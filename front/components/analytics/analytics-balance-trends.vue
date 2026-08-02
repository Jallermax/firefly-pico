<template>
  <van-cell-group inset class="analytics-card analytics-balance-card">
    <div class="van-cell-group-title analytics-card-title">
      <span class="flex-1">{{ $t('analytics.balance.title') }}</span>
      <app-tabs v-model="analyticsStore.balancePeriod" :items="periodItems" />
    </div>

    <div class="analytics-series-toggles">
      <button
        v-for="metric in metrics"
        :key="metric.id"
        type="button"
        class="analytics-series-toggle"
        :class="{ active: visibleMetrics.includes(metric.id) }"
        :aria-pressed="visibleMetrics.includes(metric.id)"
        @click="toggleMetric(metric.id)"
      >
        {{ metric.label }}
      </button>
    </div>

    <div v-if="analyticsStore.balanceState.status === 'loading' && chartSeries.length === 0" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="analyticsStore.balanceState.status === 'error' && chartSeries.length === 0" class="analytics-card-state">
      <span>{{ $t('analytics.balance.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryBalance">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <template v-else-if="chartSeries.length === 0">
      <div class="analytics-card-state">{{ $t('analytics.balance.empty') }}</div>
      <div class="analytics-assumption-note">{{ $t('analytics.balance.definition') }}</div>
    </template>
    <template v-else>
      <div v-if="analyticsStore.balanceState.status === 'error'" class="analytics-card-state analytics-card-state-compact">
        <span>{{ $t('analytics.balance.error') }}</span>
        <van-button size="small" @click="analyticsStore.retryBalance">{{ $t('analytics.common.retry') }}</van-button>
      </div>
      <div v-else-if="analyticsStore.balanceState.status === 'loading' && analyticsStore.balanceState.isStale" class="analytics-assumption-note">{{ $t('analytics.common.stale') }}</div>
      <multi-series-line-chart :series="chartSeries" :value-formatter="formatNumberForDashboard" :aria-label="$t('analytics.balance.chart_label')" />
      <div class="analytics-metric-summary-grid">
        <div v-for="summary in summaries" :key="summary.id" class="analytics-metric-summary">
          <div class="analytics-metric-summary-title">
            <span class="analytics-chart-legend-marker" :style="{ backgroundColor: summary.color }" />
            <span>{{ summary.label }}</span>
          </div>
          <div class="analytics-metric-summary-row">
            <span>{{ $t('analytics.balance.latest') }}</span>
            <strong>{{ summary.latestLabel }}</strong>
          </div>
          <div class="analytics-metric-summary-row" :class="summary.changeClass">
            <span>{{ $t('analytics.balance.change') }}</span>
            <strong
              >{{ summary.changeLabel }}<template v-if="summary.percentageChangeLabel"> ({{ summary.percentageChangeLabel }})</template></strong
            >
          </div>
        </div>
      </div>
      <div class="analytics-assumption-note">{{ $t('analytics.balance.definition') }}</div>
      <div v-if="isEstimated" class="analytics-assumption-note">{{ $t('analytics.common.estimated_current_rates') }}</div>
      <div v-if="missingCurrencies.length" class="analytics-warning">{{ $t('analytics.common.missing_rates', { currencies: missingCurrencies.join(', ') }) }}</div>
      <div v-for="(warning, index) in validationWarnings" :key="warning.type + warning.sampleDate + index" class="analytics-warning">{{ validationWarningLabel(warning) }}</div>
    </template>
    <template v-if="analyticsStore.balanceState.status !== 'loading' && chartSeries.length === 0">
      <div v-if="isEstimated" class="analytics-assumption-note">{{ $t('analytics.common.estimated_current_rates') }}</div>
      <div v-if="missingCurrencies.length" class="analytics-warning">{{ $t('analytics.common.missing_rates', { currencies: missingCurrencies.join(', ') }) }}</div>
      <div v-for="(warning, index) in validationWarnings" :key="warning.type + warning.sampleDate + index" class="analytics-warning">{{ validationWarningLabel(warning) }}</div>
    </template>
  </van-cell-group>
</template>

<script setup>
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import DateUtils from '~/utils/DateUtils.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'

const analyticsStore = useAnalyticsStore()
const { t } = useI18n()

const periodItems = computed(() => [3, 6, 12].map((value) => ({ label: t('analytics.period.months_short', { count: value }), value })))

const metrics = computed(() => [
  { id: 'netWorth', label: t('analytics.balance.net_worth'), color: 'var(--analytics-net-worth)', marker: 'circle' },
  { id: 'savings', label: t('analytics.balance.savings'), color: 'var(--analytics-savings)', marker: 'square' },
  { id: 'debt', label: t('analytics.balance.debt'), color: 'var(--analytics-debt)', marker: 'diamond' },
])

const metricIds = computed(() => metrics.value.map((metric) => metric.id))
const visibleMetrics = computed(() => analyticsStore.visibleBalanceMetrics)

const formatCurrency = (value) => `${formatNumberForDashboard(value)} ${analyticsStore.displayCurrencyCode}`
const formatSigned = (value) => `${value > 0 ? '+' : ''}${formatNumberForDashboard(value)}`
const validPoints = (points) => points.filter((point) => Number.isFinite(point.value))

const selectedBalanceSeries = computed(() =>
  metrics.value
    .filter((metric) => visibleMetrics.value.includes(metric.id))
    .map((metric) => {
      const series = analyticsStore.balanceSeries.find((item) => item.id === metric.id) ?? { points: [], isEstimated: false, missingCurrencies: [], warnings: [] }
      return {
        ...metric,
        ...series,
      }
    }),
)

const chartSeries = computed(() =>
  selectedBalanceSeries.value
    .map((series) => ({
      ...series,
      points: validPoints(series.points).map((point) => ({
        ...point,
        xLabel: DateUtils.dateToUI(DateUtils.stringToDate(point.x)),
        valueLabel: formatCurrency(point.value),
        isEstimated: series.isEstimated,
      })),
    }))
    .filter((series) => series.points.length > 0),
)

const summaries = computed(() =>
  chartSeries.value.map((series) => {
    const first = series.points[0].value
    const latest = series.points.at(-1).value
    const absoluteChange = latest - first
    const percentageChange = first === 0 ? null : (absoluteChange / Math.abs(first)) * 100
    const isImprovement = series.id === 'debt' ? absoluteChange < 0 : absoluteChange > 0
    return {
      ...series,
      latestLabel: formatCurrency(latest),
      changeLabel: formatCurrency(absoluteChange),
      percentageChangeLabel: percentageChange === null ? null : `${formatSigned(percentageChange)}%`,
      changeClass: absoluteChange === 0 ? null : isImprovement ? 'success' : 'danger',
    }
  }),
)

const isEstimated = computed(() => selectedBalanceSeries.value.some((series) => series.isEstimated))
const missingCurrencies = computed(() => [...new Set(selectedBalanceSeries.value.flatMap((series) => series.missingCurrencies))])
const validationWarnings = computed(() => selectedBalanceSeries.value.flatMap((series) => series.warnings))

const normalizeVisibleMetrics = (metricList) => {
  const selected = [...new Set((Array.isArray(metricList) ? metricList : []).filter((metricId) => metricIds.value.includes(metricId)))]
  return selected.length > 0 ? selected : ['netWorth']
}

watch(
  () => analyticsStore.visibleBalanceMetrics,
  (metricList) => {
    const current = Array.isArray(metricList) ? metricList : []
    const normalized = normalizeVisibleMetrics(current)
    if (!Array.isArray(metricList) || normalized.length !== current.length || normalized.some((metricId, index) => metricId !== current[index])) analyticsStore.visibleBalanceMetrics = normalized
  },
  { immediate: true },
)

const toggleMetric = (metricId) => {
  if (visibleMetrics.value.includes(metricId)) {
    if (visibleMetrics.value.length === 1) return
    analyticsStore.visibleBalanceMetrics = visibleMetrics.value.filter((id) => id !== metricId)
    return
  }
  analyticsStore.visibleBalanceMetrics = [...visibleMetrics.value, metricId]
}

const validationWarningLabel = (warning) =>
  t(
    {
      'current-balance-mismatch': 'analytics.balance.current_balance_mismatch',
      'current-balance-unverified': 'analytics.balance.current_balance_unverified',
    }[warning.type],
    warning,
  )
</script>
