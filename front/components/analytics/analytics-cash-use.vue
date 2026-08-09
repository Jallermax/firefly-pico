<template>
  <van-cell-group inset class="analytics-card analytics-cash-use-card">
    <div class="van-cell-group-title analytics-card-title">
      <div class="flex-1">
        <div class="flex-center-vertical gap-2">
          <span>{{ $t('analytics.cash_use.title') }}</span>
        </div>
        <div class="analytics-card-subtitle">{{ $t('analytics.cash_use.subtitle') }}</div>
      </div>
      <analytics-category-facet v-model="analyticsStore.selectedCategoryIds" :items="facetItems" :max="6" />
    </div>

    <div class="analytics-category-periods">
      <app-tabs v-model="analyticsStore.cashUseMode" :items="modeItems" :aria-label="$t('analytics.cash_use.mode_label')" />
      <app-tabs v-model="analyticsStore.balancePeriod" :items="periodItems" :aria-label="$t('analytics.cash_use.history_window_label')" />
      <app-tabs v-model="analyticsStore.cashUseDetail" :items="detailItems" :aria-label="$t('analytics.cash_use.detail_label')" />
    </div>

    <div v-if="cashUseState.sourceErrors.length" class="analytics-warning" role="status">
      <span>{{ $t('analytics.cash_use.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryCashUse">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <div v-if="cashUseState.status === 'loading' && !hasRetainedData" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="cashUseState.status === 'error' && !hasRetainedData" class="analytics-card-state">
      <span>{{ $t('analytics.cash_use.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryCashUse">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <div v-else-if="cashUseState.isUnavailable" class="analytics-warning" role="alert">
      <div v-if="cashUseState.unavailableTransactionIds.length">{{ $t('analytics.common.unavailable_amounts', { ids: cashUseState.unavailableTransactionIds.join(', ') }) }}</div>
      <div v-if="projectedUnavailableSummary.count">{{ $t('analytics.common.unavailable_evidence_count', { count: projectedUnavailableSummary.count }) }}</div>
      <details v-if="projectedUnavailableSummary.previewIds.length" class="analytics-warning-details">
        <summary>{{ $t('analytics.common.details') }}</summary>
        <div class="analytics-warning-evidence">{{ projectedUnavailableSummary.previewIds.join(', ') }}</div>
        <div v-if="projectedUnavailableSummary.omittedCount">{{ $t('analytics.common.more_items', { count: projectedUnavailableSummary.omittedCount }) }}</div>
      </details>
      <template v-if="!cashUseState.unavailableTransactionIds.length && !projectedUnavailableSummary.count">{{
        $t('analytics.cash_use.forecast_unavailable', { ids: cashUseState.auditStatus })
      }}</template>
    </div>
    <template v-else-if="!hasActivity">
      <div class="analytics-card-state">{{ $t('analytics.cash_use.empty') }}</div>
      <div class="analytics-assumption-note">{{ $t('analytics.cash_use.definition') }}</div>
    </template>
    <template v-else>
      <div v-if="cashUseState.status === 'error'" class="analytics-card-state analytics-card-state-compact">
        <span>{{ $t('analytics.cash_use.error') }}</span>
        <van-button size="small" @click="analyticsStore.retryCashUse">{{ $t('analytics.common.retry') }}</van-button>
      </div>
      <div v-else-if="cashUseState.status === 'loading' && cashUseState.isStale" class="analytics-assumption-note">{{ $t('analytics.common.stale') }}</div>

      <analytics-combination-chart :series="chartSeries" :value-formatter="formatCurrency" :aria-label="$t('analytics.cash_use.chart_label')" @select-point="onSelectPoint" />

      <details class="analytics-calculation-details">
        <summary>{{ $t('analytics.common.how_calculated') }}</summary>
        <p>{{ $t(analyticsStore.cashUseMode === 'full' ? 'analytics.cash_use.full_definition' : 'analytics.cash_use.spending_definition') }}</p>
        <p>{{ $t('analytics.cash_use.refund_definition') }}</p>
      </details>
    </template>
  </van-cell-group>
</template>

<script setup>
import { parseISO } from 'date-fns'
import Category from '~/models/Category.js'
import RouteConstants from '~/constants/RouteConstants.js'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { useCategoryStore } from '~/stores/categoryStore.js'
import { useProfileStore } from '~/stores/profileStore.js'
import { ANALYTICS_UNCATEGORIZED_ID } from '~/utils/AnalyticsUtils.js'
import { projectLineChartSelection } from '~/utils/ChartUtils.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'
import TransactionFilterUtils from '~/utils/TransactionFilterUtils.js'

const USE_COLORS = [
  'var(--analytics-category-1)',
  'var(--analytics-category-2)',
  'var(--analytics-category-3)',
  'var(--analytics-category-4)',
  'var(--analytics-category-5)',
  'var(--analytics-category-6)',
]
const SOURCE_COLORS = ['var(--income2)', 'var(--transfer2)', 'var(--analytics-category-6)', 'var(--van-text-color-2)']

const analyticsStore = useAnalyticsStore()
const categoryStore = useCategoryStore()
const profileStore = useProfileStore()
const { t } = useI18n()
const cashUseState = computed(() => analyticsStore.cashUseState)
const cashUse = computed(() => analyticsStore.cashUseSeries)
const selectedCategoryIds = computed(() => (Array.isArray(analyticsStore.selectedCategoryIds) ? analyticsStore.selectedCategoryIds : []))
const modeItems = computed(() => [
  { label: t('analytics.cash_use.mode_spending'), value: 'spending' },
  { label: t('analytics.cash_use.mode_full'), value: 'full' },
])
const periodItems = computed(() => [3, 6, 12, 24].map((value) => ({ label: t('analytics.period.months_short', { count: value }), value })))
const detailItems = computed(() => [
  { label: t('analytics.flow.top_5'), value: 5 },
  { label: t('analytics.flow.top_10'), value: 10 },
  { label: t('analytics.flow.all'), value: 'all' },
])
const categoryLabel = (id) => (id === ANALYTICS_UNCATEGORIZED_ID ? t('analytics.category.uncategorized') : Category.getDisplayName(categoryStore.categoryDictionary[id]) || id)
const formatCurrency = (value) => (Number.isFinite(value) ? `${formatNumberForDashboard(value)} ${analyticsStore.displayCurrencyCode}` : '—')
const formatMonth = (key) => new Intl.DateTimeFormat(profileStore.language, { month: 'short', year: 'numeric' }).format(parseISO(key.slice(0, 7) + '-01'))
const pointLabel = (point) => ({ ...point, xLabel: formatMonth(point.x), valueLabel: formatCurrency(point.value) })
const layerLabel = (layer) => {
  if (layer.kind === 'expenseCategory') return categoryLabel(layer.categoryId)
  if (layer.kind === 'otherExpense') return t('analytics.flow.other')
  return layer.labelKey ? t(layer.labelKey) : layer.id
}
const facetItems = computed(() => {
  const items = analyticsStore.cashUseCategoryRankingItems
  const ids = new Set(items.map(({ id }) => id))
  return [...items, ...selectedCategoryIds.value.filter((id) => !ids.has(id)).map((id) => ({ id, amount: 0 }))]
})
const chartSeries = computed(() => ({
  ...cashUse.value,
  useLayers: cashUse.value.useLayers.map((layer, index) => ({ ...layer, label: layerLabel(layer), color: USE_COLORS[index % USE_COLORS.length], points: layer.points.map(pointLabel) })),
  totalUses: { ...cashUse.value.totalUses, points: cashUse.value.totalUses.points.map(pointLabel) },
  ordinaryIncome: {
    ...cashUse.value.ordinaryIncome,
    label: t(cashUse.value.ordinaryIncome.labelKey),
    color: 'var(--income2)',
    points: cashUse.value.ordinaryIncome.points.map(pointLabel),
  },
  sourceBands: cashUse.value.sourceBands.map((band, index) => ({ ...band, label: t(band.labelKey), color: SOURCE_COLORS[index % SOURCE_COLORS.length], points: band.points.map(pointLabel) })),
  totalSources: {
    ...cashUse.value.totalSources,
    label: t(cashUse.value.totalSources.labelKey),
    color: 'var(--van-text-color-2)',
    points: cashUse.value.totalSources.points.map(pointLabel),
  },
  totalUsesLabel: t('analytics.cash_use.total_uses'),
  gap: { ...cashUse.value.gap, points: cashUse.value.gap.points.map((point) => ({ ...pointLabel(point), label: t(point.labelKey) })) },
}))
const hasActivity = computed(() =>
  [...cashUse.value.useLayers, cashUse.value.ordinaryIncome, ...cashUse.value.sourceBands].some(({ points }) => points.some(({ value }) => Number.isFinite(value) && value !== 0)),
)
const hasRetainedData = computed(() => cashUseState.value.isStale && hasActivity.value)
const projectedUnavailableSummary = computed(() => cashUseState.value.projectedUnavailableSummary ?? { count: 0, previewIds: [], omittedCount: 0 })

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
