import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { format, parseISO, startOfMonth, subMonths } from 'date-fns'
import DateUtils from '../utils/DateUtils.js'
import {
  buildCategoryLedger,
  buildMonthlyMoneyFlow,
  convertAnalyticsAmount,
  getAnalyticsAccountGroups,
  normalizeBalanceSeries,
  rankCategoryIds,
  summarizeBalanceMovements,
  summarizeCategoryWindow,
  summarizeTotalExpenseWindow,
} from '../utils/AnalyticsUtils.js'

const BALANCE_METRICS = ['netWorth', 'savings', 'debt']
const FINANCIAL_TREND_METRICS = [...BALANCE_METRICS, 'expenses']
const FINANCIAL_TREND_VIEWS = ['balances', 'changes']
const CATEGORY_SERIES_LIMIT = 6

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
    } = useDependencies()

    const balancePeriod = useStoredValue('analyticsBalancePeriod', 3)
    const categoryAverageMonths = useStoredValue('analyticsCategoryAverageMonths', 6)
    const selectedCategoryIds = useStoredValue('analyticsSelectedCategoryIds', [])
    const persistedSelectedCategoryIds = computed(() => [...new Set((Array.isArray(selectedCategoryIds.value) ? selectedCategoryIds.value : []).filter(Boolean))])
    const normalizedSelectedCategoryIds = computed(() => persistedSelectedCategoryIds.value.slice(0, CATEGORY_SERIES_LIMIT))
    const storedVisibleFinancialMetrics = useStoredValue('analyticsVisibleBalanceMetrics', FINANCIAL_TREND_METRICS)
    const storedVisibleBalanceMetrics = useStoredValue('analyticsVisibleBalanceTotalMetrics', BALANCE_METRICS)
    const storedFinancialTrendView = useStoredValue('analyticsFinancialTrendView', 'balances')
    const normalizeMetrics = (metrics, availableMetrics) => {
      const normalized = [...new Set((Array.isArray(metrics) ? metrics : []).filter((metric) => availableMetrics.includes(metric)))]
      return normalized.length > 0 ? normalized : [availableMetrics[0]]
    }
    const visibleFinancialMetrics = computed({
      get: () => normalizeMetrics(storedVisibleFinancialMetrics.value, FINANCIAL_TREND_METRICS),
      set: (metrics) => {
        storedVisibleFinancialMetrics.value = normalizeMetrics(metrics, FINANCIAL_TREND_METRICS)
      },
    })
    const visibleBalanceMetrics = computed({
      get: () => normalizeMetrics(storedVisibleBalanceMetrics.value, BALANCE_METRICS),
      set: (metrics) => {
        storedVisibleBalanceMetrics.value = normalizeMetrics(metrics, BALANCE_METRICS)
      },
    })
    const financialTrendView = computed({
      get: () => (FINANCIAL_TREND_VIEWS.includes(storedFinancialTrendView.value) ? storedFinancialTrendView.value : 'balances'),
      set: (view) => {
        storedFinancialTrendView.value = FINANCIAL_TREND_VIEWS.includes(view) ? view : 'balances'
      },
    })
    const selectedFlowMonth = ref(startOfMonth(new Date()))

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
        today: new Date(),
      }),
    )
    const currentMonthCategoryIds = computed(() => {
      const rankedIds = new Set(categoryRanking.value)
      const currentCategories = categoryLedger.value.months?.[format(new Date(), 'yyyy-MM')]?.categories ?? {}
      return Object.keys(currentCategories)
        .filter((id) => !rankedIds.has(id))
        .sort((left, right) => currentCategories[right].amount - currentCategories[left].amount || left.localeCompare(right))
    })
    const categorySummary = computed(() => ({
      ...summarizeCategoryWindow({
        ledger: categoryLedger.value,
        categoryIds: normalizedSelectedCategoryIds.value,
        averageMonths: categoryAverageMonths.value,
        today: new Date(),
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
    const flowMonthMax = computed(() => startOfMonth(new Date()))

    function getBalanceSnapshot() {
      const groups = Object.fromEntries(
        BALANCE_METRICS.map((metric) => [
          metric,
          accountGroups.value[metric].map((account) => {
            const type = account?.attributes?.type?.fireflyCode ?? account?.attributes?.type
            const direction = account?.attributes?.liability_direction?.fireflyCode ?? account?.attributes?.liability_direction
            const usesCurrentDebt = metric === 'debt' && type === 'liabilities' && direction === 'debit'
            const currentDate = account?.attributes?.current_balance_date
            return {
              id: account.id,
              currencyCode: getAccountCurrencyCode(account) ?? account?.attributes?.currency_code,
              currentAmount: usesCurrentDebt ? account?.attributes?.current_debt : getAccountBalance(account),
              currentDate: currentDate instanceof Date ? DateUtils.dateToString(currentDate) : currentDate?.slice(0, 10),
              usesCurrentDebt,
            }
          }),
        ]),
      )
      const displayCode = displayCurrencyCode.value
      const primaryCode = primaryCurrencyCode.value
      const rateSnapshot = { ...rates.value }
      const currencyCodes = [displayCode, primaryCode, ...BALANCE_METRICS.flatMap((metric) => groups[metric].map(({ currencyCode }) => currencyCode))].filter(Boolean).sort()
      const relevantRates = Object.fromEntries([...new Set(currencyCodes)].map((currencyCode) => [currencyCode, rateSnapshot[currencyCode] ?? null]))
      const months = Number(balancePeriod.value)
      const today = new Date()
      const groupIds = Object.fromEntries(BALANCE_METRICS.map((metric) => [metric, groups[metric].map(({ id }) => id).sort()]))
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
    const balanceSeries = computed(
      () =>
        balanceCache.value[balanceCacheKey.value] ??
        FINANCIAL_TREND_METRICS.filter((metric) => metric !== 'expenses').map((metric) => ({ id: metric, points: [], isEstimated: false, missingCurrencies: [], warnings: [] })),
    )
    const financialTrend = computed(() => ({
      ...summarizeBalanceMovements({ balanceSeries: balanceSeries.value, months: Number(balancePeriod.value), today: new Date() }),
      expenses: summarizeTotalExpenseWindow({ ledger: categoryLedger.value, averageMonths: Number(balancePeriod.value), today: new Date() }),
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
        const today = new Date()
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
          BALANCE_METRICS.map(async (metric) => {
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

        const normalized = responses.map(({ metric, response }) => {
          const result = normalizeBalanceSeries({
            chartLines: response?.data ?? [],
            metric,
            displayCurrencyCode: snapshot.displayCurrencyCode,
            primaryCurrencyCode: snapshot.primaryCurrencyCode,
            rates: snapshot.rates,
          })
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
          const currentTotal = currentAmounts.reduce(
            (total, { account, converted }) =>
              total + (metric === 'debt' ? (account.usesCurrentDebt ? Math.max(0, converted.value ?? 0) : Math.max(0, -(converted.value ?? 0))) : (converted.value ?? 0)),
            0,
          )
          const finalPoint = result.points.at(-1)
          const tolerance = 0.5 * 10 ** -snapshot.decimalPlaces
          const hasCompleteCurrentTotal = currentAmounts.every(({ converted }) => converted.value !== null)
          const hasSampleDateTruth = snapshot.groups[metric].every(({ currentDate }) => currentDate === finalPoint?.x || (!currentDate && finalPoint?.x === snapshot.end))
          const hasMismatch =
            finalPoint && hasCompleteCurrentTotal && hasSampleDateTruth && (Math.sign(finalPoint.value) !== Math.sign(currentTotal) || Math.abs(finalPoint.value - currentTotal) > tolerance)
          const warnings =
            hasCompleteCurrentTotal && finalPoint && !hasSampleDateTruth
              ? [{ type: 'current-balance-unverified', sampleDate: finalPoint.x, currentDate: snapshot.end }]
              : hasMismatch
                ? [{ type: 'current-balance-mismatch', sampleDate: finalPoint.x, chartValue: finalPoint.value, currentValue: currentTotal }]
                : []

          return {
            id: metric,
            ...result,
            currentPoint: hasCompleteCurrentTotal ? { x: snapshot.end, value: currentTotal } : null,
            missingCurrencies: [...new Set([...result.missingCurrencies, ...currentAmounts.map(({ converted }) => converted.missingCurrency).filter(Boolean)])],
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
      financialTrendView,
      visibleBalanceMetrics,
      visibleFinancialMetrics,
      selectedFlowMonth,
      balanceState,
      categoryState,
      flowState,
      balanceSeries,
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
