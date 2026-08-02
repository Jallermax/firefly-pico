<template>
  <div class="analytics-metric-facet">
    <button type="button" class="analytics-metric-facet-button" :aria-label="$t('analytics.balance.select_metrics')" @click="popupVisible = true">
      {{ $t('analytics.balance.selected_count', { count: selected.length }) }}
    </button>

    <app-popup v-model:show="popupVisible" popup-style="max-width: 560px">
      <div class="analytics-metric-facet-popup">
        <div class="analytics-metric-facet-header">
          <strong class="flex-1">{{ $t('analytics.balance.select_metrics') }}</strong>
          <van-button size="small" @click="popupVisible = false">{{ $t('ok') }}</van-button>
        </div>
        <app-list-search v-model="search" />
        <div class="analytics-metric-facet-list">
          <button
            v-for="item in filteredItems"
            :key="item.id"
            type="button"
            class="analytics-metric-facet-row"
            :aria-disabled="selected.length === 1 && selected.includes(item.id)"
            @click="toggle(item.id)"
          >
            <van-checkbox :model-value="selected.includes(item.id)" :disabled="selected.length === 1 && selected.includes(item.id)" @click.stop @update:model-value="toggle(item.id)" />
            <span class="analytics-chart-legend-marker" :class="'analytics-chart-legend-marker-' + item.marker" :style="{ backgroundColor: item.color }" />
            <span class="flex-1">{{ item.label }}</span>
          </button>
        </div>
      </div>
    </app-popup>
  </div>
</template>

<script setup>
const selectedIds = defineModel({ type: Array, default: () => [] })
const props = defineProps({ items: { type: Array, default: () => [] } })

const popupVisible = ref(false)
const search = ref('')
const selected = computed(() => (Array.isArray(selectedIds.value) ? selectedIds.value : []))
const filteredItems = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return query ? props.items.filter((item) => item.label.toLocaleLowerCase().includes(query)) : props.items
})

const toggle = (id) => {
  if (selected.value.includes(id)) {
    if (selected.value.length === 1) return
    selectedIds.value = selected.value.filter((item) => item !== id)
    return
  }
  selectedIds.value = [...selected.value, id]
}
</script>
