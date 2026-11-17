<template>
  <analytics-page-layout :title="$t('analytics.daily_forecast.title')" :back-route="RouteConstants.ROUTE_ANALYTICS" :refresh="analyticsStore.refresh">
    <section class="analytics-card analytics-daily-forecast-full-card">
      <div class="analytics-card-title">
        <h2>{{ monthTitle }}</h2>
      </div>
      <div class="analytics-category-periods">
        <analytics-tabs v-model="analyticsStore.dailyForecastMonths" :items="periodItems" :aria-label="$t('analytics.daily_forecast.history_window_label')" />
      </div>
      <div v-if="analyticsStore.dailyForecastState.status === 'loading' && !analyticsStore.dailyForecast.dateKeys.length" class="analytics-card-state">
        <span class="analytics-spinner" aria-hidden="true" />
        <span>{{ $t('analytics.common.loading') }}</span>
      </div>
      <div v-else-if="analyticsStore.dailyForecastState.status === 'error' && !analyticsStore.dailyForecast.dateKeys.length" class="analytics-card-state">
        <span>{{ $t('analytics.daily_forecast.error') }}</span>
        <button type="button" class="analytics-button analytics-daily-forecast-retry" @click="analyticsStore.retryDailyForecast">{{ $t('analytics.common.retry') }}</button>
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
    </section>
  </analytics-page-layout>
</template>

<script setup>
import { parseISO } from 'date-fns'
import RouteConstants from '~/core/constants/RouteConstants.js'
import { useAnalyticsStore } from '~/core/stores/analyticsStore.js'
import { useProfileStore } from '~/core/stores/profileStore.js'

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const route = useRoute()
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

onMounted(() => analyticsStore.init())
</script>
