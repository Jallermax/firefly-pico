import assert from 'node:assert/strict'
import test from 'node:test'
import { getTodoDateRange, getTodoDateWindows, loadTodoPage, TODO_PAGE_SIZE } from '../core/utils/TodoInboxLoader.js'

const tagName = 'processor/to-review'
const range = { start: '2026-08-20', end: '2026-11-17' }
const group = (id, tags = [tagName]) => ({ id: String(id), attributes: { transactions: [{ transaction_journal_id: String(id), tags }] } })
const page = (data, totalPages = 1) => ({ data, meta: { pagination: { total_pages: totalPages } } })
const readGroup = async (id) => group(id)

test('defaults to the most recent 90 days and divides longer ranges without gaps', () => {
  assert.deepEqual(getTodoDateRange({}, new Date(2026, 10, 17)), range)
  assert.deepEqual(getTodoDateWindows({ start: '2026-08-19', end: range.end }), [range, { start: '2026-08-19', end: '2026-08-19' }])
  assert.throws(() => getTodoDateRange({ dateStart: new Date(2026, 10, 18), dateEnd: new Date(2026, 10, 17) }), RangeError)
})

test('loads one batch and rescans page one after queue membership changes', async () => {
  const matching = Array.from({ length: 14 }, (_, index) => group(index + 1))
  const readPage = async ({ page: number }) => page(matching.slice((number - 1) * TODO_PAGE_SIZE, number * TODO_PAGE_SIZE), Math.ceil(matching.length / TODO_PAGE_SIZE))
  const first = await loadTodoPage({ tagName, range, seenIds: new Set(), readPage, readGroup })
  assert.equal(first.items.length, 12)
  assert.equal(first.isFinished, false)
  matching.splice(0, 5)
  const next = await loadTodoPage({ tagName, range, seenIds: first.seenIds, readPage, readGroup })
  assert.deepEqual(
    next.items.map(({ id }) => id),
    ['13', '14'],
  )
  assert.equal(next.isFinished, true)
})

test('displays complete groups and skips deleted or newly untagged search results', async () => {
  const complete = group(1)
  complete.attributes.transactions.push({ transaction_journal_id: 'other', tags: ['unrelated'] })
  const result = await loadTodoPage({
    tagName,
    range,
    seenIds: new Set(),
    readPage: async () => page([group(1), group(2), group(3)]),
    readGroup: async (id) => ({ 1: complete, 2: null, 3: group(3, []) })[id],
  })
  assert.deepEqual(result.items, [complete])
  assert.equal(result.isFinished, true)
})

test('a failed or malformed page rejects instead of reporting an empty Inbox', async () => {
  const seenIds = new Set(['1'])
  await assert.rejects(loadTodoPage({ tagName, range, seenIds, readPage: async () => ({ message: 'Timed out' }), readGroup }))
  await assert.rejects(loadTodoPage({ tagName, range, seenIds, readPage: async () => ({ data: [group(2)] }), readGroup }))
  assert.deepEqual([...seenIds], ['1'])
})
