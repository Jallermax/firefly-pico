# Analytics Forecast and Chart Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make monthly forecasts conservative and reconciled, simplify Daily Forecast into a readable cash-timing chart, and give Cash Use a persistent legend plus distinct area and month inspection modes.

**Architecture:** `buildRemainingActivityForecast()` remains the single forecast engine, but gains one deterministic allocation stage that caps inferred and historical activity inside a target derived from current actuals, completed-month history, and unfulfilled explicit definitions. The store projects those reconciled entries into every analytics card. The existing combination chart gains pure geometry for region hit-testing while its Vue consumer renders either a compact area label or the existing month crosshair/details.

**Tech Stack:** Nuxt 3 SPA, Vue 3 `<script setup>`, Pinia 3 composition stores, Vant 4, date-fns, Node's built-in test runner, existing SVG/CSS chart primitives, Docker multi-stage build.

## Global Constraints

- Plain JavaScript and Vue only; do not add TypeScript or a chart dependency.
- Keep forecast calculation in pure analytics utilities and Firefly data read-only.
- Completed-month averages use only the selected 3/6/12/24 fully completed months and preserve covered zero months.
- Inferred recurring activity and historical remainder may fill the baseline but may not raise the final above it.
- Only active, unfulfilled, explicit Firefly definitions may raise a final above the baseline.
- Forecasts never fall below actual-to-date activity.
- Credit cards remain asset accounts; only liability accounts contribute to debt.
- Preserve exact actual transaction IDs, projected source/candidate/evidence IDs, conversion evidence, unavailable inputs, and suppressed duplicates in separate audit fields.
- Use the existing 11 locale files and analytics theme files; no hard-coded user-facing labels and no `<style>` blocks in Vue components.
- Preserve 44px touch targets, keyboard navigation, dismissal, transaction drill-down, light/dark themes, and mobile/desktop behavior.
- Do not modify Money Flow behavior or the Cash Use category-detail limits.

---

### Task 1: Reconcile Monthly Forecast Targets and Duplicate Sources

**Files:**

- Modify: `front/utils/AnalyticsRecurringUtils.js:701-831`
- Modify: `front/utils/AnalyticsForecastUtils.js:220-1105`
- Test: `front/tests/utils/AnalyticsRecurringUtils.test.js`
- Test: `front/tests/utils/AnalyticsForecastUtils.test.js`

**Interfaces:**

- Consumes: normalized recurring candidates from `buildDefinedOccurrences()`/`detectRecurringCandidates()`, ledger entries, account contexts, normalized display-currency candidate amounts, selected completed months.
- Produces: `buildRemainingActivityForecast()` with reconciled `dailyProjectedEntries`, `remainingFromToday`, `final`, `knownFinal`, and `audit.allocation`; each projected entry retains `sourceKind`, `candidateId`, `sourceId`, `evidenceIds`, and exact `flowAmounts`.
- Adds pure export:

```js
export function reconcileProjectedActivity({ actualByDimension, historicalByDimension, entries, currencyDecimalPlaces })
// => {
//   entries,
//   targetsByDimension,
//   allocatedByDimension,
//   suppressedProjectionIds,
//   cappedProjectionIds,
// }
```

- Allocation dimensions are `category:<categoryId>` for expenses and the primary activity key (`income`, `refunds`, `savingsDeposits`, `savingsWithdrawals`, `debtRepayments`, or `newDebt`) for all other projected activity. `expenses` is recomputed from the category allocations so category totals and the high-level expense forecast are identical after currency rounding.

- [ ] **Step 1: Add recurring semantic-deduplication RED tests**

Add fixtures proving that two authoritative schedules with compatible account/category identity, cadence phase, and amount envelope collapse to one deterministic candidate; prefer `recurringTransaction` over `subscription`, merge evidence and expected dates, and retain the discarded ID in `suppressedCandidateIds`. Build both candidates with `buildDefinedOccurrences()` using one recurring transaction and one subscription for the same checking-to-landlord $2,321 monthly schedule. Add a split-bundle case using three separately detected payroll-tax split candidates, then assign their shared parent transaction evidence. The combined amount must match one explicit payroll definition; the inferred bundle enriches the authoritative candidate without adding another occurrence.

```js
const recurringRentFixture = {
  id: "recurring-rent",
  attributes: {
    active: true,
    type: "withdrawal",
    title: "Rent",
    repetitions: [
      { type: "monthly", moment: "1", skip: 0, occurrences: ["2026-08-01"] },
    ],
    transactions: [
      {
        amount: "2321",
        description: "Rent",
        source_id: "checking",
        destination_id: "landlord",
        category_id: "housing",
      },
    ],
  },
};
const subscriptionRentFixture = {
  id: "subscription-rent",
  attributes: {
    active: true,
    name: "Rent",
    repeat_freq: "monthly",
    amount_min: "2321",
    amount_max: "2321",
    amount_avg: "2321",
    pay_dates: ["2026-08-01"],
  },
};

test("deduplicates equivalent authoritative recurrence sources and keeps suppression audit", () => {
  const [recurringRent] = buildDefinedOccurrences({
    recurringTransactions: [recurringRentFixture],
    startDate: "2026-08-01",
    endDate: "2026-08-31",
  });
  const [subscriptionRent] = buildDefinedOccurrences({
    subscriptions: [subscriptionRentFixture],
    startDate: "2026-08-01",
    endDate: "2026-08-31",
  });
  const merged = mergeRecurringCandidates({
    defined: [subscriptionRent, recurringRent],
    inferred: [],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source.type, "recurringTransaction");
  assert.deepEqual(merged[0].suppressedCandidateIds, [subscriptionRent.id]);
  assert.deepEqual(merged[0].expectedDates, ["2026-08-01"]);
});

test("consumes an inferred split bundle into its explicit parent occurrence", () => {
  const months = [
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
  ];
  const parentTransactionIds = months.map((month) => `payroll-${month}`);
  const inferredSplits = [
    { prefix: "federal", value: 763, categoryId: "federal-tax" },
    { prefix: "social", value: 568, categoryId: "social-security" },
    { prefix: "medicare", value: 133, categoryId: "medicare" },
  ].map(({ prefix, value, categoryId }) => {
    const [candidate] = detectRecurringCandidates({
      entries: months.map((month) =>
        entry({
          id: `${prefix}-${month}`,
          date: `${month}-15`,
          value,
          destinationId: "tax-authority",
          categoryId,
          description: "Payroll taxes",
        }),
      ),
      startDate: "2026-02-01",
      endDate: "2026-07-31",
    }).candidates;
    return {
      ...candidate,
      evidence: { ...candidate.evidence, transactionIds: parentTransactionIds },
    };
  });
  const payrollTaxFixture = {
    id: "recurring-payroll-tax",
    attributes: {
      active: true,
      type: "withdrawal",
      title: "Payroll taxes",
      repetitions: [
        { type: "monthly", moment: "15", skip: 0, occurrences: ["2026-08-15"] },
      ],
      transactions: [
        {
          amount: "1464",
          description: "Payroll taxes",
          source_id: "checking",
          destination_id: "tax-authority",
        },
      ],
    },
  };
  const [explicitPayroll] = buildDefinedOccurrences({
    recurringTransactions: [payrollTaxFixture],
    startDate: "2026-08-01",
    endDate: "2026-08-31",
  });
  const [federalSplit, socialSecuritySplit, medicareSplit] = inferredSplits;
  const merged = mergeRecurringCandidates({
    defined: [explicitPayroll],
    inferred: [federalSplit, socialSecuritySplit, medicareSplit],
  });
  assert.equal(merged.length, 1);
  assert.deepEqual(
    merged[0].suppressedCandidateIds,
    [federalSplit.id, medicareSplit.id, socialSecuritySplit.id].sort(),
  );
});
```

- [ ] **Step 2: Run the recurring tests and capture RED**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsRecurringUtils.test.js
```

Expected: the new cases fail because `mergeRecurringCandidates()` currently preserves duplicate authoritative schedules and unmatched split candidates.

- [ ] **Step 3: Implement deterministic candidate canonicalization**

Before merging inferred candidates, sort authoritative candidates by this priority and stable ID:

```js
const sourcePriority = { recurringTransaction: 0, subscription: 1 };
const authoritative = [...defined].sort(
  (left, right) =>
    (sourcePriority[left.source.type] ?? 9) -
      (sourcePriority[right.source.type] ?? 9) ||
    left.id.localeCompare(right.id),
);
```

Merge only when `compatibleIdentity`, `cadencePhaseCompatible`, and `amountEnvelopesOverlap` all pass. Union expected dates/evidence; store sorted `suppressedCandidateIds`. For inferred split bundles, require common parent transaction evidence, compatible cadence, compatible route, and a combined envelope overlapping the authoritative amount. Do not merge merely by description.

- [ ] **Step 4: Add reconciled-target RED tests**

Cover actual below/equal/above baseline, no current activity, explicit below/above baseline, inferred and variable overfill, rounding residual, missing FX, signed savings/debt movement, and shuffled input. Bind the essential examples:

```js
test("caps inferred and variable expense allocation at the completed-month category target", () => {
  const history = expensesForMonths(
    ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"],
    7500,
  );
  const actual = entry({ id: "august-actual", date: "2026-08-05", value: 140 });
  const rent = definedCandidate({
    id: "rent",
    sourceAccountId: "checking",
    destinationAccountId: "landlord",
    amount: 2321,
  });
  const result = buildRemainingActivityForecast({
    ledger: ledger([...history, actual]),
    candidates: [rent],
    ...normalizedCandidateInputs([rent]),
    historyMonths: 6,
    today: "2026-08-10",
    endDate: "2026-08-31",
  });
  assert.equal(result.final.expenses, 7500);
  assert.equal(result.remainingFromToday.expenses, 7360);
  assert.equal(
    result.dailyProjectedEntries.reduce(
      (total, item) => total + item.flowAmounts.expenses,
      0,
    ),
    7360,
  );
});

test("lets unfulfilled explicit activity raise the final but never adds inference above it", () => {
  const history = expensesForMonths(
    ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"],
    7500,
  );
  const actual = entry({
    id: "august-actual",
    date: "2026-08-05",
    value: 9000,
  });
  const rent = definedCandidate({
    id: "rent",
    sourceAccountId: "checking",
    destinationAccountId: "landlord",
    amount: 1000,
  });
  const result = buildRemainingActivityForecast({
    ledger: ledger([...history, actual]),
    candidates: [rent],
    ...normalizedCandidateInputs([rent]),
    historyMonths: 6,
    today: "2026-08-10",
    endDate: "2026-08-31",
  });
  assert.equal(result.final.expenses, 10000);
  assert.equal(result.remainingFromToday.expenses, 1000);
  assert.equal(
    result.dailyProjectedEntries.some(
      ({ sourceKind }) => sourceKind !== "defined",
    ),
    false,
  );
});
```

Also assert:

```js
assert.equal(
  result.dailyProjectedEntries.reduce(
    (total, item) => total + item.flowAmounts.expenses,
    0,
  ),
  result.remainingFromToday.expenses,
);
assert.equal(
  result.actualToDate.expenses + result.remainingFromToday.expenses,
  result.final.expenses,
);
assert.deepEqual(shuffled, ordered);
```

- [ ] **Step 5: Run the forecast tests and capture RED**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsForecastUtils.test.js
```

Expected: target and audit assertions fail because recurring, inferred, and variable projections are currently summed without a shared cap.

- [ ] **Step 6: Implement the allocation stage**

Build `actualByDimension` and `historicalByDimension` from the same covered ledger months. For each dimension compute:

```js
const baselineFinal = Math.max(actual, historicalAverage);
const explicitDue = entries
  .filter(({ sourceKind }) => sourceKind === "defined")
  .reduce((total, entry) => total + entry.amount, 0);
const target = Math.max(baselineFinal, actual + explicitDue);
let capacity = roundAmount(target - actual, currencyDecimalPlaces);
```

Allocate entries in `defined`, `inferred`, `variable` order, then expected date and stable ID. Defined entries consume their full rounded amount. Later entries receive at most remaining capacity; drop zero allocations and scale `amount` plus every finite `flowAmounts` member by the same rounded ratio. Put dropped IDs in `suppressedProjectionIds` and partly allocated IDs in `cappedProjectionIds`. Recompute flow totals and derived signed metrics only from retained entries.

- [ ] **Step 7: Run focused forecast and recurring GREEN**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsRecurringUtils.test.js tests/utils/AnalyticsForecastUtils.test.js
```

Expected: all tests pass and reconciliation assertions are exact at the configured display-currency precision.

- [ ] **Step 8: Commit Task 1**

```powershell
git add -- front/utils/AnalyticsRecurringUtils.js front/utils/AnalyticsForecastUtils.js front/tests/utils/AnalyticsRecurringUtils.test.js front/tests/utils/AnalyticsForecastUtils.test.js
git diff --cached --check
git commit -m "fix: reconcile analytics forecast targets"
```

---

### Task 2: Feed One Forecast into Trends and Categories

**Files:**

- Modify: `front/stores/analyticsStoreFactory.js:644-933`
- Modify: `front/utils/AnalyticsUtils.js:920-1010`
- Modify: `front/utils/AnalyticsCategoryPresentationUtils.js:20-63`
- Test: `front/tests/stores/analyticsStore.test.js`
- Test: `front/tests/utils/AnalyticsUtils.test.js`
- Test: `front/tests/utils/AnalyticsCategoryPresentationUtils.test.js`

**Interfaces:**

- Consumes: Task 1 `buildRemainingActivityForecast()` output and `summarizeProjectedSources()`.
- Produces: Financial Trends and Spending by category forecast points whose `actualToDate + remainingFromToday === final`, whose category sum equals total expenses, and whose presentation groups variable allocations into one readable row.

- [ ] **Step 1: Add cross-card reconciliation RED tests**

Create a store fixture with completed categories, current actuals, one explicit rent, one inferred source, distributed variable rows, and `cashUseMode: 'spending'`. Assert:

```js
assert.equal(
  store.financialTrend.expenses.currentForecast,
  store.financialTrend.forecast.final.expenses,
);
assert.equal(
  store.categorySummary.series.reduce((total, { final }) => total + final, 0),
  store.financialTrend.expenses.currentForecast,
);
assert.equal(
  store.dailyForecast.monthlyTotals.components.expenses,
  store.financialTrend.forecast.final.expenses,
);
assert.equal(
  store.cashUseSeries.totalUses.points.at(-1).value,
  store.financialTrend.expenses.currentForecast,
);
```

Assert Monthly change and category series contain completed points plus one `:forecast` point and no partial-today point. Preserve the existing balance-series Today point.

- [ ] **Step 2: Add readable-details RED tests**

Pass 20 variable daily entries for one category into `buildCategoryForecastDetailsPresentation()` and assert one `source:variable:variable` row whose amount is the exact sum. Assert explicit duplicate suppression appears once and the forecast-above-average case names the explicit source.

- [ ] **Step 3: Run focused presenter/store tests and capture RED**

Run:

```powershell
cd front
node --test tests/stores/analyticsStore.test.js tests/utils/AnalyticsUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js
```

Expected: reconciliation or grouping assertions fail against the current raw projected-entry filtering.

- [ ] **Step 4: Replace card-local projection arithmetic**

In the `categorySummary` selector, derive category remaining/final directly from reconciled entries and their Task 1 allocation audit. In `financialTrend`, use `forecast.final`, `forecast.remainingFromToday`, and `forecast.statusByMetric` without recalculating a second target. Preserve split-savings filtering but source amounts only from reconciled entries.

Replace the category presentation loop with the shared grouping helper:

```js
const groupedSources = summarizeProjectedSources(
  (point.projectedSources ?? []).map((source) => ({
    ...source,
    amount: source.flowAmounts?.expenses,
  })),
);
```

Render rows in `defined`, `inferred`, `variable` order with source label, signed amount, overdue/confidence state, and evidence count; do not expose raw IDs as the primary label.

- [ ] **Step 5: Keep chart metadata and drill-down exact**

Ensure forecast points carry `actualTransactionIds`, reconciled `projectedSources`, `actualToDate`, `historicalBaseline`, `remainingFromToday`, `final`, `progress`, `progressState`, and `status`. Actual completed points keep exact transaction IDs. Projected-only rows do not navigate.

- [ ] **Step 6: Run Task 2 GREEN**

Run:

```powershell
cd front
node --test tests/stores/analyticsStore.test.js tests/utils/AnalyticsUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js
```

Expected: all tests pass with exact totals, no partial expense/change plot point, and collapsed readable source rows.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- front/stores/analyticsStoreFactory.js front/utils/AnalyticsUtils.js front/utils/AnalyticsCategoryPresentationUtils.js front/tests/stores/analyticsStore.test.js front/tests/utils/AnalyticsUtils.test.js front/tests/utils/AnalyticsCategoryPresentationUtils.test.js
git diff --cached --check
git commit -m "fix: align analytics forecast consumers"
```

---

### Task 3: Simplify Daily Forecast into Cash Timing

**Files:**

- Modify: `front/stores/analyticsStoreFactory.js:86-365`
- Modify: `front/components/analytics/analytics-daily-forecast.vue`
- Modify: `front/components/charts/analytics-combination-chart.vue`
- Modify: `front/assets/styles/theme-white.css:3032-3120`
- Modify: `front/assets/styles/theme-dark.css:506-525`
- Modify: all JSON files under `front/i18n/locales/`
- Test: `front/tests/stores/analyticsStore.test.js`
- Test: `front/tests/utils/AnalyticsCashUseUtils.test.js`

**Interfaces:**

- Consumes: reconciled `forecast.dailyProjectedEntries` from Task 1.
- Produces: `dailyForecast.summary`, two `barGroups` (`inflow`, `outflow`), one cumulative `availableLine`, and per-day item/evidence details.

```js
dailyForecast.summary = {
  inflow: { actual, projected, final, status },
  outflow: { actual, projected, final, status },
  availableChange: { actual, projected, final, status },
};
```

- [ ] **Step 1: Add Daily Forecast projection RED tests**

Assert exactly two bar groups:

```js
assert.deepEqual(
  store.dailyForecast.barGroups.map(({ id }) => id),
  ["inflow", "outflow"],
);
assert.equal(store.dailyForecast.barGroups[0].points.length, 31);
assert.equal(store.dailyForecast.barGroups[1].points.length, 31);
```

For a mixed day, assert one inflow and one negative outflow bar, `kind: 'actual'` through today and `kind: 'forecast'` after today, exact actual transaction IDs, projected evidence IDs, amount-descending item details, summary totals, Today index, and cumulative Available reconciliation. Preserve null gaps from the exact unavailable date onward.

- [ ] **Step 2: Run Daily Forecast store tests and capture RED**

Run:

```powershell
cd front
node --test tests/stores/analyticsStore.test.js
```

Expected: the two-group and summary assertions fail because the current selector emits eight provenance groups.

- [ ] **Step 3: Rebuild the daily selector around direction totals**

Replace the `DAILY_SOURCE_KINDS × directions` groups with:

```js
const barGroups = [
  buildDirectionGroup("inflow", DAILY_SOURCE_KEYS, 1),
  buildDirectionGroup("outflow", DAILY_USE_KEYS, -1),
];
```

Each point aggregates the applicable actual or projected bucket, carries `entries` sorted by descending absolute amount then stable ID, and retains actual/projected evidence separately. Keep provenance (`actual`, `defined`, `inferred`, `variable`), confidence, conversion, source/candidate/evidence IDs on each detail entry instead of separate bars.

- [ ] **Step 4: Add Daily Forecast component contract tests**

Extend the existing source-contract test to require summary tiles, only the three visual legend items, day selection details, pattern distinction, Today label, 44px detail rows, and exact actual-row route projection. Assert projected-only rows do not navigate.

- [ ] **Step 5: Update the Daily Forecast component**

Render three compact summary values above the chart using locale keys `expected_inflow`, `expected_outflow`, and `available_change`. Change the legend to Inflow, Outflow, Available change; use solid actual bars and the existing forecast hatch after today. On selected day render:

```text
Inflow
Outflow
Available change
Scheduled and estimated items, descending by amount
```

Use readable source labels first. Place candidate/evidence IDs only inside the existing details disclosure.

- [ ] **Step 6: Add locale and theme support**

Add these keys identically across all 11 locale structures, with translated values matching each file's language:

```json
{
  "expected_inflow": "Expected inflow",
  "expected_outflow": "Expected outflow",
  "day_details": "Day details",
  "scheduled_and_estimated": "Scheduled and estimated items"
}
```

Add shared classes for the three-value summary, solid/hatched legend markers, selected-day list, and dark surfaces. Reuse `--income2`, `--expense2`, `--transfer2`, and existing analytics card variables.

- [ ] **Step 7: Run Daily Forecast GREEN and parse locales**

Run:

```powershell
cd front
node --test tests/stores/analyticsStore.test.js tests/utils/AnalyticsCashUseUtils.test.js
Get-ChildItem i18n/locales/*.json | ForEach-Object { Get-Content -Raw $_ | ConvertFrom-Json | Out-Null }
```

Expected: tests pass and every locale parses.

- [ ] **Step 8: Commit Task 3**

```powershell
git add -- front/stores/analyticsStoreFactory.js front/components/analytics/analytics-daily-forecast.vue front/components/charts/analytics-combination-chart.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests/stores/analyticsStore.test.js front/tests/utils/AnalyticsCashUseUtils.test.js
git diff --cached --check
git commit -m "feat: clarify daily cash forecast"
```

---

### Task 4: Add Cash Use Legend and Dual Hover Resolution

**Files:**

- Modify: `front/utils/AnalyticsCashUseUtils.js:1-122`
- Modify: `front/components/charts/analytics-combination-chart.vue`
- Modify: `front/components/analytics/analytics-cash-use.vue`
- Modify: `front/assets/styles/theme-white.css:3032-3120`
- Modify: `front/assets/styles/theme-dark.css:506-525`
- Modify: all JSON files under `front/i18n/locales/`
- Test: `front/tests/utils/AnalyticsCashUseUtils.test.js`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**

- Adds pure exports:

```js
export function interpolateCombinationArea({ points, xValues, position })
// => { bottom, top, point, leftPoint, rightPoint } | null

export function resolveCombinationChartTarget({
  clientPoint,
  bounds,
  viewBox,
  padding,
  xValues,
  areas,
  yAt,
  pointerType,
})
// => { mode: 'month', index } | { mode: 'area', index, seriesId } | null
```

- Extends interaction state with `mode: 'month' | 'area' | null` and `selectedSeriesId: string | null`; preserves `selectedIndex`, pinning, keyboard month traversal, row selection, and clear effects.
- `analytics-combination-chart` emits the same `select` and `select-point` events; area-mode `select` payload is `{ mode: 'area', seriesId, label }`, while month mode retains `{ mode: 'month', index, x, xLabel, values }`.

- [ ] **Step 1: Add pure area/month resolver RED tests**

Cover interpolation inside stacked bands, gaps between bands, boundary ties, forecast paths, negative gaps, SVG-to-client scaling, scroll offset, and precedence:

```js
const input = {
  bounds: { left: 100, top: 50, width: 800, height: 440 },
  viewBox: { width: 400, height: 220 },
  padding: { left: 40, right: 40, top: 20, bottom: 30 },
  xValues: ["2026-06", "2026-07", "2026-08"],
  areas: [
    {
      seriesId: "expense:housing",
      points: [
        { x: "2026-06", bottom: 0, top: 100 },
        { x: "2026-07", bottom: 0, top: 100 },
        { x: "2026-08", bottom: 0, top: 100 },
      ],
    },
  ],
  yAt: (value) => 190 - value,
  pointerType: "mouse",
};
assert.deepEqual(
  resolveCombinationChartTarget({ ...input, clientPoint: { x: 500, y: 250 } }),
  { mode: "month", index: 1 },
);
assert.deepEqual(
  resolveCombinationChartTarget({ ...input, clientPoint: { x: 340, y: 330 } }),
  { mode: "area", index: 0, seriesId: "expense:housing" },
);
assert.equal(
  resolveCombinationChartTarget({ ...input, clientPoint: { x: 340, y: 80 } }),
  null,
);
```

Use a desktop corridor of 10 CSS pixels and a touch corridor/target of 44 CSS pixels. Month mode must win when a point is both inside an area and inside the month corridor.

- [ ] **Step 2: Add interaction reducer RED tests**

Assert area hover selects only the series, month hover selects the month, click/tap pins the current mode, moving while pinned does nothing, second click/tap clears, outside/Escape clears, keyboard arrows/Home/End select month mode, and a month tooltip row still emits `selectRow` with exact evidence.

- [ ] **Step 3: Run Cash Use utility tests and capture RED**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js
```

Expected: the resolver exports and area-mode state do not exist.

- [ ] **Step 4: Implement interpolation and target resolution**

Convert the pointer to SVG coordinates using `bounds` and `viewBox`. Determine the fractional x position. Check the nearest month guide first using the pointer-type corridor. Otherwise evaluate visible filled areas in reverse SVG paint order and accept a series when interpolated `bottom <= y <= top`. Resolve exact shared boundaries by visual topmost order, then stable `seriesId`.

- [ ] **Step 5: Wire dual interaction into the combination chart**

Replace the full-height per-month transparent hit rectangles with root-level pointer resolution. In area mode:

- set `aria-live` text to the area label;
- render a compact label near the pointer;
- add the active class to the matching paths and dim other filled areas;
- do not show the month crosshair or all-value tooltip.

In month mode, retain the crosshair, all series values in visual stack order, total uses, total sources, and excess/shortfall. Keep actual transaction row drill-down and projected evidence behavior unchanged.

- [ ] **Step 6: Add the persistent Cash Use legend**

In `analytics-cash-use.vue`, derive legend items from the already localized `chartSeries`:

```js
const legendItems = computed(() => [
  ...chartSeries.value.useLayers,
  chartSeries.value.ordinaryIncome,
  ...chartSeries.value.sourceBands,
  {
    id: "refund-coverage",
    label: t("analytics.cash_use.refund_coverage"),
    pattern: "refund",
  },
  {
    id: "gap-positive",
    label: t("analytics.cash_use.new_excess"),
    pattern: "positive-gap",
  },
  {
    id: "gap-negative",
    label: t("analytics.cash_use.existing_available_funds_required"),
    pattern: "negative-gap",
  },
]);
```

Filter out invisible series, preserve stack order, and render color/pattern markers with text. Desktop wraps; mobile uses a horizontally scrollable row only when needed.

- [ ] **Step 7: Add component/style/locale regression checks**

Assert every visible filled area has exactly one legend item, the legend has an accessible localized name, area hover uses label-only mode, month mode lists all values, pointer/touch/keyboard pinning works, and every interactive row is at least 44px. Add locale keys `legend_label` and `area_label` across all 11 files and dark-theme active/dimmed states.

- [ ] **Step 8: Run Task 4 GREEN**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js tests/stores/analyticsStore.test.js
Get-ChildItem i18n/locales/*.json | ForEach-Object { Get-Content -Raw $_ | ConvertFrom-Json | Out-Null }
```

Expected: pure geometry, reducer, legend, and component contracts all pass.

- [ ] **Step 9: Commit Task 4**

```powershell
git add -- front/utils/AnalyticsCashUseUtils.js front/components/charts/analytics-combination-chart.vue front/components/analytics/analytics-cash-use.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests/utils/AnalyticsCashUseUtils.test.js front/tests/stores/analyticsStore.test.js
git diff --cached --check
git commit -m "feat: inspect cash use areas and months"
```

---

### Task 5: Complete Static and Production Verification

**Files:**

- Modify only if a gate exposes a defect in a Task 1-4 owned file.
- Verify: `front/package-lock.json`, root `Dockerfile`, `docker-compose.pico.local.yml`, rendered `/analytics` route.

**Interfaces:**

- Consumes: all Task 1-4 commits.
- Produces: exact test/build/Docker/Chrome evidence; no new runtime API.

- [ ] **Step 1: Run focused and full analytics tests**

```powershell
cd front
node --test tests/utils/AnalyticsRecurringUtils.test.js tests/utils/AnalyticsForecastUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/AnalyticsCashUseUtils.test.js tests/utils/AnalyticsUtils.test.js tests/stores/analyticsStore.test.js
npm run test:analytics
```

Expected: every test passes, including exact reconciliation and interaction cases.

- [ ] **Step 2: Run touched lint, formatting, locale, and diff gates**

```powershell
cd front
npx eslint utils/AnalyticsRecurringUtils.js utils/AnalyticsForecastUtils.js utils/AnalyticsCategoryPresentationUtils.js utils/AnalyticsCashUseUtils.js utils/AnalyticsUtils.js stores/analyticsStoreFactory.js components/charts/analytics-combination-chart.vue components/analytics/analytics-daily-forecast.vue components/analytics/analytics-cash-use.vue tests/utils/AnalyticsRecurringUtils.test.js tests/utils/AnalyticsForecastUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/AnalyticsCashUseUtils.test.js tests/utils/AnalyticsUtils.test.js tests/stores/analyticsStore.test.js --max-warnings 0
npx prettier --check utils/AnalyticsRecurringUtils.js utils/AnalyticsForecastUtils.js utils/AnalyticsCategoryPresentationUtils.js utils/AnalyticsCashUseUtils.js utils/AnalyticsUtils.js stores/analyticsStoreFactory.js components/charts/analytics-combination-chart.vue components/analytics/analytics-daily-forecast.vue components/analytics/analytics-cash-use.vue tests/utils/AnalyticsRecurringUtils.test.js tests/utils/AnalyticsForecastUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js tests/utils/AnalyticsCashUseUtils.test.js tests/utils/AnalyticsUtils.test.js tests/stores/analyticsStore.test.js i18n/locales/*.json
Get-ChildItem i18n/locales/*.json | ForEach-Object { Get-Content -Raw $_ | ConvertFrom-Json | Out-Null }
cd ..
git diff --check
git status --short
```

Expected: all touched checks pass; unrelated baseline lint failures are reported separately rather than changed.

- [ ] **Step 3: Run the production Nuxt build**

```powershell
cd front
npm run build
```

Expected: Nuxt client/server/Nitro output completes with exit code 0.

- [ ] **Step 4: Reproduce and verify the Docker dependency/build path**

From the repository root use the checkout-local Compose overlay, not the published-image Compose file:

```powershell
docker-compose -f docker-compose.pico.local.yml build --no-cache firefly-pico
```

Expected: the `RUN npm ci --ignore-scripts` layer and subsequent Nuxt build complete. If dependency download fails, capture the complete npm error above exit code 1 plus the build container's DNS/registry connectivity; do not describe a network failure as a source-build failure.

- [ ] **Step 5: Verify authenticated desktop Chrome**

Open `/analytics` in the user's authenticated Chrome session and inspect the live selected 6-month case:

- Financial Trends total-expense final is no lower than actual, does not exceed the reconciled target without named explicit due activity, and shows a forecast point.
- Spending by category uses the same final and shows one collapsed historical-remainder row per category.
- Daily Forecast shows three summary values, two bar directions, a cumulative Available line, a Today marker, and readable day detail.
- Cash Use shows a persistent legend; area hover shows only the region name; month-guide hover shows all values plus totals/gap; click/tap and Escape pin/clear correctly.
- Console contains no new errors.

Capture screenshots of Financial Trends/category forecast details, Daily Forecast, Cash Use area hover, and Cash Use month mode.

- [ ] **Step 6: Verify mobile and dark Chrome states**

Use Chrome device emulation at 390px width, then switch the app's runtime dark theme. Confirm the legend remains readable, 44px tap targets work, tooltips remain within the viewport, patterns remain distinct, and both charts preserve all usable data.

- [ ] **Step 7: Run contribution preflight and final status checks**

Use the repository-local contribution preflight described by the Firefly Pico contribution skill, then run:

```powershell
git diff --check
git status --short
git log --oneline -6
```

Expected: no blockers, no secrets, no unrelated staged files, and a clean tracked worktree. Report Chrome and Docker as `PASS`, `FAIL`, or `NOT RUN` independently.

---

## Completion Criteria

- Monthly and category forecasts are explainable, conservative, and mathematically reconciled.
- Daily Forecast answers when cash enters/leaves and how Available changes without provenance-bar clutter.
- Cash Use names every visible area persistently and resolves area hover separately from month inspection.
- Exact transaction and projected evidence remain available without raw IDs replacing readable primary labels.
- Focused tests, full analytics, touched static checks, production Nuxt build, Docker build, and rendered Chrome QA all have explicit current-run evidence.
