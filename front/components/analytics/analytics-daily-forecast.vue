<template>
  <van-cell-group inset class="analytics-card analytics-daily-forecast-card analytics-daily-forecast-card-compact">
    <div class="van-cell-group-title analytics-card-title">
      <div class="flex-1">
        <div class="flex-center-vertical gap-2">
          <span>{{ $t('analytics.daily_forecast.title') }}</span>
          <span v-if="dailyState.isPartiallyUnavailable" class="analytics-daily-forecast-partial-badge">{{ $t('analytics.common.partial') }}</span>
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
      <van-button class="analytics-daily-forecast-retry" size="small" @click="analyticsStore.retryDailyForecast">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <div v-else-if="dailyState.isBlockingUnavailable" class="analytics-warning" role="alert">
      <div>{{ $t('analytics.daily_forecast.unavailable') }}</div>
      <div v-if="unavailableEvidenceSummary.count">{{ $t('analytics.common.unavailable_evidence_count', { count: unavailableEvidenceSummary.count }) }}</div>
    </div>
    <template v-else>
      <div v-if="dailyState.isPartiallyUnavailable" class="analytics-daily-forecast-partial-note" role="status">
        {{ $t('analytics.daily_forecast.inputs_need_review', { count: unavailableEvidenceSummary.count }) }}
      </div>
      <analytics-daily-forecast-overview
        :forecast="daily"
        :display-currency-code="analyticsStore.displayCurrencyCode"
        :display-currency-decimal-places="analyticsStore.displayCurrencyDecimalPlaces"
        @select="openSelection"
        @select-point="openPoint"
      />
      <div v-if="!hasActivity" class="analytics-card-state">{{ $t('analytics.daily_forecast.empty') }}</div>
      <van-button block class="analytics-daily-forecast-open" @click="openFullForecast()">{{ $t('analytics.daily_forecast.open_full_forecast') }}</van-button>
    </template>
  </van-cell-group>
</template>

<script setup>
import { parseISO } from 'date-fns'
import RouteConstants from '~/constants/RouteConstants.js'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { useProfileStore } from '~/stores/profileStore.js'

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const { t } = useI18n()
const daily = computed(() => analyticsStore.dailyForecast)
const dailyState = computed(() => analyticsStore.dailyForecastState)
const periodItems = computed(() => [3, 6, 12].map((value) => ({ label: t('analytics.period.months_short', { count: value }), value })))
const monthTitle = computed(() => new Intl.DateTimeFormat(profileStore.language, { month: 'long', year: 'numeric' }).format(parseISO(`${daily.value.monthKey}-01`)))
const hasActivity = computed(() => daily.value.barGroups.some(({ points }) => points.some(({ value }) => Number.isFinite(value) && value !== 0)))
const hasRetainedData = computed(() => dailyState.value.isStale && daily.value.dateKeys.length > 0)
const unavailableEvidenceSummary = computed(() => dailyState.value.unavailableEvidenceSummary ?? { count: 0 })
const dateFromSelection = (payload) => payload?.x ?? payload?.values?.find(({ point }) => point?.x)?.point?.x ?? null
const openFullForecast = (date = null) => navigateTo({ path: RouteConstants.ROUTE_ANALYTICS_DAILY_FORECAST, ...(date ? { query: { date } } : {}) })
const openSelection = (payload) => {
  const date = dateFromSelection(payload)
  if (date) openFullForecast(date)
}
const openPoint = ({ point }) => openFullForecast(point?.x ?? null)
</script>
