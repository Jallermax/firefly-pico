<template>
  <div ref="root" class="analytics-line-chart analytics-combination-chart" @keydown="onRootKeydown">
    <svg
      class="analytics-line-chart-svg analytics-combination-chart-svg"
      :viewBox="layout.viewBox"
      role="application"
      :aria-label="ariaLabel"
      tabindex="0"
      @pointermove="onPointerMove"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="applyInteraction({ type: 'pointerCancel' })"
      @pointerleave="onPointerLeave"
      @keydown="onChartKeydown"
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
        <pattern id="analytics-combination-defined" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" stroke="currentColor" stroke-width="2" opacity="0.7" />
        </pattern>
        <pattern id="analytics-combination-inferred" width="7" height="7" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.4" fill="currentColor" opacity="0.7" />
        </pattern>
        <pattern id="analytics-combination-variable" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M 0 4 H 8" stroke="currentColor" stroke-width="1.5" opacity="0.65" />
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

      <line
        v-if="todayX !== null"
        class="analytics-combination-today-marker"
        :x1="todayX"
        :x2="todayX"
        :y1="layout.crosshairY1"
        :y2="layout.crosshairY2"
        stroke="var(--transfer2)"
        stroke-width="1.5"
        stroke-dasharray="3 3"
        aria-hidden="true"
      />

      <g aria-hidden="true">
        <rect
          v-for="bar in renderedBars"
          :key="bar.key"
          :x="bar.x"
          :y="bar.y"
          :width="bar.width"
          :height="bar.height"
          :fill="bar.fill"
          :style="{ color: bar.color }"
          :opacity="bar.sourceKind === 'actual' ? 0.86 : 0.78"
          rx="1"
        />
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
        <path
          v-for="(path, index) in availableLinePaths"
          :key="`available:${index}`"
          :d="path.d"
          fill="none"
          :stroke="availableLine.color"
          stroke-width="2.5"
          :stroke-dasharray="path.forecast ? '7 5' : null"
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
        <span v-if="selectedRow.point.sourceKind && selectedRow.point.sourceKind !== 'actual'" class="analytics-chart-tooltip-qualifier">{{ selectedRow.label }}</span>
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
import { buildCombinationAreaGeometry, reduceCombinationChartInteraction } from '~/utils/AnalyticsCashUseUtils.js'
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
const interaction = ref({ selectedIndex: -1, isPinned: props.pinned, isKeyboardSelection: false, isDragging: false, pointerStartedOnPinnedIndex: -1, effect: null })
const selectedIndex = computed(() => interaction.value.selectedIndex)
const isPinned = computed(() => interaction.value.isPinned)
const isKeyboardSelection = computed(() => interaction.value.isKeyboardSelection)

const layout = computed(() => buildLineChartLayout({ isDesktop: appStore.isDesktopLayout, renderedWidth: renderedWidth.value }))
const xValues = computed(() => props.series.dateKeys ?? props.series.monthKeys ?? [])
const pointCount = computed(() => xValues.value.length)
const innerWidth = computed(() => layout.value.width - layout.value.padding.left - layout.value.padding.right)
const innerHeight = computed(() => layout.value.height - layout.value.padding.top - layout.value.padding.bottom)
const xAt = (index) => layout.value.padding.left + (index / Math.max(1, pointCount.value - 1)) * innerWidth.value
const yValues = computed(() => {
  const values = [
    ...(props.series.useLayers ?? []).flatMap(({ points }) => points.flatMap(({ top }) => (Number.isFinite(top) ? [top] : []))),
    ...(props.series.sourceBands ?? []).flatMap(({ points }) => points.flatMap(({ top }) => (Number.isFinite(top) ? [top] : []))),
    ...(props.series.gap?.points ?? []).flatMap(({ top }) => (Number.isFinite(top) ? [top] : [])),
    ...(props.series.ordinaryIncome?.points ?? []).flatMap(({ value }) => (Number.isFinite(value) ? [value] : [])),
    ...(props.series.totalSources?.points ?? []).flatMap(({ value }) => (Number.isFinite(value) ? [value] : [])),
    ...(props.series.barGroups ?? []).flatMap(({ points }) => points.flatMap(({ value }) => (Number.isFinite(value) ? [value] : []))),
    ...(props.series.availableLine?.points ?? []).flatMap(({ value }) => (Number.isFinite(value) ? [value] : [])),
  ]
  return values
})
const yMax = computed(() => Math.max(1, ...yValues.value))
const yMin = computed(() => Math.min(0, ...yValues.value))
const yRange = computed(() => Math.max(1, yMax.value - yMin.value))
const yAt = (value) => layout.value.padding.top + ((yMax.value - value) / yRange.value) * innerHeight.value
const pointAt = (points, key) => points.find((point) => point.x === key)
const xLabelAt = (key) =>
  pointAt(props.series.ordinaryIncome?.points ?? [], key)?.xLabel ??
  pointAt(props.series.availableLine?.points ?? [], key)?.xLabel ??
  pointAt(props.series.barGroups?.[0]?.points ?? [], key)?.xLabel ??
  (key.endsWith(':forecast') ? key.slice(0, 7) : key)

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
const totalUses = computed(() => props.series.totalUses ?? { points: [] })
const totalSources = computed(() => props.series.totalSources ?? { points: [], color: 'var(--van-text-color-2)' })
const ordinaryIncomePaths = computed(() => linePaths(ordinaryIncome.value.points))
const totalSourcePaths = computed(() => linePaths(totalSources.value.points))
const availableLine = computed(() => props.series.availableLine ?? { points: [], color: 'var(--van-text-color)' })
const availableLinePaths = computed(() => {
  const paths = linePaths(availableLine.value.points)
  const firstPoint = availableLine.value.points.find(({ value }) => Number.isFinite(value))
  if (!firstPoint || !Number.isFinite(availableLine.value.openingValue)) return paths
  const firstIndex = xValues.value.indexOf(firstPoint.x)
  if (firstIndex < 0) return paths
  const step = pointCount.value > 1 ? innerWidth.value / (pointCount.value - 1) : innerWidth.value
  const openingX = Math.max(4, xAt(firstIndex) - Math.min(20, step * 0.65))
  return [{ d: `M ${openingX} ${yAt(availableLine.value.openingValue)} L ${xAt(firstIndex)} ${yAt(firstPoint.value)}`, forecast: firstPoint.kind === 'forecast' }, ...paths]
})
const barSourceKinds = computed(() => [...new Set((props.series.barGroups ?? []).map(({ sourceKind }) => sourceKind))])
const barSpacing = computed(() => (pointCount.value > 1 ? innerWidth.value / (pointCount.value - 1) : innerWidth.value))
const barWidth = computed(() => Math.max(2, Math.min(10, (barSpacing.value * 0.78) / Math.max(1, barSourceKinds.value.length))))
const barFill = (group) => {
  if (group.sourceKind === 'defined') return 'url(#analytics-combination-defined)'
  if (group.sourceKind === 'inferred') return 'url(#analytics-combination-inferred)'
  if (group.sourceKind === 'variable') return 'url(#analytics-combination-variable)'
  return group.color
}
const renderedBars = computed(() =>
  (props.series.barGroups ?? []).flatMap((group) => {
    const sourceIndex = barSourceKinds.value.indexOf(group.sourceKind)
    const groupWidth = barWidth.value * barSourceKinds.value.length
    return group.points.flatMap((point, index) => {
      if (!Number.isFinite(point.value) || point.value === 0) return []
      const valueY = yAt(point.value)
      const zeroY = yAt(0)
      return [
        {
          key: `${group.id}:${point.x}`,
          sourceKind: group.sourceKind,
          x: xAt(index) - groupWidth / 2 + sourceIndex * barWidth.value,
          y: Math.min(valueY, zeroY),
          width: barWidth.value,
          height: Math.max(1, Math.abs(zeroY - valueY)),
          fill: barFill(group),
          color: group.color,
        },
      ]
    })
  }),
)
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
const todayX = computed(() => (Number.isInteger(props.series.todayIndex) && props.series.todayIndex >= 0 ? xAt(props.series.todayIndex) : null))

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
  if ((props.series.barGroups ?? []).length > 0) {
    const bars = props.series.barGroups
      .map((group) => {
        const point = pointAt(group.points, key)
        return row({ seriesId: group.id, label: point?.label ?? group.label ?? group.id, color: group.color, point })
      })
      .filter(({ point }) => point?.showInTooltip !== false && Number.isFinite(point?.value))
    const linePoint = pointAt(availableLine.value.points, key)
    return [...bars, row({ seriesId: availableLine.value.id, label: availableLine.value.label ?? availableLine.value.id, color: availableLine.value.color, point: linePoint })]
  }
  const uses = (props.series.useLayers ?? []).map((layer) => {
    const point = pointAt(layer.points, key)
    return row({ seriesId: layer.id, label: point?.label ?? layer.label ?? layer.id, color: layer.color, point, yValue: point?.top })
  })
  const incomePoint = pointAt(ordinaryIncome.value.points, key)
  const sources = (props.series.sourceBands ?? []).map((band) => {
    const point = pointAt(band.points, key)
    return row({ seriesId: band.id, label: point?.label ?? band.label ?? band.id, color: band.color, point, yValue: point?.top })
  })
  const totalUsePoint = pointAt(totalUses.value.points, key)
  const totalSourcePoint = pointAt(totalSources.value.points, key)
  const gapPoint = pointAt(props.series.gap?.points ?? [], key)
  return [
    ...uses,
    row({ seriesId: ordinaryIncome.value.id, label: ordinaryIncome.value.label ?? ordinaryIncome.value.id, color: ordinaryIncome.value.color, point: incomePoint }),
    ...sources,
    row({
      seriesId: 'total-uses',
      label: props.series.totalUsesLabel,
      color: 'var(--expense2)',
      point: totalUsePoint,
    }),
    row({
      seriesId: 'total-sources',
      label: totalSources.value.label ?? totalSources.value.id,
      color: totalSources.value.color,
      point: totalSourcePoint,
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
    return { y: layout.value.padding.top + ratio * innerHeight.value, label: props.valueFormatter(yMax.value - yRange.value * ratio) }
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
const applyInteraction = (event) => {
  interaction.value = reduceCombinationChartInteraction(interaction.value, { ...event, pointCount: pointCount.value })
  if (interaction.value.effect?.type === 'select') emitSelection()
  if (interaction.value.effect?.type === 'clear') emit('select', null)
  if (interaction.value.effect?.type === 'selectRow') {
    const { item, activation } = interaction.value.effect
    emit('select-point', buildLineChartSelectionPayload({ seriesId: item.seriesId, point: item.point, activation }))
  }
}
const clearSelection = () => applyInteraction({ type: 'clear' })
const pointerIndex = (event) => {
  const bounds = root.value?.getBoundingClientRect()
  if (!bounds) return -1
  return nearestChartPointIndex({ clientX: event.clientX, left: bounds.left, width: bounds.width, viewBoxWidth: layout.value.width, padding: layout.value.padding, pointCount: pointCount.value })
}
const onPointerMove = (event) => {
  const index = pointerIndex(event)
  applyInteraction({ type: 'pointerMove', index })
}
const onPointerDown = (event) => {
  const index = pointerIndex(event)
  if (index < 0) return
  applyInteraction({ type: 'pointerDown', index })
  if (event.pointerType === 'touch') event.currentTarget.setPointerCapture?.(event.pointerId)
}
const onPointerUp = (event) => {
  const index = pointerIndex(event)
  applyInteraction({ type: 'pointerUp', index })
}
const onPointerLeave = () => applyInteraction({ type: 'pointerLeave' })
const onChartKeydown = (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
  event.preventDefault()
  applyInteraction({ type: 'key', key: event.key })
}
const onRootKeydown = (event) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  applyInteraction({ type: 'key', key: event.key })
}
const emitRow = (item, activation) => applyInteraction({ type: 'rowSelect', item, activation })

watch(pointCount, () => applyInteraction({ type: 'pointCountChanged' }))
onClickOutside(root, clearSelection)
</script>
