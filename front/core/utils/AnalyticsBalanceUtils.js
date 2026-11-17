import { format } from 'date-fns'

import { convertAnalyticsAmount, getAnalyticsAccountGroups, getAnalyticsAccountKind, getAnalyticsCurrentAmount } from './AnalyticsUtils.js'

const unique = (values) => [...new Set(values.filter(Boolean))].sort()
const idOf = (value) => (value === null || value === undefined || value === '' ? null : String(value))
const codeOf = (value) => value?.fireflyCode ?? value ?? null

const dateKey = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : format(value, 'yyyy-MM-dd')
  return String(value ?? '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null
}

const monthEnd = (monthKey) => {
  const match = String(monthKey ?? '').match(/^(\d{4})-(\d{2})$/)
  if (!match) return null
  return format(new Date(Number(match[1]), Number(match[2]), 0), 'yyyy-MM-dd')
}

const cleanNumber = (value) => {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** 12
  return Math.round((value + Number.EPSILON) * factor) / factor
}

const hasAmount = (value) => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '')

const balanceAfterVirtual = (balance, virtualBalance) => {
  if (!hasAmount(balance)) return null
  const current = Number(balance)
  const virtual = hasAmount(virtualBalance) ? Number(virtualBalance) : 0
  return Number.isFinite(current) && Number.isFinite(virtual) ? cleanNumber(current - virtual) : null
}

const signedDebtAmount = ({ account, fallbackAmount, primary = false }) => {
  const attributes = account?.attributes ?? {}
  const debtAmount = primary ? (attributes.pc_debt_amount ?? attributes.pc_current_debt ?? attributes.native_current_debt) : (attributes.debt_amount ?? attributes.current_debt)
  const magnitude = getAnalyticsCurrentAmount({ account: { attributes: { current_debt: debtAmount } }, metric: 'debt', fallbackAmount })
  if (!Number.isFinite(magnitude)) return null
  if (fallbackAmount < 0) return -magnitude
  if (fallbackAmount > 0) return magnitude
  return codeOf(attributes.liability_direction) === 'debit' ? -magnitude : magnitude
}

const accountAnchorAmounts = (account, metric) => {
  const attributes = account?.attributes ?? {}
  const amount = balanceAfterVirtual(attributes.current_balance, attributes.virtual_balance)
  const primaryAmount = balanceAfterVirtual(attributes.pc_current_balance ?? attributes.native_current_balance, attributes.pc_virtual_balance ?? attributes.native_virtual_balance)
  return {
    amount: metric === 'debt' ? signedDebtAmount({ account, fallbackAmount: amount }) : amount,
    primaryAmount: metric === 'debt' ? signedDebtAmount({ account, fallbackAmount: primaryAmount, primary: true }) : primaryAmount,
  }
}

const eligibleAccounts = (accounts, metric) => {
  const groups = getAnalyticsAccountGroups(accounts)
  if (metric === 'savings') return [...groups.savingsIncluded, ...groups.savingsExcluded]
  return groups[metric] ?? []
}

const movementFor = (entry, accountId) => {
  const sourceId = idOf(entry?.sourceAccount?.id)
  const destinationId = idOf(entry?.destinationAccount?.id)
  if (sourceId !== accountId && destinationId !== accountId) return null
  if (!Number.isFinite(entry?.value)) return { entry, delta: null }
  return { entry, delta: (destinationId === accountId ? entry.value : 0) - (sourceId === accountId ? entry.value : 0) }
}

const pointForAccount = ({ account, anchorValue, entries, pointDate, upperDate = null, covered }) => {
  const movements = entries
    .map((entry) => movementFor(entry, idOf(account.id)))
    .filter(Boolean)
    .filter(({ entry }) => entry.date > pointDate && (!upperDate || entry.date <= upperDate))
  const transactionIds = unique(movements.map(({ entry }) => entry.transactionId))
  if (!covered || !Number.isFinite(anchorValue) || movements.some(({ delta }) => !Number.isFinite(delta))) return { x: pointDate, value: null, transactionIds }
  const value = cleanNumber(anchorValue - movements.reduce((total, { delta }) => total + delta, 0))
  return { x: pointDate, value, transactionIds, ...(movements.some(({ entry }) => entry.isEstimated) ? { isEstimated: true } : {}) }
}

const aggregateAccountPoints = ({ metric, accountBreakdown, monthKeys, coverage }) =>
  monthKeys.map((monthKey) => {
    const x = monthEnd(monthKey)
    const accountPoints = accountBreakdown.map(({ points }) => points.find((point) => point.x === x))
    const transactionIds = unique(accountPoints.flatMap((point) => point?.transactionIds ?? []))
    if (!coverage.completeMonths.includes(monthKey) || accountPoints.some((point) => !Number.isFinite(point?.value))) return { x, value: null, transactionIds }
    const value = cleanNumber(accountPoints.reduce((total, point) => total + (metric === 'debt' ? Math.abs(point.value) : point.value), 0))
    return { x, value, transactionIds, ...(accountPoints.some((point) => point.isEstimated) ? { isEstimated: true } : {}) }
  })

const relevantEntries = (entries, accountIds, metric) => {
  if (metric === 'expenses') return entries.filter(isQualifyingExpenseEntry)
  return entries.filter((entry) => accountIds.has(idOf(entry?.sourceAccount?.id)) || accountIds.has(idOf(entry?.destinationAccount?.id)))
}

const isQualifyingExpenseEntry = ({ sourceKind, destinationKind }) => destinationKind === 'expense' && ['available', 'savingsAccessible', 'savingsRestricted', 'liability'].includes(sourceKind)

const expensePoint = ({ entries, monthKey, covered }) => {
  const x = monthEnd(monthKey)
  const qualifying = entries.filter((entry) => entry.monthKey === monthKey && isQualifyingExpenseEntry(entry))
  const transactionIds = unique(qualifying.map(({ transactionId }) => transactionId))
  if (!covered || qualifying.some(({ value }) => !Number.isFinite(value))) return { x, value: null, transactionIds }
  const value = cleanNumber(qualifying.reduce((total, { value }) => total + Math.abs(value), 0))
  return { x, value, transactionIds, ...(qualifying.some(({ isEstimated }) => isEstimated) ? { isEstimated: true } : {}) }
}

const aggregateAccounts = ({ metric, accounts, field }) => {
  const values = accounts.map((account) => account[field])
  if (values.some((value) => !Number.isFinite(value))) return null
  return cleanNumber(values.reduce((total, value) => total + (metric === 'debt' ? Math.abs(value) : value), 0))
}

const reconcile = ({ metric, accountBreakdown, asOfDate, entries, currencyDecimalPlaces }) => {
  if (metric === 'expenses') return { status: 'unavailable', anchorValue: null, reconstructedValue: null, delta: null, accounts: [] }

  const reconstructedAccounts = accountBreakdown.map((account) => {
    const marker = dateKey(account.currentBalanceDate)
    const movements =
      marker && marker <= asOfDate
        ? entries
            .map((entry) => movementFor(entry, account.id))
            .filter(Boolean)
            .filter(({ entry }) => entry.date > marker && entry.date <= asOfDate)
        : []
    const transactionIds = unique(movements.map(({ entry }) => entry.transactionId))
    const reconstructedValue =
      Number.isFinite(account.anchorValue) && movements.every(({ delta }) => Number.isFinite(delta))
        ? cleanNumber(account.anchorValue + movements.reduce((total, { delta }) => total + delta, 0))
        : null
    const delta = Number.isFinite(reconstructedValue) && Number.isFinite(account.anchorValue) ? cleanNumber(reconstructedValue - account.anchorValue) : null
    return {
      id: account.id,
      anchorValue: account.anchorValue,
      reconstructedValue,
      delta,
      transactionIds,
    }
  })
  const anchorValue = aggregateAccounts({ metric, accounts: accountBreakdown, field: 'anchorValue' })
  const reconstructedValue = aggregateAccounts({ metric, accounts: reconstructedAccounts, field: 'reconstructedValue' })
  if (!Number.isFinite(anchorValue) || !Number.isFinite(reconstructedValue)) {
    return { status: 'unavailable', anchorValue, reconstructedValue, delta: null, accounts: reconstructedAccounts.filter(({ reconstructedValue }) => !Number.isFinite(reconstructedValue)) }
  }

  const delta = cleanNumber(reconstructedValue - anchorValue)
  const tolerance = 10 ** -currencyDecimalPlaces
  const status = Math.abs(delta) <= tolerance ? 'ok' : 'mismatch'
  return {
    status,
    anchorValue,
    reconstructedValue,
    delta,
    accounts: status === 'mismatch' ? reconstructedAccounts.filter(({ delta: accountDelta }) => accountDelta !== 0) : [],
  }
}

export function reconstructBalanceSeries({
  accounts = [],
  entries = [],
  metric,
  monthKeys = [],
  asOfDate,
  coverage: requestedCoverage,
  displayCurrencyCode,
  primaryCurrencyCode,
  rates,
  currencyDecimalPlaces = 2,
}) {
  const normalizedAsOfDate = dateKey(asOfDate)
  const normalizedEntries = entries.map((entry) => ({ ...entry, date: dateKey(entry?.date), monthKey: entry?.monthKey ?? dateKey(entry?.date)?.slice(0, 7) })).filter(({ date }) => date)
  const startMonth = String(requestedCoverage?.startMonth ?? '').match(/^\d{4}-\d{2}$/)?.[0] ?? null
  const coverageEndDate = dateKey(requestedCoverage?.endDate)
  const asOfMonth = normalizedAsOfDate?.slice(0, 7) ?? null
  const completeMonths = monthKeys.filter(
    (monthKey) =>
      startMonth &&
      monthKey >= startMonth &&
      asOfMonth &&
      monthKey < asOfMonth &&
      coverageEndDate &&
      monthEnd(monthKey) <= coverageEndDate &&
      (metric === 'expenses' || coverageEndDate >= normalizedAsOfDate),
  )
  const coverage = { startMonth, endDate: coverageEndDate, completeMonths, unavailableMonths: monthKeys.filter((monthKey) => !completeMonths.includes(monthKey)) }
  const selectedAccounts = metric === 'expenses' ? [] : eligibleAccounts(accounts, metric)
  const accountIds = new Set(selectedAccounts.map(({ id }) => idOf(id)).filter(Boolean))
  const metricEntries = relevantEntries(normalizedEntries, accountIds, metric)

  const accountBreakdown = selectedAccounts.map((account) => {
    const anchorAmounts = accountAnchorAmounts(account, metric)
    const converted = convertAnalyticsAmount({
      amount: anchorAmounts.amount,
      currencyCode: codeOf(account?.attributes?.currency_code),
      primaryAmount: anchorAmounts.primaryAmount,
      primaryCurrencyCode,
      displayCurrencyCode,
      rates,
    })
    const anchorValue = cleanNumber(converted.value)
    const points = monthKeys.map((monthKey) =>
      pointForAccount({
        account,
        anchorValue,
        entries: metricEntries,
        pointDate: monthEnd(monthKey),
        upperDate: normalizedAsOfDate,
        covered: completeMonths.includes(monthKey),
      }),
    )
    return {
      id: idOf(account.id),
      kind: getAnalyticsAccountKind(account),
      anchorValue,
      currentBalanceDate: account?.attributes?.current_balance_date,
      points,
      currentPoint: Number.isFinite(anchorValue) ? { x: normalizedAsOfDate, value: anchorValue, transactionIds: [], ...(converted.isEstimated ? { isEstimated: true } : {}) } : null,
      isEstimated: converted.isEstimated,
      missingCurrency: converted.missingCurrency,
    }
  })

  const points =
    metric === 'expenses'
      ? monthKeys.map((monthKey) => expensePoint({ entries: normalizedEntries, monthKey, covered: completeMonths.includes(monthKey) }))
      : aggregateAccountPoints({ metric, accountBreakdown, monthKeys, coverage })
  const currentMonthEntries = normalizedEntries.filter(({ date }) => asOfMonth && date <= normalizedAsOfDate && date.startsWith(asOfMonth))
  const currentPoint =
    metric === 'expenses'
      ? startMonth && asOfMonth && asOfMonth >= startMonth && coverageEndDate && coverageEndDate >= normalizedAsOfDate
        ? { ...expensePoint({ entries: currentMonthEntries, monthKey: asOfMonth, covered: true }), x: normalizedAsOfDate }
        : null
      : (() => {
          const value = aggregateAccounts({ metric, accounts: accountBreakdown, field: 'anchorValue' })
          if (!Number.isFinite(value)) return null
          return { x: normalizedAsOfDate, value, transactionIds: [], ...(accountBreakdown.some(({ isEstimated }) => isEstimated) ? { isEstimated: true } : {}) }
        })()

  const missingCurrencies = unique([...accountBreakdown.map(({ missingCurrency }) => missingCurrency), ...metricEntries.map(({ conversion }) => conversion?.missingCurrency)])
  const fxTransactionIds = unique(metricEntries.filter(({ isEstimated, conversion }) => isEstimated || conversion?.missingCurrency).map(({ transactionId }) => transactionId))
  const fx = { isEstimated: accountBreakdown.some(({ isEstimated }) => isEstimated) || metricEntries.some(({ isEstimated }) => isEstimated), missingCurrencies, transactionIds: fxTransactionIds }

  return {
    id: metric,
    points,
    currentPoint,
    accountBreakdown,
    coverage,
    fx,
    reconciliation: reconcile({ metric, accountBreakdown, asOfDate: normalizedAsOfDate, entries: metricEntries, currencyDecimalPlaces }),
  }
}
