<template>
  <div class="app-form analytics-page analytics-daily-forecast-page">
    <app-top-toolbar />
    <van-pull-refresh v-model="isRefreshing" @refresh="onRefresh">
      <van-cell-group inset class="analytics-card analytics-daily-forecast-full-card">
        <div class="van-cell-group-title analytics-card-title">
          <div class="flex-1">
            <div>{{ $t('analytics.daily_forecast.title') }}</div>
            <div class="analytics-card-subtitle">{{ monthTitle }}</div>
          </div>
        </div>
        <div class="analytics-category-periods">
          <app-tabs v-model="analyticsStore.dailyForecastMonths" :items="periodItems" :aria-label="$t('analytics.daily_forecast.history_window_label')" />
        </div>
        <div v-if="analyticsStore.dailyForecastState.status === 'loading' && !analyticsStore.dailyForecast.dateKeys.length" class="analytics-card-state">
          <van-loading size="20" />
          <span>{{ $t('analytics.common.loading') }}</span>
        </div>
        <div v-else-if="analyticsStore.dailyForecastState.status === 'error' && !analyticsStore.dailyForecast.dateKeys.length" class="analytics-card-state">
          <span>{{ $t('analytics.daily_forecast.error') }}</span>
          <van-button class="analytics-daily-forecast-retry" size="small" @click="analyticsStore.retryDailyForecast">{{ $t('analytics.common.retry') }}</van-button>
        </div>
        <template v-else>
          <div v-if="analyticsStore.dailyForecastState.isPartiallyUnavailable" class="analytics-daily-forecast-partial-note" role="status">
            {{ $t('analytics.daily_forecast.inputs_need_review', { count: partialInputCount }) }}
          </div>
          <div v-if="analyticsStore.dailyForecastState.isBlockingUnavailable" class="analytics-warning" role="alert">{{ $t('analytics.daily_forecast.unavailable') }}</div>
          <analytics-daily-forecast-overview
            :forecast="analyticsStore.dailyForecast"
            :display-currency-code="analyticsStore.displayCurrencyCode"
            :display-currency-decimal-places="analyticsStore.displayCurrencyDecimalPlaces"
            @select="onSelect"
            @select-point="onSelectPoint"
          />
          <analytics-daily-forecast-details
            :forecast="analyticsStore.dailyForecast"
            :state="analyticsStore.dailyForecastState"
            :impact="analyticsStore.dailyForecastImpact"
            :selected-date="selectedDate"
            :display-currency-code="analyticsStore.displayCurrencyCode"
            :language="profileStore.language"
            @retry="analyticsStore.retryDailyForecast"
          />
        </template>
      </van-cell-group>
    </van-pull-refresh>
  </div>
</template>

<script setup>
import { parseISO } from 'date-fns'
import { useToolbar } from '~/composables/useToolbar'
import RouteConstants from '~/constants/RouteConstants.js'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { useProfileStore } from '~/stores/profileStore.js'

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const route = useRoute()
const isRefreshing = ref(false)
const selectedDate = ref(null)
const { t } = useI18n()
const periodItems = computed(() => [3, 6, 12].map((value) => ({ label: t('analytics.period.months_short', { count: value }), value })))
const monthTitle = computed(() => new Intl.DateTimeFormat(profileStore.language, { month: 'long', year: 'numeric' }).format(parseISO(`${analyticsStore.dailyForecast.monthKey}-01`)))
const queryDate = computed(() => (analyticsStore.dailyForecast.dateKeys.includes(String(route.query.date ?? '')) ? String(route.query.date) : null))
const partialInputCount = computed(() => Math.max(1, analyticsStore.dailyForecastState.unavailableEvidenceSummary.count + analyticsStore.dailyForecastState.sourceErrors.length))

watch(
  [queryDate, () => analyticsStore.dailyForecast.dateKeys],
  ([value]) => {
    selectedDate.value = value
  },
  { immediate: true },
)
const selectDate = async (date) => {
  if (!analyticsStore.dailyForecast.dateKeys.includes(date)) return
  selectedDate.value = date
  await navigateTo({ path: RouteConstants.ROUTE_ANALYTICS_DAILY_FORECAST, query: { ...route.query, date } }, { replace: true })
}
const onSelect = (payload) => selectDate(payload?.x ?? payload?.values?.find(({ point }) => point?.x)?.point?.x ?? null)
const onSelectPoint = ({ point }) => selectDate(point?.x ?? null)
const onRefresh = async () => {
  isRefreshing.value = true
  await analyticsStore.refresh()
  isRefreshing.value = false
}

onMounted(() => analyticsStore.init())
useToolbar().init({ title: t('analytics.daily_forecast.title'), backRoute: RouteConstants.ROUTE_ANALYTICS })
</script>
