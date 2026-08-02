<template>
  <div class="analytics-category-facet">
    <button type="button" class="analytics-category-facet-button" :aria-label="$t('analytics.category.select')" @click="popupVisible = true">
      {{ $t('analytics.category.selected_count', { count: selected.length }) }}
    </button>

    <app-popup v-model:show="popupVisible" popup-style="max-width: 560px">
      <div class="analytics-category-facet-popup">
        <div class="analytics-category-facet-header">
          <strong class="flex-1">{{ $t('analytics.category.select') }}</strong>
          <van-button size="small" @click="popupVisible = false">{{ $t('ok') }}</van-button>
        </div>
        <app-list-search v-model="search" />
        <div class="analytics-category-facet-list">
          <button v-for="item in filteredItems" :key="item.id" type="button" class="analytics-category-facet-row" @click="toggle(item.id)">
            <van-checkbox :model-value="selected.includes(item.id)" @click.stop @update:model-value="toggle(item.id)" />
            <span class="flex-1">{{ categoryLabel(item.id) }}</span>
            <span v-if="Number.isFinite(item.amount)" class="analytics-category-facet-amount">{{ formatNumberForDashboard(item.amount) }}</span>
          </button>
          <div v-if="filteredItems.length === 0" class="analytics-card-state analytics-card-state-compact">{{ $t('analytics.category.empty') }}</div>
        </div>
      </div>
    </app-popup>
  </div>
</template>

<script setup>
import Category from '~/models/Category.js'
import { useCategoryStore } from '~/stores/categoryStore.js'
import { ANALYTICS_UNCATEGORIZED_ID } from '~/utils/AnalyticsUtils.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'
import UIUtils from '~/utils/UIUtils.js'

const selectedIds = defineModel({ type: Array, default: () => [] })
const props = defineProps({
  items: { type: Array, default: () => [] },
  max: { type: Number, default: 6 },
})

const categoryStore = useCategoryStore()
const { t } = useI18n()
const popupVisible = ref(false)
const search = ref('')
const selectionLimit = computed(() => Math.min(6, Math.max(0, Math.floor(Number(props.max) || 0))))
const selected = computed(() => (Array.isArray(selectedIds.value) ? selectedIds.value : []))
const normalizedItems = computed(() =>
  props.items
    .map((item) => (typeof item === 'object' && item !== null ? { id: item.id, amount: item.amount } : { id: item, amount: null }))
    .filter((item, index, items) => item.id !== null && item.id !== undefined && items.findIndex(({ id }) => id === item.id) === index),
)
const categoryLabel = (id) => String(id === ANALYTICS_UNCATEGORIZED_ID ? t('analytics.category.uncategorized') : Category.getDisplayName(categoryStore.categoryDictionary[id]) || id)
const filteredItems = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return query ? normalizedItems.value.filter(({ id }) => categoryLabel(id).toLocaleLowerCase().includes(query)) : normalizedItems.value
})

const normalizeSelection = (value) => [...new Set((Array.isArray(value) ? value : []).filter((id) => id !== null && id !== undefined))].slice(0, selectionLimit.value)

watch(
  [() => selectedIds.value, selectionLimit],
  ([value]) => {
    const normalized = normalizeSelection(value)
    const current = Array.isArray(value) ? value : []
    if (!Array.isArray(value) || normalized.length !== current.length || normalized.some((id, index) => id !== current[index])) selectedIds.value = normalized
  },
  { immediate: true },
)

const toggle = (id) => {
  if (selected.value.includes(id)) {
    selectedIds.value = selected.value.filter((item) => item !== id)
    return
  }
  if (selected.value.length >= selectionLimit.value) {
    UIUtils.showToastError(t('analytics.category.selection_limit', { count: selectionLimit.value }))
    return
  }
  selectedIds.value = [...selected.value, id]
}
</script>
