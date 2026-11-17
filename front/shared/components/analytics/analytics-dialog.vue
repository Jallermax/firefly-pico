<template>
  <dialog ref="dialog" class="analytics-dialog" :aria-label="title" :aria-modal="open ? 'true' : undefined" @cancel.prevent="open = false" @click.self="open = false">
    <div class="analytics-dialog-body">
      <header class="analytics-dialog-header">
        <h2>{{ title }}</h2>
        <button type="button" class="analytics-button" @click="open = false">{{ $t('ok') }}</button>
      </header>
      <div class="analytics-dialog-content">
        <slot />
      </div>
    </div>
  </dialog>
</template>

<script setup>
const open = defineModel({ type: Boolean, default: false })
defineProps({ title: { type: String, required: true } })

const dialog = useTemplateRef('dialog')
watchEffect(
  () => {
    if (!dialog.value) return
    if (open.value && !dialog.value.open) dialog.value.showModal()
    if (!open.value && dialog.value.open) dialog.value.close()
  },
  { flush: 'post' },
)
</script>
