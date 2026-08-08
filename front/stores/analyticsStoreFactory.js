import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { addMonths, format, parseISO, startOfMonth, subMonths } from 'date-fns'
import DateUtils from '../utils/DateUtils.js'
import {
  buildGrossCategoryLedger,
  buildMonthlyMoneyFlow,
  convertAnalyticsAmount,
  getAnalyticsAccountKind,
  limitMoneyFlowGraphDetail,
  rankCategoryIds,
  summarizeBalanceMovements,
  summarizeCategoryWindow,
  summarizeTotalExpenseWindow,
} from '../utils/AnalyticsUtils.js'
import { buildRemainingActivityForecast } from '../utils/AnalyticsForecastUtils.js'
import { buildDefinedOccurrences, detectRecurringCandidates, mergeRecurringCandidates } from '../utils/AnalyticsRecurringUtils.js'

const BALANCE_GROUPS = ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt']
const RECONSTRUCTED_METRICS = ['netWorth', 'savings', 'savingsIncluded', 'savingsExcluded', 'debt', 'expenses']
const SAVINGS_VIEWS = ['combined', 'split']
const FINANCIAL_TREND_VIEWS = ['balances', 'changes']
const MONEY_FLOW_DETAIL_LEVELS = [5, 10, 'all']
const CATEGORY_SERIES_LIMIT = 6

const balanceMetricIdsForSavingsView = (view) => (view === 'split' ? ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt'] : ['netWorth', 'savings', 'debt'])
const financialMetricIdsForSavingsView = (view) => [...balanceMetricIdsForSavingsView(view), 'expenses']

export function createAnalyticsStore(id, useDependencies) {
  return defineStore(id, () => {
    const {
      dashboardStore,
      currencyStore,
      useStoredValue,
      accountRepository,
      transactionRepository,
      transactionLinkRepository,
      transactionLinkTypeRepository,
      subscriptionRepository,
      recurringTransactionRepository,
      transformTransactions,
      getCurrencyCode,
      getCurrencyDecimalPlaces,
      getExcludedTransactionFilters,
      buildLedger,
      reconstructBalances,
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
    const storedGraphDetail = useStoredValue('analyticsMoneyFlowDetail', 5)
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
    const normalizeGraphDetail = (detailLevel) => (MONEY_FLOW_DETAIL_LEVELS.includes(detailLevel) ? detailLevel : 5)
    if (!MONEY_FLOW_DETAIL_LEVELS.includes(storedGraphDetail.value)) storedGraphDetail.value = 5
    const graphDetail = computed({
      get: () => normalizeGraphDetail(storedGraphDetail.value),
      set: (detailLevel) => {
        storedGraphDetail.value = normalizeGraphDetail(detailLevel)
      },
    })
    const selectedFlowMonth = ref(startOfMonth(getNow()))

    const balanceState = reactive({ status: 'idle', error: null, isStale: false })
    const categoryState = reactive({ status: 'idle', error: null, isStale: false })
    const flowState = reactive({ status: 'idle', error: null, isStale: false })
    const ancillaryState = reactive({
      transactionLinks: { status: 'idle', error: null },
      transactionLinkTypes: { status: 'idle', error: null },
      subscriptions: { status: 'idle', error: null },
      recurringTransactions: { status: 'idle', error: null },
    })
    const rawSnapshot = ref({
      accounts: [],
      transactions: [],
      transactionLinks: [],
      transactionLinkTypes: [],
      subscriptions: [],
      recurringTransactions: [],
      rates: { ...currencyStore.exchangeRates?.rates },
      transactionCoverage: null,
      asOfDate: null,
    })
    const accounts = computed(() => rawSnapshot.value.accounts)
    const transactions = computed(() => rawSnapshot.value.transactions)
    const transactionLinks = computed(() => rawSnapshot.value.transactionLinks)
    const transactionLinkTypes = computed(() => rawSnapshot.value.transactionLinkTypes)
    const subscriptions = computed(() => rawSnapshot.value.subscriptions)
    const recurringTransactions = computed(() => rawSnapshot.value.recurringTransactions)
    const categorySelectionInitialized = ref(false)
    let snapshotGeneration = 0
    let activeSnapshotGeneration = 0
    let snapshotRequest = null

    const displayCurrencyCode = computed(() => dashboardStore.dashboardCurrencyCode)
    const primaryCurrencyCode = computed(() => getCurrencyCode(currencyStore.defaultCurrency))
    const displayCurrencyDecimalPlaces = computed(() => {
      const decimalPlaces = getCurrencyDecimalPlaces(dashboardStore.dashboardCurrency)
      return decimalPlaces === null || decimalPlaces === undefined ? 2 : Number(decimalPlaces)
    })
    const rates = computed(() => rawSnapshot.value.rates)
    const ledger = computed(() =>
      buildLedger({
        transactions: transactions.value,
        transactionLinks: transactionLinks.value,
        linkTypes: transactionLinkTypes.value,
        accounts: accounts.value,
        displayCurrencyCode: displayCurrencyCode.value,
        primaryCurrencyCode: primaryCurrencyCode.value,
        rates: rates.value,
      }),
    )
    const categoryLedger = computed(() => buildGrossCategoryLedger({ ledger: ledger.value, coverage: rawSnapshot.value.transactionCoverage }))
    const categoryWindowMonthKeys = computed(() => {
      const currentMonth = startOfMonth(getNow())
      return new Set([format(currentMonth, 'yyyy-MM'), ...Array.from({ length: Number(categoryAverageMonths.value) }, (_, index) => format(subMonths(currentMonth, index + 1), 'yyyy-MM'))])
    })
    const categoryWindowUnclassifiedIds = computed(() =>
      [...categoryWindowMonthKeys.value]
        .flatMap((key) => categoryLedger.value.unclassifiedByMonth?.[key] ?? [])
        .filter(Boolean)
        .sort(),
    )
    const categoryBlockingTransactionIds = computed(() =>
      [...categoryWindowMonthKeys.value]
        .flatMap((key) => normalizedSelectedCategoryIds.value.flatMap((categoryId) => categoryLedger.value.unclassifiedByMonthCategory?.[key]?.[categoryId] ?? []))
        .filter(Boolean)
        .sort(),
    )
    const categoryUnclassified = computed(() => ({ value: categoryBlockingTransactionIds.value.length ? null : 0, transactionIds: categoryBlockingTransactionIds.value }))
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
    const categorySummaryBase = computed(() => {
      const summary = summarizeCategoryWindow({
        ledger: categoryLedger.value,
        categoryIds: normalizedSelectedCategoryIds.value,
        averageMonths: categoryAverageMonths.value,
        today: getNow(),
      })
      return {
        ...summary,
        ...(categoryBlockingTransactionIds.value.length ? { series: [] } : {}),
        isEstimated: categoryLedger.value.isEstimated,
        missingCurrencies: categoryLedger.value.missingCurrencies,
        unclassified: categoryUnclassified.value,
      }
    })
    const forecastStartDate = computed(() => `${rawSnapshot.value.transactionCoverage?.startMonth ?? format(startOfMonth(subMonths(getNow(), 24)), 'yyyy-MM')}-01`)
    const forecastEndDate = computed(() => format(new Date(getNow().getFullYear(), getNow().getMonth() + 1, 0), 'yyyy-MM-dd'))
    const forecastCandidates = computed(() =>
      mergeRecurringCandidates({
        defined: buildDefinedOccurrences({
          recurringTransactions: recurringTransactions.value,
          subscriptions: subscriptions.value,
          startDate: forecastStartDate.value,
          endDate: forecastEndDate.value,
        }),
        inferred: detectRecurringCandidates({ entries: ledger.value.entries, startDate: forecastStartDate.value, endDate: DateUtils.dateToString(getNow()) }).candidates,
      }),
    )
    const forecastAccountContexts = computed(() =>
      Object.fromEntries(
        accounts.value.map((account) => {
          const kind = getAnalyticsAccountKind(account)
          return [
            account.id,
            {
              kind: kind === 'savings' ? (account?.attributes?.include_net_worth === true ? 'savingsAccessible' : 'savingsRestricted') : kind.startsWith('liability') ? 'liability' : kind,
              includeNetWorth: account?.attributes?.include_net_worth === true,
            },
          ]
        }),
      ),
    )
    const forecastCandidateAmounts = computed(() => {
      const definitionFor = (candidate) => {
        const collection = candidate.source.type === 'subscription' ? subscriptions.value : recurringTransactions.value
        return collection.find((item) => String(item?.id) === String(candidate.source.id))?.attributes ?? {}
      }
      return Object.fromEntries(
        forecastCandidates.value.map((candidate) => {
          if (!candidate.source.authoritative)
            return [
              candidate.id,
              { value: candidate.expectedAmount?.value, conversion: { mode: 'exact', sourceCurrency: displayCurrencyCode.value, displayCurrency: displayCurrencyCode.value, isEstimated: false } },
            ]
          const attributes = definitionFor(candidate)
          const transaction = attributes.transactions?.[0] ?? {}
          const amount = transaction.primary_amount ?? transaction.amount ?? attributes.pc_amount_avg ?? attributes.amount_avg ?? candidate.expectedAmount?.value
          const currencyCode =
            transaction.primary_amount !== null && transaction.primary_amount !== undefined
              ? (transaction.primary_currency_code ?? primaryCurrencyCode.value)
              : (transaction.currency_code ?? attributes.pc_currency_code ?? attributes.currency_code)
          const converted = convertAnalyticsAmount({ amount, currencyCode, displayCurrencyCode: displayCurrencyCode.value, primaryCurrencyCode: primaryCurrencyCode.value, rates: rates.value })
          const sourceAmount = Number(amount)
          const mode = converted.missingCurrency || !Number.isFinite(converted.value) ? 'unavailable' : currencyCode === displayCurrencyCode.value ? 'exact' : 'rate'
          return [
            candidate.id,
            {
              value: converted.value,
              conversion: {
                mode,
                sourceCurrency: currencyCode ?? null,
                displayCurrency: displayCurrencyCode.value,
                isEstimated: converted.isEstimated,
                ...(mode === 'rate' && sourceAmount !== 0 ? { rate: converted.value / sourceAmount } : {}),
                ...(converted.missingCurrency ? { missingCurrency: converted.missingCurrency } : {}),
              },
            },
          ]
        }),
      )
    })
    const buildForecast = (historyMonths) =>
      buildRemainingActivityForecast({
        ledger: ledger.value,
        candidates: forecastCandidates.value,
        candidateAmounts: forecastCandidateAmounts.value,
        accountContexts: forecastAccountContexts.value,
        fetchCoverage: rawSnapshot.value.transactionCoverage,
        currencyDecimalPlaces: displayCurrencyDecimalPlaces.value,
        historyMonths: Number(historyMonths),
        today: getNow(),
        endDate: forecastEndDate.value,
      })
    const categoryForecast = computed(() => buildForecast(categoryAverageMonths.value))
    const categorySummary = computed(() => {
      const forecast = categoryForecast.value
      const available = forecast.statusByMetric.expenses !== 'unavailable' && Number.isFinite(forecast.final.expenses)
      const projectedByCategory = new Map()
      for (const entry of forecast.dailyProjectedEntries) {
        if (!Number.isFinite(entry.flowAmounts?.expenses) || !entry.categoryId) continue
        projectedByCategory.set(entry.categoryId, (projectedByCategory.get(entry.categoryId) ?? 0) + entry.flowAmounts.expenses)
      }
      return {
        ...categorySummaryBase.value,
        series: categorySummaryBase.value.series.map((series) => {
          const remainingFromToday = available ? (projectedByCategory.get(series.id) ?? 0) : null
          const currentForecast = Number.isFinite(remainingFromToday) ? Math.max(series.currentActual, series.currentActual + remainingFromToday) : null
          return {
            ...series,
            currentForecast,
            remainingFromToday,
            forecastAvailable: available,
            final: currentForecast,
            actualToDate: series.currentActual,
            progress: currentForecast > 0 ? series.currentActual / currentForecast : null,
            progressState: forecast.progressState.expenses,
            status: forecast.statusByMetric.expenses,
            projectedSources: forecast.dailyProjectedEntries.filter((entry) => entry.categoryId === series.id && Number.isFinite(entry.flowAmounts?.expenses)),
          }
        }),
      }
    })
    const categoryRankingItems = computed(() => {
      const rankedItems = categoryRanking.value.map((id) => ({
        id,
        amount: categoryBlockingTransactionIds.value.length
          ? null
          : categorySummary.value.monthKeys.reduce((total, key) => total + (categoryLedger.value.months?.[key]?.categories?.[id]?.amount ?? 0), 0),
      }))
      const candidateIds = new Set([...categoryRanking.value, ...currentMonthCategoryIds.value])
      return [
        ...rankedItems,
        ...currentMonthCategoryIds.value.map((id) => ({ id, amount: categoryBlockingTransactionIds.value.length ? null : 0 })),
        ...persistedSelectedCategoryIds.value.filter((id) => !candidateIds.has(id)).map((id) => ({ id, amount: categoryBlockingTransactionIds.value.length ? null : 0 })),
      ]
    })
    const selectedFullFlow = computed(() => {
      return buildMonthlyMoneyFlow({
        entries: ledger.value.entries,
        monthKey: format(selectedFlowMonth.value, 'yyyy-MM'),
        currencyDecimalPlaces: displayCurrencyDecimalPlaces.value,
        savingsView: savingsView.value,
      })
    })
    const selectedFlow = computed(() => {
      const fullGraph = selectedFullFlow.value
      const graph = limitMoneyFlowGraphDetail({ graph: fullGraph, detailLevel: graphDetail.value })
      return {
        ...graph,
        details: { nodes: fullGraph.nodes, links: fullGraph.links },
        meta: { ...fullGraph.meta, detailLevel: graphDetail.value },
      }
    })
    const flowMonthMin = computed(() => (rawSnapshot.value.transactionCoverage?.startMonth ? startOfMonth(parseISO(rawSnapshot.value.transactionCoverage.startMonth + '-01')) : null))
    const flowMonthMax = computed(() => startOfMonth(getNow()))
    const getFlowMonthTarget = (amount) => {
      if (![-1, 1].includes(amount) || !flowMonthMin.value) return null
      const target = startOfMonth(addMonths(selectedFlowMonth.value, amount))
      if (target < flowMonthMin.value || target > flowMonthMax.value) return null
      return target
    }
    const canMoveFlowMonth = (amount) => getFlowMonthTarget(amount) !== null
    const moveFlowMonth = (amount) => {
      const target = getFlowMonthTarget(amount)
      if (!target) return false
      selectedFlowMonth.value = target
      return true
    }

    const balanceMonthKeys = computed(() => {
      const currentMonth = startOfMonth(rawSnapshot.value.asOfDate ? parseISO(rawSnapshot.value.asOfDate) : getNow())
      const months = Number(balancePeriod.value)
      return Array.from({ length: months + 1 }, (_, index) => format(subMonths(currentMonth, months + 1 - index), 'yyyy-MM'))
    })
    const balanceSeriesByMetric = computed(() =>
      Object.fromEntries(
        RECONSTRUCTED_METRICS.map((metric) => [
          metric,
          reconstructBalances({
            accounts: accounts.value,
            entries: ledger.value.entries,
            metric,
            monthKeys: balanceMonthKeys.value,
            asOfDate: rawSnapshot.value.asOfDate,
            coverage: rawSnapshot.value.transactionCoverage,
            displayCurrencyCode: displayCurrencyCode.value,
            primaryCurrencyCode: primaryCurrencyCode.value,
            rates: rates.value,
            currencyDecimalPlaces: displayCurrencyDecimalPlaces.value,
          }),
        ]),
      ),
    )
    const toLegacyBalanceSeries = (result) => ({
      ...result,
      isEstimated: result.fx.isEstimated,
      missingCurrencies: result.fx.missingCurrencies,
      warnings: result.reconciliation.status === 'mismatch' ? [{ type: 'current-balance-mismatch' }] : [],
    })
    const currentFourGroupSeries = computed(() => Object.fromEntries(BALANCE_GROUPS.map((metric) => [metric, toLegacyBalanceSeries(balanceSeriesByMetric.value[metric])])))
    const combinedSavingsSeries = computed(() => toLegacyBalanceSeries(balanceSeriesByMetric.value.savings))
    const balanceSeries = computed(() => {
      const base = currentFourGroupSeries.value
      if (savingsView.value === 'split') return [base.netWorth, base.savingsIncluded, base.savingsExcluded, base.debt]
      return [base.netWorth, combinedSavingsSeries.value, base.debt]
    })
    const analyticsAudit = computed(() => {
      const groupedWarnings = new Map()
      balanceMetricIdsForSavingsView(savingsView.value).forEach((metricId) => {
        const reconciliation = balanceSeriesByMetric.value[metricId].reconciliation
        if (reconciliation.status !== 'mismatch') return
        const code = 'current-balance-mismatch'
        const warning = groupedWarnings.get(code) ?? { code, metricIds: [], accountIds: new Set(), transactionIds: new Set() }
        warning.metricIds.push(metricId)
        reconciliation.accounts.forEach((account) => {
          warning.accountIds.add(account.id)
          account.transactionIds.forEach((transactionId) => warning.transactionIds.add(transactionId))
        })
        groupedWarnings.set(code, warning)
      })
      return {
        ...ledger.value.audit,
        fx: ledger.value.fx,
        warnings: [...groupedWarnings.values()].map((warning) => ({
          code: warning.code,
          metricIds: warning.metricIds,
          accountIds: [...warning.accountIds].sort(),
          transactionIds: [...warning.transactionIds].sort(),
        })),
      }
    })
    const balanceWarnings = computed(() => {
      const selectedMetricIds = financialTrendView.value === 'balances' ? visibleBalanceMetrics.value : visibleFinancialMetrics.value
      return analyticsAudit.value.warnings.flatMap(({ code, metricIds }) => {
        const visibleMetricIds = [...new Set(metricIds.map((metricId) => (savingsView.value === 'combined' && ['savingsIncluded', 'savingsExcluded'].includes(metricId) ? 'savings' : metricId)))]
        const affectedMetricIds = visibleMetricIds.filter((metricId) => selectedMetricIds.includes(metricId))
        return affectedMetricIds.length > 0 ? [{ type: code, metricIds: affectedMetricIds }] : []
      })
    })
    const fxDisclosure = computed(() => {
      const affectedMetrics = new Set(
        financialMetricIdsForSavingsView(savingsView.value).filter((metric) => {
          const fx = balanceSeriesByMetric.value[metric].fx
          return fx.isEstimated || fx.missingCurrencies.length > 0
        }),
      )
      if (ledger.value.entries.some(({ destinationKind, conversion }) => destinationKind === 'expense' && ['rate', 'unavailable'].includes(conversion.mode))) affectedMetrics.add('expenses')
      const affected = [...affectedMetrics]
      const usesCurrentRates = ledger.value.fx.isEstimated || affected.some((metric) => balanceSeriesByMetric.value[metric].fx.isEstimated)
      const missingCurrencies = [...new Set([...ledger.value.fx.missingCurrencies, ...affected.flatMap((metric) => balanceSeriesByMetric.value[metric].fx.missingCurrencies)])].sort()
      if (!usesCurrentRates && missingCurrencies.length === 0) return null
      return { displayCurrencyCode: displayCurrencyCode.value, usesCurrentRates, missingCurrencies, metricIds: affected }
    })
    const financialForecast = computed(() => buildForecast(balancePeriod.value))
    const financialTrend = computed(() => {
      const forecast = financialForecast.value
      const remainingFor = (metric) => {
        const flowKey = { netWorth: 'netWorthChange', debt: 'debtChange', savings: 'savingsChange' }[metric]
        if (flowKey) return forecast.remainingFromToday[flowKey]
        const savingsKind = metric === 'savingsIncluded' ? 'savingsAccessible' : metric === 'savingsExcluded' ? 'savingsRestricted' : null
        if (!savingsKind) return null
        return forecast.dailyProjectedEntries.reduce((total, entry) => total + (entry.destinationKind === savingsKind ? entry.amount : 0) - (entry.sourceKind === savingsKind ? entry.amount : 0), 0)
      }
      const trend = summarizeBalanceMovements({ balanceSeries: balanceSeries.value, months: Number(balancePeriod.value), today: getNow() })
      const series = trend.series.map((item) => {
        const remainingFromToday = remainingFor(item.id)
        const flowKey = { netWorth: 'netWorthChange', debt: 'debtChange', savings: 'savingsChange' }[item.id]
        const status = flowKey ? forecast.statusByMetric[flowKey] : forecast.status
        const forecastAvailable = status !== 'unavailable' && Number.isFinite(remainingFromToday) && Number.isFinite(item.currentTotal)
        return {
          ...item,
          forecastAvailable,
          forecastChange: forecastAvailable && Number.isFinite(item.currentChange) ? item.currentChange + remainingFromToday : null,
          forecastTotal: forecastAvailable ? item.currentTotal + remainingFromToday : null,
          remainingFromToday: forecastAvailable ? remainingFromToday : null,
          actualToDate: flowKey ? forecast.actualToDate[flowKey] : item.currentChange,
          final: flowKey ? forecast.final[flowKey] : null,
          progress: flowKey ? forecast.progress[flowKey] : null,
          progressState: flowKey ? forecast.progressState[flowKey] : 'notApplicable',
          status,
        }
      })
      const expenseBase = categoryWindowUnclassifiedIds.value.length ? null : summarizeTotalExpenseWindow({ ledger: categoryLedger.value, averageMonths: Number(balancePeriod.value), today: getNow() })
      const expensesAvailable = forecast.statusByMetric.expenses !== 'unavailable' && Number.isFinite(forecast.final.expenses)
      const expenses = !expenseBase
        ? null
        : {
            ...expenseBase,
            currentActual: expenseBase.currentActual,
            currentForecast: forecast.final.expenses,
            remainingFromToday: forecast.remainingFromToday.expenses,
            forecastAvailable: expensesAvailable,
            final: forecast.final.expenses,
            actualToDate: forecast.actualToDate.expenses,
            progress: forecast.progress.expenses,
            progressState: forecast.progressState.expenses,
            status: forecast.statusByMetric.expenses,
            actualTransactionIds: forecast.actualTransactionIds.expenses,
            projectedSources: forecast.dailyProjectedEntries.filter((entry) => Number.isFinite(entry.flowAmounts?.expenses)),
          }
      return { ...trend, series, expenses, forecast }
    })

    async function loadTransactions(startDate, endDate) {
      const query = [`date_after:${startDate}`, `date_before:${endDate}`, ...getExcludedTransactionFilters()]
      const filters = [{ field: 'query', value: query.join(' ') }]
      const getAll = (options) => transactionRepository.searchTransaction({ ...options, showLoading: false, showErrorToast: false })
      const result = await transactionRepository.getAllWithMergeResult({ filters, getAll, pageSize: 200 })
      return result.ok ? { ok: true, data: transformTransactions(result.data) } : { ok: false, data: [] }
    }

    async function loadSnapshot({ force = false } = {}) {
      if (!force && snapshotRequest) return snapshotRequest.promise

      const generation = ++snapshotGeneration
      activeSnapshotGeneration = generation
      const today = getNow()
      const startDate = DateUtils.dateToString(startOfMonth(subMonths(today, 24)))
      const endDate = DateUtils.dateToString(today)
      const ownsCurrentSnapshot = () => activeSnapshotGeneration === generation
      Object.values(ancillaryState).forEach((state) => Object.assign(state, { status: 'loading', error: null }))
      Object.assign(balanceState, { status: 'loading', error: null, isStale: false })
      Object.assign(categoryState, { status: 'loading', error: null, isStale: false })
      Object.assign(flowState, { status: 'loading', error: null, isStale: false })

      const request = (async () => {
        const [accountResult, transactionLinkResult, transactionLinkTypeResult, subscriptionResult, recurringTransactionResult, rateResult, transactionResult] = await Promise.all([
          accountRepository.getAllWithMergeResult({ pageSize: 200 }),
          transactionLinkRepository.getAll(),
          transactionLinkTypeRepository.getAll(),
          subscriptionRepository.getAll(startDate, endDate),
          recurringTransactionRepository.getAllWithMergeResult({ pageSize: 200 }),
          (async () => {
            await currencyStore.fetchExchangeRate?.()
            return { ...currencyStore.exchangeRates?.rates }
          })(),
          loadTransactions(startDate, endDate),
        ])
        if (!ownsCurrentSnapshot()) return

        const ancillaryInputs = [
          ['transactionLinks', transactionLinkResult, 'transaction link'],
          ['transactionLinkTypes', transactionLinkTypeResult, 'transaction link type'],
          ['subscriptions', subscriptionResult, 'subscription'],
          ['recurringTransactions', recurringTransactionResult, 'recurring transaction'],
        ]
        ancillaryInputs.forEach(([name, result, label]) => {
          if (result?.ok) {
            Object.assign(ancillaryState[name], { status: result.data.length > 0 ? 'ready' : 'empty', error: null })
          } else {
            Object.assign(ancillaryState[name], { status: 'error', error: new Error(`Analytics ${label} request failed`) })
          }
        })

        rawSnapshot.value = {
          accounts: accountResult?.ok ? accountResult.data : [],
          transactions: transactionResult.ok ? transactionResult.data : [],
          transactionLinks: transactionLinkResult?.ok ? transactionLinkResult.data : [],
          transactionLinkTypes: transactionLinkTypeResult?.ok ? transactionLinkTypeResult.data : [],
          subscriptions: subscriptionResult?.ok ? subscriptionResult.data : [],
          recurringTransactions: recurringTransactionResult?.ok ? recurringTransactionResult.data : [],
          rates: rateResult,
          transactionCoverage: transactionResult.ok ? { startMonth: startDate.slice(0, 7), endDate } : null,
          asOfDate: endDate,
        }

        const transactionStatus = transactionResult.data.length > 0 ? 'ready' : 'empty'
        if (transactionResult.ok) {
          Object.assign(categoryState, { status: transactionStatus, error: null, isStale: false })
          Object.assign(flowState, { status: transactionStatus, error: null, isStale: false })
        } else {
          const error = new Error('Analytics transaction request failed')
          Object.assign(categoryState, { status: 'error', error, isStale: false })
          Object.assign(flowState, { status: 'error', error, isStale: false })
        }

        if (!accountResult?.ok) Object.assign(balanceState, { status: 'error', error: new Error('Analytics account request failed'), isStale: false })
        else if (!transactionResult.ok) Object.assign(balanceState, { status: 'error', error: new Error('Analytics transaction request failed'), isStale: false })
        else {
          const projections = balanceSeriesByMetric.value
          const hasBalanceData = BALANCE_GROUPS.some((metric) => projections[metric].currentPoint || projections[metric].points.some(({ value }) => Number.isFinite(value)))
          Object.assign(balanceState, { status: hasBalanceData ? 'ready' : 'empty', error: null, isStale: false })
        }

        if (!categorySelectionInitialized.value) {
          if (persistedSelectedCategoryIds.value.length === 0) selectedCategoryIds.value = (categoryRanking.value.length > 0 ? categoryRanking.value : currentMonthCategoryIds.value).slice(0, 5)
          categorySelectionInitialized.value = true
        }
      })()
      snapshotRequest = { generation, promise: request }
      try {
        return await request
      } finally {
        if (snapshotRequest?.generation === generation) snapshotRequest = null
      }
    }

    async function init() {
      if (!dashboardStore.dashboardCurrency?.id) dashboardStore.dashboardCurrency = currencyStore.defaultCurrency
      await loadSnapshot()
    }

    async function refresh() {
      await loadSnapshot({ force: true })
    }

    async function retryBalance() {
      await loadSnapshot({ force: true })
    }

    async function retryCategory() {
      await loadSnapshot({ force: true })
    }

    async function retryFlow() {
      await loadSnapshot({ force: true })
    }

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
      graphDetail,
      selectedFlowMonth,
      balanceState,
      categoryState,
      flowState,
      ancillaryState,
      accounts,
      transactions,
      transactionLinks,
      transactionLinkTypes,
      subscriptions,
      recurringTransactions,
      ledger,
      balanceSeriesByMetric,
      balanceSeries,
      balanceWarnings,
      analyticsAudit,
      fxDisclosure,
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
      canMoveFlowMonth,
      moveFlowMonth,
    }
  })
}
