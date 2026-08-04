# Extended Analytics V3 Design

**Date:** 2026-08-03

**Status:** Approved section by section in conversation; awaiting approval of this written specification

**Branch:** personal/extended-analytics

**Supersedes:** The ordering, refund, balance-reconciliation, current-month presentation, forecast, FX-disclosure, and money-flow presentation sections of 2026-08-02-extended-analytics-forecast-money-flow-v2-design.md

## Summary

Extended Analytics V3 makes the existing analytics page financially consistent and easier to read, adds a recurring-aware daily current-month forecast, and adds an additive cash-use chart.

The implementation uses one normalized, transaction-backed analytics foundation for Money flow, Financial trends, Spending by category, the daily forecast, and the additive chart. Current balances are anchored to a fresh Firefly account snapshot. Refund cash, purchase cost, savings movement, liability movement, and ordinary asset movement remain distinct instead of being inferred from Firefly transaction type alone.

The work remains personal-fork scope. It adds no analytics database, no new chart dependency, and no external AI integration.

## User decisions improved

The page should answer these questions:

- What are total net worth, savings, and debt, and how did each change?
- What was spent, what is likely to be spent by month end, and how much of that forecast has already occurred?
- Which transactions produced any monthly value?
- Where did income and existing funds go?
- How much moved between Available and Savings?
- How much saving is included in net worth versus excluded from it?
- Which incoming transactions are refunds rather than ordinary income?
- What income and outflow are expected on each remaining day of the current month?
- After expenses, savings, and debt activity, was there a true excess or shortfall?

## Current implementation anchors

The design extends the existing implementation rather than introducing a second analytics architecture:

- front/pages/analytics.vue owns the page and shared analytics controls.
- front/stores/analyticsStoreFactory.js loads and projects analytics data.
- front/utils/AnalyticsUtils.js owns account classification, money-flow aggregation, category history, forecasts, and trend series.
- front/utils/ChartUtils.js lays out and renders the layered money-flow graph.
- front/components/analytics/analytics-balance-trends.vue renders Financial trends.
- front/components/analytics/analytics-category-spending.vue renders Spending by category and already carries transaction IDs on category points.
- front/components/analytics/analytics-money-flow.vue renders Money flow and its transaction details.
- front/components/charts/multi-series-line-chart.vue provides crosshair, point selection, and series interaction.
- front/stores/recurringTransactionStore.js and the recurring/subscription models provide Firefly-defined future activity.
- front/utils/TransactionFilterUtils.js and the transaction list route provide the existing drill-down path.

AnalyticsUtils.js may be divided into small, focused utilities where needed for the approved boundaries. This is a targeted separation of financial normalization, reconciliation, refund classification, recurring detection, and chart presentation, not a general refactor.

## Chosen architecture

### Considered approaches

1. Shared front-end analytics foundation. Normalize transactions and balances once, then project every card from the same contracts.
2. Patch each chart independently. This makes the first diff smaller but duplicates financial rules and allows charts to disagree.
3. Add backend analytics endpoints. This centralizes calculation but introduces API, caching, persistence, and deployment scope that Pico does not need for this personal feature.

The selected approach is the shared front-end foundation.

### Processing boundaries

The implementation has four presentation-independent boundaries:

1. **Analytics ledger:** normalizes transaction splits while retaining exact source evidence.
2. **Balance reconciler:** anchors current values to refreshed accounts and reconstructs historical month ends.
3. **Recurring detector:** produces reusable evidence-backed recurring candidates.
4. **Chart presenters:** convert those contracts into Money flow, trend, category, daily-forecast, and additive-chart series.

Every aggregate retains:

- dashboard-currency value or an explicit unavailable state;
- transaction and split identifiers;
- source and destination account identifiers;
- category;
- non-technical tags relevant to classification;
- account pool and savings group;
- refund classification and linkage;
- conversion method and affected currencies.

Technical lifecycle tags remain excluded from ordinary category and pattern analysis. The refund tag is a deliberate exception because it is a user-approved financial signal.

## Shared account classification

Classification is performed once and reused by balances, monthly changes, averages, forecasts, Money flow, and the additive chart.

### Net worth

Net worth is the signed sum of active Firefly balance-holding accounts currently marked include_net_worth.

The account population and sign convention must reconcile to Firefly's current net-worth view. Expense and revenue accounts never enter net worth. The current include_net_worth setting is applied across the displayed history because Firefly does not expose a history of that setting.

Credit-card accounts remain ordinary asset accounts. A negative credit-card balance reduces net worth, but the account never enters debt metrics or debt-flow nodes.

### Available

Available contains active asset and cash accounts that are not savings-role accounts. It includes credit-card assets, even when their signed balance is negative.

Transfers between Available accounts cancel in pool-level cash-flow analytics.

### Savings

Savings contains active asset accounts with Firefly role savingAsset.

The saved Savings view has two modes:

- **Unified:** all savings accounts together.
- **Split:** Accessible / included in net worth and Restricted / excluded from net worth.

The split is determined only by include_net_worth. In this personal fork, the labels communicate the owner's intended configuration: liquid savings are included and retirement or otherwise restricted savings are excluded. Pico does not infer accessibility from account names and does not edit the Firefly flag.

### Debt

Debt contains active Firefly liability accounts only. Credit cards are excluded.

Debt balances are displayed as non-negative magnitudes. A positive monthly debt change means debt magnitude increased; a negative change means it decreased. Normalization occurs per liability account before aggregation so accounts with opposite raw signs cannot cancel.

## Currency and valuation contract

The selected dashboard currency remains the only combined display currency.

- Native values use their exact amount.
- Foreign values use the latest trusted stored conversion rate.
- The same current rate is used across the displayed history; historical exchange-rate reconstruction is out of scope.
- Missing required rates make only the affected aggregate unavailable.
- Raw values from unlike currencies are never summed.

Each aggregate carries conversion metadata. Repeated card labels and the full-width Estimated at current rates row are replaced by one conditional page-level badge, such as USD · current FX.

The badge details:

- affected currencies and cards;
- dashboard currency;
- current-rate rather than historical-rate valuation;
- rate timestamp or age when available;
- missing-rate exclusions.

No badge appears when every value is native to the dashboard currency.

## Fresh balance snapshot and historical reconstruction

Balance metrics require an explicit account and current-period transaction refresh even when Pico's ordinary full-sync cache is still considered recent. The analytics ledger covers the requested history through the shared refresh date. The existing Laravel catch-all proxy remains sufficient for Firefly account, transaction, recurring, subscription, and transaction-link data; no analytics endpoint is added.

The balance snapshot has one common asOfDate equal to the successful refresh time. An account's current_balance_date is treated as its last balance-changing activity date, not as a requirement that every account share the same date.

For each included account:

1. Read its refreshed current signed balance.
2. Use normalized transaction movements after a requested historical month end.
3. Walk those movements backward from the current anchor.
4. Convert consistently using the approved current-rate contract.
5. Withhold a historical point when transaction coverage is insufficient.

The sum of reconstructed latest account balances must equal the refreshed account anchor within currency rounding tolerance. Reconciliation reports the account-level contribution and delta.

The existing same-date warning is removed. Different account activity dates do not create a warning. A single card-level error appears only for:

- refresh failure;
- missing account balance;
- missing conversion rate;
- insufficient transaction coverage; or
- a proven material mismatch between the refreshed anchor and reconstructed value.

Duplicate warning rows are not allowed. A missing or unverified balance is never replaced with zero or stale cached data.

## Refund classification and timing

### Detection

A deposit is classified as refund income when either condition is true:

- it has the user tag refund or #refund; or
- it participates in a Firefly refund transaction link.

Both signals on the same transaction are deduplicated. Classification details say Tag, Firefly link, or Tag and Firefly link.

Technical tags other than the approved refund tag do not participate.

### Cash timing

The cash receipt remains in the month received and flows through Refund income into the actual receiving pool.

Refund income is visually distinct from ordinary income through color plus a non-color pattern. It is never silently merged into new income.

### Purchase-cost timing

When a Firefly refund link identifies the original purchase:

- the purchase keeps its gross expense in the original purchase month;
- refund coverage is attributed to the linked purchase month and category;
- details show Gross purchase, Refunded, and Net cost.

When only a tag identifies the refund, Pico does not invent an original purchase. The cash leg remains classified as refund income. Coverage uses the refund transaction's category and receipt month when a category exists and is labelled unlinked; otherwise it remains Unlinked refund coverage.

Refund coverage is an analytical overlay and does not increase Sankey or stacked-area node totals. If linked refunds exceed gross purchase cost, Net cost becomes negative and the UI labels the remainder Refund surplus. Values are never clipped.

## Money flow

### Accounting intent

Money flow answers where new income, refunds, new debt, savings withdrawals, and existing available funds went during the selected month. It follows the immediate accounts on Firefly splits and does not claim to trace fungible historical dollars.

The central structure is sequential so Available-to-Savings thickness is readable:

~~~text
Sources -> Income/refund grouping -> Available -> Savings pools -> Uses -> Destinations
~~~

Direct income into Savings and direct Savings-funded outcomes retain their real immediate pool. Negative net saving or an Available shortfall is introduced as a left-side existing-funds source rather than drawn as a backward cycle.

### Sources

Left-side source families include:

- ordinary income categories;
- refund income;
- existing Available funds required;
- existing Accessible savings used;
- existing Restricted savings used;
- new debt by liability account.

Ordinary income categories first group into New income. Refund sources group separately into Refund income.

### Pools and uses

Central pools remain semantically ordered:

- Available;
- Accessible savings and Restricted savings in Split mode, or Savings in Unified mode;
- Expenses;
- Savings deposited;
- Debt repaid;
- New excess.

Expense ribbons retain whether they originated from Available, Savings, or new debt. Savings deposits divide into destination savings accounts. Debt repayment divides into destination liability accounts.

Positive net movement for a savings account appears on the right as savings deposited. Negative net movement appears on the left as existing savings used. Opposing account movements remain visible rather than being hidden by a global net.

Positive liability repayment appears on the right by liability account. Increased liability magnitude appears on the left as new debt.

### Available-to-Savings bridge

Gross Available-to-Savings and Savings-to-Available movements are reduced to the net directional bridge needed for the acyclic graph:

~~~text
net transfer to savings =
gross Available-to-Savings
- gross Savings-to-Available
~~~

A positive result renders Available to Savings. A negative result becomes existing Savings used feeding Available. Details preserve both gross directions and the net.

### Sorting and detail

The current value-weighted barycentric ordering reduces crossings but does not communicate category ranking. V3 uses:

- amount descending for income categories, refund sources, expense categories, savings accounts, and liability accounts;
- alphabetical order as a stable tie-breaker;
- Other always last;
- fixed semantic ordering for central pools and outcome families.

The persisted detail selector is Top 5, Top 10, or All. Top-N is calculated independently within each outer family and the remainder groups into Other without losing transaction IDs.

On mobile, only outer category layers may collapse when the measured width cannot preserve readable labels and touch targets. The central pools, source/use totals, and full drill-down list remain available.

### Rendering

Ribbons use restrained corner radii and visible gaps. Central bars are not oversized pills, and rounded ends may not visually merge Income, Available, or Savings.

Every node and ribbon preserves transaction IDs. Selecting one opens a labelled detail sheet and the exact transaction list.

Unsupported nonzero transitions remain in an unclassified audit. The graph is withheld rather than silently dropping or guessing those amounts.

## Financial trends

### Modes

Financial trends keeps two modes.

**Balances**

- Net worth;
- Savings, or its two Split-mode groups;
- Debt.

Completed points represent reconstructed month-end totals. Today remains a solid actual point. The end-of-month forecast follows today with a dashed segment.

**Monthly change**

- Net-worth change;
- Savings change, or its two Split-mode groups;
- Debt change;
- Total expense.

Total expense is available only in Monthly change. It means gross qualifying expense cash outflow. Refund coverage appears as secondary detail rather than silently reducing the cash-outflow series.

The unfinished today's point is not plotted in Monthly change. The final current-month forecast appears at month end and connects from the last completed month with a dashed segment for every selected metric.

### Completed history and zeros

The available windows are 3, 6, and 12 completed calendar months. The unfinished current month never contributes to an average.

A month within proven transaction coverage receives an explicit zero when no qualifying movement occurred. A month outside proven coverage remains unavailable. Missing and zero are never interchangeable.

### Average strip

Each selected metric shows a compact average over the selected completed-month window:

- Net-worth, Savings, and Debt use average monthly change.
- Total expense uses average gross monthly expense.

The strip replaces a full-width explanatory row. When only one metric is selected, a subtle average reference line may be shown; multi-metric mode relies on the labelled average values to avoid clutter.

### Current-month forecast presentation

Each forecast point and its summary expose:

- Forecast at month end;
- Actual so far;
- Remaining change from today;
- Percentage of forecast realized;
- Actual contributing transaction count.

For non-negative cumulative expense metrics:

~~~text
forecast final >= actual so far
remaining = forecast final - actual so far
progress = actual so far / forecast final
~~~

Progress is between zero and 100 percent because the final forecast is recalculated and cannot be lower than actual. When actual has already exceeded the completed-month average or the earlier baseline expectation, a separate Above historical average indicator communicates that fact. When both actual and forecast are zero, the UI says No expected activity instead of dividing by zero.

For signed Net-worth, Savings, and Debt changes, progress is shown only when actual and forecast move in the same direction and the forecast is nonzero. Otherwise the UI says Opposite direction or Not applicable. Remaining change may be positive or negative.

All available forecast series receive a forecast point and dashed segment, including explicit zero forecasts.

The recurring-aware remaining-activity engine is shared with the daily forecast:

- Total expense adds projected remaining gross expense to current gross expense.
- Savings change adds projected future movements affecting the selected savings accounts to actual current-month savings change.
- Debt change adds projected future liability-magnitude movements to actual current-month debt change.
- Net-worth change adds projected future signed movements affecting included accounts to actual current-month net-worth change. Transfers between two included accounts cancel; movement across the current inclusion boundary does not.
- A Balances forecast equals the refreshed current total plus its projected remaining signed movement.

When the recurring-aware engine has only partial inputs, the corresponding trend point is marked Partial forecast. It is withheld only when no defensible remaining estimate or exact zero can be established.

## Spending by category

The category card keeps 3, 6, 12, and 24 completed-month windows and a searchable category facet.

Historical category values mean gross qualifying expense outflow. Refund coverage is displayed as a patterned portion and in Gross / Refunded / Net cost details without changing the gross plotted value.

Every selected category receives:

- a point for each covered completed month, including explicit zero;
- completed-month average;
- current actual;
- end-of-month forecast;
- remaining from today;
- forecast progress;
- exact transaction IDs.

The unfinished current-month actual is removed as a plotted point. The month-end forecast connects from the final completed point with a dashed segment. Its tooltip includes the clickable Actual so far transaction set.

Expense and category forecasts cannot finish below actual spending already recorded.

## Crosshair and drill-down

Line and area charts retain the vertical crosshair. Mouse hover or touch drag shows the amounts for every selected series at the aligned month or day.

Tap freezes the tooltip. Each actual row exposes View N transactions. A second tap, close control, or outside tap dismisses it.

Monthly-change transaction sets contain the normalized transaction IDs that produced that metric:

- Total expense: qualifying gross expense splits;
- Savings: movements affecting the selected savings accounts;
- Debt: movements affecting liability magnitude;
- Net worth: balance-changing transactions affecting included accounts, deduplicated by transaction ID.

Balance points open an account-composition view. Their month movement action opens the transactions between the previous and selected month ends.

## Reusable recurring-pattern detector

The recurring detector is a pure utility with no chart or Vue dependency.

Its output contains:

- stable candidate identity;
- direction and cadence;
- expected date or date range;
- expected amount and observed range;
- source and destination account evidence;
- category and normalized payee or description;
- confidence and human-readable reasons;
- Firefly-defined or history-inferred source;
- supporting transaction IDs;
- matching information used to identify fulfillment.

Firefly recurring transactions and subscriptions are authoritative when they expose usable future occurrence information. A history candidate overlapping a Firefly definition is merged into it and may add evidence, but never creates a second forecast occurrence.

An inferred candidate is forecast-eligible only when it has:

- at least three matched occurrences in distinct expected cycles;
- occurrences in at least 60 percent of eligible cycles within the selected window;
- a stable direction and account/category/payee signature on at least 80 percent of matches;
- an inferred weekly, biweekly, monthly, or twice-monthly cadence;
- date median absolute deviation of no more than four days for monthly clusters; and
- relative amount median absolute deviation of no more than 25 percent.

The detector uses robust medians and observed ranges rather than requiring exact amounts. Confidence reasons expose frequency, cadence, date dispersion, amount dispersion, and identity stability. Thresholds are deterministic constants covered by tests, not hidden model behavior.

An actual current-month transaction fulfills its matching expected occurrence. Fulfilled occurrences are not forecast again.

The detector contract is intentionally reusable by a future review flow that suggests creating Firefly subscriptions or recurring transactions. Suggestion review and Firefly creation are out of scope for V3.

## Daily current-month forecast

### Decision question and chart

The separate daily card answers what income and outflow are expected on each remaining day and how available cash is likely to change.

It offers 3, 6, and 12 completed-month history windows and defaults to 6. Changing this selector recalculates inferred candidates and variable activity but does not change Firefly-defined future occurrences.

It renders:

- daily income bars above zero;
- daily outflow bars below zero;
- a cumulative Available-cash-change line starting at zero on the first day;
- solid actuals through today;
- dashed estimates after today.

The line is a monthly change, not an account-balance forecast:

~~~text
Available-cash change =
ordinary income
+ refund receipts
+ savings withdrawals
+ new debt
- expenses
- savings deposits
- debt repayments
~~~

Transfers between Available accounts cancel.

### Forecast calculation

The current incomplete month never contributes to historical averages.

For every classified flow:

~~~text
forecast final =
actual so far
+ unmatched Firefly-defined future occurrences
+ unmatched high-confidence inferred occurrences
+ expected remaining variable activity
~~~

Known recurring activity is matched and removed before the variable historical baseline is calculated. This prevents double counting.

Expected remaining variable activity is derived from the selected completed-month window after recurring matches are removed. It is distributed over remaining days using observed day-of-month and weekday weighting when coverage supports that profile; otherwise it is distributed evenly and labelled lower confidence.

An expected occurrence that is past due but unmatched remains in the forecast. It moves to the next plausible future day using observed date dispersion and weekday behavior. A rent payment does not disappear merely because its usual first- or second-day occurrence was delayed by a weekend.

When no historical shift evidence exists, an overdue Firefly-defined occurrence is placed on the next forecast day and labelled Overdue rather than being discarded.

For gross expense:

~~~text
forecast final = actual expense + non-negative expected future expense
~~~

It can never fall below actual. Signed savings, debt, and net-worth forecasts may legitimately move below today's change because future transactions can reverse their direction.

Tooltips distinguish:

- Firefly defined;
- History pattern;
- Variable baseline;
- Actual.

When only Firefly-defined events are available, Pico shows a partial forecast. When neither definitions nor sufficient history are available, it shows Insufficient history instead of zero.

## Additive spending and cash-use chart

### Modes and formulas

The chart has two explicit modes.

It offers 3, 6, 12, and 24 completed-month display windows. The current-month forecast is appended without contributing to the selected completed-month window or category ranking average.

**Spending only**

~~~text
uses = gross expenses by category
sources = ordinary income + refund receipts
gap = income remaining after expense cash flow
~~~

The gap is labelled After spending, not true excess.

**Full cash use**

~~~text
uses =
gross expenses by category
+ net savings deposited
+ debt repaid

sources =
ordinary income
+ refund receipts
+ savings withdrawn
+ new debt
~~~

When sources exceed uses, the difference is New excess. When uses exceed sources, the difference is Existing available funds required.

### Presentation

- Expense categories form additive stacked areas.
- Savings deposits and debt repayments add use layers in Full cash use.
- Ordinary income is a solid line.
- Refunds, savings withdrawals, and new debt form distinct source bands above income.
- The total-sources boundary is explicit.
- The gap between total uses and total sources is green excess or red shortfall with pattern and text in addition to color.

Gross expense stays in the category area. Refund cash appears in its receipt month as a source. Refund coverage overlays the original purchase month without changing area height.

The category facet, search, and Top 5 / Top 10 / All behavior are shared with Spending by category. Stack order is stable across the period and ranks categories by total period amount. Other remains last.

Savings layers follow the Unified or Split savings view. Debt layers use liability accounts only.

The current month has an end-of-month forecast point, not a today's dip. Its crosshair exposes every component, total uses, total sources, gap, actual so far, forecast progress, and transaction drill-down.

## Page-wide UX

### Navigation and controls

The Analytics entry uses the existing Tabler chart icon style in the desktop sidebar and applicable mobile navigation.

The page header owns compact shared controls for:

- period;
- dashboard currency;
- refresh state;
- Savings view.

Cards own only controls specific to their question. Existing local-storage patterns persist period, selected metrics, category detail, Savings view, and cash-use mode.

### Responsive behavior

Mobile uses compact cards, horizontally scrollable control rows where appropriate, and facet sheets for long lists. Desktop retains dense legends, aligned values, and full labels.

The app's existing isDesktopLayout decision remains authoritative. CSS media queries do not replace the separate layout branches.

Money-flow outer layers collapse only after measured readability thresholds fail. The daily and additive charts keep touch targets and tooltips readable without requiring horizontal page scrolling.

### Loading and errors

The shared normalized data is calculated once per refresh and reused. Cards project independently and may load or fail independently.

User-visible states distinguish:

- no qualifying transactions;
- incomplete history;
- partial forecast;
- missing exchange rate;
- reconciliation failure;
- network or refresh failure.

One concise message appears per affected card. Duplicate messages are forbidden. Details and retry actions are provided where useful.

### Visual language and accessibility

The page follows Pico's existing Vant-based finance design:

- compact typography;
- 6-10px card radii;
- restrained shadows;
- theme variables;
- light and dark overrides;
- existing animation preference;
- localized labels in every supported locale.

Refund, actual, forecast, excess, and shortfall use dash, pattern, shape, or labels in addition to color. Crosshair values are exposed through accessible announcements. Frozen tooltips and drill-down rows are keyboard reachable on desktop.

## Error and audit behavior

Every normalized amount is either included exactly once, cancelled by an explicit internal-transfer rule, or listed in an audit bucket.

The analytics foundation exposes:

- classified value by flow family;
- unclassified value and transaction IDs;
- missing-rate currencies and transaction IDs;
- covered and unavailable months;
- current balance anchor and reconstructed total;
- rounding delta;
- refund classifications and unmatched links;
- recurring occurrence matches and suppressions.

Cards with a nonzero unexplained audit delta are withheld. Pico never hides a mismatch with a correction value.

## Delivery slices

Implementation remains on personal/extended-analytics and is divided into four independently verifiable slices:

1. **Financial truth foundation:** normalized ledger, refund inputs, fresh account snapshot, balance reconstruction, reconciliation, and FX metadata.
2. **Money flow:** sequential pools, amount ordering, Available-to-Savings bridge, refund presentation, and Unified/Split savings.
3. **Trends and cash-use analysis:** zero points, completed averages, forecast-point UX, drill-down, Spending by category changes, and additive chart.
4. **Daily forecast:** reusable recurring detector, Firefly/inferred matching, variable remainder, and daily chart.

Each slice has a focused commit and rollback boundary. A later slice may depend on an earlier contract, but no slice may duplicate or override the shared financial definitions.

## Personal-fork and upstream boundary

The complete V3 result is personal-fork scope.

Potential generic upstream slices:

- normalized period aggregation;
- balance-reconciliation helpers;
- amount-ranked layered-graph layout;
- chart crosshair freezing and transaction drill-down;
- configurable Savings grouping;
- conditional FX disclosure;
- recurring-candidate data contract.

Fork-first or experimental policy:

- Accessible/Restricted interpretation of include_net_worth;
- refund-coverage overlay;
- exact recurring-confidence heuristics;
- daily forecast policy;
- default chart visibility and ordering.

Nothing is pushed, published, or proposed upstream without separate user approval.

## Verification

### Automated financial fixtures

Tests cover:

- Available-to-Available and Savings-to-Savings internal transfers;
- Available-to-Savings and Savings-to-Available movement;
- savings deposits, withdrawals, and opposing account movements;
- liability borrowing and repayment;
- negative credit-card assets excluded from Debt;
- split transactions and exact transaction-ID preservation;
- refund tag, Firefly link, both signals, cross-month link, tag-only fallback, and refund surplus;
- native and converted currencies, plus missing rates;
- different account activity dates;
- current anchor and account-level net-worth reconciliation;
- covered zero months and missing history;
- completed-month averages excluding the current month;
- explicit zero forecasts and dashed forecast availability;
- expense forecast never below actual;
- signed progress in same and opposite directions;
- additive source/use equality, excess, and shortfall;
- Firefly recurrence overriding inferred duplicates;
- delayed expected transactions;
- fulfilled occurrence suppression;
- insufficient-history partial forecasts;
- amount sorting, alphabetical ties, and Other placement.

### Repository checks

The implementation plan must run and record:

- the focused analytics test suite;
- localized JSON parsing and analytics-key parity;
- scoped ESLint and Prettier checks for touched files;
- npm run build from front;
- git diff --check;
- the read-only contribution preflight.

Whole-repository lint failures unrelated to the changed files remain an explicitly reported baseline and are not silently attributed to V3.

### Runtime and browser checks

Use the standalone local Docker build path appropriate to this checkout. Confirm the built application serves /analytics successfully.

Inspect with a real browser:

- desktop and mobile layout branches;
- light and dark themes;
- hover, touch drag, frozen tooltip, keyboard access, and drill-down;
- Top 5, Top 10, and All;
- Unified and Split savings;
- Spending only and Full cash use;
- responsive Money-flow detail collapse;
- actual, forecast, partial, empty, missing-FX, and failure states;
- conditional page-level FX badge;
- no duplicate reconciliation warning.

On current real data, compare Pico's refreshed net worth with Firefly's simultaneously displayed value and capture the account-level reconciliation. Do not hard-code the previously observed amount because balances change over time.

## Acceptance criteria

V3 is complete when:

1. Pico's refreshed current net worth reconciles to Firefly's current display or presents one evidence-backed account-level mismatch.
2. Credit cards do not enter Debt calculations anywhere.
3. Covered no-activity months render explicit zero points.
4. Current incomplete months do not contribute to historical averages.
5. Monthly-change and category charts omit the today's dip and show an end-of-month forecast with actual, remaining, and progress.
6. Every selected forecastable metric receives a dashed forecast, including zero.
7. Money-flow outer categories are amount sorted and Available-to-Savings thickness is visible.
8. Refund cash is distinct from income and linked refund coverage is visible without corrupting cash timing.
9. Savings can be viewed Unified or split by net-worth inclusion throughout balances, changes, and flows.
10. Monthly-change and category values drill into their exact transaction sets.
11. The daily chart combines actuals, Firefly-defined activity, inferred recurring activity, and variable remainder without double counting.
12. The recurring detector exposes reusable evidence and has no chart dependency.
13. The additive chart reconciles sources, uses, and excess or shortfall.
14. FX disclosure appears once and only when relevant.
15. Mobile and desktop, light and dark, touch and pointer interactions are readable and functional.
16. Focused automated tests and production build pass, with unrelated baseline failures reported separately.

## Non-goals

- Historical exchange-rate retrieval.
- A persisted analytics warehouse or new analytics backend service.
- Editing account roles or include_net_worth from Analytics.
- AI or LLM-based recurring detection.
- Automatically creating Firefly subscriptions or recurring transactions.
- Holiday-calendar integration.
- Tracing a specific income dollar through later spending.
- Changing Firefly ledger data.
- Publishing or opening an upstream pull request.
