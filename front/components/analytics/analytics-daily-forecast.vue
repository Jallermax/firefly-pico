<template>
  <van-cell-group inset class="analytics-card analytics-daily-forecast-card">
    <div class="van-cell-group-title analytics-card-title">
      <div class="flex-1">
        <div class="flex-center-vertical gap-2">
          <span>{{ $t('analytics.daily_forecast.title') }}</span>
        </div>
        <div class="analytics-card-subtitle">{{ monthTitle }}</div>
      </div>
    </div>

    <div class="analytics-category-periods">
      <app-tabs v-model="analyticsStore.dailyForecastMonths" :items="periodItems" />
    </div>

    <div v-if="dailyState.status === 'loading' && !hasRetainedData" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="dailyState.status === 'error' && !hasRetainedData" class="analytics-card-state">
      <span>{{ $t('analytics.daily_forecast.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryDailyForecast">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <div v-else-if="dailyState.isUnavailable" class="analytics-warning" role="alert">
      <div>{{ $t('analytics.daily_forecast.unavailable') }}</div>
      <div v-if="dailyState.unavailableTransactionIds.length">{{ $t('analytics.common.unavailable_amounts', { ids: dailyState.unavailableTransactionIds.join(', ') }) }}</div>
      <div v-if="dailyState.unclassifiedTransactionIds.length">{{ $t('analytics.common.unavailable_amounts', { ids: dailyState.unclassifiedTransactionIds.join(', ') }) }}</div>
      <div v-if="dailyState.unavailableCandidateIds.length">{{ $t('analytics.daily_forecast.unavailable_sources', { ids: dailyState.unavailableCandidateIds.join(', ') }) }}</div>
    </div>
    <template v-else>
      <div v-if="dailyState.status === 'error'" class="analytics-card-state analytics-card-state-compact">
        <span>{{ $t('analytics.daily_forecast.error') }}</span>
        <van-button size="small" @click="analyticsStore.retryDailyForecast">{{ $t('analytics.common.retry') }}</van-button>
      </div>
      <div v-else-if="dailyState.status === 'loading' && dailyState.isStale" class="analytics-assumption-note">{{ $t('analytics.common.stale') }}</div>
      <div v-if="dailyState.isPartial" class="analytics-assumption-note">{{ $t(`analytics.daily_forecast.${dailyState.forecastStatus}`) }}</div>
      <div v-for="sourceError in dailyState.sourceErrors" :key="sourceError.source" class="analytics-assumption-note">{{ $t('analytics.daily_forecast.error') }} ({{ sourceError.source }})</div>

      <div class="analytics-chart-legend analytics-daily-forecast-legend">
        <span v-for="item in legendItems" :key="item.id" class="flex-center-vertical gap-1">
          <span class="analytics-chart-legend-marker" :class="`analytics-daily-forecast-marker-${item.id}`" :style="{ backgroundColor: item.color }" />
          <span>{{ item.label }}</span>
        </span>
      </div>

      <analytics-combination-chart :series="chartSeries" :value-formatter="formatCurrency" :aria-label="$t('analytics.daily_forecast.chart_label')" @select="onSelect" @select-point="onSelectPoint" />

      <div v-if="selectedProjectedSources.length" class="analytics-calculation-details" aria-live="polite">
        <div class="font-weight-600">{{ selectedLabel }}</div>
        <div v-for="source in selectedProjectedSources" :key="source.id" class="analytics-assumption-note">
          <div class="font-weight-600">{{ $t(`analytics.daily_forecast.source_${source.sourceKind}`) }} · {{ formatCurrency(source.amount) }}</div>
          <div v-if="source.overdue">{{ $t('analytics.daily_forecast.overdue') }}</div>
          <div v-if="source.confidence?.level">{{ $t('analytics.daily_forecast.confidence', { level: source.confidence.level }) }}</div>
          <div v-for="reason in source.reasons ?? []" :key="reason">{{ reason }}</div>
          <div v-if="source.sourceId">{{ $t('analytics.daily_forecast.source_id', { id: source.sourceId }) }}</div>
          <div v-if="source.candidateId">{{ $t('analytics.daily_forecast.candidate_id', { id: source.candidateId }) }}</div>
          <div v-if="source.expectedId">{{ $t('analytics.daily_forecast.expected_id', { id: source.expectedId }) }}</div>
          <div v-if="source.evidenceIds?.length">{{ $t('analytics.daily_forecast.evidence_ids', { ids: source.evidenceIds.join(', ') }) }}</div>
          <div v-if="source.conversion?.mode">{{ $t('analytics.daily_forecast.conversion', { mode: source.conversion.mode }) }}</div>
        </div>
      </div>

      <div v-if="!hasActivity" class="analytics-card-state">{{ $t('analytics.daily_forecast.empty') }}</div>
    </template>
  </van-cell-group>
</template>

<script setup>
import { parseISO } from 'date-fns'
import RouteConstants from '~/constants/RouteConstants.js'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { useProfileStore } from '~/stores/profileStore.js'
import { projectLineChartSelection } from '~/utils/ChartUtils.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'
import TransactionFilterUtils from '~/utils/TransactionFilterUtils.js'

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const { t } = useI18n()
const selectedPayload = ref(null)
const daily = computed(() => analyticsStore.dailyForecast)
const dailyState = computed(() => analyticsStore.dailyForecastState)
const periodItems = computed(() => [3, 6, 12].map((value) => ({ label: t('analytics.period.months_short', { count: value }), value })))
const monthTitle = computed(() => new Intl.DateTimeFormat(profileStore.language, { month: 'long', year: 'numeric' }).format(parseISO(`${daily.value.monthKey}-01`)))
const formatCurrency = (value) => (Number.isFinite(value) ? `${formatNumberForDashboard(value)} ${analyticsStore.displayCurrencyCode}` : '—')
const sourceLabel = (sourceKind) => t(`analytics.daily_forecast.source_${sourceKind}`)
const chartSeries = computed(() => ({
  ...daily.value,
  barGroups: daily.value.barGroups.map((group) => ({
    ...group,
    label: t(group.labelKey),
    color: group.direction === 'sources' ? 'var(--income2)' : 'var(--expense2)',
    points: group.points.map((point) => ({ ...point, label: t(group.labelKey) })),
  })),
  availableLine: { ...daily.value.availableLine, label: t(daily.value.availableLine.labelKey), color: 'var(--transfer2)' },
}))
const hasActivity = computed(() => daily.value.barGroups.some(({ points }) => points.some(({ value }) => Number.isFinite(value) && value !== 0)))
const hasRetainedData = computed(() => dailyState.value.isStale && daily.value.dateKeys.length > 0)
const legendItems = computed(() => [
  { id: 'actual', label: sourceLabel('actual'), color: 'var(--transfer2)' },
  { id: 'defined', label: sourceLabel('defined'), color: 'var(--income2)' },
  { id: 'inferred', label: sourceLabel('inferred'), color: 'var(--income2)' },
  { id: 'variable', label: sourceLabel('variable'), color: 'var(--income2)' },
  { id: 'available', label: t('analytics.daily_forecast.available_change'), color: 'var(--transfer2)' },
])
const selectedProjectedSources = computed(() => [...new Map((selectedPayload.value?.values ?? []).flatMap(({ point }) => point.projectedSources ?? []).map((source) => [source.id, source])).values()])
const selectedLabel = computed(() => selectedPayload.value?.xLabel ?? '')

const onSelect = (payload) => {
  selectedPayload.value = payload
}
const onSelectPoint = async ({ activation, point, transactionIds }) => {
  const selection = projectLineChartSelection({
    activation,
    transactionIds,
    kind: point?.kind,
    route: RouteConstants.ROUTE_TRANSACTION_LIST,
    toUrl: TransactionFilterUtils.filters.id.toUrl,
  })
  if (!selection.route) return
  await navigateTo(selection.route)
}
</script>
