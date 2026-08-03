import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { format, parseISO, startOfMonth, subMonths } from 'date-fns'
import DateUtils from '../utils/DateUtils.js'
import {
  buildCategoryLedger,
  buildMonthlyMoneyFlow,
  combineSavingsBalanceSeries,
  convertAnalyticsAmount,
  getAnalyticsAccountGroups,
  getAnalyticsCurrentAmount,
  normalizeBalanceSeries,
  rankCategoryIds,
  summarizeBalanceMovements,
  summarizeCategoryWindow,
  summarizeTotalExpenseWindow,
} from '../utils/AnalyticsUtils.js'

const BALANCE_GROUPS = ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt']
const SAVINGS_VIEWS = ['combined', 'split']
const FINANCIAL_TREND_VIEWS = ['balances', 'changes']
const CATEGORY_SERIES_LIMIT = 6

const balanceMetricIdsForSavingsView = (view) => (view === 'split' ? ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt'] : ['netWorth', 'savings', 'debt'])
const financialMetricIdsForSavingsView = (view) => [...balanceMetricIdsForSavingsView(view), 'expenses']
const emptyBalanceSeries = (id) => ({ id, points: [], isEstimated: false, missingCurrencies: [], warnings: [] })

export function createAnalyticsStore(id, useDependencies) {
  return defineStore(id, () => {
    const {
      appStore,
      dashboardStore,
      accountStore,
      currencyStore,
      useStoredValue,
      createAccountRepository,
      createTransactionRepository,
      transformTransactions,
      getAccountBalance,
      getAccountCurrencyCode,
      getCurrencyCode,
      getCurrencyDecimalPlaces,
      getExcludedTransactionFilters,
      isResponseSuccess,
      getNow = () => new Date(),
    } = useDependencies()

    const balancePeriod = useStoredValue('analyticsBalancePeriod', 3)
    const categoryAverageMonths = useStoredValue('analyticsCategoryAverageMonths', 6)
    const selectedCategoryIds = useStoredValue('analyticsSelectedCategoryIds', [])
    const persistedSelectedCategoryIds = computed(() => [...new Set((Array.isArray(selectedCategoryIds.value) ? selectedCategoryIds.value : []).filter(Boolean))])
    const normalizedSelectedCategoryIds = computed(() => persistedSelectedCategoryIds.value.slice(0, CATEGORY_SERIES_LIMIT))
    const storedSavingsView = useStoredValue('analyticsSavingsView', 'combined')
    const storedVisibleFinancialMetrics = useStoredValue('analyticsVisibleBalanceMetrics', financialMetricIdsForSavingsView('combined'))
    const storedVisibleBalanceMetrics = useStoredValue('analyticsVisibleBalanceTotalMetrics', balanceMetricIdsForSavingsView('combined'))
    const storedFinancialTrendView = useStoredValue('analyticsFinancialTrendView', 'balances')
    const normalizeSavingsView = (view) => (SAVINGS_VIEWS.includes(view) ? view : 'combined')
    const normalizeMetrics = (metrics, availableMetrics, view) => {
      const compatibleMetrics = (Array.isArray(metrics) ? metrics : []).flatMap((metric) => {
        if (view === 'split' && metric === 'savings') return ['savingsIncluded', 'savingsExcluded']
        if (view === 'combined' && ['savingsIncluded', 'savingsExcluded'].includes(metric)) return ['savings']
        return [metric]
      })
      const normalized = [...new Set(compatibleMetrics.filter((metric) => availableMetrics.includes(metric)))]
      return normalized.length > 0 ? normalized : [availableMetrics[0]]
    }
    if (!SAVINGS_VIEWS.includes(storedSavingsView.value)) storedSavingsView.value = 'combined'
    const savingsView = computed({
      get: () => normalizeSavingsView(storedSavingsView.value),
      set: (view) => {
        const normalizedView = normalizeSavingsView(view)
        storedSavingsView.value = normalizedView
        storedVisibleBalanceMetrics.value = normalizeMetrics(storedVisibleBalanceMetrics.value, balanceMetricIdsForSavingsView(normalizedView), normalizedView)
        storedVisibleFinancialMetrics.value = normalizeMetrics(storedVisibleFinancialMetrics.value, financialMetricIdsForSavingsView(normalizedView), normalizedView)
      },
    })
    const availableBalanceMetricIds = computed(() => balanceMetricIdsForSavingsView(savingsView.value))
    const availableFinancialMetricIds = computed(() => financialMetricIdsForSavingsView(savingsView.value))
    const visibleFinancialMetrics = computed({
      get: () => normalizeMetrics(storedVisibleFinancialMetrics.value, availableFinancialMetricIds.value, savingsView.value),
      set: (metrics) => {
        storedVisibleFinancialMetrics.value = normalizeMetrics(metrics, availableFinancialMetricIds.value, savingsView.value)
      },
    })
    const visibleBalanceMetrics = computed({
      get: () => normalizeMetrics(storedVisibleBalanceMetrics.value, availableBalanceMetricIds.value, savingsView.value),
      set: (metrics) => {
        storedVisibleBalanceMetrics.value = normalizeMetrics(metrics, availableBalanceMetricIds.value, savingsView.value)
      },
    })
    const financialTrendView = computed({
      get: () => (FINANCIAL_TREND_VIEWS.includes(storedFinancialTrendView.value) ? storedFinancialTrendView.value : 'balances'),
      set: (view) => {
        storedFinancialTrendView.value = FINANCIAL_TREND_VIEWS.includes(view) ? view : 'balances'
      },
    })
    const selectedFlowMonth = ref(startOfMonth(getNow()))

    const balanceState = reactive({ status: 'idle', error: null, isStale: false })
    const categoryState = reactive({ status: 'idle', error: null, isStale: false })
    const flowState = reactive({ status: 'idle', error: null, isStale: false })
    const balanceCache = ref({})
    const transactions = ref([])
    const categorySelectionInitialized = ref(false)
    const balanceRequests = new Map()
    let balanceRequestSequence = 0
    let activeBalanceRequestToken = null
    let transactionRequestSequence = 0
    let activeTransactionRequestToken = null
    let transactionRequest = null

    const displayCurrencyCode = computed(() => dashboardStore.dashboardCurrencyCode)
    const primaryCurrencyCode = computed(() => getCurrencyCode(currencyStore.defaultCurrency))
    const displayCurrencyDecimalPlaces = computed(() => {
      const decimalPlaces = getCurrencyDecimalPlaces(dashboardStore.dashboardCurrency)
      return decimalPlaces === null || decimalPlaces === undefined ? 2 : Number(decimalPlaces)
    })
    const rates = computed(() => currencyStore.exchangeRates?.rates ?? {})
    const accountGroups = computed(() => getAnalyticsAccountGroups(accountStore.accountList))
    const categoryLedger = computed(() =>
      buildCategoryLedger({
        transactions: transactions.value,
        displayCurrencyCode: displayCurrencyCode.value,
        primaryCurrencyCode: primaryCurrencyCode.value,
        rates: rates.value,
      }),
    )
    const categoryRanking = computed(() =>
      rankCategoryIds({
        ledger: categoryLedger.value,
        averageMonths: categoryAverageMonths.value,
        today: getNow(),
      }),
    )
    const currentMonthCategoryIds = computed(() => {
      const rankedIds = new Set(categoryRanking.value)
      const currentCategories = categoryLedger.value.months?.[format(getNow(), 'yyyy-MM')]?.categories ?? {}
      return Object.keys(currentCategories)
        .filter((id) => !rankedIds.has(id))
        .sort((left, right) => currentCategories[right].amount - currentCategories[left].amount || left.localeCompare(right))
    })
    const categorySummary = computed(() => ({
      ...summarizeCategoryWindow({
        ledger: categoryLedger.value,
        categoryIds: normalizedSelectedCategoryIds.value,
        averageMonths: categoryAverageMonths.value,
        today: getNow(),
      }),
      isEstimated: categoryLedger.value.isEstimated,
      missingCurrencies: categoryLedger.value.missingCurrencies,
    }))
    const categoryRankingItems = computed(() => {
      const rankedItems = categoryRanking.value.map((id) => ({
        id,
        amount: categorySummary.value.monthKeys.reduce((total, key) => total + (categoryLedger.value.months?.[key]?.categories?.[id]?.amount ?? 0), 0),
      }))
      const candidateIds = new Set([...categoryRanking.value, ...currentMonthCategoryIds.value])
      return [
        ...rankedItems,
        ...currentMonthCategoryIds.value.map((id) => ({ id, amount: 0 })),
        ...persistedSelectedCategoryIds.value.filter((id) => !candidateIds.has(id)).map((id) => ({ id, amount: 0 })),
      ]
    })
    const selectedFlow = computed(() =>
      buildMonthlyMoneyFlow({
        transactions: transactions.value,
        monthKey: format(selectedFlowMonth.value, 'yyyy-MM'),
        displayCurrencyCode: displayCurrencyCode.value,
        primaryCurrencyCode: primaryCurrencyCode.value,
        rates: rates.value,
        currencyDecimalPlaces: displayCurrencyDecimalPlaces.value,
      }),
    )
    const flowMonthMin = computed(() => (categoryLedger.value.ledgerStartMonth ? startOfMonth(parseISO(categoryLedger.value.ledgerStartMonth + '-01')) : null))
    const flowMonthMax = computed(() => startOfMonth(getNow()))

    function getBalanceSnapshot() {
      const groups = Object.fromEntries(
        BALANCE_GROUPS.map((metric) => [
          metric,
          accountGroups.value[metric].map((account) => {
            const currentDate = account?.attributes?.current_balance_date
            return {
              id: account.id,
              currencyCode: getAccountCurrencyCode(account) ?? account?.attributes?.currency_code,
              currentAmount: getAnalyticsCurrentAmount({ account, metric, fallbackAmount: getAccountBalance(account) }),
              currentDate: currentDate instanceof Date ? DateUtils.dateToString(currentDate) : currentDate?.slice(0, 10),
            }
          }),
        ]),
      )
      const displayCode = displayCurrencyCode.value
      const primaryCode = primaryCurrencyCode.value
      const rateSnapshot = { ...rates.value }
      const currencyCodes = [displayCode, primaryCode, ...BALANCE_GROUPS.flatMap((metric) => groups[metric].map(({ currencyCode }) => currencyCode))].filter(Boolean).sort()
      const relevantRates = Object.fromEntries([...new Set(currencyCodes)].map((currencyCode) => [currencyCode, rateSnapshot[currencyCode] ?? null]))
      const months = Number(balancePeriod.value)
      const today = getNow()
      const groupIds = Object.fromEntries(BALANCE_GROUPS.map((metric) => [metric, groups[metric].map(({ id }) => id).sort()]))
      const cacheKey = JSON.stringify({ period: months, displayCurrencyCode: displayCode, primaryCurrencyCode: primaryCode, rates: relevantRates, groups: groupIds })
      return {
        cacheKey,
        groups,
        start: DateUtils.dateToString(startOfMonth(subMonths(today, months + 1))),
        end: DateUtils.dateToString(today),
        period: months === 3 ? '1D' : '1W',
        displayCurrencyCode: displayCode,
        primaryCurrencyCode: primaryCode,
        rates: rateSnapshot,
        decimalPlaces: displayCurrencyDecimalPlaces.value,
      }
    }

    const balanceCacheKey = computed(() => getBalanceSnapshot().cacheKey)
    const currentFourGroupSeries = computed(() => {
      const cached = balanceCache.value[balanceCacheKey.value] ?? []
      return Object.fromEntries(BALANCE_GROUPS.map((metric) => [metric, cached.find(({ id }) => id === metric) ?? emptyBalanceSeries(metric)]))
    })
    const combinedSavingsSeries = computed(() => {
      const includedIsEmpty = accountGroups.value.savingsIncluded.length === 0
      const excludedIsEmpty = accountGroups.value.savingsExcluded.length === 0
      if (includedIsEmpty && excludedIsEmpty) return emptyBalanceSeries('savings')
      const combined = combineSavingsBalanceSeries({
        includedSeries: currentFourGroupSeries.value.savingsIncluded,
        excludedSeries: currentFourGroupSeries.value.savingsExcluded,
        includedIsEmpty,
        excludedIsEmpty,
      })
      return combined ? { id: 'savings', ...combined } : emptyBalanceSeries('savings')
    })
    const balanceSeries = computed(() => {
      const base = currentFourGroupSeries.value
      if (savingsView.value === 'split') return [base.netWorth, base.savingsIncluded, base.savingsExcluded, base.debt]
      return [base.netWorth, combinedSavingsSeries.value, base.debt]
    })
    const balanceWarnings = computed(() => {
      const selectedMetricIds = financialTrendView.value === 'balances' ? visibleBalanceMetrics.value : visibleFinancialMetrics.value
      const grouped = new Map()
      balanceSeries.value
        .filter(({ id: metricId }) => selectedMetricIds.includes(metricId))
        .forEach(({ id: metricId, warnings }) => {
          warnings.forEach(({ type, sampleDate }) => {
            const key = JSON.stringify([type, sampleDate])
            const warning = grouped.get(key)
            if (!warning) grouped.set(key, { type, sampleDate, metricIds: [metricId] })
            else if (!warning.metricIds.includes(metricId)) warning.metricIds.push(metricId)
          })
        })
      return [...grouped.values()]
    })
    const financialTrend = computed(() => ({
      ...summarizeBalanceMovements({ balanceSeries: balanceSeries.value, months: Number(balancePeriod.value), today: getNow() }),
      expenses: summarizeTotalExpenseWindow({ ledger: categoryLedger.value, averageMonths: Number(balancePeriod.value), today: getNow() }),
    }))

    async function fetchTransactions({ force = false } = {}) {
      const isReady = ['ready', 'empty'].includes(categoryState.status) && ['ready', 'empty'].includes(flowState.status)
      if (isReady && !force) return
      if (!force && transactionRequest) return transactionRequest.promise

      const hasExistingData = transactions.value.length > 0
      const requestToken = ++transactionRequestSequence
      activeTransactionRequestToken = requestToken
      Object.assign(categoryState, { status: 'loading', error: null, isStale: hasExistingData })
      Object.assign(flowState, { status: 'loading', error: null, isStale: hasExistingData })

      const request = (async () => {
        const today = getNow()
        const query = [`date_after:${DateUtils.dateToString(startOfMonth(subMonths(today, 24)))}`, `date_before:${DateUtils.dateToString(today)}`, ...getExcludedTransactionFilters()]
        const filters = [{ field: 'query', value: query.join(' ') }]
        const repository = createTransactionRepository()
        const getAll = (options) => repository.searchTransaction({ ...options, showLoading: false, showErrorToast: false })
        const result = await repository.getAllWithMergeResult({ filters, getAll, pageSize: 200 })
        const ownsCurrentState = () => activeTransactionRequestToken === requestToken

        if (!result.ok) {
          if (ownsCurrentState()) {
            const error = new Error('Analytics transaction request failed')
            Object.assign(categoryState, { status: 'error', error, isStale: hasExistingData })
            Object.assign(flowState, { status: 'error', error, isStale: hasExistingData })
          }
          return
        }

        const transformed = transformTransactions(result.data)
        if (!ownsCurrentState()) return

        transactions.value = transformed
        const status = transformed.length > 0 ? 'ready' : 'empty'
        Object.assign(categoryState, { status, error: null, isStale: false })
        Object.assign(flowState, { status, error: null, isStale: false })

        if (!categorySelectionInitialized.value) {
          if (persistedSelectedCategoryIds.value.length === 0) selectedCategoryIds.value = (categoryRanking.value.length > 0 ? categoryRanking.value : currentMonthCategoryIds.value).slice(0, 5)
          categorySelectionInitialized.value = true
        }
      })()
      transactionRequest = { token: requestToken, promise: request }
      try {
        return await request
      } finally {
        if (transactionRequest?.token === requestToken) transactionRequest = null
      }
    }

    async function fetchBalances({ force = false } = {}) {
      const snapshot = getBalanceSnapshot()
      const cached = balanceCache.value[snapshot.cacheKey]
      if (cached && !force) {
        Object.assign(balanceState, { status: cached.some(({ points }) => points.length > 0) ? 'ready' : 'empty', error: null, isStale: false })
        return
      }

      const hasExistingData = Boolean(cached?.some(({ points }) => points.length > 0))
      const existingRequest = balanceRequests.get(snapshot.cacheKey)
      if (existingRequest) {
        activeBalanceRequestToken = existingRequest.token
        Object.assign(balanceState, { status: 'loading', error: null, isStale: hasExistingData })
        return existingRequest.promise
      }

      const requestToken = ++balanceRequestSequence
      activeBalanceRequestToken = requestToken
      Object.assign(balanceState, { status: 'loading', error: null, isStale: hasExistingData })

      const request = (async () => {
        const repository = createAccountRepository()
        const responses = await Promise.all(
          BALANCE_GROUPS.map(async (metric) => {
            const accountIds = snapshot.groups[metric].map(({ id }) => id)
            if (accountIds.length === 0) return { metric, response: null }
            const response = await repository.getChartOverview({ start: snapshot.start, end: snapshot.end, period: snapshot.period, accountIds })
            return { metric, response }
          }),
        )
        const ownsCurrentState = () => activeBalanceRequestToken === requestToken && balanceCacheKey.value === snapshot.cacheKey

        if (responses.some(({ response }) => response && !isResponseSuccess(response))) {
          if (ownsCurrentState()) Object.assign(balanceState, { status: 'error', error: new Error('Analytics balance request failed'), isStale: hasExistingData })
          return
        }

        const responsesWithCurrent = await Promise.all(
          responses.map(async ({ metric, response }) => {
            const currentAmounts = snapshot.groups[metric].map((account) => ({
              account,
              converted: convertAnalyticsAmount({
                amount: account.currentAmount,
                currencyCode: account.currencyCode,
                primaryAmount: null,
                primaryCurrencyCode: snapshot.primaryCurrencyCode,
                displayCurrencyCode: snapshot.displayCurrencyCode,
                rates: snapshot.rates,
              }),
            }))
            const hasCompleteCurrentTotal = currentAmounts.every(({ converted }) => converted.value !== null)
            const currentResponse =
              !hasCompleteCurrentTotal && snapshot.period !== '1D'
                ? await repository.getChartOverview({ start: snapshot.end.slice(0, 7) + '-01', end: snapshot.end, period: '1D', accountIds: snapshot.groups[metric].map(({ id }) => id) })
                : null
            return { metric, response, currentResponse, currentAmounts, hasCompleteCurrentTotal }
          }),
        )

        if (responsesWithCurrent.some(({ currentResponse }) => currentResponse && !isResponseSuccess(currentResponse))) {
          if (ownsCurrentState()) Object.assign(balanceState, { status: 'error', error: new Error('Analytics balance request failed'), isStale: hasExistingData })
          return
        }

        const normalized = responsesWithCurrent.map(({ metric, response, currentResponse, currentAmounts, hasCompleteCurrentTotal }) => {
          const normalize = (chartLines) =>
            normalizeBalanceSeries({
              chartLines,
              metric,
              displayCurrencyCode: snapshot.displayCurrencyCode,
              primaryCurrencyCode: snapshot.primaryCurrencyCode,
              rates: snapshot.rates,
            })
          const result = normalize(response?.data ?? [])
          const currentResult = currentResponse ? normalize(currentResponse.data ?? []) : result
          const currentTotal = currentAmounts.reduce((total, { converted }) => total + (converted.value ?? 0), 0)
          const finalPoint = currentResult.points.at(-1)
          const tolerance = 0.5 * 10 ** -snapshot.decimalPlaces
          const isCurrentEstimated = currentAmounts.some(({ converted }) => converted.isEstimated)
          const hasCurrentMonthChartPoint = Number.isFinite(finalPoint?.value) && finalPoint.x.slice(0, 7) === snapshot.end.slice(0, 7)
          const hasSampleDateTruth = snapshot.groups[metric].every(({ currentDate }) => currentDate === finalPoint?.x || (!currentDate && finalPoint?.x === snapshot.end))
          const hasMismatch =
            finalPoint && hasCompleteCurrentTotal && hasSampleDateTruth && (Math.sign(finalPoint.value) !== Math.sign(currentTotal) || Math.abs(finalPoint.value - currentTotal) > tolerance)
          const warnings =
            (hasCompleteCurrentTotal && finalPoint && !hasSampleDateTruth) || (!hasCompleteCurrentTotal && hasCurrentMonthChartPoint && finalPoint.x < snapshot.end)
              ? [{ type: 'current-balance-unverified', sampleDate: finalPoint.x, currentDate: snapshot.end }]
              : hasMismatch
                ? [{ type: 'current-balance-mismatch', sampleDate: finalPoint.x, chartValue: finalPoint.value, currentValue: currentTotal }]
                : []

          return {
            id: metric,
            ...result,
            currentPoint: hasCompleteCurrentTotal
              ? { x: snapshot.end, value: currentTotal, ...(isCurrentEstimated ? { isEstimated: true } : {}) }
              : hasCurrentMonthChartPoint
                ? { x: finalPoint.x, value: finalPoint.value, ...(finalPoint.isEstimated ? { isEstimated: true } : {}) }
                : null,
            missingCurrencies: [...new Set([...result.missingCurrencies, ...currentResult.missingCurrencies, ...currentAmounts.map(({ converted }) => converted.missingCurrency).filter(Boolean)])],
            warnings,
          }
        })

        balanceCache.value = { ...balanceCache.value, [snapshot.cacheKey]: normalized }
        if (ownsCurrentState()) Object.assign(balanceState, { status: normalized.some(({ points }) => points.length > 0) ? 'ready' : 'empty', error: null, isStale: false })
      })()
      balanceRequests.set(snapshot.cacheKey, { token: requestToken, promise: request })
      try {
        return await request
      } finally {
        if (balanceRequests.get(snapshot.cacheKey)?.token === requestToken) balanceRequests.delete(snapshot.cacheKey)
      }
    }

    async function init() {
      await appStore.syncEverythingIfOld()
      if (!dashboardStore.dashboardCurrency?.id) dashboardStore.dashboardCurrency = currencyStore.defaultCurrency
      await Promise.all([fetchBalances(), fetchTransactions()])
    }

    async function refresh() {
      await Promise.allSettled([fetchBalances({ force: true }), fetchTransactions({ force: true })])
    }

    async function retryBalance() {
      await fetchBalances({ force: true })
    }

    async function retryCategory() {
      await fetchTransactions({ force: true })
    }

    async function retryFlow() {
      await fetchTransactions({ force: true })
    }

    watch(balancePeriod, () => fetchBalances())
    watch(displayCurrencyCode, () => fetchBalances())

    return {
      balancePeriod,
      categoryAverageMonths,
      selectedCategoryIds,
      savingsView,
      availableBalanceMetricIds,
      availableFinancialMetricIds,
      financialTrendView,
      visibleBalanceMetrics,
      visibleFinancialMetrics,
      selectedFlowMonth,
      balanceState,
      categoryState,
      flowState,
      balanceSeries,
      balanceWarnings,
      financialTrend,
      categoryRanking,
      categoryRankingItems,
      categorySummary,
      selectedFlow,
      flowMonthMin,
      flowMonthMax,
      displayCurrencyCode,
      displayCurrencyDecimalPlaces,
      init,
      refresh,
      retryBalance,
      retryCategory,
      retryFlow,
    }
  })
}
