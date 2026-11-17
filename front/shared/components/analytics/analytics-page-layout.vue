<template>
  <d-page v-if="isDesktopUI" :title="title" class="analytics-page">
    <template #actions>
      <d-button v-if="backRoute" :to="backRoute" :icon="IconArrowLeft">{{ $t('back') }}</d-button>
      <d-refresh-button :action="onRefresh" />
    </template>
    <slot />
  </d-page>

  <div v-else class="mx-page analytics-page">
    <app-top-toolbar>
      <template #right>
        <app-refresh-button :refresh="onRefresh" />
      </template>
    </app-top-toolbar>

    <main class="mx-body">
      <app-list v-model:refreshing="isRefreshing" finished @refresh="onRefresh">
        <slot />
      </app-list>
    </main>
  </div>
</template>

<script setup>
import { IconArrowLeft } from '@tabler/icons-vue'
import { isDesktopUI } from '~/core/utils/UIModeUtils.js'
import { useToolbar } from '~/mobile/composables/useToolbar.js'

const props = defineProps({
  title: { type: String, required: true },
  backRoute: { type: String, default: null },
  refresh: { type: Function, required: true },
})

const isRefreshing = ref(false)

const onRefresh = async () => {
  isRefreshing.value = true
  try {
    await props.refresh()
  } finally {
    isRefreshing.value = false
  }
}

if (!isDesktopUI) useToolbar().init({ title: toRef(props, 'title'), backRoute: props.backRoute })
</script>
