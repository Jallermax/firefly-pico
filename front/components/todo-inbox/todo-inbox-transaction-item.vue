<template>
  <div class="todo-inbox-item" :class="{ 'todo-inbox-item-completed': props.receipt }">
    <van-cell v-if="props.receipt" class="todo-inbox-receipt">
      <template #title>
        <div class="todo-inbox-receipt-content">
          <app-icon :icon="TablerIconConstants.booleanCheckOn" :size="17" />
          <span class="ellipse-text">{{ description }}</span>
          <span class="todo-inbox-receipt-label">{{ $t('todo_inbox.done') }}</span>
        </div>
      </template>
      <template #value>
        <van-button size="mini" plain :disabled="props.isProcessing" @click.stop="emit('undo', props.value)">
          {{ $t('todo_inbox.undo') }}
        </van-button>
      </template>
    </van-cell>

    <div v-if="props.receipt && props.error" class="todo-inbox-item-error">
      <span>{{ props.error }}</span>
      <van-button size="mini" plain type="danger" @click.stop="emit('undo', props.value)">{{ $t('todo_inbox.retry') }}</van-button>
    </div>

    <template v-else>
      <transaction-list-item-desktop v-if="appStore.isDesktopLayout" :value="props.value" :is-delete-enabled="false" @on-edit="emit('edit', props.value)" />
      <transaction-list-item v-else :value="props.value" :is-detailed-mode="false" :is-delete-enabled="false" @on-edit="emit('edit', props.value)" />

      <div class="todo-inbox-item-actions">
        <van-button size="small" plain @click.stop="emit('toggle', props.value)">
          {{ props.isExpanded ? $t('todo_inbox.collapse') : $t('todo_inbox.details') }}
        </van-button>
        <van-button size="small" type="primary" :loading="props.isProcessing" @click.stop="emit('done', props.value)">
          {{ $t('todo_inbox.done') }}
        </van-button>
      </div>

      <div v-if="props.error" class="todo-inbox-item-error">
        <span>{{ props.error }}</span>
        <van-button size="mini" plain type="danger" @click.stop="emit('retry', props.value)">{{ $t('todo_inbox.retry') }}</van-button>
      </div>

      <transaction-split-view v-if="props.isExpanded" :transaction="props.value" show-empty-fields />
    </template>
  </div>
</template>

<script setup>
import TablerIconConstants from '~/constants/TablerIconConstants.js'
import Transaction from '~/models/Transaction.js'

const props = defineProps({
  value: {
    type: Object,
    required: true,
  },
  isExpanded: {
    type: Boolean,
    default: false,
  },
  isProcessing: {
    type: Boolean,
    default: false,
  },
  error: {
    type: String,
    default: null,
  },
  receipt: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['edit', 'toggle', 'done', 'undo', 'retry'])

const appStore = useAppStore()
const description = computed(() => Transaction.getDescription(props.value))
</script>
