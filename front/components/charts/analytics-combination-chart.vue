<template>
  <div ref="root" class="analytics-line-chart analytics-combination-chart">
    <svg
      class="analytics-line-chart-svg analytics-combination-chart-svg"
      :viewBox="layout.viewBox"
      role="application"
      :aria-label="ariaLabel"
      tabindex="0"
      @pointermove="onPointerMove"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="clearSelection"
      @pointerleave="onPointerLeave"
      @keydown="onKeydown"
    >
      <defs>
        <pattern id="analytics-combination-forecast" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" stroke-width="2" opacity="0.45" />
        </pattern>
        <pattern id="analytics-combination-refund" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" stroke="currentColor" stroke-width="2" opacity="0.58" />
        </pattern>
        <pattern id="analytics-combination-accessible-savings" width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.5" fill="currentColor" opacity="0.55" />
        </pattern>
        <pattern id="analytics-combination-restricted-savings" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M 0 4 H 8 M 4 0 V 8" stroke="currentColor" stroke-width="1.25" opacity="0.5" />
        </pattern>
        <pattern id="analytics-combination-debt" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M 0 0 L 8 8 M 8 0 L 0 8" stroke="currentColor" stroke-width="1" opacity="0.5" />
        </pattern>
        <pattern id="analytics-combination-gap-positive" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M 0 8 L 8 0" stroke="var(--income2)" stroke-width="2" opacity="0.5" />
        </pattern>
        <pattern id="analytics-combination-gap-negative" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M 0 0 L 8 8" stroke="var(--expense2)" stroke-width="2" opacity="0.55" />
        </pattern>
      </defs>

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

      <g aria-hidden="true">
        <template v-for="layer in renderedUseLayers" :key="layer.id">
          <path v-for="(path, index) in layer.paths" :key="`${layer.id}:${index}`" :d="path.d" :fill="areaFill(layer, path)" :style="{ color: layer.color }" opacity="0.72" />
          <path v-for="(path, index) in layer.refundPaths" :key="`${layer.id}:refund:${index}`" :d="path.d" fill="url(#analytics-combination-refund)" :style="{ color: layer.color }" opacity="0.9" />
        </template>
        <template v-for="band in renderedSourceBands" :key="band.id">
          <path v-for="(path, index) in band.paths" :key="`${band.id}:${index}`" :d="path.d" :fill="areaFill(band, path)" :style="{ color: band.color }" opacity="0.55" />
        </template>
        <path v-for="(path, index) in renderedPositiveGap" :key="`positive-gap:${index}`" :d="path.d" fill="url(#analytics-combination-gap-positive)" />
        <path v-for="(path, index) in renderedNegativeGap" :key="`negative-gap:${index}`" :d="path.d" fill="url(#analytics-combination-gap-negative)" />
        <path
          v-for="(path, index) in ordinaryIncomePaths"
          :key="`income:${index}`"
          :d="path.d"
          fill="none"
          :stroke="ordinaryIncome.color"
          stroke-width="2.5"
          :stroke-dasharray="path.forecast ? '8 6' : null"
        />
        <path
          v-for="(path, index) in totalSourcePaths"
          :key="`sources:${index}`"
          :d="path.d"
          fill="none"
          :stroke="totalSources.color"
          stroke-width="1.5"
          :stroke-dasharray="path.forecast ? '5 4' : '2 3'"
        />
      </g>

      <rect v-for="(key, index) in xValues" :key="`hit:${key}`" :x="hitAreaX(index)" :y="layout.padding.top" :width="hitAreaWidth" :height="innerHeight" fill="transparent" pointer-events="all" />

      <g v-if="selectedIndex >= 0" aria-hidden="true">
        <line class="analytics-chart-crosshair" :x1="selectedX" :x2="selectedX" :y1="layout.crosshairY1" :y2="layout.crosshairY2" />
        <circle
          v-for="selectedRow in selectedRows.filter(({ y }) => Number.isFinite(y))"
          :key="selectedRow.seriesId"
          :cx="selectedX"
          :cy="selectedRow.y"
          r="5"
          :fill="selectedRow.color"
          stroke="var(--van-background-2)"
          stroke-width="2"
        />
      </g>
    </svg>

    <div v-if="selectedIndex >= 0" class="analytics-chart-tooltip" :class="{ right: tooltipOnRight, interactive: isPinned || isKeyboardSelection }">
      <div class="font-weight-600">{{ selectedXLabel }}</div>
      <button
        v-for="selectedRow in selectedRows"
        :key="selectedRow.seriesId"
        type="button"
        class="analytics-chart-tooltip-row"
        :style="{ minHeight: '44px' }"
        :tabindex="isPinned || isKeyboardSelection ? 0 : -1"
        @click="emitRow(selectedRow, $event.detail === 0 ? 'keyboard' : 'pointer')"
      >
        <span class="analytics-chart-legend-marker" :style="{ backgroundColor: selectedRow.color }" />
        <span class="flex-1">{{ selectedRow.label }}</span>
        <span class="analytics-chart-tooltip-amount">{{ selectedRow.point.valueLabel }}</span>
        <span v-if="selectedRow.point.kind === 'forecast'" class="analytics-chart-tooltip-qualifier">{{ $t('analytics.common.forecast') }}</span>
        <span v-if="Number.isFinite(selectedRow.point.actualValue) && selectedRow.point.kind === 'forecast'" class="analytics-chart-tooltip-qualifier">
          {{ $t('analytics.cash_use.actual_to_date') }}: {{ valueFormatter(selectedRow.point.actualValue) }}
        </span>
        <span v-if="Number.isFinite(selectedRow.point.projectedValue) && selectedRow.point.kind === 'forecast'" class="analytics-chart-tooltip-qualifier">
          {{ $t('analytics.cash_use.projected_remaining') }}: {{ valueFormatter(selectedRow.point.projectedValue) }}
        </span>
        <span v-if="Number.isFinite(selectedRow.point.progress) && selectedRow.point.kind === 'forecast'" class="analytics-chart-tooltip-qualifier">
          {{ $t('analytics.cash_use.progress') }}: {{ Math.round(selectedRow.point.progress * 100) }}%
        </span>
        <span v-if="selectedRow.point.status === 'partial'" class="analytics-chart-tooltip-qualifier">{{ $t('analytics.common.partial') }}</span>
        <span v-if="Number.isFinite(selectedRow.point.refundCoverage?.totalRefunded ?? selectedRow.point.refundCoverage?.refunded)" class="analytics-chart-tooltip-qualifier">
          {{ $t('analytics.cash_use.refund_coverage') }}: {{ valueFormatter(selectedRow.point.refundCoverage.totalRefunded ?? selectedRow.point.refundCoverage.refunded) }}
        </span>
      </button>
    </div>

    <div class="sr-only" aria-live="polite">{{ liveDescription }}</div>
  </div>
</template>

<script setup>
import { onClickOutside, useElementSize } from '@vueuse/core'
import { useAppStore } from '~/stores/appStore.js'
import { buildCombinationAreaGeometry } from '~/utils/AnalyticsCashUseUtils.js'
import { buildLineChartLayout, buildLineChartSelectionPayload, nearestChartPointIndex } from '~/utils/ChartUtils.js'

const GRID_LINE_COUNT = 5

const props = defineProps({
  series: { type: Object, required: true },
  ariaLabel: { type: String, required: true },
  valueFormatter: { type: Function, required: true },
  pinned: { type: Boolean, default: false },
})

const emit = defineEmits(['select', 'select-point'])
const appStore = useAppStore()
const root = ref(null)
const { width: renderedWidth } = useElementSize(root)
const selectedIndex = ref(-1)
const isPinned = ref(props.pinned)
const isKeyboardSelection = ref(false)
const isDragging = ref(false)
const pointerStartedOnPinnedIndex = ref(-1)

const layout = computed(() => buildLineChartLayout({ isDesktop: appStore.isDesktopLayout, renderedWidth: renderedWidth.value }))
const xValues = computed(() => props.series.monthKeys ?? [])
const pointCount = computed(() => xValues.value.length)
const innerWidth = computed(() => layout.value.width - layout.value.padding.left - layout.value.padding.right)
const innerHeight = computed(() => layout.value.height - layout.value.padding.top - layout.value.padding.bottom)
const xAt = (index) => layout.value.padding.left + (index / Math.max(1, pointCount.value - 1)) * innerWidth.value
const yMax = computed(() => {
  const values = [
    ...(props.series.useLayers ?? []).flatMap(({ points }) => points.flatMap(({ top }) => (Number.isFinite(top) ? [top] : []))),
    ...(props.series.sourceBands ?? []).flatMap(({ points }) => points.flatMap(({ top }) => (Number.isFinite(top) ? [top] : []))),
    ...(props.series.gap?.points ?? []).flatMap(({ top }) => (Number.isFinite(top) ? [top] : [])),
    ...(props.series.ordinaryIncome?.points ?? []).flatMap(({ value }) => (Number.isFinite(value) ? [value] : [])),
    ...(props.series.totalSources?.points ?? []).flatMap(({ value }) => (Number.isFinite(value) ? [value] : [])),
  ]
  return Math.max(1, ...values)
})
const yAt = (value) => layout.value.padding.top + ((yMax.value - value) / yMax.value) * innerHeight.value
const pointAt = (points, key) => points.find((point) => point.x === key)
const xLabelAt = (key) => pointAt(props.series.ordinaryIncome?.points ?? [], key)?.xLabel ?? (key.endsWith(':forecast') ? key.slice(0, 7) : key)

const areaPaths = (points, predicate = () => true) =>
  buildCombinationAreaGeometry({ points, xValues: xValues.value, xAt, yAt, predicate, isolatedWidth: Math.max(12, Math.min(24, innerWidth.value / Math.max(2, pointCount.value * 2))) })
const linePaths = (points) => {
  const paths = []
  let previous = null
  xValues.value.forEach((key, index) => {
    const point = pointAt(points, key)
    if (!Number.isFinite(point?.value)) {
      previous = null
      return
    }
    if (previous) paths.push({ d: `M ${xAt(previous.index)} ${yAt(previous.point.value)} L ${xAt(index)} ${yAt(point.value)}`, forecast: point.kind === 'forecast' })
    previous = { index, point }
  })
  return paths
}

const refundCoveragePoints = (points) =>
  points.map((point) => ({
    ...point,
    bottom:
      Number.isFinite(point.bottom) && Number.isFinite(point.top) && Number.isFinite(point.refundCoverage?.totalRefunded ?? point.refundCoverage?.refunded)
        ? Math.max(point.bottom, point.top - Math.max(0, point.refundCoverage.totalRefunded ?? point.refundCoverage.refunded))
        : null,
  }))
const renderedUseLayers = computed(() =>
  (props.series.useLayers ?? []).map((layer) => ({
    ...layer,
    paths: areaPaths(layer.points),
    refundPaths: areaPaths(refundCoveragePoints(layer.points), ({ refundCoverage }) => (refundCoverage?.totalRefunded ?? refundCoverage?.refunded) > 0),
  })),
)
const renderedSourceBands = computed(() => (props.series.sourceBands ?? []).map((layer) => ({ ...layer, paths: areaPaths(layer.points) })))
const renderedPositiveGap = computed(() => areaPaths(props.series.gap?.points ?? [], ({ direction }) => direction === 'positive'))
const renderedNegativeGap = computed(() => areaPaths(props.series.gap?.points ?? [], ({ direction }) => direction === 'negative'))
const ordinaryIncome = computed(() => props.series.ordinaryIncome ?? { points: [], color: 'var(--income2)' })
const totalSources = computed(() => props.series.totalSources ?? { points: [], color: 'var(--van-text-color-2)' })
const ordinaryIncomePaths = computed(() => linePaths(ordinaryIncome.value.points))
const totalSourcePaths = computed(() => linePaths(totalSources.value.points))
const areaFill = (item, path) => {
  if (path.forecast) return 'url(#analytics-combination-forecast)'
  if (item.pattern === 'refund') return 'url(#analytics-combination-refund)'
  if (item.pattern === 'accessible-savings') return 'url(#analytics-combination-accessible-savings)'
  if (item.pattern === 'restricted-savings') return 'url(#analytics-combination-restricted-savings)'
  if (item.pattern === 'debt') return 'url(#analytics-combination-debt)'
  return item.color
}
const selectedXValue = computed(() => xValues.value[selectedIndex.value])
const selectedX = computed(() => (selectedIndex.value < 0 ? 0 : xAt(selectedIndex.value)))
const selectedXLabel = computed(() => (selectedXValue.value ? xLabelAt(selectedXValue.value) : ''))
const tooltipOnRight = computed(() => selectedIndex.value < pointCount.value / 2)

const row = ({ seriesId, label, color, point, value = point?.value, yValue = value }) => ({
  seriesId,
  label,
  color,
  y: Number.isFinite(yValue) ? yAt(yValue) : null,
  point: { ...point, value, valueLabel: Number.isFinite(value) ? props.valueFormatter(value) : '—' },
})
const selectedRows = computed(() => {
  const key = selectedXValue.value
  if (!key) return []
  const uses = (props.series.useLayers ?? []).map((layer) => {
    const point = pointAt(layer.points, key)
    return row({ seriesId: layer.id, label: point?.label ?? layer.label ?? layer.id, color: layer.color, point, yValue: point?.top })
  })
  const incomePoint = pointAt(ordinaryIncome.value.points, key)
  const sources = (props.series.sourceBands ?? []).map((band) => {
    const point = pointAt(band.points, key)
    return row({ seriesId: band.id, label: point?.label ?? band.label ?? band.id, color: band.color, point, yValue: point?.top })
  })
  const totals = pointAt(props.series.totals?.points ?? [], key)
  const gapPoint = pointAt(props.series.gap?.points ?? [], key)
  return [
    ...uses,
    row({ seriesId: ordinaryIncome.value.id, label: ordinaryIncome.value.label ?? ordinaryIncome.value.id, color: ordinaryIncome.value.color, point: incomePoint }),
    ...sources,
    row({
      seriesId: 'total-uses',
      label: props.series.totalUsesLabel,
      color: 'var(--expense2)',
      point: { ...totals, value: totals?.uses, transactionIds: uses.flatMap(({ point }) => point.transactionIds), projectedSources: uses.flatMap(({ point }) => point.projectedSources) },
    }),
    row({
      seriesId: 'total-sources',
      label: totalSources.value.label ?? totalSources.value.id,
      color: totalSources.value.color,
      point: {
        ...totals,
        value: totals?.sources,
        transactionIds: [incomePoint, ...sources.map(({ point }) => point)].flatMap((point) => point?.transactionIds ?? []),
        projectedSources: [incomePoint, ...sources.map(({ point }) => point)].flatMap((point) => point?.projectedSources ?? []),
      },
    }),
    row({
      seriesId: 'gap',
      label: gapPoint?.label ?? props.series.gap?.label ?? props.series.gap?.id,
      color: gapPoint?.direction === 'negative' ? 'var(--expense2)' : 'var(--income2)',
      point: gapPoint,
      yValue: gapPoint?.top,
    }),
  ]
})

const gridLines = computed(() =>
  Array.from({ length: GRID_LINE_COUNT }, (_, index) => {
    const ratio = index / (GRID_LINE_COUNT - 1)
    return { y: layout.value.padding.top + ratio * innerHeight.value, label: props.valueFormatter(yMax.value * (1 - ratio)) }
  }),
)
const xAxisLabels = computed(() => {
  if (pointCount.value === 0) return []
  return [...new Set([0, Math.floor((pointCount.value - 1) / 2), pointCount.value - 1])].map((index) => ({
    key: xValues.value[index],
    x: xAt(index),
    label: xLabelAt(xValues.value[index]),
    anchor: index === 0 ? 'start' : index === pointCount.value - 1 ? 'end' : 'middle',
  }))
})
const hitAreaWidth = computed(() => Math.max(44, innerWidth.value / Math.max(1, pointCount.value)))
const hitAreaX = (index) => Math.max(layout.value.padding.left, Math.min(layout.value.width - layout.value.padding.right - hitAreaWidth.value, xAt(index) - hitAreaWidth.value / 2))
const liveDescription = computed(() => (selectedIndex.value < 0 ? '' : [selectedXLabel.value, ...selectedRows.value.map(({ label, point }) => `${label}: ${point.valueLabel}`)].join('. ')))

const selectionPayload = () => ({
  index: selectedIndex.value,
  x: selectedXValue.value,
  xLabel: selectedXLabel.value,
  values: selectedRows.value.map(({ seriesId, label, point }) => ({ seriesId, label, point })),
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
  return nearestChartPointIndex({ clientX: event.clientX, left: bounds.left, width: bounds.width, viewBoxWidth: layout.value.width, padding: layout.value.padding, pointCount: pointCount.value })
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
  if (pointerStartedOnPinnedIndex.value === selectedIndex.value) return (pointerStartedOnPinnedIndex.value = -1)
  pointerStartedOnPinnedIndex.value = -1
  isPinned.value = selectedIndex.value >= 0
  if (isPinned.value) emitSelection()
}
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
    isPinned.value = true
    return emitSelection()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    return clearSelection()
  } else return
  event.preventDefault()
  selectIndex(index, { keyboard: true, notify: true })
}
const emitRow = (item, activation) => emit('select-point', buildLineChartSelectionPayload({ seriesId: item.seriesId, point: item.point, activation }))

watch(pointCount, (count) => {
  if (count === 0) clearSelection()
  else if (selectedIndex.value >= count) selectedIndex.value = count - 1
})
onClickOutside(root, clearSelection)
</script>
