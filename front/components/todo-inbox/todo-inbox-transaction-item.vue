<template>
  <div class="todo-inbox-item" :class="{ 'todo-inbox-item-desktop': appStore.isDesktopLayout, 'todo-inbox-item-completed': props.receipt }" :data-todo-id="props.value.id">
    <div v-if="props.receipt || props.isProcessing || props.isQueued" class="todo-inbox-receipt" :aria-busy="props.isProcessing || props.isQueued">
      <van-loading v-if="props.isProcessing" size="16" />
      <app-icon v-else :icon="props.isQueued ? TablerIconConstants.order : TablerIconConstants.booleanCheckOn" :size="17" />
      <span class="todo-inbox-receipt-description ellipse-text" :title="description">{{ description }}</span>
      <span class="todo-inbox-receipt-amount">{{ amounts.map((amount) => amount.text).join(' · ') }}</span>
      <span class="todo-inbox-receipt-label" role="status">
        {{ $t(props.isProcessing ? (props.receipt ? 'todo_inbox.restoring' : 'todo_inbox.saving') : props.isQueued ? 'todo_inbox.queued' : (props.receipt?.messageKey ?? 'todo_inbox.done')) }}
      </span>
      <van-button v-if="props.receipt?.journalIds.length && !props.isProcessing" size="mini" plain class="todo-inbox-action" @click.stop="emit('undo', props.value)">
        {{ $t('todo_inbox.undo') }}
      </van-button>
    </div>
    <template v-else>
      <div class="todo-inbox-review-heading">
        <div class="todo-inbox-summary" role="button" tabindex="0" @click="emit('edit', props.value)" @keydown.enter="emit('edit', props.value)" @keydown.space.prevent="emit('edit', props.value)">
          <div class="todo-inbox-date">{{ dateFormatted }}</div>
          <div class="todo-inbox-description">
            <div class="todo-inbox-title">{{ description }} <transaction-split-badge v-if="isSplitPayment" /></div>
            <div v-if="!isSplitPayment" class="todo-inbox-accounts">
              <account-badge v-if="firstSplit.accountSource" :value="firstSplit.accountSource" />
              <span v-else>{{ firstSplit.source_name }}</span>
              <app-icon :icon="TablerIconConstants.rightArrow" :size="14" />
              <account-badge v-if="firstSplit.accountDestination" :value="firstSplit.accountDestination" />
              <span v-else>{{ firstSplit.destination_name }}</span>
            </div>
            <span v-else class="todo-inbox-empty">{{ $t('transaction.split_count', { count: splits.length }) }}</span>
          </div>
          <div class="todo-inbox-amounts">
            <span v-for="amount in amounts" :key="amount.key" class="todo-inbox-amount" :class="`todo-inbox-amount-${amount.type}`">{{ amount.text }}</span>
          </div>
        </div>
        <div class="todo-inbox-item-actions">
          <van-button size="small" plain class="todo-inbox-action" :aria-expanded="props.isExpanded" :aria-controls="`todo-details-${props.value.id}`" @click.stop="emit('toggle', props.value)">
            <app-icon :icon="props.isExpanded ? TablerIconConstants.upArrow : TablerIconConstants.downArrow" :size="16" />
            {{ props.isExpanded ? $t('todo_inbox.collapse') : $t('todo_inbox.details') }}
          </van-button>
          <van-button size="small" plain class="todo-inbox-action todo-inbox-done" @click.stop="emit('done', props.value)">
            <app-icon :icon="TablerIconConstants.booleanCheckOn" :size="17" />
            {{ $t('todo_inbox.done') }}
          </van-button>
        </div>
      </div>
      <div v-if="props.error" class="todo-inbox-item-error" role="alert">
        <span>{{ props.error }}</span>
        <van-button size="mini" plain type="danger" @click.stop="emit('retry', props.value)">{{ $t('todo_inbox.retry') }}</van-button>
      </div>
      <todo-inbox-review-details v-if="props.isExpanded" :id="`todo-details-${props.value.id}`" :transaction="props.value" />
    </template>
    <div v-if="props.receipt && props.error" class="todo-inbox-item-error" role="alert">
      <span>{{ props.error }}</span>
      <van-button size="mini" plain type="danger" :disabled="props.isProcessing" @click.stop="emit('undo', props.value)">{{ $t('todo_inbox.retry') }}</van-button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import TablerIconConstants from '~/constants/TablerIconConstants.js'
import Transaction from '~/models/Transaction.js'
import DateUtils from '~/utils/DateUtils.js'
import { getTodoReviewAmounts } from '~/utils/TodoReviewUtils.js'

const props = defineProps({
  value: { type: Object, required: true },
  isExpanded: { type: Boolean, default: false },
  isProcessing: { type: Boolean, default: false },
  isQueued: { type: Boolean, default: false },
  error: { type: String, default: null },
  receipt: { type: Object, default: null },
})
const emit = defineEmits(['edit', 'toggle', 'done', 'undo', 'retry'])
const appStore = useAppStore()
const { locale } = useI18n()
const splits = computed(() => Transaction.getSplits(props.value))
const firstSplit = computed(() => splits.value[0] ?? {})
const isSplitPayment = computed(() => splits.value.length > 1)
const description = computed(() => Transaction.getDescription(props.value))
const amounts = computed(() => getTodoReviewAmounts(splits.value, locale.value))
const dateFormatted = computed(() => DateUtils.dateToUIWithTime(DateUtils.autoToDate(Transaction.getDate(props.value))))
</script>
