import { cloneDeep, get } from 'lodash-es'
import { computed, reactive, ref } from 'vue'
import RouteConstants from '~/constants/RouteConstants.js'
import Tag from '~/models/Tag.js'
import TagRepository from '~/repository/TagRepository.js'
import TransactionRepository from '~/repository/TransactionRepository.js'
import TransactionTransformer from '~/transformers/TransactionTransformer.js'
import ResponseUtils from '~/utils/ResponseUtils.js'
import UIUtils from '~/utils/UIUtils.js'
import {
  TODO_BATCH_CONCURRENCY,
  TODO_PAGE_SIZE,
  buildTodoRemovalRequest,
  buildTodoRestoreRequest,
  getActiveTodoItems,
  getSafeTodoPage,
  hasTodoMarker,
  hasTodoMarkerOnJournals,
  isTodoPageLocked,
  runWithConcurrency,
} from '~/utils/TodoTransactionUtils.js'

export function useTodoInbox() {
  const appStore = useAppStore()
  const tagStore = useTagStore()
  const { t } = useI18n()
  const tagRepository = new TagRepository()
  const transactionRepository = new TransactionRepository()

  const items = ref([])
  const receipts = ref([])
  const expandedIds = ref(new Set())
  const page = ref(1)
  const pageSize = ref(TODO_PAGE_SIZE)
  const totalPages = ref(1)
  const totalCount = ref(0)
  const isLoading = ref(false)
  const isLoaded = ref(false)
  const loadError = ref(null)
  const isBatchRunning = ref(false)
  const batchProgress = ref(null)
  const batchResult = ref(null)
  const itemState = reactive({})
  const wasEditing = ref(false)

  const markerName = computed(() => Tag.getDisplayName(tagStore.tagTodo))
  const hasMarkerConfiguration = computed(() => Boolean(markerName.value))
  const receiptById = computed(() => Object.fromEntries(receipts.value.map((receipt) => [String(receipt.id), receipt])))
  const activeItems = computed(() => getActiveTodoItems(items.value, receipts.value))
  const remainingCount = computed(() => Math.max(0, totalCount.value - receipts.value.length))
  const isAnyItemProcessing = computed(() => Object.values(itemState).some((state) => state.isProcessing))
  const isPageLocked = computed(() => isTodoPageLocked(receipts.value, isBatchRunning.value, isAnyItemProcessing.value))
  const areAllExpanded = computed(() => activeItems.value.length > 0 && activeItems.value.every((item) => expandedIds.value.has(String(item.id))))

  const getState = (id) => itemState[String(id)] ?? { isProcessing: false, error: null }

  const setState = (id, values) => {
    const key = String(id)
    itemState[key] = { ...getState(key), ...values }
  }

  const clearState = () => {
    Object.keys(itemState).forEach((id) => delete itemState[id])
  }

  const getResponseError = (response, fallbackKey) => get(response, 'data.message') ?? get(response, 'data.errors.0.detail') ?? t(fallbackKey)
  const getResponseTransaction = (response) => get(response, 'data.data')

  const transformTransaction = (transaction) => TransactionTransformer.transformFromApi(cloneDeep(transaction))

  const fetchPage = async (requestedPage) => {
    const response = await tagRepository.getTodoTransactions(tagStore.tagTodo, {
      page: requestedPage,
      pageSize: TODO_PAGE_SIZE,
    })
    if (!ResponseUtils.isSuccess(response)) {
      throw new Error(getResponseError(response, 'todo_inbox.load_error'))
    }

    const responseBody = get(response, 'data', {})
    const pagination = get(responseBody, 'meta.pagination', {})
    return {
      items: TransactionTransformer.transformFromApiList(cloneDeep(get(responseBody, 'data', []))),
      page: Number(get(pagination, 'current_page', requestedPage)) || requestedPage,
      pageSize: Number(get(pagination, 'per_page', TODO_PAGE_SIZE)) || TODO_PAGE_SIZE,
      totalPages: Math.max(1, Number(get(pagination, 'total_pages', 1)) || 1),
      totalCount: Math.max(0, Number(get(pagination, 'total', 0)) || 0),
    }
  }

  const applyPage = (result, { clearReceipts = false } = {}) => {
    items.value = result.items
    page.value = result.page
    pageSize.value = result.pageSize
    totalPages.value = result.totalPages
    totalCount.value = result.totalCount
    expandedIds.value = appStore.isDesktopLayout ? new Set(result.items.map((item) => String(item.id))) : new Set()
    clearState()
    batchProgress.value = null
    batchResult.value = null
    if (clearReceipts) {
      receipts.value = []
    }
  }

  const loadPage = async (requestedPage = page.value, options = {}) => {
    if (!hasMarkerConfiguration.value || isLoading.value) {
      return false
    }

    isLoading.value = true
    loadError.value = null
    try {
      let result = await fetchPage(Math.max(1, Number(requestedPage) || 1))
      const safePage = getSafeTodoPage(requestedPage, result.totalPages)
      if (safePage !== result.page) {
        result = await fetchPage(safePage)
      }
      applyPage(result, options)
      isLoaded.value = true
      return true
    } catch (error) {
      loadError.value = error.message || t('todo_inbox.load_error')
      isLoaded.value = true
      return false
    } finally {
      isLoading.value = false
    }
  }

  const removeStaleItem = (item, messageKey) => {
    items.value = items.value.filter((currentItem) => String(currentItem.id) !== String(item.id))
    totalCount.value = Math.max(0, totalCount.value - 1)
    UIUtils.showToastSuccess(t(messageKey))
  }

  const addReceipt = (item, journalIds) => {
    const receipt = {
      id: String(item.id),
      item,
      journalIds,
      markerName: markerName.value,
    }
    receipts.value = [...receipts.value.filter((currentReceipt) => String(currentReceipt.id) !== String(item.id)), receipt]
    expandedIds.value = new Set([...expandedIds.value].filter((id) => id !== String(item.id)))
  }

  const doneItem = async (item) => {
    const id = String(item.id)
    if (getState(id).isProcessing) {
      return { status: 'ignored' }
    }

    setState(id, { isProcessing: true, error: null })
    try {
      const latestResponse = await transactionRepository.getTodoTransaction(id)
      if (get(latestResponse, 'status') === 404) {
        removeStaleItem(item, 'todo_inbox.transaction_deleted')
        return { status: 'stale' }
      }
      if (!ResponseUtils.isSuccess(latestResponse)) {
        throw new Error(getResponseError(latestResponse, 'todo_inbox.item_error'))
      }

      const latestTransaction = getResponseTransaction(latestResponse)
      if (!hasTodoMarker(latestTransaction, markerName.value)) {
        removeStaleItem(item, 'todo_inbox.completed_elsewhere')
        return { status: 'stale' }
      }

      const { journalIds, requestData } = buildTodoRemovalRequest(latestTransaction, markerName.value)
      const updateResponse = await transactionRepository.updateTodoTags(id, requestData)
      if (!ResponseUtils.isSuccess(updateResponse)) {
        throw new Error(getResponseError(updateResponse, 'todo_inbox.item_error'))
      }

      const updatedTransaction = getResponseTransaction(updateResponse)
      if (!updatedTransaction || hasTodoMarker(updatedTransaction, markerName.value)) {
        throw new Error(t('todo_inbox.marker_still_present'))
      }

      addReceipt(item, journalIds)
      return { status: 'completed' }
    } catch (error) {
      setState(id, { error: error.message || t('todo_inbox.item_error') })
      throw error
    } finally {
      setState(id, { isProcessing: false })
    }
  }

  const undoItem = async (item) => {
    const id = String(item.id)
    const receipt = receiptById.value[id]
    if (!receipt || getState(id).isProcessing) {
      return false
    }

    setState(id, { isProcessing: true, error: null })
    try {
      const latestResponse = await transactionRepository.getTodoTransaction(id)
      if (!ResponseUtils.isSuccess(latestResponse)) {
        throw new Error(getResponseError(latestResponse, 'todo_inbox.item_error'))
      }

      const latestTransaction = getResponseTransaction(latestResponse)
      const restoration = buildTodoRestoreRequest(latestTransaction, receipt.markerName, receipt.journalIds)
      if (restoration.restoredJournalIds.length === 0) {
        throw new Error(t('todo_inbox.undo_missing_splits'))
      }

      let restoredTransaction = latestTransaction
      if (!restoration.isAlreadyRestored) {
        const updateResponse = await transactionRepository.updateTodoTags(id, restoration.requestData)
        if (!ResponseUtils.isSuccess(updateResponse)) {
          throw new Error(getResponseError(updateResponse, 'todo_inbox.item_error'))
        }
        restoredTransaction = getResponseTransaction(updateResponse)
      }

      if (!restoredTransaction || !hasTodoMarkerOnJournals(restoredTransaction, receipt.markerName, restoration.restoredJournalIds)) {
        throw new Error(t('todo_inbox.marker_missing'))
      }

      const index = items.value.findIndex((currentItem) => String(currentItem.id) === id)
      if (index >= 0) {
        items.value[index] = transformTransaction(restoredTransaction)
      }
      receipts.value = receipts.value.filter((currentReceipt) => String(currentReceipt.id) !== id)
      if (appStore.isDesktopLayout) {
        expandedIds.value = new Set([...expandedIds.value, id])
      }
      if (restoration.missingJournalIds.length > 0) {
        UIUtils.showToastError(t('todo_inbox.undo_partial', { count: restoration.missingJournalIds.length }))
      }
      return true
    } catch (error) {
      setState(id, { error: error.message || t('todo_inbox.item_error') })
      throw error
    } finally {
      setState(id, { isProcessing: false })
    }
  }

  const markPageDone = async () => {
    const targets = [...activeItems.value]
    if (targets.length === 0 || isBatchRunning.value || isAnyItemProcessing.value) {
      return false
    }

    const confirmed = await UIUtils.showConfirmation(t('todo_inbox.confirm_title'), t('todo_inbox.confirm_message', { count: targets.length, marker: markerName.value }))
    if (!confirmed) {
      return false
    }

    isBatchRunning.value = true
    batchResult.value = null
    batchProgress.value = { processed: 0, total: targets.length, successful: 0, failed: 0 }
    try {
      const results = await runWithConcurrency(targets, TODO_BATCH_CONCURRENCY, doneItem, ({ processed, total, result }) => {
        batchProgress.value = {
          processed,
          total,
          successful: batchProgress.value.successful + (result.status === 'fulfilled' ? 1 : 0),
          failed: batchProgress.value.failed + (result.status === 'rejected' ? 1 : 0),
        }
      })
      const failed = results.filter((result) => result.status === 'rejected').length
      batchResult.value = { successful: results.length - failed, failed, total: results.length }
      batchProgress.value = null
      return failed === 0
    } finally {
      isBatchRunning.value = false
    }
  }

  const continuePage = async () => {
    if (isBatchRunning.value || receipts.value.length === 0) {
      return false
    }
    return await loadPage(page.value, { clearReceipts: true })
  }

  const changePage = async (newPage) => {
    if (isPageLocked.value) {
      return false
    }
    return await loadPage(newPage)
  }

  const toggleExpanded = (item) => {
    const id = String(item.id)
    const next = new Set(expandedIds.value)
    next.has(id) ? next.delete(id) : next.add(id)
    expandedIds.value = next
  }

  const toggleAll = () => {
    const activeIds = activeItems.value.map((item) => String(item.id))
    expandedIds.value = areAllExpanded.value ? new Set([...expandedIds.value].filter((id) => !activeIds.includes(id))) : new Set([...expandedIds.value, ...activeIds])
  }

  const editItem = async (item) => {
    wasEditing.value = true
    await navigateTo(`${RouteConstants.ROUTE_TRANSACTION_ID}/${item.id}`)
  }

  const refreshAfterEditor = async () => {
    if (!wasEditing.value) {
      return false
    }
    wasEditing.value = false
    return await loadPage(page.value, { clearReceipts: true })
  }

  return {
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
    isAnyItemProcessing,
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
  }
}
