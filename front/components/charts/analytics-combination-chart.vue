<template>
  <div ref="root" class="analytics-line-chart analytics-combination-chart" @keydown="onRootKeydown">
    <analytics-cash-use-legend
      v-if="legendItems.length"
      :items="legendItems"
      :display-selection="displaySelection"
      :pinned-selection="pinnedSelection"
      :aria-label="ariaLabel"
      @preview="onLegendPreview"
      @leave="onLegendLeave"
      @toggle="onLegendToggle"
    />
    <div ref="scroll" class="analytics-combination-scroll">
      <div class="analytics-combination-canvas" :style="{ width: `${canvasWidth}px` }">
        <svg
          ref="chart"
          class="analytics-line-chart-svg analytics-combination-chart-svg"
          :viewBox="chartLayout.viewBox"
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
            <pattern :id="paintId('forecast')" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" stroke-width="2" opacity="0.45" />
            </pattern>
            <pattern :id="paintId('refund')" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="7" stroke="currentColor" stroke-width="2" opacity="0.58" />
            </pattern>
            <pattern :id="paintId('accessible-savings')" width="8" height="8" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1.5" fill="currentColor" opacity="0.55" />
            </pattern>
            <pattern :id="paintId('restricted-savings')" width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M 0 4 H 8 M 4 0 V 8" stroke="currentColor" stroke-width="1.25" opacity="0.5" />
            </pattern>
            <pattern :id="paintId('debt')" width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M 0 0 L 8 8 M 8 0 L 0 8" stroke="currentColor" stroke-width="1" opacity="0.5" />
            </pattern>
            <pattern :id="paintId('gap-positive')" width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M 0 8 L 8 0" stroke="var(--income2)" stroke-width="2" opacity="0.5" />
            </pattern>
            <pattern :id="paintId('gap-negative')" width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M 0 0 L 8 8" stroke="var(--expense2)" stroke-width="2" opacity="0.55" />
            </pattern>
            <pattern :id="paintId('category-dots')" width="8" height="8" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1.5" fill="currentColor" opacity="0.55" />
            </pattern>
            <pattern :id="paintId('category-horizontal')" width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M 0 4 H 8" stroke="currentColor" stroke-width="1.5" opacity="0.55" />
            </pattern>
            <pattern :id="paintId('category-grid')" width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M 0 4 H 8 M 4 0 V 8" stroke="currentColor" stroke-width="1.25" opacity="0.5" />
            </pattern>
          </defs>

          <g aria-hidden="true">
            <template v-for="line in gridLines" :key="line.y">
              <line class="analytics-chart-grid" :x1="chartLayout.gridX1" :x2="chartLayout.gridX2" :y1="line.y" :y2="line.y" />
              <text class="analytics-chart-axis-label" :x="chartLayout.yAxisLabelX" :y="line.y + 4" text-anchor="end" :style="{ fontSize: chartLayout.axisFontSize + 'px' }">{{ line.label }}</text>
            </template>
            <text
              v-for="label in xAxisLabels"
              :key="label.key"
              class="analytics-chart-axis-label"
              :x="label.x"
              :y="chartLayout.xAxisY"
              :text-anchor="label.anchor"
              :style="{ fontSize: chartLayout.axisFontSize + 'px' }"
            >
              {{ label.label }}
            </text>
          </g>

          <line
            v-if="todayX !== null"
            class="analytics-combination-today-marker"
            :x1="todayX"
            :x2="todayX"
            :y1="chartLayout.crosshairY1"
            :y2="chartLayout.crosshairY2"
            stroke="var(--transfer2)"
            stroke-width="1.5"
            stroke-dasharray="3 3"
            aria-hidden="true"
          />

          <g aria-hidden="true">
            <rect
              v-if="selectedMonthBand"
              class="analytics-combination-selected-month-band"
              :x="selectedMonthBand.x"
              :y="chartLayout.padding.top"
              :width="selectedMonthBand.width"
              :height="innerHeight"
            />
            <rect
              v-for="bar in renderedBars"
              :key="bar.key"
              :x="bar.x"
              :y="bar.y"
              :width="bar.width"
              :height="bar.height"
              :fill="bar.fill"
              :style="{ color: bar.color }"
              :opacity="bar.kind === 'actual' ? 0.86 : 0.78"
              rx="1"
            />
            <template v-for="layer in renderedUseLayers" :key="layer.id">
              <path
                v-for="(path, index) in layer.paths"
                :key="`${layer.id}:${index}`"
                :class="areaClass(layer.id)"
                :d="path.d"
                :fill="areaFill(layer, path)"
                :stroke="areaStroke(layer)"
                :stroke-dasharray="patternVariantStrokeDasharray(layer.patternVariant)"
                :data-pattern="layer.pattern"
                :data-pattern-variant="layer.patternVariant"
                :data-marker-kind="layer.markerKind"
                :data-legend-ordinal="layer.legendOrdinal"
                :style="{ color: layer.color }"
                opacity="0.72"
              />
              <path
                v-for="(path, index) in layer.refundPaths"
                :key="`${layer.id}:refund:${index}`"
                :class="areaClass(layer.refundSeriesId)"
                :d="path.d"
                :fill="paintUrl('refund')"
                data-pattern="refund"
                data-marker-kind="area"
                :style="{ color: layer.color }"
                opacity="0.9"
              />
            </template>
            <template v-for="band in renderedSourceBands" :key="band.id">
              <path
                v-for="(path, index) in band.paths"
                :key="`${band.id}:${index}`"
                :class="areaClass(band.id)"
                :d="path.d"
                :fill="areaFill(band, path)"
                :stroke="areaStroke(band)"
                :stroke-dasharray="patternVariantStrokeDasharray(band.patternVariant)"
                :data-pattern="band.pattern"
                :data-pattern-variant="band.patternVariant"
                :data-marker-kind="band.markerKind"
                :data-legend-ordinal="band.legendOrdinal"
                :style="{ color: band.color }"
                opacity="0.55"
              />
            </template>
            <path v-for="(path, index) in renderedPositiveGap" :key="`positive-gap:${index}`" :class="areaClass('gap-positive')" :d="path.d" :fill="paintUrl('gap-positive')" />
            <path v-for="(path, index) in renderedNegativeGap" :key="`negative-gap:${index}`" :class="areaClass('gap-negative')" :d="path.d" :fill="paintUrl('gap-negative')" />
            <path
              v-for="(path, index) in ordinaryIncomePaths"
              :key="`income:${index}`"
              :class="lineClass(ordinaryIncome.id)"
              :d="path.d"
              fill="none"
              :stroke="ordinaryIncome.color"
              stroke-width="2.5"
              :stroke-dasharray="path.forecast ? '8 6' : null"
            />
            <path
              v-for="(path, index) in totalSourcePaths"
              :key="`sources:${index}`"
              :class="lineClass(totalSources.id)"
              :d="path.d"
              fill="none"
              :stroke="totalSources.color"
              stroke-width="1.5"
              :stroke-dasharray="path.forecast ? '5 4' : '2 3'"
            />
            <path
              v-for="(path, index) in availableLinePaths"
              :key="`available:${index}`"
              :class="lineClass(availableLine.id)"
              :d="path.d"
              fill="none"
              :stroke="availableLine.color"
              stroke-width="2.5"
              :stroke-dasharray="path.forecast ? '7 5' : null"
            />
          </g>

          <path v-for="(selectedSegment, index) in selectedSegments" :key="`selected-segment:${index}`" class="analytics-combination-selected-segment" :d="selectedSegment.d" fill="none" />

          <g v-if="selectionMode === 'month' && selectedIndex >= 0" aria-hidden="true">
            <line class="analytics-chart-crosshair" :x1="selectedX" :x2="selectedX" :y1="chartLayout.crosshairY1" :y2="chartLayout.crosshairY2" />
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

        <div v-if="selectionMode === 'area' && activeAreaLabel" class="analytics-combination-area-label" :style="areaLabelPosition">
          {{ $t('analytics.cash_use.area_label', { label: activeAreaLabel }) }}
        </div>

        <div v-if="selectionMode === 'month' && selectedIndex >= 0" class="analytics-chart-tooltip" :class="{ right: tooltipOnRight, interactive: isPinned || isKeyboardSelection }">
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
            <span v-if="(selectedRow.point.refundCoverage?.totalRefunded ?? selectedRow.point.refundCoverage?.refunded) > 0" class="analytics-chart-tooltip-qualifier">
              {{ $t('analytics.cash_use.refund_coverage') }}: {{ valueFormatter(selectedRow.point.refundCoverage.totalRefunded ?? selectedRow.point.refundCoverage.refunded) }}
            </span>
          </button>
        </div>

        <div v-if="displaySelection.mode === 'seriesMonth'" class="analytics-combination-series-month-callout">
          {{ selectedSeriesMonthLabel }}
        </div>

        <analytics-cash-use-month-row
          v-if="pinnedSelection?.seriesId"
          :series="pinnedSeries"
          :month-keys="xValues"
          :active-month-index="displaySelection.monthIndex"
          :canvas-width="canvasWidth"
          :padding="chartLayout.padding"
          :value-formatter="valueFormatter"
          @activate="onMonthRowActivate"
        />
      </div>
    </div>

    <div class="sr-only" aria-live="polite">{{ liveDescription }}</div>
  </div>
</template>

<script setup>
import { onClickOutside, useElementSize } from '@vueuse/core'
import { nextTick, useId } from 'vue'
import { useAppStore } from '~/stores/appStore.js'
import {
  buildCombinationAreaGeometry,
  buildCombinationMonthBand,
  buildCombinationSelectionDescription,
  buildCombinationSelectedSegment,
  buildCashUseRefundCoverageSeries,
  displayCombinationSelection,
  reduceCombinationChartInteraction,
  resolveCombinationChartTarget,
} from '~/utils/AnalyticsCashUseUtils.js'
import { buildLineChartLayout, buildLineChartSelectionPayload, nearestChartPointIndex } from '~/utils/ChartUtils.js'

const GRID_LINE_COUNT = 5
const paintServerPrefix = `analytics-combination-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const paintId = (name) => `${paintServerPrefix}-${name}`
const paintUrl = (name) => `url(#${paintId(name)})`

const props = defineProps({
  series: { type: Object, required: true },
  ariaLabel: { type: String, required: true },
  valueFormatter: { type: Function, required: true },
  pinned: { type: Boolean, default: false },
  legendItems: { type: Array, default: () => [] },
})

const emit = defineEmits(['select', 'select-point'])
const appStore = useAppStore()
const { t } = useI18n()
const root = ref(null)
const chart = ref(null)
const scroll = ref(null)
const { width: renderedWidth } = useElementSize(root)
const interaction = ref(
  props.legendItems.length
    ? { previewSelection: null, pinnedSelection: null, isDragging: false, pointerStart: null, effect: null }
    : {
        selectedIndex: -1,
        mode: null,
        selectedSeriesId: null,
        isPinned: props.pinned,
        isKeyboardSelection: false,
        isDragging: false,
        pointerStartedOnPinnedIndex: -1,
        pointerStartedOnPinnedSeriesId: null,
        effect: null,
      },
)
const displaySelection = computed(() => displayCombinationSelection(interaction.value))
const pinnedSelection = computed(() => interaction.value.pinnedSelection ?? null)
const selectedIndex = computed(() => (['month', 'seriesMonth'].includes(displaySelection.value.mode) ? displaySelection.value.monthIndex : -1))
const selectionMode = computed(() => (displaySelection.value.mode === 'seriesMonth' ? 'area' : displaySelection.value.mode))
const selectedSeriesId = computed(() => displaySelection.value.seriesId)
const isPinned = computed(
  () =>
    pinnedSelection.value &&
    displaySelection.value.mode === pinnedSelection.value.mode &&
    displaySelection.value.seriesId === pinnedSelection.value.seriesId &&
    displaySelection.value.monthIndex === pinnedSelection.value.monthIndex,
)
const isKeyboardSelection = computed(() => interaction.value.isKeyboardSelection ?? false)
const areaLabelPosition = ref({ left: '8px', top: '8px' })

const layout = computed(() => buildLineChartLayout({ isDesktop: appStore.isDesktopLayout, renderedWidth: renderedWidth.value }))
const xValues = computed(() => props.series.dateKeys ?? props.series.monthKeys ?? [])
const pointCount = computed(() => xValues.value.length)
const canvasWidth = computed(() => (pointCount.value >= 12 ? Math.max(layout.value.width, pointCount.value * 52 + layout.value.padding.left + layout.value.padding.right) : layout.value.width))
const chartLayout = computed(() => ({ ...layout.value, width: canvasWidth.value, gridX2: canvasWidth.value - layout.value.padding.right, viewBox: `0 0 ${canvasWidth.value} ${layout.value.height}` }))
const innerWidth = computed(() => chartLayout.value.width - chartLayout.value.padding.left - chartLayout.value.padding.right)
const innerHeight = computed(() => chartLayout.value.height - chartLayout.value.padding.top - chartLayout.value.padding.bottom)
const xAt = (index) => chartLayout.value.padding.left + (index / Math.max(1, pointCount.value - 1)) * innerWidth.value
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
const yAt = (value) => chartLayout.value.padding.top + ((yMax.value - value) / yRange.value) * innerHeight.value
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
const refundHoverPoints = (points) =>
  refundCoveragePoints(points).map((point) => ((point.refundCoverage?.totalRefunded ?? point.refundCoverage?.refunded) > 0 ? point : { ...point, bottom: null, top: null }))
const renderedUseLayers = computed(() =>
  (props.series.useLayers ?? []).map((layer) => ({
    ...layer,
    refundSeriesId: `refund-coverage:${layer.id}`,
    paths: areaPaths(layer.points),
    refundPaths: areaPaths(refundCoveragePoints(layer.points), ({ refundCoverage }) => (refundCoverage?.totalRefunded ?? refundCoverage?.refunded) > 0),
  })),
)
const renderedSourceBands = computed(() => (props.series.sourceBands ?? []).map((layer) => ({ ...layer, paths: areaPaths(layer.points) })))
const refundCoverageSeries = computed(() =>
  buildCashUseRefundCoverageSeries({
    useLayers: props.series.useLayers ?? [],
    monthKeys: xValues.value,
    descriptor: props.legendItems.find(({ id }) => id === 'refund-coverage') ?? { label: t('analytics.cash_use.refund_coverage'), color: 'var(--expense2)', pattern: 'refund', markerKind: 'area' },
  }),
)
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
const barSourceKinds = computed(() => [...new Set((props.series.barGroups ?? []).map(({ id }) => id))])
const barSpacing = computed(() => (pointCount.value > 1 ? innerWidth.value / (pointCount.value - 1) : innerWidth.value))
const barWidth = computed(() => Math.max(2, Math.min(10, (barSpacing.value * 0.78) / Math.max(1, barSourceKinds.value.length))))
const barFill = (group, point) => {
  if (point.kind === 'forecast') return paintUrl('forecast')
  return group.color
}
const renderedBars = computed(() =>
  (props.series.barGroups ?? []).flatMap((group) => {
    const sourceIndex = barSourceKinds.value.indexOf(group.id)
    const groupWidth = barWidth.value * barSourceKinds.value.length
    return group.points.flatMap((point, index) => {
      if (!Number.isFinite(point.value) || point.value === 0) return []
      const valueY = yAt(point.value)
      const zeroY = yAt(0)
      return [
        {
          key: `${group.id}:${point.x}`,
          kind: point.kind,
          x: xAt(index) - groupWidth / 2 + sourceIndex * barWidth.value,
          y: Math.min(valueY, zeroY),
          width: barWidth.value,
          height: Math.max(1, Math.abs(zeroY - valueY)),
          fill: barFill(group, point),
          color: group.color,
        },
      ]
    })
  }),
)
const areaFill = (item, path) => {
  if (path.forecast) return paintUrl('forecast')
  if (['refund', 'accessible-savings', 'restricted-savings', 'debt', 'category-dots', 'category-horizontal', 'category-grid'].includes(item.pattern)) return paintUrl(item.pattern)
  return item.color
}
const patternVariantStrokeDasharray = (patternVariant) =>
  ({ outline: '1 0', offset: '4 2', inverse: '2 2', dense: '1 1', sparse: '6 3', cross: '3 1 1 1', wave: '5 2 1 2', dash: '7 3' })[patternVariant] ?? null
const areaStroke = (item) => (item.patternVariant && item.patternVariant !== 'primary' ? item.color : null)
const hoverAreas = computed(() => [
  ...(props.series.useLayers ?? []).flatMap((layer) => [
    { seriesId: layer.id, label: layer.label ?? layer.id, points: layer.points },
    { seriesId: `refund-coverage:${layer.id}`, label: t('analytics.cash_use.refund_coverage'), points: refundHoverPoints(layer.points) },
  ]),
  ...(props.series.sourceBands ?? []).map((band) => ({ seriesId: band.id, label: band.label ?? band.id, points: band.points })),
  {
    seriesId: 'gap-positive',
    label: t('analytics.cash_use.new_excess'),
    points: (props.series.gap?.points ?? []).map((point) => (point.direction === 'positive' ? point : { ...point, bottom: null, top: null })),
  },
  {
    seriesId: 'gap-negative',
    label: t('analytics.cash_use.existing_available_funds_required'),
    points: (props.series.gap?.points ?? []).map((point) => (point.direction === 'negative' ? point : { ...point, bottom: null, top: null })),
  },
])
const activeAreaLabel = computed(() => hoverAreas.value.find(({ seriesId }) => seriesId === selectedSeriesId.value)?.label ?? '')
const areaClass = (seriesId) => ({
  'analytics-combination-area': true,
  'analytics-combination-area-active':
    Boolean(selectedSeriesId.value) && (selectedSeriesId.value === seriesId || (selectedSeriesId.value === 'refund-coverage' && seriesId.startsWith('refund-coverage:'))),
  'analytics-combination-area-dimmed':
    Boolean(selectedSeriesId.value) && selectedSeriesId.value !== seriesId && !(selectedSeriesId.value === 'refund-coverage' && seriesId.startsWith('refund-coverage:')),
})
const lineClass = (seriesId) => ({
  'analytics-combination-line': true,
  'analytics-combination-line-active': Boolean(selectedSeriesId.value) && selectedSeriesId.value === seriesId,
  'analytics-combination-line-dimmed': Boolean(selectedSeriesId.value) && selectedSeriesId.value !== seriesId,
})
const seriesRegistry = computed(() => [
  ...(props.series.useLayers ?? []),
  refundCoverageSeries.value,
  ...(props.series.sourceBands ?? []),
  ordinaryIncome.value,
  totalSources.value,
  availableLine.value,
  {
    id: 'gap-positive',
    label: t('analytics.cash_use.new_excess'),
    points: (props.series.gap?.points ?? []).filter(({ direction }) => direction === 'positive'),
    color: 'var(--income2)',
    pattern: 'gap-positive',
    markerKind: 'area',
  },
  {
    id: 'gap-negative',
    label: t('analytics.cash_use.existing_available_funds_required'),
    points: (props.series.gap?.points ?? []).filter(({ direction }) => direction === 'negative'),
    color: 'var(--expense2)',
    pattern: 'gap-negative',
    markerKind: 'area',
  },
])
const selectedSeries = computed(() => seriesRegistry.value.find(({ id }) => id === selectedSeriesId.value) ?? null)
const pinnedSeries = computed(() => seriesRegistry.value.find(({ id }) => id === pinnedSelection.value?.seriesId) ?? { points: [], label: '', color: '', pattern: 'solid', markerKind: 'area' })
const selectedMonthBand = computed(() => {
  if (!['month', 'seriesMonth'].includes(displaySelection.value.mode)) return null
  return buildCombinationMonthBand({ monthIndex: displaySelection.value.monthIndex, xAt })
})
const selectedSegments = computed(() => {
  if (displaySelection.value.mode !== 'seriesMonth' || !selectedSeries.value) return []
  const series = selectedSeries.value.segmentSeries ?? [selectedSeries.value]
  return series.map((item) => buildCombinationSelectedSegment({ points: item.points, xValues: xValues.value, monthIndex: displaySelection.value.monthIndex, xAt, yAt })).filter(Boolean)
})
const selectedXValue = computed(() => xValues.value[selectedIndex.value])
const selectedX = computed(() => (selectedIndex.value < 0 ? 0 : xAt(selectedIndex.value)))
const selectedXLabel = computed(() => (selectedXValue.value ? xLabelAt(selectedXValue.value) : ''))
const tooltipOnRight = computed(() => selectedIndex.value < pointCount.value / 2)
const todayX = computed(() => (Number.isInteger(props.series.todayIndex) && props.series.todayIndex >= 0 ? xAt(props.series.todayIndex) : null))
const selectedSeriesMonthLabel = computed(() => {
  const description = buildCombinationSelectionDescription({ selection: displaySelection.value, series: selectedSeries.value, valueFormatter: props.valueFormatter })
  return description ? `${description.label}: ${description.valueLabel}` : ''
})

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
    return { y: chartLayout.value.padding.top + ratio * innerHeight.value, label: props.valueFormatter(yMax.value - yRange.value * ratio) }
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
const liveDescription = computed(() => {
  if (['series', 'seriesMonth'].includes(displaySelection.value.mode)) {
    const description = buildCombinationSelectionDescription({ selection: displaySelection.value, series: selectedSeries.value, valueFormatter: props.valueFormatter })
    if (!description) return ''
    const qualifiers = [
      description.kind === 'forecast' ? t('analytics.common.forecast') : t('analytics.common.actual'),
      description.status === 'partial' ? t('analytics.common.partial') : null,
      ['unavailable', 'insufficientHistory'].includes(description.status) ? t('analytics.common.unavailable_amounts', { ids: description.unavailableTransactionIds.join(', ') }) : null,
      description.status === 'ready' ? t('analytics.common.exact_values') : null,
      description.canNavigate ? t('toolbar.transactions') : null,
    ]
    return [description.label, description.monthLabel, description.valueLabel, ...qualifiers.filter(Boolean)].join('. ')
  }
  if (selectionMode.value === 'area') return activeAreaLabel.value
  return selectedIndex.value < 0 ? '' : [selectedXLabel.value, ...selectedRows.value.map(({ label, point }) => `${label}: ${point.valueLabel}`)].join('. ')
})

const selectionPayload = () =>
  selectionMode.value === 'area'
    ? { mode: 'area', index: selectedIndex.value, seriesId: selectedSeriesId.value, label: activeAreaLabel.value }
    : {
        mode: 'month',
        index: selectedIndex.value,
        x: selectedXValue.value,
        xLabel: selectedXLabel.value,
        values: selectedRows.value.map(({ seriesId, label, point }) => ({ seriesId, label, point })),
      }
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
const onLegendPreview = (seriesId) => applyInteraction({ type: 'legendPreview', seriesId })
const onLegendLeave = () => applyInteraction({ type: 'legendLeave' })
const onLegendToggle = (seriesId) => applyInteraction({ type: 'legendToggle', seriesId })
const onMonthRowActivate = ({ point, activation }) => {
  if (['unavailable', 'insufficientHistory'].includes(point?.status) || !point?.transactionIds?.length) return
  emit('select-point', buildLineChartSelectionPayload({ seriesId: pinnedSelection.value?.seriesId, point, activation }))
}
const pointerTarget = (event) => {
  const bounds = chart.value?.getBoundingClientRect()
  if (!bounds) return null
  areaLabelPosition.value = {
    left: `${Math.max(6, Math.min(bounds.width - 170, event.clientX - bounds.left + 12))}px`,
    top: `${Math.max(6, event.clientY - bounds.top - 34)}px`,
  }
  if ((props.series.barGroups ?? []).length > 0) {
    const index = nearestChartPointIndex({
      clientX: event.clientX,
      left: bounds.left,
      width: bounds.width,
      viewBoxWidth: chartLayout.value.width,
      padding: chartLayout.value.padding,
      pointCount: pointCount.value,
    })
    return index < 0 ? null : { mode: 'month', index }
  }
  return resolveCombinationChartTarget({
    clientPoint: { x: event.clientX, y: event.clientY },
    bounds,
    viewBox: { width: chartLayout.value.width, height: chartLayout.value.height },
    padding: chartLayout.value.padding,
    xValues: xValues.value,
    areas: hoverAreas.value,
    yAt,
    pointerType: event.pointerType,
  })
}
const onPointerMove = (event) => {
  applyInteraction({ type: 'pointerMove', target: pointerTarget(event) })
}
const onPointerDown = (event) => {
  const target = pointerTarget(event)
  if (!target) return
  applyInteraction({ type: 'pointerDown', target })
  if (event.pointerType === 'touch') event.currentTarget.setPointerCapture?.(event.pointerId)
}
const onPointerUp = (event) => {
  applyInteraction({ type: 'pointerUp', target: pointerTarget(event) })
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
watch(
  () => [pinnedSelection.value?.seriesId, displaySelection.value.monthIndex],
  async ([seriesId, monthIndex]) => {
    if (!seriesId || monthIndex < 0) return
    await nextTick()
    scroll.value?.querySelector('.analytics-cash-use-month-cell.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  },
)
onClickOutside(root, clearSelection)
</script>
