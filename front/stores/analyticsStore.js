import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { format, parseISO, startOfMonth, subMonths } from 'date-fns'
import { useAppStore } from '~/stores/appStore.js'
import { useDashboardStore } from '~/stores/dashboardStore.js'
import { useAccountStore } from '~/stores/accountStore.js'
import { useCurrencyStore } from '~/stores/currencyStore.js'
import { useCategoryStore } from '~/stores/categoryStore.js'
import AccountRepository from '~/repository/AccountRepository.js'
import TransactionRepository from '~/repository/TransactionRepository.js'
import TransactionTransformer from '~/transformers/TransactionTransformer.js'
import Account from '~/models/Account.js'
import Currency from '~/models/Currency.js'
import DateUtils from '~/utils/DateUtils.js'
import ResponseUtils from '~/utils/ResponseUtils.js'
import { getExcludedTransactionFilters } from '~/utils/DashboardUtils.js'
import {
  ANALYTICS_UNCATEGORIZED_ID,
  buildCategoryLedger,
  buildMonthlyMoneyFlow,
  convertAnalyticsAmount,
  getAnalyticsAccountGroups,
  normalizeBalanceSeries,
  rankCategoryIds,
  summarizeCategoryWindow,
} from '~/utils/AnalyticsUtils.js'

const BALANCE_METRICS = ['netWorth', 'savings', 'debt']

export const useAnalyticsStore = defineStore('analytics', () => {
  const appStore = useAppStore()
  const dashboardStore = useDashboardStore()
  const accountStore = useAccountStore()
  const currencyStore = useCurrencyStore()
  const categoryStore = useCategoryStore()

  const balancePeriod = useLocalStorage('analyticsBalancePeriod', 3)
  const categoryAverageMonths = useLocalStorage('analyticsCategoryAverageMonths', 6)
  const selectedCategoryIds = useLocalStorage('analyticsSelectedCategoryIds', [])
  const normalizedSelectedCategoryIds = computed(() => [...new Set((Array.isArray(selectedCategoryIds.value) ? selectedCategoryIds.value : []).filter(Boolean))].slice(0, 6))
  const visibleBalanceMetrics = useLocalStorage('analyticsVisibleBalanceMetrics', ['netWorth', 'savings', 'debt'])
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

  const displayCurrencyCode = computed(() => dashboardStore.dashboardCurrencyCode)
  const primaryCurrencyCode = computed(() => Currency.getCode(currencyStore.defaultCurrency))
  const displayCurrencyDecimalPlaces = computed(() => {
    const decimalPlaces = Currency.getDecimalPlaces(dashboardStore.dashboardCurrency)
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
  const categoryRankingItems = computed(() =>
    categoryRanking.value.map((id) => ({
      id,
      amount: categorySummary.value.monthKeys.reduce((total, key) => total + (categoryLedger.value.months?.[key]?.categories?.[id]?.amount ?? 0), 0),
    })),
  )
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
            currencyCode: Account.getCurrencyCode(account) ?? account?.attributes?.currency_code,
            currentAmount: usesCurrentDebt ? account?.attributes?.current_debt : Account.getBalance(account),
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
      start: DateUtils.dateToString(subMonths(today, months)),
      end: DateUtils.dateToString(today),
      period: months === 3 ? '1D' : '1W',
      displayCurrencyCode: displayCode,
      primaryCurrencyCode: primaryCode,
      rates: rateSnapshot,
      decimalPlaces: displayCurrencyDecimalPlaces.value,
    }
  }

  const balanceCacheKey = computed(() => getBalanceSnapshot().cacheKey)
  const balanceSeries = computed(() => balanceCache.value[balanceCacheKey.value] ?? BALANCE_METRICS.map((id) => ({ id, points: [], isEstimated: false, missingCurrencies: [], warnings: [] })))

  async function fetchTransactions({ force = false } = {}) {
    const isReady = ['ready', 'empty'].includes(categoryState.status) && ['ready', 'empty'].includes(flowState.status)
    if (isReady && !force) return

    const hasExistingData = transactions.value.length > 0
    Object.assign(categoryState, { status: 'loading', error: null, isStale: hasExistingData })
    Object.assign(flowState, { status: 'loading', error: null, isStale: hasExistingData })

    const today = new Date()
    const query = [`date_after:${DateUtils.dateToString(startOfMonth(subMonths(today, 24)))}`, `date_before:${DateUtils.dateToString(today)}`, ...getExcludedTransactionFilters()]
    const filters = [{ field: 'query', value: query.join(' ') }]
    const repository = new TransactionRepository()
    const getAll = (options) => repository.searchTransaction({ ...options, showLoading: false, showErrorToast: false })
    const result = await repository.getAllWithMergeResult({ filters, getAll, pageSize: 200 })

    if (!result.ok) {
      const error = new Error('Analytics transaction request failed')
      Object.assign(categoryState, { status: 'error', error, isStale: hasExistingData })
      Object.assign(flowState, { status: 'error', error, isStale: hasExistingData })
      return
    }

    const transformed = TransactionTransformer.transformFromApiList(result.data)
    transactions.value = transformed
    const status = transformed.length > 0 ? 'ready' : 'empty'
    Object.assign(categoryState, { status, error: null, isStale: false })
    Object.assign(flowState, { status, error: null, isStale: false })

    if (!categorySelectionInitialized.value) {
      const validCategoryIds = new Set([...Object.keys(categoryStore.categoryDictionary), ANALYTICS_UNCATEGORIZED_ID])
      const validSelection = normalizedSelectedCategoryIds.value.filter((categoryId) => validCategoryIds.has(categoryId))
      selectedCategoryIds.value = validSelection.length > 0 ? validSelection : categoryRanking.value.slice(0, 5)
      categorySelectionInitialized.value = true
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
      const repository = new AccountRepository()
      const responses = await Promise.all(
        BALANCE_METRICS.map(async (metric) => {
          const accountIds = snapshot.groups[metric].map(({ id }) => id)
          if (accountIds.length === 0) return { metric, response: null }
          const response = await repository.getChartOverview({ start: snapshot.start, end: snapshot.end, period: snapshot.period, accountIds })
          return { metric, response }
        }),
      )
      const ownsCurrentState = () => activeBalanceRequestToken === requestToken && balanceCacheKey.value === snapshot.cacheKey

      if (responses.some(({ response }) => response && !ResponseUtils.isSuccess(response))) {
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

        return { id: metric, ...result, missingCurrencies: [...new Set([...result.missingCurrencies, ...currentAmounts.map(({ converted }) => converted.missingCurrency).filter(Boolean)])], warnings }
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
    visibleBalanceMetrics,
    selectedFlowMonth,
    balanceState,
    categoryState,
    flowState,
    balanceSeries,
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
