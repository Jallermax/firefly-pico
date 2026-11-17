<template>
  <div class="analytics-cash-use-legend" role="list" :aria-label="ariaLabel">
    <span v-for="item in items" :key="item.id" role="listitem">
      <button
        type="button"
        class="analytics-cash-use-legend-item"
        :class="{ active: displaySelection?.seriesId === item.id, pinned: pinnedSelection?.seriesId === item.id }"
        @pointerenter="$emit('preview', item.id)"
        @pointerleave="$emit('leave')"
        @focus="$emit('preview', item.id)"
        @blur="$emit('leave')"
        @click="$emit('toggle', item.id)"
      >
        <span
          class="analytics-cash-use-legend-marker"
          :data-pattern="item.pattern"
          :data-pattern-variant="item.patternVariant"
          :data-marker-kind="item.markerKind"
          :data-legend-ordinal="item.legendOrdinal"
          :style="{ color: item.color, '--legend-color': item.color }"
        />
        <span :aria-label="item.ariaLabel ?? item.label">{{ item.label }}</span>
      </button>
    </span>
  </div>
</template>

<script setup>
defineProps({
  items: { type: Array, default: () => [] },
  displaySelection: { type: Object, default: null },
  pinnedSelection: { type: Object, default: null },
  ariaLabel: { type: String, default: '' },
})

defineEmits(['preview', 'leave', 'toggle'])
</script>
