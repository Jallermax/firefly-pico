# Daily Forecast Evidence Model Design

**Date:** 2026-08-11

**Status:** Approved design; implementation planning pending written-spec review

**Scope:** Personal Firefly Pico analytics fork, with reusable pure forecasting primitives

## Decision supported

The Daily Forecast must answer: **What high-confidence inflows and uses remain this month, when are they expected, and how will they change Available money?**

The card must distinguish scheduled events from uncertain spending capacity. It must never make low-confidence history look like a dated transaction, and every exact amount must expose its Firefly evidence.

## Current failure

The current forecast mixes paid subscription dates with expected dates, relies on fuzzy fulfillment even when Firefly provides linked paid transaction IDs, fragments payroll into unrelated patterns, and distributes every historical account/category context independently across all future dates. Sparse histories fall back to even distribution. The result can repeat already-paid obligations, invent daily income, and render dozens of tiny historical-remainder rows.

Current code anchors:

- `front/utils/AnalyticsRecurringUtils.js`: authoritative definitions, schedules, evidence, and fulfillment matching.
- `front/utils/AnalyticsForecastUtils.js`: overdue handling, historical distribution, reconciliation, and projected entries.
- `front/stores/analyticsStoreFactory.js`: daily selector and monthly-to-daily projection.
- `front/components/analytics/analytics-daily-forecast.vue`: card state, summary, audit, and retry behavior.
- `front/components/charts/analytics-combination-chart.vue`: daily bars, Available line, selection, and details.

This design extends the reconciliation principles in `2026-08-10-analytics-forecast-chart-corrections-design.md`; it replaces exact-day historical remainder projection with an evidence-ranked event and envelope model.

## Forecast hierarchy

Forecast inputs have explicit roles and strict precedence:

1. **Fulfillment evidence** — exact linked Firefly transaction IDs prove that an occurrence is paid.
2. **Authoritative events** — Firefly bills and recurring transactions schedule known occurrences.
3. **Inferred bundles** — repeated groups of same-day components schedule recurring multi-part events such as payroll.
4. **Variable envelopes** — budgets and robust historical totals estimate undated remaining activity.
5. **Seasonal evidence** — twelve-month evidence corroborates yearly or seasonal events; it never turns a one-off transaction into a recurrence by itself.

Higher layers remove their evidence and amounts before lower layers are calculated. No activity may be counted twice.

## Fulfillment and schedule semantics

Subscription inputs must separate:

- `paid_dates`: evidence dates and linked transaction-group IDs only;
- `pay_dates` and `next_expected_match`: expected schedule dates only.

For each current-period occurrence, fulfillment is resolved in this order:

1. linked paid transaction-group ID within the occurrence period;
2. exact normalized entry identity and amount;
3. bounded fuzzy account/payee/date matching.

An exact linked ID is sufficient even when a transaction group contains several splits with different categories or external accounts. Once fulfilled, an occurrence cannot be moved into the future by overdue handling. An early payment in the current cycle suppresses the later configured date for that same cycle.

Overdue relocation applies only to genuinely unfulfilled occurrences. The original due date remains visible in audit, and the relocated date is labelled as estimated.

## Recurring bundles and regime changes

A bundle is a set of components that repeatedly occurs on the same local date and shares stable evidence such as source account, normalized paystub tag family, or recurring co-occurrence signature. A payroll bundle may contain:

- salary and reimbursements;
- employer contributions;
- taxes and insurance;
- debt repayment;
- savings contributions;
- internal transfers, retained only for evidence and reconciliation.

The bundle is scheduled once, then expanded for details. Components are not independently distributed over future dates.

Semimonthly payroll detects a middle-of-month occurrence and a month-end occurrence. A weekend nominal date moves to the preceding business day unless authoritative schedule evidence says otherwise. Amounts use the newest stable regime:

- if the latest two bundle occurrences have the same component signature, agree within currency precision, and differ from the older median by at least 2%, their component values become the active baseline;
- linked deductions use the same regime as the salary component;
- otherwise use a recency-weighted median and mark the result medium confidence.

This makes a confirmed pay increase effective immediately without averaging it with the former salary.

## Known and annual events

Authoritative recurring events use their configured cadence and recent linked amount. Variable-amount bills use a robust recent median constrained by the authoritative min/max envelope. A current-cycle paid occurrence has zero remaining amount.

Yearly events require an authoritative yearly schedule or a strong prior-year match. The forecast uses the configured date plus the previous occurrence as evidence and exposes a date window when those dates differ. A single unrelated transaction never creates an annual forecast.

Monthly planning buckets that describe a collection of payroll deductions or similar activity are envelopes, not atomic events. If their component bundle is already scheduled, the aggregate bucket is reconciliation evidence only.

## Budget and historical envelopes

Budgets do not create exact daily transactions.

- **Reset budgets** provide the planned monthly target and are compared with robust completed-month history.
- **Rollover or adjusted budgets** represent reserves or sinking funds. Their full available balance is never assumed to be spent.
- Explicit and bundled events are removed before variable history is calculated.
- Historical expected totals use the median of completed comparable months with recency as a tie-breaker; isolated large one-offs do not inflate the result.
- When history is sparse, a reset budget may provide a low-confidence monthly envelope. Rollover/adjusted budgets remain plan-only.

For a dimension `d`:

```text
actual_d       = completed current-month activity through today
known_d        = unfulfilled authoritative and bundled event activity
history_d      = robust completed-month variable activity after known evidence removal
plan_d         = normalized reset-budget target, when present
expected_d     = history_d when history is sufficient, otherwise plan_d
remaining_d    = max(0, expected_d - actual_variable_d) + known_d
```

The audit exposes `history_d`, `plan_d`, which value was selected, known event IDs, removed history IDs, and confidence. A habitual budget overrun remains visible as expected-versus-plan variance; the budget does not silently cap history.

## Daily allocation and presentation

Only high- or medium-confidence events receive exact dates and chart bars. A nonzero variable envelope remains undated and appears as a translucent remaining-period band or weekly reserve, not as navigable transaction rows.

The chart renders:

- one green inflow bar per event day;
- one stacked use bar per event day for expenses, debt, and savings;
- one Available line showing the cumulative net effect;
- an optional variable-spending band that communicates range rather than false precision.

Selecting an event day expands the bundle into actual-to-date, projected components, evidence, confidence, and exact transaction navigation. Payroll displays gross inflow and total uses on the chart; its details show taxes, insurance, debt, savings, employer contributions, reimbursements, and internal transfers. Variable envelope details show category/budget totals but are not transaction-navigable.

The card must not list dozens of zero or tiny historical remainder components. Rows with no material value and no status/evidence are omitted.

## Availability and error isolation

Unavailable evidence is typed by event and metric. An unresolved expense occurrence cannot make income unavailable. Defensible events and unrelated metrics remain visible. Each unresolved item shows:

- source/candidate ID without exposing amounts in audit metadata;
- affected metrics;
- missing account or currency evidence;
- retry action where the source fetch failed.

The whole card is blocking only when no defensible daily series can be produced.

## Determinism and evidence

All candidate, bundle, occurrence, and audit outputs are canonicalized before matching or projection. Input order cannot change dates, totals, IDs, confidence, or serialized output.

Exact event rows retain separate arrays for transaction IDs, source IDs, candidate IDs, and evidence IDs. Navigation uses actual Firefly transaction IDs only. Projected evidence is explanatory and never navigable as if it were an existing transaction.

## Acceptance criteria

1. A current-cycle bill with a linked paid transaction group is not projected again, including a multi-split paid group.
2. An early paid subscription suppresses its later configured date for the same cycle.
3. A two-occurrence semimonthly payroll bundle is forecast on the observed business-day schedule.
4. A new stable salary regime and its linked tax/deduction components replace the older regime instead of being averaged with it.
5. Payroll components reconcile exactly to gross inflow, total uses, savings, debt, and Available change.
6. A monthly aggregate payroll budget or bill does not duplicate its scheduled components.
7. Recent utility amounts use robust linked history rather than the midpoint of a broad min/max range.
8. Authoritative yearly subscriptions are forecast once with prior-year evidence.
9. One-off travel, vehicle, health, or technology spending does not become a dated recurrence.
10. Variable spending produces a bounded envelope, not daily historical-remainder transactions.
11. Missing expense evidence does not null income or unrelated event days.
12. Shuffled equivalent input produces byte-identical forecast and audit output.
13. Daily details preserve exact actual transaction drill-down and keep projected evidence non-navigable.
14. Mobile and desktop, light and dark, render readable bars, bands, details, and at least 44px interactive targets without page overflow.

## Implementation slices and likely files

1. **Occurrence correctness**
   - `front/utils/AnalyticsRecurringUtils.js`
   - `front/tests/utils/AnalyticsRecurringUtils.test.js`
   - Separate paid evidence from schedule dates and make linked IDs authoritative.

2. **Bundle and envelope engine**
   - `front/utils/AnalyticsForecastUtils.js`
   - `front/tests/utils/AnalyticsForecastUtils.test.js`
   - Add bundle inference/regime selection, seasonal corroboration, budget envelopes, and precedence reconciliation.

3. **Store projection and evidence isolation**
   - `front/stores/analyticsStoreFactory.js`
   - `front/tests/stores/analyticsStore.test.js`
   - Project events and undated envelopes separately; preserve typed status and evidence.

4. **Daily card and chart**
   - `front/components/analytics/analytics-daily-forecast.vue`
   - `front/components/charts/analytics-combination-chart.vue`
   - `front/assets/styles/theme-white.css`
   - `front/assets/styles/theme-dark.css`
   - `front/i18n/locales/*.json`
   - Render simplified event bars, Available line, variable band, and expandable bundle details.

The exact implementation plan may reduce this file set if existing chart and locale contracts already suffice.

## Verification

The implementation requires strict RED/GREEN tests for every acceptance criterion, followed by:

- focused recurring, forecast, store, and chart suites;
- `npm run test:analytics`;
- scoped ESLint and Prettier;
- `npm run build`;
- `git diff --check` and owned-path checks;
- contribution preflight;
- standalone `docker-compose -f docker-compose.pico.local.yml build firefly-pico`;
- authenticated Chrome verification using the built image on desktop/mobile and light/dark.

Live verification must confirm that already-paid obligations are absent and that event dates/amounts match the authenticated data. No Firefly transaction, bill, budget, account, or setting may be mutated during verification.

## Scope and packaging

The full hybrid policy and Daily Forecast UX are personal-fork scope. Reusable, upstreamable candidates are limited to generic primitives: authoritative paid-ID fulfillment, separation of paid and expected dates, deterministic bundle inference, typed evidence, and honest insufficient-data behavior. There are no unresolved product choices in this design; changing event precedence, payroll presentation, or budget-envelope semantics requires a new explicit decision.

No dependency, backend, migration, authentication, Docker configuration, or Firefly data change is in scope. Do not push, publish, open a PR, or modify runtime data without separate approval.

Rollback is commit-by-commit. The prior forecast remains recoverable by reverting the focused occurrence, engine, store, and UI commits in reverse order.
