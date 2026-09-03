# Daily Forecast Correctness and Detail Page Design

**Date:** 2026-08-12
**Status:** Approved for implementation planning
**Scope:** Personal fork, frontend analytics and forecast presentation

## Decision supported

The Daily Forecast must answer two questions without cluttering the common Analytics page:

1. What defensible activity remains this month, and what does it do to Available money?
2. Why do the forecasted taxes, savings, debt, and net-worth movement have those values?

The Analytics page remains a quick comparison surface. A dedicated Daily Forecast page owns day selection, event composition, variable envelopes, evidence, and recovery details.

## Confirmed failures

Read-only inspection of the current production-shaped forecast and authenticated rendered UI confirmed four separate failures:

- Payroll tax components are forecast inside both semimonthly payroll bundles, while an aggregate authoritative tax candidate is also projected as a standalone event. The category and outflow forecasts therefore count the same obligation twice.
- Split savings forecast consumers read forecast provenance fields as if they were account-role fields. Projected payroll savings exist, but the included and excluded savings summaries both render zero.
- The net-worth result is not explained at the account-inclusion boundary. An excluded payroll account, included checking and savings accounts, excluded savings accounts, liabilities, and ordinary expenses affect net worth differently, but the UI exposes only one opaque total.
- The Daily Forecast card contains a partial warning, chart, variable envelope, nineteen scheduled-event disclosures, technical evidence, and selected-day details in one card. Selected-day details appear after the long event list and are effectively hidden.

The exact private amounts used for live acceptance remain in ignored verification evidence, not in this tracked design.

## Chosen approach

Use a compact Analytics preview plus one dedicated Daily Forecast page.

Rejected alternatives:

- A full-screen popup or drawer would avoid a new route but would provide poor history, deep-link, refresh, mobile back-navigation, and long-content behavior.
- Reordering and collapsing the current inline lists would reduce the immediate height but would leave the common Analytics page responsible for two incompatible jobs.

The dedicated page is one forecast page with a selected-day section. It does not create a separate route for every calendar day. A selected date is represented by the page query so chart selections remain deep-linkable.

## Forecast correctness

### Aggregate payroll obligations

An authoritative candidate becomes bundle reconciliation evidence instead of a projected event only when all of the following are true:

- its linked historical entry or transaction evidence overlaps an admitted recurring bundle;
- the overlapping evidence maps to admitted material bundle components, not merely to another split in the same transaction group;
- its current expected month is already covered by the bundle schedule; and
- it has no defensible independent evidence outside that bundle.

Suppression must be evidence-based. Labels, categories, similar values, or a shared transaction group alone are insufficient. A stale aggregate amount may still be suppressed when its linked evidence is fully represented by the current-regime bundle. An independent tax, insurance, subscription, or annual obligation must remain projected.

The forecast audit will expose aggregate candidates retained for reconciliation, their matched bundle, and the admitted evidence that justified the decision. They do not create daily rows, category forecast amounts, or Available/net-worth movement.

### Savings movement

Combined savings continues to use the forecast's normalized `savingsChange` flow amount.

Split savings uses normalized account-role fields on projected entries:

- `sourceAccountKind`
- `destinationAccountKind`

Forecast provenance such as `defined`, `inferred`, or `variable` must never be interpreted as an account kind. A deposit into an included savings account contributes to included savings; a deposit into an excluded savings account contributes to excluded savings. Withdrawals reverse the corresponding movement. Payroll-linked employee transfers and employer contributions are both included when they reach a savings account.

Variable envelopes affect a split savings forecast only when they carry a defensible explicit savings account role. No category or label heuristic may assign them to included or excluded savings.

### Net-worth movement

Do not introduce a gross-income shortcut. Each projected component keeps the existing endpoint formula:

```text
net_worth_change = amount_to_included_destination - amount_from_included_source
```

Consequences are explicit:

- salary deposited into an excluded payroll account does not directly increase included net worth;
- movement from that excluded payroll account into an included asset increases included net worth;
- movement between excluded accounts does not change included net worth;
- repayment of an included liability increases net worth according to the existing liability convention;
- an expense paid from an included asset decreases net worth;
- reconciliation-only payroll components preserve evidence but create no material forecast movement.

The corrected forecast must reconcile each payroll occurrence independently across gross inflow, expenses/taxes, savings, debt, Available change, and net-worth change. If the resulting net-worth forecast is still negative after correction, it is shown as an honest result with its components rather than forced positive.

## Analytics preview

The common Analytics page keeps a compact Daily Forecast card containing:

- title, month, and history-window control;
- Expected inflow, Expected outflow, and Available change;
- the existing compact daily inflow/outflow/Available chart;
- one concise status badge; and
- a primary **Open full forecast** action.

The preview contains no variable-envelope list, scheduled-event list, evidence-ID list, or inline day-details panel.

Selecting a chart day navigates to:

```text
/analytics/daily-forecast?date=YYYY-MM-DD
```

The button opens the same route without a date. A partial forecast uses a compact amber status such as “4 inputs need review.” Red is reserved for a blocking state in which no defensible forecast can be rendered.

## Dedicated Daily Forecast page

To support sibling `/analytics` and `/analytics/daily-forecast` routes cleanly, the existing page moves from `front/pages/analytics.vue` to `front/pages/analytics/index.vue` without changing the public `/analytics` route. The new page is `front/pages/analytics/daily-forecast.vue`, and `RouteConstants` gains a dedicated route constant.

The page uses the existing toolbar and analytics store initialization patterns. Its content order is fixed:

1. history-window controls and status;
2. summary totals;
3. daily chart;
4. selected Day details;
5. monthly impact reconciliation;
6. Scheduled events;
7. Variable envelope;
8. Evidence and issues.

On mobile these sections stack. On desktop the chart and selected-day panel may share a two-column row when space permits; the remaining sections stay below them. All controls retain at least 44px interactive targets and the page must not overflow horizontally.

### Day details

Day details appear immediately after the chart and never below the monthly event list. A route date initializes the selection. An in-page chart selection updates the query without losing the current forecast state.

The panel shows:

- the selected date;
- inflow, uses, and Available change;
- scheduled events for that date;
- actual-to-date versus projected amounts where both exist; and
- exact transaction navigation only for actual Firefly transaction IDs.

Projected evidence remains explanatory and non-navigable.

### Scheduled events

Events are grouped by date and rendered once. A payroll bundle is one Salary event per payday with nested material components for taxes, insurance, debt, savings, contributions, reimbursements, and transfers. A payroll component must not also appear as a standalone event unless it has independent authoritative evidence.

The default view shows human labels, totals, confidence, and material components. Source, candidate, bundle, and evidence IDs move behind a **Technical evidence** disclosure. Zero-value, reconciliation-only, and evidence-only components are omitted from ordinary rows while remaining available in the technical audit.

### Monthly impact reconciliation

The page explains the forecast across these metrics:

- Available change;
- savings change, including included and excluded savings when split view is enabled;
- debt change; and
- net-worth change.

Each metric shows actual through today, remaining scheduled or enveloped activity, and end-of-month change. Payroll events can be expanded to show how their account endpoints contribute to each metric. The view uses the same normalized forecast flow amounts as other analytics consumers; it does not recompute finance semantics in the component.

### Variable envelope

The envelope remains undated. It shows category or budget, actual variable activity, known scheduled activity, historical or reset-plan expectation, remaining amount, and confidence. It never becomes a fake transaction row or exact day. Empty and immaterial rows are omitted.

### Evidence and issues

Partial evidence is grouped by source and affected metric. The default state shows a concise amber summary and recovery action. Technical IDs, missing currencies/accounts, and forecast reasons are available inside disclosures.

Retry remains available for source-fetch failures. An unresolved expense cannot null unrelated income, savings, debt, or net-worth values. The page is blocking only when no defensible daily series exists.

## Component boundaries

The current monolithic card is split only where two real consumers need a boundary:

- the compact card owns Analytics-page framing and navigation;
- a shared overview owns summary, legend, chart, and day-selection events;
- a detail component owns selected-day, reconciliation, scheduled-event, envelope, and evidence sections;
- the dedicated page owns route-query synchronization and toolbar/store initialization.

Forecast classification and accounting remain in pure utilities and the analytics store. Components format and present normalized data; they do not infer tax, savings, account inclusion, or recurrence semantics from labels.

## State and navigation

The analytics store remains the single forecast source. Opening the full page reuses retained data and refresh semantics rather than maintaining a second forecast instance.

The selected date is valid only when it exists in the current month. An absent or invalid query leaves no day selected. Changing history length preserves the date when it remains valid and clears it otherwise.

Actual transaction navigation continues through the existing exact-ID transaction filter. No source ID, candidate ID, or projected evidence ID is passed as if it were a Firefly transaction ID.

## Accessibility and localization

- Add all new labels to every tracked locale.
- The compact status is announced as status, not alert; blocking failure uses alert semantics.
- The full-page sections use headings and labelled disclosures.
- Chart day activation works with pointer, keyboard, and touch.
- Selected-day changes use a concise live announcement.
- Light and dark themes preserve semantic contrast without using red for ordinary partial evidence.

## Verification

### Automated proof

Add production-shaped synthetic regressions that prove:

- a fully covered aggregate payroll candidate is reconciliation-only;
- a same-category or same-amount independent obligation remains projected;
- current-regime payroll taxes appear exactly once and reconcile across both paydays;
- combined, included, and excluded savings forecasts use normalized account roles and are nonzero when matching projected movement exists;
- payroll employer contributions and employee savings transfers are represented once;
- payroll net-worth movement follows endpoint inclusion and reconciles with Available, savings, and debt;
- reversed equivalent input is byte-identical and inputs are not mutated;
- the compact card contains no disclosure lists or day-details panel;
- chart selection and the full-forecast action use the dedicated route;
- the full page orders Day details before scheduled events;
- projected evidence is disabled while actual transaction IDs remain navigable;
- partial and blocking states use the intended semantics.

Run focused forecast/store/chart/component tests, the complete analytics suite, scoped ESLint and Prettier, locale parsing, and a production Nuxt build.

### Rendered and live proof

Build the standalone local Docker image, preserve the existing authenticated preview volume/session, and replace only the disposable preview container. Verify in real Chrome:

- taxes match the two current-regime payroll deductions with no aggregate duplicate;
- savings forecast is nonzero and split correctly by account inclusion;
- net-worth movement has an understandable endpoint-backed reconciliation;
- the Analytics card is compact and contains no long evidence lists;
- chart selection opens the full page with the selected day visible immediately after the chart;
- payroll components appear once under each Salary event;
- partial evidence is amber and blocking failures are red;
- desktop/mobile and light/dark states have readable 44px controls and no horizontal overflow;
- console has no new warnings or errors.

Private account names, transaction IDs, and exact acceptance amounts remain in ignored evidence. Do not mutate Firefly data during verification.

## Scope and packaging

This full forecast policy and dedicated analytics experience are personal-fork scope. Potential upstreamable slices are limited to generic evidence-covered aggregate suppression, normalized account-role projection, typed partial-state presentation, and exact-ID navigation boundaries.

No backend route, database migration, dependency, Firefly transaction, budget, subscription, account, or recurring definition is changed. No push, issue, pull request, or public publication occurs without separate approval.

## Rollback

The route and presentation split can be rolled back independently from the forecast-accounting fixes. The accounting fixes remain pure frontend forecast/store changes guarded by focused regressions. Docker verification retains the prior image until the replacement passes HTTP and Chrome acceptance; the named data volume and authenticated session are preserved.
