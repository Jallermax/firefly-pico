# Extended Analytics Forecast and Money Flow V2 Design

**Date:** 2026-08-02

**Status:** Approved in conversation; awaiting approval of this written specification

**Branch:** `personal/extended-analytics`
**Supersedes:** The forecast, debt-membership, savings-grouping, and money-flow sections of `2026-08-01-extended-analytics-design.md`

## Summary

This amendment corrects the implemented analytics forecast model, changes debt membership so credit cards are regular asset accounts, adds a combined-versus-split savings view, and replaces the flat Money flow bus with an auditable layered graph.

The work remains personal-fork functionality. It uses Pico's existing Firefly III account-chart and transaction data, adds no database schema or backend route, and adds no chart dependency.

## User-visible problems being addressed

1. The Analytics sidebar item has no visible icon.
2. `Estimated at current rates` consumes a full row without explaining the implication.
3. Identical current-balance validation messages may render more than once.
4. The current expense forecast can be materially below the completed-month average when little has been spent early in the current month.
5. Forecast points show only the end-of-month value, not the expected movement from today.
6. An expense forecast can be lower than spending already recorded in the current month.
7. A regular category such as Housing can forecast zero when its usual early-month transaction has not arrived yet.
8. Round-ended Money flow strokes overlap the Available bus and each other.
9. Money flow lacks income-category, expense-category, savings-account, and liability-account breakdowns.
10. Credit-card assets are incorrectly treated as debt.
11. Money flow does not distinguish Available from Savings funding or represent existing funds used.
12. Savings cannot be compared as combined savings versus savings included in or excluded from net worth.

The responsive graph must also allow a persisted Top 5, Top 10, or All detail level. Mobile may collapse outer breakdown layers when showing them would make labels or touch targets unreadable.

## Goals

- Make every forecast explainable from completed history and current actuals.
- Never forecast an expense total below the amount already spent.
- Preserve expected recurring spending even when the current month's transaction has not yet posted.
- Show both the forecast end-of-month value and the expected movement from today.
- Use one explicit account classification consistently across charts, averages, forecasts, and Money flow.
- Show which immediate account pool funded an outcome without pretending to trace fungible money across time.
- Preserve opposing savings-account movements and gross per-liability increases and repayments instead of hiding them in a global net.
- Keep the graph readable on mobile and information-dense on desktop.
- Reconcile the visible graph to exact values and contributing transactions.

## Non-goals

- Machine-learning, seasonal, weekday, or recurring-transaction prediction.
- FIFO, proportional, or other historical tracing of specific income dollars into later expenses.
- Historical exchange-rate reconstruction.
- A new backend analytics endpoint or persisted analytics database.
- Editing Firefly account roles or net-worth inclusion from the Analytics page.
- Displaying every breakdown node simultaneously when that would make the mobile graph unreadable.

## Account classification

### Net worth

Net worth is the signed aggregate of active balance-holding accounts whose `attributes.include_net_worth` value is true.

Credit-card accounts remain asset accounts. Their signed balance can reduce net worth when negative, but they never enter the Debt metric or debt-flow nodes.

### Savings

Savings consists of active asset accounts whose `attributes.account_role.fireflyCode` is `savingAsset`.

The shared Savings view has two persisted modes:

- **Combined:** one Savings series and one savings flow assembled from every savings-role account.
- **By net-worth inclusion:** separate groups for savings accounts whose `include_net_worth` value is true and false.

The split is labelled `Included in net worth` and `Excluded from net worth`. It does not claim that either group is liquid, retirement-only, or otherwise available for a particular purpose; the Firefly flag is the sole grouping rule.

### Debt

Debt consists of every active account whose Firefly account type is `liabilities`, regardless of liability direction. Credit-card asset roles are excluded.

Debt totals are presented as non-negative magnitudes. A positive monthly debt change means the magnitude increased; a negative change means it decreased.

Normalization occurs per liability account before aggregation, so liabilities with opposite raw signs cannot cancel:

| Liability direction | Historical chart value | Current validation value |
| --- | --- | --- |
| `debit` | Absolute converted signed account contribution | Absolute converted `current_debt`; fall back to `current_balance` when `current_debt` is blank |
| `credit` | Absolute converted signed account contribution | Absolute converted `current_debt`; fall back to `current_balance` when `current_debt` is blank |
| Missing or unknown | Absolute converted signed account contribution | Absolute converted `current_debt`; fall back to `current_balance` when `current_debt` is blank |

Zero remains zero. A missing or non-convertible value is unavailable rather than coerced to zero. This all-liability rule is deliberate even though Firefly describes credit-direction liabilities differently from debit-direction liabilities.

## Completed-history windows

All averages use completed calendar months ending immediately before the current month. The unfinished current month never contributes to an average.

- Financial trends: 3, 6, or 12 completed months.
- Spending by category: 3, 6, 12, or 24 completed months.
- Months after the transaction ledger begins but without a matching category amount contribute an explicit zero.
- A forecast requires at least two completed months.

## Expense forecast model

The forecast is calculated independently for every category, including categories not currently selected in the Spending by category facet.

For one history window, `every category` means the union of category IDs found in the selected completed months or current month after the shared analytics transaction-exclusion filter. Expense splits without a category use the existing uncategorized sentinel. Excluded transactions do not establish a category, contribute to its average, or contribute to the total forecast.

For category `c`, completed-history months `H`, and today's calendar day `D`:

```text
average(c) =
  sum(net spending for c in H) / count(H)

actual(c) =
  current-month net spending for c through D

averageHistoricalRemainder(c) =
  sum(net spending for c after D in H) / count(H)

pacedForecast(c) =
  actual(c) + averageHistoricalRemainder(c)

endOfMonthForecast(c) =
  max(actual(c), average(c), pacedForecast(c))

remainingFromToday(c) =
  endOfMonthForecast(c) - actual(c)
```

Net spending is expense purchases minus refunds in the month and category where they occur.

The three-way maximum has distinct purposes:

- `actual` prevents a forecast below spending already recorded.
- `average` preserves expected recurring obligations that usually post before today's day-of-month but have not posted this month.
- `pacedForecast` preserves historically expected spending after today when current spending already meets or exceeds the average.

`remainingFromToday` is therefore always non-negative for expenses.

Total-expense values are derived as follows:

```text
totalActual = sum(actual(c) for all categories)
totalAverage = sum(average(c) for all categories)
totalEndOfMonthForecast = sum(endOfMonthForecast(c) for all categories)
totalRemainingFromToday = totalEndOfMonthForecast - totalActual
```

The total forecast must not apply one aggregate maximum. Summing category forecasts ensures that overspending in one category does not erase an expected but not-yet-posted category such as Housing.

## Account-balance and monthly-change forecasts

For Net worth, each visible Savings group, and Debt:

```text
completedChange(month) =
  monthEndTotal(month) - monthEndTotal(previous month)

averageCompletedChange =
  mean(completedChange for the selected completed window)

forecastMonthlyChange =
  averageCompletedChange

forecastMonthEndTotal =
  previousCompletedMonthEndTotal + forecastMonthlyChange

remainingFromToday =
  forecastMonthEndTotal - currentTotal

equivalently in Monthly change view:
  remainingFromToday = forecastMonthlyChange - currentPartialChange
```

Unlike expense remaining values, balance remaining values may be positive or negative because balances can move in either direction.

An unchanged current value or zero forecast remains an explicit chart point.

## Financial trends UX

A compact page-level control applies to Financial trends and Money flow:

```text
Savings view: Combined | By net-worth inclusion
```

Financial trends retains:

- `Balances | Monthly change` views;
- 3M, 6M, and 12M completed-history selectors;
- a selectable metric facet;
- solid completed history;
- a visibly partial current point; and
- dashed end-of-month forecast segments for every selected metric with an available forecast.

In split savings mode, the single Savings metric is replaced by `Savings included in net worth` and `Savings excluded from net worth`. Stored selections are repaired so switching modes cannot leave the facet empty.

At a forecast point, the chart crosshair, tooltip, accessible announcement, and summary show two values:

```text
End-of-month forecast     2,500 USD
From today               +1,300 USD
```

The plotted y-value is the end-of-month total in Balances view and the final monthly change in Monthly change view. The secondary value explains the expected movement from the current actual to that point.

Total expenses remains available only in Monthly change view.

## Spending by category UX

The category facet and 3M, 6M, 12M, and 24M selectors remain.

Each selected category presents:

- completed-month average;
- current actual;
- end-of-month forecast; and
- remaining from today.

Desktop uses an aligned summary table. Mobile uses stacked labelled values without a minimum-width table. Selecting a forecast point opens the existing details sheet with the revised formula inputs and both forecast values.

## Compact exchange-rate qualification

The full-width `Estimated at current rates` row is removed.

When current-rate conversion affects a card, its header shows a compact `FX: current rates` badge. `How this is calculated` explains that foreign-currency values use the latest stored exchange rates rather than historical rates. Point tooltips retain a concise current-FX qualifier where applicable.

Missing required rates omit affected values and produce one grouped warning. Missing values are never converted to zero.

## Balance validation messages

Current account totals continue to be compared with compatible account-chart samples. Validation remains visible because it protects the chart's accounting integrity.

Messages are aggregated by reason and relevant dates, deduplicated, and labelled with affected metrics. For example:

```text
Current balance cross-check unavailable for Net worth and Savings.
```

An unavailable same-date sample is a data-quality notice. A confirmed material value mismatch remains a prominent warning. Repeated identical rows are not allowed.

## Analytics navigation icon

The existing `IconChartLine` Analytics constant is registered with the app's Tabler icon plugin and rendered through the same sidebar component, size, stroke, and active-state treatment as other navigation icons.

## Money flow accounting boundary

Money flow follows the immediate accounts recorded on transaction splits. It does not attempt to trace historical income dollars.

Examples:

- Income deposited into a savings-role account: `Income -> Savings`.
- Income deposited into checking: `Income -> Available`.
- Expense paid from savings: `Savings -> Expenses`.
- Expense paid from checking, cash, or a credit-card asset: `Available -> Expenses`.
- Debt payment sourced from savings: `Savings -> Debt paid`.

Credit-card purchases therefore remain Available-funded expenses even when the card's signed asset balance becomes negative.

Each split endpoint is classified as `revenue`, `expense`, `available`, `savings`, `debt`, or `other`. Available includes active asset and cash accounts that are not savings-role accounts, including credit-card assets.

The supported transition table is explicit:

| Source | Destination | Graph route |
| --- | --- | --- |
| Revenue | Available | Income category -> New income -> Available |
| Revenue | Savings | Income category -> New income -> Savings |
| Revenue | Debit-direction liability | Income category -> New income -> Debt paid -> liability account |
| Revenue | Credit-direction liability | Income category -> New income -> Liability extended -> liability account |
| Available | Expense | Available -> Expenses -> expense category |
| Savings | Expense | Savings -> Expenses -> expense category |
| Debit-direction liability | Expense | New debt by liability account -> Expenses -> expense category |
| Credit-direction liability | Expense | Liability collected by account -> Expenses -> expense category |
| Expense | Available | Refund category -> Available |
| Expense | Savings | Refund category -> Savings |
| Expense | Debit-direction liability | Refund category -> Debt paid -> liability account |
| Expense | Credit-direction liability | Refund category -> Liability extended -> liability account |
| Available | Savings | Available-to-Savings transfer input |
| Savings | Available | Savings-to-Available transfer input |
| Available | Debit-direction liability | Available -> Debt paid -> liability account |
| Savings | Debit-direction liability | Savings -> Debt paid -> liability account |
| Available | Credit-direction liability | Available -> Liability extended -> liability account |
| Savings | Credit-direction liability | Savings -> Liability extended -> liability account |
| Debit-direction liability | Available | New debt by liability account -> Available |
| Debit-direction liability | Savings | New debt by liability account -> Savings |
| Credit-direction liability | Available | Liability collected by account -> Available |
| Credit-direction liability | Savings | Liability collected by account -> Savings |
| Same pool | Same pool | Internal transfer; no pool-level flow |
| Liability | Liability | Internal liability reallocation detail; no outer source or destination |

A direct Liability-to-Expense split remains visibly liability-funded; it does not pass through an invented Available account. Direct Revenue-to-Liability and Expense-to-Liability splits also retain their funding source and direction-aware outcome.

A liability with a missing or unknown direction remains included in Debt balance charts but its nonzero transaction movement is placed in the `unclassified` Money flow audit. The graph is withheld rather than guessing a cash-flow direction.

Any nonzero transition involving `other`, a missing account endpoint, or another unsupported combination is retained in an `unclassified` audit bucket. It cannot silently disappear. The visible graph is withheld until the unclassified amount is zero within currency tolerance.

## Money flow graph model

The current flat `sources[]` and `destinations[]` contract is replaced by a layered graph:

```js
{
  nodes: [{ id, layer, kind, refId, value, transactionIds }],
  links: [{ id, sourceId, targetId, value, transactionIds, fundingPool, kind }],
  pools: {
    available: { incoming, outgoing, net },
    savings: { incoming, outgoing, net },
  },
  audit: {},
  isBalanced: true,
}
```

`fundingPool` preserves whether an outcome came from Available or Savings even when both paths meet at a common Expenses or Debt paid node.

The logical layers are:

```text
income categories -> New income -> Available / Savings
refund categories ----------------> Available / Savings
new debt / liability collected ---> Available / Savings
existing available funds ---------> Available
existing savings by account ------> Savings

Available / Savings -> Expenses -> expense categories
New debt / liability collected -> Expenses -> expense categories
Available / Savings -> Debt paid / Liability extended -> liability accounts
New income / refunds -> Debt paid / Liability extended -> liability accounts
Savings             -> Savings deposited -> savings accounts
Available           -> New excess
```

### Income labels

Income source labels use this fallback order:

1. Firefly category;
2. revenue-account name; and
3. `Uncategorized income`.

### Expenses and refunds

Purchases and refunds are netted within each `(expense category, immediate pool)` pair:

```text
netExpense(category, pool) =
  purchases paid from pool into category
  - refunds returned from category into pool
```

- A positive pair net follows `pool -> Expenses -> expense category`.
- A negative pair net follows `Refund category -> pool`.
- The user-facing category total is the sum of its Available and Savings pair nets.

The same category may therefore have a positive expense path from one pool and a refund-source path into the other pool. Both remain visible because collapsing them globally would lose the approved immediate-account attribution.

Direct Debt-to-Expense purchases and Expense-to-Debt refunds remain separate gross paths because neither has an Available or Savings pool endpoint. The user-facing category net still includes them.

The common Expenses details preserve `from Available`, `from Savings`, and `from new debt` subtotals.

### Available and Savings transfers

Gross Available-to-Savings and Savings-to-Available transfers are reduced to one net directional bridge for the selected month:

```text
netTransferToSavings =
  gross Available-to-Savings - gross Savings-to-Available
```

Only the positive direction is rendered. This avoids a visual cycle while retaining pool conservation.

Savings-to-savings and Available-to-Available transfers cancel as internal reallocations at the pool level. Their account effects still contribute to per-account net savings detail where relevant.

### Savings account movement

Savings movement is netted per savings account, not globally.

- A positive account movement appears on the right under Savings deposited.
- A negative account movement appears on the left under Existing savings used.
- The summary shows positive movement, negative movement, and combined net movement.

Opposite account directions remain visible. For example, `HYSA +1,000` and `HSA -500` are both shown while the summary reports `Net savings +500`.

In split savings mode, these account nodes and summaries are grouped by net-worth inclusion.

### Liability account movement

Liability movement retains gross direction-aware activity per liability account.

- For a debit-direction liability, value leaving the account increases its magnitude and appears as New debt; value entering reduces it and appears as Debt paid.
- For a credit-direction liability, value leaving reduces its magnitude and appears as Liability collected; value entering increases it and appears as Liability extended.
- The same liability account may appear in both directions during one month; neither external path is discarded.
- Debt paid and Liability extended divide into their destination liability accounts.
- Liability-to-liability transfers are omitted from the outer funding equation but remain visible in a `Liability reallocations` detail with both accounts and the exact transaction. They do not inflate the New debt or Debt paid headline.

The summary reports:

```text
liabilityIncrease =
  debit-direction New debt
  + credit-direction Liability extended

liabilityReduction =
  debit-direction Debt paid
  + credit-direction Liability collected

netDebtChange = liabilityIncrease - liabilityReduction
```

Credit-card assets are not included in any of those values.

### Available residual

Available is balanced globally after classified income, refunds, new debt, expenses, debt payments, and the net Savings bridge.

- A negative Available net becomes `Existing available funds used` on the left.
- A positive Available net becomes `New excess` on the right.

These labels describe the transaction-derived pool residual. The reconciliation details expose every component instead of presenting the residual as a separately observed account balance.

### Pool equations

For pool `p`, direct flows use the transition table above and the net Available/Savings bridge is included once in its rendered direction:

```text
baseIncoming(p) =
  incomeToPool(p)
  + refundsToPool(p)
  + newDebtToPool(p)
  + liabilityCollectedToPool(p)
  + netBridgeInto(p)

baseOutgoing(p) =
  expensesFromPool(p)
  + debtPaidFromPool(p)
  + liabilityExtendedFromPool(p)
  + netBridgeOutOf(p)
```

For each savings account `a`:

```text
netSavingsAccount(a) =
  all classified value entering a
  - all classified value leaving a

savingsDeposited(a) = max(netSavingsAccount(a), 0)
existingSavingsUsed(a) = max(-netSavingsAccount(a), 0)
```

Savings pool conservation is:

```text
baseIncoming(Savings) + sum(existingSavingsUsed(a))
=
baseOutgoing(Savings) + sum(savingsDeposited(a))
```

Available is balanced globally:

```text
availableNet =
  baseIncoming(Available) - baseOutgoing(Available)

newExcess = max(availableNet, 0)
existingAvailableFundsUsed = max(-availableNet, 0)

baseIncoming(Available) + existingAvailableFundsUsed
=
baseOutgoing(Available) + newExcess
```

Direct Revenue-to-Liability, Expense-to-Liability, and Liability-to-Expense routes bypass the two pools but must conserve their own common graph nodes and remain included in the complete source/destination audit.

## Money flow reconciliation

The utility reconciles both account pools and the complete graph within the display currency's rounding tolerance.

At the outer graph boundary:

```text
totalSources =
  newIncome
  + netRefundSources
  + newDebt
  + liabilityCollected
  + existingAvailableFundsUsed
  + existingSavingsUsed

totalDestinations =
  expenses
  + debtPaid
  + liabilityExtended
  + savingsDeposited
  + newExcess

totalSources = totalDestinations
```

The net Available/Savings bridge is internal and therefore appears in both pool audits but not in the outer totals.

Every non-residual node and link retains exact contributing transaction IDs. `Other` retains the union of its hidden members and their drilldowns.

If pool or total conservation fails:

- the visual graph is withheld;
- the exact audit remains visible;
- missing currencies or unclassified values are identified; and
- no unexplained balancing node is silently inserted.

Existing dashboard transaction exclusions continue to apply consistently to spending and Money flow.

## Money flow responsive presentation

### Detail control

Money flow has a persisted `Graph detail` control:

- Top 5, the default;
- Top 10; or
- All.

The limit applies independently to each breakdown group. Members are ranked by descending absolute display-currency value with the stable entity ID as the tie-breaker. Hidden members are combined into `Other` separately for each parent path, graph side, funding pool, movement sign, and savings-inclusion group; incompatible flows are never mixed into one Other node. `Other` is absent when every member is visible. Selecting any node opens a complete exact list regardless of the visible detail level.

### Desktop

Desktop uses a left-to-right layered graph. The chart grows vertically when the selected detail level adds nodes. It does not compress labels below the established readable spacing.

### Mobile

Mobile uses a top-to-bottom graph with Available and Savings beside each other in the pool layer.

The renderer first attempts the selected Top 5, Top 10, or All level. It may grow vertically, but it must preserve at least 28 CSS pixels between adjacent label baselines and a non-overlapping 44-by-44 CSS-pixel transparent interaction target for every visible node. If the outer income-category or destination-detail layers cannot meet both constraints at the available card width, mobile renders the condensed common-node graph instead:

```text
New income / Existing funds / Liability sources
                  -> Available / Savings
                  -> Expenses / Savings deposited / Liability outcomes / New excess
```

The common nodes remain selectable and open the complete category/account breakdown. A compact notice explains that graph details were condensed for mobile. Accounting values and reconciliation do not change; only visible graph detail changes.

### Geometry and styling

- Use filled closed ribbons rather than proportional stroked curves.
- Ribbon endpoints are square where they meet node bars.
- Gentle curves are limited to travel between layers.
- Widths share one proportional scale and cannot independently overfill a pool.
- Tiny values use larger transparent interaction targets instead of distorted accounting widths.
- Stable value-based node ordering minimizes crossings.
- Available and Savings are distinct parallel bars.
- Semantic colors use existing Pico variables and work in both themes.
- No horizontal scrolling is required inside the card.

### Interaction and accessibility

- Hover, keyboard focus, or touch highlights the selected node and directly connected ribbons while dimming unrelated paths.
- Selection opens a compact details sheet with exact constituent values and transaction drilldowns.
- Every node and link relationship has an accessible source, destination, and amount label.
- Exact values and Reconciliation remain collapsed below the graph.
- Motion is subtle and respects the profile's animation setting.

## Data flow and implementation boundaries

No backend change is required.

`AnalyticsUtils.js` remains the pure deterministic boundary for:

- account groups and savings segmentation;
- expense forecast calculation;
- account forecast calculation;
- layered Money flow aggregation; and
- pool and total reconciliation.

The analytics store:

- persists the Savings view and Graph detail settings;
- requests Net worth, Savings included, Savings excluded, and Debt account groups;
- skips empty groups;
- combines the two savings series client-side in Combined mode;
- makes no fifth unified-savings request;
- continues to load the transaction window once for category and Money flow analytics; and
- groups validation messages before presentation.

Combined Savings aligns the two constituent series on the union of returned dates. Each non-empty constituent carries its most recent value forward only after its own first valid point. A combined point exists only when every non-empty constituent has a valid value at that date. Empty account groups contribute zero. If either non-empty constituent request fails or requires a missing currency rate, Combined Savings is unavailable rather than partially summed; retained complete data may remain visible as stale.

At most four primary non-empty range requests are made for one balance window. The existing current-point recovery may issue one additional 1D current-month request for each non-empty group whose current account fields are incomplete, for a worst case of eight account-chart HTTP requests. These fallbacks use the same four logical groups and never create a fifth unified-savings request.

The existing line-chart component retains its inspection model and gains secondary forecast-detail metadata. The Money flow SVG consumes graph nodes and links instead of flat source/destination arrays.

All labels are localized in every supported locale. Shared styles remain in the established light and dark theme files; no scoped styles are added.

## Loading, empty, and error states

- Account-chart and transaction-backed metrics retain independent loading and retry states.
- Retained data remains visible while a refresh is in progress or fails.
- Fewer than two completed months shows current actual plus the localized insufficient-history state and no forecast segment.
- Missing matching accounts explains the active account rule, including the current Savings view.
- Missing rates omit affected values and show one grouped warning.
- Empty Money flow shows a reconciled empty state rather than an empty SVG.
- An unbalanced graph shows the complete audit and retry path but no misleading ribbons.

## Verification

### Pure aggregation tests

- Current unfinished months never enter completed averages.
- Category forecast floors at actual, completed average, and paced forecast.
- A missing early-month Housing transaction still forecasts at least the completed average.
- A category already above average never forecasts below actual.
- Historical refunds after today cannot reduce the final forecast below actual.
- Total forecast equals the sum of every category forecast, not one aggregate maximum.
- Zero actual, zero forecast, and zero remaining values remain explicit.
- Account forecasts exclude current partial movement and return remaining-from-today values.
- Credit-card assets never enter Debt and remain Available in Money flow.
- Every active Liability account enters Debt, and debit-, credit-, and unknown-direction magnitudes normalize per account before aggregation.
- Combined savings equals the two split savings groups.
- Direct income and expense splits route through the correct pool.
- Direct liability-funded expenses and direct income/refunds to liabilities retain their non-pool funding route.
- Refunds return to the correct pool.
- Opposing savings-account movements remain visible and reconcile to net savings.
- Net Available/Savings transfers produce one directional bridge.
- Debit- and credit-direction liability activity receives the correct direction-aware route and reconciles to the net magnitude summary.
- Liability-to-liability reallocations remain available in exact details without inflating outer New debt or Debt paid totals.
- Top 5, Top 10, All, and Other preserve totals and contributing transaction IDs.
- Pool and total conservation hold within currency tolerance.

### Store and presentation tests

- Corrupt persisted Savings view, detail level, metric, and category selections are repaired.
- Empty account groups do not issue requests.
- Combined savings does not issue a fifth request.
- Combined savings aligns complete constituent points and never displays a partial sum after one non-empty constituent fails or lacks a rate.
- Current-point fallback requests remain bounded to one per incomplete non-empty logical group.
- Validation warnings are grouped and deduplicated.
- Forecast crosshairs and accessible announcements expose end-of-month and from-today values.
- Mobile condensation changes visible graph layers without changing exact values or reconciliation.

### Geometry tests

- Packed ribbon widths never exceed their node or pool span.
- Square endpoints do not protrude over pool bars.
- Stable ordering avoids the current alternating-origin crossings.
- Dynamic desktop and mobile dimensions retain minimum readable spacing.
- Transparent hit targets remain usable for small values.

### Manual verification

- Inspect desktop and mobile layouts in Chrome.
- Inspect light and dark themes.
- Verify hover, touch, keyboard focus, highlighting, details sheets, and vertical chart crosshairs.
- Verify Top 5, Top 10, All, Other, and automatic mobile condensation with live data.
- Verify the Analytics sidebar icon and compact FX badge.
- Reproduce a previously duplicated balance warning and confirm one grouped message.
- Run focused analytics tests, scoped lint/format checks, production build, locale parsing, and the checkout's local Docker image/Compose path.

## Acceptance criteria

- The Analytics sidebar icon renders consistently with its neighboring items.
- No full-width `Estimated at current rates` note remains.
- Identical balance-validation messages never render twice.
- The unfinished current month is excluded from all historical averages.
- Expense forecasts satisfy the approved three-way category rule and never fall below actual.
- Housing-like missing expected spending is represented by the forecast.
- Every forecast point exposes both end-of-month and from-today values.
- Credit cards are regular Available assets; only Liability accounts are Debt.
- Savings can be viewed Combined or split by net-worth inclusion across Financial trends and Money flow.
- Money flow visibly distinguishes Available and Savings funding.
- Income categories, expense categories, savings accounts, and liability accounts are available as graph layers or complete node details.
- Opposing savings movements remain visible and reconcile to their net.
- Existing available or savings funds used appear on the left when applicable.
- Ribbons do not overlap node bars with round caps.
- Top 5, Top 10, and All are configurable, with truthful Other aggregation.
- Mobile condenses outer layers only when required for readability and retains complete details on selection.
- The graph reconciles or is withheld with an actionable audit.
- No backend route, migration, or new dependency is introduced.
