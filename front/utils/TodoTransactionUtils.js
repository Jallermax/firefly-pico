export const TODO_PAGE_SIZE = 50
export const TODO_BATCH_CONCURRENCY = 3
export const TODO_QUERY_TIMEOUT = 60000

const getSplits = (transaction) => transaction?.attributes?.transactions ?? []
const getTags = (split) => split?.tags ?? []
const getJournalKey = (id) => String(id)
const hasMarker = (split, markerName) => getTags(split).includes(markerName)

const getRequestData = (transactions) => ({
  apply_rules: true,
  fire_webhooks: true,
  transactions,
})

export const buildTodoTransactionsPath = (tag) => `api/tags/${encodeURIComponent(typeof tag === 'object' ? (tag?.id ?? tag?.attributes?.tag) : tag)}/transactions`

export const getTodoJournalIds = (transaction, markerName) =>
  getSplits(transaction)
    .filter((split) => hasMarker(split, markerName))
    .map((split) => getJournalKey(split.transaction_journal_id))

export const hasTodoMarker = (transaction, markerName) => getTodoJournalIds(transaction, markerName).length > 0

export const hasTodoMarkerOnJournals = (transaction, markerName, journalIds) => {
  const splitByJournalId = new Map(getSplits(transaction).map((split) => [getJournalKey(split.transaction_journal_id), split]))
  const expectedJournalIds = [...new Set(journalIds.map(getJournalKey))]
  return expectedJournalIds.length > 0 && expectedJournalIds.every((journalId) => hasMarker(splitByJournalId.get(journalId), markerName))
}

export const buildTodoRemovalRequest = (transaction, markerName) => {
  const markedSplits = getSplits(transaction).filter((split) => hasMarker(split, markerName))

  return {
    journalIds: markedSplits.map((split) => getJournalKey(split.transaction_journal_id)),
    requestData: getRequestData(
      markedSplits.map((split) => ({
        transaction_journal_id: split.transaction_journal_id,
        tags: getTags(split).filter((tag) => tag !== markerName),
      })),
    ),
  }
}

export const buildTodoRestoreRequest = (transaction, markerName, journalIds) => {
  const requestedJournalIds = [...new Set(journalIds.map(getJournalKey))]
  const splitByJournalId = new Map(getSplits(transaction).map((split) => [getJournalKey(split.transaction_journal_id), split]))
  const restoredJournalIds = requestedJournalIds.filter((journalId) => splitByJournalId.has(journalId))
  const missingJournalIds = requestedJournalIds.filter((journalId) => !splitByJournalId.has(journalId))
  const transactions = restoredJournalIds
    .map((journalId) => splitByJournalId.get(journalId))
    .filter((split) => !hasMarker(split, markerName))
    .map((split) => ({
      transaction_journal_id: split.transaction_journal_id,
      tags: [...getTags(split), markerName],
    }))

  return {
    restoredJournalIds,
    missingJournalIds,
    isAlreadyRestored: restoredJournalIds.length > 0 && transactions.length === 0,
    requestData: getRequestData(transactions),
  }
}

export const getActiveTodoItems = (items, receipts) => {
  const receiptIds = new Set(receipts.map((receipt) => String(receipt.id)))
  return items.filter((item) => !receiptIds.has(String(item.id)))
}

export const getSafeTodoPage = (page, totalPages) => {
  const currentPage = Math.max(1, Number(page) || 1)
  const lastPage = Math.max(1, Number(totalPages) || 1)
  return Math.min(currentPage, lastPage)
}

export const isTodoPageLocked = (receipts, isBatchRunning, isItemProcessing = false) => receipts.length > 0 || isBatchRunning || isItemProcessing

export const runWithConcurrency = async (items, limit, worker, onProgress) => {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Concurrency limit must be a positive integer')
  }

  const results = new Array(items.length)
  let nextIndex = 0
  let processed = 0

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      let result

      try {
        result = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        result = { status: 'rejected', reason }
      }

      results[index] = result
      processed += 1
      onProgress?.({ processed, total: items.length, index, result })
    }
  }

  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, runWorker))
  return results
}
