<template>
  <nav class="analytics-tabs analytics-page-switch" :aria-label="$t('analytics.title')">
    <nuxt-link :to="RouteConstants.ROUTE_DASHBOARD" class="analytics-tab">{{ $t('analytics.overview') }}</nuxt-link>
    <nuxt-link :to="RouteConstants.ROUTE_ANALYTICS" class="analytics-tab">{{ $t('analytics.title') }}</nuxt-link>
  </nav>
</template>

<script setup>
import RouteConstants from '~/core/constants/RouteConstants.js'
</script>
