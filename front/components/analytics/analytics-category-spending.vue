<template>
  <van-cell-group inset class="analytics-card analytics-category-card">
    <div class="van-cell-group-title analytics-card-title analytics-category-card-title">
      <span class="flex-1">{{ $t('analytics.category.title') }}</span>
      <analytics-category-facet v-model="analyticsStore.selectedCategoryIds" :items="facetItems" :max="6" />
    </div>
    <div class="analytics-category-periods">
      <app-tabs v-model="analyticsStore.categoryAverageMonths" :items="periodItems" />
    </div>

    <div v-if="analyticsStore.categoryState.status === 'loading' && !hasRetainedData" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="analyticsStore.categoryState.status === 'error' && !hasRetainedData" class="analytics-card-state">
      <span>{{ $t('analytics.category.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryCategory">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <template v-else-if="analyticsStore.categoryState.status === 'empty' || chartSeries.length === 0">
      <div class="analytics-card-state">{{ $t('analytics.category.empty') }}</div>
      <div class="analytics-assumption-note">{{ $t('analytics.category.definition') }}</div>
      <div class="analytics-assumption-note">{{ $t('analytics.category.current_month_separate') }}</div>
    </template>
    <template v-else>
      <div v-if="analyticsStore.categoryState.status === 'error'" class="analytics-card-state analytics-card-state-compact">
        <span>{{ $t('analytics.category.error') }}</span>
        <van-button size="small" @click="analyticsStore.retryCategory">{{ $t('analytics.common.retry') }}</van-button>
      </div>
      <div v-else-if="analyticsStore.categoryState.status === 'loading' && analyticsStore.categoryState.isStale" class="analytics-assumption-note">{{ $t('analytics.common.stale') }}</div>

      <multi-series-line-chart :series="chartSeries" :value-formatter="formatNumberForDashboard" :aria-label="$t('analytics.category.chart_label')" @select-point="onSelectPoint" />

      <div class="analytics-category-summary-scroll">
        <div class="analytics-category-summary">
          <div class="analytics-category-summary-header">
            <span>{{ $t('category') }}</span>
            <span>{{ $t('analytics.common.average') }}</span>
            <span>{{ $t('analytics.category.current_actual') }}</span>
            <span>{{ $t('analytics.category.current_forecast') }}</span>
          </div>
          <div v-for="item in summaries" :key="item.id" class="analytics-category-summary-row">
            <span class="analytics-category-summary-label"><span class="analytics-chart-legend-marker" :style="{ backgroundColor: item.color }" />{{ item.label }}</span>
            <strong>{{ item.averageLabel }}</strong>
            <strong>{{ item.currentActualLabel }}</strong>
            <strong v-if="item.forecastAvailable">{{ item.forecastLabel }}</strong>
            <span v-else class="analytics-category-insufficient">{{ $t('analytics.category.insufficient_history') }}</span>
          </div>
        </div>
      </div>

      <div v-if="summary.usedMonths !== summary.requestedMonths" class="analytics-assumption-note">
        {{ $t('analytics.common.based_on_months', { used: summary.usedMonths, requested: summary.requestedMonths }) }}
      </div>
      <div class="analytics-assumption-note">{{ $t('analytics.category.definition') }}</div>
      <div class="analytics-assumption-note">{{ $t('analytics.category.current_month_separate') }}</div>
      <div v-if="summary.isEstimated" class="analytics-assumption-note">{{ $t('analytics.common.estimated_current_rates') }}</div>
      <div v-if="summary.missingCurrencies?.length" class="analytics-warning">{{ $t('analytics.common.missing_rates', { currencies: summary.missingCurrencies.join(', ') }) }}</div>
    </template>

    <template v-if="analyticsStore.categoryState.status !== 'loading' && (analyticsStore.categoryState.status === 'empty' || chartSeries.length === 0)">
      <div v-if="summary.isEstimated" class="analytics-assumption-note">{{ $t('analytics.common.estimated_current_rates') }}</div>
      <div v-if="summary.missingCurrencies?.length" class="analytics-warning">{{ $t('analytics.common.missing_rates', { currencies: summary.missingCurrencies.join(', ') }) }}</div>
    </template>

    <app-popup v-model:show="forecastDetailsVisible" popup-style="max-width: 520px">
      <div v-if="selectedForecastPoint" class="analytics-forecast-details">
        <div class="analytics-category-facet-header">
          <strong class="flex-1">{{ $t('analytics.common.details') }} — {{ selectedForecastPoint.categoryLabel }}</strong>
          <van-button size="small" @click="forecastDetailsVisible = false">{{ $t('ok') }}</van-button>
        </div>
        <p>{{ $t('analytics.category.forecast_formula') }}</p>
        <div class="analytics-forecast-detail-row">
          <span>{{ $t('analytics.category.current_actual') }}</span
          ><strong>{{ formatCurrency(selectedForecastPoint.currentActual) }}</strong>
        </div>
        <div class="analytics-forecast-detail-row">
          <span>{{ $t('analytics.category.average_remainder') }}</span
          ><strong>{{ formatCurrency(selectedForecastPoint.averageRemainder) }}</strong>
        </div>
        <div class="analytics-forecast-detail-row">
          <span>{{ $t('analytics.category.used_month_count') }}</span
          ><strong>{{ selectedForecastPoint.usedMonths }}</strong>
        </div>
        <div class="analytics-forecast-detail-row">
          <span>{{ $t('analytics.category.current_forecast') }}</span
          ><strong>{{ formatCurrency(selectedForecastPoint.value) }}</strong>
        </div>
      </div>
    </app-popup>
  </van-cell-group>
</template>

<script setup>
import { format, parseISO } from 'date-fns'
import Category from '~/models/Category.js'
import RouteConstants from '~/constants/RouteConstants.js'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { useCategoryStore } from '~/stores/categoryStore.js'
import { useProfileStore } from '~/stores/profileStore.js'
import { ANALYTICS_UNCATEGORIZED_ID } from '~/utils/AnalyticsUtils.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'
import TransactionFilterUtils from '~/utils/TransactionFilterUtils.js'

const CATEGORY_COLORS = [
  'var(--analytics-category-1)',
  'var(--analytics-category-2)',
  'var(--analytics-category-3)',
  'var(--analytics-category-4)',
  'var(--analytics-category-5)',
  'var(--analytics-category-6)',
]
const CATEGORY_MARKERS = ['circle', 'square', 'diamond', 'hollow', 'circle', 'square']

const analyticsStore = useAnalyticsStore()
const categoryStore = useCategoryStore()
const profileStore = useProfileStore()
const { t } = useI18n()
const forecastDetailsVisible = ref(false)
const selectedForecastPoint = ref(null)
const summary = computed(() => analyticsStore.categorySummary)
const selectedCategoryIds = computed(() => (Array.isArray(analyticsStore.selectedCategoryIds) ? analyticsStore.selectedCategoryIds : []))
const periodItems = computed(() => [3, 6, 12, 24].map((value) => ({ label: t('analytics.period.months_short', { count: value }), value })))
const formatMonthKey = (value) => new Intl.DateTimeFormat(profileStore.language, { month: 'short', year: 'numeric' }).format(parseISO(value.slice(0, 7) + '-01'))
const currentMonthKey = computed(() => format(new Date(), 'yyyy-MM'))
const currentMonthLabel = computed(() => formatMonthKey(currentMonthKey.value))
const categoryLabel = (categoryId) =>
  categoryId === ANALYTICS_UNCATEGORIZED_ID ? t('analytics.category.uncategorized') : Category.getDisplayName(categoryStore.categoryDictionary[categoryId]) || categoryId
const formatCurrency = (value) => `${formatNumberForDashboard(value)} ${analyticsStore.displayCurrencyCode}`
const toChartPoint = (point, kind) => ({
  ...point,
  xLabel: point.xLabel ?? formatMonthKey(point.x),
  valueLabel: formatNumberForDashboard(point.value),
  kind,
  isEstimated: analyticsStore.categorySummary.isEstimated,
})

const chartSeries = computed(() =>
  (summary.value?.series ?? []).slice(0, 6).map((category, index) => ({
    id: category.id,
    label: categoryLabel(category.id),
    color: CATEGORY_COLORS[index],
    marker: CATEGORY_MARKERS[index],
    points: [
      ...category.actualPoints.map((point) => toChartPoint(point, 'actual')),
      toChartPoint({ x: currentMonthKey.value, value: category.currentActual, transactionIds: category.currentTransactionIds }, 'actual'),
      ...(category.forecastAvailable
        ? [
            toChartPoint(
              {
                x: currentMonthKey.value + ':forecast',
                xLabel: currentMonthLabel.value,
                value: category.currentForecast,
                transactionIds: [],
                currentActual: category.currentActual,
                averageRemainder: category.currentForecast - category.currentActual,
                usedMonths: summary.value.usedMonths,
                categoryLabel: categoryLabel(category.id),
              },
              'forecast',
            ),
          ]
        : []),
    ],
  })),
)

const summaries = computed(() =>
  (summary.value?.series ?? []).slice(0, 6).map((category, index) => ({
    ...category,
    label: categoryLabel(category.id),
    color: CATEGORY_COLORS[index],
    averageLabel: category.average === null ? '—' : formatCurrency(category.average),
    currentActualLabel: formatCurrency(category.currentActual),
    forecastLabel: category.forecastAvailable ? formatCurrency(category.currentForecast) : null,
  })),
)
const facetItems = computed(() => {
  const rankedItems = analyticsStore.categoryRankingItems
  const rankedIds = new Set(rankedItems.map(({ id }) => id))
  return [...rankedItems, ...selectedCategoryIds.value.filter((id) => !rankedIds.has(id)).map((id) => ({ id, amount: 0 }))]
})
const hasRetainedData = computed(() => analyticsStore.categoryState.isStale && chartSeries.value.length > 0)

const onSelectPoint = async ({ point }) => {
  if (point.kind === 'forecast') {
    selectedForecastPoint.value = point
    forecastDetailsVisible.value = true
    return
  }
  if (!point.transactionIds?.length) return
  const ids = [...new Set(point.transactionIds)].join(',')
  const query = TransactionFilterUtils.filters.id.toUrl(ids)
  await navigateTo(RouteConstants.ROUTE_TRANSACTION_LIST + '?' + query)
}
</script>
