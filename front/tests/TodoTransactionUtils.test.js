import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TODO_BATCH_CONCURRENCY,
  TODO_PAGE_SIZE,
  buildTodoRemovalRequest,
  buildTodoRestoreRequest,
  buildTodoTransactionsPath,
  getActiveTodoItems,
  getSafeTodoPage,
  getTodoJournalIds,
  hasTodoMarker,
  isTodoPageLocked,
  runWithConcurrency,
} from '../utils/TodoTransactionUtils.js'

const makeTransaction = () => ({
  id: '42',
  attributes: {
    transactions: [
      { transaction_journal_id: '101', tags: ['todo', 'imported'] },
      { transaction_journal_id: '102', tags: ['groceries'] },
      { transaction_journal_id: 103, tags: ['todo', 'family'] },
    ],
  },
})

test('builds a minimal removal request for marked journals only', () => {
  const result = buildTodoRemovalRequest(makeTransaction(), 'todo')

  assert.deepEqual(result.journalIds, ['101', '103'])
  assert.deepEqual(result.requestData, {
    apply_rules: true,
    fire_webhooks: true,
    transactions: [
      { transaction_journal_id: '101', tags: ['imported'] },
      { transaction_journal_id: 103, tags: ['family'] },
    ],
  })
})

test('preserves every unrelated tag while removing duplicate marker values', () => {
  const transaction = makeTransaction()
  transaction.attributes.transactions[0].tags = ['todo', 'imported', 'todo', 'personal']

  const result = buildTodoRemovalRequest(transaction, 'todo')

  assert.deepEqual(result.requestData.transactions[0].tags, ['imported', 'personal'])
})

test('returns no changed journals when the marker is already absent', () => {
  const transaction = makeTransaction()
  transaction.attributes.transactions.forEach((split) => {
    split.tags = split.tags.filter((tag) => tag !== 'todo')
  })

  assert.deepEqual(getTodoJournalIds(transaction, 'todo'), [])
  assert.equal(hasTodoMarker(transaction, 'todo'), false)
  assert.deepEqual(buildTodoRemovalRequest(transaction, 'todo').requestData.transactions, [])
})

test('restores the marker to surviving original journals without replacing current tags', () => {
  const transaction = makeTransaction()
  transaction.attributes.transactions[0].tags = ['imported', 'new-tag']
  transaction.attributes.transactions.splice(2, 1)

  const result = buildTodoRestoreRequest(transaction, 'todo', ['101', '103'])

  assert.deepEqual(result.restoredJournalIds, ['101'])
  assert.deepEqual(result.missingJournalIds, ['103'])
  assert.equal(result.isAlreadyRestored, false)
  assert.deepEqual(result.requestData, {
    apply_rules: true,
    fire_webhooks: true,
    transactions: [{ transaction_journal_id: '101', tags: ['imported', 'new-tag', 'todo'] }],
  })
})

test('does not duplicate a marker that is already restored', () => {
  const transaction = makeTransaction()

  const result = buildTodoRestoreRequest(transaction, 'todo', [101, 103])

  assert.equal(result.isAlreadyRestored, true)
  assert.deepEqual(result.restoredJournalIds, ['101', '103'])
  assert.deepEqual(result.missingJournalIds, [])
  assert.deepEqual(result.requestData.transactions, [])
})

test('encodes the marker name in the tag-transactions path', () => {
  assert.equal(buildTodoTransactionsPath('review/Needs attention'), 'api/tags/review%2FNeeds%20attention/transactions')
  assert.equal(buildTodoTransactionsPath('Проверить'), 'api/tags/%D0%9F%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%B8%D1%82%D1%8C/transactions')
})

test('filters completed receipts from active items and locks their offset page', () => {
  const items = [{ id: '42' }, { id: '43' }]
  const receipts = [{ id: '42' }]

  assert.deepEqual(getActiveTodoItems(items, receipts), [{ id: '43' }])
  assert.equal(isTodoPageLocked(receipts, false), true)
  assert.equal(isTodoPageLocked([], true), true)
  assert.equal(isTodoPageLocked([], false), false)
})

test('clamps a shifted offset page to the current valid range', () => {
  assert.equal(getSafeTodoPage(4, 3), 3)
  assert.equal(getSafeTodoPage(2, 5), 2)
  assert.equal(getSafeTodoPage(0, 0), 1)
})

test('limits concurrent workers while preserving result order', async () => {
  let active = 0
  let maximum = 0
  const results = await runWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, value % 2 === 0 ? 2 : 5))
    active -= 1
    return value * 2
  })

  assert.equal(maximum, 2)
  assert.deepEqual(
    results.map((result) => result.value),
    [2, 4, 6, 8],
  )
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
  )
})

test('settles every batch item and reports progress when one worker fails', async () => {
  const progress = []
  const results = await runWithConcurrency(
    [1, 2, 3],
    TODO_BATCH_CONCURRENCY,
    async (value) => {
      if (value === 2) {
        throw new Error('failed item')
      }
      return value
    },
    ({ processed }) => progress.push(processed),
  )

  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(results[1].reason.message, 'failed item')
  assert.equal(results[2].status, 'fulfilled')
  assert.deepEqual(
    progress.sort((a, b) => a - b),
    [1, 2, 3],
  )
})

test('rejects an invalid concurrency limit', async () => {
  await assert.rejects(() => runWithConcurrency([1], 0, async (value) => value), RangeError)
})

test('uses a fixed page size suitable for the Firefly endpoint', () => {
  assert.equal(TODO_PAGE_SIZE, 50)
})
