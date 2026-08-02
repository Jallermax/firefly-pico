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
  const visibleBalanceMetrics = useLocalStorage('analyticsVisibleBalanceMetrics', ['netWorth', 'savings', 'debt'])
  const selectedFlowMonth = ref(startOfMonth(new Date()))

  const balanceState = reactive({ status: 'idle', error: null, isStale: false })
  const categoryState = reactive({ status: 'idle', error: null, isStale: false })
  const flowState = reactive({ status: 'idle', error: null, isStale: false })
  const balanceCache = ref({})
  const transactions = ref([])
  const categorySelectionInitialized = ref(false)

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
      categoryIds: selectedCategoryIds.value,
      averageMonths: categoryAverageMonths.value,
      today: new Date(),
    }),
    isEstimated: categoryLedger.value.isEstimated,
    missingCurrencies: categoryLedger.value.missingCurrencies,
  }))
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

  const balanceCacheKey = computed(() => {
    const groups = Object.fromEntries(BALANCE_METRICS.map((metric) => [metric, accountGroups.value[metric].map((account) => account.id).sort()]))
    const currencyCodes = [
      displayCurrencyCode.value,
      primaryCurrencyCode.value,
      ...BALANCE_METRICS.flatMap((metric) => accountGroups.value[metric].map((account) => Account.getCurrencyCode(account) ?? account?.attributes?.currency_code)),
    ]
      .filter(Boolean)
      .sort()
    const relevantRates = Object.fromEntries([...new Set(currencyCodes)].map((currencyCode) => [currencyCode, rates.value[currencyCode] ?? null]))
    return JSON.stringify({ period: Number(balancePeriod.value), displayCurrencyCode: displayCurrencyCode.value, primaryCurrencyCode: primaryCurrencyCode.value, rates: relevantRates, groups })
  })
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
      const validSelection = selectedCategoryIds.value.filter((categoryId) => validCategoryIds.has(categoryId))
      selectedCategoryIds.value = validSelection.length > 0 ? validSelection : categoryRanking.value.slice(0, 5)
      categorySelectionInitialized.value = true
    }
  }

  async function fetchBalances({ force = false } = {}) {
    const cacheKey = balanceCacheKey.value
    const cached = balanceCache.value[cacheKey]
    if (cached && !force) {
      Object.assign(balanceState, { status: cached.some(({ points }) => points.length > 0) ? 'ready' : 'empty', error: null, isStale: false })
      return
    }

    const hasExistingData = Boolean(cached?.some(({ points }) => points.length > 0))
    Object.assign(balanceState, { status: 'loading', error: null, isStale: hasExistingData })

    const today = new Date()
    const start = DateUtils.dateToString(subMonths(today, Number(balancePeriod.value)))
    const end = DateUtils.dateToString(today)
    const period = Number(balancePeriod.value) === 3 ? '1D' : '1W'
    const repository = new AccountRepository()
    const responses = await Promise.all(
      BALANCE_METRICS.map(async (metric) => {
        const accountIds = accountGroups.value[metric].map((account) => account.id)
        if (accountIds.length === 0) return { metric, response: null }
        const response = await repository.getChartOverview({ start, end, period, accountIds })
        return { metric, response }
      }),
    )

    if (responses.some(({ response }) => response && !ResponseUtils.isSuccess(response))) {
      Object.assign(balanceState, { status: 'error', error: new Error('Analytics balance request failed'), isStale: hasExistingData })
      return
    }

    const normalized = responses.map(({ metric, response }) => {
      const result = normalizeBalanceSeries({
        chartLines: response?.data ?? [],
        metric,
        displayCurrencyCode: displayCurrencyCode.value,
        primaryCurrencyCode: primaryCurrencyCode.value,
        rates: rates.value,
      })
      const currentAmounts = accountGroups.value[metric].map((account) =>
        convertAnalyticsAmount({
          amount: Account.getBalance(account),
          currencyCode: Account.getCurrencyCode(account) ?? account?.attributes?.currency_code,
          primaryAmount: null,
          primaryCurrencyCode: primaryCurrencyCode.value,
          displayCurrencyCode: displayCurrencyCode.value,
          rates: rates.value,
        }),
      )
      const currentTotal = currentAmounts.reduce((total, converted) => total + (metric === 'debt' ? Math.max(0, -(converted.value ?? 0)) : (converted.value ?? 0)), 0)
      const finalPoint = result.points.at(-1)
      const tolerance = 0.5 * 10 ** -displayCurrencyDecimalPlaces.value
      const isCurrentSample = finalPoint?.x === end
      const hasCompleteCurrentTotal = currentAmounts.every(({ value }) => value !== null)
      const hasMismatch = hasCompleteCurrentTotal && isCurrentSample && (Math.sign(finalPoint.value) !== Math.sign(currentTotal) || Math.abs(finalPoint.value - currentTotal) > tolerance)
      const warnings = hasMismatch ? [{ type: 'current-balance-mismatch', sampleDate: finalPoint.x, chartValue: finalPoint.value, currentValue: currentTotal }] : []

      return { id: metric, ...result, missingCurrencies: [...new Set([...result.missingCurrencies, ...currentAmounts.map(({ missingCurrency }) => missingCurrency).filter(Boolean)])], warnings }
    })

    balanceCache.value = { ...balanceCache.value, [cacheKey]: normalized }
    Object.assign(balanceState, { status: normalized.some(({ points }) => points.length > 0) ? 'ready' : 'empty', error: null, isStale: false })
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
