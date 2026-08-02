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

export function getAnalyticsAccountKind(account) {
  const type = codeOf(account?.attributes?.type)
  const role = codeOf(account?.attributes?.account_role)
  const direction = codeOf(account?.attributes?.liability_direction)
  if (type === 'expense') return 'expense'
  if (type === 'revenue') return 'revenue'
  if (type === 'asset' && role === 'savingAsset') return 'savings'
  if ((type === 'asset' && role === 'ccAsset') || (type === 'liabilities' && direction === 'debit')) return 'debt'
  if (['asset', 'cash', 'liabilities'].includes(type)) return 'balance'
  return 'other'
}

export function convertAnalyticsAmount({ amount, currencyCode, primaryAmount, primaryCurrencyCode, displayCurrencyCode, rates }) {
  const hasAmount = (value) => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '')
  const hasPrimary = hasAmount(primaryAmount) && primaryCurrencyCode
  const sourceAmountValue = hasPrimary ? primaryAmount : amount
  const sourceCurrency = hasPrimary ? primaryCurrencyCode : currencyCode

  if (!hasAmount(sourceAmountValue)) {
    return { value: null, isEstimated: false, missingCurrency: null }
  }

  const sourceAmount = Number(sourceAmountValue)
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
  return format(date, 'yyyy-MM')
}

const splitDay = (item) => {
  const date = item?.date instanceof Date ? item.date : new Date(item?.date)
  return Number.isNaN(date.getTime()) ? null : date.getDate()
}

export function buildMonthlyMoneyFlow({ transactions, monthKey, displayCurrencyCode, primaryCurrencyCode, rates, currencyDecimalPlaces = 2 }) {
  const buckets = Object.fromEntries(['income', 'expensePurchases', 'refunds', 'savingsIn', 'savingsOut', 'debtIncrease', 'debtRepayment'].map((id) => [id, { value: 0, transactionIds: [] }]))
  const missingCurrencies = []
  let isEstimated = false

  const add = (id, amount, transactionId) => {
    buckets[id].value += amount
    buckets[id].transactionIds.push(transactionId)
    buckets[id].transactionIds = unique(buckets[id].transactionIds)
  }

  for (const transaction of transactions) {
    for (const item of transaction?.attributes?.transactions ?? []) {
      if (splitMonthKey(item) !== monthKey) continue

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

      const amount = Math.abs(converted.value)
      const sourceKind = getAnalyticsAccountKind(item.accountSource)
      const destinationKind = getAnalyticsAccountKind(item.accountDestination)

      if (sourceKind === 'revenue') add('income', amount, transaction.id)
      if (destinationKind === 'expense') add('expensePurchases', amount, transaction.id)
      if (sourceKind === 'expense') add('refunds', amount, transaction.id)

      if (sourceKind !== 'savings' && destinationKind === 'savings') add('savingsIn', amount, transaction.id)
      if (sourceKind === 'savings' && destinationKind !== 'savings') add('savingsOut', amount, transaction.id)

      if (sourceKind === 'debt' && destinationKind !== 'debt') add('debtIncrease', amount, transaction.id)
      if (sourceKind !== 'debt' && destinationKind === 'debt') add('debtRepayment', amount, transaction.id)

      isEstimated ||= converted.isEstimated
    }
  }

  const income = buckets.income.value
  const expensePurchases = buckets.expensePurchases.value
  const refunds = buckets.refunds.value
  const savingsIn = buckets.savingsIn.value
  const savingsOut = buckets.savingsOut.value
  const debtIncrease = buckets.debtIncrease.value
  const debtRepayment = buckets.debtRepayment.value
  const expenses = Math.max(0, expensePurchases - refunds)
  const netRefunds = Math.max(0, refunds - expensePurchases)
  const savingsDeposited = Math.max(0, savingsIn - savingsOut)
  const savingsWithdrawn = Math.max(0, savingsOut - savingsIn)
  const debtRepaid = Math.max(0, debtRepayment - debtIncrease)
  const newDebt = Math.max(0, debtIncrease - debtRepayment)
  const classifiedSources = income + savingsWithdrawn + newDebt + netRefunds
  const classifiedDestinations = expenses + savingsDeposited + debtRepaid
  const priorExcessUsed = Math.max(0, classifiedDestinations - classifiedSources)
  const newExcess = Math.max(0, classifiedSources - classifiedDestinations)
  const sourceTotal = classifiedSources + priorExcessUsed
  const destinationTotal = classifiedDestinations + newExcess
  const equationDifference = sourceTotal - destinationTotal
  const savingsTransactionIds = unique([...buckets.savingsIn.transactionIds, ...buckets.savingsOut.transactionIds])
  const debtTransactionIds = unique([...buckets.debtIncrease.transactionIds, ...buckets.debtRepayment.transactionIds])
  const expenseTransactionIds = unique([...buckets.expensePurchases.transactionIds, ...buckets.refunds.transactionIds])
  const nodes = (items) => items.filter(({ value }) => value > 0)

  const sources = nodes([
    { id: 'income', value: income, transactionIds: buckets.income.transactionIds },
    { id: 'savingsWithdrawn', value: savingsWithdrawn, transactionIds: savingsTransactionIds },
    { id: 'newDebt', value: newDebt, transactionIds: debtTransactionIds },
    { id: 'priorExcessUsed', value: priorExcessUsed, transactionIds: [] },
    { id: 'netRefunds', value: netRefunds, transactionIds: expenseTransactionIds },
  ])
  const destinations = nodes([
    { id: 'expenses', value: expenses, transactionIds: expenseTransactionIds },
    { id: 'savingsDeposited', value: savingsDeposited, transactionIds: savingsTransactionIds },
    { id: 'debtRepaid', value: debtRepaid, transactionIds: debtTransactionIds },
    { id: 'newExcess', value: newExcess, transactionIds: [] },
  ])
  const audit = {
    income,
    incomeIds: buckets.income.transactionIds,
    expensePurchases,
    expensePurchasesIds: buckets.expensePurchases.transactionIds,
    refunds,
    refundsIds: buckets.refunds.transactionIds,
    savingsIn,
    savingsInIds: buckets.savingsIn.transactionIds,
    savingsOut,
    savingsOutIds: buckets.savingsOut.transactionIds,
    debtIncrease,
    debtIncreaseIds: buckets.debtIncrease.transactionIds,
    debtRepayment,
    debtRepaymentIds: buckets.debtRepayment.transactionIds,
    expenses,
    netRefunds,
    savingsDeposited,
    savingsWithdrawn,
    debtRepaid,
    newDebt,
    classifiedSources,
    classifiedDestinations,
    priorExcessUsed,
    newExcess,
    sourceTotal,
    destinationTotal,
    equationDifference,
  }

  return {
    sources,
    destinations,
    total: sourceTotal,
    audit,
    isEstimated,
    missingCurrencies: unique(missingCurrencies),
    isBalanced: Math.abs(equationDifference) <= 0.5 * 10 ** -currencyDecimalPlaces,
  }
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
      const category = (month.categories[categoryId] ??= { amount: 0, byDay: {}, transactionIds: [], transactionIdsByDay: {} })
      const value = direction * converted.value
      category.amount += value
      category.byDay[day] = (category.byDay[day] ?? 0) + value
      category.transactionIds.push(transaction.id)
      category.transactionIds = unique(category.transactionIds)
      const transactionIdsByDay = (category.transactionIdsByDay[day] ??= [])
      transactionIdsByDay.push(transaction.id)
      category.transactionIdsByDay[day] = unique(transactionIdsByDay)
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

const categoryForMonth = (ledger, key, categoryId) => ledger.months?.[key]?.categories?.[categoryId] ?? { amount: 0, byDay: {}, transactionIds: [], transactionIdsByDay: {} }

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
    const currentActual = Object.entries(current.byDay).reduce((total, [day, value]) => total + (Number(day) <= todayDay ? value : 0), 0)
    const currentTransactionIds = unique(Object.entries(current.transactionIdsByDay ?? {}).flatMap(([day, transactionIds]) => (Number(day) <= todayDay ? transactionIds : [])))

    return {
      id: categoryId,
      actualPoints: monthKeys.map((key) => ({
        x: key,
        value: categoryForMonth(ledger, key, categoryId).amount,
        transactionIds: categoryForMonth(ledger, key, categoryId).transactionIds,
      })),
      average: usedMonths > 0 ? completedTotal / usedMonths : null,
      currentActual,
      currentTransactionIds,
      currentForecast: usedMonths >= 2 ? currentActual + averageRemainderAfterToday : null,
      forecastAvailable: usedMonths >= 2,
    }
  })

  return { requestedMonths: averageMonths, usedMonths, monthKeys, series }
}

const totalForMonth = (ledger, key) => Object.values(ledger.months?.[key]?.categories ?? {}).reduce((total, category) => total + category.amount, 0)

const totalByDay = (categories, predicate) =>
  Object.values(categories ?? {}).reduce(
    (total, category) => total + Object.entries(category.byDay ?? {}).reduce((categoryTotal, [day, value]) => categoryTotal + (predicate(Number(day)) ? value : 0), 0),
    0,
  )

export function summarizeTotalExpenseWindow({ ledger, averageMonths, today }) {
  const monthKeys = completedMonthKeys({ today, averageMonths, ledgerStartMonth: ledger.ledgerStartMonth })
  const usedMonths = monthKeys.length
  const currentMonthKey = monthKey(today)
  const todayDay = today.getDate()
  const currentCategories = ledger.months?.[currentMonthKey]?.categories
  const actualPoints = monthKeys.map((key) => ({ x: key, value: totalForMonth(ledger, key), kind: 'actual' }))
  const currentActual = totalByDay(currentCategories, (day) => day <= todayDay)
  const remainderTotal = monthKeys.reduce((total, key) => total + totalByDay(ledger.months?.[key]?.categories, (day) => day > todayDay), 0)
  const forecastAvailable = usedMonths >= 2

  return {
    requestedMonths: averageMonths,
    usedMonths,
    actualPoints,
    average: usedMonths > 0 ? actualPoints.reduce((total, point) => total + point.value, 0) / usedMonths : null,
    currentActual,
    currentForecast: forecastAvailable ? currentActual + remainderTotal / usedMonths : null,
    forecastAvailable,
  }
}

const lastMonthlyPoints = (points) =>
  points
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.x) && Number.isFinite(point.value))
    .sort((left, right) => left.x.localeCompare(right.x))
    .reduce((months, point) => ({ ...months, [point.x.slice(0, 7)]: point }), {})

export function summarizeBalanceMovements({ balanceSeries, months, today }) {
  const currentMonth = startOfMonth(today)
  const monthKeys = Array.from({ length: months + 1 }, (_, index) => monthKey(subMonths(currentMonth, months - index)))
  const currentMonthKey = monthKey(today)

  return {
    monthKeys,
    series: balanceSeries.map(({ id, points, currentPoint }) => {
      const monthlyPoints = lastMonthlyPoints(points)
      const currentTotal = Number.isFinite(currentPoint?.value) ? currentPoint.value : null
      const currentEstimate = currentPoint?.isEstimated ? { isEstimated: true } : {}
      const sourceMonthKeys = Object.keys(monthlyPoints).sort()
      const totalForKey = (key) => {
        const sourceKey = sourceMonthKeys.filter((sourceMonthKey) => sourceMonthKey <= key).at(-1)
        return sourceKey ? monthlyPoints[sourceKey].value : null
      }
      const completedMonthKeys = monthKeys.filter((key) => key !== currentMonthKey)
      const precedingCompletedTotal = totalForKey(completedMonthKeys.at(-1))
      const totalPoints = [
        ...completedMonthKeys.flatMap((key) => {
          const value = totalForKey(key)
          return value === null ? [] : [{ x: key, value, kind: 'actual' }]
        }),
        ...(currentTotal === null || precedingCompletedTotal === null ? [] : [{ x: currentMonthKey, value: currentTotal, kind: 'partial', ...currentEstimate }]),
      ]
      const changePoints = monthKeys.flatMap((key) => {
        const previousKey = monthKey(subMonths(new Date(key + '-01T00:00:00'), 1))
        const previous = totalForKey(previousKey)
        const isCurrentMonth = key === currentMonthKey
        const current = isCurrentMonth ? currentTotal : totalForKey(key)
        return previous === null || current === null ? [] : [{ x: key, value: current - previous, kind: isCurrentMonth ? 'partial' : 'actual', ...(isCurrentMonth ? currentEstimate : {}) }]
      })
      const completedChanges = changePoints.filter(({ kind }) => kind === 'actual')
      const averageChange = completedChanges.length > 0 ? completedChanges.reduce((total, point) => total + point.value, 0) / completedChanges.length : null
      const forecastAvailable = completedChanges.length >= 2
      const currentChange = changePoints.find(({ kind }) => kind === 'partial')?.value ?? null

      return {
        id,
        totalPoints,
        changePoints,
        currentTotal,
        currentChange,
        averageChange,
        forecastChange: forecastAvailable ? averageChange : null,
        forecastTotal: forecastAvailable && precedingCompletedTotal !== null ? precedingCompletedTotal + averageChange : null,
        forecastAvailable,
      }
    }),
  }
}

export function buildFinancialTrendChartSeries({ view, metrics, selectedIds, accountSeries, expenses, currentMonthKey }) {
  const selected = new Set(selectedIds)
  const accountSeriesById = Object.fromEntries(accountSeries.map((series) => [series.id, series]))

  return metrics.flatMap((metric) => {
    if (!selected.has(metric.id)) return []
    if (metric.id === 'expenses') {
      if (view !== 'changes') return []
      return [
        {
          ...metric,
          points: [
            ...expenses.actualPoints,
            { x: currentMonthKey, value: expenses.currentActual, kind: 'partial' },
            ...(expenses.forecastAvailable && Number.isFinite(expenses.currentForecast) ? [{ x: currentMonthKey + ':forecast', value: expenses.currentForecast, kind: 'forecast' }] : []),
          ],
        },
      ]
    }

    const series = accountSeriesById[metric.id]
    if (!series) return []
    const isBalances = view === 'balances'
    const forecastValue = isBalances ? series.forecastTotal : series.forecastChange
    return [
      {
        ...metric,
        points: [
          ...(isBalances ? series.totalPoints : series.changePoints),
          ...(series.forecastAvailable && Number.isFinite(forecastValue) ? [{ x: currentMonthKey + ':forecast', value: forecastValue, kind: 'forecast' }] : []),
        ],
      },
    ]
  })
}

export function formatFinancialTrendForecastValue({ forecastAvailable, value, formatValue, insufficientHistoryLabel }) {
  return forecastAvailable ? formatValue(value) : insufficientHistoryLabel
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
      currencyCode: line.primary_currency_code ?? line.pc_currency_code ?? primaryCurrencyCode,
      isPrimary: true,
    }
  }
  return {
    entries: line?.entries ?? {},
    currencyCode: line?.currency_code,
    isPrimary: false,
  }
}

const normalizeChartDateKey = (value) => {
  const match = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)
  return match?.[1] ?? null
}

export function normalizeBalanceSeries({ chartLines, metric, displayCurrencyCode, primaryCurrencyCode, rates }) {
  const normalizedLines = chartLines.map((line) => {
    const source = entriesForLine({ line, primaryCurrencyCode })
    const points = Object.entries(source.entries)
      .map(([x, amount]) => ({ x: normalizeChartDateKey(x), amount }))
      .filter(({ x }) => x)
      .sort((left, right) => left.x.localeCompare(right.x))
      .map(({ x, amount }) => {
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
