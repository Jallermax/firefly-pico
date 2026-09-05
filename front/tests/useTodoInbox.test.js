import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const transaction = (id, tags = ['todo', 'imported']) => ({
  id: String(id),
  type: 'transactions',
  attributes: { transactions: [{ transaction_journal_id: `${id}01`, description: 'Market', amount: '12.34', tags }] },
})
const response = (data) => ({ status: 200, data: { data } })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => (resolve = done))
  return { promise, resolve }
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../composables/useTodoInbox.js', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  tsconfigRaw: {},
  alias: { '~': fileURLToPath(new URL('../', import.meta.url)) },
  banner: {
    js: 'const useAppStore = () => globalThis.todoTest.app; const useTagStore = () => globalThis.todoTest.tags; const useI18n = () => ({ t: key => key }); const navigateTo = async () => {};',
  },
  plugins: [
    {
      name: 'external-boundaries',
      setup(build) {
        const doubles = {
          'TagRepository.js': 'export default class { constructor() { return globalThis.todoTest.tagRepository } }',
          'TransactionRepository.js': 'export default class { constructor() { return globalThis.todoTest.transactionRepository } }',
          'TransactionTransformer.js': 'export default { transformFromApi: x => x, transformFromApiList: x => x }',
          'Tag.js': 'export default { getDisplayName: x => x.attributes.tag }',
          'UIUtils.js': 'export default { showConfirmation: async () => true, showToastSuccess() {}, showToastError() {} }',
        }
        build.onResolve({ filter: /\/(TagRepository|TransactionRepository|TransactionTransformer|Tag|UIUtils)\.js$/ }, ({ path }) => ({ path: path.split('/').at(-1), namespace: 'boundary' }))
        build.onLoad({ filter: /.*/, namespace: 'boundary' }, ({ path }) => ({ contents: doubles[path], loader: 'js' }))
      },
    },
  ],
})
const { useTodoInbox } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=todo-inbox-test-bundle.js').toString('base64')}`)

async function inboxWith(items, repository = {}) {
  globalThis.todoTest = {
    app: { isDesktopLayout: false },
    tags: { tagTodo: { id: '1', attributes: { tag: 'todo' } } },
    tagRepository: { getTodoTransactions: async () => ({ ...response(items), data: { data: items, meta: { pagination: { current_page: 1, per_page: 50, total_pages: 1, total: items.length } } } }) },
    transactionRepository: { getTodoTransaction: async (id) => response(items.find((item) => item.id === String(id))), updateTodoTags: async (id) => response(transaction(id, ['imported'])) },
  }
  const inbox = useTodoInbox()
  await inbox.loadPage()
  Object.assign(globalThis.todoTest.transactionRepository, repository)
  return inbox
}

test('loads complete groups when the tag endpoint returns only matching splits', async () => {
  const partial = transaction(1)
  const complete = structuredClone(partial)
  complete.attributes.transactions.push({ transaction_journal_id: '102', description: 'Other split', amount: '7.66', tags: ['household'] })
  const inbox = await inboxWith([partial])
  globalThis.todoTest.transactionRepository.getTodoTransaction = async () => response(complete)
  await inbox.loadPage()
  assert.deepEqual(inbox.items.value[0].attributes.transactions, complete.attributes.transactions)
})

test('does not show partial transaction details if loading a complete group fails', async () => {
  const inbox = await inboxWith([])
  globalThis.todoTest.tagRepository.getTodoTransactions = async () => response([transaction(1)])
  globalThis.todoTest.transactionRepository.getTodoTransaction = async () => ({ status: 503 })
  assert.equal(await inbox.loadPage(), false)
  assert.equal(inbox.loadError.value, 'todo_inbox.load_error')
  assert.deepEqual(inbox.items.value, [])
})

test('counts remaining groups on the page instead of the API journal total', async () => {
  const item = transaction(1)
  const inbox = await inboxWith([item])
  globalThis.todoTest.tagRepository.getTodoTransactions = async () => ({ status: 200, data: { data: [item], meta: { pagination: { total: 2 } } } })
  await inbox.loadPage()
  assert.equal(inbox.remainingCount.value, 1)
  await inbox.doneItem(item)
  assert.equal(inbox.remainingCount.value, 0)
})

test('Done becomes pending immediately, blocks duplicate writes, and retains its slot', async () => {
  const read = deferred()
  const item = transaction(1)
  const inbox = await inboxWith([item], { getTodoTransaction: () => read.promise })
  const saving = inbox.doneItem(item)
  assert.equal(inbox.getState(1).isProcessing, true)
  assert.deepEqual(await inbox.doneItem(item), { status: 'ignored' })
  assert.equal(inbox.items.value.length, 1)
  read.resolve(response(item))
  await saving
  assert.equal(inbox.items.value.length, 1)
  assert.equal(inbox.receipts.value.length, 1)
})

test('page loading blocks Done, Undo and batch actions until the page is settled', async () => {
  const item = transaction(1)
  const inbox = await inboxWith([item, transaction(2)])
  await inbox.doneItem(item)
  const read = deferred()
  globalThis.todoTest.tagRepository.getTodoTransactions = () => read.promise
  const loading = inbox.continuePage()
  assert.equal(await inbox.undoItem(item), false)
  assert.deepEqual(await inbox.doneItem(transaction(2)), { status: 'ignored' })
  assert.equal(await inbox.markPageDone(), false)
  read.resolve(response([]))
  await loading
})

test('batch queues every row before the first read finishes', async () => {
  const read = deferred()
  const items = [1, 2, 3, 4, 5].map((id) => transaction(id))
  const inbox = await inboxWith(items, {
    getTodoTransaction: async (id) => {
      await read.promise
      return response(transaction(id))
    },
  })
  const batch = inbox.markPageDone()
  await Promise.resolve()
  assert.equal(
    items.every((item) => inbox.getState(item.id).isProcessing || inbox.getState(item.id).isQueued),
    true,
  )
  assert.equal(inbox.getState(4).isQueued, true)
  read.resolve()
  await batch
  assert.equal(inbox.receipts.value.length, 5)
})

test('failed saves restore the previous expansion state and expose an inline error', async () => {
  const item = transaction(1)
  const inbox = await inboxWith([item], { updateTodoTags: async () => ({ status: 422, data: { message: 'Validation failed' } }) })
  inbox.toggleExpanded(item)
  await assert.rejects(inbox.doneItem(item))
  assert.equal(inbox.getState(1).isProcessing, false)
  assert.equal(inbox.getState(1).error, 'Validation failed')
  assert.equal(inbox.expandedIds.value.has('1'), true)
  assert.equal(inbox.receipts.value.length, 0)
})

test('a timed-out save is reread and confirmed without a second write', async () => {
  let reads = 0
  let writes = 0
  const item = transaction(1)
  const inbox = await inboxWith([item], {
    getTodoTransaction: async () => response(transaction(1, ++reads === 1 ? ['todo', 'imported'] : ['imported'])),
    updateTodoTags: async () => {
      writes++
      return { code: 'ECONNABORTED' }
    },
  })
  await inbox.doneItem(item)
  assert.equal(inbox.receipts.value.length, 1)
  assert.equal(writes, 1)
  assert.equal(reads, 2)
})

test('an unconfirmed timeout retains journal information for a safe retry and Undo', async () => {
  let reads = 0
  let writes = 0
  const item = transaction(1)
  const inbox = await inboxWith([item], {
    getTodoTransaction: async () => (++reads === 2 ? { status: 503 } : response(transaction(1, reads === 1 ? ['todo', 'imported'] : ['imported']))),
    updateTodoTags: async () => {
      writes++
      return { code: 'ECONNABORTED' }
    },
  })
  await assert.rejects(inbox.doneItem(item))
  assert.equal(inbox.getState(1).error, 'todo_inbox.completion_unconfirmed')
  await inbox.doneItem(item)
  assert.equal(writes, 1)
  assert.deepEqual(inbox.receipts.value[0].journalIds, ['101'])
})

test('a transaction completed elsewhere leaves a stable receipt without Undo', async () => {
  const item = transaction(1)
  const inbox = await inboxWith([item], { getTodoTransaction: async () => response(transaction(1, ['imported'])) })
  await inbox.doneItem(item)
  assert.equal(inbox.items.value.length, 1)
  assert.deepEqual(inbox.receipts.value[0].journalIds, [])
})

test('Undo restores the expanded mobile review state', async () => {
  const item = transaction(1)
  const inbox = await inboxWith([item])
  inbox.toggleExpanded(item)
  await inbox.doneItem(item)
  await inbox.undoItem(item)
  assert.equal(inbox.receipts.value.length, 0)
  assert.equal(inbox.expandedIds.value.has('1'), true)
})

test('Done after Undo does not claim an unrelated completion as its own', async () => {
  const item = transaction(1)
  const inbox = await inboxWith([item])
  await inbox.doneItem(item)
  await inbox.undoItem(item)
  globalThis.todoTest.transactionRepository.getTodoTransaction = async () => response(transaction(1, ['imported']))
  await inbox.doneItem(item)
  assert.deepEqual(inbox.receipts.value[0].journalIds, [])
})
