<template>
  <div class="app-form todo-inbox-page" :class="{ empty: showEmptyState || !hasMarkerConfiguration }">
    <app-top-toolbar />

    <empty-list v-if="!hasMarkerConfiguration" :title="$t('todo_inbox.marker_not_configured')" :subtitle="$t('todo_inbox.marker_not_configured_help')">
      <template #action>
        <app-tutorial v-bind="TUTORIAL_CONSTANTS.todoTag" />
      </template>
    </empty-list>

    <template v-else>
      <van-cell-group inset class="todo-inbox-controls">
        <van-cell>
          <template #title>
            <div class="todo-inbox-context">
              <div class="todo-inbox-marker">
                <app-icon :icon="TablerIconConstants.tag" :size="16" />
                <span>{{ markerName }}</span>
              </div>
              <span class="text-muted">{{ $t('todo_inbox.all_history') }}</span>
            </div>
          </template>
          <template #value>
            <span>{{ $t('todo_inbox.remaining_items', { count: remainingCount }) }}</span>
          </template>
        </van-cell>

        <div class="todo-inbox-page-actions">
          <van-button size="small" plain :disabled="activeItems.length === 0 || isBatchRunning" @click="toggleAll">
            {{ areAllExpanded ? $t('todo_inbox.collapse_all') : $t('todo_inbox.expand_all') }}
          </van-button>
          <van-button size="small" type="primary" :disabled="activeItems.length === 0" :loading="isBatchRunning" @click="markPageDone">
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

      <div v-else-if="items.length > 0" class="todo-inbox-list" :class="{ 'transaction-desktop-list': appStore.isDesktopLayout }">
        <todo-inbox-transaction-item
          v-for="item in items"
          :key="item.id"
          :value="item"
          :is-expanded="expandedIds.has(String(item.id))"
          :is-processing="getState(item.id).isProcessing"
          :error="getState(item.id).error"
          :receipt="receiptById[String(item.id)]"
          @edit="editItem"
          @toggle="toggleExpanded"
          @done="onDone"
          @retry="onDone"
          @undo="onUndo"
        />
      </div>

      <div v-if="receipts.length > 0" class="todo-inbox-continue">
        <span>{{ $t('todo_inbox.continue_help') }}</span>
        <van-button type="primary" size="small" :loading="isLoading" :disabled="isBatchRunning" @click="continuePage">
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
    </template>
  </div>
</template>

<script setup>
import { computed, onActivated, onMounted } from 'vue'
import { useTodoInbox } from '~/composables/useTodoInbox.js'
import { useToolbar } from '~/composables/useToolbar.js'
import RouteConstants from '~/constants/RouteConstants.js'
import TablerIconConstants from '~/constants/TablerIconConstants.js'
import { TUTORIAL_CONSTANTS } from '~/constants/TutorialConstants.js'

const appStore = useAppStore()
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
  areAllExpanded,
  page,
  pageSize,
  totalPages,
  totalCount,
  isLoading,
  isLoaded,
  loadError,
  isPageLocked,
  isBatchRunning,
  batchProgress,
  batchResult,
  getState,
  loadPage,
  changePage,
  continuePage,
  editItem,
  refreshAfterEditor,
  toggleExpanded,
  toggleAll,
  doneItem,
  undoItem,
  markPageDone,
} = useTodoInbox()

const showEmptyState = computed(() => isLoaded.value && !isLoading.value && !loadError.value && items.value.length === 0)
const toolbarSubtitle = computed(() => (hasMarkerConfiguration.value ? t('todo_inbox.page_context', { page: page.value, total: totalPages.value, count: remainingCount.value }) : null))

const onDone = (item) => doneItem(item).catch(() => {})
const onUndo = (item) => undoItem(item).catch(() => {})

useToolbar().init({
  title: t('todo_inbox.title'),
  subtitle: toolbarSubtitle,
  backRoute: RouteConstants.ROUTE_DASHBOARD,
})

onMounted(() => loadPage(1))
onActivated(() => refreshAfterEditor())
</script>
