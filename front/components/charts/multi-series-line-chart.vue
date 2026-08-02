<template>
  <div ref="root" class="analytics-line-chart">
    <svg
      class="analytics-line-chart-svg"
      viewBox="0 0 1000 320"
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
          <line class="analytics-chart-grid" x1="88" x2="976" :y1="line.y" :y2="line.y" />
          <text class="analytics-chart-axis-label" x="80" :y="line.y + 4" text-anchor="end">{{ line.label }}</text>
        </template>
        <text v-for="label in xAxisLabels" :key="label.key" class="analytics-chart-axis-label" :x="label.x" y="310" :text-anchor="label.anchor">{{ label.label }}</text>
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
          v-for="point in persistentPoints(item)"
          :key="item.id + point.key"
          class="analytics-chart-marker"
          :class="{
            'analytics-chart-marker-cross': item.marker === 'cross',
            'analytics-chart-marker-hollow': item.marker === 'hollow',
            'analytics-chart-marker-forecast': point.kind === 'forecast',
          }"
          :d="markerPath(item.marker, point.x, point.y, 7)"
          :fill="markerFill(item, point)"
          :stroke="item.color"
          :stroke-dasharray="markerDash(point)"
        />
      </template>

      <g v-if="selectedIndex >= 0">
        <line class="analytics-chart-crosshair" :x1="selectedX" :x2="selectedX" y1="16" y2="282" />
        <path
          v-for="item in selectedValues"
          :key="item.seriesId"
          class="analytics-chart-marker analytics-chart-marker-selected"
          :class="{ 'analytics-chart-marker-cross': item.marker === 'cross', 'analytics-chart-marker-hollow': item.marker === 'hollow' }"
          :d="markerPath(item.marker, item.x, item.y, 10)"
          :fill="markerFill(item, item.point)"
          :stroke="item.color"
          :stroke-dasharray="markerDash(item.point)"
        />
      </g>
    </svg>

    <div v-if="selectedIndex >= 0" class="analytics-chart-tooltip" :class="{ right: tooltipOnRight, interactive: isPinned || isKeyboardSelection }">
      <div class="font-weight-600">{{ selectedXLabel }}</div>
      <button v-for="item in selectedValues" :key="item.seriesId" type="button" class="analytics-chart-tooltip-row" :tabindex="isPinned || isKeyboardSelection ? 0 : -1" @click="emitPoint(item)">
        <span class="analytics-chart-legend-marker" :style="{ backgroundColor: item.color }" />
        <span class="flex-1">{{ item.label }}</span>
        <span>{{ item.point.valueLabel }}</span>
        <span v-if="item.point.kind === 'forecast'">{{ $t('analytics.common.forecast') }}</span>
        <span v-if="item.point.isEstimated">{{ $t('analytics.common.estimated_current_rates') }}</span>
      </button>
    </div>

    <div class="sr-only" aria-live="polite">{{ liveDescription }}</div>
  </div>
</template>

<script setup>
import { onClickOutside } from '@vueuse/core'
import { buildLineChartGeometry, nearestChartPointIndex } from '~/utils/ChartUtils.js'

const CHART_WIDTH = 1000
const CHART_HEIGHT = 320
const CHART_PADDING = { top: 16, right: 24, bottom: 38, left: 88 }
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
const root = ref(null)
const selectedIndex = ref(-1)
const isPinned = ref(props.pinned)
const isKeyboardSelection = ref(false)
const isDragging = ref(false)
const pointerStartedOnPinnedIndex = ref(-1)

const visibleSeries = computed(() => props.series.filter((item) => item.visible !== false))
const geometry = computed(() =>
  buildLineChartGeometry({
    series: visibleSeries.value,
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    padding: CHART_PADDING,
  }),
)
const pointCount = computed(() => geometry.value.xValues.length)
const selectedXValue = computed(() => geometry.value.xValues[selectedIndex.value])
const selectedX = computed(() => {
  if (selectedIndex.value < 0) return 0
  const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right
  return CHART_PADDING.left + (selectedIndex.value / Math.max(1, pointCount.value - 1)) * innerWidth
})
const selectedXLabel = computed(() => {
  const key = selectedXValue.value
  if (key === undefined) return ''
  return geometry.value.series.flatMap((item) => item.points).find((point) => point.key === key)?.xLabel ?? ''
})
const selectedValues = computed(() => {
  const key = selectedXValue.value
  if (key === undefined) return []
  return geometry.value.series.flatMap((item) => {
    const point = item.points.find((candidate) => candidate.key === key && candidate.y !== null)
    if (!point) return []
    return [
      {
        seriesId: item.id,
        label: item.label,
        color: item.color,
        marker: item.marker,
        x: point.x,
        y: point.y,
        point: { ...point, x: point.key },
      },
    ]
  })
})
const tooltipOnRight = computed(() => selectedIndex.value < pointCount.value / 2)
const gridLines = computed(() =>
  Array.from({ length: GRID_LINE_COUNT }, (_, index) => {
    const ratio = index / (GRID_LINE_COUNT - 1)
    return {
      y: CHART_PADDING.top + ratio * (CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom),
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
      x: CHART_PADDING.left + (index / Math.max(1, pointCount.value - 1)) * (CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right),
      label: point?.xLabel ?? '',
      anchor: index === 0 ? 'start' : index === pointCount.value - 1 ? 'end' : 'middle',
    }
  })
})
const liveDescription = computed(() => {
  if (selectedIndex.value < 0) return ''
  const values = selectedValues.value.map((item) => {
    const qualifiers = [item.point.kind === 'forecast' ? t('analytics.common.forecast') : null, item.point.isEstimated ? t('analytics.common.estimated_current_rates') : null].filter(Boolean)
    return [item.label, item.point.valueLabel, ...qualifiers].filter(Boolean).join(', ')
  })
  return [selectedXLabel.value, ...values].filter(Boolean).join('. ')
})

const persistentPoints = (item) => {
  const points = item.points.filter((point) => point.y !== null)
  if (points.length <= 12) return points
  const step = Math.ceil(points.length / 12)
  let lastActualIndex = -1
  points.forEach((point, index) => {
    if (point.kind !== 'forecast') lastActualIndex = index
  })
  return points.filter((point, index) => index % step === 0 || index === points.length - 1 || index === lastActualIndex || point.kind === 'forecast')
}
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
    viewBoxWidth: CHART_WIDTH,
    padding: CHART_PADDING,
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

const emitPoint = (item) => emit('select-point', { seriesId: item.seriesId, point: item.point })

watch(pointCount, (count) => {
  if (count === 0) clearSelection()
  else if (selectedIndex.value >= count) selectedIndex.value = count - 1
})

onClickOutside(root, clearSelection)
</script>
