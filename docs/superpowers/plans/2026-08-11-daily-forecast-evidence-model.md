# Daily Forecast Evidence Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Daily Forecast's duplicate paid obligations and random dated historical remainder with exact fulfilled occurrences, recurring event bundles, current-regime payroll, bounded budget/history envelopes, and an explainable daily chart.

**Architecture:** Preserve the existing pure `AnalyticsRecurringUtils` and `AnalyticsForecastUtils` boundaries. First make authoritative occurrence construction and fulfillment correct, then add a pure bundle/envelope layer that emits dated events separately from undated variable envelopes. The analytics store adapts those outputs to the existing two-bar plus Available-line chart contract; the card adds envelope and bundle evidence without changing Firefly data.

**Tech Stack:** Vue 3, Pinia 3 composition stores, Nuxt 3 SPA, Node `node:test`, date-fns, existing analytics utilities and combination chart, Vant/i18n, standalone Docker Compose, authenticated Chromium verification.

## Global Constraints

- Plain JavaScript and Vue `<script setup>` only; no TypeScript, JSDoc types, dependency additions, backend routes, migrations, or Firefly mutations.
- Prettier is authoritative: single quotes, no semicolons, trailing commas, 2-space indentation, print width 200.
- The full hybrid policy and Daily Forecast UX are personal-fork scope; reusable pure correctness primitives may later be promoted separately.
- Exact actual transaction IDs remain the only navigable evidence. Source, candidate, expected, and projected evidence IDs stay separate and non-navigable.
- `paid_dates` are evidence only; `pay_dates` and `next_expected_match` are schedule inputs only.
- Exact linked paid transaction-group IDs outrank fuzzy identity/date matching and must fulfill multi-split groups.
- A current-cycle fulfillment suppresses every later configured occurrence for that same subscription cycle.
- A weekend nominal semimonthly payroll date moves to the preceding business day unless authoritative evidence says otherwise.
- Two latest equivalent payroll bundles with the same signature, currency-precise amounts, and at least 2% difference from the older median define the new current regime; linked deductions use that regime.
- Budgets never invent dated transactions. Reset budgets may supply monthly targets; rollover/adjusted budgets remain plan-only; known events are removed before variable history is measured.
- Only high- or medium-confidence events receive exact chart dates. Variable activity remains an undated envelope/band and cannot expose transaction navigation.
- One unresolved expense event cannot make income or unrelated event days unavailable.
- Canonicalized equivalent input must produce byte-identical output.
- Use strict RED/GREEN TDD for each task, commit each task separately, and preserve unrelated workspace changes.
- Final proof includes focused suites, `npm run test:analytics`, scoped ESLint/Prettier, `npm run build`, `git diff --check`, contribution preflight, standalone `docker-compose -f docker-compose.pico.local.yml build firefly-pico`, and authenticated built-image desktop/mobile light/dark verification.
- Do not push, publish, open a PR, change GitHub identity, or modify Firefly transactions, bills, budgets, accounts, settings, or credentials.

---

### Task 1: Authoritative paid occurrence correctness

**Files:**
- Modify: `front/utils/AnalyticsRecurringUtils.js:456-698,861-980`
- Test: `front/tests/utils/AnalyticsRecurringUtils.test.js`

**Interfaces:**
- Consumes: Firefly recurring/subscription JSON:API entities, analytics ledger entries, current date.
- Produces: unchanged public APIs `buildDefinedOccurrences({ recurringTransactions, subscriptions, startDate, endDate })`, `enrichRecurringCandidatesFromEvidence({ candidates, entries })`, and `matchRecurringOccurrences({ candidates, actualEntries, today })`.
- Candidate evidence must expose paid transaction-group IDs and paid dates separately from `expectedDates`.

- [ ] **Step 1: Write RED tests for schedule/evidence separation**

Add tests that construct a monthly subscription with:

```js
attributes: {
  active: true,
  name: 'Rent',
  repeat_freq: 'monthly',
  amount_min: '2321',
  amount_max: '2321',
  amount_avg: '2321',
  pay_dates: ['2026-09-02T00:00:00-04:00'],
  paid_dates: [{ date: '2026-08-03T00:00:00-04:00', transaction_group_id: 'paid-rent', amount: '2321' }],
}
```

Assert the candidate has no August `expectedDates`, retains `paid-rent` and `2026-08-03` in evidence, and schedules September 2 only. Add an early-payment case whose `pay_dates` still includes August 25 and assert current-cycle matching produces no remaining occurrence.

- [ ] **Step 2: Write RED tests for exact multi-split fulfillment**

Create two current ledger entries with the same `transactionId: 'paid-rent-water'`: rent and water, different destination/category identities. The rent subscription candidate evidence contains `paid-rent-water`. Assert it is fulfilled even if enrichment cannot derive one unique destination/category and even if the fuzzy date/payee identity would fail. Assert the exact actual entry IDs and one actual transaction ID are audited.

- [ ] **Step 3: Run the focused RED gate**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsRecurringUtils.test.js
```

Expected: only the new schedule separation, early-payment suppression, and exact multi-split fulfillment assertions fail.

- [ ] **Step 4: Implement minimal paid-evidence and cycle fulfillment semantics**

Split the existing merged helper into schedule and evidence helpers. Construct `expectedDates` from `pay_dates`/`next_expected_match`; construct evidence from `paid_dates`. Before fuzzy matching, derive current-cycle linked entries from `candidate.evidence.transactionIds`. Treat any linked current-cycle transaction as fulfillment, select matching split entry IDs when possible, and retain the linked transaction ID even when several splits prevent unique identity enrichment. Suppress a current-month expected date when current-cycle paid evidence exists.

- [ ] **Step 5: Run GREEN and mutation proof**

Run the focused test. Then temporarily restore paid dates into expected dates and verify the schedule test fails; restore the fix. Temporarily remove linked-ID precedence and verify the multi-split test fails; restore the fix. Re-run GREEN.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- front/utils/AnalyticsRecurringUtils.js front/tests/utils/AnalyticsRecurringUtils.test.js
git diff --cached --check
git commit -m "fix: honor paid recurring evidence"
```

---

### Task 2: Recurring bundles and current payroll regime

**Files:**
- Modify: `front/utils/AnalyticsForecastUtils.js:500-1156`
- Test: `front/tests/utils/AnalyticsForecastUtils.test.js`

**Interfaces:**
- Consumes: completed ledger entries, merged candidates, account contexts, today/end date, currency precision.
- Produces: `dailyProjectedEntries` containing one dated event with expandable component entries; audit adds `bundles` with signature, occurrence dates, selected-regime transaction IDs, component evidence IDs, confidence, and schedule policy.
- `sourceKind` values remain compatible with current consumers. Bundle components may use `bundleId`, `bundleComponentId`, and `bundleLabel` while preserving existing `flowAmounts`.

- [ ] **Step 1: Write RED tests for semimonthly payroll bundles**

Add a fixture with three completed months. Each month has transaction groups on the 15th (or previous business day) and month end. Each group includes salary income, taxes, insurance, debt repayment, savings transfers, employer contribution, and internal transfers. June uses an older salary regime; both July occurrences use a new salary and identical linked deductions.

For an August 11 forecast, assert:

- event dates are August 14 and August 31;
- gross salary uses the newest stable regime on both dates;
- July tax/deduction values remain attached to each occurrence;
- the month-end reimbursement appears only in the month-end bundle when supported by three month-end observations;
- internal available-to-available transfers remain evidence/reconciliation only;
- components reconcile exactly to income, expenses, debt, savings, and Available change;
- no payroll component appears as `sourceKind: 'variable'` on any other date.

- [ ] **Step 2: Write RED tests for regime fallback and determinism**

Assert that one changed occurrence is insufficient to replace the old regime, causing a recency-weighted median and medium confidence. Assert two latest equivalent occurrences whose component values agree and differ by at least 2% select the new regime. Reverse groups, entries, and candidates and assert byte-identical output/audit.

- [ ] **Step 3: Run the focused RED gate**

```powershell
cd front
node --test tests/utils/AnalyticsForecastUtils.test.js
```

Expected: new bundle/regime assertions fail while existing recurring and metric tests remain executable.

- [ ] **Step 4: Implement bundle discovery and projection**

Canonicalize completed entries by transaction ID and local date. Discover bundles only when a stable multi-component signature repeats across at least three occurrences and two completed months. Derive semimonthly phase from middle/month-end occurrence clusters, schedule the next local dates, and apply the preceding-business-day rule. Select the new regime exactly as defined in Global Constraints. Emit component projected entries on the bundle date and suppress their evidence from variable grouping.

- [ ] **Step 5: Reconcile and audit bundle flows**

Aggregate component `flowAmounts` using current `classifyForecastFlowAmounts` semantics. Store actual transaction IDs only in historical audit; projected entries carry candidate/source/evidence IDs, not navigable transaction IDs. Include schedule and regime reasons in confidence/audit.

- [ ] **Step 6: Run GREEN and mutation proof**

Run focused tests. Mutate the preceding-business-day rule to keep Saturday and verify the date test fails. Mutate regime selection to average all months and verify the new-regime amount test fails. Mutate bundle suppression and verify the no-random-payroll assertion fails. Restore and re-run GREEN.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- front/utils/AnalyticsForecastUtils.js front/tests/utils/AnalyticsForecastUtils.test.js
git diff --cached --check
git commit -m "feat: forecast recurring activity bundles"
```

---

### Task 3: Known-event amounts, seasonal evidence, and variable envelopes

**Files:**
- Modify: `front/utils/AnalyticsForecastUtils.js`
- Modify: `front/stores/analyticsStore.js`
- Modify: `front/stores/analyticsStoreFactory.js:381-705,1024-1033`
- Test: `front/tests/utils/AnalyticsForecastUtils.test.js`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Consumes: active budget entities from `budgetStore`, ledger budget IDs, authoritative definitions, recurring bundle evidence, and 3/6/12-month history selection.
- Produces: forecast `variableEnvelopes[]` with `{ id, budgetId, categoryId, actual, known, historical, plan, expected, remaining, confidence, evidenceIds }`; `dailyProjectedEntries` contains dated known events only.
- Store dependency adds `budgetStore`; factory passes a normalized pure `budgetPlans` array into `buildRemainingActivityForecast`.

- [ ] **Step 1: Write RED tests for robust known-event amounts**

Add linked history fixtures for a variable utility with a broad authoritative min/max range. Assert projected amount uses the recent median constrained by the envelope rather than `(min + max) / 2`. Add a yearly subscription with one prior-year linked occurrence and assert exactly one current-year event with source/candidate/evidence audit. Add an aggregate monthly tax definition plus an already inferred payroll tax bundle and assert the aggregate definition is reconciliation-only and does not duplicate the component taxes.

- [ ] **Step 2: Write RED tests for budget/history envelopes**

Pass normalized plans:

```js
[
  { id: 'groceries', type: 'reset', period: 'monthly', amount: 1100 },
  { id: 'travel', type: 'adjusted', period: 'monthly', amount: 200 },
]
```

Use completed months containing known recurring expenses plus variable grocery history and one isolated travel outlier. Assert:

- known recurring evidence is removed before historical variable totals;
- grocery history uses a robust median and reports the reset plan as comparison evidence;
- adjusted/rollover balances never become expected spend;
- an isolated one-month outlier does not create a dated event or inflate the envelope;
- `dailyProjectedEntries` has no `sourceKind: 'variable'` entries;
- total envelope remaining reconciles monthly forecast totals but is non-navigable.

- [ ] **Step 3: Write RED store tests for budget dependency and isolation**

Extend the real store dependency fixture with `budgetStore.budgetList`. Assert active normalized reset plans reach the forecast, inactive/corrupt/adjusted plans do not become expected spending, and other analytics selectors remain byte-equivalent when only budget plans change.

- [ ] **Step 4: Run RED gates**

```powershell
cd front
node --test tests/utils/AnalyticsForecastUtils.test.js tests/stores/analyticsStore.test.js
```

Expected: only the new robust amount, yearly, aggregate suppression, envelope, and store dependency assertions fail.

- [ ] **Step 5: Implement normalized budget plans**

Inject `useBudgetStore()` in `front/stores/analyticsStore.js`. In the factory, normalize active entity attributes through JSON:API paths into pure `{ id, type, period, amount }` records. Accept only finite positive amounts and recognized reset/rollover/adjusted codes. Pass plans to forecast construction without making the utility depend on Pinia or Vue.

- [ ] **Step 6: Implement known-event amount and envelope reconciliation**

For authoritative variable amounts, prefer robust linked evidence, then explicit authoritative value, then min/max midpoint only when no linked evidence exists. Add yearly corroboration. Build variable totals after excluding fulfilled/projected candidate evidence and bundle evidence. Use the median of comparable completed months; use a reset plan only when history is insufficient. Return the envelope separately and remove exact-day distribution of variable groups.

- [ ] **Step 7: Run GREEN and mutation proof**

Run both focused suites. Mutate robust median to midpoint and verify the utility test fails. Treat adjusted plan as expected and verify the plan-only assertion fails. Re-enable variable daily distribution and verify the no-variable-day assertion fails. Restore and rerun GREEN.

- [ ] **Step 8: Commit Task 3**

```powershell
git add -- front/utils/AnalyticsForecastUtils.js front/stores/analyticsStore.js front/stores/analyticsStoreFactory.js front/tests/utils/AnalyticsForecastUtils.test.js front/tests/stores/analyticsStore.test.js
git diff --cached --check
git commit -m "feat: add forecast budget envelopes"
```

---

### Task 4: Daily projection and typed availability

**Files:**
- Modify: `front/stores/analyticsStoreFactory.js:30-377,1024-1074`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Consumes: forecast dated events, `variableEnvelopes`, typed metric status, candidates, and actual ledger.
- Produces: existing `dailyForecast` date/day/bar/Available-line contract plus `variableEnvelope`, `eventSummaries`, and typed audit fields; existing Cash Use and financial/category consumers stay compatible.

- [ ] **Step 1: Write RED projection tests**

Assert a fixture with actual activity, two payroll events, a known bill, and a variable envelope produces:

- exactly two bar groups: `inflow` and `outflow`;
- event bars only on exact event dates;
- no bar or detail row for the undated variable envelope;
- cumulative Available line equals actual plus dated-event net change;
- monthly summary exposes the variable envelope separately from event uses;
- event detail carries bundle/component labels, confidence, source/candidate/evidence IDs, and no projected transaction IDs.

- [ ] **Step 2: Write RED typed-unavailability tests**

Create an unresolved expense event on one date plus a valid income bundle on another. Assert income and its bar remain ready; only the affected expense day/use value is null; later defensible unrelated bars remain finite; the whole card is partial, not blocking. Preserve exact Firefly transaction IDs separately from entry/candidate evidence.

- [ ] **Step 3: Run RED**

```powershell
cd front
node --test tests/stores/analyticsStore.test.js
```

- [ ] **Step 4: Adapt daily projection**

Keep the existing two-bar chart API. Build daily buckets from actual entries and dated forecast entries only. Add envelope summary/audit without assigning it a date. Ensure reconciliation compares actual plus dated known events plus undated envelope at the monthly level while the Available line remains an event-path projection and labels the envelope exclusion.

- [ ] **Step 5: Isolate availability**

Use event date, flow direction, source kind, and affected metric IDs to null only the unknown component/day. `dailyForecastState.isBlockingUnavailable` remains true only when no defensible chart data exists, unclassified actual evidence blocks reconciliation, or monthly reconciliation mismatches.

- [ ] **Step 6: Run GREEN and mutation proof**

Run the store suite. Mutate envelope projection back into a dated entry and verify the no-envelope-bar test fails. Promote expense unavailability globally and verify the valid-income test fails. Restore and rerun GREEN.

- [ ] **Step 7: Commit Task 4**

```powershell
git add -- front/stores/analyticsStoreFactory.js front/tests/stores/analyticsStore.test.js
git diff --cached --check
git commit -m "fix: project defensible daily forecast events"
```

---

### Task 5: Explainable Daily Forecast card and chart

**Files:**
- Modify: `front/components/analytics/analytics-daily-forecast.vue`
- Modify: `front/components/charts/analytics-combination-chart.vue` only if an existing source-band path cannot render the envelope honestly
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: all JSON files under `front/i18n/locales/`
- Test: `front/tests/stores/analyticsStore.test.js`
- Test: `front/tests/utils/ChartUtils.test.js` only if chart geometry changes

**Interfaces:**
- Consumes: `dailyForecast.barGroups`, `availableLine`, `eventSummaries`, `variableEnvelope`, typed card state, and existing exact-ID selection payloads.
- Produces: a readable two-bar/Available-line chart, envelope disclosure, expandable event details, retry/audit messages, and unchanged transaction-list navigation for actual IDs.

- [ ] **Step 1: Write rendered contract RED tests**

Use the existing real-SFC render/source-contract harness to assert:

- one visible inflow legend, one outflow legend, Available line, and variable-envelope label;
- payroll event details show gross inflow, taxes, insurance, debt, savings, and Available change;
- envelope details show expected range/plan/history and explicitly say they are not dated transactions;
- zero/materially empty component rows are absent;
- projected evidence is labelled non-navigable; actual transaction IDs still create the exact transaction filter route;
- retry remains reachable for source errors and partial event evidence.

- [ ] **Step 2: Add locale keys in all locale files**

Add nonempty native strings under `analytics.daily_forecast` for bundle details, gross inflow, taxes, insurance, debt, savings, variable envelope, expected range, plan, history, undated estimate, confidence, and event/evidence explanations. Parse all locale JSON files.

- [ ] **Step 3: Run RED**

```powershell
cd front
node --test tests/stores/analyticsStore.test.js tests/utils/ChartUtils.test.js
```

- [ ] **Step 4: Implement the minimal card/chart presentation**

Reuse the existing combination chart's bar groups and Available line. Render the envelope as a card disclosure first; add a chart source-band only if it can communicate a range without implying exact transactions. Keep event details compact and expandable. Do not add a second forecasting control or new dependency. Add responsive CSS using existing analytics surfaces, 44px targets, bounded intrinsic chart width, and dark overrides.

- [ ] **Step 5: Run GREEN and interaction mutation proof**

Run focused tests. Remove the non-navigable qualifier and verify its contract fails. Reintroduce a zero component and verify the material-row assertion fails. Remove exact actual-ID routing and verify the drilldown assertion fails. Restore and rerun GREEN.

- [ ] **Step 6: Run broad automated gates**

```powershell
cd front
node --test tests/utils/AnalyticsRecurringUtils.test.js tests/utils/AnalyticsForecastUtils.test.js tests/stores/analyticsStore.test.js tests/utils/ChartUtils.test.js
npm run test:analytics
npx eslint utils/AnalyticsRecurringUtils.js utils/AnalyticsForecastUtils.js stores/analyticsStore.js stores/analyticsStoreFactory.js components/analytics/analytics-daily-forecast.vue components/charts/analytics-combination-chart.vue tests/utils/AnalyticsRecurringUtils.test.js tests/utils/AnalyticsForecastUtils.test.js tests/stores/analyticsStore.test.js tests/utils/ChartUtils.test.js --max-warnings 0
npx prettier --check utils/AnalyticsRecurringUtils.js utils/AnalyticsForecastUtils.js stores/analyticsStore.js stores/analyticsStoreFactory.js components/analytics/analytics-daily-forecast.vue components/charts/analytics-combination-chart.vue tests/utils/AnalyticsRecurringUtils.test.js tests/utils/AnalyticsForecastUtils.test.js tests/stores/analyticsStore.test.js tests/utils/ChartUtils.test.js i18n/locales/*.json
npm run build
```

Expected: all exit 0. If whole-file theme CSS Prettier is already red at Task 5 base, prove that baseline separately and require the newly added CSS block to match isolated Prettier output.

- [ ] **Step 7: Commit Task 5**

```powershell
git add -- front/components/analytics/analytics-daily-forecast.vue front/components/charts/analytics-combination-chart.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests/stores/analyticsStore.test.js front/tests/utils/ChartUtils.test.js
git diff --cached --check
git commit -m "feat: explain daily forecast evidence"
```

---

### Task 6: Whole-feature verification and real-data acceptance

**Files:**
- Create ignored evidence/report files only under `.superpowers/sdd/2026-08-11-daily-forecast-evidence-model/`
- Modify tracked files only if a verified feature defect receives a RED regression first

**Interfaces:**
- Consumes: complete branch changes, local ignored Compose configuration, authenticated preview volume/session, current read-only Firefly data.
- Produces: verification report with PASS/FAIL/NOT RUN boundaries and screenshots containing no sensitive identifiers.

- [ ] **Step 1: Run whole-range static and contribution gates**

From the repository root:

```powershell
git status --short
git diff --check 54d0dff..HEAD
pwsh -NoProfile -File .agents/skills/firefly-pico-oss-contribution/scripts/contribution-preflight.ps1
```

Confirm the range contains only approved frontend, test, locale, theme, spec, and plan paths; no secrets, private Compose files, dependencies, backend, or runtime data.

- [ ] **Step 2: Build the exact standalone Docker image**

```powershell
docker-compose -f docker-compose.pico.local.yml build firefly-pico
```

Record image ID and build warnings. Do not start, replace, or remove any container until the existing preview container, named volume, environment-key names, network, port, and rollback image have been inspected without printing secret values.

- [ ] **Step 3: Replace only the disposable preview container**

Preserve the existing named data volume and authenticated session. Replace only the known analytics preview container with the newly built image. Keep the previous container/image as rollback until HTTP 200 and authenticated Analytics load succeed. Do not touch any other container or volume.

- [ ] **Step 4: Verify real-data occurrence acceptance in authenticated Chrome**

Read-only checks against the built image:

- the current-cycle paid rent/water transaction group is not projected again;
- two salary events use the current payroll regime on the middle and month-end business dates;
- linked tax/deduction components match the current regime and appear only on payroll dates;
- paid internet, early-paid subscription, and other fulfilled bills show zero remaining;
- authoritative yearly subscriptions appear once;
- variable spending appears as an undated envelope and there are no random daily historical-remainder incomes/uses;
- unavailable expense evidence does not hide defensible income events.

Do not display or capture raw account IDs, salary evidence IDs, credentials, or exact private graph details in screenshots/report.

- [ ] **Step 5: Verify layout and interaction matrix**

Desktop and 390x844 mobile, light and dark:

- fully loaded card, readable chart and envelope;
- no page/control overflow;
- interactive targets at least 44px;
- pointer and keyboard day selection;
- payroll bundle expansion;
- exact actual transaction navigation and projected-only non-navigation;
- retry reachable where a source error can be safely simulated by tests; live source failure may remain NOT RUN;
- zero new console errors/warnings after a clean reload.

- [ ] **Step 6: Fix verified defects through RED/GREEN only**

For every browser or Docker defect, add the narrowest executable failing test before changing production. Re-run affected focused tests, full analytics, build, Docker image, and the failed browser state. Do not add unrequested controls or mutate Firefly data to manufacture a state.

- [ ] **Step 7: Final independent review and report**

Generate a whole-range review package from `54d0dff` to `HEAD`. Request an independent senior review against the design, this plan, and the verification report. One fix wave is allowed for confirmed P0/P1/P2 findings, followed by one scoped re-review. Record residual proof boundaries honestly.

- [ ] **Step 8: Final commit only if Task 6 produced tracked fixes**

If no tracked fix was needed, do not create an empty commit. If fixes were needed:

```powershell
git add -- <exact approved fix paths>
git diff --cached --check
git commit -m "fix: complete daily forecast verification"
```

No push, PR, publication, or Firefly mutation is authorized.
