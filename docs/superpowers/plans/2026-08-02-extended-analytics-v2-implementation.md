# Extended Analytics V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct Firefly Pico's analytics semantics and deliver explainable balance, expense, savings, debt, and layered money-flow forecasts with readable desktop/mobile charts.

**Architecture:** Keep Firefly III as the system of record and extend Pico's existing pure analytics utilities, Pinia store factory, SVG chart primitives, and Vant-based analytics cards. Account-chart data continues to drive balances; one filtered 24-month transaction load continues to drive category and money-flow calculations. No backend endpoint, migration, or chart dependency is added.

**Tech Stack:** Plain JavaScript, Vue 3 `<script setup>`, Pinia composition stores, Nuxt 3 SPA, Vant 4, date-fns, Node's built-in test runner, SVG, existing CSS variables and theme files.

## Global Constraints

- Work only on `personal/extended-analytics`; this is personal-fork delivery. Generic pure calculations, chart primitives, and configurable controls are the optional upstreamable slice, but no push, issue, or pull request is part of this plan.
- Firefly III remains authoritative. Do not add a backend route, migration, database field, npm dependency, or composer dependency.
- Use plain `.js` and `.vue`; single quotes, no semicolons, trailing commas, 2-space indentation, and no TypeScript or JSDoc types.
- Keep source edits limited to analytics files, shared chart helpers, Tabler icon registration, shared theme files, and all supported locale JSON files. Preserve unrelated user changes.
- Net worth is the signed total of active balance-holding accounts with `include_net_worth === true`.
- Savings is every active asset account with account role `savingAsset`, split by `include_net_worth` when requested.
- Debt is the non-negative magnitude of every active Firefly `liabilities` account. Credit-card assets remain Available assets even when their signed balance is negative.
- Historical and current debt values normalize per liability account before aggregation. Missing or unconvertible values remain unavailable; zero remains an explicit zero.
- Historical averages use only completed calendar months: Financial trends 3/6/12 and Spending by category 3/6/12/24. The unfinished current month never enters an average; forecasts require at least two completed months.
- Per-category expense forecast is `max(actual, completedAverage, actual + averageHistoricalRemainderAfterToday)`; total expense forecast is the sum of every category forecast, including the uncategorized sentinel.
- Every forecast exposes the end-of-month value and `remainingFromToday = endOfMonth - currentActual`. Expense remaining is non-negative; account-balance remaining may have either sign.
- Continue using the selected dashboard currency and existing current-rate conversion. Never coerce a missing rate or value to zero; show the compact `FX: current rates` qualifier when applicable.
- Continue applying `getExcludedTransactionFilters()` to the single transaction load used by Spending and Money flow. Every visible summary or node retains exact contributing transaction IDs.
- Money flow follows immediate transaction accounts, uses separate Available and Savings pools, preserves category/account detail, withholds ribbons for nonzero unclassified activity or failed reconciliation, and never inserts an unexplained balancing node.
- Money-flow detail is persisted as Top 5, Top 10, or All. Ranking is descending absolute display value with stable entity-ID ties; incompatible flows never share one Other node.
- Desktop remains left-to-right; mobile remains top-to-bottom. Preserve at least 28 CSS pixels between visible label baselines and non-overlapping 44-by-44 CSS-pixel interaction targets; condense outer mobile layers only when those constraints cannot be met.
- Preserve hover, touch, keyboard, crosshair, accessible announcement, exact-value, and drill-down behavior. Respect `profileStore.showAnimations`, both themes, and the `appStore.isDesktopLayout` branch.
- Add every new label to `en.json`, `ro.json`, `zh-CN.json`, `it.json`, `pt-BR.json`, `de-DE.json`, `fr.json`, `pl.json`, `ru-RU.json`, `es-MX.json`, and `ko.json`.
- TDD is mandatory for every calculation or behavior change: add one focused test, run it and record the expected failure, implement the minimum behavior, then run it green before refactoring.

## Product and Delivery Boundaries

- **User decision improved:** explain whether wealth, usable savings, long-term savings, debt, and spending are rising; estimate the rest of the month without treating partial-month data as history; show where income and existing funds actually went.
- **Owner-context anchors:** `docs/local/firefly-ux-analytics-handoff.md` sections “Accuracy before visual polish,” “Explainability and observability,” “Transaction types and internal movement,” “Financial dashboard and analytics requirements,” and “Acceptance benchmarks for future work.”
- **Current code anchors:** `front/utils/AnalyticsUtils.js`, `front/stores/analyticsStoreFactory.js`, `front/components/analytics/`, `front/components/charts/`, and the analytics tests under `front/tests/`.
- **Formula decisions:** all forecast, account-membership, flow-routing, grouping, responsive-detail, and currency decisions are resolved in `docs/superpowers/specs/2026-08-02-extended-analytics-forecast-money-flow-v2-design.md`; implementation must not substitute a different policy.
- **Rollout:** the existing `/analytics` route remains the only entry point; persisted controls use repairable local-storage values and default to Combined Savings plus Top 5 flow detail.
- **Rollback:** each task is one focused commit. Reverting a task commit restores the previous behavior for that slice; no data migration or ledger mutation requires rollback.
- **Publication boundary:** commits stay local on the personal branch until the user separately authorizes push or PR work.

---

### Task 1: Correct account membership, debt normalization, and balance forecast metadata

**Files:**
- Modify: `front/utils/AnalyticsUtils.js`
- Test: `front/tests/utils/AnalyticsUtils.test.js`

**Interfaces:**
- Produces: `getAnalyticsAccountGroups(accounts)` returning `{ netWorth, savingsIncluded, savingsExcluded, debt }`.
- Produces: `getAnalyticsCurrentAmount({ account, metric, fallbackAmount })` returning a finite signed non-debt amount, a non-negative debt magnitude, or `null`.
- Produces: `combineSavingsBalanceSeries({ includedSeries, excludedSeries, includedIsEmpty, excludedIsEmpty })` returning the complete combined series or `null` when a non-empty constituent is unavailable.
- Extends: `summarizeBalanceMovements(...)` series items with `remainingFromToday`.
- Preserves: `normalizeBalanceSeries(...)` return shape `{ points, isEstimated, missingCurrencies }`.

- [ ] **Step 1: Write failing account-rule and per-account debt-normalization tests**

Replace the obsolete account-group expectation and add a mixed-sign chart fixture whose hand-derived debt total cannot pass if values are summed before normalization:

```js
test('groups all liabilities as debt and keeps credit cards in available net worth', () => {
  const groups = getAnalyticsAccountGroups([
    account({ id: 'saving-in', role: 'savingAsset', includeNetWorth: true }),
    account({ id: 'saving-out', role: 'savingAsset', includeNetWorth: false }),
    account({ id: 'card', role: 'ccAsset' }),
    account({ id: 'loan', type: 'liabilities', role: null, direction: 'debit' }),
    account({ id: 'receivable', type: 'liabilities', role: null, direction: 'credit' }),
  ])

  assert.deepEqual(groups.savingsIncluded.map(({ id }) => id), ['saving-in'])
  assert.deepEqual(groups.savingsExcluded.map(({ id }) => id), ['saving-out'])
  assert.deepEqual(groups.debt.map(({ id }) => id), ['loan', 'receivable'])
  assert.equal(groups.debt.some(({ id }) => id === 'card'), false)
})

test('normalizes every liability magnitude before aggregation', () => {
  const result = normalizeBalanceSeries({
    metric: 'debt',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    chartLines: [
      { currency_code: 'USD', entries: { '2026-07-31': '-900' } },
      { currency_code: 'USD', entries: { '2026-07-31': '250' } },
    ],
  })
  assert.deepEqual(result.points, [{ x: '2026-07-31', value: 1150 }])
})
```

- [ ] **Step 2: Run the focused utility tests and verify RED**

Run:

```powershell
cd D:\projects\firefly-pico\front
node --test tests/utils/AnalyticsUtils.test.js
```

Expected: FAIL because `savingsIncluded`/`savingsExcluded` do not exist, credit cards still enter Debt, and mixed-sign liabilities currently cancel or clamp after aggregation.

- [ ] **Step 3: Implement the account groups and current-value normalization**

Use these exact group rules and normalize debt before the aggregate reducer:

```js
return {
  netWorth: active.filter((account) => balanceHolding(account) && account?.attributes?.include_net_worth === true),
  savingsIncluded: active.filter((account) => typeOf(account) === 'asset' && roleOf(account) === 'savingAsset' && account?.attributes?.include_net_worth === true),
  savingsExcluded: active.filter((account) => typeOf(account) === 'asset' && roleOf(account) === 'savingAsset' && account?.attributes?.include_net_worth !== true),
  debt: active.filter((account) => typeOf(account) === 'liabilities'),
}
```

`getAnalyticsCurrentAmount(...)` must select `attributes.current_debt` for Debt when nonblank, otherwise `fallbackAmount`, convert to `Number`, return `Math.abs(value)` for Debt, and return `null` for blank/non-finite input.

- [ ] **Step 4: Add failing combined-savings and remaining-from-today tests**

```js
test('combines complete savings groups on their union of dates without inventing early history', () => {
  const combined = combineSavingsBalanceSeries({
    includedSeries: { id: 'savingsIncluded', points: [{ x: '2026-01-31', value: 100 }, { x: '2026-03-31', value: 150 }], currentPoint: { x: '2026-04-10', value: 160 } },
    excludedSeries: { id: 'savingsExcluded', points: [{ x: '2026-02-28', value: 40 }, { x: '2026-03-31', value: 50 }], currentPoint: { x: '2026-04-10', value: 55 } },
    includedIsEmpty: false,
    excludedIsEmpty: false,
  })

  assert.deepEqual(combined.points, [
    { x: '2026-02-28', value: 140 },
    { x: '2026-03-31', value: 200 },
  ])
  assert.equal(combined.currentPoint.value, 215)
})

test('balance forecast reports signed movement remaining from today', () => {
  const result = summarizeBalanceMovements({
    balanceSeries: [{
      id: 'savings',
      points: [
        { x: '2025-12-31', value: 1000 },
        { x: '2026-01-31', value: 1100 },
        { x: '2026-02-28', value: 1200 },
        { x: '2026-03-31', value: 1300 },
      ],
      currentPoint: { x: '2026-04-10', value: 1350 },
    }],
    months: 3,
    today: new Date('2026-04-10T12:00:00'),
  }).series[0]
  assert.equal(result.forecastTotal, 1400)
  assert.equal(result.remainingFromToday, 50)
})
```

Add one unchanged-current fixture with two completed zero changes and assert `currentChange === 0`, `forecastChange === 0`, and `remainingFromToday === 0`; zero is a visible point, not an absent value.

- [ ] **Step 5: Verify RED, implement strict savings combination and remaining metadata, then verify GREEN**

Run the same focused test command before and after implementation. The combined function must:

```text
1. Return null when a non-empty constituent is null.
2. Treat an explicitly empty group as zero.
3. Use the union of dates.
4. Carry a constituent only after its first valid point.
5. Emit a date only when every non-empty constituent has a value.
6. Union missing currencies and warnings and preserve isEstimated.
```

Expected final result: all `AnalyticsUtils.test.js` cases PASS with no process warnings.

- [ ] **Step 6: Commit Task 1**

```powershell
git add front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsUtils.test.js
git commit -m "fix: correct analytics account semantics"
```

### Task 2: Load four balance groups and persist the shared Savings view

**Files:**
- Modify: `front/stores/analyticsStoreFactory.js`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Consumes: Task 1 account groups, current-value normalization, savings-series combination, and balance summary metadata.
- Produces: `savingsView` with values `combined` or `split`, stored under `analyticsSavingsView`.
- Produces: `balanceSeries` containing `netWorth`, `debt`, and either combined `savings` or split `savingsIncluded`/`savingsExcluded`.
- Produces: `availableBalanceMetricIds` and `availableFinancialMetricIds` for the active Savings view.
- Produces: repaired `visibleBalanceMetrics` and `visibleFinancialMetrics` compatible with the active Savings view.
- Preserves: one shared transaction load, balance cache/race protection, stale-data behavior, and public retry/init methods.

- [ ] **Step 1: Add failing persistence and four-group request tests**

Add fixtures for included savings, excluded savings, debit liability, and credit liability. Assert the logical requests without depending on response ordering:

```js
test('repairs the shared savings view and requests four logical balance groups without a unified fifth request', async () => {
  storageOverrides.set('analyticsSavingsView', 'corrupt')
  accountStore.accountList = [activeAsset(), includedSaving(), excludedSaving(), debitLiability(), creditLiability()]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.savingsView, 'combined')
  assert.equal(accountRequests.filter(({ period }) => period !== '1D').length, 4)
  assert.deepEqual(
    accountRequests.filter(({ period }) => period !== '1D').map(({ accountIds }) => [...accountIds].sort()).sort(),
    [['checking', 'saving-included'], ['saving-excluded'], ['saving-included'], ['loan', 'receivable']].sort(),
  )
})
```

Also add one test that assigns `store.savingsView = 'split'`, verifies persistence-compatible normalization, and verifies selected metrics are repaired to valid IDs while retaining at least one selection.

- [ ] **Step 2: Run the store tests and verify RED**

```powershell
cd D:\projects\firefly-pico\front
node --test tests/stores/analyticsStore.test.js
```

Expected: FAIL because only three logical groups and no shared Savings view exist.

- [ ] **Step 3: Implement four-group snapshots and current-value rules**

Use these internal IDs:

```js
const BALANCE_GROUPS = ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt']
const SAVINGS_VIEWS = ['combined', 'split']
```

Build the cache key from all four group ID arrays. Skip empty group requests. For each Debt account, call Task 1's current-value helper before conversion; every non-empty group with an incomplete current value may issue one `1D` current-month fallback. Never issue a `savings` request.

- [ ] **Step 4: Add failing complete/partial combined-series and warning-group tests**

Cover these literal outcomes:

```text
- included 100 + excluded 40 => combined savings 140;
- empty excluded group => combined savings equals included;
- failed non-empty excluded request => no new partial combined series, retained complete data may remain stale;
- the same unverified warning on two selected metrics becomes one grouped warning with both metric IDs;
- four incomplete non-empty groups issue at most four 1D fallbacks, for at most eight total chart calls.
```

The warning assertion must compare structured data such as `{ type, sampleDate, metricIds }`, not localized text.

- [ ] **Step 5: Verify RED, implement combined/split exposure and grouped warnings, then verify GREEN**

Expose a store-level warning collection and derive visible series as:

```js
const balanceSeries = computed(() => {
  const base = currentFourGroupSeries.value
  if (savingsView.value === 'split') return [base.netWorth, base.savingsIncluded, base.savingsExcluded, base.debt].filter(Boolean)
  return [base.netWorth, combinedSavingsSeries.value, base.debt].filter(Boolean)
})
```

Keep request state independent of Savings view so toggling the control does not refetch or create a fifth logical group.

- [ ] **Step 6: Run the focused store and utility regression suite**

```powershell
node --test tests/utils/AnalyticsUtils.test.js tests/stores/analyticsStore.test.js
```

Expected: all tests PASS. Existing concurrency, stale cache, current-point fallback, and selected-currency cases remain green.

- [ ] **Step 7: Commit Task 2**

```powershell
git add front/stores/analyticsStoreFactory.js front/tests/stores/analyticsStore.test.js
git commit -m "feat: add segmented savings analytics"
```

### Task 3: Replace expense forecasting with the approved category-first model

**Files:**
- Modify: `front/utils/AnalyticsUtils.js`
- Modify: `front/utils/AnalyticsCategoryPresentationUtils.js`
- Test: `front/tests/utils/AnalyticsUtils.test.js`
- Test: `front/tests/utils/AnalyticsCategoryPresentationUtils.test.js`

**Interfaces:**
- Produces: `getForecastCategoryIds({ ledger, averageMonths, today })` as the union of completed-window and current-month categories after the shared exclusion filter.
- Extends: each `summarizeCategoryWindow(...)` series item with `pacedForecast`, `currentForecast` as the approved end-of-month forecast, and `remainingFromToday`.
- Changes: `summarizeTotalExpenseWindow(...)` to sum the complete category forecast set rather than run one aggregate maximum.
- Extends: `buildCategorySummaryPresentation(...)` with a localized remaining-from-today row on both desktop and mobile.

- [ ] **Step 1: Add failing three-way forecast tests**

Use literal ledger fixtures for the three distinct floors:

```js
const completedMonths = (keys, categories) => Object.fromEntries(keys.map((key) => [key, { categories: structuredClone(categories) }]))
const housingLedger = {
  ledgerStartMonth: '2026-05',
  months: {
    ...completedMonths(['2026-05', '2026-06', '2026-07'], {
      housing: { amount: 2321, byDay: { 2: 2321 }, transactionIds: [], transactionIdsByDay: {} },
    }),
    '2026-08': { categories: {} },
  },
}
const overspentLedger = {
  ledgerStartMonth: '2026-02',
  months: {
    ...completedMonths(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], {
      food: { amount: 7500, byDay: { 1: 7500 }, transactionIds: [], transactionIdsByDay: {} },
    }),
    '2026-08': {
      categories: {
        food: { amount: 9000, byDay: { 25: 9000 }, transactionIds: ['food-now'], transactionIdsByDay: { 25: ['food-now'] } },
      },
    },
  },
}

test('category forecast preserves a recurring expense missing early this month', () => {
  const summary = summarizeCategoryWindow({ ledger: housingLedger, categoryIds: ['housing'], averageMonths: 3, today: new Date('2026-08-03T12:00:00') }).series[0]
  assert.equal(summary.currentActual, 0)
  assert.equal(summary.average, 2321)
  assert.equal(summary.currentForecast, 2321)
  assert.equal(summary.remainingFromToday, 2321)
})

test('category forecast never falls below spending already recorded', () => {
  const summary = summarizeCategoryWindow({ ledger: overspentLedger, categoryIds: ['food'], averageMonths: 6, today: new Date('2026-08-25T12:00:00') }).series[0]
  assert.equal(summary.average, 7500)
  assert.equal(summary.currentActual, 9000)
  assert.equal(summary.currentForecast >= 9000, true)
  assert.equal(summary.remainingFromToday, summary.currentForecast - 9000)
})
```

Add a third literal ledger where current actual and completed average are both `1000`, completed months also contain `400` after today's date, and assert `pacedForecast === currentForecast === 1400`.

- [ ] **Step 2: Run utility tests and verify RED**

```powershell
cd D:\projects\firefly-pico\front
node --test tests/utils/AnalyticsUtils.test.js
```

Expected: FAIL because current forecast is still only `actual + average remainder` and has no remaining value.

- [ ] **Step 3: Implement the exact category formula**

Keep intermediate values visible in the return object:

```js
const average = usedMonths > 0 ? completedTotal / usedMonths : null
const pacedForecast = forecastAvailable ? currentActual + averageHistoricalRemainder : null
const currentForecast = forecastAvailable ? Math.max(currentActual, average, pacedForecast) : null
const remainingFromToday = forecastAvailable ? currentForecast - currentActual : null
```

Refunds remain signed inside each category. The max prevents after-today refunds from reducing the final forecast below actual.

- [ ] **Step 4: Add failing all-category total tests**

```js
test('total forecast sums every category forecast including current-only uncategorized', () => {
  const completedCategories = {
    housing: { amount: 2321, byDay: { 2: 2321 }, transactionIds: [], transactionIdsByDay: {} },
    food: { amount: 1000, byDay: { 25: 1000 }, transactionIds: [], transactionIdsByDay: {} },
  }
  const ledger = {
    ledgerStartMonth: '2026-05',
    months: {
      '2026-05': { categories: structuredClone(completedCategories) },
      '2026-06': { categories: structuredClone(completedCategories) },
      '2026-07': { categories: structuredClone(completedCategories) },
      '2026-08': {
        categories: {
          food: { amount: 2000, byDay: { 3: 2000 }, transactionIds: ['food-now'], transactionIdsByDay: { 3: ['food-now'] } },
          [ANALYTICS_UNCATEGORIZED_ID]: { amount: 140, byDay: { 3: 140 }, transactionIds: ['uncategorized-now'], transactionIdsByDay: { 3: ['uncategorized-now'] } },
        },
      },
    },
  }
  const result = summarizeTotalExpenseWindow({ ledger, averageMonths: 3, today: new Date('2026-08-03T12:00:00') })
  assert.equal(result.categoryIds.includes(ANALYTICS_UNCATEGORIZED_ID), true)
  assert.equal(result.currentActual, 2140)
  assert.equal(result.average, 3321)
  assert.equal(result.currentForecast, result.categoryForecasts.reduce((sum, item) => sum + item.currentForecast, 0))
  assert.equal(result.currentForecast, 5461)
  assert.equal(result.remainingFromToday, 3321)
})
```

The fixture must include one overspent category and one expected-but-not-posted category so an aggregate maximum would produce a different answer and fail.

- [ ] **Step 5: Verify RED, implement category-union totals, and verify GREEN**

`getForecastCategoryIds(...)` must include category IDs from every selected completed month plus current month, retain `ANALYTICS_UNCATEGORIZED_ID`, and sort with a stable ID tie. `summarizeTotalExpenseWindow(...)` must call the same category calculation and sum literal returned values.

- [ ] **Step 6: Add and pass presentation tests for Remaining from today**

Extend the existing desktop/mobile presentation fixture:

```js
assert.deepEqual(presentation.rows.map(({ id }) => id), ['average', 'currentActual', 'currentForecast', 'remainingFromToday'])
assert.equal(presentation.rows.find(({ id }) => id === 'remainingFromToday').value, '2,181 USD')
```

Run:

```powershell
node --test tests/utils/AnalyticsUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js
```

Expected: PASS with the desktop table and mobile stacked rows sharing the same semantic values.

- [ ] **Step 7: Commit Task 3**

```powershell
git add front/utils/AnalyticsUtils.js front/utils/AnalyticsCategoryPresentationUtils.js front/tests/utils/AnalyticsUtils.test.js front/tests/utils/AnalyticsCategoryPresentationUtils.test.js
git commit -m "fix: forecast expenses by category"
```

### Task 4: Expose end-of-month and from-today values through charts and summaries

**Files:**
- Modify: `front/utils/ChartUtils.js`
- Modify: `front/utils/AnalyticsCategoryPresentationUtils.js`
- Modify: `front/components/charts/multi-series-line-chart.vue`
- Modify: `front/components/analytics/analytics-balance-trends.vue`
- Modify: `front/components/analytics/analytics-category-spending.vue`
- Modify: `front/tests/utils/ChartUtils.test.js`
- Modify: `front/tests/utils/AnalyticsCategoryPresentationUtils.test.js`
- Modify: all 11 files under `front/i18n/locales/`

**Interfaces:**
- Consumes: Task 1 balance `remainingFromToday` and Task 3 expense/category forecast metadata.
- Extends: a chart point with optional `secondaryLabel` and `secondaryValueLabel` strings.
- Extends: `buildLineChartLiveDescription(...)` to announce the primary and secondary forecast values at one vertical crosshair.
- Preserves: current pointer/touch pinning, keyboard navigation, exact point selection, dashed forecast segments for every selected metric, and actual-point transaction drill-down.

- [ ] **Step 1: Add a failing shared-chart secondary-value test**

```js
test('forecast crosshair exposes end-of-month and from-today values together', () => {
  const description = buildLineChartLiveDescription({
    xLabel: 'Aug 2026 forecast',
    values: [
      {
        label: 'Savings change',
        point: {
          valueLabel: '2,500 USD',
          kind: 'forecast',
          secondaryLabel: 'From today',
          secondaryValueLabel: '+1,300 USD',
        },
      },
    ],
    qualifierLabels: { forecast: 'Forecast' },
  })

  assert.equal(description, 'Aug 2026 forecast. Savings change: 2,500 USD, Forecast, From today: +1,300 USD')
})
```

Also extend the existing multi-series forecast test so Net worth, Savings, Debt, and Expenses each keep a dashed forecast segment and their own secondary metadata at the same forecast X.

- [ ] **Step 2: Run ChartUtils tests and verify RED**

```powershell
cd D:\projects\firefly-pico\front
node --test tests/utils/ChartUtils.test.js
```

Expected: FAIL because the live description and point DTO ignore secondary values.

- [ ] **Step 3: Implement secondary chart metadata and render it in the shared tooltip**

Keep the point contract additive:

```js
{
  x: '2026-08:forecast',
  value: 2500,
  kind: 'forecast',
  valueLabel: '2,500 USD',
  secondaryLabel: 'From today',
  secondaryValueLabel: '+1,300 USD',
}
```

Render the secondary line only when both strings exist. Include it in the existing aria-live description and in the payload emitted by `select`/`select-point`; do not add a second x coordinate or a second crosshair.

- [ ] **Step 4: Add failing presentation tests for account and expense remaining values**

Extend pure presentation assertions so these literals are visible:

```text
Savings end-of-month forecast: 2,500 USD
Savings From today: +1,300 USD
Expenses end-of-month forecast: 2,321 USD
Expenses From today: +2,321 USD
```

For negative account movement, assert `From today: -500 USD`; do not apply expense-only non-negative styling to account metrics.

- [ ] **Step 5: Verify RED, wire forecast metadata into both analytics cards, and verify GREEN**

In `analytics-balance-trends.vue`:

```text
Balances view plotted forecast = forecastTotal
Monthly change plotted forecast = forecastChange
Account secondary = remainingFromToday
Expense plotted forecast = currentForecast
Expense secondary = remainingFromToday
```

In `analytics-category-spending.vue`, show Average, Current actual, End-of-month forecast, and From today in both desktop and mobile summaries. The forecast details popup must list actual, average, historical remainder, paced forecast, final max result, remaining from today, and completed months used.

Run:

```powershell
node --test tests/utils/ChartUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/AnalyticsUtils.test.js
```

Expected: PASS, with zero-value primary and secondary forecast values retained rather than omitted by truthiness checks.

- [ ] **Step 6: Add localized forecast labels to every locale and parse all locale JSON**

Add translations for these semantic keys under the existing analytics namespaces:

```text
analytics.common.end_of_month
analytics.common.from_today
analytics.category.paced_forecast
analytics.category.final_forecast_rule
analytics.category.remaining_from_today
analytics.balance.remaining_from_today
```

Validate:

```powershell
Get-ChildItem front/i18n/locales/*.json | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json | Out-Null }
```

Expected: all 11 files parse successfully.

- [ ] **Step 7: Commit Task 4**

```powershell
git add front/utils/ChartUtils.js front/utils/AnalyticsCategoryPresentationUtils.js front/components/charts/multi-series-line-chart.vue front/components/analytics/analytics-balance-trends.vue front/components/analytics/analytics-category-spending.vue front/tests/utils/ChartUtils.test.js front/tests/utils/AnalyticsCategoryPresentationUtils.test.js front/i18n/locales
git commit -m "feat: explain analytics forecasts from today"
```

### Task 5: Integrate Savings view, compact FX status, grouped warnings, and the sidebar icon

**Files:**
- Create: `front/components/analytics/analytics-savings-view-control.vue`
- Modify: `front/pages/analytics.vue`
- Modify: `front/components/analytics/analytics-balance-trends.vue`
- Modify: `front/plugins/plugin-register-tabler-icons.js`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: all 11 files under `front/i18n/locales/`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Consumes: Task 2 `savingsView`, dynamic balance series, repaired metric selections, and grouped structured warnings.
- Produces: one compact page-level `Savings view: Combined | By net-worth inclusion` control shared by Financial trends and Money flow.
- Preserves: existing analytics route, pull-to-refresh, toolbar, dashboard/analytics switch, and card-local source states.

- [ ] **Step 1: Add failing store-consumer tests for dynamic metric IDs**

```js
test('switching savings view repairs metric selections without leaving the facet empty', async () => {
  const store = (analyticsStore = useAnalyticsStore())
  await store.init()
  store.visibleBalanceMetrics = ['savings']
  store.savingsView = 'split'
  await nextTick()
  assert.deepEqual(store.availableBalanceMetricIds, ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt'])
  assert.equal(store.visibleBalanceMetrics.length > 0, true)
  assert.equal(store.visibleBalanceMetrics.every((id) => store.availableBalanceMetricIds.includes(id)), true)
})
```

Add an equivalent Monthly change assertion that retains `expenses` while replacing obsolete `savings` with the two split IDs.

- [ ] **Step 2: Run store tests and verify RED**

```powershell
cd D:\projects\firefly-pico\front
node --test tests/stores/analyticsStore.test.js
```

Expected: FAIL until dynamic metric IDs and selection repair are exposed.

- [ ] **Step 3: Implement the shared Savings view control and dynamic trend labels**

Use existing `app-tabs`/Vant control patterns and `defineModel()`:

```vue
<analytics-savings-view-control v-model="analyticsStore.savingsView" />
```

Place it once in `analytics.vue` above the analytics card layout. In split mode, `analytics-balance-trends.vue` must show:

```text
Savings included in net worth
Savings excluded from net worth
```

and their matching monthly-change labels. Do not infer liquid/retirement meaning.

- [ ] **Step 4: Replace the full-width FX note and duplicate warning rows**

Remove the full-row `Estimated at current rates` note. Add a compact header badge only when a selected series is estimated:

```text
FX: current rates
```

Render the store's grouped warnings once per `{type, sampleDate}` and include the localized joined metric labels. A same-date unverified Net worth + Savings warning must produce one row, not two.

- [ ] **Step 5: Register the existing Analytics icon and style both themes**

Import and register `IconChartLine` in `plugin-register-tabler-icons.js` using the same two-line pattern as neighboring Tabler icons. Add shared styles for the page control, compact badge, warning row, split metric labels, and small-screen stacking. Use existing analytics CSS variables and add dark overrides only for hardcoded light surfaces.

- [ ] **Step 6: Localize and validate the integration labels**

Add translations for:

```text
analytics.savings_view.label
analytics.savings_view.combined
analytics.savings_view.split
analytics.balance.savings_included
analytics.balance.savings_excluded
analytics.balance.savings_included_change
analytics.balance.savings_excluded_change
analytics.common.fx_current_rates
analytics.balance.grouped_balance_warning
```

Run the 11-file JSON parse command from Task 4.

- [ ] **Step 7: Verify focused tests and build the production frontend**

```powershell
cd D:\projects\firefly-pico\front
node --test tests/stores/analyticsStore.test.js tests/utils/AnalyticsUtils.test.js tests/utils/ChartUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js
npm run build
```

Expected: focused tests PASS and Nuxt production build exits 0. The known npm configuration warnings are baseline tool output, not a test failure.

- [ ] **Step 8: Commit Task 5**

```powershell
git add front/components/analytics/analytics-savings-view-control.vue front/pages/analytics.vue front/components/analytics/analytics-balance-trends.vue front/plugins/plugin-register-tabler-icons.js front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests/stores/analyticsStore.test.js
git commit -m "fix: polish financial trends controls"
```

### Task 6: Build the direction-aware layered Money flow model

**Files:**
- Modify: `front/utils/AnalyticsUtils.js`
- Test: `front/tests/utils/AnalyticsUtils.test.js`

**Interfaces:**
- Produces: `getAnalyticsAccountKind(account)` values `revenue`, `expense`, `available`, `savings`, `liabilityDebit`, `liabilityCredit`, `liabilityUnknown`, or `other`.
- Produces: `buildLayeredMonthlyMoneyFlow({ transactions, monthKey, displayCurrencyCode, primaryCurrencyCode, rates, currencyDecimalPlaces, savingsView })`.
- Produces graph shape `{ nodes, links, pools, audit, meta: { savingsView }, isEstimated, missingCurrencies, unclassified, isBalanced }`.
- Temporarily preserves: the old `buildMonthlyMoneyFlow(...)` export for the existing card until Task 8 performs the atomic UI/store cutover.

Add these focused test helpers beside the existing fixtures:

```js
const typedAccount = ({ id = null, name = null, type, role = null, direction = null, includeNetWorth = true }) => ({
  id,
  attributes: {
    name,
    include_net_worth: includeNetWorth,
    type: { fireflyCode: type },
    account_role: role ? { fireflyCode: role } : null,
    liability_direction: direction ? { fireflyCode: direction } : null,
  },
})
const flowArgs = { monthKey: '2026-08', displayCurrencyCode: 'USD', primaryCurrencyCode: 'USD', rates: { USD: 1 }, currencyDecimalPlaces: 2, savingsView: 'combined' }
const nodeValue = (graph, id) => graph.nodes.find((node) => node.id === id)?.value ?? 0
const nodeTransactions = (graph, id) => graph.nodes.find((node) => node.id === id)?.transactionIds ?? []
const linkValue = (graph, sourceId, targetId) => graph.links.filter((link) => link.sourceId === sourceId && link.targetId === targetId).reduce((sum, link) => sum + link.value, 0)
```

- [ ] **Step 1: Replace obsolete credit-card flow expectations with failing immediate-account routing tests**

```js
test('routes card purchases through Available and never through Debt', () => {
  const graph = buildLayeredMonthlyMoneyFlow({
    transactions: [transaction('card-food', [split({ amount: 80, date: '2026-08-02', source: card, destination: expense, categoryId: 'food' })])],
    monthKey: '2026-08',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    currencyDecimalPlaces: 2,
    savingsView: 'combined',
  })

  assert.equal(graph.links.some(({ sourceId, targetId, value }) => sourceId === 'available' && targetId === 'expenses' && value === 80), true)
  assert.equal(graph.nodes.some(({ kind }) => ['newDebt', 'debtPaid', 'liabilityExtended', 'liabilityCollected'].includes(kind)), false)
})
```

Add literal transition fixtures for Revenue→Available, Revenue→Savings, Available→Expense, Savings→Expense, Available↔Savings, debit liability→Available/Expense, Available/Revenue/Refund→debit liability, and the credit-direction equivalents.

- [ ] **Step 2: Run the utility tests and verify RED**

```powershell
cd D:\projects\firefly-pico\front
node --test tests/utils/AnalyticsUtils.test.js
```

Expected: FAIL because the layered function and Available classification do not exist.

- [ ] **Step 3: Implement endpoint classification and the explicit transition table**

Use stable node IDs:

```text
income:<category-or-revenue-id> -> income
refund:<category-id>
newDebt:<liability-id>
liabilityCollected:<liability-id>
existingAvailable
existingSavings:<account-id>
available
savings
expenses -> expense:<category-id>
debtPaid -> debtPaid:<liability-id>
liabilityExtended -> liabilityExtended:<liability-id>
savingsDeposited -> savingsDeposit:<account-id>
newExcess
```

Every node and link must carry sorted unique `transactionIds`. Income labels preserve category ID first, then revenue account name/ID, then the uncategorized-income sentinel. Direct liability-funded expense/refund routes bypass both pools.

- [ ] **Step 4: Add failing cross-pool refund, opposing-savings, and liability-direction tests**

```js
test('keeps a purchase from Available and refund to Savings as separate category paths', () => {
  const crossPoolRefundTransactions = [
    transaction('purchase', [split({ amount: 100, date: '2026-08-02', source: checking, destination: expense, categoryId: 'food' })]),
    transaction('refund', [split({ amount: 40, date: '2026-08-03', source: expense, destination: savings, categoryId: 'food' })]),
  ]
  const graph = buildLayeredMonthlyMoneyFlow({ ...flowArgs, transactions: crossPoolRefundTransactions })
  assert.equal(linkValue(graph, 'available', 'expenses'), 100)
  assert.equal(linkValue(graph, 'refund:food', 'savings'), 40)
})

test('shows opposing savings account movements and their net', () => {
  const hysa = typedAccount({ id: 'hysa', type: 'asset', role: 'savingAsset', includeNetWorth: true })
  const hsa = typedAccount({ id: 'hsa', type: 'asset', role: 'savingAsset', includeNetWorth: false })
  const opposingSavingsTransactions = [
    transaction('hysa-in', [split({ amount: 1000, date: '2026-08-04', source: checking, destination: hysa })]),
    transaction('hsa-out', [split({ amount: 500, date: '2026-08-05', source: hsa, destination: checking })]),
  ]
  const graph = buildLayeredMonthlyMoneyFlow({ ...flowArgs, transactions: opposingSavingsTransactions })
  assert.equal(nodeValue(graph, 'savingsDeposit:hysa'), 1000)
  assert.equal(nodeValue(graph, 'existingSavings:hsa'), 500)
  assert.equal(graph.audit.netSavings, 500)
})
```

For liabilities, assert debit source movement is New debt, debit destination movement is Debt paid, credit source movement is Liability collected, credit destination movement is Liability extended, and liability-to-liability transfers appear only under `audit.liabilityReallocations`.

- [ ] **Step 5: Verify RED, implement per-pair and per-account netting, then verify GREEN**

Implement expense/refund netting per `(category, immediate pool)`, one directional Available/Savings bridge, and per-account savings residuals:

```text
netExpense(category,pool) = purchasesFromPool - refundsToPool
netTransferToSavings = grossAvailableToSavings - grossSavingsToAvailable
netSavingsAccount = classifiedEntering - classifiedLeaving
savingsDeposited = max(netSavingsAccount, 0)
existingSavingsUsed = max(-netSavingsAccount, 0)
```

Do not globally cancel opposing savings accounts or cross-pool category paths.

- [ ] **Step 6: Add failing conservation and unclassified-withholding tests**

Assert exact pool equations and the outer equation using literal expected totals. Add one unknown-liability-direction transaction and one unsupported endpoint transition; both must produce nonzero `unclassified`, `isBalanced: false`, and retain exact transaction IDs. An empty graph must reconcile to zero.

- [ ] **Step 7: Implement reconciliation within display-currency tolerance**

The audit must expose:

```text
pools.available = { incoming, outgoing, net }
pools.savings = { incoming, outgoing, net }
totalSources
totalDestinations
equationDifference
liabilityIncrease
liabilityReduction
netDebtChange
positiveSavingsMovement
negativeSavingsMovement
netSavings
liabilityReallocations
unclassified
```

Set `isBalanced` only when both pools and the outer graph reconcile within `0.5 * 10 ** -currencyDecimalPlaces`, unclassified value is within that tolerance, and no selected-month transaction amount was omitted for a missing currency rate.

- [ ] **Step 8: Run the pure analytics suite and commit Task 6**

```powershell
node --test tests/utils/AnalyticsUtils.test.js
git add front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsUtils.test.js
git commit -m "feat: model layered monthly money flow"
```

### Task 7: Add truthful Top-N reduction and packed ribbon geometry

**Files:**
- Modify: `front/utils/AnalyticsUtils.js`
- Modify: `front/utils/ChartUtils.js`
- Create: `front/components/charts/layered-money-flow-chart.vue`
- Test: `front/tests/utils/AnalyticsUtils.test.js`
- Test: `front/tests/utils/ChartUtils.test.js`

**Interfaces:**
- Consumes: Task 6 layered graph.
- Produces: `limitMoneyFlowGraphDetail({ graph, detailLevel })` where `detailLevel` is `5`, `10`, or `'all'`.
- Produces: `resolveMoneyFlowGraphMode({ nodes, isDesktop, renderedWidth })` returning `full` or `condensed`.
- Replaces: `buildMoneyFlowGeometry(...)` with `buildMoneyFlowGraphGeometry({ nodes, links, isDesktop, renderedWidth, mode })`.
- Produces chart props: `graph`, required `ariaLabel`, and optional `detailLevel`; emits `select-node` and `select-link`.

- [ ] **Step 1: Add failing deterministic Top-N and Other tests**

```js
test('limits each compatible breakdown independently and preserves exact Other totals', () => {
  const limited = limitMoneyFlowGraphDetail({ graph: manyCategoryGraph, detailLevel: 5 })
  const expenseNodes = limited.nodes.filter(({ kind }) => ['expenseCategory', 'otherExpenseCategory'].includes(kind))
  assert.equal(expenseNodes.length, 6)
  assert.equal(nodeValue(limited, 'other:expenses:available:positive'), 30)
  assert.deepEqual(nodeTransactions(limited, 'other:expenses:available:positive'), ['expense-6', 'expense-7'])
})
```

Define `manyCategoryGraph` as a literal graph with seven compatible expense-category nodes valued `70, 60, 50, 40, 30, 20, 10`; the hidden two must produce Other value `30` with their exact two transaction IDs. Use equal absolute values with reversed input order in a second fixture to prove stable entity-ID tie-breaking. Add separate assertions that source/destination, Available/Savings, positive/negative, and included/excluded savings groups never merge into one Other node. `'all'` must preserve every original node.

- [ ] **Step 2: Run utility tests and verify RED, then implement graph reduction**

```powershell
cd D:\projects\firefly-pico\front
node --test tests/utils/AnalyticsUtils.test.js
```

Expected: FAIL because detail reduction does not exist. Implement ranking by descending `Math.abs(value)` then stable `refId`/node ID. Rewire hidden members' links into their compatible Other node and union transaction IDs without changing source or destination totals.

- [ ] **Step 3: Add failing desktop/mobile ribbon geometry tests**

```js
test('packed ribbons close at square node edges and never overfill a pool', () => {
  const geometry = buildMoneyFlowGraphGeometry({ nodes: manyCategoryGraph.nodes, links: manyCategoryGraph.links, isDesktop: true, renderedWidth: 900, mode: 'full' })
  assert.equal(geometry.ribbons.every(({ path }) => path.startsWith('M ') && path.endsWith(' Z')), true)
  assert.equal(geometry.ribbons.every(({ strokeWidth }) => strokeWidth === undefined), true)
  assert.equal(geometry.pools.every(({ incomingWidth, outgoingWidth, span }) => incomingWidth <= span && outgoingWidth <= span), true)
})
```

Add mobile fixtures proving full mode while baseline spacing is at least 28 and transparent hit boxes are at least 44×44, then a crowded 390px fixture proving `condensed` mode.

- [ ] **Step 4: Verify RED, implement packed closed ribbons and responsive mode, then verify GREEN**

Use one proportional width scale per graph. Allocate link bands contiguously along each node edge and produce a closed cubic path with square attachment edges. Geometry may increase height; it must not shrink labels or accounting bands independently.

For mobile, retain full outer layers only when computed positions meet both exact constraints. In condensed mode, retain common source, pool, and outcome nodes; attach complete hidden node/link lists to `details` metadata for selection.

- [ ] **Step 5: Replace the chart renderer without changing card integration yet**

`layered-money-flow-chart.vue` must:

```text
- render filled `<path>` ribbons, not stroked round-cap curves;
- render Available and Savings as separate bars;
- highlight a focused/hovered/touched node or link and its direct connections;
- dim unrelated paths;
- expose an accessible source, destination, and formatted amount label;
- keep transparent interaction targets at least 44×44;
- emit exact node/link objects for the details sheet.
```

Leave the existing `money-flow-chart.vue` unchanged so the live card remains functional until Task 8 switches the sole caller.

- [ ] **Step 6: Run geometry and analytics tests, then commit Task 7**

```powershell
node --test tests/utils/AnalyticsUtils.test.js tests/utils/ChartUtils.test.js
git add front/utils/AnalyticsUtils.js front/utils/ChartUtils.js front/components/charts/layered-money-flow-chart.vue front/tests/utils/AnalyticsUtils.test.js front/tests/utils/ChartUtils.test.js
git commit -m "feat: render packed money flow ribbons"
```

### Task 8: Cut over the Money flow card, persistence, details, and responsive styling

**Files:**
- Modify: `front/stores/analyticsStoreFactory.js`
- Modify: `front/utils/AnalyticsUtils.js`
- Modify: `front/components/analytics/analytics-money-flow.vue`
- Modify: `front/components/charts/layered-money-flow-chart.vue`
- Delete: `front/components/charts/money-flow-chart.vue`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: all 11 files under `front/i18n/locales/`
- Test: `front/tests/stores/analyticsStore.test.js`
- Test: `front/tests/utils/AnalyticsUtils.test.js`
- Test: `front/tests/utils/ChartUtils.test.js`

**Interfaces:**
- Consumes: Task 5 shared Savings view, Task 6 layered graph, and Task 7 detail/geometry helpers.
- Produces: `graphDetail` stored under `analyticsMoneyFlowDetail` with repaired values `5`, `10`, or `'all'` and default `5`.
- Changes: `selectedFlow` to the final layered graph limited by `graphDetail` and grouped by the current Savings view.
- Extends: final graph metadata to `{ savingsView, detailLevel }` for presentation and persistence tests.
- Removes: the old flat Money-flow utility body, flat card props, round-band audit vocabulary, and residual-only popup.

- [ ] **Step 1: Add failing store persistence and cutover tests**

```js
test('repairs graph detail and derives layered flow with the shared savings view', async () => {
  storageOverrides.set('analyticsMoneyFlowDetail', 42)
  const store = (analyticsStore = useAnalyticsStore())
  await store.init()
  assert.equal(store.graphDetail, 5)
  assert.equal(Array.isArray(store.selectedFlow.nodes), true)
  assert.equal(Array.isArray(store.selectedFlow.links), true)
  assert.equal(store.selectedFlow.sources, undefined)
  store.graphDetail = 'all'
  store.savingsView = 'split'
  await nextTick()
  assert.equal(store.selectedFlow.meta.savingsView, 'split')
  assert.equal(store.selectedFlow.meta.detailLevel, 'all')
})
```

Also verify Top 5 changes only visible detail, not `audit.totalSources`, `audit.totalDestinations`, or transaction IDs available through complete details.

- [ ] **Step 2: Run store tests and verify RED**

```powershell
cd D:\projects\firefly-pico\front
node --test tests/stores/analyticsStore.test.js
```

Expected: FAIL because the store still returns the flat flow contract and has no Graph detail setting.

- [ ] **Step 3: Atomically switch the store and remove flat compatibility**

Make final `buildMonthlyMoneyFlow(...)` return the layered Task 6 contract, or rename the layered implementation to that public export and remove the old flat implementation. Compute the full graph once for the selected month, then apply Task 7 detail reduction without discarding the full graph's audit/details.

- [ ] **Step 4: Rebuild the Money flow card around graph nodes and links**

The card must include:

```text
Graph detail: Top 5 | Top 10 | All
Available and Savings pool labels
income category -> New income detail
Expenses -> expense category detail
Savings deposited / Existing savings used -> savings account detail
Debt paid / New debt / Liability extended / Liability collected -> liability account detail
compact mobile-condensed notice when mode is condensed
collapsed Exact values and Reconciliation sections
unclassified/unbalanced audit plus retry, with ribbons withheld
```

Selecting any visible node or link opens one existing-style `app-popup` with exact constituent rows and transaction IDs. From that popup, navigate to the filtered transaction list using the same query contract as current node drill-down.

- [ ] **Step 5: Add failing presentation-state assertions and make them green**

Extend `resolveMoneyFlowPresentation(...)` tests for:

```js
assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: false, hasNodes: true, hasUnclassified: true }), {
  showGraph: false,
  showEmpty: false,
  showAudit: true,
  reason: 'unclassified',
})
```

Also cover reconciled empty, balanced full, balanced condensed, stale retained data, and missing-rate states. Run `ChartUtils.test.js` RED before changing the helper and GREEN after.

- [ ] **Step 6: Replace flow styles in both themes**

Remove obsolete round-stroke and single-bus rules. Add shared classes for filled ribbons, square bar attachments, separate pools, node/link focus dimming, Top-N control, details rows, mobile condensed notice, and responsive graph height. Verify no horizontal overflow at a 390px content width in the geometry test and live browser pass.

- [ ] **Step 7: Localize every Money flow label and parse locale JSON**

Add translated keys for Graph detail, Top 5/10/All, Other, Available/Savings pools, income/expense/refund categories, existing funds, savings account directions, debit/credit liability outcomes, unclassified audit, liability reallocations, mobile condensation, and exact source→destination descriptions. Remove obsolete card copy that says credit-card purchases create Debt.

Run the 11-file JSON parse command from Task 4.

- [ ] **Step 8: Run the complete analytics suite and production build**

```powershell
cd D:\projects\firefly-pico\front
node --test tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/AnalyticsUtils.test.js tests/utils/ChartUtils.test.js tests/repository/BaseRepository.test.js tests/stores/analyticsStore.test.js
npm run build
```

Expected: all analytics tests PASS and Nuxt build exits 0. Then run scoped formatting on only touched files with the repo formatter and repeat the focused tests/build if formatting changed code.

```powershell
npx prettier --write stores/analyticsStoreFactory.js utils/AnalyticsUtils.js components/analytics/analytics-money-flow.vue components/charts/layered-money-flow-chart.vue assets/styles/theme-white.css assets/styles/theme-dark.css "i18n/locales/*.json" tests/stores/analyticsStore.test.js tests/utils/AnalyticsUtils.test.js tests/utils/ChartUtils.test.js
npx eslint --fix stores/analyticsStoreFactory.js utils/AnalyticsUtils.js components/analytics/analytics-money-flow.vue components/charts/layered-money-flow-chart.vue tests/stores/analyticsStore.test.js tests/utils/AnalyticsUtils.test.js tests/utils/ChartUtils.test.js
```

- [ ] **Step 9: Rebuild the local image and inspect the live UI in Chrome**

```powershell
cd D:\projects\firefly-pico
docker-compose -f docker-compose.pico.yml -f docker-compose.pico.local.yml config --services
docker-compose -f docker-compose.pico.yml -f docker-compose.pico.local.yml up -d --build firefly-pico
docker-compose -f docker-compose.pico.yml -f docker-compose.pico.local.yml ps
Invoke-WebRequest http://localhost:6976/analytics -Method Head
```

Inspect `http://localhost:6976/analytics` in Chrome:

```text
Desktop light and dark: sidebar icon; compact FX badge; grouped warning; combined/split Savings; Balances/Monthly change; 3/6/12; both forecast values.
Spending: 3/6/12/24; actual, average, paced floors; Housing-like missing payment; details sheet and exact drill-down.
Money flow: Top 5/10/All/Other; Available/Savings; category/account layers; square ribbons; highlighting; exact details; reconciliation.
Mobile 390x844 light and dark: vertical flow; readable labels; 44x44 targets; automatic condensation notice; no horizontal overflow; touch selection.
Failure states: stale data, empty accounts, insufficient history, missing rates, unclassified and unbalanced flow withholding.
Keyboard/pointer: crosshair hover/pin, touch drag/release, outside dismiss, arrows/Home/End/Escape, node Enter activation, live-region dual values.
```

If inspection reveals a behavior defect, add a failing focused test before fixing it, then repeat only the affected suite and live state.

- [ ] **Step 10: Run final repository checks and commit Task 8**

```powershell
cd D:\projects\firefly-pico
git diff --check
pwsh -NoProfile -File .agents/skills/firefly-pico-oss-contribution/scripts/contribution-preflight.ps1
git status --short
git add front/stores/analyticsStoreFactory.js front/utils/AnalyticsUtils.js front/components/analytics/analytics-money-flow.vue front/components/charts/layered-money-flow-chart.vue front/components/charts/money-flow-chart.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests/stores/analyticsStore.test.js front/tests/utils/AnalyticsUtils.test.js front/tests/utils/ChartUtils.test.js
git commit -m "feat: deliver layered analytics money flow"
```

Record repository-wide lint/Prettier as baseline `FAIL` if it remains at the observed 585 lint problems / 301 Prettier files; do not reformat unrelated files. The required completion gate is scoped formatting for touched files, analytics tests, production build, locale parsing, live Docker HTTP, and the Chrome matrix above.

## Final Branch Review and Handoff

After Task 8 is reviewed clean:

1. Generate one full review package from the pre-plan commit through `HEAD`.
2. Dispatch the final whole-branch reviewer on the most capable available model and include any deferred-minor ledger entries.
3. Send one fix agent for the complete final finding list, if any, followed by one scoped re-review.
4. Run the verification-before-completion workflow against the final `HEAD`.
5. Use the finishing-a-development-branch workflow to present local integration options. Do not push or open a PR without explicit user authorization.
