<template>
  <div class="analytics-warning flex-center-vertical gap-2" role="note">
    <span v-if="disclosure.usesCurrentRates" class="analytics-fx-badge">{{ disclosure.displayCurrencyCode }} · {{ $t('analytics.common.fx_current_rates') }}</span>
    <span v-if="disclosure.missingCurrencies.length">{{ $t('analytics.common.missing_rates', { currencies: disclosure.missingCurrencies.join(', ') }) }}</span>
  </div>
</template>

<script setup>
defineProps({
  disclosure: { type: Object, required: true },
})
</script>
