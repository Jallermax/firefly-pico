<template>
  <div class="app-form todo-inbox-page" :class="{ empty: showEmptyState || !hasMarkerConfiguration }">
    <app-top-toolbar>
      <template v-if="appStore.isDesktopLayout && hasMarkerConfiguration" #right>
        <div class="todo-inbox-page-actions">
          <van-button size="small" plain class="todo-inbox-action" :disabled="isLoading || activeItems.length === 0 || isAnyItemProcessing" :loading="isBatchRunning" @click="markPageDone">
            <app-icon :icon="TablerIconConstants.booleanCheckOn" :size="17" />
            {{ $t('todo_inbox.mark_page_done') }}
          </van-button>
        </div>
      </template>
    </app-top-toolbar>

    <empty-list v-if="!hasMarkerConfiguration" :title="$t('todo_inbox.marker_not_configured')" :subtitle="$t('todo_inbox.marker_not_configured_help')">
      <template #action>
        <app-tutorial v-bind="TUTORIAL_CONSTANTS.todoTag" />
      </template>
    </empty-list>

    <template v-else>
      <van-cell-group v-if="!appStore.isDesktopLayout" inset class="todo-inbox-controls">
        <div class="todo-inbox-page-actions">
          <van-button size="small" plain class="todo-inbox-action" :disabled="isLoading || activeItems.length === 0 || isAnyItemProcessing" :loading="isBatchRunning" @click="markPageDone">
            <app-icon :icon="TablerIconConstants.booleanCheckOn" :size="17" />
            {{ $t('todo_inbox.mark_page_done') }}
          </van-button>
        </div>
      </van-cell-group>

      <div v-if="batchProgress" class="todo-inbox-status todo-inbox-batch-progress">
        {{
          $t('todo_inbox.batch_progress', {
            processed: batchProgress.processed,
            total: batchProgress.total,
            successful: batchProgress.successful,
            failed: batchProgress.failed,
          })
        }}
      </div>
      <div v-else-if="batchResult" class="todo-inbox-status">
        {{ $t('todo_inbox.batch_result', { successful: batchResult.successful, failed: batchResult.failed }) }}
      </div>

      <div v-if="loadError" class="todo-inbox-load-error">
        <app-icon :icon="TablerIconConstants.close" :size="20" />
        <span>{{ loadError }}</span>
        <van-button size="small" plain type="danger" :loading="isLoading" @click="loadPage(page)">{{ $t('todo_inbox.retry') }}</van-button>
      </div>

      <empty-list v-else-if="showEmptyState" :title="$t('todo_inbox.empty')" :subtitle="$t('todo_inbox.empty_help')" />

      <div v-else-if="items.length > 0" class="todo-inbox-list-wrapper">
        <div ref="listElement" class="todo-inbox-list" :inert="isLoading" :aria-busy="isLoading">
          <todo-inbox-transaction-item
            v-for="item in items"
            :key="item.id"
            :value="item"
            :is-expanded="expandedIds.has(String(item.id))"
            :is-processing="getState(item.id).isProcessing"
            :is-queued="getState(item.id).isQueued"
            :error="getState(item.id).error"
            :receipt="receiptById[String(item.id)]"
            @edit="openEditor"
            @toggle="toggleExpanded"
            @done="onDone"
            @retry="onDone"
            @undo="onUndo"
          />
        </div>
      </div>

      <div v-if="receipts.length > 0" class="todo-inbox-continue">
        <span>{{ $t('todo_inbox.continue_help') }}</span>
        <van-button type="primary" size="small" :loading="isLoading" :disabled="isBatchRunning || isAnyItemProcessing" @click="continuePage">
          {{ $t('todo_inbox.continue') }}
        </van-button>
      </div>

      <van-pagination
        v-if="isLoaded && !loadError && totalPages > 1"
        class="todo-inbox-pagination"
        :model-value="page"
        :total-items="totalCount"
        :items-per-page="pageSize"
        :page-count="totalPages"
        :mode="appStore.isDesktopLayout ? 'multi' : 'simple'"
        :disabled="isPageLocked || isLoading"
        :prev-text="$t('todo_inbox.previous')"
        :next-text="$t('todo_inbox.next')"
        @change="changePage"
      />
      <div v-if="isLoaded" class="todo-inbox-page-actions todo-inbox-period-navigation">
        <van-button size="small" plain class="todo-inbox-action" :disabled="periodIndex === 0 || isPageLocked || isLoading || editorOpen" @click="newerPeriod">{{ $t('todo_inbox.newer') }}</van-button>
        <span>{{ periodLabel }}</span>
        <van-button size="small" plain class="todo-inbox-action" :disabled="isPageLocked || isLoading || editorOpen" @click="olderPeriod">{{ $t('todo_inbox.older') }}</van-button>
      </div>
    </template>

    <app-popup :show="editorOpen" :close-on-click-overlay="false" :popup-style="editorPopupStyle" @update:show="onEditorVisibilityChange">
      <div class="todo-inbox-editor-header">
        <strong>{{ $t(editorItem && Transaction.isSplitPayment(editorItem) ? 'transaction.title_split_details' : 'transaction.title_edit_transaction') }}</strong>
        <van-button size="small" plain class="todo-inbox-action" :disabled="editorSaving || editorLoading" @click="closeEditor">{{ $t('todo_inbox.close_editor') }}</van-button>
      </div>
      <div class="todo-inbox-editor-body" :inert="editorSaving">
        <van-loading v-if="editorLoading" class="todo-inbox-editor-loading" />
        <transaction-form v-else-if="editorItem" ref="editorForm" v-model="editorItem" :disabled="editorSaving || editorUnconfirmed" @submit="onEditorSave" />
      </div>
      <div v-if="editorItem || editorError" class="todo-inbox-editor-footer">
        <div v-if="editorError" class="todo-inbox-item-error" role="alert">{{ editorError }}</div>
        <van-button v-if="editorItem && !Transaction.isSplitPayment(editorItem)" block type="primary" :loading="editorSaving" :disabled="editorUnconfirmed" @click="editorForm?.submit()">{{
          $t('save')
        }}</van-button>
      </div>
    </app-popup>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useTodoInbox } from '~/composables/useTodoInbox.js'
import { useToolbar } from '~/composables/useToolbar.js'
import RouteConstants from '~/constants/RouteConstants.js'
import TablerIconConstants from '~/constants/TablerIconConstants.js'
import { TUTORIAL_CONSTANTS } from '~/constants/TutorialConstants.js'
import Transaction from '~/models/Transaction.js'
import DateUtils from '~/utils/DateUtils.js'

const appStore = useAppStore()
const profileStore = useProfileStore()
const { t } = useI18n()
const {
  items,
  receipts,
  receiptById,
  activeItems,
  remainingCount,
  markerName,
  hasMarkerConfiguration,
  expandedIds,
  page,
  periodIndex,
  periodRange,
  pageSize,
  totalPages,
  totalCount,
  isLoading,
  isLoaded,
  loadError,
  isPageLocked,
  isAnyItemProcessing,
  isBatchRunning,
  batchProgress,
  batchResult,
  getState,
  loadPage,
  changePage,
  olderPeriod,
  newerPeriod,
  continuePage,
  editorOpen,
  editorItem,
  editorSaving,
  editorLoading,
  editorError,
  editorUnconfirmed,
  openEditor,
  saveEditor,
  closeEditor,
  toggleExpanded,
  doneItem,
  undoItem,
  markPageDone,
} = useTodoInbox()

const showEmptyState = computed(() => isLoaded.value && !isLoading.value && !loadError.value && items.value.length === 0)
const listElement = ref(null)
const editorForm = ref(null)
const editorPopupStyle = computed(() => ({
  height: appStore.isDesktopLayout ? 'min(90vh, 780px)' : '94%',
  maxHeight: '94vh',
  width: appStore.isDesktopLayout ? 'min(940px, 92vw)' : undefined,
  padding: 0,
}))
watch(
  () => items.value.map((item) => ({ id: String(item.id), pending: getState(item.id).isProcessing || getState(item.id).isQueued })),
  async (current, previous) => {
    const settledIds = previous.filter((item) => item.pending && !current.find((next) => next.id === item.id)?.pending).map((item) => item.id)
    if (!settledIds.length || !listElement.value) return
    const anchor = [...listElement.value.children].find(
      (element) => !settledIds.includes(element.dataset.todoId) && element.getBoundingClientRect().bottom > 0 && element.getBoundingClientRect().top < window.innerHeight,
    )
    if (!anchor) return
    const top = anchor.getBoundingClientRect().top
    await nextTick()
    if (anchor.isConnected) window.scrollBy({ top: anchor.getBoundingClientRect().top - top, behavior: 'instant' })
  },
)
const periodLabel = computed(
  () =>
    `${DateUtils.stringFromTo(periodRange.value.start, DateUtils.FORMAT_ENGLISH_DATE, profileStore.dateFormat)}–${DateUtils.stringFromTo(periodRange.value.end, DateUtils.FORMAT_ENGLISH_DATE, profileStore.dateFormat)}`,
)
const toolbarSubtitle = computed(() => (hasMarkerConfiguration.value ? `${markerName.value} · ${periodLabel.value} · ${t('todo_inbox.remaining_items', { count: remainingCount.value })}` : null))

const onDone = (item) => doneItem(item).catch(() => {})
const onUndo = (item) => undoItem(item).catch(() => {})
const onEditorVisibilityChange = (show) => {
  if (!show) closeEditor()
}
const onEditorSave = async () => {
  const row = listElement.value?.querySelector(`[data-todo-id="${editorItem.value?.id}"]`)
  const anchor = row?.nextElementSibling
  const top = anchor?.getBoundingClientRect().top
  if (await saveEditor()) {
    await nextTick()
    if (anchor?.isConnected && top > 0 && top < window.innerHeight) window.scrollBy({ top: anchor.getBoundingClientRect().top - top, behavior: 'instant' })
  }
}

useToolbar().init({
  title: t('todo_inbox.title'),
  subtitle: toolbarSubtitle,
  backRoute: RouteConstants.ROUTE_DASHBOARD,
})

onMounted(() => loadPage(1))
</script>
