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
      <app-tabs v-model="analyticsStore.dailyForecastMonths" :items="periodItems" :aria-label="$t('analytics.daily_forecast.history_window_label')" />
    </div>

    <div v-if="dailyState.status === 'loading' && !hasRetainedData" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="dailyState.status === 'error' && !hasRetainedData" class="analytics-card-state">
      <span>{{ $t('analytics.daily_forecast.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryDailyForecast">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <div v-else-if="dailyState.isBlockingUnavailable" class="analytics-warning" role="alert">
      <div>{{ $t('analytics.daily_forecast.unavailable') }}</div>
      <div v-if="dailyState.unavailableTransactionIds.length">{{ $t('analytics.common.unavailable_amounts', { ids: dailyState.unavailableTransactionIds.join(', ') }) }}</div>
      <div v-if="dailyState.unclassifiedTransactionIds.length">{{ $t('analytics.common.unavailable_amounts', { ids: dailyState.unclassifiedTransactionIds.join(', ') }) }}</div>
      <div v-if="unavailableEvidenceSummary.count">{{ $t('analytics.common.unavailable_evidence_count', { count: unavailableEvidenceSummary.count }) }}</div>
      <details v-if="unavailableEvidenceSummary.previewIds.length" class="analytics-warning-details">
        <summary>{{ $t('analytics.common.details') }}</summary>
        <div class="analytics-warning-evidence">{{ unavailableEvidenceSummary.previewIds.join(', ') }}</div>
        <div v-if="unavailableEvidenceSummary.omittedCount">{{ $t('analytics.common.more_items', { count: unavailableEvidenceSummary.omittedCount }) }}</div>
      </details>
    </div>
    <template v-else>
      <div v-if="dailyState.status === 'error'" class="analytics-card-state analytics-card-state-compact">
        <span>{{ $t('analytics.daily_forecast.error') }}</span>
        <van-button size="small" @click="analyticsStore.retryDailyForecast">{{ $t('analytics.common.retry') }}</van-button>
      </div>
      <div v-else-if="dailyState.status === 'loading' && dailyState.isStale" class="analytics-assumption-note">{{ $t('analytics.common.stale') }}</div>
      <div v-if="dailyState.isPartiallyUnavailable" class="analytics-warning" role="status">
        <div>{{ $t(`analytics.daily_forecast.${dailyState.forecastStatus}`) }}</div>
        <div v-if="dailyState.unavailableTransactionIds.length">{{ $t('analytics.common.unavailable_amounts', { ids: dailyState.unavailableTransactionIds.join(', ') }) }}</div>
        <div v-if="unavailableEvidenceSummary.count">{{ $t('analytics.common.unavailable_evidence_count', { count: unavailableEvidenceSummary.count }) }}</div>
        <details v-if="unavailableEvidenceSummary.previewIds.length" class="analytics-warning-details">
          <summary>{{ $t('analytics.common.details') }}</summary>
          <div class="analytics-warning-evidence">{{ unavailableEvidenceSummary.previewIds.join(', ') }}</div>
          <div v-if="unavailableEvidenceSummary.omittedCount">{{ $t('analytics.common.more_items', { count: unavailableEvidenceSummary.omittedCount }) }}</div>
        </details>
        <div v-if="dailyState.sourceErrors.length">
          <div v-for="sourceError in dailyState.sourceErrors" :key="sourceError.source">{{ $t('analytics.daily_forecast.error') }} ({{ sourceError.source }})</div>
          <van-button size="small" @click="analyticsStore.retryDailyForecast">{{ $t('analytics.common.retry') }}</van-button>
        </div>
      </div>

      <div class="analytics-daily-forecast-summary" :aria-label="$t('analytics.daily_forecast.chart_label')">
        <div v-for="item in summaryItems" :key="item.id" class="analytics-daily-forecast-summary-item">
          <span>{{ item.label }}</span>
          <strong>{{ formatCurrency(item.value) }}</strong>
          <small v-if="Number.isFinite(item.projected) && item.projected !== 0">{{ formatSignedCurrency(item.projected) }} {{ $t('analytics.cash_use.projected_remaining') }}</small>
        </div>
      </div>

      <div class="analytics-chart-legend analytics-daily-forecast-legend">
        <span v-for="item in legendItems" :key="item.id" class="flex-center-vertical gap-1">
          <span class="analytics-chart-legend-marker" :class="`analytics-daily-forecast-marker-${item.id}`" :style="{ backgroundColor: item.color }" />
          <span>{{ item.label }}</span>
        </span>
      </div>

      <analytics-combination-chart :series="chartSeries" :value-formatter="formatCurrency" :aria-label="$t('analytics.daily_forecast.chart_label')" @select="onSelect" @select-point="onSelectPoint" />

      <div v-if="selectedPayload" class="analytics-calculation-details analytics-daily-forecast-details" aria-live="polite">
        <div class="analytics-daily-forecast-details-heading">
          <strong>{{ $t('analytics.daily_forecast.day_details') }}</strong>
          <span>{{ selectedLabel }}</span>
        </div>
        <div class="analytics-daily-forecast-day-summary">
          <div v-for="item in selectedDayTotals" :key="item.id">
            <span>{{ item.label }}</span>
            <strong>{{ formatCurrency(item.value) }}</strong>
          </div>
        </div>
        <template v-if="selectedDayEntries.length">
          <div class="font-weight-600">{{ $t('analytics.daily_forecast.scheduled_and_estimated') }}</div>
          <button
            v-for="entry in selectedDayEntries"
            :key="entry.id"
            type="button"
            class="analytics-daily-forecast-detail-row"
            style="min-height: 44px"
            :disabled="entry.sourceKind !== 'actual'"
            @click="onDetailEntry(entry)"
          >
            <span class="analytics-daily-forecast-detail-main">
              <span class="font-weight-600">{{ entry.sourceLabel || sourceLabel(entry.sourceKind) }}</span>
              <small>{{ sourceLabel(entry.sourceKind) }}</small>
            </span>
            <span :class="entry.direction === 'uses' ? 'analytics-negative-value' : 'analytics-positive-value'">{{ formatSignedCurrency(entry.displayAmount) }}</span>
          </button>
          <details v-if="selectedProjectedSources.length" class="analytics-warning-details">
            <summary>{{ $t('analytics.common.details') }}</summary>
            <div v-for="source in selectedProjectedSources" :key="source.id" class="analytics-assumption-note">
              <div class="font-weight-600">
                {{ sourceLabel(source.sourceKind) }}<template v-if="source.sourceLabel"> — {{ source.sourceLabel }}</template> · {{ formatCurrency(source.amount) }}
              </div>
              <div v-if="source.overdue">{{ $t('analytics.daily_forecast.overdue') }}</div>
              <div v-if="source.confidence?.level">{{ $t('analytics.daily_forecast.confidence', { level: source.confidence.level }) }}</div>
              <div v-for="reason in source.reasons ?? []" :key="reason">{{ reason }}</div>
              <div v-if="source.sourceId">{{ $t('analytics.daily_forecast.source_id', { id: source.sourceId }) }}</div>
              <div v-if="source.candidateId">{{ $t('analytics.daily_forecast.candidate_id', { id: source.candidateId }) }}</div>
              <div v-if="source.evidenceIds?.length">{{ $t('analytics.daily_forecast.evidence_ids', { ids: source.evidenceIds.join(', ') }) }}</div>
              <div v-if="source.evidenceOmittedCount">{{ $t('analytics.common.more_items', { count: source.evidenceOmittedCount }) }}</div>
              <div v-if="source.conversion?.mode">{{ $t('analytics.daily_forecast.conversion', { mode: source.conversion.mode }) }}</div>
            </div>
          </details>
        </template>
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
import { summarizeProjectedSources } from '~/utils/AnalyticsForecastUtils.js'
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
const formatSignedCurrency = (value) => (Number.isFinite(value) ? `${value > 0 ? '+' : ''}${formatCurrency(value)}` : '—')
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
const unavailableEvidenceSummary = computed(() => dailyState.value.unavailableEvidenceSummary ?? { count: 0, previewIds: [], omittedCount: 0 })
const summaryItems = computed(() => [
  { id: 'inflow', label: t('analytics.daily_forecast.expected_inflow'), value: daily.value.summary.inflow.final, projected: daily.value.summary.inflow.projected },
  { id: 'outflow', label: t('analytics.daily_forecast.expected_outflow'), value: daily.value.summary.outflow.final, projected: daily.value.summary.outflow.projected },
  { id: 'available', label: t('analytics.daily_forecast.available_change'), value: daily.value.summary.availableChange.final, projected: daily.value.summary.availableChange.projected },
])
const legendItems = computed(() => [
  { id: 'inflow', label: t('analytics.daily_forecast.inflow'), color: 'var(--income2)' },
  { id: 'outflow', label: t('analytics.daily_forecast.outflow'), color: 'var(--expense2)' },
  { id: 'available', label: t('analytics.daily_forecast.available_change'), color: 'var(--transfer2)' },
])
const directionKeys = {
  sources: ['income', 'refunds', 'savingsWithdrawals', 'newDebt'],
  uses: ['expenses', 'savingsDeposits', 'debtRepayments'],
}
const entryValue = (entry, direction) => directionKeys[direction].reduce((total, key) => total + (entry.flowAmounts?.[key] ?? 0), 0) * (direction === 'uses' ? -1 : 1)
const selectedDayEntries = computed(() => {
  const entries = new Map()
  for (const { seriesId, point } of selectedPayload.value?.values ?? []) {
    if (!['inflow', 'outflow'].includes(seriesId)) continue
    for (const entry of point.entries ?? []) entries.set(entry.id, { ...entry, direction: point.direction, displayAmount: entryValue(entry, point.direction) })
  }
  return [...entries.values()].sort((left, right) => Math.abs(right.displayAmount) - Math.abs(left.displayAmount) || String(left.id).localeCompare(String(right.id)))
})
const selectedProjectedSources = computed(() =>
  summarizeProjectedSources(selectedDayEntries.value.filter(({ sourceKind }) => sourceKind !== 'actual').map((entry) => ({ ...entry, amount: Math.abs(entry.displayAmount) }))),
)
const selectedDayTotals = computed(() =>
  (selectedPayload.value?.values ?? [])
    .filter(({ seriesId }) => ['inflow', 'outflow', 'availableCashChange'].includes(seriesId))
    .map(({ seriesId, label, point }) => ({ id: seriesId, label, value: point.value })),
)
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
  if (!selection.route) {
    if (point?.kind === 'forecast') selectedPayload.value = { xLabel: point.xLabel ?? point.x, values: [{ point }] }
    return
  }
  await navigateTo(selection.route)
}
const onDetailEntry = async (entry) => {
  if (entry.sourceKind === 'actual') {
    const selection = projectLineChartSelection({
      activation: 'pointer',
      transactionIds: entry.transactionIds,
      kind: 'actual',
      route: RouteConstants.ROUTE_TRANSACTION_LIST,
      toUrl: TransactionFilterUtils.filters.id.toUrl,
    })
    if (selection.route) await navigateTo(selection.route)
  }
}
</script>
