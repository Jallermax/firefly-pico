import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { chunk, cloneDeep, get } from 'lodash-es'
import { useLocalStorage } from '@vueuse/core'
import Tag from '~/core/models/Tag'
import Transaction from '~/core/models/Transaction'
import TagRepository from '~/core/repository/TagRepository'
import TransactionRepository from '~/core/repository/TransactionRepository'
import TransactionTransformer from '~/core/transformers/TransactionTransformer'
import TransactionFilterUtils from '~/core/utils/TransactionFilterUtils'
import { areIntEqual } from '~/core/utils/DataUtils'
import { getActiveFilters } from '~/core/utils/FilterUtils'
import { withoutDeleted } from '~/core/utils/DeleteUtils'
import UIUtils from '~/core/utils/UIUtils'
import { getTodoJournalIds, getTodoTagUpdate, isSameTransactionGroup } from '~/core/utils/TodoTagUpdate'
import { getTodoDateRange, loadTodoPage } from '~/core/utils/TodoInboxLoader'

// TODO Inbox: transactions tagged with the todo tag, reviewed one by one.
// "Mark as done" only removes the todo tag. What was marked as done stays listed for this session (not persisted),
// so it can be edited again or get its todo tag back.
// The one source for the inbox, its badges (sidebar, Extras) and the dashboard cards.
// Extra list filters (the transaction filters bag) narrow the inbox and are kept in localStorage.
export const useTodoStore = defineStore('todo', () => {
  const appStore = useAppStore()
  const todoList = ref([])
  const doneList = ref([])
  const isLoading = ref(false)
  const isFinished = ref(false)
  const loadError = ref(false)
  const dateRange = ref(null)
  let seenIds = new Set()
  let isFetched = false
  let lastLoadWasRefresh = true
  const removedTodoJournals = new Map()
  const pendingTagChanges = new Map()
  let listRevision = 0
  const connection = computed(() => ({
    picoBackendURL: appStore.picoBackendURL,
    authToken: appStore.authToken,
    picoBackendHeaders: (appStore.picoBackendHeaders ?? []).map(({ key, value }) => ({ key, value })),
    isDemoMode: appStore.isDemoMode,
  }))
  const todoTag = computed(() => useTagStore().tagTodo)
  const todoTagName = computed(() => Tag.getDisplayName(todoTag.value))

  const reviveDates = (bag) => ({ ...bag, dateStart: bag.dateStart && new Date(bag.dateStart), dateEnd: bag.dateEnd && new Date(bag.dateEnd) })
  const filters = useLocalStorage('todoInboxFilters', {}, { serializer: { read: (value) => reviveDates(JSON.parse(value)), write: JSON.stringify } })
  const activeFilters = computed(() => getActiveFilters(Object.values(TransactionFilterUtils.filters), filters.value))
  const setFilters = (value) => {
    filters.value = value ?? {}
    resetLoadedQueue()
    return fetchTodo()
  }

  const isTodoTag = (name) => name === todoTagName.value

  // The transformer swaps tag names for the synced tags: keep the raw names too, so saving never drops a tag Pico does not know yet
  const fromApi = (item) => {
    Transaction.getSplits(item).forEach((split) => (split.tagNames = [...(split.tags ?? [])]))
    return TransactionTransformer.transformFromApi(item)
  }

  const hasTodoTag = (transaction) => Transaction.getSplits(transaction).some((split) => (split.tagNames ?? []).some(isTodoTag))
  const without = (list, ids) => list.filter((item) => !ids.some((id) => areIntEqual(id, item.id)))
  const byDateDesc = (a, b) => Transaction.getDate(b) - Transaction.getDate(a)

  // Rows hidden behind a pending Undo delete are not shown or counted
  const visibleTodoList = computed(() => withoutDeleted(todoList.value))
  const visibleDoneList = computed(() => withoutDeleted(doneList.value))
  const totalCount = computed(() => visibleTodoList.value.length + visibleDoneList.value.length)

  // Loaded once at app start for the badges; the dashboard, the inbox page and its actions refresh it
  const fetchTodoOnce = () => isFetched || fetchTodo()
  const fetchTodo = () => loadTodo(true)
  const loadMore = () => loadTodo(!isFetched)
  const retryLoad = () => loadTodo(lastLoadWasRefresh)

  function resetLoadedQueue() {
    isFetched = false
    isFinished.value = false
    loadError.value = false
    dateRange.value = null
    todoList.value = []
    seenIds = new Set()
  }

  watch(
    [connection, todoTagName],
    () => {
      listRevision++
      resetLoadedQueue()
      doneList.value = []
      removedTodoJournals.clear()
      pendingTagChanges.clear()
    },
    { flush: 'sync' },
  )

  const inboxRequest = computed(() => ({
    connection: connection.value,
    tagName: todoTagName.value,
    tagId: todoTag.value?.id,
    dateStart: filters.value.dateStart,
    dateEnd: filters.value.dateEnd,
    extraFilters: activeFilters.value.filter(({ bagKey }) => bagKey !== 'dateStart' && bagKey !== 'dateEnd').map(({ filter }) => filter),
  }))

  async function loadTodo(refresh) {
    if (isLoading.value || (!refresh && isFinished.value)) return
    const request = inboxRequest.value
    if (!request.tagName) {
      isFinished.value = true
      return
    }
    isLoading.value = true
    loadError.value = false
    lastLoadWasRefresh = refresh
    const revision = listRevision
    const isCurrent = () => request === inboxRequest.value && revision === listRevision
    try {
      const range = getTodoDateRange(request)
      const transactions = new TransactionRepository()
      const tags = new TagRepository()
      const tagQuery = TransactionFilterUtils.filters.tag.filter(todoTag.value)
      const existingIds = refresh ? new Set() : new Set([...seenIds, ...todoList.value.map(({ id }) => String(id))])
      const result = await loadTodoPage({
        range,
        tagName: request.tagName,
        seenIds: existingIds,
        readPage: (window) => {
          if (!isCurrent()) return
          if (!request.extraFilters.length) return tags.getTodoTransactions(request.tagId ?? request.tagName, window, request.connection)
          const query = [tagQuery, `date_after:${window.start}`, `date_before:${window.end}`, ...request.extraFilters].join(' ')
          return transactions.searchTodoTransactions(query, window, request.connection)
        },
        readGroup: async (id) => {
          if (!isCurrent()) return null
          const response = await transactions.getTodoTransactionResponse(id, request.connection)
          if (response?.status === 404) return null
          const group = get(response, 'data.data')
          if (response?.status !== 200 || String(group?.id) !== id || !Transaction.getSplits(group).length) throw new Error('Could not read TODO transaction group')
          return group
        },
      })
      if (isCurrent()) {
        const items = result.items.map(fromApi)
        todoList.value = refresh ? items : [...todoList.value, ...items]
        const ids = items.map(({ id }) => id)
        ids.forEach((id) => removedTodoJournals.delete(String(id)))
        doneList.value = without(doneList.value, ids)
        seenIds = result.seenIds
        isFinished.value = result.isFinished
        dateRange.value = range
        isFetched = true
      }
    } catch {
      if (isCurrent()) loadError.value = true
    } finally {
      isLoading.value = false
    }
    if (!isCurrent()) return loadTodo(refresh || request !== inboxRequest.value)
  }

  // Search results can omit splits, and their tags can change while the Inbox is open.
  async function updateTags(transaction, isTodo, activeConnection, tagName) {
    const isCurrent = () => activeConnection === connection.value && tagName === todoTagName.value
    if (!isCurrent()) return false
    const id = String(transaction.id)
    if (pendingTagChanges.has(id)) return true
    pendingTagChanges.set(id, activeConnection)
    try {
      const repository = new TransactionRepository()
      const latest = await repository.getTodoTransaction(id, activeConnection)
      if (!isCurrent() || String(latest?.id) !== id) return false
      const receipt = removedTodoJournals.get(id)
      const journalIds = isTodo ? (receipt?.tagName === tagName ? receipt.journalIds : []) : getTodoJournalIds(latest, tagName)
      const update = getTodoTagUpdate(latest, tagName, journalIds, isTodo)
      if (!update) return false

      const response = await repository.updateTodoTags(id, update, activeConnection)
      if (!isCurrent() || (response?.status >= 400 && response.status < 500)) return false
      // A response can go missing after Firefly applied the write. Read it back instead of retrying.
      let saved = get(response, 'data.data')
      if (!isSameTransactionGroup(latest, saved)) saved = await repository.getTodoTransaction(id, activeConnection)
      if (!isCurrent() || !isSameTransactionGroup(latest, saved)) return false
      const markedIds = getTodoJournalIds(saved, tagName)
      if (isTodo ? !journalIds.every((journalId) => markedIds.includes(journalId)) : markedIds.length > 0) return false

      onSaved(fromApi(saved), { tagName, journalIds })
      return true
    } finally {
      if (pendingTagChanges.get(id) === activeConnection) pendingTagChanges.delete(id)
    }
  }

  // A few requests at a time; the user hears about the ones that failed
  async function setTodo(transactions, isTodo) {
    const activeConnection = connection.value
    const tagName = todoTagName.value
    if (!tagName) return
    let failedCount = 0
    for (const batch of chunk(transactions, 5)) {
      if (activeConnection !== connection.value || tagName !== todoTagName.value) return
      const results = await Promise.all(batch.map((transaction) => updateTags(transaction, isTodo, activeConnection, tagName)))
      failedCount += results.filter((result) => !result).length
    }
    if (failedCount && activeConnection === connection.value && tagName === todoTagName.value) UIUtils.showToastError(useNuxtApp().$i18n.t('todo_page.some_failed', { count: failedCount }))
  }

  const markDone = (transactions) => setTodo(transactions, false)
  const putBack = (transactions) => setTodo(transactions, true)

  // A transaction saved anywhere in the inbox goes to the list its tags say
  function onSaved(transaction, receipt) {
    if (!transaction) return
    listRevision++
    const isTodo = hasTodoTag(transaction)
    const ids = [transaction.id]
    const id = String(transaction.id)
    if (isTodo) {
      removedTodoJournals.delete(id)
    } else if (receipt) {
      removedTodoJournals.set(id, receipt)
    } else {
      // A regular save can also remove the marker. Retain the known journal IDs for Put Back.
      const previous = todoList.value.find((item) => areIntEqual(item.id, id))
      const journalIds = Transaction.getSplits(previous)
        .filter((split) => split.transaction_journal_id && split.tagNames?.some(isTodoTag))
        .map((split) => String(split.transaction_journal_id))
      if (journalIds.length) removedTodoJournals.set(id, { tagName: Tag.getDisplayName(useTagStore().tagTodo), journalIds })
    }
    todoList.value = isTodo ? [...without(todoList.value, ids), transaction].sort(byDateDesc) : without(todoList.value, ids)
    doneList.value = isTodo ? without(doneList.value, ids) : [transaction, ...without(doneList.value, ids)]
  }

  function onDeleted(id) {
    listRevision++
    removedTodoJournals.delete(String(id))
    todoList.value = without(todoList.value, [id])
    doneList.value = without(doneList.value, [id])
  }

  // The editor works on its own copy, with the todo tag taken off for "Save & done"
  function withoutTodoTag(transaction) {
    const result = cloneDeep(transaction)
    Transaction.getSplits(result).forEach((split) => (split.tags = (split.tags ?? []).filter((tag) => !get(tag, 'attributes.is_todo'))))
    return result
  }

  return {
    todoList,
    doneList,
    visibleTodoList,
    visibleDoneList,
    isLoading,
    isFinished,
    loadError,
    dateRange,
    totalCount,
    filters,
    activeFilters,
    setFilters,
    fetchTodo,
    fetchTodoOnce,
    loadMore,
    retryLoad,
    markDone,
    putBack,
    onSaved,
    onDeleted,
    fromApi,
    withoutTodoTag,
  }
})
