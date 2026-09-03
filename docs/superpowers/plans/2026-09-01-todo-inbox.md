# TODO Inbox implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the timed-out all-history TODO tag search with a dedicated paginated Inbox that supports split-aware review, safe Done and Undo, and recoverable page-wide processing.

**Architecture:** Keep the dashboard's bounded generic search, but load the all-history Inbox through Firefly III's tag-transactions endpoint using Pico's existing proxy. The client re-reads each transaction and sends minimal tag-only updates with rules and webhooks enabled. Pure utilities own payload construction and controlled concurrency; Vue components own presentation and page-session receipts.

**Tech stack:** Nuxt 4 SPA, Vue 3 script setup, Vant 4, Pinia 3, Axios, plain JavaScript, Node built-in test runner, Laravel catch-all proxy unchanged.

**Spec:** `docs/superpowers/specs/2026-09-01-todo-inbox-design.md`

## Global constraints

- Work only in `D:\projects\firefly-pico\.worktrees\feat-todo-inbox` on branch `feat/todo-inbox` based on `dev` commit `fe5e3f2`.
- Do not add npm or Composer dependencies.
- Keep Firefly III authoritative. Do not add a database migration, backend controller, or persistent Inbox state.
- Preserve the dashboard's existing bounded date and account search.
- Use Firefly's direct tag-transactions endpoint only for the all-history Inbox.
- Use plain JavaScript and Vue script setup. Do not add TypeScript or JSDoc types.
- Reuse existing transaction rows and `transaction-split-view.vue`. Do not redesign them.
- Add styles only to shared theme files and existing helper classes. Check light and dark themes.
- Update all ten locale JSON files.
- Use direct `node --test` commands. Do not add a one-off package script.
- Do not push, deploy, open an issue, or open a pull request.
- Run the eventual isolated runtime on port `6977`; leave the existing service on `6976` untouched.

## File map

**Create**

- `front/utils/TodoTransactionUtils.js`: pure Firefly marker matching, minimal removal and restoration payloads, response checks, and concurrency runner.
- `front/tests/TodoTransactionUtils.test.js`: behavior-focused Node tests for marker and concurrency semantics.
- `front/composables/useTodoInbox.js`: page loading, paging lock, expansion, per-item requests, receipts, batch progress, Retry, Undo, and Continue.
- `front/components/todo-inbox/todo-inbox-transaction-item.vue`: wrapper around existing mobile and desktop transaction rows plus Inbox controls and completed state.
- `front/pages/todo-inbox.vue`: dedicated page, toolbar, batch confirmation, page controls, error and empty states.
- `docs/superpowers/plans/2026-09-01-todo-inbox.md`: this plan.

**Modify**

- `front/repository/TagRepository.js`: paginated direct tag-transactions request.
- `front/repository/TransactionRepository.js`: raw read and minimal tag-update response methods with quiet background request options.
- `front/components/list-items/transaction-list-item.vue`: opt out of swipe-delete while reused in the Inbox.
- `front/components/list-items/transaction-list-item-desktop.vue`: opt out of swipe-delete while reused in the Inbox.
- `front/components/transaction/transaction-split-view.vue`: optional empty enabled fields for Inbox review, defaulting off elsewhere.
- `front/components/dashboard/dashboard-todo-transactions/dashboard-todo-transactions.vue`: route the count button to the Inbox.
- `front/constants/RouteConstants.js`: add `ROUTE_TODO_INBOX`.
- `front/utils/UIUtils.js`: expose a generic confirmation method while retaining delete confirmation behavior.
- `front/assets/styles/theme-white.css`: Inbox layout and states using existing variables.
- `front/assets/styles/theme-dark.css`: dark overrides only where shared variables are insufficient.
- `front/i18n/locales/en.json`, `ro.json`, `zh-CN.json`, `it.json`, `pt-BR.json`, `de-DE.json`, `fr.json`, `pl.json`, `ru-RU.json`, `es-MX.json`: localized Inbox copy.

---

### Task 1: Pure marker update logic

**Files:**

- Create: `front/utils/TodoTransactionUtils.js`
- Create: `front/tests/TodoTransactionUtils.test.js`

**Interfaces:**

- Produces: `TODO_PAGE_SIZE`, `TODO_BATCH_CONCURRENCY`, `buildTodoTransactionsPath(tagName)`, `getTodoJournalIds(transaction, markerName)`, `hasTodoMarker(transaction, markerName)`, `buildTodoRemovalRequest(transaction, markerName)`, `buildTodoRestoreRequest(transaction, markerName, journalIds)`, `getActiveTodoItems(items, receipts)`, `getSafeTodoPage(page, totalPages)`, `isTodoPageLocked(receipts, isBatchRunning)`, and `runWithConcurrency(items, limit, worker, onProgress)`.
- Consumes: raw Firefly transaction resources shaped as `{ id, attributes: { transactions: [...] } }`.
- `buildTodoRemovalRequest` returns `{ requestData, journalIds }`.
- `buildTodoRestoreRequest` returns `{ requestData, restoredJournalIds, missingJournalIds, isAlreadyRestored }`.

- [ ] **Step 1: Write failing marker-removal tests**

Create tests using Node's built-in runner. Include a raw multi-split fixture where only selected journals carry `todo`.

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTodoRemovalRequest,
  buildTodoRestoreRequest,
  buildTodoTransactionsPath,
  getActiveTodoItems,
  getTodoJournalIds,
  getSafeTodoPage,
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
      { transaction_journal_id: '103', tags: ['todo', 'family'] },
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
      { transaction_journal_id: '103', tags: ['family'] },
    ],
  })
})

test('detects whether any split still carries the marker', () => {
  assert.equal(hasTodoMarker(makeTransaction(), 'todo'), true)
})

test('locks shifted offset pages while completion receipts exist', () => {
  const items = [{ id: '42' }, { id: '43' }]
  const receipts = [{ id: '42' }]

  assert.deepEqual(getActiveTodoItems(items, receipts), [{ id: '43' }])
  assert.equal(isTodoPageLocked(receipts, false), true)
  assert.equal(getSafeTodoPage(4, 3), 3)
})
```

- [ ] **Step 2: Run the marker tests and confirm the red state**

Run from `front/`:

```powershell
node --test tests/TodoTransactionUtils.test.js
```

Expected: FAIL because `TodoTransactionUtils.js` does not exist.

- [ ] **Step 3: Add restoration, path, idempotency, and concurrency tests**

Cover these exact cases:

```js
test('restores the marker to surviving original journals without replacing current tags', () => {
  const current = makeTransaction()
  current.attributes.transactions[0].tags = ['imported', 'new-tag']
  current.attributes.transactions.splice(2, 1)

  const result = buildTodoRestoreRequest(current, 'todo', ['101', '103'])

  assert.deepEqual(result.restoredJournalIds, ['101'])
  assert.deepEqual(result.missingJournalIds, ['103'])
  assert.deepEqual(result.requestData.transactions, [
    { transaction_journal_id: '101', tags: ['imported', 'new-tag', 'todo'] },
  ])
})

test('encodes marker names in the tag-transactions path', () => {
  assert.equal(buildTodoTransactionsPath('review/Needs attention'), 'api/tags/review%2FNeeds%20attention/transactions')
})

test('limits concurrent workers and reports every result', async () => {
  let active = 0
  let maximum = 0
  const results = await runWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return value * 2
  })

  assert.equal(maximum, 2)
  assert.deepEqual(
    results.map((result) => result.value),
    [2, 4, 6, 8],
  )
})
```

Also test: marker absent, marker already restored, exact unrelated-tag preservation, duplicate marker avoidance, string and numeric journal IDs, active-item filtering, pager locking, safe-page clamping, and invalid concurrency limit rejected with `RangeError`.

- [ ] **Step 4: Implement the smallest pure utility**

Use no Nuxt aliases or browser globals so Node can import the module directly.

```js
export const TODO_PAGE_SIZE = 50
export const TODO_BATCH_CONCURRENCY = 3

const getSplits = (transaction) => transaction?.attributes?.transactions ?? []
const isMarker = (tag, markerName) => tag === markerName
const journalKey = (id) => String(id)

export const buildTodoTransactionsPath = (tagName) => `api/tags/${encodeURIComponent(tagName)}/transactions`

export const getTodoJournalIds = (transaction, markerName) =>
  getSplits(transaction)
    .filter((split) => (split.tags ?? []).some((tag) => isMarker(tag, markerName)))
    .map((split) => journalKey(split.transaction_journal_id))

export const hasTodoMarker = (transaction, markerName) => getTodoJournalIds(transaction, markerName).length > 0
```

Build removal and restoration payloads from the latest split tag arrays. Include only changed journals. Keep `apply_rules` and `fire_webhooks` true.

Implement `runWithConcurrency` as a small worker pool that preserves result order and returns `Promise.allSettled`-shaped entries: `{ status: 'fulfilled', value }` or `{ status: 'rejected', reason }`. Invoke `onProgress({ processed, total, index, result })` after each settled worker. One worker failure must not abort remaining items.

- [ ] **Step 5: Run the focused tests to confirm green**

```powershell
node --test tests/TodoTransactionUtils.test.js
```

Expected: all tests PASS with exit code 0.

- [ ] **Step 6: Run formatting checks for the new files**

```powershell
npx prettier utils/TodoTransactionUtils.js tests/TodoTransactionUtils.test.js --check
npx eslint utils/TodoTransactionUtils.js tests/TodoTransactionUtils.test.js
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit the pure behavior**

```powershell
git add front/utils/TodoTransactionUtils.js front/tests/TodoTransactionUtils.test.js
git commit -m "test: define TODO marker update behavior"
```

---

### Task 2: Firefly data-access seams

**Files:**

- Modify: `front/repository/TagRepository.js`
- Modify: `front/repository/TransactionRepository.js`
- Modify: `front/constants/RouteConstants.js`

**Interfaces:**

- Consumes: `buildTodoTransactionsPath()` and `TODO_PAGE_SIZE` from Task 1.
- Produces: `TagRepository.getTodoTransactions(tagName, { page, pageSize, showLoading })`, returning the Axios response.
- Produces: `TransactionRepository.getTodoTransaction(id)` and `TransactionRepository.updateTodoTags(id, requestData)`, both returning Axios responses and suppressing the global loading overlay and duplicate error toast.
- Produces: `RouteConstants.ROUTE_TODO_INBOX === '/todo-inbox'`.

- [ ] **Step 1: Add a path assertion to the existing utility test**

Add cases for spaces, slashes, Unicode, and `TODO_PAGE_SIZE === 50`. Run the test to verify the current utility already supports the repository contract.

```powershell
node --test tests/TodoTransactionUtils.test.js
```

Expected: PASS.

- [ ] **Step 2: Add the direct tag-transactions request**

Use the repository's existing Axios and URL conventions:

```js
async getTodoTransactions(tagName, { page = 1, pageSize = TODO_PAGE_SIZE, showLoading = true } = {}) {
  const appStore = useAppStore()
  const path = buildTodoTransactionsPath(tagName)
  const url = this.getUrlForRequest({
    url: `${appStore.picoBackendURL}/${path}`,
    page,
    pageSize,
  })
  return await axios.get(url, { showLoading })
}
```

Return the full Axios response so the caller can distinguish success, error, and empty response states.

- [ ] **Step 3: Add quiet raw transaction methods**

```js
async getTodoTransaction(id) {
  return await axios.get(`${this.getUrl()}/${id}`, {
    showLoading: false,
    showErrorToast: false,
  })
}

async updateTodoTags(id, requestData) {
  return await axios.put(`${this.getUrl()}/${id}`, requestData, {
    showLoading: false,
    showErrorToast: false,
  })
}
```

Do not change `BaseRepository` or the normal transaction editor methods.

- [ ] **Step 4: Add the Inbox route constant**

Add `ROUTE_TODO_INBOX: '/todo-inbox'` near the transaction routes.

- [ ] **Step 5: Run focused lint and the production build**

```powershell
npx prettier repository/TagRepository.js repository/TransactionRepository.js constants/RouteConstants.js --check
npx eslint repository/TagRepository.js repository/TransactionRepository.js constants/RouteConstants.js
npm run build
```

Expected: focused checks and build exit 0.

- [ ] **Step 6: Commit the access layer**

```powershell
git add front/repository/TagRepository.js front/repository/TransactionRepository.js front/constants/RouteConstants.js
git commit -m "feat: add TODO inbox data access"
```

---

### Task 3: Reusable transaction review presentation

**Files:**

- Modify: `front/components/list-items/transaction-list-item.vue`
- Modify: `front/components/list-items/transaction-list-item-desktop.vue`
- Modify: `front/components/transaction/transaction-split-view.vue`
- Create: `front/components/todo-inbox/todo-inbox-transaction-item.vue`

**Interfaces:**

- Produces: `isDeleteEnabled` prop on both transaction list rows, default `true`.
- Produces: `showEmptyFields` prop on `transaction-split-view`, default `false`.
- Produces: `todo-inbox-transaction-item` props `value`, `receipt`, `isExpanded`, `isProcessing`, and `error`; emits `edit`, `toggle`, `done`, `undo`, and `retry`.

- [ ] **Step 1: Add the opt-out props with unchanged defaults**

For both row components:

```js
isDeleteEnabled: {
  type: Boolean,
  default: true,
},
```

Disable the swipe cell and omit its right-side Delete action when false. Existing callers must render exactly as before.

- [ ] **Step 2: Add optional empty enabled fields to the split view**

Add:

```js
showEmptyFields: {
  type: Boolean,
  default: false,
},
```

When true, render separate Category, Budget, Tags, Subscription, and Notes rows for enabled resources even when their current value is empty. Use localized `None` for absent linked resources and `Empty` for notes. Keep existing conditional rendering when the prop is false.

- [ ] **Step 3: Build the Inbox item wrapper from existing components**

Active item structure:

```vue
<transaction-list-item-desktop
  v-if="appStore.isDesktopLayout"
  :value="value"
  :is-delete-enabled="false"
  @on-edit="$emit('edit', value)"
/>
<transaction-list-item
  v-else
  :value="value"
  :is-detailed-mode="false"
  :is-delete-enabled="false"
  @on-edit="$emit('edit', value)"
/>
```

Add a compact control row with Details and Done or Retry. Render `transaction-split-view` below it only when expanded. Do not add an Edit button.

Completed item structure uses a single `van-cell` at the same list position. Show description, formatted amount and currency, Done, and Undo. It is not expandable and has no timer.

- [ ] **Step 4: Add accessible state and click behavior**

- Details uses `aria-expanded`.
- Buttons stop propagation so row navigation never fires.
- Processing disables Done, Undo, and Retry for that item.
- An item error is visible near the controls and uses `role="alert"`.
- The compact receipt remains keyboard reachable.

- [ ] **Step 5: Run focused formatting and build proof**

```powershell
npx prettier components/list-items/transaction-list-item.vue components/list-items/transaction-list-item-desktop.vue components/transaction/transaction-split-view.vue components/todo-inbox/todo-inbox-transaction-item.vue --check
npx eslint components/list-items/transaction-list-item.vue components/list-items/transaction-list-item-desktop.vue components/transaction/transaction-split-view.vue components/todo-inbox/todo-inbox-transaction-item.vue
npm run build
```

Expected: focused checks and build exit 0. Existing list pages still compile with the default props.

- [ ] **Step 6: Commit the reusable UI**

```powershell
git add front/components/list-items/transaction-list-item.vue front/components/list-items/transaction-list-item-desktop.vue front/components/transaction/transaction-split-view.vue front/components/todo-inbox/todo-inbox-transaction-item.vue
git commit -m "feat: add TODO inbox transaction review item"
```

---

### Task 4: Inbox state and mutation workflow

**Files:**

- Create: `front/composables/useTodoInbox.js`
- Modify: `front/utils/UIUtils.js`
- Test: `front/tests/TodoTransactionUtils.test.js`

**Interfaces:**

- Consumes: repository methods from Task 2 and all marker, active-item, pager-lock, safe-page, and concurrency helpers from Task 1.
- Produces: `useTodoInbox()` with refs and methods used by the page: `items`, `page`, `pageSize`, `totalPages`, `totalCount`, `activeItems`, `receiptById`, `expandedIds`, `isLoading`, `isRefreshing`, `loadError`, `itemStateById`, `isPagerLocked`, `isBatchRunning`, `batchProgress`, `loadPage`, `refresh`, `editItem`, `toggleItem`, `toggleAll`, `doneItem`, `undoItem`, `retryItem`, `donePage`, `continuePage`, and `changePage`.
- Produces: `UIUtils.showConfirmation(title, message)`; existing `showDeleteConfirmation` delegates to it.

- [ ] **Step 1: Extend pure tests for batch settlement**

Verify `runWithConcurrency` continues after a rejected worker and reports progress for every item:

```js
test('settles every batch item when one worker fails', async () => {
  const progress = []
  const results = await runWithConcurrency(
    [1, 2, 3],
    2,
    async (value) => {
      if (value === 2) throw new Error('failed item')
      return value
    },
    (value) => progress.push(value.processed),
  )

  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(results[2].status, 'fulfilled')
  assert.deepEqual(progress.sort((a, b) => a - b), [1, 2, 3])
})
```

Run the focused test and confirm it fails if settlement is not already implemented.

- [ ] **Step 2: Implement generic confirmation**

```js
static async showConfirmation(title, message) {
  return showConfirmDialog({ title, message })
    .then(() => true)
    .catch(() => false)
}

static async showDeleteConfirmation(title, message) {
  return UIUtils.showConfirmation(title, message)
}
```

- [ ] **Step 3: Implement page loading and explicit pagination**

`loadPage(targetPage)` must:

1. Validate the configured marker from `tagStore.tagTodo`.
2. Request the direct tag page with `limit=50`.
3. Distinguish a non-200 response from a successful empty page using `ResponseUtils.isSuccess`.
4. Transform a cloned response list with `TransactionTransformer.transformFromApiList`.
5. Set `page`, `pageSize`, `totalPages`, and `totalCount` from `meta.pagination`.
6. Default expansion to every active item on desktop and none on mobile.

Do not append pages. Replace the current page.

- [ ] **Step 4: Implement guarded Done**

`doneItem(item)` must:

1. Mark only that item as processing.
2. Call `getTodoTransaction(item.id)`.
3. Handle 404 as a stale deleted item.
4. Build the minimal removal request from the returned raw resource.
5. Handle no marked journals as externally completed without creating Undo.
6. Call `updateTodoTags`.
7. Confirm the returned resource has no marker on any split.
8. Create an in-memory receipt at the same item ID only after confirmed success.
9. Retain the active item and a localized error on failure.

Do not refresh the page after confirmed success. The receipt locks pagination until Continue or Undo.

- [ ] **Step 5: Implement merge-safe Undo**

`undoItem(receipt)` must re-read the transaction, build the restoration request from current tags and receipt journal IDs, handle missing journals, update only surviving original journals, verify the marker, remove the receipt, and replace the displayed transaction with freshly transformed response data.

When the last receipt is removed, re-enable pagination without requiring Continue.

- [ ] **Step 6: Implement stable page locking and Continue**

- `isPagerLocked` is true while receipts exist or a batch runs.
- `changePage` ignores a requested page while locked.
- `continuePage` first fetches the same current page. Only after a successful response does it clear receipts and replace the page.
- If the current page exceeds the new total page count, fetch the highest valid page.
- A failed Continue retains receipts and Undo.

- [ ] **Step 7: Implement page-wide Done with concurrency three**

Confirm with localized marker name and active count before work begins. Run `doneItem` through `runWithConcurrency(activeItems, TODO_BATCH_CONCURRENCY, ...)`. Update exact processed, success, and failure counts. Keep successful receipts and failed active rows. Do not include existing receipts.

- [ ] **Step 8: Run focused tests, lint, and build**

```powershell
node --test tests/TodoTransactionUtils.test.js
npx prettier composables/useTodoInbox.js utils/UIUtils.js tests/TodoTransactionUtils.test.js --check
npx eslint composables/useTodoInbox.js utils/UIUtils.js tests/TodoTransactionUtils.test.js
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit the workflow**

```powershell
git add front/composables/useTodoInbox.js front/utils/UIUtils.js front/tests/TodoTransactionUtils.test.js
git commit -m "feat: add TODO inbox review workflow"
```

---

### Task 5: Dedicated Inbox page and dashboard entry

**Files:**

- Create: `front/pages/todo-inbox.vue`
- Modify: `front/components/dashboard/dashboard-todo-transactions/dashboard-todo-transactions.vue`

**Interfaces:**

- Consumes: `useTodoInbox()` and `todo-inbox-transaction-item` from earlier tasks.
- Produces: `/todo-inbox` route with mobile and desktop layout branches inherited from Pico.
- Dashboard count button navigates to `RouteConstants.ROUTE_TODO_INBOX`; row editing is unchanged.

- [ ] **Step 1: Build the page shell and toolbar**

Use `app-form`, `app-top-toolbar`, `useToolbar()`, Vant buttons, and existing helper classes. The toolbar subtitle shows active current-page items and the all-history total.

The right-side controls expose Expand all or Collapse all and Mark page done. Continue replaces the normal page action emphasis while receipts exist.

- [ ] **Step 2: Render distinct configuration, loading, error, empty, and list states**

- Missing marker: existing TODO tag tutorial guidance.
- Load error: inline localized message and Retry.
- Successful empty response: existing empty-list presentation.
- Loaded response: item wrapper for every page item, using the receipt map to keep completed items in place.
- Batch progress: processed, total, success, and failed counts with normal Pico feedback styling.

- [ ] **Step 3: Add explicit pagination**

Use `van-pagination` after the list:

```vue
<van-pagination
  :model-value="page"
  :total-items="totalCount"
  :items-per-page="pageSize"
  :mode="appStore.isDesktopLayout ? 'multi' : 'simple'"
  :disabled="isPagerLocked"
  @change="changePage"
/>
```

Keep the pager outside any internal scroll container. Do not add infinite scroll.

- [ ] **Step 4: Wire edit return and page loading**

Load the page on mount. The Inbox page is unmounted when it opens the existing editor, so returning creates a fresh page load. Receipts intentionally do not survive leaving the Inbox.

- [ ] **Step 5: Change only the dashboard count destination**

Replace the tag-filter list URL in `onGoToTodos` with:

```js
await navigateTo(RouteConstants.ROUTE_TODO_INBOX)
```

Keep the tag existence guard and `onEditTransaction` unchanged. Remove the now-unused `get` import.

- [ ] **Step 6: Run focused formatting and build proof**

```powershell
npx prettier pages/todo-inbox.vue components/dashboard/dashboard-todo-transactions/dashboard-todo-transactions.vue --check
npx eslint pages/todo-inbox.vue components/dashboard/dashboard-todo-transactions/dashboard-todo-transactions.vue
npm run build
```

Expected: focused checks and build exit 0.

- [ ] **Step 7: Commit the route and page**

```powershell
git add front/pages/todo-inbox.vue front/components/dashboard/dashboard-todo-transactions/dashboard-todo-transactions.vue
git commit -m "feat: add TODO inbox page"
```

---

### Task 6: Pico styling and localization

**Files:**

- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: all files under `front/i18n/locales/*.json`

**Interfaces:**

- Consumes: class names and translation keys introduced by Tasks 3 through 5.
- Produces: existing-style mobile and desktop presentation in both themes and complete locale key parity.

- [ ] **Step 1: Add the English translation object**

Add a `todo_inbox` object containing these keys:

```json
{
  "title": "TODO Inbox",
  "all_history": "All history",
  "expand_all": "Expand all",
  "collapse_all": "Collapse all",
  "details": "Details",
  "done": "Done",
  "undo": "Undo",
  "retry": "Retry",
  "continue": "Continue",
  "mark_page_done": "Mark page done",
  "confirm_title": "Mark this page done?",
  "confirm_message": "Remove the {marker} tag from {count} transaction groups on this page?",
  "remaining_items": "{count} remaining",
  "page_context": "Page {page} of {total}",
  "none": "None",
  "empty": "Empty",
  "load_error": "The TODO Inbox could not be loaded.",
  "marker_missing": "Configure one tag as the TODO tag to use the Inbox.",
  "marker_still_present": "Firefly still reports the TODO tag on this transaction.",
  "transaction_deleted": "This transaction no longer exists.",
  "completed_elsewhere": "Already completed elsewhere.",
  "undo_missing_splits": "The original transaction splits no longer exist.",
  "batch_progress": "Processed {processed} of {total}",
  "batch_result": "{success} done, {failed} failed"
}
```

Add any additional error key only when a page or composable has a concrete use for it. Do not add speculative copy.

- [ ] **Step 2: Add equivalent keys to the other nine locales**

Translate the same meanings into Romanian, Simplified Chinese, Italian, Brazilian Portuguese, German, French, Polish, Russian, and Mexican Spanish. Keep the `TODO` marker name unchanged and preserve `{marker}`, `{count}`, `{page}`, `{total}`, `{processed}`, `{success}`, and `{failed}` placeholders exactly.

- [ ] **Step 3: Add existing-style shared CSS**

Use a small set of `todo-inbox-*` classes for:

- Toolbar action wrapping
- Active-item list spacing
- Item control row
- Expanded split pane
- Compact grey completion receipt
- Inline item error
- Batch progress and result
- Pager spacing and locked appearance

Use existing CSS variables, 6 to 10 pixel radii, existing shadows, and helper classes. Do not restyle transaction rows or `transaction-split-view`. Avoid fixed heights so long localized labels wrap.

- [ ] **Step 4: Add dark overrides only where needed**

Prefer variables from `variables.css`. Add dark rules only for hardcoded light receipt or error surfaces that cannot use an existing variable.

- [ ] **Step 5: Parse every locale and run focused formatting**

```powershell
Get-ChildItem i18n/locales/*.json | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json | Out-Null }
npx prettier assets/styles/theme-white.css assets/styles/theme-dark.css i18n/locales/*.json --check
```

Expected: JSON parsing and Prettier exit 0.

- [ ] **Step 6: Run focused ESLint and production build**

```powershell
npx eslint pages/todo-inbox.vue components/todo-inbox/todo-inbox-transaction-item.vue composables/useTodoInbox.js repository/TagRepository.js repository/TransactionRepository.js utils/TodoTransactionUtils.js tests/TodoTransactionUtils.test.js
npm run build
```

Expected: focused lint and build exit 0.

- [ ] **Step 7: Commit presentation and copy**

```powershell
git add front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales
git commit -m "feat: style and localize TODO inbox"
```

---

### Task 7: Full verification and isolated runtime proof

**Files:**

- Modify only files that fail an approved acceptance check.

**Interfaces:**

- Consumes: complete feature from Tasks 1 through 6.
- Produces: recorded automated, browser, and live HTTP evidence with remaining gaps stated plainly.

- [ ] **Step 1: Run focused automated proof**

From `front/`:

```powershell
node --test tests/TodoTransactionUtils.test.js
npx eslint pages/todo-inbox.vue components/todo-inbox/todo-inbox-transaction-item.vue components/list-items/transaction-list-item.vue components/list-items/transaction-list-item-desktop.vue components/transaction/transaction-split-view.vue composables/useTodoInbox.js repository/TagRepository.js repository/TransactionRepository.js utils/TodoTransactionUtils.js utils/UIUtils.js tests/TodoTransactionUtils.test.js
npx prettier pages/todo-inbox.vue components/todo-inbox/todo-inbox-transaction-item.vue components/list-items/transaction-list-item.vue components/list-items/transaction-list-item-desktop.vue components/transaction/transaction-split-view.vue composables/useTodoInbox.js repository/TagRepository.js repository/TransactionRepository.js utils/TodoTransactionUtils.js utils/UIUtils.js tests/TodoTransactionUtils.test.js assets/styles/theme-white.css assets/styles/theme-dark.css i18n/locales/*.json --check
npm run build
```

Expected: every focused command and build exits 0.

- [ ] **Step 2: Run repository-wide lint and separate baseline failures**

```powershell
npm run lint
```

Expected on the untouched base was 359 errors and 215 warnings. Record the new result. Do not claim repository-wide lint passes unless it exits 0. Confirm no reported error belongs to a changed file.

- [ ] **Step 3: Review the exact diff**

```powershell
git diff dev...HEAD --check
git diff dev...HEAD --stat
git status --short
```

Confirm no secret, host, token, personal account name, unrelated file, backend route, dependency, or migration entered the branch.

- [ ] **Step 4: Build and start the isolated runtime on port 6977**

Follow the repository's local deployment instructions from the feature worktree. Use a separate compose project, image tag, container name, and host port `6977`. Do not recreate or restart `firefly_pico` on `6976`.

Before starting, record container and port ownership. After starting, prove the served bundle comes from the feature worktree.

- [ ] **Step 5: Verify live performance and request path**

On the target Firefly dataset:

- Open the dashboard and confirm its TODO request remains bounded by configured date and account filters.
- Open the Inbox and confirm the browser makes `GET /api/tags/{tag}/transactions?page=1&limit=50`.
- Confirm no Inbox request calls `/api/search/transactions`.
- Record three first-page timings and confirm each completes before Pico's 10-second timeout.

- [ ] **Step 6: Verify mobile and desktop interaction**

Check mobile at 320 to 390 pixels and desktop above 800 pixels, in light and dark themes:

- Correct default expansion
- Expand all and Collapse all
- Separate Category, Tags, Budget, Subscription, and Notes
- Multi-split subsections
- Row click opens editor; no Edit button exists
- Done creates a stable one-line receipt
- Scrolling does not move after waiting because there is no timer
- Undo restores the marker and active row
- Batch confirmation, progress, partial failure, Retry, and exact summary
- Pager locks while receipts exist
- Continue reloads the same valid page
- Editor return with marker kept and removed
- Loading, empty, missing marker, page error, item error, and deleted transaction states

- [ ] **Step 7: Run the contribution preflight**

From the worktree root:

```powershell
pwsh -NoProfile -File .agents/skills/firefly-pico-oss-contribution/scripts/contribution-preflight.ps1
```

Record PASS, FAIL, and warnings exactly. Do not execute publication recommendations.

- [ ] **Step 8: Request code review and fix approved findings**

Use the required review workflow on the complete implementation. Re-run the focused test, lint, formatting, build, and diff checks after any fix.

- [ ] **Step 9: Create the final local implementation commit if fixes remain**

```powershell
git add <only the approved fix files>
git commit -m "fix: address TODO inbox review findings"
```

Skip this commit when review requires no changes. Do not push.
