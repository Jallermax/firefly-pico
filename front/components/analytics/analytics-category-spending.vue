<template>
  <van-cell-group inset class="analytics-card analytics-category-card">
    <div class="van-cell-group-title analytics-card-title analytics-category-card-title">
      <div class="flex-1">
        <div class="flex-center-vertical gap-2">
          <span>{{ $t('analytics.category.title') }}</span>
        </div>
        <div class="analytics-card-subtitle">{{ $t('analytics.category.subtitle') }}</div>
      </div>
      <analytics-category-facet v-model="analyticsStore.selectedCategoryIds" :items="facetItems" :max="6" />
    </div>
    <div class="analytics-category-periods">
      <app-tabs v-model="analyticsStore.categoryAverageMonths" :items="periodItems" />
    </div>

    <div v-if="analyticsStore.categoryState.sourceErrors.length" class="analytics-warning" role="status">
      <span>{{ $t('analytics.category.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryCategory">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <div v-if="analyticsStore.categoryState.status === 'loading' && !hasRetainedData" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="analyticsStore.categoryState.status === 'error' && !hasRetainedData" class="analytics-card-state">
      <span>{{ $t('analytics.category.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryCategory">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <div v-else-if="readyPresentation.isBlocked" class="analytics-warning" role="alert">
      {{ $t('analytics.common.unavailable_amounts', { ids: readyPresentation.unavailableTransactionIds.join(', ') }) }}
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

      <div v-if="summaryPresentation.layout === 'desktop'" class="analytics-category-summary-scroll">
        <div class="analytics-category-summary">
          <div class="analytics-category-summary-header" style="grid-template-columns: minmax(96px, 1.4fr) repeat(4, minmax(82px, 1fr))">
            <span>{{ summaryPresentation.labels.category }}</span>
            <span v-for="value in summaryPresentation.rows[0]?.values ?? []" :key="value.id">{{ value.label }}</span>
          </div>
          <div v-for="item in summaryPresentation.rows" :key="item.id" class="analytics-category-summary-row" style="grid-template-columns: minmax(96px, 1.4fr) repeat(4, minmax(82px, 1fr))">
            <span class="analytics-category-summary-label"><span class="analytics-chart-legend-marker" :style="{ backgroundColor: item.color }" />{{ item.label }}</span>
            <template v-for="value in item.values" :key="value.id">
              <strong v-if="item.forecastAvailable || !['currentForecast', 'remainingFromToday'].includes(value.id)">{{ value.value }}</strong>
              <span v-else class="analytics-category-insufficient">{{ value.value }}</span>
            </template>
          </div>
        </div>
      </div>
      <div v-else class="analytics-category-summary-mobile">
        <div v-for="item in summaryPresentation.rows" :key="item.id" class="analytics-category-summary-mobile-row">
          <div class="analytics-category-summary-label"><span class="analytics-chart-legend-marker" :style="{ backgroundColor: item.color }" />{{ item.label }}</div>
          <dl class="analytics-category-summary-mobile-values">
            <div v-for="value in item.values" :key="value.id">
              <dt>{{ value.label }}</dt>
              <dd>{{ value.value }}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div v-if="readyPresentation.showShortHistory" class="analytics-assumption-note">
        {{ $t('analytics.common.based_on_months', { used: summary.usedMonths, requested: summary.requestedMonths }) }}
      </div>
      <details v-if="readyPresentation.showCalculation" class="analytics-calculation-details">
        <summary>{{ $t('analytics.common.how_calculated') }}</summary>
        <p>{{ $t('analytics.category.definition') }}</p>
        <p>{{ $t('analytics.category.current_month_separate') }}</p>
      </details>
    </template>

    <app-popup v-model:show="forecastDetailsVisible" popup-style="max-width: 520px">
      <div v-if="selectedForecastPoint" class="analytics-forecast-details">
        <div class="analytics-category-facet-header">
          <strong class="flex-1">{{ $t('analytics.common.details') }} — {{ selectedForecastPoint.categoryLabel }}</strong>
          <van-button size="small" @click="forecastDetailsVisible = false">{{ $t('ok') }}</van-button>
        </div>
        <p>{{ $t('analytics.category.final_forecast_rule') }}</p>
        <div v-for="row in forecastDetails" :key="row.id" class="analytics-forecast-detail-row">
          <span>{{ row.label }}</span
          ><strong>{{ row.value }}</strong>
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
import { useAppStore } from '~/stores/appStore.js'
import { useCategoryStore } from '~/stores/categoryStore.js'
import { useProfileStore } from '~/stores/profileStore.js'
import { buildCategoryForecastDetailsPresentation, buildCategoryReadyPresentation, buildCategorySummaryPresentation, decorateCategoryChartPoint } from '~/utils/AnalyticsCategoryPresentationUtils.js'
import { ANALYTICS_UNCATEGORIZED_ID } from '~/utils/AnalyticsUtils.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'
import { projectCategorySpendingSelection } from '~/utils/ChartUtils.js'
import TransactionFilterUtils from '~/utils/TransactionFilterUtils.js'

const CATEGORY_COLORS = [
  'var(--analytics-category-1)',
  'var(--analytics-category-2)',
  'var(--analytics-category-3)',
  'var(--analytics-category-4)',
  'var(--analytics-category-5)',
  'var(--analytics-category-6)',
]
const analyticsStore = useAnalyticsStore()
const appStore = useAppStore()
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
const formatSignedCurrency = (value) => `${value > 0 ? '+' : ''}${formatNumberForDashboard(value)} ${analyticsStore.displayCurrencyCode}`
const toChartPoint = (point, kind, remainingFromToday) =>
  decorateCategoryChartPoint(point, {
    kind,
    fallbackXLabel: formatMonthKey(point.x),
    currencyCode: analyticsStore.displayCurrencyCode,
    formatNumber: formatNumberForDashboard,
    secondaryLabel: kind === 'forecast' ? t('analytics.common.from_today') : undefined,
    secondaryValueLabel: kind === 'forecast' && Number.isFinite(remainingFromToday) ? formatSignedCurrency(remainingFromToday) : undefined,
  })

const chartSeries = computed(() =>
  (summary.value?.series ?? []).slice(0, 6).map((category, index) => ({
    id: category.id,
    label: categoryLabel(category.id),
    color: CATEGORY_COLORS[index],
    points: [
      ...category.actualPoints.map((point) => toChartPoint(point, 'actual')),
      ...(category.forecastAvailable
        ? [
            toChartPoint(
              {
                x: currentMonthKey.value + ':forecast',
                xLabel: currentMonthLabel.value,
                value: category.currentForecast,
                transactionIds: category.currentTransactionIds,
                actualToDate: category.actualToDate,
                final: category.final,
                progress: category.progress,
                progressState: category.progressState,
                projectedSources: category.projectedSources,
                currentActual: category.currentActual,
                average: category.average,
                currentForecast: category.currentForecast,
                remainingFromToday: category.remainingFromToday,
                usedMonths: summary.value.usedMonths,
                categoryLabel: categoryLabel(category.id),
              },
              'forecast',
              category.remainingFromToday,
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
    remainingFromTodayLabel: category.forecastAvailable ? formatSignedCurrency(category.remainingFromToday) : null,
  })),
)
const summaryPresentation = computed(() =>
  buildCategorySummaryPresentation({
    summaries: summaries.value,
    isDesktopLayout: appStore.isDesktopLayout,
    labels: {
      category: t('category'),
      average: t('analytics.common.average'),
      currentActual: t('analytics.category.current_actual'),
      currentForecast: t('analytics.common.end_of_month'),
      remainingFromToday: t('analytics.common.from_today'),
      insufficientHistory: t('analytics.category.insufficient_history'),
    },
  }),
)
const forecastDetails = computed(() =>
  selectedForecastPoint.value
    ? buildCategoryForecastDetailsPresentation({
        point: selectedForecastPoint.value,
        labels: {
          currentActual: t('analytics.category.current_actual'),
          finalForecast: t('analytics.common.end_of_month'),
          remainingFromToday: t('analytics.category.remaining_from_today'),
          progress: '%',
        },
        formatValue: formatCurrency,
        formatSignedValue: formatSignedCurrency,
      })
    : [],
)
const readyPresentation = computed(() =>
  buildCategoryReadyPresentation({
    usedMonths: summary.value.usedMonths,
    requestedMonths: summary.value.requestedMonths,
    unclassified: summary.value.unclassified,
  }),
)
const facetItems = computed(() => {
  const rankedItems = analyticsStore.categoryRankingItems
  const rankedIds = new Set(rankedItems.map(({ id }) => id))
  return [...rankedItems, ...selectedCategoryIds.value.filter((id) => !rankedIds.has(id)).map((id) => ({ id, amount: 0 }))]
})
const hasRetainedData = computed(() => analyticsStore.categoryState.isStale && chartSeries.value.length > 0)

const onSelectPoint = async ({ activation, point, transactionIds }) => {
  const selection = projectCategorySpendingSelection({ activation, point: { ...point, transactionIds }, route: RouteConstants.ROUTE_TRANSACTION_LIST, toUrl: TransactionFilterUtils.filters.id.toUrl })
  if (selection.forecastOnly) {
    selectedForecastPoint.value = point
    forecastDetailsVisible.value = true
    return
  }
  if (!selection.route) return
  await navigateTo(selection.route)
}
</script>
