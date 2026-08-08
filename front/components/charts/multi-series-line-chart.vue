<template>
  <div ref="root" class="analytics-line-chart">
    <svg
      class="analytics-line-chart-svg"
      :viewBox="layout.viewBox"
      role="application"
      :aria-label="ariaLabel"
      tabindex="0"
      @pointermove="onPointerMove"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="onPointerLeave"
      @keydown="onKeydown"
    >
      <g aria-hidden="true">
        <template v-for="line in gridLines" :key="line.y">
          <line class="analytics-chart-grid" :x1="layout.gridX1" :x2="layout.gridX2" :y1="line.y" :y2="line.y" />
          <text class="analytics-chart-axis-label" :x="layout.yAxisLabelX" :y="line.y + 4" text-anchor="end" :style="{ fontSize: layout.axisFontSize + 'px' }">{{ line.label }}</text>
        </template>
        <text
          v-for="label in xAxisLabels"
          :key="label.key"
          class="analytics-chart-axis-label"
          :x="label.x"
          :y="layout.xAxisY"
          :text-anchor="label.anchor"
          :style="{ fontSize: layout.axisFontSize + 'px' }"
        >
          {{ label.label }}
        </text>
      </g>

      <template v-for="item in geometry.series" :key="item.id">
        <path
          v-for="(segment, segmentIndex) in item.segments"
          :key="item.id + segmentIndex"
          class="analytics-chart-line"
          :d="segment.path"
          fill="none"
          :stroke="item.color"
          :stroke-dasharray="segment.dashed ? '8 6' : null"
        />
        <path
          v-for="point in persistentLineChartPoints(item.points)"
          :key="item.id + point.key"
          class="analytics-chart-marker"
          :class="{
            'analytics-chart-marker-cross': item.marker === 'cross',
            'analytics-chart-marker-hollow': item.marker === 'hollow',
            'analytics-chart-marker-forecast': point.kind === 'forecast',
          }"
          :d="markerPath(item.marker, point.x, point.y, layout.markerSize)"
          :fill="markerFill(item, point)"
          :stroke="item.color"
          :stroke-dasharray="markerDash(point)"
        />
      </template>

      <g v-if="selectedIndex >= 0">
        <line class="analytics-chart-crosshair" :x1="selectedX" :x2="selectedX" :y1="layout.crosshairY1" :y2="layout.crosshairY2" />
        <path
          v-for="item in selectedValues"
          :key="item.seriesId"
          class="analytics-chart-marker analytics-chart-marker-selected"
          :class="{ 'analytics-chart-marker-cross': item.marker === 'cross', 'analytics-chart-marker-hollow': item.marker === 'hollow' }"
          :d="markerPath(item.marker, item.x, item.y, layout.selectedMarkerSize)"
          :fill="markerFill(item, item.point)"
          :stroke="item.color"
          :stroke-dasharray="markerDash(item.point)"
        />
      </g>
    </svg>

    <div v-if="selectedIndex >= 0" class="analytics-chart-tooltip" :class="{ right: tooltipOnRight, interactive: isPinned || isKeyboardSelection }">
      <div class="font-weight-600">{{ selectedXLabel }}</div>
      <button v-for="item in selectedValues" :key="item.seriesId" type="button" class="analytics-chart-tooltip-row" :tabindex="isPinned || isKeyboardSelection ? 0 : -1" @click="emitPoint(item)">
        <span class="analytics-chart-legend-marker" :class="'analytics-chart-legend-marker-' + item.marker" :style="{ backgroundColor: item.color }" />
        <span class="flex-1">{{ item.label }}</span>
        <span class="analytics-chart-tooltip-amount">{{ item.point.valueLabel }}</span>
        <span v-for="qualifier in pointQualifiers(item.point)" :key="qualifier" class="analytics-chart-tooltip-qualifier">{{ qualifier }}</span>
        <span v-if="item.point.secondaryLabel && item.point.secondaryValueLabel" class="analytics-chart-tooltip-qualifier">{{ item.point.secondaryLabel }}: {{ item.point.secondaryValueLabel }}</span>
      </button>
    </div>

    <div class="sr-only" aria-live="polite">{{ liveDescription }}</div>
  </div>
</template>

<script setup>
import { onClickOutside, useElementSize } from '@vueuse/core'
import { useAppStore } from '~/stores/appStore.js'
import {
  buildLineChartGeometry,
  buildLineChartLayout,
  buildLineChartLiveDescription,
  lineChartPointQualifierKeys,
  lineChartPointsAtX,
  nearestChartPointIndex,
  persistentLineChartPoints,
} from '~/utils/ChartUtils.js'

const GRID_LINE_COUNT = 5

const props = defineProps({
  series: {
    type: Array,
    default: () => [],
  },
  ariaLabel: {
    type: String,
    required: true,
  },
  valueFormatter: {
    type: Function,
    required: true,
  },
  pinned: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['select', 'select-point'])
const { t } = useI18n()
const appStore = useAppStore()
const root = ref(null)
const { width: renderedWidth } = useElementSize(root)
const selectedIndex = ref(-1)
const isPinned = ref(props.pinned)
const isKeyboardSelection = ref(false)
const isDragging = ref(false)
const pointerStartedOnPinnedIndex = ref(-1)

const visibleSeries = computed(() => props.series.filter((item) => item.visible !== false))
const layout = computed(() => buildLineChartLayout({ isDesktop: appStore.isDesktopLayout, renderedWidth: renderedWidth.value }))
const geometry = computed(() =>
  buildLineChartGeometry({
    series: visibleSeries.value,
    width: layout.value.width,
    height: layout.value.height,
    padding: layout.value.padding,
  }),
)
const pointCount = computed(() => geometry.value.xValues.length)
const selectedXValue = computed(() => geometry.value.xValues[selectedIndex.value])
const selectedX = computed(() => {
  if (selectedIndex.value < 0) return 0
  const innerWidth = layout.value.width - layout.value.padding.left - layout.value.padding.right
  return layout.value.padding.left + (selectedIndex.value / Math.max(1, pointCount.value - 1)) * innerWidth
})
const selectedXLabel = computed(() => {
  const key = selectedXValue.value
  if (key === undefined) return ''
  return geometry.value.series.flatMap((item) => item.points).find((point) => point.key === key)?.xLabel ?? ''
})
const selectedValues = computed(() => {
  const key = selectedXValue.value
  if (key === undefined) return []
  return lineChartPointsAtX(geometry.value.series, key).map(({ series: item, point }) => ({
    seriesId: item.id,
    label: item.label,
    color: item.color,
    marker: item.marker,
    x: point.x,
    y: point.y,
    point: { ...point, x: point.key },
  }))
})
const tooltipOnRight = computed(() => selectedIndex.value < pointCount.value / 2)
const gridLines = computed(() =>
  Array.from({ length: GRID_LINE_COUNT }, (_, index) => {
    const ratio = index / (GRID_LINE_COUNT - 1)
    return {
      y: layout.value.padding.top + ratio * (layout.value.height - layout.value.padding.top - layout.value.padding.bottom),
      label: props.valueFormatter(geometry.value.yMax - ratio * (geometry.value.yMax - geometry.value.yMin)),
    }
  }),
)
const xAxisLabels = computed(() => {
  if (pointCount.value === 0) return []
  const indices = [...new Set([0, Math.floor((pointCount.value - 1) / 2), pointCount.value - 1])]
  return indices.map((index) => {
    const key = geometry.value.xValues[index]
    const point = geometry.value.series.flatMap((item) => item.points).find((candidate) => candidate.key === key)
    return {
      key,
      x: layout.value.padding.left + (index / Math.max(1, pointCount.value - 1)) * (layout.value.width - layout.value.padding.left - layout.value.padding.right),
      label: point?.xLabel ?? '',
      anchor: index === 0 ? 'start' : index === pointCount.value - 1 ? 'end' : 'middle',
    }
  })
})
const qualifierLabels = computed(() => ({
  forecast: t('analytics.common.forecast'),
  partial: t('analytics.common.partial'),
  estimated_current_rates: t('analytics.common.estimated_current_rates'),
}))
const pointQualifiers = (point) => lineChartPointQualifierKeys(point).map((key) => qualifierLabels.value[key])
const liveDescription = computed(() =>
  selectedIndex.value < 0 ? '' : buildLineChartLiveDescription({ xLabel: selectedXLabel.value, values: selectedValues.value, qualifierLabels: qualifierLabels.value }),
)

const markerFill = (item, point) => (point.kind === 'forecast' || item.marker === 'hollow' ? 'var(--van-background-2)' : item.color)
const markerDash = (point) => (point.kind === 'forecast' ? '3 2' : null)
const markerPath = (marker, x, y, size) => {
  if (marker === 'square') return `M ${x - size} ${y - size} H ${x + size} V ${y + size} H ${x - size} Z`
  if (marker === 'diamond') return `M ${x} ${y - size} L ${x + size} ${y} L ${x} ${y + size} L ${x - size} ${y} Z`
  if (marker === 'triangle') return `M ${x} ${y - size} L ${x + size} ${y + size} L ${x - size} ${y + size} Z`
  if (marker === 'cross') return `M ${x - size} ${y} L ${x + size} ${y} M ${x} ${y - size} L ${x} ${y + size}`
  return `M ${x - size} ${y} A ${size} ${size} 0 1 0 ${x + size} ${y} A ${size} ${size} 0 1 0 ${x - size} ${y}`
}

const selectionPayload = () => ({
  index: selectedIndex.value,
  x: selectedXValue.value,
  xLabel: selectedXLabel.value,
  values: selectedValues.value.map(({ seriesId, label, point }) => ({ seriesId, label, point })),
})

const emitSelection = () => {
  if (selectedIndex.value >= 0) emit('select', selectionPayload())
}

const clearSelection = () => {
  selectedIndex.value = -1
  isPinned.value = false
  isKeyboardSelection.value = false
  isDragging.value = false
  pointerStartedOnPinnedIndex.value = -1
}

const selectIndex = (index, { keyboard = false, notify = false } = {}) => {
  if (pointCount.value === 0) return clearSelection()
  selectedIndex.value = Math.min(pointCount.value - 1, Math.max(0, index))
  isKeyboardSelection.value = keyboard
  if (notify) emitSelection()
}

const pointerIndex = (event) => {
  const bounds = root.value?.getBoundingClientRect()
  if (!bounds) return -1
  return nearestChartPointIndex({
    clientX: event.clientX,
    left: bounds.left,
    width: bounds.width,
    viewBoxWidth: layout.value.width,
    padding: layout.value.padding,
    pointCount: pointCount.value,
  })
}

const onPointerMove = (event) => {
  if (isPinned.value && !isDragging.value) return
  const index = pointerIndex(event)
  if (index >= 0) selectIndex(index)
}

const onPointerDown = (event) => {
  const index = pointerIndex(event)
  if (index < 0) return
  pointerStartedOnPinnedIndex.value = isPinned.value && selectedIndex.value === index ? index : -1
  isPinned.value = false
  isDragging.value = true
  selectIndex(index)
  if (event.pointerType === 'touch') event.currentTarget.setPointerCapture?.(event.pointerId)
}

const onPointerUp = (event) => {
  if (!isDragging.value) return
  const index = pointerIndex(event)
  if (index >= 0) selectIndex(index)
  isDragging.value = false
  if (pointerStartedOnPinnedIndex.value === selectedIndex.value) {
    pointerStartedOnPinnedIndex.value = -1
    return
  }
  pointerStartedOnPinnedIndex.value = -1
  isPinned.value = selectedIndex.value >= 0
  if (isPinned.value) emitSelection()
}

const onPointerCancel = () => clearSelection()

const onPointerLeave = () => {
  if (!isPinned.value && !isDragging.value) clearSelection()
}

const onKeydown = (event) => {
  if (pointCount.value === 0) return
  let index = selectedIndex.value
  if (event.key === 'ArrowLeft') index--
  else if (event.key === 'ArrowRight') index++
  else if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = pointCount.value - 1
  else if (event.key === 'Enter') {
    event.preventDefault()
    if (selectedIndex.value < 0) selectIndex(0, { keyboard: true })
    if (!isPinned.value) {
      isPinned.value = true
      emitSelection()
    }
    return
  } else if (event.key === 'Escape') {
    event.preventDefault()
    clearSelection()
    return
  } else return

  event.preventDefault()
  selectIndex(index, { keyboard: true, notify: true })
}

const emitPoint = (item) => {
  const transactionIds = [...new Set((item.point.transactionIds ?? []).filter(Boolean))]
  emit('select-point', {
    seriesId: item.seriesId,
    pointId: String(item.point.pointId ?? item.point.key ?? item.point.x),
    transactionIds,
    point: item.point,
    metadata: item.point,
  })
}

watch(pointCount, (count) => {
  if (count === 0) clearSelection()
  else if (selectedIndex.value >= count) selectedIndex.value = count - 1
})

onClickOutside(root, clearSelection)
</script>
