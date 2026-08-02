# Extended Analytics Page Design

Date: 2026-08-02

Status: Revised UX design approved in conversation; awaiting review of this written specification

Target branch: `personal/extended-analytics`

## Summary

Provide a dedicated `/analytics` page for deeper historical and forward-looking analysis without changing the existing month-focused dashboard. The page has three full-width cards:

1. Financial trends: selectable monthly net-worth change, savings change, debt change, and total expenses over 3, 6, or 12 months, with current account totals kept in summary tiles.
2. Category spending: selectable category histories, completed-month averages over 3, 6, 12, or 24 months, and a separately identified current-month forecast.
3. Money flow: a monthly flow from income, withdrawn savings, prior excess, and new debt into expenses, savings deposits, debt repayment, and new excess.

The implementation is personal-fork functionality. It uses Firefly III's existing account-chart and transaction APIs through Pico's proxy, adds no database schema, and adds no chart dependency. This revision responds to inspection of the implemented page with live Firefly data: the balance card is hidden by an Atom-timestamp parsing failure, the desktop two-column layout compresses the charts, the mobile category summary clips horizontally, and the money-flow detail is too dense.

## Goals

- Make monthly net-worth, savings, debt, and expense movement comparable over useful time windows while preserving the latest account totals.
- Show exact values at any chart position, including all visible series on a shared vertical crosshair.
- Make category-level spending history usable for estimating future spending.
- Keep completed history, current actuals, and current forecast visually and semantically distinct.
- Explain how this month's resources moved between income, past resources, spending, saving, debt, and remaining excess.
- Improve hierarchy, spacing, typography, and progressive disclosure so the page remains readable on mobile and desktop.
- Preserve Pico's mobile-first interaction model, desktop shell, dark theme, localization, and repository conventions.
- Avoid the many-small-request pattern that made historical balance work unsuitable for the main dashboard.

## Non-goals

- Replacing or broadening the existing dashboard's monthly cards.
- A generic report builder, arbitrary formulas, or user-authored chart definitions.
- Projecting net worth, savings, or debt beyond the latest known balance. The partial current-month movement is actual, not forecast.
- Predicting income, category mix, or money flow beyond the explicitly defined category forecast.
- Changing Firefly III records, Pico's database, authentication, or backend proxy semantics.
- Adding a charting npm package.
- Publishing, pushing, or opening an upstream pull request as part of implementation.

## Confirmed Product Decisions

### Account groups

- **Net worth** means the signed aggregate of all active balance-holding accounts whose `attributes.include_net_worth` value is true, including assets, cash-wallet assets, and liabilities supported by Firefly's account chart.
- **Savings** means the signed aggregate of every active asset account whose `attributes.account_role.fireflyCode` is `savingAsset`. Inclusion in net worth does not control membership in this series.
- **Debt** means the non-negative amount currently owed across:
  - active liability accounts whose `attributes.liability_direction.fireflyCode` is `debit`; and
  - active asset accounts whose `attributes.account_role.fireflyCode` is `ccAsset`.
- A credit-direction liability represents money owed to the user. It remains part of net worth when `include_net_worth` is true, but is not debt.
- A credit-card purchase is an expense and an increase in debt. A credit-card payment is debt repayment, not another expense.

### Periods

- Financial-trend ranges: 3, 6, and 12 trailing calendar months through the current partial month.
- Account-history requests retain daily sampling for 3 months and weekly sampling for 6 and 12 months, then use the final valid balance in each calendar month to calculate month-over-month movement. The request includes the prior month-end baseline needed for the first displayed movement.
- The current month is a separately styled partial period. Account movements use latest actual balances; total expenses show actual-to-date plus the approved remainder-of-month forecast. The selected 3/6/12-month range is also the completed-history window for this total-expense forecast.
- Category average windows: 3, 6, 12, and 24 completed calendar months.
- The current month is never included in a completed-month average.
- Money flow initially opens on the current calendar month and supports month navigation within the loaded 24-completed-month history.

### Current-month category forecast

For category `c`, current date `d`, and selected completed months `M`:

```text
forecast(c) = actualCurrentMonthThroughToday(c)
            + average(monthSpendAfterDay(c, m, dayOfMonth(d)) for m in M)
```

The remainder calculation uses calendar dates strictly after today's day-of-month. In a shorter historical month, nonexistent days contribute zero. A forecast is shown only when at least two completed months are available in the selected window. Otherwise, the card shows actual current-month spending and an insufficient-history explanation.

### Currency behavior

- Analytics are displayed in the user's selected dashboard currency.
- Historical Firefly primary-currency values are preferred whenever the API supplies them.
- When the selected currency is Firefly's primary currency, those historical values are treated as historical primary-currency amounts.
- If a selected non-primary currency requires a cross-rate, or historical primary values are unavailable, Pico converts with its currently stored exchange rates and visibly labels the affected card `Estimated at current rates`.
- If any required rate is unavailable, affected values are omitted with a partial-data warning. Missing values are never silently converted to zero.

## Navigation and Page Layout

### Navigation

- Add `ROUTE_ANALYTICS: '/analytics'` to `RouteConstants.js`.
- Mobile retains five bottom items. The Dashboard item remains active for both `/dashboard` and `/analytics`.
- The top of both pages contains a compact `Overview / Analytics` switch. It navigates through route constants and clearly marks the current page.
- Desktop adds Analytics as its own sidebar item while retaining Dashboard.
- Direct navigation and refresh of `/analytics` work with Nuxt file routing.

### Responsive layout

Mobile is one column in this order:

1. Financial trends
2. Category spending
3. Money flow

Desktop uses the same full-width stack in a centered content region approximately 1,100-1,200px wide. Category spending and money flow are never squeezed side by side. Mobile must not require horizontal scrolling inside any card.

Each section uses a Vant inset cell group/card, compact but readable typography, 6-10px rounding, existing CSS variables, and Pico's soft-shadow language. Every card presents its title and one-line purpose, primary controls, visualization, key values, then collapsed calculation details. Loading, error, retry, and empty states remain card-local. Styles live in the shared theme files, with explicit dark-theme treatment for any fixed color.

The screenshots under `docs/local/zenmoney_charts_references/` are visual references for compact financial density, combined balance lines, category comparison, and flow storytelling. They are not a mandate to copy Zenmoney's navigation, colors, controls, or chart implementation; Pico's established design language remains authoritative.

## Architecture

### Ownership boundaries

- `dashboardStore.js` remains responsible for the existing dashboard only.
- `analyticsStore.js` owns route-lazy request state, cached raw responses for the active analytics session, selected periods/metrics/categories/month, and independent card errors.
- `AnalyticsUtils.js` contains deterministic normalization and aggregation. It receives plain account/transaction objects plus dates and returns chart-ready plain objects; it does not access Pinia, the router, axios, or the DOM.
- Repository classes own HTTP details.
- Reusable chart components own SVG geometry and input behavior, but no financial rules.
- Analytics card components translate store data into chart series, summaries, drilldowns, and localized states.

### Data flow

```text
account and currency stores
        |
        +--> analyticsStore account groups
        |         |
        |         +--> AccountRepository chart requests --> AnalyticsUtils --> monthly account movement
        |
TransactionRepository: current month + 24 completed months, paginated once
        |
        +--> AnalyticsUtils category buckets/averages/forecast --> category chart
        |                                                   |
        |                                                   +--> total monthly expense movement
        |
        +--> AnalyticsUtils monthly flow ledger -------------> money-flow chart
```

The route starts loading only when `/analytics` is opened. Changing a presentation-only selection reuses already loaded data:

- changing balance range may fetch the corresponding range once and then cache it for the session;
- changing category average window or selected categories does not refetch transactions;
- changing the flow month does not refetch while the month is within the loaded interval.

### HTTP requests

#### Balance history

`AccountRepository` gains a method for Pico's proxied Firefly endpoint `/api/chart/account/overview`. It accepts `start`, `end`, `period`, and an explicit list of account IDs.

The analytics store makes at most one range request for each required account group for a newly selected balance range:

- net-worth account IDs;
- savings account IDs; and
- debt account IDs.

Requests for empty account groups are skipped and produce an empty-series state. The existing Laravel catch-all proxy forwards these requests to Firefly III; no new Laravel route or controller is required.

#### Transaction history

One sequential paginated read loads the widest required interval: the current calendar month plus 24 completed calendar months. The request uses the existing transaction repository and date filters, with a page size of up to 200. `BaseRepository.getAllWithMerge()` may accept and consistently forward an optional `pageSize`; its existing callers retain current behavior.

The store retains the raw JSON:API transactions for the current page session. The same collection feeds category and flow calculations. Pagination remains sequential to respect existing loading and API behavior.

### Independent state

Each card has its own `idle/loading/ready/empty/error` state and retry action. A failed balance request does not hide category or flow results. Refresh retries failed or stale sources while keeping successful cards visible until replacements arrive.

Only lightweight UI preferences may persist in local storage, such as the last selected periods, metric IDs, and category IDs. Raw account history, transactions, calculated balances, and errors remain session state.

## Financial Trends

### Source normalization

The Firefly account-chart response is normalized to:

```js
{
  date: 'YYYY-MM-DD',
  value: Number,
  currencyCode: String,
  isCurrentRateEstimate: Boolean,
}
```

For each requested account and point:

1. Accept Firefly's Atom timestamp keys, such as `2026-08-02T00:00:00+00:00`, and date-only keys, validating and canonicalizing both to the source calendar date `YYYY-MM-DD` without local-time conversion.
2. Prefer the account line's `primary_currency_code` entry when present, while retaining compatibility with the previously observed `pc_currency_code` field.
3. Otherwise use its native-currency entry and current Pico rate conversion.
4. Normalize the result into the selected display currency.
5. Align all accounts on the union of requested dates, carrying the most recent known balance forward only after that account's first returned point. Time before an account's first returned point is not invented.

The current endpoint value and the final chart point are validated against the corresponding account's `current_balance` or `current_debt`, allowing for the selected sampling date and currency conversion. A sign or material-value mismatch produces a visible partial-data warning and logs diagnostic context in development; it is not silently repaired.

### Aggregation and monthly movement

- Net worth sums the Firefly signed balance contribution of each included account.
- Savings sums the signed balances of savings-role asset accounts.
- Debt converts each included account's signed balance to a non-negative amount owed. For debit-direction liabilities and credit-card assets, the owed amount is `max(0, -signedNetWorthContribution)`. The normalization helper owns any Firefly account-type sign adaptation before this formula, and fixtures must cover both account classes.
- For each account metric, a completed month's plotted movement is that month-end total minus the preceding month-end total.
- Current-month account movement is the latest actual total minus the preceding completed month-end total and is visibly labeled partial.
- Positive debt movement means debt grew; negative debt movement means debt was repaid. Debt-aware summary color treats growth as deterioration and repayment as improvement.
- Total expenses are the existing transaction ledger's monthly net consumption across all categories. Transfers, savings movements, debt payments, and configured non-expense transactions remain excluded. Refunds reduce the month in which they occur.
- Completed months show actual total expenses. The current month shows actual-to-date and a dashed forecast continuation using the approved remainder-of-month formula and selected 3/6/12-month history window.
- Zero is a valid point. Missing is not zero.

Summary tiles display the latest actual Net worth, Savings, and Debt totals rather than replacing them with movements. A fourth tile shows current total-expense actual and forecast. Movement summaries identify the latest completed month separately from the current partial month.

### Controls and visual encoding

- Segmented period control: 3M / 6M / 12M.
- A category-style facet button reports `N selected` and opens a searchable checkbox list for Net worth change, Savings change, Debt change, and Total expenses.
- All four may be shown together; at least one must remain selected. Invalid or obsolete persisted selections are repaired safely.
- Each series has a stable semantic color plus a distinct marker/line treatment so color is not the only identifier.
- Actual account-movement lines never use forecast styling. Only the current total-expense forecast uses a dashed segment and forecast marker.
- Hover, touch, or keyboard inspection shows a vertical guide and exact values for every selected series at the active month.

## Category Spending

### Transaction semantics

Calculations operate at split-transaction level.

- Spending is net consumption: withdrawals to expense accounts minus refunds from expense accounts for the same category.
- A credit-card purchase to an expense account is spending, even though its source is a credit-card asset.
- Savings transfers, debt payments, and ordinary transfers are excluded from category spending.
- Refunds reduce the category and month in which the refund occurred.
- A missing category is grouped under a visible `Uncategorized` series.
- A month can have negative net spending when refunds exceed purchases; the chart and exact tooltip preserve that value.

### Completed-month average

For a selected window of `N` months:

1. Find the latest `N` completed calendar months ending immediately before the current month.
2. Exclude months before the first available ledger month.
3. Once ledger history has begun, months with no spending in a category count as zero.
4. Average each selected category over the usable completed months.
5. Display `Based on X of N months` when less history is available than requested.

The ledger-history boundary is the earliest transaction date in the loaded interval. Because the client loads at most 24 completed months, a 24-month label is explicitly bounded by the available API interval.

### Category facet

- The facet lists categories by spending over the active completed-month window.
- The initial selection is the top five categories with spending; if fewer exist, select all available categories.
- Users may search and toggle categories.
- Mobile shows at most six chart series at once to keep the graph readable. Attempting to select a seventh explains the limit; deselection is always available.
- Desktop uses the same limit so the selection remains consistent across layouts.
- `Uncategorized` behaves like a normal selectable category.
- The selection is stored by category ID, not translated label.

### Chart

- Historical completed months are drawn as actual solid series.
- The current month is a separately labeled final position.
- Its actual-to-date value uses an actual marker.
- Its forecast continuation uses a dashed segment and forecast marker, never an unqualified actual point.
- A compact comparison shows each selected category's completed-month average, current actual, and current forecast.
- When forecast history is insufficient, the forecast point/segment is absent rather than set equal to actual.
- On desktop, the compact comparison is an aligned table with right-aligned tabular currency values. On mobile, it becomes stacked category rows showing category, current actual, historical average, and forecast without a minimum-width table or horizontal clipping.
- Controls and selected-state behavior align with Financial trends. Chart labels and tooltips use stronger contrast and readable 11-13px text.
- Repeated assumption notes are consolidated into one collapsed `How this is calculated` disclosure. Missing-rate, short-history, and other data-quality warnings stay visible outside the disclosure.

### Drilldown

Selecting an actual category-month value opens the transaction list using the exact split transaction IDs that produced the value, plus the human-readable category/month context. This avoids semantic mismatches for refunds and mixed split transactions. Forecast points show their formula inputs instead of opening nonexistent future transactions.

## Money Flow

### Conservation model

For a selected month, the display closes this equation in the selected currency:

```text
income
+ savings withdrawn
+ new debt
+ prior excess used
+ net refunds when expenses are negative
= expenses
+ savings deposited
+ debt repaid
+ new excess
```

All rendered bands are non-negative magnitudes. Savings and debt are netted for the month so they appear on only one side:

- net savings increase -> `Savings deposited` destination;
- net savings decrease -> `Savings withdrawn` source;
- net debt decrease -> `Debt repaid` destination;
- net debt increase -> `New debt` source.

`Prior excess used` and `New excess` are mutually exclusive residuals that make the two sides equal after classified flows. The card exposes the formula and amounts used for either residual.

```text
classifiedSources = income + savingsWithdrawn + newDebt + netRefunds
classifiedDestinations = expenses + savingsDeposited + debtRepaid
priorExcessUsed = max(0, classifiedDestinations - classifiedSources)
newExcess = max(0, classifiedSources - classifiedDestinations)
```

### Classification

- Revenue-account inflows to included asset, cash, or debt accounts are new income.
- Expense-account outflows are expenses; refunds reduce expenses.
- Transfers into savings-role accounts contribute to net savings increase; transfers out contribute to net savings decrease.
- Transfers that reduce an included debt account contribute to debt repayment; movements that increase it contribute to new debt.
- A credit-card purchase contributes to expenses and debt increase through the same split's two financial effects. This is intentional: the expense explains consumption, while new debt explains its funding source.
- A credit-card payment contributes to debt repayment only.
- Ordinary transfers, savings-to-savings transfers, and debt-to-debt transfers cancel and do not create flow.
- If refunds exceed expenses, the negative expense amount becomes a `Net refunds` source rather than a negative destination band.

The utility returns exact contributing split IDs for each non-residual node and an audit object containing gross classified amounts, netted savings/debt, residual, and equation difference. A nonzero difference beyond currency rounding tolerance is an error state, not an auto-balanced diagram.

### Visualization and drilldown

- Use a compact native SVG flow diagram with labeled source and destination nodes and proportional bands. It uses the full card width, with horizontal flow on desktop and a purpose-built vertical flow on mobile rather than shrinking the desktop geometry.
- Keep labels and amounts visible outside narrow bands; never require hover to understand the diagram.
- Increase node, amount, and connection-label size and contrast enough to remain readable in both themes.
- Keep the balanced/not-balanced result visible beside the primary monthly summary.
- Collapse detailed reconciliation by default.
- Put the equivalent exact-value list behind an `Exact values` disclosure. The SVG retains an accessible summary and the disclosure provides the full non-visual/tabular equivalent on demand without duplicating every value in the default visual hierarchy.
- Selecting a non-residual node opens the exact contributing transaction IDs.
- Selecting a residual opens a small formula explanation, since it has no direct transaction set.

## Shared Chart Inspection Interaction

Every multi-series line chart uses the same inspection component and behavior:

- A vertical crosshair snaps to the nearest x-axis point.
- The tooltip shows the exact date or month and the actual amount for every currently visible series at that x-position.
- Values identify `Actual`, `Forecast`, and `Estimated at current rates` where applicable.
- Desktop pointer hover updates the crosshair. Click pins/unpins it.
- Mobile touch-drag updates it. Releasing pins the selected point so amounts remain readable.
- Tapping outside the chart dismisses a pinned inspection.
- Keyboard focus exposes the chart; Left/Right arrows move through points, Home/End jump to edges, and Escape dismisses the pinned point.
- Tooltip placement flips near chart edges and stays within the card.
- Tooltip rows clearly separate marker, series name, right-aligned tabular amount, and `Actual`, `Forecast`, `Partial`, or `Estimated at current rates` qualifiers.
- The selected point and all displayed values are announced through an accessible live region.
- Series markers remain visible at the crosshair; touch targets are larger than their visual markers.

The flow chart does not use a date crosshair, but it follows the same exact-amount and keyboard-selectability principles for its nodes.

## Empty, Partial, Loading, and Error States

- Each card loads independently with a skeleton or compact spinner inside its card.
- No matching accounts: explain which account rule produced no series, including when the Financial trends chart itself is absent.
- No category spending: keep controls visible and show a localized empty state.
- Insufficient forecast history: show current actual and the minimum two-month requirement.
- Short history: show `Based on X of N months`.
- Missing exchange rate: omit affected series/nodes, show involved currency codes, and offer retry after rates sync.
- Request failure: keep other cards usable and provide a card-local retry.
- Partial pagination failure: do not present incomplete category/flow aggregates as complete; mark both transaction-derived cards failed while preserving any balance result.
- Flow conservation failure: show the audit totals and suppress the misleading SVG. Successful reconciliation details remain collapsed by default.
- Stale cached request: retain the previous visible result during retry and label it until refreshed.

## Accessibility and Localization

- All user-visible text uses i18n keys in every locale present at implementation time. The current set is `de-DE`, `en`, `es-MX`, `fr`, `it`, `ko`, `pl`, `pt-BR`, `ro`, `ru-RU`, and `zh-CN`.
- Currency formatting uses existing Pico number-format and decimal preferences.
- Colors meet theme contrast expectations and are supplemented by line patterns, markers, labels, and accessible names.
- Controls have visible focus states and usable touch targets.
- Charts include a concise text summary. The crosshair live region and flow list provide non-visual access to exact values.
- Motion is subtle, short, and disabled when the existing profile animation setting is off.

## Candidate Implementation Files

Personal feature surface:

- `front/pages/analytics.vue`
- `front/pages/dashboard.vue`
- `front/stores/analyticsStore.js`
- `front/utils/AnalyticsUtils.js`
- `front/components/analytics/analytics-page-switch.vue`
- `front/components/analytics/analytics-balance-trends.vue`
- `front/components/analytics/analytics-category-spending.vue`
- `front/components/analytics/analytics-category-facet.vue`
- `front/components/analytics/analytics-money-flow.vue`
- `front/constants/RouteConstants.js`
- `front/stores/appStore.js`
- `front/components/ui-kit/theme/app-left-sidebar/app-left-sidebar.vue`
- `front/assets/styles/theme-white.css`
- `front/assets/styles/theme-dark.css`
- all JSON files under `front/i18n/locales/`

Potentially reusable infrastructure:

- `front/components/charts/multi-series-line-chart.vue`
- `front/components/charts/money-flow-chart.vue`
- `front/repository/AccountRepository.js`
- `front/repository/BaseRepository.js`
- `front/tests/utils/AnalyticsUtils.test.js`

The final implementation should keep this list minimal. Files are added or changed only when required by the behavior above.

## Verification Strategy

### Deterministic utility tests

Use Node's built-in test runner; add no test dependency. Fixtures cover:

- account membership for net worth, savings, debit liabilities, credit liabilities, and credit cards;
- signed net-worth aggregation and non-negative debt normalization;
- Firefly Atom-timestamp and date-only chart keys canonicalizing to date-only points without a timezone day shift;
- `primary_currency_code` plus compatibility with the previously observed currency-code field;
- daily/weekly point alignment, missing leading history, and valid zero balances;
- month-end extraction and month-over-month net-worth, savings, and debt movement, including the prior-period baseline and current partial month;
- monthly total expenses derived from the same normalized ledger as category spending;
- historical primary values, current-rate fallback, and missing-rate omission;
- split transactions and uncategorized spending;
- refunds reducing category spending and net-refund flow behavior;
- zero-spend completed months and pre-ledger months;
- 3/6/12/24 completed-month selection;
- current forecast remainder across unequal month lengths and the two-month minimum;
- savings deposits/withdrawals and debt increase/repayment netting;
- credit-card purchase versus credit-card payment;
- ordinary, savings-to-savings, and debt-to-debt transfers canceling;
- mutually exclusive residuals and exact conservation within currency rounding tolerance;
- exact transaction ID sets for drilldowns.

### Component and interaction checks

- One through four visible Financial trends series, category-style metric selection, persisted-selection repair, and the at-least-one rule.
- Category selection, six-series limit, average-window switching, and current forecast treatment.
- Crosshair hover, click pin, touch drag/release pin, outside dismissal, edge flipping, and keyboard navigation.
- Actual, forecast, and current-rate-estimated labels.
- Independent loading, empty, error, short-history, missing-rate, and partial-success states.
- Flow node selection, residual formula, collapsed reconciliation, and disclosed accessible exact-value list.

### Repository verification

From `front/`:

```bash
npm run lint
npm run build
node --test tests/utils/AnalyticsUtils.test.js
```

Parse every changed locale JSON file. Run `git diff --check`. Use the actual running app in Chrome to inspect mobile and desktop layouts in both light and dark themes, including pointer and touch interaction. Acceptance requires no horizontal clipping, unreadable labels, hidden Financial trends card, or unexpected console errors. Where local Firefly data does not exercise an edge case, use deterministic component fixtures and record that boundary instead of claiming live proof.

## Acceptance Criteria

- `/analytics` is reachable through the approved mobile and desktop navigation without adding a sixth mobile tab.
- Financial trends shows selectable monthly net-worth change, savings change, debt change, and total expenses for 3/6/12 months while retaining latest actual account totals in summary tiles.
- 3-month balance data is daily; 6/12-month data is weekly.
- A crosshair exposes the exact amount of every visible series and works with pointer, touch, and keyboard.
- Category history supports category faceting and 3/6/12/24 completed-month averages.
- Current-month actual and forecast are distinct, and forecast implements the approved remainder-of-month formula with a two-month minimum.
- Category averages count zero-spend months after ledger history begins and exclude time before available history.
- Money flow conserves the approved equation, nets savings/debt direction, treats cards correctly, and exposes exact drilldowns or residual formulas.
- All three cards are full-width in a centered desktop stack; mobile category summaries do not clip, and mobile money flow uses readable vertical geometry.
- Calculation and exact-value detail is progressively disclosed while data-quality and reconciliation status remain visible.
- Historical currency values are preferred; every current-rate fallback is visibly labeled; missing rates are never treated as zero.
- Cards fail independently and partial success remains useful.
- All new labels are localized, themes are coherent, no dependency or database migration is added, and lint/build/utility tests pass.

## Delivery and Upstream Packaging

Implementation stays on `personal/extended-analytics` and is not pushed without explicit approval. Commits should keep reusable infrastructure separate from the personal analytics page where practical:

1. pure analytics utilities and deterministic tests;
2. generic SVG line-chart inspection behavior;
3. repository pagination/range support, if required;
4. personal analytics store, cards, page, navigation, styles, and localization;
5. verification-only fixes.

This separation leaves a possible future upstream contribution containing generic chart interaction or aggregation helpers without requiring maintainers to accept the personal analytics information architecture.

Rollback requires removing the analytics route/page/components/store/utility/tests, reverting navigation and locale/style additions, and reverting the narrow repository extensions. No persisted financial data or database migration needs reversal. Local-storage preference keys, if introduced, should be namespaced under analytics and be safe to leave orphaned or explicitly removed during rollback.

## Risks and Mitigations

- **Large transaction history:** fetch the widest interval once, use page size up to 200, paginate sequentially, and reuse the collection.
- **Currency ambiguity:** prefer primary historical values, feature-detect transaction primary values, label current-rate fallback, and never invent a missing rate.
- **Account sign differences:** centralize sign normalization, test debit liabilities and credit cards separately, and compare the latest normalized point with current account fields.
- **Split/refund double counting:** classify at split level and retain exact IDs plus an auditable flow ledger.
- **Unreadable mobile charts:** cap visible category series, use a crosshair with all exact amounts, and allow edge-aware pinned tooltips.
- **Dense analytics hierarchy:** stack all cards at full width, replace the mobile category table with labeled rows, use vertical mobile flow geometry, and collapse secondary calculation details.
- **Live Firefly date shape:** normalize validated Atom keys to their source calendar date at the analytics boundary and cover the API-shaped response in utility and store tests.
- **Misleading partial data:** isolate card errors, treat incomplete pagination as failure, and surface `Based on X of N months`.
- **Upstream scope mismatch:** keep the feature personal first and isolate generally reusable primitives in separate commits.
