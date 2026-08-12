<template>
  <div class="analytics-daily-forecast-overview">
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

    <analytics-combination-chart
      :series="chartSeries"
      :value-formatter="formatCurrency"
      :aria-label="$t('analytics.daily_forecast.chart_label')"
      @select="$emit('select', $event)"
      @select-point="$emit('select-point', $event)"
    />
  </div>
</template>

<script setup>
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'

const props = defineProps({
  forecast: { type: Object, required: true },
  displayCurrencyCode: { type: String, required: true },
  displayCurrencyDecimalPlaces: { type: Number, default: 2 },
})
defineEmits(['select', 'select-point'])
const { t } = useI18n()

const formatCurrency = (value) => (Number.isFinite(value) ? `${formatNumberForDashboard(value)} ${props.displayCurrencyCode}` : '—')
const formatSignedCurrency = (value) => (Number.isFinite(value) ? `${value > 0 ? '+' : ''}${formatCurrency(value)}` : '—')
const knownComponentTotal = (components) => {
  const values = Object.values(components ?? {}).filter(Number.isFinite)
  return values.length ? Number(values.reduce((total, value) => total + value, 0).toFixed(props.displayCurrencyDecimalPlaces)) : null
}
const inflowSummaryValue = (field) =>
  Number.isFinite(props.forecast.summary.inflow[field]) ? props.forecast.summary.inflow[field] : knownComponentTotal(props.forecast.summary.inflow.components?.[field])
const summaryItems = computed(() => [
  { id: 'inflow', label: t('analytics.daily_forecast.expected_inflow'), value: inflowSummaryValue('final'), projected: inflowSummaryValue('projected') },
  { id: 'outflow', label: t('analytics.daily_forecast.expected_outflow'), value: props.forecast.summary.outflow.final, projected: props.forecast.summary.outflow.projected },
  { id: 'available', label: t('analytics.daily_forecast.available_change'), value: props.forecast.summary.availableChange.final, projected: props.forecast.summary.availableChange.projected },
])
const legendItems = computed(() => [
  { id: 'inflow', label: t('analytics.daily_forecast.inflow'), color: 'var(--income2)' },
  { id: 'outflow', label: t('analytics.daily_forecast.outflow'), color: 'var(--expense2)' },
  { id: 'available', label: t('analytics.daily_forecast.available_change'), color: 'var(--transfer2)' },
])
const chartSeries = computed(() => ({
  ...props.forecast,
  barGroups: props.forecast.barGroups.map((group) => ({
    ...group,
    label: t(group.labelKey),
    color: group.direction === 'sources' ? 'var(--income2)' : 'var(--expense2)',
    points: group.points.map((point) => ({ ...point, label: t(group.labelKey) })),
  })),
  availableLine: { ...props.forecast.availableLine, label: t(props.forecast.availableLine.labelKey), color: 'var(--transfer2)' },
}))
</script>
