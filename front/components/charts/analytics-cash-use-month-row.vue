<template>
  <div class="analytics-cash-use-month-row" :style="{ width: `${canvasWidth}px` }">
    <div class="analytics-cash-use-month-row-label">
      <span
        class="analytics-cash-use-legend-marker"
        :data-pattern="series.pattern"
        :data-pattern-variant="series.patternVariant"
        :data-marker-kind="series.markerKind"
        :data-legend-ordinal="series.legendOrdinal"
        :style="{ color: series.color, '--legend-color': series.color }"
      />
      <span :aria-label="series.ariaLabel ?? series.label">{{ series.label }}</span>
    </div>
    <button
      v-for="cell in cells"
      :key="cell.point?.x ?? cell.monthKey"
      type="button"
      class="analytics-cash-use-month-cell"
      :class="{ active: cell.index === activeMonthIndex }"
      :style="{ left: `${cell.x}px` }"
      :disabled="!cell.canNavigate"
      @click="$emit('activate', { point: cell.point, activation: 'pointer' })"
    >
      <span>{{ cell.monthLabel }}</span>
      <strong>{{ valueFormatter(cell.point?.value) }}</strong>
    </button>
  </div>
</template>

<script setup>
const props = defineProps({
  series: { type: Object, required: true },
  monthKeys: { type: Array, default: () => [] },
  activeMonthIndex: { type: Number, default: -1 },
  canvasWidth: { type: Number, required: true },
  padding: { type: Object, required: true },
  valueFormatter: { type: Function, required: true },
})

defineEmits(['activate'])

const canNavigate = (point) => !['unavailable', 'insufficientHistory'].includes(point?.status) && Array.isArray(point?.transactionIds) && point.transactionIds.length > 0
const cells = computed(() => {
  const innerWidth = props.canvasWidth - props.padding.left - props.padding.right
  return props.monthKeys.map((monthKey, index) => {
    const point = props.series.points.find((item) => item.x === monthKey)
    return {
      index,
      monthKey,
      point,
      monthLabel: point?.xLabel ?? monthKey,
      x: props.padding.left + (index / Math.max(1, props.monthKeys.length - 1)) * innerWidth,
      canNavigate: canNavigate(point),
    }
  })
})
</script>
