# Extended Analytics UX and Financial Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the live Financial trends card, add selectable monthly net-worth, savings, debt, and expense movement, and make all analytics cards readable and smooth on mobile and desktop.

**Architecture:** Keep Firefly account-chart data and the normalized transaction ledger as separate sources, then combine their derived monthly series only at the analytics store/presentation boundary. Preserve the existing account request groups (`netWorth`, `savings`, `debt`) while adding `expenses` only to the selectable Financial trends metrics. Reuse the native SVG charts and add no backend route, database change, or chart dependency.

**Tech Stack:** Nuxt client SPA, Vue 3 `<script setup>`, Pinia 3 composition stores, Vant 4, date-fns 4, native SVG, Node built-in test runner, CSS custom properties, Chrome live-app inspection.

## Global Constraints

- Work only on `personal/extended-analytics`; do not push or open a pull request without explicit approval.
- Plain JavaScript and Vue SFCs only; no TypeScript syntax or new npm/composer dependency.
- Preserve the repository runtime floors: Node.js 18+ and PHP 8.2+.
- Use single quotes, no semicolons, trailing commas, 2-space indentation, and the existing Prettier configuration.
- Keep `BALANCE_METRICS = ['netWorth', 'savings', 'debt']` limited to account grouping and account-chart requests; `expenses` is transaction-derived.
- Treat credit-card purchases as expenses plus debt growth and credit-card payments as debt repayment, not spending.
- Exclude savings transfers, debt payments, ordinary transfers, and configured dashboard exclusions from total expenses.
- Keep current-month actual account movement separate from the expense forecast; do not forecast net worth, savings, or debt.
- Use shared theme files and all 11 locale JSON files; do not add scoped styles or hard-coded user-facing labels.
- Preserve card-local loading/error/retry/stale/empty states and exact pointer/touch/keyboard chart inspection.
- Verify real mobile/desktop and light/dark states in Chrome before completion.

---

## File Structure

- `front/utils/AnalyticsUtils.js`: normalize live Firefly chart dates and calculate month-end balance movement and total-expense history/forecast.
- `front/stores/analyticsStoreFactory.js`: fetch the prior-month baseline, expose combined Financial trends data, and persist a valid four-metric selection.
- `front/components/analytics/analytics-balance-trends.vue`: present the renamed Financial trends card, four-series chart, totals, warnings, and current-period semantics.
- `front/components/analytics/analytics-metric-facet.vue`: category-style selector for the four Financial trends metrics with at least one selected.
- `front/components/charts/multi-series-line-chart.vue`: improve exact-value tooltip hierarchy, expose partial-period qualifiers, and keep inspection-only alignment points out of rendered lines.
- `front/components/analytics/analytics-category-spending.vue`: responsive category summary rows and one calculation disclosure.
- `front/components/analytics/analytics-money-flow.vue`: visible reconciliation status with collapsed details.
- `front/components/charts/money-flow-chart.vue`: readable desktop/mobile geometry and disclosed exact-value list.
- `front/utils/ChartUtils.js`: pure, testable money-flow geometry in addition to the existing line-chart geometry.
- `front/pages/analytics.vue`: existing card order remains authoritative; no template change is planned.
- `front/assets/styles/variables.css`, `theme-white.css`, `theme-dark.css`: semantic expense color, full-width layout, responsive summaries/flow, typography, tooltip, disclosure, focus, and dark-theme treatment.
- `front/i18n/locales/*.json`: Financial trends, metric selection, partial period, calculation disclosure, and exact-values copy in every locale.
- `front/tests/utils/AnalyticsUtils.test.js`, `front/tests/stores/analyticsStore.test.js`, `front/tests/utils/ChartUtils.test.js`: deterministic live-contract, formula, selection, and geometry coverage.

### Task 1: Normalize the live Firefly account-chart contract

**Files:**
- Modify: `front/utils/AnalyticsUtils.js`
- Test: `front/tests/utils/AnalyticsUtils.test.js`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Consumes: Firefly chart lines with `entries` or `pc_entries`, whose keys may be `YYYY-MM-DD` or Atom timestamps.
- Produces: `normalizeBalanceSeries(...)` points whose `x` is always a validated `YYYY-MM-DD`; supports `primary_currency_code` and legacy `pc_currency_code`.

- [ ] **Step 1: Add failing utility tests for the live timestamp and currency fields**

```js
test('normalizes Firefly Atom chart keys without shifting the source day', () => {
  const result = normalizeBalanceSeries({
    metric: 'netWorth',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: {},
    chartLines: [{ primary_currency_code: 'USD', pc_entries: { '2026-08-02T00:00:00+00:00': '125' } }],
  })

  assert.deepEqual(result.points, [{ x: '2026-08-02', value: 125 }])
})

test('ignores invalid account-chart date keys', () => {
  const result = normalizeBalanceSeries({
    metric: 'netWorth',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    chartLines: [{ currency_code: 'USD', entries: { invalid: '10', '2026-08-02': '20' } }],
  })

  assert.deepEqual(result.points, [{ x: '2026-08-02', value: 20 }])
})
```

- [ ] **Step 2: Run the focused utility tests and confirm the regression fails**

Run from `front/`:

```bash
node --test --test-name-pattern="Atom chart keys|invalid account-chart" tests/utils/AnalyticsUtils.test.js
```

Expected: FAIL because Atom keys remain unnormalized and invalid keys remain in the output.

- [ ] **Step 3: Canonicalize date keys at normalization and accept the live primary-currency field**

```js
const normalizeChartDateKey = (value) => {
  const match = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)
  return match?.[1] ?? null
}

const entriesForLine = ({ line, primaryCurrencyCode }) => {
  if (line?.pc_entries && Object.keys(line.pc_entries).length > 0) {
    return {
      entries: line.pc_entries,
      currencyCode: line.primary_currency_code ?? line.pc_currency_code ?? primaryCurrencyCode,
      isPrimary: true,
    }
  }
  return { entries: line?.entries ?? {}, currencyCode: line?.currency_code, isPrimary: false }
}
```

Inside `normalizeBalanceSeries`, map each entry through `normalizeChartDateKey(x)` and filter null dates before sorting/carry-forward aggregation. Do not construct `Date` objects; that could shift the source ledger day.

- [ ] **Step 4: Add the API-shaped store regression and run both focused suites**

Change/add a store fixture whose chart response uses:

```js
const atomDate = format(new Date(), 'yyyy-MM-dd') + 'T00:00:00+00:00'
accountResponse = async () => chartResponse(100, atomDate)
```

Assert that the resulting point uses `format(new Date(), 'yyyy-MM-dd')` and does not produce `current-balance-unverified` when the account current date is the same calendar day.

Run:

```bash
node --test tests/utils/AnalyticsUtils.test.js tests/stores/analyticsStore.test.js
```

Expected: PASS with no `RangeError: Invalid time value` data path remaining.

- [ ] **Step 5: Commit the live-contract repair**

```bash
git add front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsUtils.test.js front/tests/stores/analyticsStore.test.js
git commit -m "fix: normalize analytics chart timestamps"
```

### Task 2: Derive monthly account movement and total expenses

**Files:**
- Modify: `front/utils/AnalyticsUtils.js`
- Modify: `front/stores/analyticsStoreFactory.js`
- Test: `front/tests/utils/AnalyticsUtils.test.js`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Consumes: normalized account series `{ id, points: [{ x, value }], currentPoint: { x, value } | null }`, the existing category ledger, selected `months`, and `today`.
- Produces: `summarizeBalanceMovements({ balanceSeries, months, today })` and `summarizeTotalExpenseWindow({ ledger, averageMonths, today })`; store computed `financialTrend` with `{ monthKeys, series, expenses }`.

- [ ] **Step 1: Add failing tests for movement, baseline, debt sign, and total expense forecast**

```js
test('builds completed and partial monthly account movement from month-end totals', () => {
  const result = summarizeBalanceMovements({
    months: 3,
    today: new Date('2026-08-10T12:00:00Z'),
    balanceSeries: [
      { id: 'netWorth', points: [{ x: '2026-05-31', value: 100 }, { x: '2026-06-30', value: 130 }, { x: '2026-07-31', value: 120 }, { x: '2026-08-07', value: 140 }], currentPoint: { x: '2026-08-10', value: 150 } },
      { id: 'debt', points: [{ x: '2026-05-31', value: 80 }, { x: '2026-06-30', value: 60 }, { x: '2026-07-31', value: 75 }, { x: '2026-08-07', value: 72 }], currentPoint: { x: '2026-08-10', value: 70 } },
    ],
  })

  assert.deepEqual(result.monthKeys, ['2026-06', '2026-07', '2026-08'])
  assert.deepEqual(result.series.find(({ id }) => id === 'netWorth').points, [
    { x: '2026-06', value: 30, kind: 'actual' },
    { x: '2026-07', value: -10, kind: 'actual' },
    { x: '2026-08', value: 30, kind: 'partial' },
  ])
  assert.deepEqual(result.series.find(({ id }) => id === 'debt').points.map(({ value }) => value), [-20, 15, -5])
})

test('summarizes total expense from every category and forecasts only with two completed months', () => {
  const result = summarizeTotalExpenseWindow({
    averageMonths: 3,
    today: new Date('2026-04-10T12:00:00Z'),
    ledger: {
      ledgerStartMonth: '2026-01',
      months: {
        '2026-01': { categories: { food: { amount: 40, byDay: { 20: 40 } }, rent: { amount: 60, byDay: { 2: 60 } } } },
        '2026-02': { categories: { food: { amount: 20, byDay: { 20: 20 } } } },
        '2026-03': { categories: { food: { amount: 30, byDay: { 20: 30 } } } },
        '2026-04': { categories: { food: { amount: 10, byDay: { 5: 10 } } } },
      },
    },
  })

  assert.deepEqual(result.actualPoints.map(({ value }) => value), [100, 20, 30])
  assert.equal(result.currentActual, 10)
  assert.equal(result.currentForecast, 40)
  assert.equal(result.forecastAvailable, true)
})
```

- [ ] **Step 2: Run the focused utility tests and confirm the new exports are missing**

Run:

```bash
node --test --test-name-pattern="monthly account movement|total expense" tests/utils/AnalyticsUtils.test.js
```

Expected: FAIL because `summarizeBalanceMovements` and `summarizeTotalExpenseWindow` do not exist.

- [ ] **Step 3: Implement the two deterministic summaries**

Use these exact return shapes:

```js
summarizeBalanceMovements(...) => {
  monthKeys: ['YYYY-MM', ...],
  series: [{ id, currentTotal, currentDate, points: [{ x: 'YYYY-MM', value, kind: 'actual' | 'partial' }] }],
}

summarizeTotalExpenseWindow(...) => {
  requestedMonths,
  usedMonths,
  actualPoints: [{ x: 'YYYY-MM', value, kind: 'actual' }],
  currentActual,
  currentForecast,
  forecastAvailable,
}
```

For account movement, retain the last valid point per completed calendar month, require the preceding month as the baseline, and omit a movement when either side is missing. Use `currentPoint` for the partial current-month movement so a weekly chart sample cannot replace the latest actual account total. For expenses, sum every category amount/by-day entry in the existing ledger; reuse the same completed-month boundary and “after today’s day-of-month” forecast rules as `summarizeCategoryWindow`.

- [ ] **Step 4: Wire the store without adding an expense account request**

Keep:

```js
const BALANCE_METRICS = ['netWorth', 'savings', 'debt']
const FINANCIAL_TREND_METRICS = [...BALANCE_METRICS, 'expenses']
```

Change the account request start to the first day of the baseline month:

```js
start: DateUtils.dateToString(startOfMonth(subMonths(today, months))),
```

Add:

```js
const financialTrend = computed(() => ({
  ...summarizeBalanceMovements({ balanceSeries: balanceSeries.value, months: Number(balancePeriod.value), today: new Date() }),
  expenses: summarizeTotalExpenseWindow({ ledger: categoryLedger.value, averageMonths: Number(balancePeriod.value), today: new Date() }),
}))
```

When normalizing each account-backed series, retain the already calculated current total instead of discarding it:

```js
currentPoint: hasCompleteCurrentTotal ? { x: snapshot.end, value: currentTotal } : null,
```

Return `financialTrend` from the store. Add a store test asserting three account requests at most for non-empty account groups, zero request for `expenses`, the latest account total overriding a stale weekly sample, and the combined transaction-derived expense values.

- [ ] **Step 5: Run the analytics suites and commit**

```bash
npm run test:analytics
git add front/utils/AnalyticsUtils.js front/stores/analyticsStoreFactory.js front/tests/utils/AnalyticsUtils.test.js front/tests/stores/analyticsStore.test.js
git commit -m "feat: derive monthly financial trends"
```

Expected: all analytics tests PASS.

### Task 3: Build the selectable Financial trends card

**Files:**
- Create: `front/components/analytics/analytics-metric-facet.vue`
- Modify: `front/components/analytics/analytics-balance-trends.vue`
- Modify: `front/components/charts/multi-series-line-chart.vue`
- Modify: `front/utils/ChartUtils.js`
- Modify: `front/stores/analyticsStoreFactory.js`
- Modify: `front/assets/styles/variables.css`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: all files under `front/i18n/locales/`
- Test: `front/tests/stores/analyticsStore.test.js`
- Test: `front/tests/utils/ChartUtils.test.js`

**Interfaces:**
- Consumes: store `financialTrend`, `balancePeriod`, `visibleFinancialMetrics`, balance/category states, and display currency.
- Produces: four selectable chart series with stable colors/markers, latest-total tiles, current expense actual/forecast, and exact crosshair values.

- [ ] **Step 1: Add failing store tests for persisted metric repair**

```js
test('repairs persisted financial metrics and keeps at least one valid selection', () => {
  storageOverrides.set('analyticsVisibleBalanceMetrics', ['debt', 'unknown', 'debt'])
  const store = (analyticsStore = useAnalyticsStore())
  assert.deepEqual(store.visibleFinancialMetrics, ['debt'])
  store.visibleFinancialMetrics = []
  assert.deepEqual(store.visibleFinancialMetrics, ['netWorth'])
})
```

Also assert a fresh store defaults to `['netWorth', 'savings', 'debt', 'expenses']` while preserving valid legacy selections.

- [ ] **Step 2: Run the focused store test and confirm failure**

```bash
node --test --test-name-pattern="financial metrics" tests/stores/analyticsStore.test.js
```

Expected: FAIL because `visibleFinancialMetrics` is not exposed and `expenses` is not a selectable default.

Add a failing `ChartUtils.test.js` case proving that a point with `inspectionOnly: true` remains available on the shared x-scale but produces no visible segment:

```js
test('inspection-only points align tooltip values without drawing a line', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [{ id: 'balance', points: [{ x: '2026-08', value: 10 }, { x: '2026-08:forecast', value: 10, inspectionOnly: true }] }],
  })
  assert.deepEqual(geometry.xValues, ['2026-08', '2026-08:forecast'])
  assert.deepEqual(geometry.series[0].segments, [])
})
```

- [ ] **Step 3: Add normalized four-metric persistence and the facet component**

Keep the local-storage key `analyticsVisibleBalanceMetrics` for compatibility, but expose a computed setter/getter named `visibleFinancialMetrics`. Normalize against `FINANCIAL_TREND_METRICS`, deduplicate, and fall back to `['netWorth']` when empty.

`analytics-metric-facet.vue` must accept this interface:

```js
const selectedIds = defineModel({ type: Array, default: () => [] })
defineProps({ items: { type: Array, default: () => [] } })
```

Render the same selected-count button/popup/checklist interaction as the category facet, including `app-list-search` and label filtering. Each row shows the series marker and localized label. Refuse deselection when one item remains; no toast is needed because the disabled/unchanged checkbox is sufficient.

- [ ] **Step 4: Replace the balance presentation with Financial trends**

Build metric metadata exactly around these IDs:

```js
[
  { id: 'netWorth', color: 'var(--analytics-net-worth)', marker: 'circle' },
  { id: 'savings', color: 'var(--analytics-savings)', marker: 'square' },
  { id: 'debt', color: 'var(--analytics-debt)', marker: 'diamond' },
  { id: 'expenses', color: 'var(--analytics-expenses)', marker: 'triangle' },
]
```

Map account movement points from `financialTrend.series`. Map total-expense completed points plus current actual (`kind: 'partial'`) and, when available, a current `:forecast` point (`kind: 'forecast'`). When that forecast x-position exists, duplicate each selected account metric's current partial value at the forecast key with `{ kind: 'partial', inspectionOnly: true }`. Update `buildLineChartGeometry` and `persistentPoints()` so inspection-only points participate in crosshair lookup but do not render a line segment or persistent marker. This preserves exact values for every selected series across the forecast vertical line without implying a balance forecast.

Keep latest Net worth/Savings/Debt totals in summary tiles and add Current expenses with actual and forecast labels. Warnings still come only from selected account-backed source series.

Treat the two data sources independently inside the card: a transaction load/error for selected Expenses shows a compact state and retry without hiding ready account movements; a balance load/error does not hide ready expense history. If the failed source is the only selected metric and has no retained data, use the card's blocking state. Wrap the account/expense definition text in the shared collapsed `analytics-calculation-details`; keep missing-rate, validation, stale-data, and request warnings outside it.

Update the tooltip markup to assign amount/qualifier classes and show localized `Partial` for `point.kind === 'partial'`; update the live-region qualifier list too. Preserve the existing crosshair, pin, touch-drag, outside-dismissal, and keyboard behavior.

- [ ] **Step 5: Add localized copy and semantic styles**

In every locale, add the equivalent keys while preserving valid JSON:

```json
{
  "analytics": {
    "common": { "partial": "Partial", "how_calculated": "How this is calculated", "exact_values": "Exact values" },
    "balance": {
      "title": "Financial trends",
      "subtitle": "Monthly movement and current totals",
      "select_metrics": "Select metrics",
      "selected_count": "{count} selected",
      "net_worth_change": "Net-worth change",
      "savings_change": "Savings change",
      "debt_change": "Debt change",
      "total_expenses": "Total expenses",
      "current_total": "Current total",
      "current_actual": "Current actual",
      "current_forecast": "Current forecast"
    }
  }
}
```

Add `--analytics-expenses` in both variable themes and style the facet, summary tiles, tabular tooltip amounts, qualifier text, and mobile wrapping using existing surfaces and focus rings.

Render `analytics.balance.subtitle` directly below the Financial trends title as the card's concise purpose line.

- [ ] **Step 6: Format, verify, and commit**

```bash
npm run lint:fix
npm run test:analytics
npm run build
git diff --check
git add front/components/analytics/analytics-metric-facet.vue front/components/analytics/analytics-balance-trends.vue front/components/charts/multi-series-line-chart.vue front/utils/ChartUtils.js front/stores/analyticsStoreFactory.js front/assets/styles/variables.css front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests/stores/analyticsStore.test.js front/tests/utils/ChartUtils.test.js
git commit -m "feat: add selectable financial trends"
```

Expected: tests and build PASS; every locale parses; the commit contains no backend or dependency change.

### Task 4: Make the page and category card responsive and readable

**Files:**
- Modify: `front/components/analytics/analytics-category-spending.vue`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: all files under `front/i18n/locales/`

**Interfaces:**
- Consumes: existing category summary items `{ label, averageLabel, currentActualLabel, forecastLabel, forecastAvailable }` and `appStore.isDesktopLayout`.
- Produces: full-width stacked cards, desktop table, mobile labeled rows, and one collapsed calculation disclosure with visible warnings.

- [ ] **Step 1: Record the existing visual failures in Chrome**

Use `chrome:control-chrome`, claim the running `/analytics` tab, and record screenshots at desktop width and `390x844`. Confirm before editing that the desktop category/flow cards share a row and that `.analytics-category-summary` exceeds its mobile card width.

- [ ] **Step 2: Render separate desktop and mobile category summaries**

Import/use `useAppStore()`. Keep the existing header/grid under `v-if="appStore.isDesktopLayout"`. Under `v-else`, reuse the same `summaries` data and render each category as a title plus localized values:

```vue
<div v-for="item in summaries" :key="item.id" class="analytics-category-summary-mobile-row">
  <div class="analytics-category-summary-label">
    <span class="analytics-chart-legend-marker" :style="{ backgroundColor: item.color }" />{{ item.label }}
  </div>
  <dl class="analytics-category-summary-mobile-values">
    <div><dt>{{ $t('analytics.common.average') }}</dt><dd>{{ item.averageLabel }}</dd></div>
    <div><dt>{{ $t('analytics.category.current_actual') }}</dt><dd>{{ item.currentActualLabel }}</dd></div>
    <div><dt>{{ $t('analytics.category.current_forecast') }}</dt><dd>{{ item.forecastAvailable ? item.forecastLabel : $t('analytics.category.insufficient_history') }}</dd></div>
  </dl>
</div>
```

This follows Pico's runtime mobile/desktop branch instead of relying on a CSS media query for structural content.

Also change category chart points from `formatNumberForDashboard(point.value)` to the existing `formatCurrency(point.value)` so exact-value tooltips identify the currency consistently with Financial trends.

Add and render `analytics.category.subtitle` as a one-line purpose directly below the card title in every locale.

- [ ] **Step 3: Consolidate explanatory notes**

Replace the repeated category definition/current-month notes in the ready state with:

```vue
<details class="analytics-calculation-details">
  <summary>{{ $t('analytics.common.how_calculated') }}</summary>
  <p>{{ $t('analytics.category.definition') }}</p>
  <p>{{ $t('analytics.category.current_month_separate') }}</p>
</details>
```

Keep short-history, estimated-rate, and missing-rate warnings outside the disclosure. In the empty state, keep the definition visible because it explains why no result exists.

- [ ] **Step 4: Replace the two-column desktop rule and mobile overflow styles**

Make `.analytics-layout` a one-column stack at every width and center it with `width: 100%` and `max-width: 1200px`. Remove the `@media (min-width: 1100px)` two-column rule. Remove the 390px minimum width/scroll dependency from the mobile branch and style its `<dl>` values as compact labeled rows. Use 11-13px type, right-aligned tabular values, and visible focus/summary states in both themes.

- [ ] **Step 5: Reinspect both viewports and commit**

In Chrome, verify:

```text
desktop: Financial trends -> Spending by category -> Money flow, all full-width
390x844: document/card scrollWidth <= clientWidth; every category value label and amount is visible
light + dark: readable titles, headers, notes, and disclosure focus rings
```

Then run:

```bash
npm run lint:fix
npm run build
git diff --check
git add front/components/analytics/analytics-category-spending.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales
git commit -m "refactor: improve analytics layout readability"
```

### Task 5: Simplify and enlarge the money-flow presentation

**Files:**
- Modify: `front/utils/ChartUtils.js`
- Modify: `front/components/charts/money-flow-chart.vue`
- Modify: `front/components/analytics/analytics-money-flow.vue`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: all files under `front/i18n/locales/`
- Test: `front/tests/utils/ChartUtils.test.js`

**Interfaces:**
- Consumes: enriched source/destination nodes, total, and `appStore.isDesktopLayout`.
- Produces: `buildMoneyFlowGeometry({ sources, destinations, total, isDesktop })`, readable SVG geometry, collapsed exact values, and collapsed reconciliation with visible status.

- [ ] **Step 1: Add failing pure geometry tests**

```js
test('money flow uses compact top-to-bottom mobile geometry', () => {
  const geometry = buildMoneyFlowGeometry({
    sources: [{ id: 'income', value: 100 }],
    destinations: [{ id: 'expenses', value: 100 }],
    total: 100,
    isDesktop: false,
  })

  assert.equal(geometry.viewBox, '0 0 360 620')
  assert.ok(geometry.sources[0].labelY < geometry.bus.y)
  assert.ok(geometry.destinations[0].labelY > geometry.bus.y + geometry.bus.height)
  assert.ok(geometry.sources[0].width <= 48)
})

test('money flow retains left-to-right desktop geometry', () => {
  const geometry = buildMoneyFlowGeometry({ sources: [{ id: 'income', value: 100 }], destinations: [{ id: 'expenses', value: 100 }], total: 100, isDesktop: true })
  assert.equal(geometry.viewBox, '0 0 1000 520')
  assert.ok(geometry.sources[0].labelX < geometry.bus.x)
  assert.ok(geometry.destinations[0].labelX > geometry.bus.x + geometry.bus.width)
})
```

- [ ] **Step 2: Run the focused tests and confirm the missing export**

```bash
node --test --test-name-pattern="money flow" tests/utils/ChartUtils.test.js
```

Expected: FAIL because `buildMoneyFlowGeometry` does not exist.

- [ ] **Step 3: Move responsive geometry into `ChartUtils.js`**

Implement `buildMoneyFlowGeometry` with the tested view boxes. Desktop keeps sources left, a vertical bus, and destinations right. Mobile uses source labels/bands above a horizontal bus and destination labels/bands below it. Scale maximum band width to 180 desktop and 48 mobile so a single large flow does not cover labels. Return `{ viewBox, bus, sources, destinations }` with each node containing `path`, `width`, `labelX`, `labelY`, and `textAnchor`.

Update `money-flow-chart.vue` to consume this function and attach localized `ariaLabel` after geometry is built.

Add and render `analytics.flow.subtitle` as a one-line purpose directly below the Money flow card title in every locale.

- [ ] **Step 4: Apply progressive disclosure without hiding status**

Remove `open` from `.analytics-flow-audit`; its summary continues to show `Balanced` or `Not balanced`. Wrap the exact-value `<ul>` in:

```vue
<details class="analytics-flow-values">
  <summary>{{ $t('analytics.common.exact_values') }}</summary>
  <ul class="analytics-flow-list">...</ul>
</details>
```

Keep the SVG’s role/aria label and keyboard-selectable nodes. Keep the full unbalanced audit visible when conservation fails and the SVG is suppressed.

Move the normal flow-definition note inside the collapsed reconciliation details after the audit sections. Keep stale-data, estimated-rate, missing-rate, and conservation-failure warnings visible outside it.

- [ ] **Step 5: Style, inspect, test, and commit**

Increase mobile node/bus labels to a rendered 12-13px, keep 44px interaction targets, use tabular amounts in exact values/audit, and add light/dark disclosure styling. In Chrome at `390x844`, confirm every visible label is legible, the default card no longer duplicates all exact values, the reconciliation starts collapsed, and keyboard activation still opens transaction/residual detail.

Run:

```bash
node --test tests/utils/ChartUtils.test.js
npm run lint:fix
npm run build
git diff --check
git add front/utils/ChartUtils.js front/tests/utils/ChartUtils.test.js front/components/charts/money-flow-chart.vue front/components/analytics/analytics-money-flow.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales
git commit -m "refactor: improve money flow readability"
```

### Task 6: Integrated real-data verification and final repairs

**Files:**
- Modify only files already listed above when a verified regression requires a repair.
- Verify: all analytics tests, all locales, production build, contribution preflight, and live Chrome UI.

**Interfaces:**
- Consumes: the completed five implementation commits and the running local Firefly/Pico environment.
- Produces: evidence that the approved design works with real data across interaction modes and themes.

- [ ] **Step 1: Run deterministic verification from `front/`**

```bash
npm run test:analytics
npm run lint
npm run build
git diff --check
```

Parse every locale explicitly:

```powershell
Get-ChildItem i18n/locales/*.json | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json | Out-Null }
```

Expected: analytics tests and build PASS; all locale files parse. If full lint reports a pre-existing repository baseline issue, run scoped ESLint/Prettier on every touched front-end file and record the exact boundary.

- [ ] **Step 2: Inspect live desktop light and dark modes in Chrome**

Open `/analytics` with the real signed-in app and verify:

```text
Financial trends renders with no console RangeError or secondary undefined-length error
3M / 6M / 12M changes the monthly points
metric facet can show one through four series and never reaches zero selected
hover/click shows one vertical line and exact values for all series present at that month
latest account totals remain visible separately from movement
all three cards are full-width and calculation details start collapsed
```

- [ ] **Step 3: Inspect live mobile light and dark modes in Chrome**

At `390x844`, verify touch drag/release pins the crosshair, tooltips stay within the card, category rows do not clip, the money flow is top-to-bottom and legible, the fixed tab bar does not hide required controls, and no card/document horizontal overflow exists.

- [ ] **Step 4: Run Firefly Pico contribution preflight**

From the repository root, use the local contribution workflow:

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/firefly-pico-oss-contribution/scripts/contribution-preflight.ps1
```

Record each `PASS`, `FAIL`, and `NOT RUN` line exactly. Do not convert packaged/build proof into a deployed/runtime claim.

- [ ] **Step 5: Apply only evidence-backed final repairs and re-run the affected checks**

For each observed defect, first add or extend the narrowest deterministic test when the behavior is in `AnalyticsUtils.js`, `ChartUtils.js`, or the store. For purely responsive presentation defects, capture the failing Chrome viewport, make the smallest CSS/template correction, and recheck the same viewport plus its opposite theme.

- [ ] **Step 6: Commit final verification repairs if any**

If tracked repairs were required:

```bash
git add front/utils/AnalyticsUtils.js front/utils/ChartUtils.js front/stores/analyticsStoreFactory.js front/components/analytics front/components/charts front/pages/analytics.vue front/assets/styles/variables.css front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests
git commit -m "fix: complete analytics UX verification"
```

If no repair was required, do not create an empty commit. Finish with `git status --short` and report the tested commit SHA, exact test counts, build result, Chrome states, preflight result, and any honest `NOT RUN` boundary.
