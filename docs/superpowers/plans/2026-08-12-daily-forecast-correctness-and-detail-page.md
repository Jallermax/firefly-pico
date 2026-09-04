# Daily Forecast Correctness and Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicated payroll obligations, restore savings and net-worth forecast reconciliation, and move detailed Daily Forecast evidence from the common Analytics card to a dedicated page.

**Architecture:** Forecast utilities remain responsible for evidence-based projection and suppression. The analytics store exposes normalized monthly-impact data, while a compact card and a dedicated page compose shared forecast overview and detail components without recomputing finance semantics in Vue.

**Tech Stack:** Nuxt 3 SPA, Vue 3 `<script setup>`, Pinia 3, Vant 4, plain JavaScript, Node test runner, CSS theme files, JSON i18n, standalone Docker Compose, authenticated Chrome verification.

## Global Constraints

- Personal-fork scope; do not push, publish, open a PR, or mutate Firefly data.
- No backend, migration, dependency, lockfile, authentication, or proxy changes.
- Do not hardcode private account names, transaction IDs, salary, tax, or savings amounts in production, tracked tests, or tracked documentation.
- Aggregate suppression is evidence-based; labels, categories, values, or a shared transaction group alone are insufficient.
- Preserve `net_worth_change = amount_to_included_destination - amount_from_included_source`.
- Forecast provenance and account role remain separate fields.
- Projected evidence is explanatory and non-navigable; only actual Firefly transaction IDs navigate.
- Add new labels to every tracked locale and parse all locale JSON before completion.
- Use existing UI-kit, toolbar, route, store, and transaction-filter patterns.
- Mobile/desktop and light/dark controls must remain readable, at least 44px, and free of horizontal page overflow.
- Keep private live acceptance values in ignored evidence only.

---

## File Structure

### Forecast correctness

- Modify `front/utils/AnalyticsForecastUtils.js`: classify evidence-covered aggregate bundle candidates as reconciliation-only and emit deterministic audit records.
- Modify `front/tests/utils/AnalyticsForecastUtils.test.js`: production-shaped aggregate, independent-obligation, determinism, and reconciliation regressions.

### Store projection and impact

- Modify `front/stores/analyticsStoreFactory.js`: repair split savings account-role lookup, expose monthly impact, and preserve event-level flow reconciliation.
- Modify `front/tests/stores/analyticsStore.test.js`: split savings, payroll impact, compact/full presentation data, and route behavior tests.

### Routes and components

- Delete `front/pages/analytics.vue` after reproducing its contents in `front/pages/analytics/index.vue`.
- Create `front/pages/analytics/index.vue`: unchanged common Analytics route.
- Create `front/pages/analytics/daily-forecast.vue`: dedicated full forecast route, query selection, toolbar, and initialization.
- Modify `front/constants/RouteConstants.js`: add `ROUTE_ANALYTICS_DAILY_FORECAST`.
- Modify `front/components/analytics/analytics-daily-forecast.vue`: compact card only.
- Create `front/components/analytics/analytics-daily-forecast-overview.vue`: summary, status, legend, chart, and selected payload contract shared by both surfaces.
- Create `front/components/analytics/analytics-daily-forecast-details.vue`: day, impact, scheduled events, envelope, and evidence sections.

### Presentation

- Modify `front/assets/styles/theme-white.css`: compact preview, full-page layout, amber partial status, responsive sections, and 44px controls.
- Modify `front/assets/styles/theme-dark.css`: dark-surface and semantic-status overrides.
- Modify all JSON files in `front/i18n/locales/`: route, action, section, impact, and evidence copy.

---

### Task 1: Evidence-covered aggregate payroll reconciliation

**Files:**
- Modify: `front/utils/AnalyticsForecastUtils.js:1247-1280,1627-1634,1910-1920`
- Test: `front/tests/utils/AnalyticsForecastUtils.test.js:2850-2920`

**Interfaces:**
- Consumes: canonical authoritative candidates, admitted bundle `entryIds`, `transactionIds`, `components`, projected dates, and candidate aggregate evidence.
- Produces: `audit.recurring.aggregateReconciliation[]` records shaped as `{ candidateId, bundleIds, entryIds, transactionIds, reason: 'bundleEvidenceCovered' }`; their candidate IDs also remain in `suppressedCandidateIds`.

- [ ] **Step 1: Write the failing stale-aggregate regression**

Add a candidate whose linked tax evidence is completely admitted by the payroll bundle but whose configured aggregate amount is stale and therefore differs from the sum of the current-regime components:

```js
test('keeps stale aggregate payroll evidence reconciliation-only when admitted bundle evidence covers it', () => {
  const history = payrollHistoryWithIdenticalPhases()
  const aggregate = definedCandidate({ id: 'monthly-payroll-tax', sourceAccountId: 'checking', destinationAccountId: 'tax-authority', date: '2026-08-20', amount: 1200 })
  aggregate.identity.categoryId = 'taxes'
  aggregate.aggregateEvidence = { entryIds: history.filter(({ categoryId }) => categoryId === 'taxes').map(({ id }) => id) }
  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-11' }),
    candidates: [aggregate],
    ...normalizedCandidateInputs([aggregate], { ...accountContexts, 'tax-authority': { kind: 'expense', includeNetWorth: false } }),
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })

  assert.equal(result.dailyProjectedEntries.some(({ candidateId }) => candidateId === aggregate.id), false)
  assert.equal(result.dailyProjectedEntries.filter(({ bundleId, categoryId }) => bundleId && categoryId === 'taxes').length, 2)
  assert.deepEqual(result.audit.recurring.aggregateReconciliation.map(({ candidateId, reason }) => ({ candidateId, reason })), [
    { candidateId: aggregate.id, reason: 'bundleEvidenceCovered' },
  ])
})
```

- [ ] **Step 2: Add false-merge guards**

Add three assertions: an independent same-category obligation remains, a same-amount candidate without overlapping evidence remains, and a candidate linked only to an unadmitted same-group split remains. Reverse ledger/candidate order and assert byte identity and nonmutation.

- [ ] **Step 3: Run RED**

Run:

```powershell
cd front
node --test --test-name-pattern="aggregate payroll|independent.*obligation|same-group" tests/utils/AnalyticsForecastUtils.test.js
```

Expected: the stale aggregate projects a standalone occurrence and `aggregateReconciliation` is absent; false-merge guards stay green.

- [ ] **Step 4: Implement evidence-coverage classification**

Replace the amount-equality-only aggregate function with a deterministic record builder. Candidate evidence must map to admitted material bundle component evidence; shared transaction evidence is accepted only when the transaction is exclusive to the admitted component under the existing cohort rules.

```js
const aggregateBundleCandidateReconciliation = ({ candidates, bundles, candidateAmounts, accountContexts, currencyDecimalPlaces }) =>
  candidates
    .filter(({ source }) => source?.authoritative === true)
    .flatMap((candidate) => {
      const coverage = coveredAggregateBundleEvidence({ candidate, bundles, candidateAmounts, accountContexts, currencyDecimalPlaces })
      return coverage ? [{ candidateId: String(candidate.id), ...coverage, reason: 'bundleEvidenceCovered' }] : []
    })
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
```

Do not suppress from category/value equality. Keep the existing exact-amount route as one sufficient evidence-backed case, not the only case.

- [ ] **Step 5: Run GREEN and mutations**

Run the focused utility suite. Then temporarily mutate each guard and confirm a test fails: restore amount equality as mandatory; accept any shared transaction ID; ignore independent evidence. Restore production after each RED.

- [ ] **Step 6: Run the full analytics suite and commit**

```powershell
cd front
npm run test:analytics
npx eslint utils/AnalyticsForecastUtils.js tests/utils/AnalyticsForecastUtils.test.js --max-warnings 0
npx prettier --check utils/AnalyticsForecastUtils.js tests/utils/AnalyticsForecastUtils.test.js
cd ..
git diff --check
git add front/utils/AnalyticsForecastUtils.js front/tests/utils/AnalyticsForecastUtils.test.js
git commit -m "fix: reconcile aggregate payroll forecasts"
```

---

### Task 2: Savings and net-worth monthly impact

**Files:**
- Modify: `front/stores/analyticsStoreFactory.js:100-175,1040-1095,1180-1230,1340-1400`
- Test: `front/tests/stores/analyticsStore.test.js:2450-2820,3625-3915`

**Interfaces:**
- Consumes: normalized projected entry `sourceAccountKind`, `destinationAccountKind`, `flowAmounts`, `financialTrend.series`, `dailyForecast.eventSummaries`, and selected savings view.
- Produces: `dailyForecastImpact` shaped as `{ items: [{ id, actual, remaining, final, status, projectedSources }], payrollEvents: [{ id, impact }] }` where impact includes `availableCashChange`, `savingsChange`, `debtChange`, and `netWorthChange`.

- [ ] **Step 1: Write the failing split-savings regression**

Use forecast entries whose provenance is `sourceKind: 'inferred'` and whose account roles are `destinationAccountKind: 'savingsAccessible'` or `savingsRestricted`. Assert nonzero, separately reconciled included/excluded remaining movement.

```js
assert.equal(store.financialTrend.series.find(({ id }) => id === 'savingsIncluded').remainingFromToday, 25)
assert.equal(store.financialTrend.series.find(({ id }) => id === 'savingsExcluded').remainingFromToday, 75)
assert.equal(store.financialTrend.series.find(({ id }) => id === 'savings').remainingFromToday, 100)
```

Add a withdrawal fixture and assert its sign reverses. Add a provenance mutation guard proving `sourceKind: 'inferred'` is never treated as an account role.

- [ ] **Step 2: Write the failing payroll impact regression**

Build two sanitized payroll events with excluded payroll sources, included and excluded savings destinations, included checking destinations, an included liability repayment, and an included-asset expense. Assert each event and the monthly impact reconcile using endpoint inclusion:

```js
assert.deepEqual(store.dailyForecastImpact.items.map(({ id, remaining }) => [id, remaining]), [
  ['availableCashChange', expectedAvailable],
  ['savingsIncluded', expectedIncludedSavings],
  ['savingsExcluded', expectedExcludedSavings],
  ['debtChange', expectedDebtChange],
  ['netWorthChange', expectedNetWorthChange],
])
```

The test calculates expected values from fixture endpoints, not copied production constants.

- [ ] **Step 3: Run RED**

```powershell
cd front
node --test --test-name-pattern="split savings|monthly impact|payroll.*net worth" tests/stores/analyticsStore.test.js
```

Expected: split savings remains zero because the consumer reads provenance fields; `dailyForecastImpact` is absent.

- [ ] **Step 4: Repair the normalized account-role consumer**

Use only `sourceAccountKind` and `destinationAccountKind` for split savings:

```js
const projectedSavingsForKind = (entries, kind) =>
  entries.reduce((total, entry) => total + (entry.destinationAccountKind === kind ? entry.amount : 0) - (entry.sourceAccountKind === kind ? entry.amount : 0), 0)
```

Do not fall back to labels, categories, or forecast provenance. Include a variable envelope only when it carries an explicit matching account role.

- [ ] **Step 5: Expose normalized monthly impact**

Create a computed `dailyForecastImpact` from the same forecast/store projections used by Financial Trends. Do not recalculate account inclusion in Vue. Extend event summaries with the four impact metrics from their existing normalized `flowAmounts`.

- [ ] **Step 6: Run GREEN and mutations**

Confirm focused store GREEN. Mutate back to `sourceKind`/`destinationKind`, drop excluded savings, and replace endpoint net-worth flow with gross income; each mutation must fail the intended regression, then be restored.

- [ ] **Step 7: Run broad gates and commit**

```powershell
cd front
npm run test:analytics
npx eslint stores/analyticsStoreFactory.js tests/stores/analyticsStore.test.js --max-warnings 0
npx prettier --check stores/analyticsStoreFactory.js tests/stores/analyticsStore.test.js
cd ..
git diff --check
git add front/stores/analyticsStoreFactory.js front/tests/stores/analyticsStore.test.js
git commit -m "fix: reconcile forecast savings and net worth"
```

---

### Task 3: Compact preview and dedicated route

**Files:**
- Delete: `front/pages/analytics.vue`
- Create: `front/pages/analytics/index.vue`
- Create: `front/pages/analytics/daily-forecast.vue`
- Create: `front/components/analytics/analytics-daily-forecast-overview.vue`
- Modify: `front/components/analytics/analytics-daily-forecast.vue`
- Modify: `front/constants/RouteConstants.js`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Consumes: `dailyForecast`, `dailyForecastState`, `dailyForecastImpact`, `dailyForecastMonths`.
- Produces: overview events `select(payload)` and `select-point({ activation, point, transactionIds })`; compact navigation to `ROUTE_ANALYTICS_DAILY_FORECAST`; route query `date=YYYY-MM-DD`.

- [ ] **Step 1: Write rendered compact-card RED tests**

Compile the real SFC and assert the preview contains summary, chart, compact status, and full-page action, but excludes `.analytics-daily-forecast-disclosures`, `.analytics-daily-forecast-event`, and `.analytics-daily-forecast-details`.

```js
assert.match(html, /Open full forecast/)
assert.doesNotMatch(html, /Bundle details|Variable spending envelope|Technical evidence/)
assert.equal(findVNodes(vnodes, (node) => node.props?.class?.includes?.('analytics-daily-forecast-event')).length, 0)
```

Assert the button navigates to `RouteConstants.ROUTE_ANALYTICS_DAILY_FORECAST` and a chart date navigates with `{ query: { date: '2026-08-14' } }`.

- [ ] **Step 2: Write route/source RED tests**

Assert the route constant exists, `/analytics` source lives at `pages/analytics/index.vue`, the dedicated page exists, and the full page validates the query against `dailyForecast.dateKeys`.

- [ ] **Step 3: Run RED**

```powershell
cd front
node --test --test-name-pattern="compact daily forecast|dedicated daily forecast route" tests/stores/analyticsStore.test.js
```

Expected: disclosures are still inline and the route/page do not exist.

- [ ] **Step 4: Extract the shared overview**

Move summary formatting, legend, chart-series decoration, and chart event forwarding into `analytics-daily-forecast-overview.vue`. It accepts explicit props for forecast, state, currency, decimal places, and localized labels; it does not import the store or navigate.

- [ ] **Step 5: Reduce the common card**

Keep loading/blocking states, compact amber partial status, overview, and one 44px action. Remove event/envelope/day/evidence lists. Navigate using the new route constant; chart day navigation adds the date query.

- [ ] **Step 6: Split the pages without changing `/analytics`**

Recreate the current page exactly at `front/pages/analytics/index.vue`, delete the old file, and add the dedicated page. The page calls `analyticsStore.init()` on mount, uses the existing toolbar, and stores a valid selected date from the route query.

```js
const selectedDate = computed(() => (analyticsStore.dailyForecast.dateKeys.includes(String(route.query.date ?? '')) ? String(route.query.date) : null))
```

- [ ] **Step 7: Run GREEN, build, and commit**

```powershell
cd front
node --test tests/stores/analyticsStore.test.js tests/utils/ChartUtils.test.js
npm run test:analytics
npx eslint pages/analytics/index.vue pages/analytics/daily-forecast.vue components/analytics/analytics-daily-forecast.vue components/analytics/analytics-daily-forecast-overview.vue constants/RouteConstants.js tests/stores/analyticsStore.test.js --max-warnings 0
npx prettier --check pages/analytics/index.vue pages/analytics/daily-forecast.vue components/analytics/analytics-daily-forecast.vue components/analytics/analytics-daily-forecast-overview.vue constants/RouteConstants.js tests/stores/analyticsStore.test.js
npm run build
cd ..
git diff --check
git add front/pages/analytics.vue front/pages/analytics/index.vue front/pages/analytics/daily-forecast.vue front/components/analytics/analytics-daily-forecast.vue front/components/analytics/analytics-daily-forecast-overview.vue front/constants/RouteConstants.js front/tests/stores/analyticsStore.test.js
git commit -m "feat: add daily forecast detail route"
```

---

### Task 4: Full forecast detail presentation

**Files:**
- Create: `front/components/analytics/analytics-daily-forecast-details.vue`
- Modify: `front/pages/analytics/daily-forecast.vue`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: every `front/i18n/locales/*.json`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Consumes: selected overview payload, `eventSummaries`, `variableEnvelope`, `dailyForecastImpact`, typed state/audit, and exact actual transaction IDs.
- Produces: ordered detail sections and exact-ID navigation; emits `retry` only for existing forecast retry behavior.

- [ ] **Step 1: Write full-page order and semantics RED tests**

Compile the real detail SFC and assert DOM order:

```js
assert.ok(html.indexOf('Day details') < html.indexOf('Monthly impact'))
assert.ok(html.indexOf('Monthly impact') < html.indexOf('Scheduled events'))
assert.ok(html.indexOf('Scheduled events') < html.indexOf('Variable envelope'))
assert.ok(html.indexOf('Variable envelope') < html.indexOf('Evidence and issues'))
```

Assert one Salary event contains its material tax/savings/debt rows, reconciliation-only aggregate candidates do not render as events, zero rows are absent, technical IDs are inside a closed disclosure, projected controls are disabled, and actual-ID controls navigate.

- [ ] **Step 2: Write partial/blocking state RED tests**

Assert partial data renders a `role="status"` amber summary with count and blocking data renders `role="alert"`. Raw technical IDs must not appear outside the evidence disclosure.

- [ ] **Step 3: Run RED**

```powershell
cd front
node --test --test-name-pattern="daily forecast detail page|forecast evidence issues|monthly impact" tests/stores/analyticsStore.test.js
```

Expected: the detail component and new labels are missing.

- [ ] **Step 4: Implement selected-day and impact sections**

Place selected Day details immediately after the overview. Present impact rows from `dailyForecastImpact`; do not derive flow semantics in the component. Actual rows route through `projectLineChartSelection`; projected rows remain disabled.

- [ ] **Step 5: Implement event, envelope, and evidence sections**

Group events by date, render each event once, nest material bundle components, and put source/candidate/bundle/evidence IDs behind **Technical evidence**. Keep variable envelopes undated. Group partial evidence by source and affected metric with retry for source errors.

- [ ] **Step 6: Add localization and responsive themes**

Add native, nonempty strings for `open_full_forecast`, `monthly_impact`, `scheduled_events`, `evidence_and_issues`, `technical_evidence`, `inputs_need_review`, `actual_through_today`, `remaining_activity`, and `end_of_month_change` in every locale. Add compact/full layouts, amber status, desktop chart/detail columns, mobile stacking, 44px controls, and dark overrides.

- [ ] **Step 7: Run locale, style, focused, and full gates**

```powershell
cd front
node --test tests/stores/analyticsStore.test.js tests/utils/ChartUtils.test.js tests/utils/AnalyticsForecastUtils.test.js tests/utils/AnalyticsLedgerUtils.test.js
npm run test:analytics
npx eslint components/analytics/analytics-daily-forecast-details.vue pages/analytics/daily-forecast.vue tests/stores/analyticsStore.test.js --max-warnings 0
npx prettier --check components/analytics/analytics-daily-forecast-details.vue pages/analytics/daily-forecast.vue tests/stores/analyticsStore.test.js i18n/locales/*.json
node -e "const fs=require('fs'); for (const file of fs.readdirSync('i18n/locales').filter(file=>file.endsWith('.json'))) JSON.parse(fs.readFileSync('i18n/locales/'+file,'utf8')); console.log('locale parse PASS')"
npm run build
cd ..
git diff --check
```

For the two baseline-drifted theme files, verify the added blocks in isolation with Prettier and parse both complete files with the existing CSS parser; do not reformat unrelated CSS.

- [ ] **Step 8: Commit**

```powershell
git add front/components/analytics/analytics-daily-forecast-details.vue front/pages/analytics/daily-forecast.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests/stores/analyticsStore.test.js
git commit -m "feat: explain daily forecast on its own page"
```

---

### Task 5: Whole-feature review and deployed acceptance

**Files:**
- Review: all files changed since `0a88889`
- Write ignored evidence: `.superpowers/sdd/2026-08-12-daily-forecast-correctness-detail-page/final-report.md`

**Interfaces:**
- Consumes: committed Tasks 1-4.
- Produces: independently reviewed branch, local Docker image, preserved preview runtime, Chrome evidence, and explicit PASS/FAIL/NOT RUN boundaries.

- [ ] **Step 1: Run an independent code-review pass**

Review exact diff `0a88889..HEAD` for false aggregate suppression, duplicate forecast values, wrong savings signs, account-role/provenance confusion, raw-ID exposure, route/query loss, transaction-navigation mistakes, accessibility, locale parity, and mobile overflow. Fix every P1/P2 through a new RED/GREEN commit before continuing.

- [ ] **Step 2: Run final automated/static gates**

```powershell
cd front
node --test tests/utils/AnalyticsForecastUtils.test.js tests/utils/AnalyticsLedgerUtils.test.js tests/stores/analyticsStore.test.js tests/utils/ChartUtils.test.js
npm run test:analytics
npm run build
cd ..
git diff --check 0a88889..HEAD
pwsh -NoProfile -File .agents/skills/firefly-pico-oss-contribution/scripts/contribution-preflight.ps1
```

Record known repository/toolchain warnings separately from task failures.

- [ ] **Step 3: Build the exact standalone image**

```powershell
docker-compose -f docker-compose.pico.local.yml build firefly-pico
```

Inspect the running disposable preview first. Preserve its named volume, authenticated session, environment, port, and network. Replace only the preview container; keep the previous image until HTTP and Chrome acceptance pass.

- [ ] **Step 4: Verify authenticated Chrome desktop**

On the exact built image:

- confirm the Analytics preview has totals, chart, amber partial badge if applicable, and one full-page action;
- confirm it has no event/envelope/evidence lists;
- confirm taxes appear exactly once across the two current-regime payroll events and match the ignored real baseline;
- confirm combined and split savings are nonzero and endpoint-correct;
- confirm net-worth impact is reconciled rather than guessed;
- activate a chart day and verify `/analytics/daily-forecast?date=...` opens with Day details before the schedule;
- verify one Salary event per payday with nested components and no standalone aggregate tax event;
- verify actual IDs navigate and projected evidence does not;
- verify no new console warning/error.

- [ ] **Step 5: Verify mobile and themes**

At 390×844, verify light and dark modes, 44px controls, readable chart/day details, stacked sections, no horizontal page overflow, and browser back navigation to Analytics. Repeat desktop light/dark status and layout checks.

- [ ] **Step 6: Finalize evidence and workspace**

Record exact commands, counts, image ID, container/volume preservation, Chrome states, screenshots without private values, and live-data limitations in the ignored report. Confirm `git status --short` is clean and no push/PR/Firefly mutation occurred.

---

## Completion Criteria

- Aggregate payroll tax evidence is projected once, never through label or amount guessing.
- Combined and split savings forecast uses account-role fields and reconciles employer plus employee savings movement.
- Net-worth movement follows endpoint inclusion and is explained in the full page.
- The common Analytics card is compact.
- The dedicated Daily Forecast page places Day details immediately after the chart and contains the long-form evidence.
- Focused and full analytics tests, lint/format/locale/CSS/build gates, Docker build, and authenticated Chrome desktop/mobile light/dark acceptance pass, or any unavailable gate is reported honestly.
