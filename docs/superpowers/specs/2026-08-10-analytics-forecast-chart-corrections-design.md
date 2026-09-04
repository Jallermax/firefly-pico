# Analytics forecast and chart corrections design

**Date:** 2026-08-10
**Status:** approved design
**Destination:** personal Firefly Pico fork on `personal/extended-analytics`

## Problem

Rendered Chrome inspection exposed three related defects:

1. Financial Trends and Spending by category can produce implausible end-of-month spikes because actual spending, defined recurring activity, inferred recurring activity, and a conditional historical remainder are added without one reconciled final target. Live evidence included a Taxes forecast that combined a defined tax schedule with inferred payroll-tax splits and the historical remainder, plus duplicate defined subscriptions.
2. Daily Forecast renders provenance as up to eight bar groups across every day. The live month produced 98 small bars, making daily cash timing and the Available trajectory unreadable.
3. Cash Use renders stacked areas without a persistent legend. Its interaction resolves only the nearest month column, so hovering any area shows every row for that month instead of identifying the region under the pointer.

The correction must preserve transaction evidence, currency availability, partial states, and drill-down while making every card reconcile to the same forecast.

## User decisions

- Daily Forecast optimizes for daily cash timing.
- Inferred recurring activity and historical remainder may fill the selected historical baseline but may not push the monthly forecast above it.
- Only active, unfulfilled, explicit Firefly recurring definitions may raise a forecast above the selected historical baseline.
- A forecast may never be lower than actual activity already recorded.
- Cash Use supports two distinct pointer modes:
  - direct area hover identifies the area;
  - proximity to a month guide shows values for every visible area in that month.
- Click or tap pins either inspection mode. Existing drill-down behavior remains available for values backed by actual transactions.

## Calculation contract

### Shared monthly target

For cumulative activity such as expenses and category spending:

```text
baseline_final = max(actual_to_date, completed_month_average)
explicit_due_final = actual_to_date + unfulfilled_explicit_definition_amount
forecast_final = max(baseline_final, explicit_due_final)
remaining_from_today = forecast_final - actual_to_date
```

Rules:

- The completed-month average uses only the selected 3/6/12/24 fully completed months and preserves covered zero months.
- Inferred recurring candidates and the historical remainder describe composition and timing inside `remaining_from_today`; they do not increase `forecast_final` beyond the baseline.
- Active explicit Firefly definitions may increase the final above the baseline only for unfulfilled occurrences remaining in the current month.
- Current actual is authoritative. When it already exceeds the average, the final cannot fall below it.
- A known explicit occurrence must not be counted twice because it also appears as an inferred candidate, a linked subscription, another semantically equivalent definition, or a historical remainder entry.
- A split-level inferred bundle that represents one explicit parent occurrence must consume that parent occurrence rather than be added beside it.
- Missing or unavailable inputs remain unavailable or partial according to the affected metric. They are never converted to zero.

### Allocation inside the target

The remaining target is allocated in this order:

1. Reserve unfulfilled explicit definitions at their expected dates.
2. Use eligible inferred candidates to allocate the still-unassigned target without exceeding it.
3. Distribute the residual historical remainder using the observed day-of-month and weekday profile, or the existing disclosed even fallback when timing evidence is insufficient.

If explicit definitions exceed the historical baseline, the target expands to include them. If explicit definitions alone exceed the target for a metric, inferred and historical allocations for that metric become zero.

Signed balance-change metrics retain their signed semantics. Explicit savings and liability movements may exceed the historical signed average when they are known and unfulfilled. Credit cards remain asset accounts, not liabilities.

### Reconciliation

The following consumers use the same shared target and allocations:

- Financial Trends monthly changes and total expenses;
- Spending by category;
- Daily Forecast;
- Cash Use forecast month.

For every usable metric:

```text
actual_to_date + remaining_from_today = forecast_final
sum(daily projected entries) = remaining_from_today
sum(category forecast amounts) = total expense forecast
```

Audit output retains actual transaction IDs, projected source IDs, candidate IDs, evidence IDs, conversion provenance, suppressed duplicates, and unavailable inputs separately.

## Presentation design

### Financial Trends and Spending by category

- Continue to plot completed months plus one forecast point; do not plot a misleading partial-today point for change or expense series.
- Forecast details distinguish current actual, completed-month baseline, explicit scheduled activity, inferred allocation, historical remainder, final forecast, and remaining from today.
- Repeated daily historical-remainder entries collapse into one readable row per category and context.
- A forecast above the historical average must expose the explicit scheduled source that caused it.
- Existing vertical crosshair and transaction drill-down remain.

### Daily Forecast

The card shows three summary values above the chart:

- expected inflow;
- expected outflow;
- Available change.

The chart contains:

- one green inflow bar per day;
- one pink outflow bar per day;
- solid treatment through today;
- hatched treatment after today;
- one cumulative Available-change line;
- a labelled Today marker.

Hovering or tapping a day shows total inflow, total outflow, net Available change, and a short amount-descending list of scheduled or estimated items. Provenance such as recurring-defined, recurring-inferred, historical remainder, confidence, conversion, and evidence belongs in this day detail instead of separate chart bars.

Unavailable daily portions stay visibly unknown. Known bars and the known cumulative path remain visible until an unknown value prevents a defensible continuation.

### Cash Use legend

Cash Use renders a persistent legend for every visible filled area, plus meaningful boundary lines and gap treatments. Legend order matches visual stack order. Markers reuse each series color and pattern.

On desktop the legend wraps compactly. On narrow mobile layouts it may use a horizontal scrolling row if wrapping would make the chart unreadable. The existing category facet and Top 5/Top 10/All detail control still determine which areas are visible.

### Cash Use interaction

The resolver distinguishes two modes:

1. **Area mode:** when the pointer is inside a filled area and outside the month corridor, highlight that area, de-emphasize other areas, and show a compact label containing the area name. Click/tap pins it.
2. **Month mode:** when the pointer is near a month vertical guide, show the month crosshair and every visible area value in visual stack order, followed by total sources, total uses, and excess or shortfall. Click/tap pins it.

Month mode wins inside its explicit corridor. Pointer corridors remain narrow on desktop and use a 44px touch target on touch interaction without making unrelated filled regions ambiguous.

A pinned row backed by actual transaction IDs can drill into the exact transaction list. Projected-only rows remain non-navigating and show their projected source evidence. Second click/tap, outside click, or Escape clears the selection.

Keyboard behavior preserves month traversal and dismissal. Legend and tooltip text provide non-color identification for every area.

## Architecture and scope

- Keep forecast calculation in the existing pure analytics utilities.
- Add one shared target-allocation stage instead of adding card-specific clamps.
- Extend the existing combination-chart geometry and interaction controller with pure area-containment and month-corridor resolution.
- Reuse current Pinia selectors and existing chart components; do not add dependencies or a second charting framework.
- Use existing analytics styles, CSS variables, pattern treatments, and locale structure.
- Keep all Firefly data read-only. No transactions, recurring definitions, subscriptions, or account data are modified.

Personal-fork outcome: trustworthy forecasting and decision-oriented rendered charts for the owner's daily Pico client.

Potential upstreamable slices: conservative target allocation, duplicate-safe forecast audit, accessible stacked-area legend, and pure region/month interaction geometry. Personal defaults and experimental forecast policy remain fork-specific unless deliberately generalized later.

## Error and partial-data behavior

- Loading retains the last complete chart generation when available.
- Source failures remain card-local with a retry action.
- Missing FX, account classification, link metadata, or recurring inputs affect only dependent metrics and dates.
- Partial cards retain every defensible historical and actual value.
- Warning summaries show human-readable counts and concise source labels; raw candidate/evidence IDs remain behind details.
- Empty data has an explicit empty state rather than a zero-looking forecast.

## Verification contract

### Forecast behavior

Automated tests must cover:

- actual below, equal to, and above the completed-month average;
- zero-activity current months;
- explicit definitions below and above the baseline;
- inferred candidates and historical remainder capped inside the target;
- semantically duplicate recurring/subscription definitions;
- parent definitions represented by split-level inferred bundles;
- fulfilled and overdue occurrences;
- refunds, savings deposits/withdrawals, liability repayments/new debt, credit-card assets, transfers, splits, and missing FX;
- exact cross-card reconciliation and stable audit evidence under shuffled input.

### Presentation and interaction

Automated tests must cover:

- collapsed forecast-detail rows;
- Daily Forecast summary totals, two daily bar directions, actual/forecast treatment, Today marker, day details, and unavailable gaps;
- Cash Use legend ordering, labels, colors, patterns, and detail filtering;
- area containment, interpolation, boundary ties, month-corridor precedence, scroll offsets, pointer/touch/keyboard pinning, dismissal, and exact drill-down projection;
- 44px touch targets and accessible non-color names.

### Final gates

- focused RED/GREEN tests for every changed behavior;
- full analytics suite;
- touched ESLint and Prettier checks;
- production Nuxt build;
- Docker image build through `npm ci --ignore-scripts`;
- Chrome verification on desktop and mobile, in light and dark themes, using the authenticated live data;
- direct inspection of forecast decomposition, area hover, month crosshair, touch pinning, and console errors.

## Non-goals

- Editing or creating Firefly recurring transactions or subscriptions.
- Subscription-management suggestions or recurring-transaction creation.
- Arbitrary forecast scenarios, budgets, investment recommendations, or machine-learning models.
- Replacing the existing analytics page or adding a chart dependency.
- Changing the category facet limit or Money Flow behavior in this correction.

## Rollback

The calculation allocation, Daily Forecast presentation, and Cash Use interaction are separable implementation commits. Each can be reverted independently. No data migration or persistent financial mutation is required.
