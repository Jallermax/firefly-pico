<template>
  <van-cell-group inset class="analytics-card analytics-balance-card">
    <div class="van-cell-group-title analytics-card-title analytics-balance-card-title">
      <div class="flex-1 analytics-balance-heading">
        <div class="analytics-balance-heading-row">
          <div>{{ $t('analytics.balance.title') }}</div>
        </div>
        <div class="analytics-card-subtitle">{{ $t('analytics.balance.subtitle') }}</div>
      </div>
      <analytics-metric-facet v-model="selectedMetricIds" :items="metrics" />
    </div>
    <div class="analytics-balance-view">
      <app-tabs v-model="analyticsStore.financialTrendView" :items="viewItems" />
    </div>
    <div class="analytics-balance-periods">
      <app-tabs v-model="analyticsStore.balancePeriod" :items="periodItems" />
    </div>

    <div v-if="isBalanceBlocking && analyticsStore.balanceState.status === 'loading'" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="isBalanceBlocking" class="analytics-card-state">
      <span>{{ $t('analytics.balance.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryBalance">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <div v-else-if="isExpenseBlocking && analyticsStore.categoryState.status === 'loading'" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="isExpenseBlocking" class="analytics-card-state">
      <span>{{ $t('analytics.category.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryCategory">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <template v-else>
      <div v-if="sourceState.balanceStatusVisible && analyticsStore.balanceState.status === 'loading'" class="analytics-card-state analytics-card-state-compact">
        <van-loading size="16" />
        <span>{{ $t('analytics.common.loading') }}</span>
      </div>
      <div v-else-if="sourceState.balanceStatusVisible" class="analytics-card-state analytics-card-state-compact">
        <span>{{ $t('analytics.balance.error') }}</span>
        <van-button size="small" @click="analyticsStore.retryBalance">{{ $t('analytics.common.retry') }}</van-button>
      </div>
      <div v-if="sourceState.expenseStatusVisible && analyticsStore.categoryState.status === 'loading'" class="analytics-card-state analytics-card-state-compact">
        <van-loading size="16" />
        <span>{{ $t('analytics.common.loading') }}</span>
      </div>
      <div v-else-if="sourceState.expenseStatusVisible" class="analytics-card-state analytics-card-state-compact">
        <span>{{ $t('analytics.category.error') }}</span>
        <van-button size="small" @click="analyticsStore.retryCategory">{{ $t('analytics.common.retry') }}</van-button>
      </div>

      <multi-series-line-chart v-if="chartSeries.length" :series="chartSeries" :value-formatter="formatNumberForDashboard" :aria-label="chartAriaLabel" @select-point="onSelectPoint" />
      <div v-else-if="selectedSourcesSettled && !hasUnavailableExpenses" class="analytics-card-state">{{ $t('analytics.balance.empty') }}</div>

      <div v-if="summaries.length" class="analytics-metric-summary-grid">
        <div v-for="summary in summaries" :key="summary.id" class="analytics-metric-summary" :class="{ 'analytics-metric-summary-savings-split': isSplitSavingsMetric(summary.id) }">
          <div class="analytics-metric-summary-title">
            <span class="analytics-chart-legend-marker" :class="'analytics-chart-legend-marker-' + summary.marker" :style="{ backgroundColor: summary.color }" />
            <span>{{ summary.label }}</span>
          </div>
          <div v-for="row in summary.rows" :key="row.label" class="analytics-metric-summary-row">
            <span>{{ row.label }}</span>
            <strong>{{ row.value }}</strong>
          </div>
        </div>
      </div>

      <details class="analytics-calculation-details">
        <summary>{{ $t('analytics.common.how_calculated') }}</summary>
        <p v-if="hasSelectedAccountMetrics">{{ $t('analytics.balance.definition') }}</p>
        <p v-if="expensesSelected">{{ $t('analytics.category.definition') }}</p>
      </details>
      <div v-if="hasSelectedAccountMetrics && analyticsStore.balanceState.status === 'loading' && analyticsStore.balanceState.isStale" class="analytics-assumption-note">
        {{ $t('analytics.common.stale') }}
      </div>
      <div v-if="expensesSelected && analyticsStore.categoryState.status === 'loading' && analyticsStore.categoryState.isStale" class="analytics-assumption-note">
        {{ $t('analytics.common.stale') }}
      </div>
      <div v-if="expensesSelected && hasUnavailableExpenses" class="analytics-warning" role="alert">
        {{ $t('analytics.common.unavailable_amounts', { ids: unavailableExpenseTransactionIds.join(', ') }) }}
      </div>
      <div v-for="warning in validationWarnings" :key="warning.type + warning.sampleDate" class="analytics-warning analytics-grouped-warning">{{ validationWarningLabel(warning) }}</div>
    </template>
  </van-cell-group>
</template>

<script setup>
import { format, parseISO } from 'date-fns'
import RouteConstants from '~/constants/RouteConstants.js'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { useProfileStore } from '~/stores/profileStore.js'
import { buildFinancialTrendChartSeries, formatFinancialTrendForecastValue } from '~/utils/AnalyticsUtils.js'
import { decorateLineChartPoint, projectSelectedBalanceWarnings, resolveFinancialTrendSourceState } from '~/utils/ChartUtils.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'
import TransactionFilterUtils from '~/utils/TransactionFilterUtils.js'

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const { t } = useI18n()

const viewItems = computed(() => [
  { label: t('analytics.balance.view_balances'), value: 'balances' },
  { label: t('analytics.balance.view_changes'), value: 'changes' },
])
const periodItems = computed(() => [3, 6, 12].map((value) => ({ label: t('analytics.period.months_short', { count: value }), value })))
const metricDefinitions = computed(() =>
  [
    { id: 'netWorth', balanceLabel: t('analytics.balance.net_worth'), changeLabel: t('analytics.balance.net_worth_change'), color: 'var(--analytics-net-worth)', marker: 'circle' },
    { id: 'savings', balanceLabel: t('analytics.balance.savings'), changeLabel: t('analytics.balance.savings_change'), color: 'var(--analytics-savings)', marker: 'square' },
    {
      id: 'savingsIncluded',
      balanceLabel: t('analytics.balance.savings_included'),
      changeLabel: t('analytics.balance.savings_included_change'),
      color: 'var(--analytics-savings)',
      marker: 'square',
    },
    {
      id: 'savingsExcluded',
      balanceLabel: t('analytics.balance.savings_excluded'),
      changeLabel: t('analytics.balance.savings_excluded_change'),
      color: 'var(--analytics-savings)',
      marker: 'square',
    },
    { id: 'debt', balanceLabel: t('analytics.balance.debt'), changeLabel: t('analytics.balance.debt_change'), color: 'var(--analytics-debt)', marker: 'diamond' },
    { id: 'expenses', balanceLabel: null, changeLabel: t('analytics.balance.total_expenses'), color: 'var(--analytics-expenses)', marker: 'triangle' },
  ].filter(({ id }) => analyticsStore.availableFinancialMetricIds.includes(id)),
)
const metrics = computed(() =>
  metricDefinitions.value
    .filter((metric) => analyticsStore.financialTrendView === 'changes' || metric.id !== 'expenses')
    .map((metric) => ({ ...metric, label: analyticsStore.financialTrendView === 'balances' ? metric.balanceLabel : metric.changeLabel })),
)
const selectedMetricIds = computed({
  get: () => (analyticsStore.financialTrendView === 'balances' ? analyticsStore.visibleBalanceMetrics : analyticsStore.visibleFinancialMetrics),
  set: (metrics) => {
    if (analyticsStore.financialTrendView === 'balances') analyticsStore.visibleBalanceMetrics = metrics
    else analyticsStore.visibleFinancialMetrics = metrics
  },
})
const selectedAccountMetrics = computed(() => metrics.value.filter((metric) => metric.id !== 'expenses' && selectedMetricIds.value.includes(metric.id)))
const hasSelectedAccountMetrics = computed(() => selectedAccountMetrics.value.length > 0)
const expensesSelected = computed(() => selectedMetricIds.value.includes('expenses'))
const unavailableExpenseTransactionIds = computed(() => analyticsStore.categorySummary.unclassified?.transactionIds ?? [])
const hasUnavailableExpenses = computed(() => unavailableExpenseTransactionIds.value.length > 0)
const hasBalanceResult = computed(() => ['ready', 'empty'].includes(analyticsStore.balanceState.status) || analyticsStore.balanceState.isStale)
const hasExpenseResult = computed(() => ['ready', 'empty'].includes(analyticsStore.categoryState.status) || analyticsStore.categoryState.isStale)
const sourceState = computed(() =>
  resolveFinancialTrendSourceState({
    hasAccountSelection: hasSelectedAccountMetrics.value,
    expensesSelected: expensesSelected.value,
    balanceState: analyticsStore.balanceState,
    expenseState: analyticsStore.categoryState,
  }),
)
const isBalanceBlocking = computed(() => sourceState.value.balanceBlocking)
const isExpenseBlocking = computed(() => sourceState.value.expenseBlocking)
const selectedSourcesSettled = computed(() => sourceState.value.selectedSourcesSettled)

const formatCurrency = (value) => (Number.isFinite(value) ? `${formatNumberForDashboard(value)} ${analyticsStore.displayCurrencyCode}` : '—')
const formatSignedCurrency = (value) => (Number.isFinite(value) ? `${value > 0 ? '+' : ''}${formatNumberForDashboard(value)} ${analyticsStore.displayCurrencyCode}` : '—')
const formatMonthKey = (value) => new Intl.DateTimeFormat(profileStore.language, { month: 'short', year: 'numeric' }).format(parseISO(value.slice(0, 7) + '-01'))
const currentMonthKey = computed(() => format(new Date(), 'yyyy-MM'))
const toChartPoint = (point, remainingFromToday) =>
  decorateLineChartPoint(point, {
    xLabel: point.xLabel ?? formatMonthKey(point.x),
    valueLabel: formatCurrency(point.value),
    secondaryLabel: point.kind === 'forecast' && Number.isFinite(remainingFromToday) ? t('analytics.common.from_today') : undefined,
    secondaryValueLabel: point.kind === 'forecast' && Number.isFinite(remainingFromToday) ? formatSignedCurrency(remainingFromToday) : undefined,
  })

const chartSeries = computed(() =>
  buildFinancialTrendChartSeries({
    view: analyticsStore.financialTrendView,
    metrics: metrics.value,
    selectedIds: selectedMetricIds.value,
    accountSeries: analyticsStore.financialTrend.series,
    expenses: analyticsStore.financialTrend.expenses,
    currentMonthKey: currentMonthKey.value,
  })
    .filter((series) => (series.id === 'expenses' ? hasExpenseResult.value && !hasUnavailableExpenses.value : hasBalanceResult.value))
    .map((series) => {
      const source = series.id === 'expenses' ? analyticsStore.financialTrend.expenses : analyticsStore.financialTrend.series.find((item) => item.id === series.id)
      return {
        ...series,
        points: series.points.filter((point) => Number.isFinite(point.value)).map((point) => toChartPoint(point, source?.remainingFromToday)),
      }
    })
    .filter((series) => series.points.length),
)
const chartAriaLabel = computed(() => t(analyticsStore.financialTrendView === 'balances' ? 'analytics.balance.chart_label_balances' : 'analytics.balance.chart_label_changes'))
const accountSummaries = computed(() => {
  if (!hasBalanceResult.value) return []
  return selectedAccountMetrics.value.map((metric) => {
    const series = analyticsStore.financialTrend.series.find((item) => item.id === metric.id)
    const isBalances = analyticsStore.financialTrendView === 'balances'
    return {
      ...metric,
      rows: [
        { label: t(isBalances ? 'analytics.balance.current_total' : 'analytics.balance.current_change'), value: formatCurrency(isBalances ? series?.currentTotal : series?.currentChange) },
        { label: t('analytics.balance.average_monthly_change'), value: formatCurrency(series?.averageChange) },
        {
          label: t('analytics.common.end_of_month'),
          value: formatFinancialTrendForecastValue({
            forecastAvailable: series?.forecastAvailable,
            value: isBalances ? series?.forecastTotal : series?.forecastChange,
            formatValue: formatCurrency,
            insufficientHistoryLabel: t('analytics.balance.insufficient_history'),
          }),
        },
        {
          label: t('analytics.balance.remaining_from_today'),
          value: formatFinancialTrendForecastValue({
            forecastAvailable: series?.forecastAvailable,
            value: series?.remainingFromToday,
            formatValue: formatSignedCurrency,
            insufficientHistoryLabel: t('analytics.balance.insufficient_history'),
          }),
        },
      ],
    }
  })
})
const expenseSummary = computed(() => {
  if (!expensesSelected.value || !hasExpenseResult.value || hasUnavailableExpenses.value) return null
  const expenses = analyticsStore.financialTrend.expenses
  const metric = metrics.value.find((item) => item.id === 'expenses')
  return {
    ...metric,
    rows: [
      { label: t('analytics.balance.current_actual'), value: formatCurrency(expenses.currentActual) },
      { label: t('analytics.balance.average_monthly_spending'), value: formatCurrency(expenses.average) },
      {
        label: t('analytics.common.end_of_month'),
        value: formatFinancialTrendForecastValue({
          forecastAvailable: expenses.forecastAvailable,
          value: expenses.currentForecast,
          formatValue: formatCurrency,
          insufficientHistoryLabel: t('analytics.balance.insufficient_history'),
        }),
      },
      {
        label: t('analytics.balance.remaining_from_today'),
        value: formatFinancialTrendForecastValue({
          forecastAvailable: expenses.forecastAvailable,
          value: expenses.remainingFromToday,
          formatValue: formatSignedCurrency,
          insufficientHistoryLabel: t('analytics.balance.insufficient_history'),
        }),
      },
    ],
  }
})
const summaries = computed(() => [...accountSummaries.value, ...(expenseSummary.value ? [expenseSummary.value] : [])])
const isSplitSavingsMetric = (id) => ['savingsIncluded', 'savingsExcluded'].includes(id)
const onSelectPoint = async ({ transactionIds }) => {
  if (!transactionIds?.length) return
  await navigateTo(RouteConstants.ROUTE_TRANSACTION_LIST + '?' + TransactionFilterUtils.filters.id.toUrl(transactionIds))
}

const validationWarnings = computed(() => projectSelectedBalanceWarnings({ warnings: analyticsStore.balanceWarnings, selectedMetrics: selectedAccountMetrics.value }))
const warningMetricFormatter = computed(() => new Intl.ListFormat(profileStore.language, { style: 'long', type: 'conjunction' }))
const validationWarningLabel = (warning) => {
  const reasonKey = {
    'current-balance-mismatch': 'analytics.balance.current_balance_mismatch',
    'current-balance-unverified': 'analytics.balance.current_balance_unverified',
  }[warning.type]
  return t('analytics.balance.grouped_balance_warning', {
    reason: reasonKey ? t(reasonKey, warning) : warning.type,
    metrics: warningMetricFormatter.value.format(warning.metricLabels),
  })
}
</script>
