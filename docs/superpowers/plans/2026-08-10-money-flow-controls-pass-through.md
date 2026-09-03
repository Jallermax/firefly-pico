# Money Flow Controls and Pass-Through Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic-family ordering, minimum-amount detail, and a reusable transaction-backed pass-through account role to Money Flow without changing Firefly data or any other analytics calculation.

**Architecture:** Keep the normalized analytics ledger authoritative and unchanged. Add pure graph ordering/detail functions, apply pass-through endpoint overrides only inside the monthly Money Flow builder, persist role/control state in the analytics store, and let the Money Flow card resolve localized labels before final ordering and rendering. The existing layered SVG remains dependency-free and receives an already ordered, balanced graph.

**Tech Stack:** Nuxt 3 SPA, Vue 3 `<script setup>`, Pinia 3 composition stores, Vant 4, plain JavaScript, Node test runner, existing dependency-free SVG chart utilities, CSS variables, Vue i18n.

## Global Constraints

- Work on the existing `personal/extended-analytics` branch; do not create or switch branches, push, or open a PR.
- Follow strict TDD: add the real behavior test, run it against unchanged production code, record the expected RED, then implement the minimum production change and record GREEN.
- Do not change `buildAnalyticsLedger()`, `getAnalyticsAccountKind()`, Firefly account types/roles, balances, net worth, forecasts, Cash Use, Spending by category, or backend code.
- Do not add npm/composer dependencies, TypeScript, Nuxt server routes, Vue Options API, component-scoped styles, or hard-coded user-facing labels.
- Pass-through account IDs are reusable Pico analytics metadata, but Money Flow is their only consumer in this slice.
- Only active asset/cash accounts whose shared analytics kind is `available` are effective pass-through accounts.
- Treatment off plus Amount order must reproduce the previous Money Flow graph for the same ledger, month, savings view, and detail.
- Use one nonnegative threshold in the selected dashboard currency for all compatible outer families; only two-or-more sub-threshold siblings become `Other`.
- Type order is left: Income, Refunds, Existing funds, New debt; right: Expenses, Debt, Savings, Excess. Within a family use absolute amount descending, localized label, then stable ID. `Other` stays last inside its family.
- Preserve exact transaction IDs, grouped-node component details, refund coverage, dashboard-currency tolerance, and blocking unclassified/FX audit behavior.
- Pass-through supported inbound kinds are Revenue, Refund, and Liability; supported outbound kinds are Available, Expense, Savings, and Liability. Pass-through-to-pass-through is an internal reallocation. Available/Savings-to-pass-through is blocking unclassified evidence.
- A selected pass-through account balances with explicit `Existing pass-through funds` or `Retained in <account>` residuals; never call prior balance income or force retained balance into Available.
- Mobile and desktop, light and dark, 44px targets, intrinsic SVG scrolling, keyboard/pointer interaction, and exact transaction drill-down remain required.
- Update all 11 locale files: `de-DE.json`, `en.json`, `es-MX.json`, `fr.json`, `it.json`, `ko.json`, `pl.json`, `pt-BR.json`, `ro.json`, `ru-RU.json`, and `zh-CN.json`.
- Use Prettier formatting from `front/.prettierrc`; avoid whole-file stylesheet churn when existing CSS baseline drift is unrelated.
- Exact real account names, amounts, tokens, URLs, and other private data belong only in ignored verification evidence.

---

## File responsibility map

- `front/utils/AnalyticsCategoryPresentationUtils.js`: generic deterministic item comparator with optional family rank and label projector; no financial classification.
- `front/utils/AnalyticsUtils.js`: Money Flow family mapping, graph ordering, threshold grouping, pass-through pools, conservation, and audit.
- `front/stores/analyticsStoreFactory.js`: persisted/normalized settings, eligible/effective pass-through IDs, and Money Flow projection inputs.
- `front/utils/ChartUtils.js`: interaction repair when a graph setting removes the active node/link; existing exact-selection projection remains authoritative.
- `front/components/charts/layered-money-flow-chart.vue`: dispatch interaction repair when graph targets change; no financial sorting.
- `front/components/analytics/analytics-money-flow.vue`: controls, account-role selector, localized final graph ordering, labels, audit copy, and existing drill-down.
- `front/assets/styles/theme-white.css` and `front/assets/styles/theme-dark.css`: responsive controls, selector, pass-through visual treatment, and dark override.
- `front/i18n/locales/*.json`: all new visible labels and messages.
- `front/tests/utils/AnalyticsUtils.test.js`: graph accounting/detail behavior.
- `front/tests/utils/AnalyticsCategoryPresentationUtils.test.js`: comparator behavior.
- `front/tests/stores/analyticsStore.test.js`: persistence, role eligibility, selector projection, and SSR card behavior.
- `front/tests/utils/ChartUtils.test.js`: interaction repair and exact-selection behavior.

---

### Task 1: Add semantic ordering and minimum-amount detail

**Files:**
- Modify: `front/utils/AnalyticsCategoryPresentationUtils.js`
- Modify: `front/utils/AnalyticsUtils.js`
- Test: `front/tests/utils/AnalyticsCategoryPresentationUtils.test.js`
- Test: `front/tests/utils/AnalyticsUtils.test.js`

**Interfaces:**
- Consumes: existing Money Flow graph `{ nodes, links }`, existing compatible grouping keys in `limitMoneyFlowGraphDetail()`.
- Produces: `sortMoneyFlowPresentationItems(items, { familyRank, labelOf } = {})`, `orderMoneyFlowGraph({ graph, orderMode, labelOf })`, and `limitMoneyFlowGraphDetail({ graph, detailLevel, minimumAmount = 0 })`.
- Later tasks rely on `orderMode` values `amount` and `type`, detail value `threshold`, and final link ordering based on the visible node order.

- [ ] **Step 1: Write RED comparator tests with literal expected orders**

Add tests that name the two wrong production mutations: ignoring the semantic family rank and ignoring localized labels on equal amounts.

```js
test('money flow type ordering groups the right side by family before amount', () => {
  const items = [
    { id: 'excess', kind: 'newExcess', value: 500, label: 'Excess' },
    { id: 'saving', kind: 'savingsDeposit', value: 400, label: 'Saving' },
    { id: 'debt', kind: 'debtPaid', value: 300, label: 'Debt' },
    { id: 'expense-b', kind: 'expenseCategory', value: 20, label: 'Beta' },
    { id: 'expense-a', kind: 'expenseCategory', value: 20, label: 'Alpha' },
  ]

  assert.deepEqual(
    CategoryPresentation.sortMoneyFlowPresentationItems(items, {
      familyRank: (item) => ({ expenseCategory: 0, debtPaid: 1, savingsDeposit: 2, newExcess: 3 })[item.kind],
      labelOf: (item) => item.label,
    }).map(({ id }) => id),
    ['expense-a', 'expense-b', 'debt', 'saving', 'excess'],
  )
})
```

Add `orderMoneyFlowGraph()` fixtures with left-side kinds `income`, `refund`, `existingAvailable`, `existingSavings`, `newDebt`; right-side kinds `expenseCategory`, `debtPaid`, `savingsDeposit`, `newExcess`; and `Other` nodes inside more than one family. Assert both complete literal ID orders. Add an Amount-mode assertion proving the highest absolute value wins across families and all `Other` nodes remain last.

- [ ] **Step 2: Run the comparator tests and capture RED**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/AnalyticsUtils.test.js
```

Expected: FAIL because the comparator does not accept a family rank/label projector and `orderMoneyFlowGraph` does not exist.

- [ ] **Step 3: Implement the generic comparator and pure graph orderer**

Keep `AnalyticsCategoryPresentationUtils.js` free of Money Flow financial policy:

```js
export const sortMoneyFlowPresentationItems = (items, { familyRank = () => 0, labelOf = (item) => item.refId ?? item.id } = {}) =>
  [...items].sort((left, right) => {
    const leftFamily = familyRank(left)
    const rightFamily = familyRank(right)
    const leftIsOther = String(left.id).startsWith('other:') || String(left.kind).startsWith('other') || left.label === 'Other'
    const rightIsOther = String(right.id).startsWith('other:') || String(right.kind).startsWith('other') || right.label === 'Other'
    return (
      leftFamily - rightFamily ||
      Number(leftIsOther) - Number(rightIsOther) ||
      Math.abs(right.value) - Math.abs(left.value) ||
      String(labelOf(left) ?? left.refId ?? left.id).localeCompare(String(labelOf(right) ?? right.refId ?? right.id)) ||
      String(left.id).localeCompare(String(right.id))
    )
  })
```

In `AnalyticsUtils.js`, define explicit source/destination family rank helpers and export:

```js
export function orderMoneyFlowGraph({ graph, orderMode = 'amount', labelOf = (node) => node.label ?? node.refId ?? node.id }) {
  // Sort each layer, applying source ranks only to the first layer and
  // destination ranks only to the last. Keep the fixed middle accounting
  // order, then rebuild link order from the resulting node positions.
}
```

The middle accounting rank must cover income/refund groups, pass-through pools, Available, accessible/restricted Savings, Expenses, Debt, Savings deposited, and Excess. Unknown middle kinds fall back after known kinds with stable label/ID ordering.

- [ ] **Step 4: Write RED threshold-detail tests**

Use the existing `ledgerEntry()`/`buildLedgerFlow()` helpers to build one compatible expense group with values `120`, `40`, and `20`, plus one compatible accessible-savings destination group with values `70` and `35`. At threshold `50`, the two small expenses become `Other`; the lone small savings destination remains named because its compatible sibling is visible.

```js
test('minimum amount groups two compatible siblings but keeps a lone sibling named', () => {
  const thresholdGraph = buildLedgerFlow([
    ledgerEntry({ id: 'expense-large', value: 120, sourceKind: 'available', destinationKind: 'expense', categoryId: 'large' }),
    ledgerEntry({ id: 'expense-40', value: 40, sourceKind: 'available', destinationKind: 'expense', categoryId: 'small-40' }),
    ledgerEntry({ id: 'expense-20', value: 20, sourceKind: 'available', destinationKind: 'expense', categoryId: 'small-20' }),
    ledgerEntry({ id: 'saving-large', value: 70, sourceKind: 'available', destinationKind: 'savingsAccessible', destinationAccountId: 'reserve-large' }),
    ledgerEntry({ id: 'saving-only', value: 35, sourceKind: 'available', destinationKind: 'savingsAccessible', destinationAccountId: 'reserve-only' }),
  ])
  const limited = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph: thresholdGraph, detailLevel: 'threshold', minimumAmount: 50 })

  assert.deepEqual(limited.nodes.filter(({ kind }) => ['expenseCategory', 'otherExpenseCategory'].includes(kind)).map(({ id }) => id), [
    'expense:large',
    'other:expenses:available:positive',
  ])
  assert.deepEqual(limited.nodes.find(({ id }) => id === 'other:expenses:available:positive').transactionIds, ['expense-20', 'expense-40'])
  assert.equal(limited.nodes.some(({ id }) => id === 'savingsDeposit:reserve-only'), true)
  assert.equal(limited.nodes.some(({ id }) => id.startsWith('other:savingsDeposited')), false)
})
```

Add literal boundary cases for threshold `0`, equality at `50`, negative node values by absolute amount, different funding pools, different savings groups, and `detailLevel: 5/10/'all'` regression behavior.

- [ ] **Step 5: Run threshold tests and capture RED**

Run the same focused command. Expected: FAIL because `'threshold'` currently becomes an unlimited numeric fallback and groups a lone compatible sibling incorrectly or not at all.

- [ ] **Step 6: Extend compatible grouping without duplicating Top-N logic**

Inside `limitMoneyFlowGraphDetail()` derive hidden nodes per existing compatibility group:

```js
const hidden =
  detailLevel === 'threshold'
    ? ranked.filter(({ value }) => Math.abs(value) < minimumAmount)
    : ranked.slice(Number.isFinite(limit) && limit >= 0 ? limit : ranked.length)
if (detailLevel === 'threshold' && hidden.length < 2) continue
```

Validate `minimumAmount` with `Number.isFinite()` and `>= 0`; callers normalize invalid persisted values, while the pure function safely treats an invalid direct value as `0`. Reuse existing Other-node/link rewiring, component detail, refund coverage, and transaction-ID aggregation.

After grouping, call `orderMoneyFlowGraph()` rather than maintaining a second link-order implementation.

- [ ] **Step 7: Verify GREEN and mutation coverage**

Run the focused command. Then temporarily mutate the expense family rank and the `hidden.length < 2` guard; confirm the new tests fail for the expected literal order/identity, restore production, and rerun GREEN.

- [ ] **Step 8: Run scoped static checks and commit**

```powershell
cd front
npx eslint utils/AnalyticsCategoryPresentationUtils.js utils/AnalyticsUtils.js tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/AnalyticsUtils.test.js --max-warnings 0
npx prettier --check utils/AnalyticsCategoryPresentationUtils.js utils/AnalyticsUtils.js tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/AnalyticsUtils.test.js
cd ..
git diff --check
git add front/utils/AnalyticsCategoryPresentationUtils.js front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsCategoryPresentationUtils.test.js front/tests/utils/AnalyticsUtils.test.js
git commit -m "feat: add money flow ordering and threshold detail"
```

---

### Task 2: Add transaction-backed pass-through account pools

**Files:**
- Modify: `front/utils/AnalyticsUtils.js`
- Test: `front/tests/utils/AnalyticsUtils.test.js`

**Interfaces:**
- Consumes: `buildMonthlyMoneyFlow({ entries, monthKey, currencyDecimalPlaces, savingsView, passThroughAccountIds = [], passThroughEnabled = false })`.
- Produces: named nodes `passThrough:<accountId>`, `existingPassThrough:<accountId>`, and `retainedPassThrough:<accountId>`; `audit.passThrough[accountId]`; `audit.passThroughReallocations`; and blocking unsupported-transition IDs in the existing unclassified contract.
- Stage map when effective: source `0`, group `1`, pass-through `2`, Available `3`, Savings `4`, Uses `5`, destinations `6`. With treatment disabled/no effective IDs, preserve the previous stage map and graph bytes in Amount mode.

- [ ] **Step 1: Write the treatment-off and balanced-distribution RED tests**

Add a fixture with an available account named only by ID `payroll`, an ordinary available account `checking`, a savings account `espp`, an expense category `tax`, and a debit liability `loan`.

```js
test('pass-through treatment off preserves the existing Available graph', () => {
  const passThroughEntries = [
    ledgerEntry({ id: 'salary', value: 100, sourceKind: 'revenue', destinationKind: 'available', destinationAccountId: 'payroll', categoryId: 'salary' }),
    ledgerEntry({ id: 'tax', value: 30, sourceKind: 'available', destinationKind: 'expense', sourceAccountId: 'payroll', categoryId: 'tax' }),
  ]
  const before = buildLedgerFlow(passThroughEntries)
  const off = buildLedgerFlow(passThroughEntries, { passThroughAccountIds: ['payroll'], passThroughEnabled: false })
  assert.deepEqual(off, before)
})

test('routes supported payroll distributions through one balanced named pass-through pool', () => {
  const graph = buildLedgerFlow(
    [
      ledgerEntry({ id: 'salary', value: 100, sourceKind: 'revenue', destinationKind: 'available', destinationAccountId: 'payroll', categoryId: 'salary' }),
      ledgerEntry({ id: 'tax', value: 30, sourceKind: 'available', destinationKind: 'expense', sourceAccountId: 'payroll', categoryId: 'tax' }),
      ledgerEntry({ id: 'espp', value: 20, sourceKind: 'available', destinationKind: 'savingsAccessible', sourceAccountId: 'payroll', destinationAccountId: 'espp' }),
      ledgerEntry({ id: 'checking', value: 40, sourceKind: 'available', destinationKind: 'available', sourceAccountId: 'payroll', destinationAccountId: 'checking' }),
    ],
    { passThroughAccountIds: ['payroll'], passThroughEnabled: true },
  )

  assert.equal(linkValue(graph, 'income', 'passThrough:payroll'), 100)
  assert.equal(linkValue(graph, 'passThrough:payroll', 'expenses'), 30)
  assert.equal(linkValue(graph, 'passThrough:payroll', 'available'), 40)
  assert.equal(linkValue(graph, 'passThrough:payroll', 'savings'), 20)
  assert.equal(linkValue(graph, 'passThrough:payroll', 'retainedPassThrough:payroll'), 10)
  assert.equal(graph.isBalanced, true)
})
```

Expected mutations caught: still treating `payroll` as Available; double-counting the salary deposit; forcing the retained `10` into generic `newExcess`.

- [ ] **Step 2: Run focused tests and capture RED**

```powershell
cd front
node --test tests/utils/AnalyticsUtils.test.js
```

Expected: treatment-off passes, balanced pass-through test fails because the new options/nodes do not exist.

- [ ] **Step 3: Add stage and endpoint helpers before changing branches**

Implement a normalized ID set and a stage map:

```js
const passThroughIds = new Set(passThroughEnabled ? passThroughAccountIds.map(String) : [])
const hasPassThrough = passThroughIds.size > 0
const stages = hasPassThrough
  ? { source: 0, group: 1, passThrough: 2, available: 3, savings: 4, use: 5, destination: 6 }
  : { source: 0, group: 1, available: 2, savings: 3, use: 4, destination: 5 }
const isPassThroughSide = (entry, side) => passThroughIds.has(String(entry?.[`${side}Account`]?.id ?? ''))
```

Replace numeric layer literals in this builder with `stages.*`. Do not change ledger kinds or shared account classification.

- [ ] **Step 4: Build per-account pools from supported actual transitions**

Create one pool record per selected account:

```js
const passThroughPools = new Map()
const passThroughPool = (account) => {
  const refId = accountId(account, 'unknown-pass-through')
  const pool = passThroughPools.get(refId) ?? { refId, account, incoming: 0, outgoing: 0, incomingTransactionIds: new Set(), outgoingTransactionIds: new Set() }
  passThroughPools.set(refId, pool)
  return pool
}
```

Before ordinary Available branches, handle the exact supported transitions from the design. Revenue/refund/liability-to-pass-through adds source/group links into `passThrough:<id>`. Pass-through-to-Available/Expense/Savings/Liability adds real links from that pool and preserves destination-account/category handling. Pass-through-to-pass-through records an internal reallocation only and does not enter outer totals.

Do not trace deposits to individual withdrawals. The pool aggregates selected-month incoming/outgoing and retains the actual transaction IDs on each real link.

- [ ] **Step 5: Write residual and unsupported-transition RED tests**

Add literal fixtures proving:

- incoming `100`, outgoing `120` creates `existingPassThrough:payroll -> passThrough:payroll` value `20`, no retained node, and balanced totals;
- incoming `100`, outgoing `70` creates retained value `30`, no existing source;
- two selected payroll accounts balance independently and do not share residuals;
- Available -> selected pass-through adds the exact transaction ID to `unclassified.transactionIds`, makes `isBalanced` false, and creates no visible pass-through graph route for that transfer;
- Savings -> selected pass-through behaves the same;
- selected pass-through -> selected pass-through appears only in `audit.passThroughReallocations` with exact source/target account IDs, amount, and transaction IDs.

Run the focused test and confirm RED for missing residual/audit behavior.

- [ ] **Step 6: Finalize residuals and audit**

After processing actual entries, balance each pool:

```js
const delta = pool.incoming - pool.outgoing
if (delta < 0) addExistingPassThroughSource(pool, -delta)
if (delta > 0) addRetainedPassThroughDestination(pool, delta)
```

`audit.passThrough[id]` must contain `incoming`, `outgoing`, and `net` before the residual is added, plus sorted incoming/outgoing transaction IDs. Residual nodes carry no synthetic transaction ID; their `details` contain real contributing rows/IDs. Add residual values once to global total sources/destinations so the graph equation remains balanced.

Unsupported pass-through transitions call the existing `addUnclassified()` with the actual amount and transaction ID. Do not silently fall through to Available behavior while treatment is enabled.

- [ ] **Step 7: Verify GREEN, disabled equivalence, and mutation coverage**

Run `node --test tests/utils/AnalyticsUtils.test.js`. Mutate one pass-through source ID back to `available`, change the residual sign, and remove the unsupported branch one at a time; confirm the corresponding literal test fails, restore, and rerun GREEN.

- [ ] **Step 8: Run scoped static checks and commit**

```powershell
cd front
npx eslint utils/AnalyticsUtils.js tests/utils/AnalyticsUtils.test.js --max-warnings 0
npx prettier --check utils/AnalyticsUtils.js tests/utils/AnalyticsUtils.test.js
cd ..
git diff --check
git add front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsUtils.test.js
git commit -m "feat: add money flow pass-through pools"
```

---

### Task 3: Persist and normalize Money Flow account-role settings

**Files:**
- Modify: `front/stores/analyticsStoreFactory.js`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Produces store refs/computeds: `moneyFlowOrder`, `moneyFlowMinimumAmount`, `passThroughAccountIds`, `eligiblePassThroughAccounts`, `effectivePassThroughAccountIds`, and `moneyFlowPassThroughEnabled`.
- Storage keys: `analyticsMoneyFlowOrder`, `analyticsMoneyFlowMinimumAmount`, `analyticsPassThroughAccountIds`, and `analyticsMoneyFlowUsePassThrough`.
- Extends `graphDetail` accepted values with `threshold`.
- Passes effective IDs/enabled state only into `buildMonthlyMoneyFlow()`, and passes threshold only into `limitMoneyFlowGraphDetail()`.

- [ ] **Step 1: Write RED persistence and repair tests**

Using the existing `storageOverrides`/`useStoredValue` test seam, add a fixture with active default asset `payroll`, active savings-role asset `hysa`, inactive asset `closed`, liability `loan`, and cash `wallet`.

Assert literal behavior:

```js
assert.deepEqual(store.eligiblePassThroughAccounts.map(({ id }) => id), ['payroll', 'wallet'])
assert.deepEqual(store.effectivePassThroughAccountIds, ['payroll'])
assert.equal(store.moneyFlowOrder, 'type')
assert.equal(store.graphDetail, 'threshold')
assert.equal(store.moneyFlowMinimumAmount, 125.5)
assert.equal(store.moneyFlowPassThroughEnabled, true)
```

Add corrupt storage cases: unknown order repairs to `amount`; an initially negative/NaN threshold repairs to `0`; assigning an invalid threshold after a valid value retains the last valid value; duplicate/missing/ineligible account IDs do not enter the effective selection; unknown detail repairs to `5`. Assert selected IDs remain saved when enabled is toggled false.

- [ ] **Step 2: Run store tests and capture RED**

```powershell
cd front
node --test tests/stores/analyticsStore.test.js
```

Expected: FAIL because the new stored values and store surface do not exist and `threshold` repairs to `5`.

- [ ] **Step 3: Add exact stored values and normalization**

Near existing Money Flow stored state:

```js
const storedMoneyFlowOrder = useStoredValue('analyticsMoneyFlowOrder', 'amount')
const storedMoneyFlowMinimumAmount = useStoredValue('analyticsMoneyFlowMinimumAmount', 0)
const storedPassThroughAccountIds = useStoredValue('analyticsPassThroughAccountIds', [])
const storedMoneyFlowPassThroughEnabled = useStoredValue('analyticsMoneyFlowUsePassThrough', false)
```

Normalize order against `['amount', 'type']`, detail against `[5, 10, 'all', 'threshold']`, threshold as finite/nonnegative, and account IDs as unique nonempty strings. Do not mutate stored account IDs before the account snapshot is loaded; compute effective IDs from the current eligible list. Expose `passThroughAccountIds` as a writable computed that normalizes unique nonempty string IDs on set, while `effectivePassThroughAccountIds` remains a read-only computed intersection with eligible accounts.

`eligiblePassThroughAccounts` is sorted by human-readable account name only if the store has an existing model helper available; otherwise use stable ID and let the card apply localized display ordering. Eligibility requires `attributes.active === true` and `getAnalyticsAccountKind(account) === 'available'`.

- [ ] **Step 4: Route settings through selected Money Flow only**

Extend `selectedFullFlow`:

```js
buildMonthlyMoneyFlow({
  entries: ledger.value.entries,
  monthKey: format(selectedFlowMonth.value, 'yyyy-MM'),
  currencyDecimalPlaces: displayCurrencyDecimalPlaces.value,
  savingsView: savingsView.value,
  passThroughAccountIds: effectivePassThroughAccountIds.value,
  passThroughEnabled: moneyFlowPassThroughEnabled.value && effectivePassThroughAccountIds.value.length > 0,
})
```

Extend `selectedFlow` with `minimumAmount`, include settings in `meta`, and keep `details.nodes/links` from the full ungrouped graph. Do not pass role IDs into `ledger`, forecast, category, balance, or Cash Use computations.

- [ ] **Step 5: Add projection-isolation tests and verify GREEN**

Use the store's real `selectedFlow` projection rather than inventing a dependency seam that the factory does not expose. Assert:

- the selected graph and `meta` show the effective role IDs/enabled flag when treatment is on;
- threshold mode changes the selected graph using the exact stored currency value while `details.nodes`/`details.links` retain the full graph;
- disabling treatment restores the pre-feature selected Money Flow for the same ledger/month/detail/order while preserving the stored IDs;
- before/after snapshots of `ledger`, balance series, forecast, Cash Use series, and category summary are deeply equal when only these Money Flow settings change.

Run store tests GREEN. Mutate eligibility to include `savingAsset`; confirm the repair test fails, restore, and rerun.

- [ ] **Step 6: Run scoped checks and commit**

```powershell
cd front
npx eslint stores/analyticsStoreFactory.js tests/stores/analyticsStore.test.js --max-warnings 0
npx prettier --check stores/analyticsStoreFactory.js tests/stores/analyticsStore.test.js
cd ..
git diff --check
git add front/stores/analyticsStoreFactory.js front/tests/stores/analyticsStore.test.js
git commit -m "feat: persist money flow account roles"
```

---

### Task 4: Repair chart interaction and exact inspection across graph changes

**Files:**
- Modify: `front/utils/ChartUtils.js`
- Modify: `front/components/charts/layered-money-flow-chart.vue`
- Test: `front/tests/utils/ChartUtils.test.js`

**Interfaces:**
- Extends `resolveMoneyFlowInteraction({ state, action, targets })` with action `{ type: 'targetsChanged' }`.
- The action preserves preview/selection/focus only when the exact `{ type, id }` target still exists; otherwise it clears the stale state and emits no selection.
- Existing node/link click payloads and `projectMoneyFlowTransactionSelection()` remain actual-ID-only.

- [ ] **Step 1: Write RED reducer tests for stale settings changes**

```js
test('money flow interaction clears stale preview and pin when controls replace their targets', () => {
  const original = [
    { type: 'node', id: 'expense:small' },
    { type: 'link', id: 'expenses->expense:small' },
  ]
  let state = ChartUtils.resolveMoneyFlowInteraction({ state: {}, action: { type: 'preview', target: original[0] }, targets: original })
  state = ChartUtils.resolveMoneyFlowInteraction({ state, action: { type: 'select', target: original[0], contextNodes: [] }, targets: original })

  const repaired = ChartUtils.resolveMoneyFlowInteraction({ state, action: { type: 'targetsChanged' }, targets: [{ type: 'node', id: 'other:expenses' }] })

  assert.equal(repaired.preview, null)
  assert.equal(repaired.selection, null)
  assert.equal(repaired.focusTarget, null)
})
```

Add a preservation case where the target still exists but its label/value changed. Add an empty-target case after condensed/threshold mode. Expected mutations caught: matching by index instead of stable ID; preserving a removed pinned target.

- [ ] **Step 2: Run ChartUtils tests and capture RED**

```powershell
cd front
node --test tests/utils/ChartUtils.test.js
```

Expected: FAIL because `targetsChanged` is ignored.

- [ ] **Step 3: Implement reducer repair and chart watcher**

In the pure reducer, use exact target identity:

```js
const targetExists = (target, targets) => target && targets.some(({ type, id }) => type === target.type && id === target.id)
```

For `targetsChanged`, keep only states whose targets still exist. Clear drag/pointer-start state as well so a later pointer-up cannot select a removed ribbon.

In `layered-money-flow-chart.vue`, watch a stable target signature derived from `interactionTargets` and dispatch `targetsChanged` after graph/detail/order/pass-through changes. Do not emit `select-node` or `select-link` from repair.

- [ ] **Step 4: Add exact pass-through and grouped-selection tests**

Use a logical pass-through link and a threshold `Other` link with actual transaction IDs. Assert `projectMoneyFlowTransactionSelection()` returns:

- a transaction-list route containing only the sorted actual transaction IDs;
- no synthetic residual node IDs;
- refund coverage IDs when present; and
- resolved rows from the full graph when the visible link targets grouped nodes.

If existing behavior already passes, retain only assertions that catch a realistic regression in changed integration code. Do not add source-text regex tests for unchanged helper names.

- [ ] **Step 5: Verify GREEN, static checks, and commit**

```powershell
cd front
node --test tests/utils/ChartUtils.test.js
npx eslint utils/ChartUtils.js components/charts/layered-money-flow-chart.vue tests/utils/ChartUtils.test.js --max-warnings 0
npx prettier --check utils/ChartUtils.js components/charts/layered-money-flow-chart.vue tests/utils/ChartUtils.test.js
cd ..
git diff --check
git add front/utils/ChartUtils.js front/components/charts/layered-money-flow-chart.vue front/tests/utils/ChartUtils.test.js
git commit -m "fix: repair money flow interaction state"
```

---

### Task 5: Integrate Money Flow controls, labels, themes, and runtime proof

**Files:**
- Modify: `front/components/analytics/analytics-money-flow.vue`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: `front/i18n/locales/de-DE.json`
- Modify: `front/i18n/locales/en.json`
- Modify: `front/i18n/locales/es-MX.json`
- Modify: `front/i18n/locales/fr.json`
- Modify: `front/i18n/locales/it.json`
- Modify: `front/i18n/locales/ko.json`
- Modify: `front/i18n/locales/pl.json`
- Modify: `front/i18n/locales/pt-BR.json`
- Modify: `front/i18n/locales/ro.json`
- Modify: `front/i18n/locales/ru-RU.json`
- Modify: `front/i18n/locales/zh-CN.json`
- Test: `front/tests/stores/analyticsStore.test.js`
- Test: `front/tests/utils/ChartUtils.test.js`

**Interfaces:**
- Consumes Task 1 `orderMoneyFlowGraph()`, Task 3 store settings/eligible accounts, Task 4 interaction repair, existing `Account.getDisplayName()`/account dictionary and transaction routing.
- Produces four Detail options, two Order options, a searchable multi-select of eligible account entities, one enabled switch, localized final chart graph, pass-through audit rows/messages, and responsive styles.

- [ ] **Step 1: Write RED SSR/card contract tests**

Extend the existing `renderAnalyticsCard()` stub list only for real components newly rendered (`app-select`, `app-boolean`, and the existing threshold input wrapper). Render the Money Flow card with literal context and assert observable HTML contains:

- both order options;
- all four detail options;
- the minimum-amount field only in threshold mode;
- the pass-through account selector and enabled switch;
- a disabled/no-effect switch state when selection is empty;
- one blocking unsupported-transition message plus retry/disable affordance; and
- no raw selected account ID when a display name exists.

Avoid tests that only grep source text. Render the real template branch and assert output/attributes.

- [ ] **Step 2: Run focused card/store tests and capture RED**

```powershell
cd front
node --test tests/stores/analyticsStore.test.js tests/utils/ChartUtils.test.js
```

Expected: FAIL because the new controls and labels are not rendered.

- [ ] **Step 3: Add localized control models and account adapter**

In the card:

```js
const orderItems = computed(() => [
  { label: t('analytics.flow.order_amount'), value: 'amount' },
  { label: t('analytics.flow.order_type'), value: 'type' },
])
const detailItems = computed(() => [
  { label: t('analytics.flow.top_5'), value: 5 },
  { label: t('analytics.flow.top_10'), value: 10 },
  { label: t('analytics.flow.all'), value: 'all' },
  { label: t('analytics.flow.minimum_amount'), value: 'threshold' },
])
const selectedPassThroughAccounts = computed({
  get: () => analyticsStore.effectivePassThroughAccountIds.map((id) => accountStore.accountDictionary[id]).filter(Boolean),
  set: (accounts) => {
    analyticsStore.passThroughAccountIds = accounts.map(({ id }) => String(id))
  },
})
```

Use `app-select` directly with `analyticsStore.eligiblePassThroughAccounts`, multi-select enabled, search enabled, and `Account.getDisplayName` for tags/options. This avoids widening the general account selector with analytics-only policy.

Use the existing numeric/currency field pattern for the threshold. Keep the stored value in dashboard-currency units and display the currency code in the label or suffix.

- [ ] **Step 4: Apply localized final ordering and pass-through labels**

Map raw nodes to labels/colors first, then order:

```js
const chartGraph = computed(() => {
  const labelled = {
    ...flow.value,
    nodes: flow.value.nodes.map((node) => ({ ...node, label: nodeLabel(node), color: resolveMoneyFlowSemanticColor(node) })),
    links: flow.value.links.map((link) => ({ ...link, color: resolveMoneyFlowSemanticColor(link) })),
  }
  return orderMoneyFlowGraph({ graph: labelled, orderMode: analyticsStore.moneyFlowOrder, labelOf: (node) => node.label })
})
```

Add node labels for `passThrough`, `existingPassThrough`, and `retainedPassThrough`. Pass-through pool/retained labels include the account display name. Extend audit sections with each account's incoming/outgoing/net and internal reallocation details. Exact Details remains full-graph-backed.

- [ ] **Step 5: Add all locale keys and responsive styles**

Add the same nonempty key structure under `analytics.flow` in all 11 locales, including:

```json
{
  "order": "Order",
  "order_amount": "Amount",
  "order_type": "Type, then amount",
  "minimum_amount": "Minimum amount",
  "pass_through_accounts": "Pass-through accounts",
  "use_pass_through": "Use pass-through treatment",
  "pass_through_pool": "Pass-through",
  "existing_pass_through": "Existing pass-through funds",
  "retained_pass_through": "Retained in {account}",
  "pass_through_unsupported": "Some pass-through account movements cannot be classified without double-counting.",
  "disable_pass_through": "Show original Available view"
}
```

Translations may use accurate localized wording; do not leave English placeholders in non-English files.

Add `.analytics-flow-order-control`, `.analytics-flow-threshold-control`, `.analytics-flow-pass-through-control`, and selector/notice styles to `theme-white.css`. Use existing card/control variables, 6–10px radii, small type, 44px minimum interactive targets, wrapping on narrow screens, and no page-level horizontal overflow. Add only required dark color/surface overrides to `theme-dark.css`; do not duplicate layout declarations.

- [ ] **Step 6: Verify focused GREEN and locale parity**

```powershell
cd front
node --test tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/AnalyticsUtils.test.js tests/utils/ChartUtils.test.js tests/stores/analyticsStore.test.js
Get-ChildItem i18n/locales/*.json | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json | Out-Null }
```

Add a structural assertion that all 11 locale files contain the exact new keys with nonempty string values. Mutate one locale key or type-order label and confirm the relevant test fails, restore, and rerun GREEN.

- [ ] **Step 7: Run broad automated and production-build gates**

```powershell
cd front
npm run test:analytics
npx eslint components/analytics/analytics-money-flow.vue components/charts/layered-money-flow-chart.vue stores/analyticsStoreFactory.js utils/AnalyticsUtils.js utils/AnalyticsCategoryPresentationUtils.js utils/ChartUtils.js tests/utils/AnalyticsUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/ChartUtils.test.js tests/stores/analyticsStore.test.js --max-warnings 0
npx prettier --check components/analytics/analytics-money-flow.vue components/charts/layered-money-flow-chart.vue stores/analyticsStoreFactory.js utils/AnalyticsUtils.js utils/AnalyticsCategoryPresentationUtils.js utils/ChartUtils.js tests/utils/AnalyticsUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/ChartUtils.test.js tests/stores/analyticsStore.test.js i18n/locales/*.json
npm run build
cd ..
git diff --check
pwsh -NoProfile -File .agents/skills/firefly-pico-oss-contribution/scripts/contribution-preflight.ps1
```

For theme files, check only the added blocks against Prettier when whole-file baseline drift is unchanged; record the exact baseline distinction in the report.

- [ ] **Step 8: Build the exact local Docker image**

```powershell
docker-compose -f docker-compose.pico.local.yml build firefly-pico
```

Expected: `npm ci --ignore-scripts`, Nuxt build, prune, and image export all succeed. Record the resulting image ID and existing dependency/toolchain warnings separately.

- [ ] **Step 9: Perform authenticated Chrome verification against the final image**

Run/replace only the disposable analytics preview container while preserving its named volume. Verify in Chrome:

1. Amount/off matches the original Available graph.
2. Enabling one configured pass-through account produces named incoming/outgoing/residual paths without duplicate income.
3. Type order matches both approved outer-family sequences.
4. Top 5, Top 10, All, and several threshold values update graph, labels, exact values, and `Other` together.
5. One sub-threshold sibling stays named; two-or-more compatible siblings become `Other`.
6. Unsupported pass-through input presents exact audit evidence and the original-view recovery action.
7. Hover, click/tap, keyboard traversal, pinned details, and exact transaction drill-down work after every control change.
8. Desktop/mobile and light/dark remain readable, use 44px targets, and avoid page overflow.
9. Browser console contains no feature-attributable warnings/errors.

Do not write real account names or amounts into tracked evidence.

- [ ] **Step 10: Commit the integration**

```powershell
git add front/components/analytics/analytics-money-flow.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests/stores/analyticsStore.test.js front/tests/utils/ChartUtils.test.js
git diff --cached --check
git commit -m "feat: add money flow configuration controls"
```

---

## Final branch review

After all five tasks have clean task-scoped reviews:

1. Generate one review package covering the implementation-plan base through HEAD.
2. Dispatch the most capable available reviewer against the design, plan, task reports, and implementation diff.
3. If findings exist, dispatch one complete fix wave, then one scoped re-review.
4. Rerun focused, full analytics, build, Docker, and relevant authenticated Chrome checks after any final fix.
5. Leave the branch and working tree clean; do not push or open a PR.
