<template>
  <analytics-page-layout :title="$t('analytics.title')" :refresh="analyticsStore.refresh">
    <analytics-page-switch />
    <analytics-savings-view-control v-model="analyticsStore.savingsView" />
    <analytics-fx-disclosure v-for="item in fxDisclosurePlacements" :key="item.surface" :disclosure="item.disclosure" />
    <div class="analytics-layout">
      <analytics-balance-trends class="analytics-layout-balance" />
      <analytics-category-spending v-if="profileStore.categoriesEnabled" class="analytics-layout-category" />
      <analytics-money-flow class="analytics-layout-flow" />
      <analytics-daily-forecast class="analytics-layout-daily" />
      <analytics-cash-use class="analytics-layout-cash-use" />
    </div>
  </analytics-page-layout>
</template>

<script setup>
import { useAnalyticsStore } from '~/core/stores/analyticsStore.js'
import { resolveAnalyticsFxDisclosurePlacements } from '~/core/utils/AnalyticsUtils.js'

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const fxDisclosurePlacements = computed(() => resolveAnalyticsFxDisclosurePlacements(analyticsStore.fxDisclosure))

onMounted(() => analyticsStore.init())
</script>
