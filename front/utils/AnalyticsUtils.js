import { format, startOfMonth, subMonths } from 'date-fns'

const codeOf = (value) => value?.fireflyCode ?? value ?? null
const unique = (values) => [...new Set(values.filter(Boolean))]

export const ANALYTICS_UNCATEGORIZED_ID = 'uncategorized'

export function getAnalyticsAccountGroups(accounts) {
  const active = accounts.filter((account) => account?.attributes?.active === true)
  const typeOf = (account) => codeOf(account?.attributes?.type)
  const roleOf = (account) => codeOf(account?.attributes?.account_role)
  const directionOf = (account) => codeOf(account?.attributes?.liability_direction)
  const balanceHolding = (account) => ['asset', 'cash', 'liabilities'].includes(typeOf(account))

  return {
    netWorth: active.filter((account) => balanceHolding(account) && account?.attributes?.include_net_worth === true),
    savings: active.filter((account) => typeOf(account) === 'asset' && roleOf(account) === 'savingAsset'),
    debt: active.filter((account) => (typeOf(account) === 'asset' && roleOf(account) === 'ccAsset') || (typeOf(account) === 'liabilities' && directionOf(account) === 'debit')),
  }
}

export function convertAnalyticsAmount({ amount, currencyCode, primaryAmount, primaryCurrencyCode, displayCurrencyCode, rates }) {
  const hasPrimary = primaryAmount !== null && primaryAmount !== undefined && primaryCurrencyCode
  const sourceAmount = Number(hasPrimary ? primaryAmount : amount)
  const sourceCurrency = hasPrimary ? primaryCurrencyCode : currencyCode

  if (!Number.isFinite(sourceAmount) || !sourceCurrency || !displayCurrencyCode) {
    return { value: null, isEstimated: false, missingCurrency: sourceCurrency ?? displayCurrencyCode ?? null }
  }
  if (sourceCurrency === displayCurrencyCode) {
    return { value: sourceAmount, isEstimated: false, missingCurrency: null }
  }

  const sourceRate = Number(rates?.[sourceCurrency])
  const destinationRate = Number(rates?.[displayCurrencyCode])
  if (!Number.isFinite(sourceRate) || !Number.isFinite(destinationRate) || sourceRate === 0) {
    return { value: null, isEstimated: false, missingCurrency: !Number.isFinite(sourceRate) ? sourceCurrency : displayCurrencyCode }
  }

  return {
    value: (sourceAmount * destinationRate) / sourceRate,
    isEstimated: true,
    missingCurrency: null,
  }
}

const accountType = (account) => codeOf(account?.attributes?.type)

const splitDirection = (item) => {
  const sourceType = accountType(item?.accountSource)
  const destinationType = accountType(item?.accountDestination)
  if (destinationType === 'expense') return 1
  if (sourceType === 'expense') return -1
  return 0
}

const splitMonthKey = (item) => {
  const date = item?.date instanceof Date ? item.date : new Date(item?.date)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 7)
}

const splitDay = (item) => {
  const date = item?.date instanceof Date ? item.date : new Date(item?.date)
  return Number.isNaN(date.getTime()) ? null : date.getUTCDate()
}

export function buildCategoryLedger({ transactions, displayCurrencyCode, primaryCurrencyCode, rates }) {
  const months = {}
  const missingCurrencies = []
  let isEstimated = false
  let ledgerStartMonth = null

  for (const transaction of transactions) {
    for (const item of transaction?.attributes?.transactions ?? []) {
      const direction = splitDirection(item)
      const monthKey = splitMonthKey(item)
      const day = splitDay(item)
      if (monthKey && (!ledgerStartMonth || monthKey < ledgerStartMonth)) ledgerStartMonth = monthKey
      if (direction === 0 || !monthKey || !day) continue

      const converted = convertAnalyticsAmount({
        amount: Math.abs(Number(item.amount)),
        currencyCode: item.currency_code,
        primaryAmount: item.primary_amount,
        primaryCurrencyCode,
        displayCurrencyCode,
        rates,
      })
      if (converted.missingCurrency) {
        missingCurrencies.push(converted.missingCurrency)
        continue
      }

      const categoryId = item.category_id ?? ANALYTICS_UNCATEGORIZED_ID
      const month = (months[monthKey] ??= { categories: {} })
      const category = (month.categories[categoryId] ??= { amount: 0, byDay: {}, transactionIds: [] })
      const value = direction * converted.value
      category.amount += value
      category.byDay[day] = (category.byDay[day] ?? 0) + value
      category.transactionIds.push(transaction.id)
      category.transactionIds = unique(category.transactionIds)
      isEstimated ||= converted.isEstimated
    }
  }

  return {
    months,
    ledgerStartMonth,
    isEstimated,
    missingCurrencies: unique(missingCurrencies),
  }
}

const monthKey = (date) => format(date, 'yyyy-MM')

const completedMonthKeys = ({ today, averageMonths, ledgerStartMonth }) => {
  const current = startOfMonth(today)
  const requested = Array.from({ length: averageMonths }, (_, index) => monthKey(subMonths(current, averageMonths - index)))
  return ledgerStartMonth ? requested.filter((key) => key >= ledgerStartMonth) : []
}

const categoryForMonth = (ledger, key, categoryId) => ledger.months?.[key]?.categories?.[categoryId] ?? { amount: 0, byDay: {}, transactionIds: [] }

export function summarizeCategoryWindow({ ledger, categoryIds, averageMonths, today }) {
  const monthKeys = completedMonthKeys({ today, averageMonths, ledgerStartMonth: ledger.ledgerStartMonth })
  const usedMonths = monthKeys.length
  const currentMonthKey = monthKey(today)
  const todayDay = today.getDate()
  const series = categoryIds.map((categoryId) => {
    const current = categoryForMonth(ledger, currentMonthKey, categoryId)
    const completed = monthKeys.map((key) => categoryForMonth(ledger, key, categoryId))
    const completedTotal = completed.reduce((total, category) => total + category.amount, 0)
    const remainderTotal = completed.reduce((total, category) => total + Object.entries(category.byDay).reduce((monthTotal, [day, value]) => monthTotal + (Number(day) > todayDay ? value : 0), 0), 0)
    const averageRemainderAfterToday = usedMonths > 0 ? remainderTotal / usedMonths : 0

    return {
      id: categoryId,
      actualPoints: monthKeys.map((key) => ({
        x: key,
        value: categoryForMonth(ledger, key, categoryId).amount,
        transactionIds: categoryForMonth(ledger, key, categoryId).transactionIds,
      })),
      average: usedMonths > 0 ? completedTotal / usedMonths : null,
      currentActual: current.amount,
      currentTransactionIds: current.transactionIds,
      currentForecast: usedMonths >= 2 ? current.amount + averageRemainderAfterToday : null,
      forecastAvailable: usedMonths >= 2,
    }
  })

  return { requestedMonths: averageMonths, usedMonths, monthKeys, series }
}

export function rankCategoryIds({ ledger, averageMonths, today }) {
  const monthKeys = completedMonthKeys({ today, averageMonths, ledgerStartMonth: ledger.ledgerStartMonth })
  const categoryIds = unique(monthKeys.flatMap((key) => Object.keys(ledger.months?.[key]?.categories ?? {})))
  return categoryIds.sort((left, right) => {
    const leftTotal = monthKeys.reduce((total, key) => total + categoryForMonth(ledger, key, left).amount, 0)
    const rightTotal = monthKeys.reduce((total, key) => total + categoryForMonth(ledger, key, right).amount, 0)
    return rightTotal - leftTotal || left.localeCompare(right)
  })
}

const entriesForLine = ({ line, primaryCurrencyCode }) => {
  if (line?.pc_entries && Object.keys(line.pc_entries).length > 0) {
    return {
      entries: line.pc_entries,
      currencyCode: line.pc_currency_code ?? primaryCurrencyCode,
      isPrimary: true,
    }
  }
  return {
    entries: line?.entries ?? {},
    currencyCode: line?.currency_code,
    isPrimary: false,
  }
}

export function normalizeBalanceSeries({ chartLines, metric, displayCurrencyCode, primaryCurrencyCode, rates }) {
  const normalizedLines = chartLines.map((line) => {
    const source = entriesForLine({ line, primaryCurrencyCode })
    const points = Object.entries(source.entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([x, amount]) => {
        const converted = convertAnalyticsAmount({
          amount,
          currencyCode: source.currencyCode,
          primaryAmount: source.isPrimary ? amount : null,
          primaryCurrencyCode: source.isPrimary ? source.currencyCode : primaryCurrencyCode,
          displayCurrencyCode,
          rates,
        })
        return { x, ...converted }
      })
    return { points }
  })

  const xValues = unique(normalizedLines.flatMap((line) => line.points.map(({ x }) => x))).sort()
  const missingCurrencies = unique(normalizedLines.flatMap((line) => line.points.map(({ missingCurrency }) => missingCurrency)))
  const isEstimated = normalizedLines.some((line) => line.points.some((point) => point.isEstimated))

  const points = xValues
    .map((x) => {
      let value = 0
      let hasValue = false
      for (const line of normalizedLines) {
        const available = line.points.filter((point) => point.x <= x && point.value !== null)
        const point = available.at(-1)
        if (!point) continue
        hasValue = true
        value += metric === 'debt' ? Math.max(0, -point.value) : point.value
      }
      return hasValue ? { x, value } : null
    })
    .filter(Boolean)

  return { points, isEstimated, missingCurrencies }
}
