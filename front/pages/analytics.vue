<template>
  <div class="app-form analytics-page">
    <app-top-toolbar />
    <analytics-page-switch />

    <van-pull-refresh v-model="isRefreshing" @refresh="onRefresh">
      <analytics-savings-view-control v-model="analyticsStore.savingsView" />
      <analytics-fx-disclosure v-for="item in fxDisclosurePlacements" :key="item.surface" :disclosure="item.disclosure" />
      <div class="analytics-layout">
        <analytics-balance-trends class="analytics-layout-balance" />
        <analytics-category-spending v-if="profileStore.categoriesEnabled" class="analytics-layout-category" />
        <analytics-money-flow class="analytics-layout-flow" />
        <analytics-daily-forecast class="analytics-layout-daily" />
        <analytics-cash-use class="analytics-layout-cash-use" />
      </div>
    </van-pull-refresh>
  </div>
</template>

<script setup>
import { useToolbar } from '~/composables/useToolbar'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { resolveAnalyticsFxDisclosurePlacements } from '~/utils/AnalyticsUtils.js'

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const isRefreshing = ref(false)
const { t } = useI18n()
const fxDisclosurePlacements = computed(() => resolveAnalyticsFxDisclosurePlacements(analyticsStore.fxDisclosure))

const onRefresh = async () => {
  isRefreshing.value = true
  await analyticsStore.refresh()
  isRefreshing.value = false
}

onMounted(() => analyticsStore.init())
useToolbar().init({ title: t('analytics.title') })
</script>
