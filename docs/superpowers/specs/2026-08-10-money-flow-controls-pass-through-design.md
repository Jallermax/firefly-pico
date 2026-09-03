# Money Flow Ordering, Threshold Detail, and Pass-Through Accounts Design

Date: 2026-08-10

Status: approved design, awaiting written-spec review

Target: `personal/extended-analytics`

## Summary

Money Flow will gain three coordinated controls:

1. `Amount` versus `Type, then amount` ordering;
2. a fourth `Minimum amount` detail mode alongside Top 5, Top 10, and All; and
3. a reusable Pico analytics role for pass-through asset/cash accounts, with a Money Flow toggle for immediate original-versus-pass-through comparison.

The work remains personal-fork analytics functionality. It adds no backend schema, does not mutate Firefly account types or transactions, and does not change balances, net worth, forecasts, Cash Use, Spending by category, or other analytics in this slice.

## User decision improved

The card should answer two related questions more clearly:

- Can the outer sources and destinations be scanned as semantic families instead of one amount-ranked list?
- How did payroll or another automated clearing account distribute new money into taxes, benefits, savings, debt, spendable cash, and retained balance?

The user must be able to compare both interpretations without deleting configuration: toggle pass-through treatment off for the current Available-pool view, then on for the pass-through view.

## Existing behavior and code anchors

The current graph is transaction-backed and follows immediate Firefly split endpoints. Active asset/cash accounts that are not savings-role accounts belong to Available. `front/utils/AnalyticsUtils.js` builds and limits the monthly graph; `front/utils/AnalyticsCategoryPresentationUtils.js` supplies amount ordering; `front/stores/analyticsStoreFactory.js` persists detail state; `front/components/analytics/analytics-money-flow.vue` owns the card controls and exact-details routing; and `front/components/charts/layered-money-flow-chart.vue` renders the preordered graph.

Current detail values are Top 5, Top 10, and All. Top-N is applied independently to compatible outer groups, and grouped nodes retain their exact component nodes and transaction IDs. The renderer preserves the production graph order rather than performing an independent visual sort.

## Scope boundaries

### Personal-fork scope

- Complete sorting, threshold-detail, role configuration, pass-through calculation, responsive UI, locales, and rendered verification.
- Persist settings locally using the existing analytics-store pattern.
- Preserve exact transaction evidence and the current graph audit contract.

### Potentially upstreamable slice

- Pure semantic ordering for layered Money Flow nodes.
- Threshold-based compatible-node grouping with preserved drill-down evidence.

### Experimental fork behavior

- The `passThrough` analytics role and its account-specific accounting policy.

### Explicit non-goals

- Changing a Firefly account type, role, balance, or transaction.
- Applying pass-through treatment to balance reconstruction, net worth, forecasting, Cash Use, or category analytics in this slice.
- Tracing a specific income dollar through subsequent transactions.
- Supporting every possible inbound transfer into a pass-through account by guessing a direction or source.
- Adding a backend route, database migration, or chart dependency.

## Persisted settings

The analytics store owns and validates these local values:

- Money Flow order: `amount` or `type`;
- detail mode: `5`, `10`, `all`, or `threshold`;
- minimum amount: a finite value greater than or equal to zero in the dashboard currency, defaulting to zero until the user changes it;
- pass-through role assignment: unique account IDs assigned the reusable `passThrough` analytics role; and
- Money Flow pass-through enabled state.

The role assignment remains saved when treatment is disabled. This makes A/B comparison one switch action.

Only currently active asset/cash accounts are effective pass-through candidates. Missing, deleted, inactive, savings-role, liability, expense, and revenue accounts are excluded from the effective selection. Stale stored IDs are repaired after account data becomes available rather than affecting the graph.

The role is reusable Pico analytics metadata even though Money Flow is its only consumer in this slice. The implementation should expose a focused account-role resolver rather than modifying `getAnalyticsAccountKind()` or the shared normalized ledger.

## Money Flow controls

The card adds three compact control rows.

### Order

- Amount
- Type, then amount

### Detail

- Top 5
- Top 10
- All
- Minimum amount

Selecting Minimum amount reveals one localized currency input. The field uses the selected dashboard currency and its configured decimal precision. Invalid, non-finite, or negative input does not replace the last valid value.

### Pass-through accounts

- A searchable multi-select containing eligible active asset/cash accounts, using human-readable account names.
- A `Use pass-through treatment` switch.
- The switch is disabled or has no financial effect when no eligible account is selected.

Controls wrap on mobile, retain at least 44px interactive targets, and use existing Pico tab, field, popup, and theme patterns. Desktop may lay compact controls inline when space permits. Changing any graph-affecting setting clears stale hover, focus, or pinned interaction state.

## Ordering contract

Sorting affects graph presentation only. It does not alter values, accounting, evidence, or grouping membership.

The final outer-node sort is a pure presenter operation after human-readable labels have been resolved. Tests and non-UI callers may supply labels directly; a missing label falls back to `refId`, then stable ID. The chart geometry still consumes the resulting order without performing another sort.

### Amount mode

Amount mode preserves current behavior:

- nodes within each layer use absolute amount descending;
- stable ties use the localized human-readable label, then stable ID; and
- `Other` nodes remain last.

### Type, then amount mode

The most-left source breakdown uses this family order:

1. Income;
2. Refunds;
3. Existing funds, including Available, Savings, and pass-through residual sources; and
4. New debt or liability-collected sources.

The most-right destination breakdown uses this family order:

1. Expenses;
2. Debt;
3. Savings; and
4. Excess, including retained pass-through balance and ordinary new excess.

Within each family, nodes use absolute amount descending, then localized label, then stable ID. `Other` remains last inside its family. Central grouping, pass-through, Available, Savings, and use pools keep their fixed accounting order; multiple pass-through account pools use amount descending, label, then ID.

The selected order is applied before geometry. `layered-money-flow-chart.vue` must continue to consume the supplied order without barycentric or DOM-order resorting.

## Minimum-amount detail contract

The threshold is one shared dashboard-currency amount applied to all outer account/category families for the selected month.

For every existing compatible grouping key:

1. keep each node whose absolute value is greater than or equal to the threshold;
2. collect nodes whose absolute value is below the threshold;
3. if at least two compatible nodes are below the threshold, replace them with one `Other` node; and
4. if only one compatible node is below the threshold, keep its real name and identity.

Compatibility remains at least as strict as the current Top-N implementation. Threshold grouping never combines:

- different source/destination sides;
- income, refunds, expenses, debt, savings, or excess families;
- different parent paths;
- different immediate funding pools;
- accessible and restricted savings;
- positive and negative directions; or
- otherwise incompatible link kinds.

Pass-through pools themselves are central accounting nodes and are never threshold-grouped. Their outer account/category destinations remain eligible.

Every `Other` node retains:

- its component nodes;
- exact transaction IDs;
- refund-coverage evidence when present; and
- enough compatibility metadata to reconstruct exact detail rows and links.

Ordering is applied after Top-N or threshold grouping so the final visible nodes obey the selected order mode.

## Pass-through accounting contract

### Boundary

The shared analytics ledger keeps its authoritative Firefly endpoint classifications. Pass-through treatment is applied only by `buildMonthlyMoneyFlow()` when the Money Flow toggle is enabled.

Each effective selected account becomes a named pass-through pool before Available. The expanded logical stages are:

```text
outer sources
  -> income/refund grouping
  -> pass-through account pools
  -> Available
  -> Savings
  -> Uses
  -> outer destinations
```

Ordinary flows that do not involve a pass-through account may skip the pass-through stage. Links remain forward-only and acyclic.

### Supported transitions

For a selected pass-through destination account:

- Revenue -> Pass-through: new income feeds the named pool.
- Expense refund -> Pass-through: refund income feeds the named pool.
- Liability -> Pass-through: new debt or liability-collected source feeds the named pool.

For a selected pass-through source account:

- Pass-through -> Expense: direct expense-category distribution.
- Pass-through -> Available: spendable cash distribution.
- Pass-through -> Savings: savings-account distribution, preserving accessible/restricted classification.
- Pass-through -> Liability: debt repayment or liability-extension handling using the existing liability-direction policy.
- Pass-through -> Pass-through: internal pass-through reallocation; exclude it from outer totals but retain it in exact audit detail.

Available/Savings -> Pass-through and other unsupported pass-through transitions are retained in a pass-through unclassified audit with exact transaction IDs. A nonzero unsupported amount withholds the pass-through graph rather than guessing, tracing fungible funds, or double-counting an internal transfer. Disabling pass-through treatment immediately restores current Available-pool behavior.

### Pool conservation

For each selected pass-through account:

```text
supported incoming = ordinary income + refunds + new debt/liability sources
supported outgoing = Available distributions + expenses + savings + debt outcomes

existing pass-through funds = max(supported outgoing - supported incoming, 0)
retained pass-through balance = max(supported incoming - supported outgoing, 0)
```

`Existing pass-through funds` is a left-side existing-funds source. `Retained in <account>` is a right-side Excess destination. These residuals balance the selected-month pool without calling prior balance new income or forcing retained payroll balance into Available.

Actual links keep their transaction IDs. Derived residual nodes are visibly identified as calculated balance changes; their details show the contributing incoming and outgoing totals and evidence, while transaction navigation uses actual transaction IDs only.

When treatment is disabled and Amount order is selected, the selected accounts remain ordinary Available accounts and the resulting graph must match the pre-feature calculation for the same ledger, month, savings view, and detail.

### Global reconciliation

Pass-through pools join the existing accounting audit:

- each pool reports incoming, outgoing, and net;
- global total sources equal total destinations within dashboard-currency tolerance;
- missing FX or unsupported transitions remain blocking evidence; and
- no residual is silently clipped or rounded before reconciliation.

## Presentation and explainability

- Pass-through nodes use their human-readable account names, never raw IDs when the account is available.
- The active chart note names the order mode, detail rule, threshold when applicable, dashboard currency, pass-through enabled state, and selected pass-through accounts.
- Exact Values and the details popup include pass-through routes and component evidence.
- Unsupported transitions show one actionable card-level message with exact transaction IDs, a transaction drill-down, and the option to disable pass-through treatment.
- Empty and stale states follow the existing Money Flow card behavior.
- Light/dark colors and patterns remain semantic; the new pool must not rely on color alone.

## Data flow and implementation boundaries

### Pure calculation

`front/utils/AnalyticsUtils.js` will:

- resolve Money Flow endpoint overrides from the enabled pass-through account-ID set;
- build, balance, and audit per-account pass-through pools;
- support numeric Top-N, All, and threshold detail policies;
- apply amount or semantic-family ordering; and
- preserve full nodes, links, component detail, refund coverage, and transaction IDs.

`front/utils/AnalyticsCategoryPresentationUtils.js` may host or consume the pure presentation comparator, but it must not gain financial classification logic.

### Store

`front/stores/analyticsStoreFactory.js` will:

- persist and normalize the five settings;
- compute eligible/effective pass-through accounts from the refreshed account snapshot;
- pass the enabled account IDs, order, and detail policy into the monthly builder/limiter; and
- expose the full graph for exact details and the limited/ordered graph for rendering.

The store must not pass the role into shared ledger construction, account-balance reconstruction, or forecast inputs.

### UI and chart

`front/components/analytics/analytics-money-flow.vue` will:

- render the controls and account-selection popup;
- resolve account/category labels through existing dictionaries;
- present role/audit definitions; and
- retain existing exact-details and transaction-list navigation.

`front/components/charts/layered-money-flow-chart.vue` and `front/utils/ChartUtils.js` should need only the smallest changes required for the additional graph stage and interaction repair after settings change. Geometry continues to support intrinsic scrolling, non-overlapping 44px targets, nearest-centerline ribbon selection, and mobile condensation without dropping pass-through pools.

Shared styles belong in `front/assets/styles/theme-white.css` with dark overrides in `front/assets/styles/theme-dark.css`. All locale files receive the new labels and messages.

## Error and state behavior

- Empty eligible account list: selection is empty and pass-through treatment has no effect.
- Invalid persisted order/detail: repair to existing safe defaults.
- Invalid persisted threshold: retain the last valid finite nonnegative value; initial value is zero.
- Deleted/inactive/ineligible account: remove it from the effective role set once account data is available.
- Unsupported pass-through transition: withhold only the pass-through Money Flow graph, preserve exact audit evidence, and offer transaction drill-down plus retry/disable actions.
- Missing currency: preserve the existing blocking FX behavior.
- Loading or source failure: preserve retained/stale-data and retry behavior.

## Verification

### Focused automated proof

Fixtures must cover:

- amount ordering and stable tie-breaking;
- approved type-family order on both outer sides;
- `Other` placement within each family;
- Top 5, Top 10, All, and threshold mode;
- threshold equality, zero, a lone sub-threshold node, two-or-more grouping, incompatible groups, opposing signs, both savings groups, and exact grouped evidence;
- balanced Revenue -> Pass-through -> Expense/Savings/Available/Debt distribution;
- existing pass-through funds and retained pass-through balance;
- multiple selected pass-through accounts;
- pass-through-to-pass-through internal reallocation;
- unsupported Available/Savings inbound transitions and exact audit IDs;
- treatment-off plus Amount-order byte-equivalence with the previous Money Flow graph;
- store persistence and repair for all new settings;
- human-readable labels and exact transaction routing; and
- unchanged balances, forecasts, Cash Use, category analytics, and shared ledger classifications.

### Broader gates

- focused Money Flow/store/component tests;
- full analytics test suite;
- touched ESLint and Prettier checks;
- locale JSON parse and key parity;
- production Nuxt build;
- `git diff --check` and contribution preflight; and
- exact `docker-compose -f docker-compose.pico.local.yml build firefly-pico` image build.

### Rendered browser verification

Using the authenticated final Docker image:

- compare treatment off/on for the selected payroll account;
- exercise Amount and Type ordering;
- exercise Top 5, Top 10, All, and several threshold values;
- confirm one sub-threshold item stays named and two-or-more become `Other`;
- inspect pass-through, expense, savings, debt, and excess paths;
- verify exact transaction drill-down;
- verify unsupported-transition recovery;
- test hover, click/tap, keyboard traversal, pinning, and dismissal;
- test mobile and desktop plus light and dark themes;
- check horizontal/intrinsic fit and 44px targets; and
- confirm no browser console errors or warnings attributable to the feature.

Real-data verification records account names and amounts only in ignored/private evidence, never in committed files.

## Acceptance criteria

1. Amount mode reproduces the current graph ordering and values.
2. Type mode orders the left and right outer families exactly as approved and sorts within each family by amount then label.
3. One dashboard-currency threshold controls every compatible outer family; only two-or-more sub-threshold siblings become `Other`.
4. Pass-through roles are configured from Money Flow, persisted for reuse, and independently enabled/disabled.
5. Treatment off produces the current Available-pool graph without clearing assigned roles.
6. Treatment on shows actual pass-through distributions, explicit existing/retained residuals, and balanced totals without inventing income.
7. Unsupported transitions are visible, evidence-backed, and recoverable; they never silently disappear.
8. Every actual visible or grouped value drills into the exact transaction set used.
9. Other analytics and Firefly account metadata remain unchanged.
10. Mobile/desktop, light/dark, automated, production-build, Docker-build, and authenticated-browser gates pass or are reported honestly as `NOT RUN`.

## Rollback

The user-visible rollback is immediate: disable pass-through treatment to restore current account classification. Removing the role selection removes the configuration. Code rollback requires only the focused commits; no database, Firefly, or user-ledger migration is involved.
