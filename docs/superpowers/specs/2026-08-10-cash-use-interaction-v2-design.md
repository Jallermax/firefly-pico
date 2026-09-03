# Cash Use Interaction and Detail Design

**Date:** 2026-08-10

**Status:** Approved in conversation

**Scope:** Personal-fork Cash Use card only

## Decision improved

The Cash Use chart should let the user answer three related questions without decoding the visualization:

1. What does each color, pattern, area, or line represent?
2. What was the value of one selected series in one selected month?
3. Which exact transactions produced that value?

The current chart contains the underlying evidence, but its legend does not faithfully reproduce chart patterns, legend entries are not interactive, a hovered area is not tied to a visually bounded month segment, and a second category facet can disagree with the `Top 5 / Top 10 / All` control.

## Product boundaries

### Personal outcome

- Make every Cash Use series visually identifiable from its legend marker.
- Synchronize category detail across the areas, legend, month tooltip, and monthly value row.
- Support series-only, month-only, and combined series-plus-month inspection.
- Preserve exact transaction drill-down and forecast evidence boundaries.
- Make expense categories plus debt visually comparable with ordinary income, while keeping savings movements visually separate.

### Generic core

- Reusable combination-chart selection state for a series and optional month.
- Reusable patterned legend markers.
- Reusable selected-series monthly value row backed by the chart's existing point evidence.

### Non-goals

- No changes to forecast calculations.
- No changes to Daily Forecast, Financial Trends, Spending by Category, Money Flow, or balance calculations.
- No new chart dependency.
- No change to Firefly transaction classification or account-kind rules.

## Current code anchors

- `front/components/analytics/analytics-cash-use.vue` builds labels, colors, legend items, controls, and transaction navigation.
- `front/components/charts/analytics-combination-chart.vue` renders areas, lines, month tooltips, hit testing, and interaction state.
- `front/utils/AnalyticsCashUseUtils.js` builds Cash Use layers and contains the pure geometry and interaction reducer.
- `front/stores/analyticsStoreFactory.js` persists the Cash Use mode, history period, and detail level.
- `front/tests/utils/AnalyticsCashUseUtils.test.js` and `front/tests/stores/analyticsStore.test.js` are the focused proof surfaces.
- `front/assets/styles/theme-white.css`, `theme-dark.css`, and `variables.css` own shared presentation and theme behavior.

## One category-detail control

The Cash Use card will remove its `selectedCategoryIds` facet and the `6 selected` badge. `cashUseDetail` becomes the only category-detail control:

- `Top 5` renders the five highest ranked category areas plus `Other` when hidden categories exist.
- `Top 10` renders the ten highest ranked category areas plus `Other` when hidden categories exist.
- `All` renders every ranked category and no synthetic `Other` layer.

The same visible category groups feed:

- chart areas;
- legend entries;
- all-series month tooltip rows;
- hover targets;
- selected-series monthly values;
- exact transaction drill-down.

No explicit category selection may extend Cash Use beyond the chosen detail level. Other analytics cards may continue to use their existing shared category selection independently.

## Layer order and financial meaning

Use layers are stacked from bottom to top in this order:

1. ranked expense categories;
2. synthetic `Other`, when present;
3. Debt repaid;
4. Savings deposited, combined or split into accessible and restricted savings according to the existing page-level savings view.

This makes ordinary consumption plus liability repayment one contiguous spending block. Savings deposits remain part of total Cash Use in Full mode, but sit above debt because they are internal allocation rather than consumption or liability spending.

Refund coverage, ordinary income, source bands, total sources, and positive or negative gap keep their existing formulas and evidence. This work changes their presentation and interaction, not their values.

## Visual encoding and legend fidelity

Every legend marker must reproduce the rendered series encoding rather than showing a generic color block:

- solid area: filled swatch;
- refund coverage: diagonal refund hatch;
- accessible savings: matching dotted pattern;
- restricted savings: matching cross pattern;
- debt: matching debt crosshatch;
- positive or negative gap: matching diagonal gap pattern and semantic color;
- ordinary income: matching solid line;
- total sources: matching dotted line;
- forecast remains a point/path state and is not a separate selectable legend series.

Visible expense categories receive deterministic style tuples. A style tuple is `(color, pattern, stroke)`. No two visible expense areas may share the same tuple. Use an expanded accessible category palette first; if `All` exceeds the palette, cycle category-only secondary patterns so an exact color-pattern combination does not repeat. `Other` receives a stable distinct neutral/teal encoding rather than inheriting a colliding category color.

Semantic source families may reuse a category hue only when their line or pattern makes the encoding distinct. One green category area and green income/new-excess semantics are acceptable because their families and encodings differ. The legend and chart must always use the same tuple.

## Interaction model

Extend the existing pure combination-chart interaction state instead of adding card-local duplicate state.

The state distinguishes:

- transient preview selection;
- pinned selection;
- selection mode: `month`, `series`, or `seriesMonth`;
- selected `seriesId`;
- optional selected `monthIndex`.

The displayed chart selection uses the transient preview while the pointer or focus is over a target, otherwise it uses the pinned selection. The monthly value row is controlled only by the pinned series, so incidental hover never replaces or removes an opened row.

### Legend interaction

- Hover or focus previews the series, strongly highlights all of its painted paths, and dims other areas and lines.
- Click, Enter, or Space pins the series and opens its monthly value row.
- Selecting the same pinned legend entry again clears it.
- Escape or outside click clears the pinned selection.
- Refund coverage is one logical legend series and highlights all of its category coverage overlays.

### Chart area interaction

- A pointer inside a filled area resolves the topmost painted series as today.
- Away from a month-guide corridor, the horizontal interval between the previous month axis and the current month axis belongs to the right-hand month. The area between May and June therefore represents June.
- The first displayed month has no preceding area interval; it remains selectable through its month guide and monthly row cell.
- Hovering an area produces a `seriesMonth` preview.
- The selected series remains strongly highlighted across the chart.
- The selected series segment receives a clear outline.
- A subtle full-height month band continues through all dimmed layers.
- A compact callout shows series name, month, and value, for example `Housing · June` and `2,321 USD`.
- Clicking the area pins the series and month and opens the monthly row with the same month selected.

### Month-guide interaction

The existing month-guide corridor takes precedence when the pointer is sufficiently close to a vertical month axis. It shows the all-series month tooltip and does not apply a series highlight. The tooltip uses the exact same category groups as the selected `Top 5 / Top 10 / All` level.

Mouse and touch hit corridors remain distinct: precise mouse targeting must not make broad areas ambiguous, while touch targets remain at least 44px.

## Selected-series monthly value row

Clicking any legend item or chart series opens one horizontal row directly beneath the chart.

The row contains:

- the exact legend marker;
- the series label;
- one value cell for every displayed month or forecast period;
- a selected state for the pinned or previewed month;
- forecast/partial/unavailable qualifiers where required.

The row supports every legend series, including:

- expense categories and `Other`;
- Debt repaid;
- Savings deposited and withdrawn variants;
- Refund coverage;
- Ordinary income;
- New debt;
- New excess or existing available funds required;
- Total sources.

The row must reuse the selected series' existing points. It must not recalculate financial values in the component.

For composite legend items:

- Refund coverage aggregates the per-category coverage overlays for each month and unions their exact refund and purchase transaction IDs.
- `Other` uses the exact hidden category set for the active detail level.
- Total sources and gap rows use their existing aggregate point evidence.

Clicking a transaction-backed month cell navigates to the transaction list filtered to the exact contributing Firefly transaction IDs. A derived series drills into the exact union of its contributing transaction evidence. An unavailable value displays `—` and is disabled. A projected-only value remains visible with its forecast provenance but does not invent a transaction route.

## Responsive layout

Desktop keeps the legend wrapped above the chart. Mobile keeps it horizontally scrollable. Every legend item is an interactive 44px target even when its visual marker is smaller.

For 12- and 24-month compact layouts, the chart and monthly value row share one horizontal scrolling viewport and one intrinsic plot width. Month columns therefore remain aligned and readable instead of compressing values into unusable cells. Selecting a month scrolls its column into view. The card controls and calculation details do not participate in this horizontal scroll.

## Accessibility

- The legend is an explicitly named list of buttons, not decorative spans.
- Marker meaning is repeated in text; pattern is not the only label.
- Focus preview matches pointer hover.
- Enter or Space pins a legend series.
- Left/Right, Home, and End traverse displayed months for a pinned series.
- Enter on a transaction-backed month cell activates drill-down.
- Escape clears the selection and returns focus predictably.
- The live region announces series, month, value, forecast status, and whether drill-down is available.
- Active and dimmed states retain sufficient contrast in light and dark themes.

## Error and partial-data behavior

- A missing or unavailable series value remains `—`; it is never converted to zero.
- Partial forecast values keep their existing actual-to-date, projected-remaining, progress, metric IDs, source IDs, candidate IDs, and evidence IDs.
- Chart, legend, tooltip, and row must remain internally consistent when one point is unavailable.
- Existing card-local retry and partial-warning behavior remains unchanged.
- Empty series are omitted from the legend and cannot be selected.

## Verification contract

### Pure and store tests

- `Top 5`, `Top 10`, and `All` produce the same category groups across area layers, legend projection, tooltip projection, and selected row.
- Explicit shared category selections cannot extend Cash Use detail.
- Layer order is categories, `Other`, debt, then savings.
- Every visible series has a deterministic non-colliding style tuple.
- Legend markers map to the exact chart pattern or line style.
- The reducer handles preview, pin, second-click clear, outside clear, Escape, keyboard traversal, and point-count repair for `month`, `series`, and `seriesMonth` modes.
- Area hit testing applies the right-hand month rule while month-guide corridors retain precedence.
- Selected segment geometry and the full-height month band use the same resolved month.
- Monthly rows reuse point values and exact evidence.
- Category, `Other`, refund coverage, debt, savings, income, total source, and gap drill-down routes contain the correct transaction IDs.
- Unavailable and projected-only cells do not navigate.
- Existing Cash Use reconciliation remains byte-for-byte unchanged by presentation-only inputs.

### Static and rendered proof

- All locale files contain the new accessible labels and selected-row text.
- Locale JSON parses and retains structural parity.
- Focused lint and formatting pass for touched files.
- Full analytics tests and production build pass.
- Docker image build passes.
- Authenticated Chrome verification covers:
  - desktop and mobile;
  - light and dark themes;
  - `Top 5`, `Top 10`, and `All`;
  - solid, patterned, and line legend selection;
  - area-plus-month hover and pin;
  - all-series month-guide tooltip;
  - chart-aligned monthly row and exact drill-down;
  - 12/24-month shared horizontal scrolling;
  - empty, partial, unavailable, and forecast states;
  - no console errors.

## Rollout, rollback, and publication

Implementation stays on `personal/extended-analytics`. It should be split into focused commits for data/order controls, shared interaction/geometry, and card styling/localization where practical.

Rollback is commit-level: removing this slice restores the current Cash Use chart without changing stored financial data or forecast results. No push, fork synchronization, issue, or pull request is authorized by this design approval.
