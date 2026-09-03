# Extended Analytics V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Extended Analytics financially consistent and explainable by sharing one transaction-backed ledger across balances, monthly changes, spending, money flow, refund coverage, daily forecasting, and additive cash-use analysis.

**Architecture:** Keep Firefly III authoritative and the existing `/analytics` route intact. Add thin read-only repositories for Firefly transaction links and subscriptions, normalize all analytics inputs into a pure ledger, reconstruct historical balances backward from a fresh account snapshot, and project each chart from that shared foundation. Pure JavaScript utilities own accounting and forecasting rules; Pinia coordinates loading and card-isolated state; existing Vue/Vant/SVG components own interaction and presentation. No backend endpoint, migration, database, npm dependency, or composer dependency is added.

**Tech Stack:** Plain JavaScript, Vue 3 `<script setup>`, Pinia composition stores, Nuxt 3 SPA, Vant 4, date-fns, lodash-es, Node's built-in test runner, existing SVG chart primitives, CSS variables, and all supported i18n locales.

## Global Constraints

- Work only on `personal/extended-analytics`. Do not push, open a PR, merge, or stage unrelated work.
- Treat `docs/superpowers/specs/2026-08-03-extended-analytics-v3-design.md` as the source of truth. If existing code disagrees with it, change the code rather than silently weakening the design.
- Keep Firefly III authoritative. The Laravel catch-all proxy already exposes the required Firefly endpoints; do not add a Pico backend route.
- Do not add dependencies, migrations, persistent analytics data, or external AI.
- Use plain `.js` and `.vue` only: single quotes, no semicolons, trailing commas, 2-space indentation, and no TypeScript or JSDoc types.
- Preserve JSON:API shapes. Access entity properties with `get(entity, 'attributes.path')` or a normalized field, never by assuming a flattened model.
- Fetch a fresh analytics-local account snapshot. Do not overwrite the global account store merely to refresh analytics, and do not silently fall back to stale accounts after a failed fresh fetch.
- Net worth is the signed total of active balance-holding accounts with `include_net_worth === true`. Savings accounts are active assets with role `savingAsset`. Debt is the non-negative magnitude of active Firefly `liabilities` accounts only. Credit-card asset accounts stay in Available and may be negative.
- Savings supports Unified and Split views; Split separates `include_net_worth === true` accessible savings from `include_net_worth !== true` restricted/excluded savings.
- Treat refunds as cash receipts in the receipt month. Attribute linked purchase-cost coverage to the original purchase month. A `#refund` tag without a link is an unlinked refund whose coverage remains in the receipt month.
- Preserve both truthful refund and expense legs. Never convert a refund into ordinary income or destructively net it out of the underlying transaction set.
- Completed-month averages exclude the unfinished current month. Missing activity is an explicit zero when data coverage is complete.
- Forecasts combine completed-history baselines, remaining recurring activity, and current actuals. Expense/category final forecast is never below actual. Progress is clamped to 0–100%; when actual exceeds the baseline, show `Above historical average` instead of an invalid percent.
- Every visible amount retains exact contributing transaction IDs or a clearly marked projected-source reference. Actual points and nodes must drill down to the transaction list.
- Currency conversion uses the selected display currency and current available rates. Missing conversion is unavailable, never zero. Show one page-level FX disclosure only when conversion is actually used or incomplete.
- Money-flow outer nodes are amount-descending with deterministic stable ties and `Other` last. Detail remains Top 5, Top 10, or All. Desktop is left-to-right; mobile may omit outer category layers only when required for readable pool/use flow.
- Use non-color patterns and labels for refunds, forecasts, accessible/restricted savings, and unavailable values. Respect light/dark themes and `profileStore.showAnimations`.
- Add every new label to all 11 locale files: `de-DE`, `en`, `es-MX`, `fr`, `it`, `ko`, `pl`, `pt-BR`, `ro`, `ru-RU`, and `zh-CN`.
- TDD is mandatory for pure calculations and behavior changes: add a focused failing test, run the narrow test and observe the intended failure, implement the minimum behavior, then rerun green before refactoring.
- Each task ends in a focused local commit. Before every commit run `git diff --check` and inspect `git status --short` so unrelated changes remain untouched.

## Shared Data Contracts

### Normalized ledger

`front/utils/AnalyticsLedgerUtils.js` exports:

```js
export function buildAnalyticsLedger({
  transactions,
  transactionLinks,
  accounts,
  displayCurrencyCode,
  primaryCurrencyCode,
  rates,
})
```

It returns:

```js
{
  entries: [
    {
      id,
      transactionId,
      journalId,
      splitIndex,
      date,
      monthKey,
      day,
      value,
      isEstimated,
      sourceAccount,
      destinationAccount,
      sourceKind,
      destinationKind,
      categoryId,
      tags,
      refund: {
        isRefund,
        signals,
        linkedPurchaseTransactionId,
        linkedPurchaseMonthKey,
        coverageCategoryId,
        coverageMonthKey,
        coverageValue,
        isLinked,
      },
    },
  ],
  months,
  coverage: { startMonth, endDate },
  fx: { isEstimated, missingCurrencies, transactionIds },
  audit: { unclassifiedValue, transactionIds, unmatchedRefundLinkIds },
}
```

### Balance reconstruction

`front/utils/AnalyticsBalanceUtils.js` exports:

```js
export function reconstructBalanceSeries({
  accounts,
  entries,
  metric,
  monthKeys,
  asOfDate,
  displayCurrencyCode,
  primaryCurrencyCode,
  rates,
  currencyDecimalPlaces,
})
```

It returns:

```js
{
  id,
  points,
  currentPoint,
  accountBreakdown,
  coverage,
  fx,
  reconciliation: {
    status,
    anchorValue,
    reconstructedValue,
    delta,
    accounts,
  },
}
```

`status` is exactly `ok`, `unavailable`, or `mismatch`. A mismatch is card-scoped and must identify affected accounts without duplicating the same message.

### Recurring candidates and forecast

`front/utils/AnalyticsRecurringUtils.js` exports:

```js
export function buildDefinedOccurrences({ recurringTransactions, subscriptions, startDate, endDate })
export function detectRecurringCandidates({ entries, startDate, endDate })
export function mergeRecurringCandidates({ defined, inferred })
export function matchRecurringOccurrences({ candidates, actualEntries, today })
```

`front/utils/AnalyticsForecastUtils.js` exports:

```js
export function buildRemainingActivityForecast({
  ledger,
  candidates,
  historyMonths,
  today,
  endDate,
})

export function projectMetricForecast({
  metric,
  actual,
  historicalAverage,
  remainingActivity,
  currentTotal,
})
```

The remaining forecast returns daily projected entries, totals by flow family, confidence, and audit metadata. Defined recurring/subscription schedules override inferred candidates for the same signature.

### Additive cash-use series

`front/utils/AnalyticsCashUseUtils.js` exports:

```js
export function buildCashUseSeries({
  ledger,
  remainingActivity,
  months,
  mode,
  savingsView,
  categoryIds,
  detailLevel,
})
```

`mode` is `spending` or `full`. The result contains sources, signed use layers, excess/shortfall, exact actual transaction IDs, and projected-source metadata.

---

### Task 1: Add read-only Firefly inputs and a fresh analytics snapshot

**Files:**
- Create: `front/repository/TransactionLinkRepository.js`
- Create: `front/repository/SubscriptionRepository.js`
- Modify: `front/stores/analyticsStoreFactory.js`
- Modify: `front/tests/stores/analyticsStore.test.js`
- Test: `front/tests/repository/BaseRepository.test.js`

**Interfaces:**
- `TransactionLinkRepository.getAll()` reads `transaction-links` through `BaseRepository` pagination.
- `SubscriptionRepository.getAll(startDate, endDate)` reads `subscriptions` with `start` and `end` query parameters.
- `analyticsStoreFactory` accepts injectable `accountRepository`, `transactionLinkRepository`, `subscriptionRepository`, and `recurringTransactionRepository` dependencies for deterministic tests.
- `init()` and `refresh()` produce one coherent snapshot: fresh accounts, 24-month transactions, transaction links, subscriptions, recurring definitions, and rates.

- [ ] **Step 1: Add failing repository URL tests**

Add expectations proving exact endpoint paths and subscription date parameters:

```js
assert.equal(request.url, 'transaction-links')
assert.deepEqual(request.params, { page: 1 })
assert.equal(subscriptionRequest.url, 'subscriptions')
assert.equal(subscriptionRequest.params.start, '2026-07-01')
assert.equal(subscriptionRequest.params.end, '2026-08-31')
```

Run: `cd front; node --test tests/repository/BaseRepository.test.js`
Expected: FAIL because the repositories do not exist.

- [ ] **Step 2: Implement the two repositories**

Follow `AccountRepository.js` and `TransactionRepository.js` patterns. Reuse `BaseRepository.getAll()` pagination and axios configuration; do not call `fetch` or `$fetch`.

- [ ] **Step 3: Add failing coherent-snapshot store tests**

Prove that:

- account data comes from the fresh analytics repository response, not stale `accountStore.accountList`;
- a failed fresh account request marks balance-dependent cards unavailable;
- transaction-based cards can still resolve when balance inputs fail;
- `refresh()` refetches all snapshot inputs;
- one init generation cannot combine accounts from one refresh with transactions from another.

Run: `cd front; node --test tests/stores/analyticsStore.test.js`
Expected: FAIL on missing dependencies and snapshot behavior.

- [ ] **Step 4: Implement snapshot loading and generation guards**

Load inputs concurrently, store raw inputs separately, and publish projections only for the latest generation. Preserve card-isolated `loading`, `ready`, and `error` states. Keep excluded transaction filters on the 24-month transaction request.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cd front
node --test tests/repository/BaseRepository.test.js tests/stores/analyticsStore.test.js
npm run lint
cd ..
git diff --check
git status --short
git add front/repository/TransactionLinkRepository.js front/repository/SubscriptionRepository.js front/stores/analyticsStoreFactory.js front/tests/repository/BaseRepository.test.js front/tests/stores/analyticsStore.test.js
git commit -m "feat: load coherent analytics inputs"
```

---

### Task 2: Build the normalized analytics ledger and refund classifier

**Files:**
- Create: `front/utils/AnalyticsLedgerUtils.js`
- Create: `front/tests/utils/AnalyticsLedgerUtils.test.js`
- Modify: `front/package.json`

**Behavior:**
- Normalize every transaction split once with stable transaction/journal/split identity.
- Classify account endpoints as Available, accessible Savings, restricted Savings, Liability, Revenue, Expense, or Unknown from fresh accounts.
- Retain display-currency value, conversion provenance, category, tags, and exact transaction IDs.
- Detect refunds by `#refund` tag or Firefly refund link, dedupe both signals, and associate a linked refund to the purchase journal.
- Keep refund cash timing at receipt date. Put linked coverage in the original purchase month/category; keep tag-only coverage in receipt month.

- [ ] **Step 1: Write failing ledger fixture tests**

Create hand-derived fixtures for:

- expense, income, internal transfer, saving transfer, and liability payment;
- a negative credit-card asset balance that remains Available;
- a linked partial refund received in a later month;
- one refund carrying both a link and tag without double counting;
- tag-only refund with no matched purchase;
- multi-split transaction journal identity;
- missing FX rate returning unavailable metadata rather than zero;
- unclassified account endpoint captured in audit.

Assert both numeric values and exact contributing IDs.

Run: `cd front; node --test tests/utils/AnalyticsLedgerUtils.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement account and split normalization**

Reuse existing currency conversion and account-role helpers where their semantics match. Move only truly shared primitives from `AnalyticsUtils.js`; avoid maintaining two competing classifiers.

- [ ] **Step 3: Implement refund-link indexing**

Index transaction journal IDs to normalized entries and Firefly transaction links to inward/outward journal IDs. Recognize the refund link type by normalized link name/type data, not numeric IDs. Record unmatched refund links in `audit.unmatchedRefundLinkIds`.

- [ ] **Step 4: Implement refund timing and coverage**

Keep each refund entry's receipt `date` and `monthKey` unchanged. Populate `coverageMonthKey` and `coverageCategoryId` from a matched purchase; otherwise use the refund receipt month and its category. Cap linked coverage to the refund's absolute converted value and preserve partial values.

- [ ] **Step 5: Register the test and verify**

Add `tests/utils/AnalyticsLedgerUtils.test.js` to `test:analytics`.

Run:

```powershell
cd front
node --test tests/utils/AnalyticsLedgerUtils.test.js
npm run test:analytics
npm run lint
cd ..
git diff --check
git status --short
git add front/utils/AnalyticsLedgerUtils.js front/tests/utils/AnalyticsLedgerUtils.test.js front/package.json
git commit -m "feat: normalize analytics ledger"
```

---

### Task 3: Reconstruct balances from the fresh account anchor

**Files:**
- Create: `front/utils/AnalyticsBalanceUtils.js`
- Create: `front/tests/utils/AnalyticsBalanceUtils.test.js`
- Modify: `front/package.json`

**Behavior:**
- Anchor today to fresh account `current_balance` values in the selected display currency.
- Rewind ledger entries per account to each completed month end.
- Aggregate net worth, unified/split savings, liabilities-only debt, and total expenses.
- Normalize liability magnitudes per account before summing.
- Emit explicit completed-month zeros when coverage is complete.
- Reconcile reconstructed today against the same fresh anchor/date without using Firefly account-chart date equality.

- [ ] **Step 1: Add failing reconstruction tests**

Fixtures must prove:

- current net worth equals the same fresh Firefly accounts used for reconstruction;
- backward application of an expense, income, transfer, saving deposit/withdrawal, and debt payment;
- internal transfers do not alter net worth;
- credit-card assets affect net worth/Available but never debt;
- accessible/restricted savings split;
- mixed-sign liability accounts normalize individually;
- zero-activity months still appear;
- partial data coverage produces `unavailable` rather than a fabricated zero;
- reconciliation produces one `mismatch` object with account evidence, not repeated strings.

Run: `cd front; node --test tests/utils/AnalyticsBalanceUtils.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement per-account backward reconstruction**

Build signed account deltas from normalized ledger endpoints. Starting at `asOfDate`, subtract transactions after each month end from the fresh anchor. Use display-currency precision for reconciliation tolerance.

- [ ] **Step 3: Implement metric aggregation and coverage**

For each requested metric, aggregate only eligible accounts. Return `null` points when a required account amount or FX conversion is unavailable. Preserve account-level evidence for drill-down/audit.

- [ ] **Step 4: Implement reconciliation**

Compare the reconstructed as-of point and fresh anchor from the same snapshot. Use `ok` when within one minor unit, `mismatch` when both are finite but differ, and `unavailable` otherwise.

- [ ] **Step 5: Verify and commit**

Add the new test to `test:analytics`, then run:

```powershell
cd front
node --test tests/utils/AnalyticsBalanceUtils.test.js
npm run test:analytics
npm run lint
cd ..
git diff --check
git status --short
git add front/utils/AnalyticsBalanceUtils.js front/tests/utils/AnalyticsBalanceUtils.test.js front/package.json
git commit -m "feat: reconstruct analytics balances"
```

---

### Task 4: Wire the shared ledger, balances, FX disclosure, and audit state

**Files:**
- Modify: `front/stores/analyticsStoreFactory.js`
- Modify: `front/stores/analyticsStore.js`
- Modify: `front/tests/stores/analyticsStore.test.js`
- Create: `front/components/analytics/analytics-fx-disclosure.vue`
- Modify: `front/pages/analytics.vue`

**Store outputs:**
- `ledger` is computed once from the coherent raw snapshot.
- `balanceSeriesByMetric` comes from `reconstructBalanceSeries()`.
- `fxDisclosure` is `null` when no conversion is involved; otherwise it reports current-rate conversion and missing currencies once at page level.
- `analyticsAudit` dedupes card warnings by code and affected metrics.
- Each card has independent `status` and `error` metadata.

- [ ] **Step 1: Add failing shared-foundation store tests**

Assert one ledger build feeds all projections, balance series use fresh accounts, refresh invalidates the complete generation, identical reconciliation warnings dedupe, and one broken optional Firefly input does not blank unrelated cards.

Run: `cd front; node --test tests/stores/analyticsStore.test.js`
Expected: FAIL on the new public store contract.

- [ ] **Step 2: Replace legacy parallel projections**

Build the ledger and balances after coherent inputs settle. Keep legacy selectors temporarily only when a later task still uses them, but make them consume the shared ledger rather than raw transactions.

- [ ] **Step 3: Add the conditional FX disclosure**

Render one compact page-level disclosure beneath controls only when `fxDisclosure` is non-null. Remove repeated `FX: Current rate` labels from individual analytics cards as their tasks are migrated.

- [ ] **Step 4: Add card-isolated error presentation**

Provide one concise warning per code with affected metric names. Do not show the obsolete date-verification warning when the fresh-snapshot reconciliation succeeds.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cd front
node --test tests/stores/analyticsStore.test.js
npm run lint
npm run build
cd ..
git diff --check
git status --short
git add front/stores/analyticsStoreFactory.js front/stores/analyticsStore.js front/tests/stores/analyticsStore.test.js front/components/analytics/analytics-fx-disclosure.vue front/pages/analytics.vue
git commit -m "feat: share analytics foundation"
```

---

### Task 5: Rebuild Money flow aggregation with truthful refunds and sequential pools

**Files:**
- Modify: `front/utils/AnalyticsUtils.js`
- Modify: `front/tests/utils/AnalyticsUtils.test.js`
- Modify: `front/utils/AnalyticsCategoryPresentationUtils.js`
- Modify: `front/tests/utils/AnalyticsCategoryPresentationUtils.test.js`

**Behavior:**
- Build money flow only from ledger entries.
- Sort income/refund source categories and expense destination categories by descending absolute amount, then stable ID; `Other` is always last.
- Keep ordinary income and refund receipt as distinct sources with distinct styling metadata.
- Route refund coverage alongside the expense category so the chart shows what portion was refunded without erasing either cash leg.
- Split Savings into accessible and restricted first, then destination accounts.
- Make Available-to-Savings and Savings-to-Available transfers explicit ribbons between different stages.
- Put external shortfall/existing-funds sources on the left when outcomes exceed new income; put savings withdrawal on the left when savings net is negative.

- [ ] **Step 1: Replace legacy flow tests with ledger fixtures**

Add exact tests for:

- amount sorting and deterministic ties;
- Top 5/10/All grouping with `Other` last;
- ordinary art income and art expense remaining separate;
- linked Tech refund shown as refund receipt plus expense coverage;
- tag-only refund coverage in receipt month;
- Available-to-accessible-Savings and Available-to-restricted-Savings thickness;
- Savings-originated expense;
- savings net negative as a left-side source;
- shortfall/existing-funds source when uses exceed sources;
- no ribbon emitted for unclassified nonzero value.

Run: `cd front; node --test tests/utils/AnalyticsUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js`
Expected: FAIL on legacy ordering and routing.

- [ ] **Step 2: Implement sequential flow aggregation**

Produce stable node IDs and explicit stages:

```text
income categories / refund / existing funds / savings withdrawal
  -> Available and accessible/restricted Savings
  -> expense / saving deposited / debt paid / excess
  -> expense categories / savings accounts / liability accounts
```

Do not create an unexplained balancing node. Surface unclassified value in audit.

- [ ] **Step 3: Implement detail grouping**

Group only compatible sibling nodes. Keep refunds separate from ordinary income and accessible savings separate from restricted savings. Preserve the union of contributing transaction IDs on every `Other` node/ribbon.

- [ ] **Step 4: Verify and commit**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsUtils.test.js tests/utils/AnalyticsCategoryPresentationUtils.test.js
npm run test:analytics
npm run lint
cd ..
git diff --check
git status --short
git add front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsUtils.test.js front/utils/AnalyticsCategoryPresentationUtils.js front/tests/utils/AnalyticsCategoryPresentationUtils.test.js
git commit -m "feat: rebuild analytics money flow"
```

---

### Task 6: Improve Money flow layout, interaction, and responsive readability

**Files:**
- Modify: `front/utils/ChartUtils.js`
- Modify: `front/tests/utils/ChartUtils.test.js`
- Modify: `front/components/charts/layered-money-flow-chart.vue`
- Modify: `front/components/analytics/analytics-money-flow.vue`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`

**Behavior:**
- Layout sequential stages instead of co-locating Available and Savings on one axis.
- Ribbon width directly represents transferred amount.
- Outer nodes follow aggregation order; layout must not re-sort them barycentrically.
- Desktop shows all selected layers. Mobile tries selected detail first, then hides income/expense category layers only when label/target constraints fail.
- Hover/tap/focus reveals amount, percent of source and destination, refund coverage, and exact drill-down affordance.

- [ ] **Step 1: Add failing geometry tests**

Prove:

- Available and Savings occupy distinct stages with a measurable transfer span;
- ribbon widths are proportional at both source and destination;
- amount ordering is preserved;
- `Other` remains last;
- labels have at least 28 CSS pixels between baselines;
- interactive targets are at least 44 by 44 CSS pixels;
- mobile condensation retains pools and uses while hiding only outer categories.

Run: `cd front; node --test tests/utils/ChartUtils.test.js`
Expected: FAIL against the current same-axis/barycentric layout.

- [ ] **Step 2: Implement stage-aware layout**

Replace outer-node barycentric reordering with stable input order. Add explicit bridge geometry and collision-aware vertical spacing. Keep calculation pure in `ChartUtils.js`.

- [ ] **Step 3: Update SVG semantics and interactions**

Add non-color refund pattern, accessible/restricted savings patterns, meaningful `aria-label` text, keyboard traversal, pinned details, outside dismiss, and transaction drill-down events. Gate animated ribbon transitions behind `profileStore.showAnimations`.

- [ ] **Step 4: Polish the card and themes**

Reduce excessive corner rounding where flows meet nodes, increase label contrast, keep compact controls, and add matching dark-theme rules. Avoid a separate card-local FX label.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cd front
node --test tests/utils/ChartUtils.test.js
npm run lint
npm run build
cd ..
git diff --check
git status --short
git add front/utils/ChartUtils.js front/tests/utils/ChartUtils.test.js front/components/charts/layered-money-flow-chart.vue front/components/analytics/analytics-money-flow.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css
git commit -m "feat: clarify analytics money flow"
```

---

### Task 7: Add the reusable recurring-pattern detector

**Files:**
- Create: `front/utils/AnalyticsRecurringUtils.js`
- Create: `front/tests/utils/AnalyticsRecurringUtils.test.js`
- Modify: `front/package.json`

**Behavior:**
- Normalize authoritative Pico recurring transactions and Firefly subscriptions into occurrence candidates.
- Infer weekly, biweekly, monthly, and twice-monthly candidates from completed ledger history.
- Require at least 3 occurrences in distinct expected cycles, at least 60% eligible-cycle coverage, stable direction/account/category/payee at least 80%, monthly date median absolute deviation at most 4 days, and relative amount median absolute deviation at most 25%.
- Merge defined and inferred candidates deterministically, with defined candidates authoritative.
- Match actual current-month occurrences so already-paid rent or salary is not projected again.
- Keep the detector independent from chart presentation so a future suggestion/review workflow can reuse it.

- [ ] **Step 1: Write failing detector tests**

Include:

- monthly rent shifted by a weekend;
- twice-monthly salary around the middle and end of month;
- weekly expense with one missed cycle;
- noisy merchant rejected by amount variability;
- inconsistent category/payee rejected;
- only two occurrences rejected;
- defined recurring schedule overriding an inferred candidate;
- already-observed current occurrence matched and suppressed;
- deterministic output for shuffled ledger input.

Run: `cd front; node --test tests/utils/AnalyticsRecurringUtils.test.js`
Expected: FAIL because the detector does not exist.

- [ ] **Step 2: Implement normalization and signatures**

Use stable signatures from direction, account roles/IDs, category, and normalized payee description. Keep authoritative source IDs and inferred evidence transaction IDs.

- [ ] **Step 3: Implement cadence scoring**

Use completed eligible cycles only. Calculate robust medians and median absolute deviations. Return confidence factors and rejection audit without mutating ledger entries.

- [ ] **Step 4: Implement merge and occurrence matching**

Deduplicate candidates by stable signature/cadence overlap. Prefer defined sources, then higher confidence, then stable ID. Match actual occurrences within the cadence's date window and amount tolerance.

- [ ] **Step 5: Verify and commit**

Add the test to `test:analytics` and run:

```powershell
cd front
node --test tests/utils/AnalyticsRecurringUtils.test.js
npm run test:analytics
npm run lint
cd ..
git diff --check
git status --short
git add front/utils/AnalyticsRecurringUtils.js front/tests/utils/AnalyticsRecurringUtils.test.js front/package.json
git commit -m "feat: detect recurring analytics activity"
```

---

### Task 8: Build the remaining-activity and daily forecast engine

**Files:**
- Create: `front/utils/AnalyticsForecastUtils.js`
- Create: `front/tests/utils/AnalyticsForecastUtils.test.js`
- Modify: `front/package.json`

**Behavior:**
- Exclude the unfinished current month from 3/6/12/24-month historical averages.
- Forecast only remaining days after `today`.
- Combine unmatched recurring candidates with non-recurring historical remainder profiles.
- For regular categories such as rent, project an expected current-month occurrence even before it arrives.
- Never forecast final expense/category spending below actual.
- Return final, change from now, actual-to-date, progress, confidence, daily projected entries, and projected-source metadata.

- [ ] **Step 1: Write failing forecast tests**

Cover:

- current partial month excluded from a 6-month average;
- rent normally paid on days 1–2 projected on day 3 when a weekend shifts it;
- rent already paid not duplicated;
- twice-monthly salary with first payment actual and second projected;
- actual expense above average produces final equal to or above actual and `Above historical average`;
- actual and forecast both zero produce `No expected activity`;
- signed savings/debt changes show percent only when actual and forecast share direction and forecast is nonzero;
- future days sum exactly to `remainingFromToday`;
- missing FX inputs remain unavailable;
- projected entries retain candidate/source IDs but never pretend to be actual transaction IDs.

Run: `cd front; node --test tests/utils/AnalyticsForecastUtils.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement historical remainder profiles**

For each completed comparison month, measure activity remaining after the equivalent day-of-month. Use robust average/median selection already fixed by the design. Do not include the current month in that sample.

- [ ] **Step 3: Overlay recurring occurrences**

Insert unmatched defined/inferred occurrences on expected days. Subtract their historical contribution from the generic remainder profile so forecast components do not double count.

- [ ] **Step 4: Implement metric projection rules**

For expense/category metrics, clamp final to at least actual. For signed savings/debt/net-worth changes, retain direction and expose `remainingFromToday`. Clamp displayed progress to 0–100 and return the special presentation states.

- [ ] **Step 5: Verify and commit**

Add the test to `test:analytics` and run:

```powershell
cd front
node --test tests/utils/AnalyticsForecastUtils.test.js
npm run test:analytics
npm run lint
cd ..
git diff --check
git status --short
git add front/utils/AnalyticsForecastUtils.js front/tests/utils/AnalyticsForecastUtils.test.js front/package.json
git commit -m "feat: forecast remaining monthly activity"
```

---

### Task 9: Correct Financial trends and Spending by category

**Files:**
- Modify: `front/stores/analyticsStoreFactory.js`
- Modify: `front/tests/stores/analyticsStore.test.js`
- Modify: `front/components/analytics/analytics-balance-trends.vue`
- Modify: `front/components/analytics/analytics-category-spending.vue`
- Modify: `front/components/analytics/analytics-category-facet.vue`
- Modify: `front/components/analytics/analytics-metric-facet.vue`
- Modify: `front/components/charts/multi-series-line-chart.vue`
- Modify: `front/utils/AnalyticsUtils.js`
- Modify: `front/tests/utils/AnalyticsUtils.test.js`

**Behavior:**
- Balances show completed month ends, Today, and end-of-month Forecast.
- Monthly changes and Spending by category show completed months plus one Forecast point; they omit the misleading partial-today plot point.
- Forecast detail shows final, actual to date, change from now, and actual as percent of forecast/baseline.
- Completed zero months and zero forecast points always render when coverage is complete.
- Every historical/current actual point retains exact transaction IDs; projected portions retain source metadata.
- Crosshair rows and category points are clickable to the corresponding transaction list.
- Remove `Estimated at current rates` full-row copy and per-card FX labels.

- [ ] **Step 1: Add failing presenter/store tests**

Assert:

- total net worth/savings/debt balances match reconstructed series;
- changes derive from adjacent totals;
- total expense change includes completed explicit zero months;
- no current partial point in change/category series;
- all selected metrics receive a dashed forecast segment, including zero;
- average strip uses only completed selected months;
- forecast detail exposes final, actual, remaining, and progress state;
- historical point IDs and current actual IDs are exact.

Run: `cd front; node --test tests/utils/AnalyticsUtils.test.js tests/stores/analyticsStore.test.js`
Expected: FAIL on present partial-point and forecast metadata behavior.

- [ ] **Step 2: Update store projections**

Replace legacy balance-chart date validation and raw transaction calculations with shared reconstructed balances, ledger, and forecast output. Preserve existing persisted period/mode/savings selectors and repair invalid stored values.

- [ ] **Step 3: Update line-chart point selection**

Keep hover/touch vertical crosshair behavior. Emit a row-specific event with `seriesId`, `pointId`, `transactionIds`, and point metadata when a tooltip row is clicked or activated by keyboard.

- [ ] **Step 4: Wire exact drill-down**

Use `TransactionFilterUtils.filters.id.toUrl(ids)` and `RouteConstants.ROUTE_TRANSACTION_LIST`. Disable navigation for a purely projected amount with no actual IDs and clearly label it forecast.

- [ ] **Step 5: Polish the two cards**

Use compact detail rows and consistent dashed forecast styling for every metric/category. Retain visible zero points. Ensure category facets remain usable with many selected categories.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsUtils.test.js tests/stores/analyticsStore.test.js
npm run test:analytics
npm run lint
npm run build
cd ..
git diff --check
git status --short
git add front/stores/analyticsStoreFactory.js front/tests/stores/analyticsStore.test.js front/components/analytics/analytics-balance-trends.vue front/components/analytics/analytics-category-spending.vue front/components/analytics/analytics-category-facet.vue front/components/analytics/analytics-metric-facet.vue front/components/charts/multi-series-line-chart.vue front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsUtils.test.js
git commit -m "feat: correct analytics trend forecasts"
```

---

### Task 10: Add the additive spending and cash-use chart

**Files:**
- Create: `front/utils/AnalyticsCashUseUtils.js`
- Create: `front/tests/utils/AnalyticsCashUseUtils.test.js`
- Create: `front/components/charts/analytics-combination-chart.vue`
- Create: `front/components/analytics/analytics-cash-use.vue`
- Modify: `front/stores/analyticsStoreFactory.js`
- Modify: `front/tests/stores/analyticsStore.test.js`
- Modify: `front/package.json`

**Behavior:**
- `Spending` mode stacks expense categories as additive areas.
- `Full cash use` mode may additionally stack saving transfers and debt payments.
- Income is a distinct top reference line.
- The band between total uses and income is `Excess` when positive and `Shortfall` when negative.
- Category selection, Top 5/10/All, savings Unified/Split, completed months, and forecast semantics match the rest of the page.
- Crosshair rows retain exact actual transaction sets.

- [ ] **Step 1: Write failing cash-use tests**

Cover:

- category areas add exactly to total spending;
- refunds remain truthful and coverage is visibly attributed without erasing expense;
- savings and debt are absent from `spending` and present in `full`;
- credit-card activity is not debt;
- accessible/restricted savings split;
- excess and shortfall signs around income;
- zero-activity month;
- current forecast actual/projected split;
- exact IDs per layer/month.

Run: `cd front; node --test tests/utils/AnalyticsCashUseUtils.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the pure presenter**

Return ordered additive layers with cumulative bottoms/tops, income line points, excess/shortfall band, patterns, labels, actual IDs, and projected sources. Reuse category/detail grouping rather than reimplementing it.

- [ ] **Step 3: Add the shared combination chart**

Implement a focused SVG primitive supporting stacked areas, bars, a line, forecast patterns, one shared vertical crosshair, touch pinning, keyboard navigation, outside dismissal, and row-specific selection. Keep it presentation-only.

- [ ] **Step 4: Build the card and store selector**

Add Spending/Full cash-use control, category facet, detail selector, empty/error/loading states, and transaction drill-down. Use existing analytics controls and Vant patterns.

- [ ] **Step 5: Verify and commit**

Add the test to `test:analytics` and run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js tests/stores/analyticsStore.test.js
npm run test:analytics
npm run lint
npm run build
cd ..
git diff --check
git status --short
git add front/utils/AnalyticsCashUseUtils.js front/tests/utils/AnalyticsCashUseUtils.test.js front/components/charts/analytics-combination-chart.vue front/components/analytics/analytics-cash-use.vue front/stores/analyticsStoreFactory.js front/tests/stores/analyticsStore.test.js front/package.json
git commit -m "feat: add analytics cash use chart"
```

---

### Task 11: Add the daily current-month forecast chart

**Files:**
- Create: `front/components/analytics/analytics-daily-forecast.vue`
- Modify: `front/components/charts/analytics-combination-chart.vue`
- Modify: `front/stores/analyticsStoreFactory.js`
- Modify: `front/tests/stores/analyticsStore.test.js`

**Behavior:**
- Show actual and forecast income/outflow bars for every day of the current month.
- Overlay a cumulative Available-cash-change line.
- Distinguish actual days, today, recurring projections, and non-recurring projections.
- Surface expected rent/salary timing and confidence/source detail.
- Selecting an actual bar/row opens exact transactions; projected rows show source evidence without navigating to nonexistent transactions.

- [ ] **Step 1: Add failing daily-series store tests**

Assert:

- every calendar day is present;
- actual entries stop at today;
- projected entries begin after today;
- already matched recurring activity is absent from future days;
- daily values sum to monthly forecast totals;
- cumulative Available line equals prior value plus income minus Available-funded outflow and transfers;
- actual IDs and forecast source IDs remain distinct.

Run: `cd front; node --test tests/stores/analyticsStore.test.js`
Expected: FAIL because no daily card projection exists.

- [ ] **Step 2: Add daily presenter output to the store**

Expose calendar labels, actual/projected bars, cumulative line, today index, confidence, source evidence, and card-isolated unavailable state.

- [ ] **Step 3: Extend the combination chart only as needed**

Add grouped/overlaid positive and negative bars while preserving the Task 10 area/line API. Do not fork a second interaction implementation.

- [ ] **Step 4: Build the daily card**

Use a compact legend, current-month title, tooltip/source rows, and mobile horizontal density that remains touchable. Respect theme and reduced-animation settings.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cd front
node --test tests/stores/analyticsStore.test.js
npm run test:analytics
npm run lint
npm run build
cd ..
git diff --check
git status --short
git add front/components/analytics/analytics-daily-forecast.vue front/components/charts/analytics-combination-chart.vue front/stores/analyticsStoreFactory.js front/tests/stores/analyticsStore.test.js
git commit -m "feat: add daily analytics forecast"
```

---

### Task 12: Integrate page UX, styling, localization, and regression proof

**Files:**
- Modify: `front/pages/analytics.vue`
- Modify: `front/components/analytics/analytics-page-switch.vue`
- Modify: `front/components/analytics/analytics-savings-view-control.vue`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: `front/assets/styles/variables.css`
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
- Modify: `front/package.json`

**Behavior:**
- Present a coherent order: Financial trends, Spending by category, Money flow, Daily forecast, Additive cash use.
- Keep controls near the chart they affect; share savings view where semantics are identical.
- Preserve desktop sidebar/mobile tab navigation and the existing Analytics icon.
- Loading and errors stay within affected cards; no duplicate global red messages.
- Improve readability with compact radii, semantic spacing, clear forecasts, and no full-row low-value labels.
- Both themes use non-color distinctions and meet mobile touch requirements.

- [ ] **Step 1: Integrate the final page structure**

Mount the two new cards, conditional FX disclosure, and card-level warnings. Preserve existing route and analytics page switch behavior. Avoid duplicating the same savings or detail control unnecessarily.

- [ ] **Step 2: Add all localized labels**

Add labels for:

- refund and refund coverage;
- accessible/restricted savings;
- actual, forecast, remaining, progress, above average, and no expected activity;
- daily income/outflow/Available change;
- recurring-defined, recurring-inferred, and historical remainder;
- Spending and Full cash use;
- Excess and Shortfall;
- page-level FX disclosure and unavailable states.

Use English text as the fallback translation in locales where no reviewed translation is available, but keep every JSON file structurally complete and valid.

- [ ] **Step 3: Finish responsive and theme styling**

Test narrow mobile and desktop layouts. Keep labels readable, controls wrappable, touch targets at least 44 pixels, chart cards 6–10px rounded, and dark surfaces explicitly overridden. Do not add scoped component styles.

- [ ] **Step 4: Run automated verification**

Run:

```powershell
cd front
npm run test:analytics
npm run lint
npm run build
Get-ChildItem i18n\locales\*.json | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json | Out-Null }
cd ..
git diff --check
git status --short
```

Expected:

- all analytics tests pass;
- lint exits zero;
- Nuxt production build exits zero;
- every locale parses;
- no whitespace errors;
- only V3 task files are changed.

- [ ] **Step 5: Run browser verification**

Start the existing local runtime without changing deployment configuration. Inspect the real `/analytics` page in Chrome at desktop and mobile widths, light and dark themes.

Verify:

- Firefly current net worth matches the fresh account snapshot;
- credit cards never appear as debt;
- completed zero months and forecast segments render;
- today is absent from change/category lines but present in balances;
- forecast details show final, actual, remaining, and progress;
- rent-like pending activity appears in daily/category forecasts;
- crosshair rows open exact transaction lists;
- money-flow sorting, refund styling, Available-to-Savings thickness, savings split, and mobile condensation;
- additive layers reconcile to totals and show excess/shortfall;
- only one conditional FX disclosure appears;
- one card failure does not blank other cards;
- no console errors.

Capture screenshots for desktop light, desktop dark, mobile light, and mobile dark in an ignored local inspection directory. Do not commit screenshots containing personal financial data.

- [ ] **Step 6: Run focused code review**

Review the final diff for:

- transaction/refund double counting;
- account-role mistakes;
- current-month leakage into historical averages;
- defined/inferred recurring duplication;
- forecast values below actual;
- missing zero points;
- IDs lost through `Other` grouping;
- stale snapshot races;
- unavailable values coerced to zero;
- accessibility regressions;
- unrelated changes or secrets.

Fix any finding with a focused failing test before changing calculation code, then rerun Step 4.

- [ ] **Step 7: Commit integration**

Run:

```powershell
git diff --check
git status --short
git add front/pages/analytics.vue front/components/analytics/analytics-page-switch.vue front/components/analytics/analytics-savings-view-control.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/assets/styles/variables.css front/i18n/locales/de-DE.json front/i18n/locales/en.json front/i18n/locales/es-MX.json front/i18n/locales/fr.json front/i18n/locales/it.json front/i18n/locales/ko.json front/i18n/locales/pl.json front/i18n/locales/pt-BR.json front/i18n/locales/ro.json front/i18n/locales/ru-RU.json front/i18n/locales/zh-CN.json front/package.json
git commit -m "feat: complete extended analytics v3"
```

---

## Final Verification and Handoff

- [ ] Confirm `git status --short` is clean or contains only pre-existing unrelated user changes.
- [ ] Run `git log --oneline --decorate -15` and confirm every task is a focused local commit on `personal/extended-analytics`.
- [ ] Record exact verification commands and results, including any browser/runtime limitation as `NOT RUN` rather than inferring success.
- [ ] Summarize the accounting rules now enforced: fresh-anchor balances, liabilities-only debt, split savings, truthful refunds, completed-history averages, recurring-aware remainder, zero points, and drill-down provenance.
- [ ] Do not push, open a PR, or merge without separate user authorization.

## Primary References

- Approved design: `docs/superpowers/specs/2026-08-03-extended-analytics-v3-design.md`
- Existing owner context: `docs/local/firefly-ux-analytics-handoff.md`
- Firefly III transaction links: `https://raw.githubusercontent.com/firefly-iii/api-docs/main/src/v1/paths/models/link.yaml`
- Firefly III transaction-link schema: `https://raw.githubusercontent.com/firefly-iii/api-docs/main/src/v1/schemas/models/TransactionLink/TransactionLink.yaml`
- Firefly III subscriptions: `https://raw.githubusercontent.com/firefly-iii/api-docs/main/src/v1/paths/models/subscription.yaml`
- Firefly III subscription properties: `https://raw.githubusercontent.com/firefly-iii/api-docs/main/src/v1/schemas/models/Bill/BillProperties.yaml`
