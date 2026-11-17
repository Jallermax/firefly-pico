<template>
  <div class="analytics-metric-facet">
    <button type="button" class="analytics-metric-facet-button" aria-haspopup="dialog" :aria-label="$t('analytics.balance.select_metrics')" @click="popupVisible = true">
      {{ $t('analytics.balance.selected_count', { count: selected.length }) }}
    </button>

    <analytics-dialog v-model="popupVisible" :title="$t('analytics.balance.select_metrics')">
      <input v-model="search" type="search" class="analytics-input" :aria-label="$t('search_placeholder')" :placeholder="$t('search_placeholder')" />
      <button
        v-for="item in filteredItems"
        :key="item.id"
        type="button"
        class="analytics-metric-facet-row"
        :aria-pressed="selected.includes(item.id)"
        :disabled="selected.length === 1 && selected.includes(item.id)"
        @click="toggle(item.id)"
      >
        <span class="analytics-facet-check" aria-hidden="true" />
        <span class="analytics-chart-legend-marker" :class="'analytics-chart-legend-marker-' + item.marker" :style="{ backgroundColor: item.color }" />
        <span class="flex-1">{{ item.label }}</span>
      </button>
      <div v-if="filteredItems.length === 0" class="analytics-card-state analytics-card-state-compact">{{ $t('no_matches') }}</div>
    </analytics-dialog>
  </div>
</template>

<script setup>
import { filterChartFacetItems, toggleRequiredChartFacetSelection } from '~/core/utils/ChartUtils.js'

const selectedIds = defineModel({ type: Array, default: () => [] })
const props = defineProps({ items: { type: Array, default: () => [] } })

const popupVisible = ref(false)
const search = ref('')
const selected = computed(() => (Array.isArray(selectedIds.value) ? selectedIds.value : []))
const filteredItems = computed(() => filterChartFacetItems(props.items, search.value))

const toggle = (id) => {
  selectedIds.value = toggleRequiredChartFacetSelection(selected.value, id)
}
</script>
