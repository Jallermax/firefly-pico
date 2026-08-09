import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { addMonths, format, parseISO, startOfMonth, subMonths } from 'date-fns'
import DateUtils from '../utils/DateUtils.js'
import {
  ANALYTICS_UNCATEGORIZED_ID,
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
import { buildRemainingActivityForecast, classifyForecastFlowAmounts, projectMetricForecast } from '../utils/AnalyticsForecastUtils.js'
import { buildDefinedOccurrences, detectRecurringCandidates, mergeRecurringCandidates } from '../utils/AnalyticsRecurringUtils.js'
import { buildCashUseSeries } from '../utils/AnalyticsCashUseUtils.js'

const BALANCE_GROUPS = ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt']
const RECONSTRUCTED_METRICS = ['netWorth', 'savings', 'savingsIncluded', 'savingsExcluded', 'debt', 'expenses']
const SAVINGS_VIEWS = ['combined', 'split']
const FINANCIAL_TREND_VIEWS = ['balances', 'changes']
const MONEY_FLOW_DETAIL_LEVELS = [5, 10, 'all']
const CASH_USE_MODES = ['spending', 'full']
const DAILY_FORECAST_PERIODS = [3, 6, 12]
const DAILY_FLOW_KEYS = ['income', 'refunds', 'expenses', 'savingsDeposits', 'savingsWithdrawals', 'debtRepayments', 'newDebt']
const DAILY_SOURCE_KEYS = ['income', 'refunds', 'savingsWithdrawals', 'newDebt']
const DAILY_USE_KEYS = ['expenses', 'savingsDeposits', 'debtRepayments']
const DAILY_SOURCE_KINDS = ['actual', 'defined', 'inferred', 'variable']
const CATEGORY_SERIES_LIMIT = 6

const balanceMetricIdsForSavingsView = (view) => (view === 'split' ? ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt'] : ['netWorth', 'savings', 'debt'])
const financialMetricIdsForSavingsView = (view) => [...balanceMetricIdsForSavingsView(view), 'expenses']
const emptyDailyComponents = (value = 0) => Object.fromEntries(DAILY_FLOW_KEYS.map((key) => [key, value]))
const roundDaily = (value, decimalPlaces) => Number(value.toFixed(decimalPlaces))
const addDailyComponents = (target, values, decimalPlaces) => {
  DAILY_FLOW_KEYS.forEach((key) => {
    target[key] = target[key] === null || values[key] === null ? null : roundDaily(target[key] + (values[key] ?? 0), decimalPlaces)
  })
}
const dailyTotal = (components, keys, decimalPlaces) =>
  keys.some((key) => components[key] === null)
    ? null
    : roundDaily(
        keys.reduce((total, key) => total + components[key], 0),
        decimalPlaces,
      )
const finishDailyBucket = (bucket, decimalPlaces) => {
  bucket.sources = dailyTotal(bucket.components, DAILY_SOURCE_KEYS, decimalPlaces)
  bucket.uses = dailyTotal(bucket.components, DAILY_USE_KEYS, decimalPlaces)
  bucket.availableCashChange = Number.isFinite(bucket.sources) && Number.isFinite(bucket.uses) ? roundDaily(bucket.sources - bucket.uses, decimalPlaces) : null
  bucket.transactionIds = [...bucket.transactionIds].sort()
  bucket.projectedEvidenceIds = [...bucket.projectedEvidenceIds].sort()
  bucket.entries.sort((left, right) => String(left.sourceKind).localeCompare(String(right.sourceKind)) || String(left.id).localeCompare(String(right.id)))
  return bucket
}
const newDailyBucket = () => ({ components: emptyDailyComponents(), sources: 0, uses: 0, availableCashChange: 0, entries: [], transactionIds: new Set(), projectedEvidenceIds: new Set() })
const dailyDates = (today) => {
  const year = today.getFullYear()
  const month = today.getMonth()
  const count = new Date(year, month + 1, 0).getDate()
  return Array.from({ length: count }, (_, index) => format(new Date(year, month, index + 1), 'yyyy-MM-dd'))
}
const projectedEvidenceIds = (entry) => [entry.sourceId, entry.candidateId, entry.expectedId, ...(entry.evidenceIds ?? [])].filter(Boolean).map(String)
const dailyConfidence = (confidence) => {
  if (!confidence) return null
  const score = Number(confidence.score)
  const level = confidence.level ?? (!Number.isFinite(score) ? 'unavailable' : score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low')
  return { ...confidence, level }
}
const dailyEntryContributes = (entry, keys) => keys.some((key) => entry.flowAmounts?.[key] !== 0)

const buildDailyForecastProjection = ({ ledger, forecast, candidates, today, currencyDecimalPlaces }) => {
  const dateKeys = dailyDates(today)
  const todayKey = format(today, 'yyyy-MM-dd')
  const monthKey = todayKey.slice(0, 7)
  const dayByDate = new Map(
    dateKeys.map((date) => [
      date,
      {
        date,
        label: String(Number(date.slice(-2))),
        isToday: date === todayKey,
        actual: date <= todayKey ? newDailyBucket() : null,
        projected: date > todayKey ? newDailyBucket() : null,
      },
    ]),
  )

  for (const entry of ledger.entries.filter(({ date }) => date?.startsWith(monthKey) && date <= todayKey)) {
    const day = dayByDate.get(entry.date)
    if (!day?.actual) continue
    const classified = classifyForecastFlowAmounts({ entry, currencyDecimalPlaces })
    addDailyComponents(day.actual.components, classified.flowAmounts, currencyDecimalPlaces)
    const hasActivity = DAILY_FLOW_KEYS.some((key) => classified.flowAmounts[key] !== 0)
    if (hasActivity && entry.transactionId) day.actual.transactionIds.add(String(entry.transactionId))
    day.actual.entries.push({
      id: entry.id,
      date: entry.date,
      amount: classified.amount,
      sourceKind: 'actual',
      transactionId: entry.transactionId,
      transactionIds: entry.transactionId ? [String(entry.transactionId)] : [],
      evidenceIds: [],
      flowAmounts: classified.flowAmounts,
      affectedMetricIds: classified.affectedMetricIds,
      status: classified.status,
      conversion: entry.conversion ?? null,
    })
  }

  for (const entry of forecast.dailyProjectedEntries.filter(({ date }) => date > todayKey && date.startsWith(monthKey))) {
    const day = dayByDate.get(entry.date)
    if (!day?.projected) continue
    addDailyComponents(day.projected.components, entry.flowAmounts, currencyDecimalPlaces)
    projectedEvidenceIds(entry).forEach((id) => day.projected.projectedEvidenceIds.add(id))
    day.projected.entries.push({
      ...entry,
      confidence: dailyConfidence(entry.confidence),
      statusByMetric: { ...forecast.statusByMetric },
      transactionIds: [],
      evidenceIds: [...(entry.evidenceIds ?? [])].map(String).sort(),
    })
  }

  const futureDates = dateKeys.filter((date) => date > todayKey)
  const projectedUnavailableFlowKeys = Object.fromEntries(DAILY_SOURCE_KINDS.filter((kind) => kind !== 'actual').map((kind) => [kind, new Map(futureDates.map((date) => [date, new Set()]))]))
  const addProjectedUnavailableFlowKeys = (sourceKind, dates, keys) => {
    dates.forEach((date) => keys.filter((key) => DAILY_FLOW_KEYS.includes(key)).forEach((key) => projectedUnavailableFlowKeys[sourceKind].get(date)?.add(key)))
  }
  const candidateById = new Map(candidates.map((candidate) => [String(candidate.id), candidate]))
  const unresolvedByCandidateId = new Map((forecast.audit.recurring.unresolvedCandidates ?? []).map((candidate) => [String(candidate.candidateId), candidate]))
  const fulfilledExpectedIds = new Set(forecast.audit.recurring.fulfilledExpectedIds ?? [])
  for (const candidateId of forecast.audit.unavailable.candidateIds) {
    const candidate = candidateById.get(String(candidateId))
    const sourceKind = candidate?.source?.authoritative ? 'defined' : 'inferred'
    const affectedMetricIds = unresolvedByCandidateId.get(String(candidateId))?.affectedMetricIds ?? DAILY_FLOW_KEYS
    const expectedDates = (candidate?.expectedDates ?? [])
      .filter((date) => date.startsWith(monthKey) && !fulfilledExpectedIds.has(`expected:${candidate.id}:${date}`))
      .map((date) => (date <= todayKey ? futureDates[0] : date))
      .filter(Boolean)
    addProjectedUnavailableFlowKeys(sourceKind, expectedDates.length > 0 ? [...new Set(expectedDates)] : futureDates, affectedMetricIds)
  }
  const historyMonths = new Set(forecast.audit.history.months ?? [])
  const unavailableEntryIds = new Set(forecast.audit.unavailable.entryIds ?? [])
  for (const entry of ledger.entries.filter((item) => historyMonths.has(item.monthKey) && unavailableEntryIds.has(String(item.id)))) {
    addProjectedUnavailableFlowKeys('variable', futureDates, classifyForecastFlowAmounts({ entry, currencyDecimalPlaces }).affectedMetricIds)
  }
  addProjectedUnavailableFlowKeys(
    'variable',
    futureDates,
    DAILY_FLOW_KEYS.filter((key) => forecast.statusByMetric[key] === 'insufficientHistory'),
  )
  futureDates.forEach((date) => {
    const components = dayByDate.get(date).projected.components
    DAILY_FLOW_KEYS.forEach((key) => {
      if (Object.values(projectedUnavailableFlowKeys).some((dates) => dates.get(date)?.has(key))) components[key] = null
    })
  })

  const days = dateKeys.map((date) => {
    const day = dayByDate.get(date)
    if (day.actual) finishDailyBucket(day.actual, currencyDecimalPlaces)
    if (day.projected) finishDailyBucket(day.projected, currencyDecimalPlaces)
    const components = emptyDailyComponents()
    if (day.actual) addDailyComponents(components, day.actual.components, currencyDecimalPlaces)
    if (day.projected) addDailyComponents(components, day.projected.components, currencyDecimalPlaces)
    const sources = dailyTotal(components, DAILY_SOURCE_KEYS, currencyDecimalPlaces)
    const uses = dailyTotal(components, DAILY_USE_KEYS, currencyDecimalPlaces)
    const availableCashChange = Number.isFinite(sources) && Number.isFinite(uses) ? roundDaily(sources - uses, currencyDecimalPlaces) : null
    return {
      ...day,
      components,
      sources,
      uses,
      availableCashChange,
      transactionIds: day.actual?.transactionIds ?? [],
      projectedEvidenceIds: day.projected?.projectedEvidenceIds ?? [],
    }
  })

  let cumulative = 0
  const cumulativeTransactionIds = new Set()
  const cumulativeProjectedSources = new Map()
  days.forEach((day) => {
    day.transactionIds.forEach((id) => cumulativeTransactionIds.add(id))
    ;(day.projected?.entries ?? []).forEach((entry) => cumulativeProjectedSources.set(entry.id, entry))
    cumulative = cumulative === null || day.availableCashChange === null ? null : roundDaily(cumulative + day.availableCashChange, currencyDecimalPlaces)
    day.cumulativeAvailableCashChange = cumulative
    day.cumulativeTransactionIds = [...cumulativeTransactionIds].sort()
    day.cumulativeProjectedSources = [...cumulativeProjectedSources.values()]
  })

  const barGroups = DAILY_SOURCE_KINDS.flatMap((sourceKind) =>
    ['sources', 'uses'].map((direction) => ({
      id: `${sourceKind}:${direction}`,
      sourceKind,
      direction,
      labelKey: `analytics.daily_forecast.${sourceKind}_${direction}`,
      points: days.map((day) => {
        const bucket = sourceKind === 'actual' ? day.actual : day.projected
        const applicable = sourceKind === 'actual' ? day.date <= todayKey : day.date > todayKey
        const directionKeys = direction === 'sources' ? DAILY_SOURCE_KEYS : DAILY_USE_KEYS
        const entries = applicable ? (bucket?.entries ?? []).filter((entry) => entry.sourceKind === sourceKind && dailyEntryContributes(entry, directionKeys)) : []
        const components = emptyDailyComponents()
        entries.forEach((entry) => addDailyComponents(components, entry.flowAmounts, currencyDecimalPlaces))
        const hasUnavailableMetric = sourceKind !== 'actual' && directionKeys.some((key) => projectedUnavailableFlowKeys[sourceKind].get(day.date)?.has(key))
        const rawValue = applicable && !hasUnavailableMetric ? dailyTotal(components, directionKeys, currencyDecimalPlaces) : null
        const transactionIds = [...new Set(entries.flatMap((entry) => entry.transactionIds ?? []))].sort()
        const evidenceIds = [...new Set(entries.flatMap(projectedEvidenceIds))].sort()
        return {
          x: day.date,
          xLabel: day.label,
          value: direction === 'uses' && Number.isFinite(rawValue) ? -rawValue : rawValue,
          kind: sourceKind === 'actual' ? 'actual' : 'forecast',
          sourceKind,
          direction,
          isToday: day.isToday,
          transactionIds,
          evidenceIds,
          projectedSources: sourceKind === 'actual' ? [] : entries,
          status: sourceKind === 'actual' ? (entries.some(({ status }) => status === 'unavailable') ? 'unavailable' : 'ready') : forecast.status,
          showInTooltip: (Number.isFinite(rawValue) && rawValue !== 0) || transactionIds.length > 0 || evidenceIds.length > 0,
        }
      }),
    })),
  )

  const unavailableTransactionIds = [
    ...new Set(days.flatMap(({ actual }) => (actual?.entries ?? []).filter(({ status }) => status === 'unavailable').flatMap(({ transactionIds }) => transactionIds))),
    ...ledger.entries
      .filter(({ id, monthKey: entryMonth }) => unavailableEntryIds.has(String(id)) && (entryMonth === monthKey || historyMonths.has(entryMonth)))
      .map(({ transactionId }) => transactionId)
      .filter(Boolean)
      .map(String),
  ].sort()
  const componentDeltas = Object.fromEntries(
    DAILY_FLOW_KEYS.map((key) => {
      const expected = ['unavailable', 'insufficientHistory'].includes(forecast.statusByMetric[key])
        ? null
        : roundDaily((forecast.actualToDate[key] ?? 0) + (forecast.remainingFromToday[key] ?? 0), currencyDecimalPlaces)
      const actual = days.some(({ components }) => components[key] === null)
        ? null
        : roundDaily(
            days.reduce((total, day) => total + day.components[key], 0),
            currencyDecimalPlaces,
          )
      return [key, expected === null || actual === null ? null : roundDaily(actual - expected, currencyDecimalPlaces)]
    }),
  )
  const expectedAvailable = ['unavailable', 'insufficientHistory'].includes(forecast.statusByMetric.availableCashChange)
    ? null
    : roundDaily(forecast.actualToDate.availableCashChange + forecast.remainingFromToday.availableCashChange, currencyDecimalPlaces)
  const actualAvailable = days.at(-1)?.cumulativeAvailableCashChange ?? 0
  const availableCashDelta = expectedAvailable === null || actualAvailable === null ? null : roundDaily(actualAvailable - expectedAvailable, currencyDecimalPlaces)
  const relevantUnclassifiedMonths = new Set([monthKey, ...(forecast.audit.history.months ?? [])])
  const relevantUnclassifiedEntries = ledger.entries.filter(
    ({ monthKey: entryMonth, sourceKind, destinationKind }) => relevantUnclassifiedMonths.has(entryMonth) && (sourceKind === 'unknown' || destinationKind === 'unknown'),
  )
  const unclassifiedValue = relevantUnclassifiedEntries.some(({ value }) => !Number.isFinite(value))
    ? null
    : roundDaily(
        relevantUnclassifiedEntries.reduce((total, { value }) => total + Math.abs(value), 0),
        currencyDecimalPlaces,
      )
  const hasUnclassifiedActivity = unclassifiedValue === null || unclassifiedValue !== 0
  const unclassifiedTransactionIds = hasUnclassifiedActivity
    ? [
        ...new Set(
          relevantUnclassifiedEntries
            .map(({ transactionId }) => transactionId)
            .filter(Boolean)
            .map(String),
        ),
      ].sort()
    : []
  const reconciliationStatus =
    hasUnclassifiedActivity || Object.values(componentDeltas).some((value) => value === null) || availableCashDelta === null
      ? 'unavailable'
      : Object.values(componentDeltas).some((value) => value !== 0) || availableCashDelta !== 0
        ? 'mismatch'
        : 'ok'

  return {
    monthKey,
    dateKeys,
    todayIndex: dateKeys.indexOf(todayKey),
    openingValue: 0,
    days,
    barGroups,
    availableLine: {
      id: 'availableCashChange',
      labelKey: 'analytics.daily_forecast.available_change',
      openingValue: 0,
      points: days.map((day) => ({
        x: day.date,
        xLabel: day.label,
        value: day.cumulativeAvailableCashChange,
        kind: day.date <= todayKey ? 'actual' : 'forecast',
        isToday: day.isToday,
        transactionIds: day.date <= todayKey ? day.cumulativeTransactionIds : [],
        actualTransactionIds: day.cumulativeTransactionIds,
        projectedSources: day.cumulativeProjectedSources,
      })),
    },
    confidence: forecast.confidence,
    status: forecast.status,
    statusByMetric: forecast.statusByMetric,
    monthlyTotals: {
      components: Object.fromEntries(
        DAILY_FLOW_KEYS.map((key) => [key, componentDeltas[key] === null ? null : roundDaily(forecast.actualToDate[key] + forecast.remainingFromToday[key], currencyDecimalPlaces)]),
      ),
      sources:
        componentDeltas.income === null || componentDeltas.refunds === null || componentDeltas.savingsWithdrawals === null || componentDeltas.newDebt === null
          ? null
          : roundDaily(
              forecast.actualToDate.income +
                forecast.remainingFromToday.income +
                forecast.actualToDate.refunds +
                forecast.remainingFromToday.refunds +
                forecast.actualToDate.savingsWithdrawals +
                forecast.remainingFromToday.savingsWithdrawals +
                forecast.actualToDate.newDebt +
                forecast.remainingFromToday.newDebt,
              currencyDecimalPlaces,
            ),
      uses:
        componentDeltas.expenses === null || componentDeltas.savingsDeposits === null || componentDeltas.debtRepayments === null
          ? null
          : roundDaily(
              forecast.actualToDate.expenses +
                forecast.remainingFromToday.expenses +
                forecast.actualToDate.savingsDeposits +
                forecast.remainingFromToday.savingsDeposits +
                forecast.actualToDate.debtRepayments +
                forecast.remainingFromToday.debtRepayments,
              currencyDecimalPlaces,
            ),
      availableCashChange: expectedAvailable,
    },
    reconciliation: { status: reconciliationStatus, componentDeltas, availableCashDelta },
    audit: {
      fulfilledExpectedIds: forecast.audit.recurring.fulfilledExpectedIds,
      remainingExpectedIds: forecast.audit.recurring.remainingExpectedIds,
      unavailableTransactionIds: [...new Set(unavailableTransactionIds)],
      unavailableEntryIds: forecast.audit.unavailable.entryIds,
      unavailableCandidateIds: forecast.audit.unavailable.candidateIds,
      missingCurrencies: forecast.audit.unavailable.missingCurrencies,
      unclassifiedValue: hasUnclassifiedActivity ? unclassifiedValue : 0,
      unclassifiedTransactionIds,
    },
  }
}

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
    const storedCashUseMode = useStoredValue('analyticsCashUseMode', 'spending')
    const storedCashUseDetail = useStoredValue('analyticsCashUseDetail', 5)
    const storedDailyForecastMonths = useStoredValue('analyticsDailyForecastMonths', 6)
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
    const cashUseMode = computed({
      get: () => (CASH_USE_MODES.includes(storedCashUseMode.value) ? storedCashUseMode.value : 'spending'),
      set: (value) => {
        storedCashUseMode.value = CASH_USE_MODES.includes(value) ? value : 'spending'
      },
    })
    const cashUseDetail = computed({
      get: () => normalizeGraphDetail(storedCashUseDetail.value),
      set: (value) => {
        storedCashUseDetail.value = normalizeGraphDetail(value)
      },
    })
    const dailyForecastMonths = computed({
      get: () => (DAILY_FORECAST_PERIODS.includes(Number(storedDailyForecastMonths.value)) ? Number(storedDailyForecastMonths.value) : 6),
      set: (value) => {
        storedDailyForecastMonths.value = DAILY_FORECAST_PERIODS.includes(Number(value)) ? Number(value) : 6
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
    const forecastDefinedCandidates = computed(() =>
      buildDefinedOccurrences({
        recurringTransactions: recurringTransactions.value,
        subscriptions: subscriptions.value,
        startDate: forecastStartDate.value,
        endDate: forecastEndDate.value,
      }),
    )
    const forecastCandidates = computed(() =>
      mergeRecurringCandidates({
        defined: forecastDefinedCandidates.value,
        inferred: detectRecurringCandidates({ entries: ledger.value.entries, startDate: forecastStartDate.value, endDate: DateUtils.dateToString(getNow()) }).candidates,
      }),
    )
    const dailyForecastCandidates = (historyMonths) => {
      const currentMonth = startOfMonth(getNow())
      const startDate = DateUtils.dateToString(startOfMonth(subMonths(currentMonth, Number(historyMonths))))
      const endDate = DateUtils.dateToString(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 0))
      const entries = ledger.value.entries.filter(({ date }) => date >= startDate && date <= endDate)
      return mergeRecurringCandidates({
        defined: forecastDefinedCandidates.value,
        inferred: detectRecurringCandidates({ entries, startDate, endDate }).candidates,
      })
    }
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
    const candidateAmountsFor = (candidates) => {
      const definitionFor = (candidate) => {
        const collection = candidate.source.type === 'subscription' ? subscriptions.value : recurringTransactions.value
        return collection.find((item) => String(item?.id) === String(candidate.source.id))?.attributes ?? {}
      }
      return Object.fromEntries(
        candidates.map((candidate) => {
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
    }
    const forecastCandidateAmounts = computed(() => candidateAmountsFor(forecastCandidates.value))
    const buildForecast = (historyMonths, candidates = forecastCandidates.value) =>
      buildRemainingActivityForecast({
        ledger: ledger.value,
        candidates,
        candidateAmounts: candidates === forecastCandidates.value ? forecastCandidateAmounts.value : candidateAmountsFor(candidates),
        accountContexts: forecastAccountContexts.value,
        fetchCoverage: rawSnapshot.value.transactionCoverage,
        currencyDecimalPlaces: displayCurrencyDecimalPlaces.value,
        historyMonths: Number(historyMonths),
        today: getNow(),
        endDate: forecastEndDate.value,
      })
    const categoryForecast = computed(() => buildForecast(categoryAverageMonths.value))
    const projectedCategoryIds = computed(() => [
      ...new Set(categoryForecast.value.dailyProjectedEntries.filter((entry) => entry.flowAmounts?.expenses !== 0).map((entry) => entry.categoryId ?? ANALYTICS_UNCATEGORIZED_ID)),
    ])
    const categorySummary = computed(() => {
      const forecast = categoryForecast.value
      const available = forecast.statusByMetric.expenses !== 'unavailable' && Number.isFinite(forecast.final.expenses)
      const projectedByCategory = new Map()
      for (const entry of forecast.dailyProjectedEntries) {
        if (!Number.isFinite(entry.flowAmounts?.expenses) || entry.flowAmounts.expenses === 0) continue
        const categoryId = entry.categoryId ?? ANALYTICS_UNCATEGORIZED_ID
        projectedByCategory.set(categoryId, (projectedByCategory.get(categoryId) ?? 0) + entry.flowAmounts.expenses)
      }
      return {
        ...categorySummaryBase.value,
        series: categorySummaryBase.value.series.map((series) => {
          const remainingFromToday = available ? (projectedByCategory.get(series.id) ?? 0) : null
          const projection = projectMetricForecast({
            metric: 'expenses',
            actual: series.currentActual,
            historicalAverage: series.average,
            remainingActivity: remainingFromToday,
            currencyDecimalPlaces: displayCurrencyDecimalPlaces.value,
          })
          const currentForecast = Number.isFinite(remainingFromToday) ? projection.final : null
          return {
            ...series,
            currentForecast,
            remainingFromToday,
            forecastAvailable: available,
            final: currentForecast,
            actualToDate: series.currentActual,
            progress: projection.progress,
            progressState: projection.progressState,
            status: projection.status,
            projectedSources: forecast.dailyProjectedEntries.filter(
              (entry) => (entry.categoryId ?? ANALYTICS_UNCATEGORIZED_ID) === series.id && Number.isFinite(entry.flowAmounts?.expenses) && entry.flowAmounts.expenses !== 0,
            ),
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
      const candidateIds = new Set([...categoryRanking.value, ...currentMonthCategoryIds.value, ...projectedCategoryIds.value])
      return [
        ...rankedItems,
        ...currentMonthCategoryIds.value.map((id) => ({ id, amount: categoryBlockingTransactionIds.value.length ? null : 0 })),
        ...projectedCategoryIds.value
          .filter((id) => !categoryRanking.value.includes(id) && !currentMonthCategoryIds.value.includes(id))
          .map((id) => ({ id, amount: categoryBlockingTransactionIds.value.length ? null : 0 })),
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
        const splitSavings = ['savingsIncluded', 'savingsExcluded'].includes(item.id)
        const projection = projectMetricForecast({
          metric: flowKey ?? 'savingsChange',
          actual: flowKey ? forecast.actualToDate[flowKey] : item.currentChange,
          historicalAverage: item.averageChange,
          remainingActivity: remainingFromToday,
          currencyDecimalPlaces: displayCurrencyDecimalPlaces.value,
        })
        const status = flowKey ? forecast.statusByMetric[flowKey] : projection.status
        const forecastAvailable = status !== 'unavailable' && Number.isFinite(remainingFromToday) && Number.isFinite(item.currentTotal)
        return {
          ...item,
          forecastAvailable,
          forecastChange: forecastAvailable && Number.isFinite(item.currentChange) ? item.currentChange + remainingFromToday : null,
          forecastTotal: forecastAvailable ? item.currentTotal + remainingFromToday : null,
          remainingFromToday: forecastAvailable ? remainingFromToday : null,
          actualToDate: projection.actualToDate,
          final: splitSavings ? projection.final : forecast.final[flowKey],
          progress: projection.progress,
          progressState: projection.progressState,
          status,
          actualTransactionIds: flowKey ? forecast.actualTransactionIds[flowKey] : (item.changePoints.find((point) => point.kind === 'partial')?.transactionIds ?? []),
          actualTransactionCount: flowKey ? forecast.actualTransactionIds[flowKey].length : (item.changePoints.find((point) => point.kind === 'partial')?.transactionIds ?? []).length,
          projectedSources: forecast.dailyProjectedEntries.filter((entry) => {
            if (flowKey) return entry.flowAmounts?.[flowKey] !== 0
            const savingsKind = item.id === 'savingsIncluded' ? 'savingsAccessible' : 'savingsRestricted'
            return (entry.destinationKind === savingsKind ? entry.amount : entry.sourceKind === savingsKind ? -entry.amount : 0) !== 0
          }),
        }
      })
      const globalGrossExpenseUnavailableTransactionIds = [...new Set(trend.monthKeys.flatMap((key) => categoryLedger.value.unclassifiedByMonth[key] ?? []))]
      const expenseBase = globalGrossExpenseUnavailableTransactionIds.length
        ? null
        : summarizeTotalExpenseWindow({ ledger: categoryLedger.value, averageMonths: Number(balancePeriod.value), today: getNow() })
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
            projectedSources: forecast.dailyProjectedEntries.filter((entry) => entry.flowAmounts?.expenses !== 0),
          }
      return { ...trend, series, expenses, forecast, globalGrossExpenseUnavailableTransactionIds, unavailableRefundTransactionIds: categoryLedger.value.unavailableRefundTransactionIds }
    })
    const cashUseCompletedMonthKeys = computed(() => {
      const currentMonth = startOfMonth(getNow())
      const count = Number(balancePeriod.value)
      return Array.from({ length: count }, (_, index) => format(subMonths(currentMonth, count - index), 'yyyy-MM'))
    })
    const cashUseSeries = computed(() => {
      const currentMonthKey = format(getNow(), 'yyyy-MM')
      const forecast = financialForecast.value
      return buildCashUseSeries({
        ledger: ledger.value,
        remainingActivity: {
          ...forecast,
          currentMonthKey,
          dailyProjectedEntries: forecast.dailyProjectedEntries.map((entry) => ({
            ...entry,
            sourceAccountKind: forecastAccountContexts.value[entry.sourceAccountId]?.kind ?? null,
            destinationAccountKind: forecastAccountContexts.value[entry.destinationAccountId]?.kind ?? null,
          })),
        },
        months: cashUseCompletedMonthKeys.value,
        mode: cashUseMode.value,
        savingsView: savingsView.value,
        categoryIds: persistedSelectedCategoryIds.value,
        detailLevel: cashUseDetail.value,
      })
    })
    const cashUseCategoryRankingItems = computed(() => {
      const items = cashUseSeries.value.rankingItems
      const ids = new Set(items.map(({ id }) => id))
      return [...items, ...persistedSelectedCategoryIds.value.filter((id) => !ids.has(id)).map((id) => ({ id, amount: 0 }))]
    })
    const cashUseState = computed(() => ({
      ...categoryState,
      isUnavailable: !['ok', 'partial'].includes(cashUseSeries.value.audit.status),
      auditStatus: cashUseSeries.value.audit.status,
      unavailableTransactionIds: [...new Set(cashUseSeries.value.audit.unavailable.flatMap(({ transactionIds }) => transactionIds))].sort(),
      projectedUnavailability: cashUseSeries.value.audit.unavailable.flatMap(({ monthKey, projected }) => (projected ? [{ monthKey, ...projected }] : [])),
    }))
    const dailyForecast = computed(() => {
      const candidates = dailyForecastCandidates(dailyForecastMonths.value)
      return buildDailyForecastProjection({
        ledger: ledger.value,
        forecast: buildForecast(dailyForecastMonths.value, candidates),
        candidates,
        today: getNow(),
        currencyDecimalPlaces: displayCurrencyDecimalPlaces.value,
      })
    })
    const dailyForecastSourceErrors = computed(() =>
      ['recurringTransactions', 'subscriptions'].filter((source) => ancillaryState[source].status === 'error').map((source) => ({ source, message: ancillaryState[source].error?.message ?? '' })),
    )
    const dailyForecastState = computed(() => {
      const sourceErrors = dailyForecastSourceErrors.value
      const forecastStatus = sourceErrors.length > 0 && dailyForecast.value.status !== 'unavailable' ? 'partial' : dailyForecast.value.status
      const unavailableMetricIds = DAILY_FLOW_KEYS.filter((key) => dailyForecast.value.statusByMetric[key] === 'unavailable')
      const hasDefensibleChartData = dailyForecast.value.barGroups.some(({ points }) =>
        points.some(({ value, transactionIds, evidenceIds }) => Number.isFinite(value) && (value !== 0 || transactionIds.length > 0 || evidenceIds.length > 0)),
      )
      const hasUnavailableEvidence =
        dailyForecast.value.audit.unavailableTransactionIds.length > 0 || dailyForecast.value.audit.unavailableCandidateIds.length > 0 || dailyForecast.value.audit.missingCurrencies.length > 0
      const isBlockingUnavailable =
        dailyForecast.value.audit.unclassifiedTransactionIds.length > 0 ||
        dailyForecast.value.reconciliation.status === 'mismatch' ||
        (!hasDefensibleChartData && (dailyForecast.value.status === 'unavailable' || hasUnavailableEvidence))
      const isPartiallyUnavailable =
        !isBlockingUnavailable &&
        (sourceErrors.length > 0 ||
          unavailableMetricIds.length > 0 ||
          hasUnavailableEvidence ||
          ['partial', 'insufficientHistory', 'unavailable'].includes(dailyForecast.value.status) ||
          dailyForecast.value.reconciliation.status === 'unavailable')
      return {
        ...categoryState,
        forecastStatus,
        isPartial: isPartiallyUnavailable,
        isUnavailable: isBlockingUnavailable,
        isBlockingUnavailable,
        isPartiallyUnavailable,
        unavailableMetricIds,
        unavailableTransactionIds: dailyForecast.value.audit.unavailableTransactionIds,
        unavailableCandidateIds: dailyForecast.value.audit.unavailableCandidateIds,
        unclassifiedTransactionIds: dailyForecast.value.audit.unclassifiedTransactionIds,
        missingCurrencies: dailyForecast.value.audit.missingCurrencies,
        sourceErrors,
      }
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
          if (persistedSelectedCategoryIds.value.length === 0)
            selectedCategoryIds.value = (categoryRanking.value.length > 0 ? categoryRanking.value : [...currentMonthCategoryIds.value, ...projectedCategoryIds.value]).slice(0, 5)
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

    async function retryCashUse() {
      await loadSnapshot({ force: true })
    }

    async function retryDailyForecast() {
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
      cashUseMode,
      cashUseDetail,
      dailyForecastMonths,
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
      cashUseSeries,
      cashUseCategoryRankingItems,
      cashUseState,
      dailyForecast,
      dailyForecastState,
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
      retryCashUse,
      retryDailyForecast,
      canMoveFlowMonth,
      moveFlowMonth,
    }
  })
}
