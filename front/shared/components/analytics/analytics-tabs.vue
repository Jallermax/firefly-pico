<template>
  <div class="analytics-tabs" role="group">
    <button v-for="item in items" :key="item.value" type="button" class="analytics-tab" :aria-pressed="item.value === modelValue" @click="modelValue = item.value">
      {{ item.label }}
    </button>
  </div>
</template>

<script setup>
const modelValue = defineModel({ type: [String, Number, Boolean], default: null })
defineProps({ items: { type: Array, required: true } })
</script>
