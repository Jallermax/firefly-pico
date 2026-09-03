<template>
  <div class="todo-inbox-review-details">
    <section v-for="(split, index) in splits" :key="split.transaction_journal_id ?? index" class="todo-inbox-review-split">
      <div v-if="splits.length > 1" class="todo-inbox-split-heading">
        <div class="todo-inbox-title">{{ index + 1 }} / {{ splits.length }} · {{ split.description }}</div>
        <span v-for="amount in getTodoReviewAmounts([split], locale)" :key="amount.key" class="todo-inbox-amount" :class="`todo-inbox-amount-${amount.type}`">{{ amount.text }}</span>
        <span class="todo-inbox-date">{{ DateUtils.dateToUIWithTime(DateUtils.autoToDate(split.date)) }}</span>
        <div class="todo-inbox-accounts">
          <account-badge v-if="split.accountSource" :value="split.accountSource" />
          <span v-else>{{ split.source_name }}</span>
          <app-icon :icon="TablerIconConstants.rightArrow" :size="14" />
          <account-badge v-if="split.accountDestination" :value="split.accountDestination" />
          <span v-else>{{ split.destination_name }}</span>
        </div>
      </div>
      <div class="todo-inbox-properties">
        <dl v-if="profileStore.categoriesEnabled || profileStore.tagsEnabled" class="todo-inbox-property-column">
          <div v-if="profileStore.categoriesEnabled" class="todo-inbox-property">
            <dt><app-icon :icon="TablerIconConstants.category" :size="15" />{{ $t('category') }}</dt>
            <dd>
              <category-badge v-if="split.category" :value="split.category" :icon-size="14" />
              <span v-else :class="{ 'todo-inbox-empty': !split.category_name }">{{ split.category_name || $t('todo_inbox.none') }}</span>
            </dd>
          </div>
          <div v-if="profileStore.tagsEnabled" class="todo-inbox-property">
            <dt><app-icon :icon="TablerIconConstants.tag" :size="15" />{{ $t('tags') }}</dt>
            <dd>
              <tag-badge v-for="tag in split.tags?.filter(Boolean) ?? []" :key="tag.id" :value="tag" :max-length="Infinity" />
              <span v-if="!split.tags?.filter(Boolean).length" class="todo-inbox-empty">{{ $t('todo_inbox.none') }}</span>
            </dd>
          </div>
        </dl>
        <dl
          v-if="
            profileStore.budgetsEnabled ||
            profileStore.recurringTransactionsEnabled ||
            transactionExtraDateFieldList.some((field) => split[field.code]) ||
            (split.amountForeign ?? split.foreign_amount)
          "
          class="todo-inbox-property-column"
        >
          <div v-if="profileStore.budgetsEnabled" class="todo-inbox-property">
            <dt><app-icon :icon="TablerIconConstants.budget" :size="15" />{{ $t('budget') }}</dt>
            <dd :class="{ 'todo-inbox-empty': !split.budget && !split.budget_name }">{{ split.budget ? Budget.getDisplayName(split.budget) : split.budget_name || $t('todo_inbox.none') }}</dd>
          </div>
          <div v-if="profileStore.recurringTransactionsEnabled" class="todo-inbox-property">
            <dt><app-icon :icon="TablerIconConstants.recurringTransaction" :size="15" />{{ $t('transaction.subscription') }}</dt>
            <dd :class="{ 'todo-inbox-empty': !split.subscription_name && !split.bill_name }">{{ split.subscription_name || split.bill_name || $t('todo_inbox.none') }}</dd>
          </div>
          <div v-for="field in transactionExtraDateFieldList.filter((field) => split[field.code])" :key="field.code" class="todo-inbox-property">
            <dt><app-icon :icon="field.icon" :size="15" />{{ $t(field.t) }}</dt>
            <dd>{{ DateUtils.dateToUI(split[field.code]) }}</dd>
          </div>
          <div v-if="split.amountForeign ?? split.foreign_amount" class="todo-inbox-property">
            <dt><app-icon :icon="TablerIconConstants.currency" :size="15" />{{ $t('amount') }} · {{ split.foreign_currency_code }}</dt>
            <dd>{{ formatAmount(split.amountForeign ?? split.foreign_amount, locale) }} {{ split.foreign_currency_symbol ?? split.foreign_currency_code }}</dd>
          </div>
        </dl>
      </div>
      <div class="todo-inbox-note-panel">
        <div class="todo-inbox-note-heading">
          <span><app-icon :icon="TablerIconConstants.fieldText1" :size="15" />{{ $t('notes') }}</span>
          <van-button v-if="split.notes" size="mini" plain class="todo-inbox-action" :aria-pressed="Boolean(sourceNotes[index])" @click="sourceNotes[index] = !sourceNotes[index]">
            {{ sourceNotes[index] ? $t('todo_inbox.rendered') : $t('todo_inbox.source') }}
          </van-button>
        </div>
        <span v-if="!split.notes" class="todo-inbox-empty">{{ $t('todo_inbox.none') }}</span>
        <pre v-else-if="sourceNotes[index]" class="todo-inbox-note-source">{{ split.notes }}</pre>
        <div v-else class="todo-inbox-markdown" v-html="renderTodoNotes(split.notes)" />
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import Budget from '~/models/Budget.js'
import Transaction from '~/models/Transaction.js'
import DateUtils from '~/utils/DateUtils.js'
import TablerIconConstants from '~/constants/TablerIconConstants.js'
import { transactionExtraDateFieldList } from '~/constants/TransactionConstants.js'
import { formatAmount } from '~/utils/AmountUtils.js'
import { getTodoReviewAmounts, renderTodoNotes } from '~/utils/TodoReviewUtils.js'

const props = defineProps({ transaction: { type: Object, required: true } })
const profileStore = useProfileStore()
const { locale } = useI18n()
const splits = computed(() => Transaction.getSplits(props.transaction))
const sourceNotes = ref({})
</script>
