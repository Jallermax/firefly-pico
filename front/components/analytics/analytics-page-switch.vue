<template>
  <app-tabs v-model="selectedRoute" :items="items" :aria-label="$t('analytics.title')" class="analytics-page-switch" />
</template>

<script setup>
import RouteConstants from '~/constants/RouteConstants.js'

const route = useRoute()
const { t } = useI18n()
const selectedRoute = computed({
  get: () => (route.path === RouteConstants.ROUTE_ANALYTICS ? RouteConstants.ROUTE_ANALYTICS : RouteConstants.ROUTE_DASHBOARD),
  set: (value) => navigateTo(value),
})
const items = computed(() => [
  { label: t('analytics.overview'), value: RouteConstants.ROUTE_DASHBOARD },
  { label: t('analytics.title'), value: RouteConstants.ROUTE_ANALYTICS },
])
</script>
