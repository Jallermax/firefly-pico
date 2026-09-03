<template>
  <div class="analytics-savings-view-control" role="group" aria-labelledby="analytics-savings-view-label">
    <span id="analytics-savings-view-label" class="analytics-savings-view-label">{{ $t('analytics.savings_view.label') }}</span>
    <app-tabs v-model="modelValue" :items="items" aria-labelledby="analytics-savings-view-label" />
  </div>
</template>

<script setup>
const modelValue = defineModel({ type: String, default: 'combined' })
const { t } = useI18n()
const items = computed(() => [
  { label: t('analytics.savings_view.combined'), value: 'combined' },
  { label: t('analytics.savings_view.split'), value: 'split' },
])
</script>
