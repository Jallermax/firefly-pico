<template>
  <div class="analytics-category-facet">
    <button type="button" class="analytics-category-facet-button" aria-haspopup="dialog" :aria-label="$t('analytics.category.select')" @click="popupVisible = true">
      {{ $t('analytics.category.selected_count', { count: selected.length }) }}
    </button>

    <analytics-dialog v-model="popupVisible" :title="$t('analytics.category.select')">
      <input v-model="search" type="search" class="analytics-input" :aria-label="$t('search_placeholder')" :placeholder="$t('search_placeholder')" />
      <p v-if="selectionError" class="analytics-selection-error" role="alert">{{ selectionError }}</p>
      <button v-for="item in filteredItems" :key="item.id" type="button" class="analytics-category-facet-row" :aria-pressed="selected.includes(item.id)" @click="toggle(item.id)">
        <span class="analytics-facet-check" aria-hidden="true" />
        <span class="flex-1">{{ categoryLabel(item.id) }}</span>
        <span v-if="Number.isFinite(item.amount)" class="analytics-category-facet-amount">{{ formatNumberForDashboard(item.amount) }}</span>
      </button>
      <div v-if="filteredItems.length === 0" class="analytics-card-state analytics-card-state-compact">{{ $t('analytics.category.empty') }}</div>
    </analytics-dialog>
  </div>
</template>

<script setup>
import Category from '~/core/models/Category.js'
import { useCategoryStore } from '~/core/stores/categoryStore.js'
import { ANALYTICS_UNCATEGORIZED_ID } from '~/core/utils/AnalyticsUtils.js'
import { formatNumberForDashboard } from '~/core/utils/NumberUtils.js'
import UIUtils from '~/core/utils/UIUtils.js'

const selectedIds = defineModel({ type: Array, default: () => [] })
const props = defineProps({
  items: { type: Array, default: () => [] },
  max: { type: Number, default: 6 },
})

const categoryStore = useCategoryStore()
const { t } = useI18n()
const popupVisible = ref(false)
const search = ref('')
const selectionError = ref('')
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

const uniqueSelection = (value) => [...new Set((Array.isArray(value) ? value : []).filter((id) => id !== null && id !== undefined))]
const normalizeSelection = (value) => uniqueSelection(value).slice(0, selectionLimit.value)
let selectionRecoveryReported = false

watch(
  [() => selectedIds.value, selectionLimit],
  ([value]) => {
    const normalized = normalizeSelection(value)
    const current = Array.isArray(value) ? value : []
    if (!selectionRecoveryReported && (!Array.isArray(value) || uniqueSelection(value).length > selectionLimit.value)) {
      selectionRecoveryReported = true
      UIUtils.showToastError(t('analytics.category.selection_limit', { count: selectionLimit.value }))
    }
    if (!Array.isArray(value) || normalized.length !== current.length || normalized.some((id, index) => id !== current[index])) selectedIds.value = normalized
  },
  { immediate: true },
)

const toggle = (id) => {
  selectionError.value = ''
  if (selected.value.includes(id)) {
    selectedIds.value = selected.value.filter((item) => item !== id)
    return
  }
  if (selected.value.length >= selectionLimit.value) {
    selectionError.value = t('analytics.category.selection_limit', { count: selectionLimit.value })
    return
  }
  selectedIds.value = [...selected.value, id]
}

watch(popupVisible, () => (selectionError.value = ''))
</script>
