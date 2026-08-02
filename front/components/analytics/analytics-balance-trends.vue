<template>
  <van-cell-group inset class="analytics-card analytics-balance-card">
    <div class="van-cell-group-title analytics-card-title analytics-balance-card-title">
      <div class="flex-1">
        <div>{{ $t('analytics.balance.title') }}</div>
        <div class="analytics-card-subtitle">{{ $t('analytics.balance.subtitle') }}</div>
      </div>
      <analytics-metric-facet v-model="analyticsStore.visibleFinancialMetrics" :items="metrics" />
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

      <multi-series-line-chart v-if="chartSeries.length" :series="chartSeries" :value-formatter="formatNumberForDashboard" :aria-label="$t('analytics.balance.chart_label')" />
      <div v-else-if="selectedSourcesSettled" class="analytics-card-state">{{ $t('analytics.balance.empty') }}</div>

      <div v-if="summaries.length" class="analytics-metric-summary-grid">
        <div v-for="summary in summaries" :key="summary.id" class="analytics-metric-summary">
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
      <div v-if="isEstimated" class="analytics-assumption-note">{{ $t('analytics.common.estimated_current_rates') }}</div>
      <div v-if="missingCurrencies.length" class="analytics-warning">{{ $t('analytics.common.missing_rates', { currencies: missingCurrencies.join(', ') }) }}</div>
      <div v-for="(warning, index) in validationWarnings" :key="warning.type + warning.sampleDate + index" class="analytics-warning">{{ validationWarningLabel(warning) }}</div>
    </template>
  </van-cell-group>
</template>

<script setup>
import { format, parseISO } from 'date-fns'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { useProfileStore } from '~/stores/profileStore.js'
import { decorateLineChartPoint, resolveFinancialTrendSourceState } from '~/utils/ChartUtils.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const { t } = useI18n()

const periodItems = computed(() => [3, 6, 12].map((value) => ({ label: t('analytics.period.months_short', { count: value }), value })))
const metrics = computed(() => [
  { id: 'netWorth', label: t('analytics.balance.net_worth_change'), summaryLabel: t('analytics.balance.net_worth'), color: 'var(--analytics-net-worth)', marker: 'circle' },
  { id: 'savings', label: t('analytics.balance.savings_change'), summaryLabel: t('analytics.balance.savings'), color: 'var(--analytics-savings)', marker: 'square' },
  { id: 'debt', label: t('analytics.balance.debt_change'), summaryLabel: t('analytics.balance.debt'), color: 'var(--analytics-debt)', marker: 'diamond' },
  { id: 'expenses', label: t('analytics.balance.total_expenses'), summaryLabel: t('analytics.balance.total_expenses'), color: 'var(--analytics-expenses)', marker: 'triangle' },
])
const selectedMetricIds = computed(() => analyticsStore.visibleFinancialMetrics)
const selectedAccountMetrics = computed(() => metrics.value.filter((metric) => metric.id !== 'expenses' && selectedMetricIds.value.includes(metric.id)))
const hasSelectedAccountMetrics = computed(() => selectedAccountMetrics.value.length > 0)
const expensesSelected = computed(() => selectedMetricIds.value.includes('expenses'))
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
const formatMonthKey = (value) => new Intl.DateTimeFormat(profileStore.language, { month: 'short', year: 'numeric' }).format(parseISO(value.slice(0, 7) + '-01'))
const currentMonthKey = computed(() => format(new Date(), 'yyyy-MM'))
const currentMonthLabel = computed(() => formatMonthKey(currentMonthKey.value))
const expenseForecastKey = computed(() => (expensesSelected.value && hasExpenseResult.value && analyticsStore.financialTrend.expenses.forecastAvailable ? currentMonthKey.value + ':forecast' : null))
const toChartPoint = (point, isEstimated) =>
  decorateLineChartPoint(point, {
    xLabel: point.xLabel ?? formatMonthKey(point.x),
    valueLabel: formatCurrency(point.value),
    isEstimated,
  })

const selectedAccountTrendSeries = computed(() =>
  selectedAccountMetrics.value.map((metric) => {
    const series = analyticsStore.financialTrend.series.find((item) => item.id === metric.id) ?? { points: [] }
    const sourceSeries = analyticsStore.balanceSeries.find((item) => item.id === metric.id)
    const points = series.points.filter((point) => Number.isFinite(point.value)).map((point) => toChartPoint(point, sourceSeries?.isEstimated))
    const currentPartial = points.findLast((point) => point.kind === 'partial')
    if (expenseForecastKey.value && currentPartial) points.push({ ...currentPartial, x: expenseForecastKey.value, xLabel: currentMonthLabel.value, inspectionOnly: true })
    return { ...metric, points }
  }),
)

const expenseChartSeries = computed(() => {
  if (!expensesSelected.value || !hasExpenseResult.value) return null
  const expenses = analyticsStore.financialTrend.expenses
  return {
    ...metrics.value.find((metric) => metric.id === 'expenses'),
    points: [
      ...expenses.actualPoints.map((point) => toChartPoint(point, analyticsStore.categorySummary.isEstimated)),
      toChartPoint({ x: currentMonthKey.value, value: expenses.currentActual, kind: 'partial' }, analyticsStore.categorySummary.isEstimated),
      ...(expenses.forecastAvailable
        ? [toChartPoint({ x: expenseForecastKey.value, xLabel: currentMonthLabel.value, value: expenses.currentForecast, kind: 'forecast' }, analyticsStore.categorySummary.isEstimated)]
        : []),
    ],
  }
})

const chartSeries = computed(() =>
  [...(hasBalanceResult.value ? selectedAccountTrendSeries.value : []), ...(expenseChartSeries.value ? [expenseChartSeries.value] : [])].filter((series) => series.points.length),
)
const accountSummaries = computed(() => {
  if (!hasBalanceResult.value) return []
  return metrics.value.slice(0, 3).map((metric) => {
    const series = analyticsStore.financialTrend.series.find((item) => item.id === metric.id)
    return { ...metric, label: metric.summaryLabel, rows: [{ label: t('analytics.balance.current_total'), value: formatCurrency(series?.currentTotal) }] }
  })
})
const expenseSummary = computed(() => {
  if (!hasExpenseResult.value) return null
  const expenses = analyticsStore.financialTrend.expenses
  const metric = metrics.value.find((item) => item.id === 'expenses')
  return {
    ...metric,
    label: metric.summaryLabel,
    rows: [
      { label: t('analytics.balance.current_actual'), value: formatCurrency(expenses.currentActual) },
      { label: t('analytics.balance.current_forecast'), value: formatCurrency(expenses.currentForecast) },
    ],
  }
})
const summaries = computed(() => [...accountSummaries.value, ...(expenseSummary.value ? [expenseSummary.value] : [])])

const selectedAccountSourceSeries = computed(() =>
  selectedAccountMetrics.value.map((metric) => analyticsStore.balanceSeries.find((series) => series.id === metric.id) ?? { isEstimated: false, missingCurrencies: [], warnings: [] }),
)
const isEstimated = computed(() => selectedAccountSourceSeries.value.some((series) => series.isEstimated) || (expensesSelected.value && analyticsStore.categorySummary.isEstimated))
const missingCurrencies = computed(() => [
  ...new Set([...selectedAccountSourceSeries.value.flatMap((series) => series.missingCurrencies), ...(expensesSelected.value ? (analyticsStore.categorySummary.missingCurrencies ?? []) : [])]),
])
const validationWarnings = computed(() => selectedAccountSourceSeries.value.flatMap((series) => series.warnings))
const validationWarningLabel = (warning) =>
  t(
    {
      'current-balance-mismatch': 'analytics.balance.current_balance_mismatch',
      'current-balance-unverified': 'analytics.balance.current_balance_unverified',
    }[warning.type],
    warning,
  )
</script>
