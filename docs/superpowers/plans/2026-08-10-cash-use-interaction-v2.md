# Cash Use Interaction and Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cash Use category detail, legend encoding, series/month inspection, monthly values, and exact transaction drill-down operate as one synchronized interaction.

**Architecture:** Keep `buildCashUseSeries()` as the sole financial projection. Add one pure presentation-style projection and extend the existing pure combination-chart resolver/reducer to represent transient and pinned `month`, `series`, and `seriesMonth` selections. The combination chart owns its interactive legend and selected-series monthly row so all visual consumers share one state and one evidence source.

**Tech Stack:** Nuxt 4 SPA, Vue 3 `<script setup>`, Pinia 3, Vant 4, plain JavaScript, SVG, CSS custom properties, Node test runner, Docker Compose.

## Global Constraints

- Stay on `personal/extended-analytics`; do not push, sync the fork, open an issue, or create a pull request.
- Cash Use only: do not change forecast formulas, Daily Forecast, Financial Trends, Spending by Category, Money Flow, or balance calculations.
- Plain JavaScript and Vue SFCs only; no TypeScript, JSDoc types, new npm packages, native fetch, or scoped styles.
- Use the existing Cash Use point values, statuses, transaction IDs, and projected evidence; do not introduce a second financial calculation path.
- Preserve current dashboard currency conversion and explicit unavailable/partial semantics.
- Preserve exact Firefly transaction drill-down; projected-only values must not invent transaction routes.
- Use existing CSS theme files and add matching dark-theme behavior for new hardcoded presentation colors.
- Update all 11 locale files for every new user-facing label.
- Maintain 44px touch targets, keyboard parity, mobile/desktop layouts, and light/dark themes.
- Use strict TDD: capture the complete focused RED for each task before production edits, then run focused GREEN and full analytics regression checks.
- Keep unrelated user changes unstaged and out of every commit.

---

## File responsibility map

- `front/utils/AnalyticsCashUseUtils.js`: financial Cash Use projection, deterministic visual-style projection, area/month geometry, and pure interaction reducer.
- `front/components/charts/analytics-combination-chart.vue`: shared selection coordinator, SVG highlights, scroll geometry, and selection-to-drill-down projection.
- `front/components/charts/analytics-cash-use-legend.vue`: accessible patterned legend buttons only.
- `front/components/charts/analytics-cash-use-month-row.vue`: accessible chart-aligned selected-series values only.
- `front/components/analytics/analytics-cash-use.vue`: Cash Use card controls, labels, styles passed into the chart, card-local warnings, and final navigation.
- `front/stores/analyticsStoreFactory.js`: persisted Cash Use mode/period/detail projection; shared category selection remains available to other cards but does not affect Cash Use.
- `front/assets/styles/variables.css`, `theme-white.css`, `theme-dark.css`: category palette, SVG/legend patterns, highlights, responsive shared scrolling, and theme contrast.
- `front/i18n/locales/*.json`: accessible legend, selection, value-row, and drill-down copy.
- `front/tests/utils/AnalyticsCashUseUtils.test.js`: pure financial, style, geometry, reducer, and static component wiring proof.
- `front/tests/stores/analyticsStore.test.js`: store isolation, SSR card integration, locale parity, and exact route evidence.

---

### Task 1: Unify category detail and correct layer order

**Files:**
- Modify: `front/utils/AnalyticsCashUseUtils.js:349-352,506-600`
- Modify: `front/stores/analyticsStoreFactory.js:916-940`
- Test: `front/tests/utils/AnalyticsCashUseUtils.test.js`
- Test: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Consumes: existing `buildCashUseSeries({ ledger, remainingActivity, months, mode, savingsView, detailLevel })` inputs.
- Produces: `visibleCategoryIds`, `hiddenCategoryIds`, and `useLayers` driven only by `detailLevel`; Full-mode `useLayers` ordered as categories, optional `Other`, Debt repaid, then Savings deposited.

- [ ] **Step 1: Write the failing detail-synchronization tests**

Add a pure regression whose ranking contains at least 12 categories and whose former explicit `categoryIds` contains a category outside the limit:

```js
const rankedCategoryEntries = (count) =>
  Array.from({ length: count }, (_, index) =>
    entry({
      id: `ranked-${index + 1}`,
      value: count - index,
      sourceKind: 'available',
      destinationKind: 'expense',
      categoryId: `category-${index + 1}`,
    }),
  )

test('Cash Use detail alone owns visible categories and Other', () => {
  const topFive = build({ entries: rankedCategoryEntries(12), categoryIds: ['category-12'], detailLevel: 5 })

  assert.deepEqual(topFive.visibleCategoryIds, ['category-1', 'category-2', 'category-3', 'category-4', 'category-5'])
  assert.deepEqual(topFive.useLayers.filter(({ kind }) => kind === 'expenseCategory').map(({ categoryId }) => categoryId), topFive.visibleCategoryIds)
  assert.deepEqual(topFive.useLayers.find(({ kind }) => kind === 'otherExpense').categoryIds, [
    'category-6',
    'category-7',
    'category-8',
    'category-9',
    'category-10',
    'category-11',
    'category-12',
  ])
})
```

Add store assertions that changing `selectedCategoryIds` does not change `cashUseSeries.visibleCategoryIds`, while changing `cashUseDetail` does.

- [ ] **Step 2: Write the failing layer-order tests**

Use Full mode with split savings and nonzero category, debt, accessible savings, and restricted savings values:

```js
assert.deepEqual(
  series.useLayers.map(({ kind }) => kind),
  ['expenseCategory', 'otherExpense', 'debtRepaid', 'savingsAccessibleDeposit', 'savingsRestrictedDeposit'],
)
```

Also assert that `totalUses`, transaction IDs, projected evidence, and reconciliation totals are unchanged when the same layer values are summed in the new order.

- [ ] **Step 3: Run the Task 1 RED gate**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js tests/stores/analyticsStore.test.js
```

Expected: FAIL because explicit category selection still extends detail and savings currently precedes debt.

- [ ] **Step 4: Remove category selection from Cash Use projection**

Delete the `categoryIds` parameter from the production `buildCashUseSeries()` signature and replace `selectedCategories()` with detail-only slicing:

```js
const categoriesForDetail = ({ ranking, detailLevel }) => (detailLevel === 'all' ? ranking : ranking.slice(0, detailLevel))

const visibleCategoryIds = categoriesForDetail({ ranking, detailLevel: selectedDetailLevel })
const hiddenCategoryIds = ranking.filter((id) => !visibleCategoryIds.includes(id))
```

Remove `categoryIds: persistedSelectedCategoryIds.value` from the store's Cash Use call. Do not remove `selectedCategoryIds` from the store because Spending by Category still owns it.

- [ ] **Step 5: Move Debt repaid before Savings deposited**

Build the debt layer immediately after `categoryGroups`, then append the existing combined/split savings layers. Reuse the existing buckets and forecast projection without changing values or evidence:

```js
if (selectedMode === 'full') {
  useLayers.push({
    id: 'debt:repaid',
    kind: 'debtRepaid',
    labelKey: 'analytics.cash_use.debt_repaid',
    pattern: 'debt',
    points: monthKeys.map((x) => {
      const isForecast = x === forecastX
      const key = isForecast ? currentMonthKey : x
      return buildLayerPoint({
        x,
        kind: isForecast ? 'forecast' : 'actual',
        actual: actual.get(key)?.debtRepaid ?? emptyBucket(),
        projected: isForecast ? projectedWithStatus(projectedFor(future, () => true, 'debtRepayments'), ['debtRepayments']) : undefined,
      })
    }),
  })

  for (const id of savingsGroups) {
    const savingsProjection = projectedSavingsFor(future, id)
    const projection = projectedWithStatus(savingsProjection, ['savingsDeposits', 'savingsWithdrawals'], savingsProjection.value < 0 ? 'savingsWithdrawals' : 'savingsDeposits')
    useLayers.push({
      id: `savings:${id}`,
      kind: id === 'combined' ? 'savingsDeposit' : id === 'accessible' ? 'savingsAccessibleDeposit' : 'savingsRestrictedDeposit',
      labelKey: `analytics.cash_use.savings_${id}`,
      pattern: id === 'restricted' ? 'restricted-savings' : 'accessible-savings',
      points: monthKeys.map((x) => {
        const isForecast = x === forecastX
        const key = isForecast ? currentMonthKey : x
        return buildLayerPoint({
          x,
          kind: isForecast ? 'forecast' : 'actual',
          actual: bucketForSavingsUse(actual.get(key)?.savings[id] ?? emptyBucket()),
          projected: isForecast ? projectedSavingsUse(projection) : undefined,
        })
      }),
    })
  }
}
```

Keep `sourceBands`, `totalUses`, `totalSources`, gap formulas, and reconciliation logic unchanged.

- [ ] **Step 6: Run focused GREEN and full analytics regression**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js tests/stores/analyticsStore.test.js
npm run test:analytics
```

Expected: focused tests PASS and full analytics remains green.

- [ ] **Step 7: Commit Task 1**

```powershell
git add front/utils/AnalyticsCashUseUtils.js front/stores/analyticsStoreFactory.js front/tests/utils/AnalyticsCashUseUtils.test.js front/tests/stores/analyticsStore.test.js
git commit -m "fix: unify cash use category detail"
```

---

### Task 2: Add deterministic series styles and faithful legend projection

**Files:**
- Modify: `front/utils/AnalyticsCashUseUtils.js`
- Modify: `front/tests/utils/AnalyticsCashUseUtils.test.js`
- Modify: `front/assets/styles/variables.css`

**Interfaces:**
- Produces: `buildCashUseVisualStyles({ series, categoryColors, sourceColors, semanticColors }) -> Record<string, { color, pattern, markerKind }>`.
- Style IDs consumed later: `solid`, `category-dots`, `category-horizontal`, `category-grid`, `refund`, `accessible-savings`, `restricted-savings`, `debt`, `gap-positive`, `gap-negative`, `line`, `dotted-line`.

- [ ] **Step 1: Write failing visual-style tests**

Cover Top 5, Top 10, and a 20-category All fixture:

```js
test('Cash Use assigns deterministic non-colliding visual tuples', () => {
  const styles = buildCashUseVisualStyles({
    series: build({ entries: rankedCategoryEntries(20), detailLevel: 'all' }),
    categoryColors: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'],
    sourceColors: ['s1', 's2', 's3'],
    semanticColors: { income: 'green', expense: 'pink', transfer: 'blue', neutral: 'grey' },
  })
  const categoryTuples = Object.entries(styles)
    .filter(([id]) => id.startsWith('category:'))
    .map(([, style]) => `${style.color}|${style.pattern}|${style.markerKind}`)

  assert.equal(new Set(categoryTuples).size, categoryTuples.length)
  assert.deepEqual(styles['gap-positive'], { color: 'green', pattern: 'gap-positive', markerKind: 'area' })
  assert.deepEqual(styles['ordinary-income'], { color: 'green', pattern: 'line', markerKind: 'line' })
  assert.deepEqual(styles['total-sources'], { color: 'grey', pattern: 'dotted-line', markerKind: 'line' })
})
```

Assert that the same input shuffled by non-category source order returns byte-identical style JSON and that `category:other` receives its stable distinct encoding.

- [ ] **Step 2: Run the Task 2 RED gate**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js
```

Expected: FAIL because `buildCashUseVisualStyles` does not exist.

- [ ] **Step 3: Add the pure style projection**

Add fixed category fallback patterns and build styles by semantic ID:

```js
const CATEGORY_PATTERNS = ['solid', 'category-dots', 'category-horizontal', 'category-grid']

export function buildCashUseVisualStyles({ series, categoryColors, sourceColors, semanticColors }) {
  const styles = {}
  const expenseLayers = series.useLayers.filter(({ kind }) => ['expenseCategory', 'otherExpense'].includes(kind))
  expenseLayers.forEach((layer, index) => {
    const isOther = layer.kind === 'otherExpense'
    styles[layer.id] = {
      color: isOther ? semanticColors.transfer : categoryColors[index % categoryColors.length],
      pattern: isOther ? 'category-dots' : CATEGORY_PATTERNS[Math.floor(index / categoryColors.length) % CATEGORY_PATTERNS.length],
      markerKind: 'area',
    }
  })

  for (const layer of series.useLayers.filter(({ kind }) => !['expenseCategory', 'otherExpense'].includes(kind))) {
    const savings = layer.kind.toLowerCase().includes('savings')
    styles[layer.id] = {
      color: savings ? sourceColors[layer.kind.includes('Restricted') ? 1 : 0] : semanticColors.expense,
      pattern: savings ? layer.pattern : 'debt',
      markerKind: 'area',
    }
  }

  for (const [index, band] of series.sourceBands.entries()) {
    styles[band.id] = {
      color: band.kind === 'refunds' || band.kind === 'newDebt' ? semanticColors.expense : sourceColors[index % sourceColors.length],
      pattern: band.pattern,
      markerKind: 'area',
    }
  }

  styles['refund-coverage'] = { color: semanticColors.expense, pattern: 'refund', markerKind: 'area' }
  styles['ordinary-income'] = { color: semanticColors.income, pattern: 'line', markerKind: 'line' }
  styles['gap-positive'] = { color: semanticColors.income, pattern: 'gap-positive', markerKind: 'area' }
  styles['gap-negative'] = { color: semanticColors.expense, pattern: 'gap-negative', markerKind: 'area' }
  styles['total-sources'] = { color: semanticColors.neutral, pattern: 'dotted-line', markerKind: 'line' }
  return styles
}
```

Keep these mappings keyed by stable IDs and kinds; do not infer semantic styles from translated labels.

- [ ] **Step 4: Expand the accessible category palette**

Add four category variables, with light and dark values that remain distinguishable from existing `--analytics-category-1..6`:

```css
--analytics-category-7: #5c6bc0;
--analytics-category-8: #ef5350;
--analytics-category-9: #8d6e63;
--analytics-category-10: #78909c;
```

Add dark-theme values in the existing `.van-theme-dark` variable block rather than hardcoding component colors.

- [ ] **Step 5: Run focused GREEN**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js
npx eslint --max-warnings 0 utils/AnalyticsCashUseUtils.js tests/utils/AnalyticsCashUseUtils.test.js
```

Expected: all focused tests and lint PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add front/utils/AnalyticsCashUseUtils.js front/tests/utils/AnalyticsCashUseUtils.test.js front/assets/styles/variables.css
git commit -m "feat: define cash use visual styles"
```

---

### Task 3: Extend pure area/month geometry and interaction state

**Files:**
- Modify: `front/utils/AnalyticsCashUseUtils.js`
- Modify: `front/tests/utils/AnalyticsCashUseUtils.test.js`

**Interfaces:**
- Produces selection objects `{ mode, seriesId, monthIndex }` where mode is `month`, `series`, or `seriesMonth`.
- Produces reducer state `{ previewSelection, pinnedSelection, isDragging, pointerStart, effect }`.
- Produces `displayCombinationSelection(state)` and `buildCombinationSelectedSegment({ points, xValues, monthIndex, xAt, yAt })`.
- `resolveCombinationChartTarget()` returns month-guide targets before filled-area targets.

- [ ] **Step 1: Write failing right-hand-month geometry tests**

Use three x positions at 80, 180, and 280. Assert a pointer at x=130 inside Housing returns month index 1, while a pointer within the mouse month corridor around x=180 returns month mode:

```js
const targetFixture = {
  bounds: { left: 0, top: 0, width: 360, height: 240 },
  viewBox: { width: 360, height: 240 },
  padding: { left: 80, right: 80, top: 20, bottom: 20 },
  xValues: ['2026-05', '2026-06', '2026-07'],
  areas: [
    {
      seriesId: 'category:housing',
      points: [
        { x: '2026-05', bottom: 0, top: 40 },
        { x: '2026-06', bottom: 0, top: 40 },
        { x: '2026-07', bottom: 0, top: 40 },
      ],
    },
  ],
  yAt: (value) => 160 - value,
}
const resolveTarget = ({ x, y, pointerType }) =>
  AnalyticsCashUseUtils.resolveCombinationChartTarget({
    ...targetFixture,
    clientPoint: { x, y },
    pointerType,
  })

assert.deepEqual(resolveTarget({ x: 130, y: 120, pointerType: 'mouse' }), {
  mode: 'seriesMonth',
  seriesId: 'category:housing',
  monthIndex: 1,
})
assert.deepEqual(resolveTarget({ x: 179, y: 120, pointerType: 'mouse' }), {
  mode: 'month',
  seriesId: null,
  monthIndex: 1,
})
```

Test paint-order boundaries, forecast interval selection, first-month guide selection, and 44px touch corridors.

- [ ] **Step 2: Write failing highlight-geometry tests**

Assert the selected segment path uses only the previous and current month top/bottom coordinates, and the month band spans the same interval:

```js
const segment = AnalyticsCashUseUtils.buildCombinationSelectedSegment({
  points: [
    { x: 'may', top: 90, bottom: 160 },
    { x: 'june', top: 80, bottom: 150 },
  ],
  xValues: ['may', 'june'],
  monthIndex: 1,
  xAt: (index) => 180 + index * 100,
  yAt: (value) => value,
})
const band = AnalyticsCashUseUtils.buildCombinationMonthBand({ monthIndex: 2, xAt: (index) => 80 + index * 100 })

assert.equal(segment.d, 'M 180 90 L 280 80 L 280 150 L 180 160 Z')
assert.deepEqual(band, { x: 180, width: 100, monthIndex: 2 })
```

- [ ] **Step 3: Write failing reducer tests**

Cover these exact transitions:

```js
state = reduceCombinationChartInteraction(state, { type: 'legendPreview', seriesId: 'category:housing' })
assert.deepEqual(displayCombinationSelection(state), { mode: 'series', seriesId: 'category:housing', monthIndex: -1 })

state = reduceCombinationChartInteraction(state, { type: 'legendToggle', seriesId: 'category:housing' })
assert.deepEqual(state.pinnedSelection, { mode: 'series', seriesId: 'category:housing', monthIndex: -1 })

state = reduceCombinationChartInteraction(state, { type: 'pointerMove', target: { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 2 } })
assert.equal(displayCombinationSelection(state).monthIndex, 2)

state = reduceCombinationChartInteraction(state, { type: 'pointerLeave' })
assert.deepEqual(displayCombinationSelection(state), state.pinnedSelection)
```

Also cover second-toggle clear, outside clear, Escape, Home/End/Left/Right traversal, point-count repair, touch pinning, month-only behavior, and selected-row activation effects.

- [ ] **Step 4: Run the Task 3 RED gate**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js
```

Expected: FAIL on the new modes, right-hand interval resolver, and geometry exports.

- [ ] **Step 5: Implement the minimal pure selection model**

Normalize every selection through one helper:

```js
const normalizeSelection = ({ mode, seriesId = null, monthIndex = -1 } = {}) => ({
  mode: ['month', 'series', 'seriesMonth'].includes(mode) ? mode : null,
  seriesId: mode === 'month' ? null : seriesId,
  monthIndex: mode === 'series' ? -1 : Number.isInteger(monthIndex) ? monthIndex : -1,
})

export const displayCombinationSelection = (state) => state.previewSelection ?? state.pinnedSelection ?? normalizeSelection()
```

Keep interaction effects explicit: `{ type: 'select' }`, `{ type: 'clear' }`, and `{ type: 'selectRow', item, activation }`.

- [ ] **Step 6: Implement right-hand target and highlight geometry**

Resolve the guide corridor first. Outside it, find the first x axis at or right of the pointer, reject index 0 as an area interval, interpolate the candidate areas at the pointer x, and return the topmost painted match:

```js
const position = xValues.length > 1 ? ((svgX - padding.left) / innerWidth) * (xValues.length - 1) : 0
const guideIndex = Math.min(xValues.length - 1, Math.max(0, Math.round(position)))
const guideSvgX = padding.left + (guideIndex / Math.max(1, xValues.length - 1)) * innerWidth
const guideClientX = bounds.left + (guideSvgX / viewBox.width) * bounds.width
if (Math.abs(clientPoint.x - guideClientX) <= (pointerType === 'touch' ? 22 : 10)) return { mode: 'month', seriesId: null, monthIndex: guideIndex }

const monthIndex = Math.ceil(Math.min(xValues.length - 1, Math.max(0, position)))
if (monthIndex <= 0) return null
for (let areaIndex = areas.length - 1; areaIndex >= 0; areaIndex--) {
  const area = areas[areaIndex]
  const interpolated = interpolateCombinationArea({ points: area.points, xValues, position })
  if (!interpolated) continue
  const y1 = yAt(interpolated.bottom)
  const y2 = yAt(interpolated.top)
  if (svgY >= Math.min(y1, y2) && svgY <= Math.max(y1, y2)) return { mode: 'seriesMonth', seriesId: area.seriesId, monthIndex }
}
return null
```

Build the selected segment and band from the same `monthIndex` so they cannot diverge:

```js
export const buildCombinationMonthBand = ({ monthIndex, xAt }) =>
  monthIndex <= 0 ? null : { x: xAt(monthIndex - 1), width: xAt(monthIndex) - xAt(monthIndex - 1), monthIndex }
```

- [ ] **Step 7: Run focused GREEN and diff checks**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js
npx prettier --check utils/AnalyticsCashUseUtils.js tests/utils/AnalyticsCashUseUtils.test.js
git diff --check
```

Expected: focused tests and static checks PASS.

- [ ] **Step 8: Commit Task 3**

```powershell
git add front/utils/AnalyticsCashUseUtils.js front/tests/utils/AnalyticsCashUseUtils.test.js
git commit -m "feat: add compound cash use selection"
```

---

### Task 4: Render interactive legend, combined highlight, and monthly values

**Files:**
- Create: `front/components/charts/analytics-cash-use-legend.vue`
- Create: `front/components/charts/analytics-cash-use-month-row.vue`
- Modify: `front/components/charts/analytics-combination-chart.vue`
- Modify: `front/tests/utils/AnalyticsCashUseUtils.test.js`

**Interfaces:**
- Legend consumes `items`, `displaySelection`, and `pinnedSelection`; emits `preview`, `leave`, and `toggle` events.
- Month row consumes `series`, `monthKeys`, `activeMonthIndex`, `canvasWidth`, `padding`, and `valueFormatter`; emits `activate` with `{ point, activation }`.
- Combination chart accepts optional `legendItems`; it remains compatible with Daily Forecast when the array is empty.

- [ ] **Step 1: Write failing component-contract tests**

Add source/SSR assertions for:

- legend entries are `<button type="button">` with 44px class hooks;
- markers consume the exact item color, pattern, and marker kind;
- pointer enter/focus previews and click/Enter/Space toggles;
- SVG renders a selected month band and selected segment outline;
- area and line paths both receive active/dimmed classes;
- month row renders only for `pinnedSelection.seriesId`;
- every row cell uses the selected series' existing point object;
- unavailable and projected-only cells are disabled for navigation;
- Daily Forecast renders without a legend or monthly row.

Use direct source assertions only for Vue wiring; keep behavior assertions in the pure reducer/geometry tests.

- [ ] **Step 2: Run the Task 4 RED gate**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js
```

Expected: FAIL because both child components and new chart hooks are absent.

- [ ] **Step 3: Create the accessible legend component**

Implement the component around an actual list of buttons:

```vue
<div class="analytics-cash-use-legend" role="list" :aria-label="ariaLabel">
  <span v-for="item in items" :key="item.id" role="listitem">
    <button
      type="button"
      class="analytics-cash-use-legend-item"
      :class="{ active: displaySelection?.seriesId === item.id, pinned: pinnedSelection?.seriesId === item.id }"
      @pointerenter="$emit('preview', item.id)"
      @pointerleave="$emit('leave')"
      @focus="$emit('preview', item.id)"
      @blur="$emit('leave')"
      @click="$emit('toggle', item.id)"
    >
      <span class="analytics-cash-use-legend-marker" :data-pattern="item.pattern" :data-marker-kind="item.markerKind" :style="{ color: item.color, '--legend-color': item.color }" />
      <span>{{ item.label }}</span>
    </button>
  </span>
</div>
```

Declare props and emits with plain JavaScript. Native button keyboard behavior supplies Enter/Space activation.

- [ ] **Step 4: Create the selected-series month-row component**

Render one label and absolutely aligned month buttons inside the shared intrinsic canvas:

```vue
<div class="analytics-cash-use-month-row" :style="{ width: `${canvasWidth}px` }">
  <div class="analytics-cash-use-month-row-label">
    <span class="analytics-cash-use-legend-marker" :data-pattern="series.pattern" :data-marker-kind="series.markerKind" :style="{ color: series.color, '--legend-color': series.color }" />
    <span>{{ series.label }}</span>
  </div>
  <button
    v-for="cell in cells"
    :key="cell.point.x"
    type="button"
    class="analytics-cash-use-month-cell"
    :class="{ active: cell.index === activeMonthIndex }"
    :style="{ left: `${cell.x}px` }"
    :disabled="!cell.canNavigate"
    @click="$emit('activate', { point: cell.point, activation: 'pointer' })"
  >
    <span>{{ cell.monthLabel }}</span>
    <strong>{{ valueFormatter(cell.point.value) }}</strong>
  </button>
</div>
```

Derive `canNavigate` from actual `transactionIds.length > 0`; keep projected source/candidate/evidence IDs visible as qualifiers but non-navigable.

- [ ] **Step 5: Extend chart rendering without breaking Daily Forecast**

In `analytics-combination-chart.vue`:

1. accept `legendItems: { type: Array, default: () => [] }`;
2. normalize the new reducer state;
3. render the legend only when nonempty;
4. wrap SVG and selected row in `.analytics-combination-scroll` and a shared intrinsic canvas;
5. compute compact intrinsic width only when `pointCount >= 12`;
6. render full-height month band behind data paths;
7. render the selected segment outline above its area and below tooltips;
8. apply active/dimmed classes to area paths, income/total lines, refund overlays, source bands, and gap paths;
9. show the compact `series · month` value callout for `seriesMonth` mode;
10. retain the all-series tooltip for `month` mode;
11. render the month row only for a pinned series;
12. bring a selected month cell into the shared viewport.

Use the reducer for legend events:

```js
const onLegendPreview = (seriesId) => applyInteraction({ type: 'legendPreview', seriesId })
const onLegendLeave = () => applyInteraction({ type: 'legendLeave' })
const onLegendToggle = (seriesId) => applyInteraction({ type: 'legendToggle', seriesId })
```

- [ ] **Step 6: Preserve exact drill-down emission**

Resolve the selected legend series through the same series registry used by hover and tooltip rows. When a month cell activates, emit the existing `select-point` payload using that exact point and series ID. Do not flatten projected evidence into transaction IDs.

- [ ] **Step 7: Run focused GREEN and production build**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js tests/stores/analyticsStore.test.js
npx eslint --max-warnings 0 components/charts/analytics-combination-chart.vue components/charts/analytics-cash-use-legend.vue components/charts/analytics-cash-use-month-row.vue tests/utils/AnalyticsCashUseUtils.test.js
npx prettier --check components/charts/analytics-combination-chart.vue components/charts/analytics-cash-use-legend.vue components/charts/analytics-cash-use-month-row.vue tests/utils/AnalyticsCashUseUtils.test.js
npm run build
```

Expected: focused tests, lint, formatting, and Nuxt build PASS.

- [ ] **Step 8: Commit Task 4**

```powershell
git add front/components/charts/analytics-combination-chart.vue front/components/charts/analytics-cash-use-legend.vue front/components/charts/analytics-cash-use-month-row.vue front/tests/utils/AnalyticsCashUseUtils.test.js
git commit -m "feat: inspect cash use series by month"
```

---

### Task 5: Integrate Cash Use card, themes, and locales

**Files:**
- Modify: `front/components/analytics/analytics-cash-use.vue`
- Modify: `front/assets/styles/theme-white.css`
- Modify: `front/assets/styles/theme-dark.css`
- Modify: `front/i18n/locales/de-DE.json`
- Modify: `front/i18n/locales/en.json`
- Modify: `front/i18n/locales/es-MX.json`
- Modify: `front/i18n/locales/fr.json`
- Modify: `front/i18n/locales/it.json`
- Modify: `front/i18n/locales/ko.json`
- Modify: `front/i18n/locales/pl.json`
- Modify: `front/i18n/locales/pt-BR.json`
- Modify: `front/i18n/locales/ro.json`
- Modify: `front/i18n/locales/ru-RU.json`
- Modify: `front/i18n/locales/zh-CN.json`
- Modify: `front/tests/utils/AnalyticsCashUseUtils.test.js`
- Modify: `front/tests/stores/analyticsStore.test.js`

**Interfaces:**
- Cash Use card passes `legendItems` built from the style map into the combination chart.
- Card retains only mode, history period, and detail controls.
- Existing `onSelectPoint()` remains the only transaction navigation boundary.

- [ ] **Step 1: Write the complete integration RED tests**

Assert the rendered/source contract:

```js
assert.doesNotMatch(cashUseSource, /analytics-category-facet/)
assert.doesNotMatch(cashUseSource, /selectedCategoryIds/)
assert.match(cashUseSource, /:legend-items="legendItems"/)
assert.match(cashUseSource, /buildCashUseVisualStyles/)
```

Add SSR assertions that `Top 5` renders five categories plus `Other`, `Top 10` renders ten plus `Other`, and `All` renders all categories without `Other`. Assert legend labels and month tooltip categories match the same IDs in order.

Add locale parity assertions for these English keys in all 11 locale files:

```json
{
  "selected_series_values": "Monthly values for {series}",
  "series_month_value": "{series}, {month}: {value}",
  "drilldown_available": "Open contributing transactions",
  "drilldown_unavailable": "No completed transactions to open",
  "selected_area": "Selected area",
  "selected_month_band": "Selected month"
}
```

Localized text may differ, but every value must be a nonempty string and locale structures must match.

- [ ] **Step 2: Run the Task 5 RED gate**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js tests/stores/analyticsStore.test.js
```

Expected: FAIL because the facet still renders, the style map is unused, and locale keys/styles are absent.

- [ ] **Step 3: Simplify the Cash Use card**

Remove the category facet, `selectedCategoryIds`, `facetItems`, and the selected-count badge. Retain the three tab groups. Build the chart styles once:

```js
const visualStyles = computed(() =>
  buildCashUseVisualStyles({
    series: cashUse.value,
    categoryColors: CATEGORY_COLORS,
    sourceColors: SOURCE_COLORS,
    semanticColors: {
      income: 'var(--income2)',
      expense: 'var(--expense2)',
      transfer: 'var(--transfer2)',
      neutral: 'var(--van-text-color-2)',
    },
  }),
)
```

Apply those styles to `chartSeries` and create legend items from visible nonempty series. Give composite refund coverage one logical ID and aggregate point projection. Pass `legendItems` into `<analytics-combination-chart>`.

- [ ] **Step 4: Add faithful marker, highlight, row, and shared-scroll CSS**

In `theme-white.css`, add styles for:

- interactive legend buttons with 44px minimum size;
- exact solid/pattern/line marker renderings;
- active, pinned, hover, focus-visible, and dimmed states;
- full-height month band;
- selected area-segment outline;
- compact area/month callout;
- chart-and-row shared horizontal scroll;
- selected-series row label and 44px cells;
- disabled/unavailable/forecast qualifiers;
- mobile nowrap legend and desktop wrapping.

Use these concrete hooks as the baseline, adding pattern-specific gradients for every style ID from Task 2:

```css
.analytics-cash-use-legend-item {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 6px 8px;
    gap: 6px;
    border: 0;
    border-radius: 7px;
    color: var(--van-text-color-2);
    background: transparent;
}

.analytics-cash-use-legend-marker {
    width: 18px;
    height: 10px;
    border-radius: 3px;
    background: var(--legend-color);
}

.analytics-cash-use-legend-marker[data-pattern='refund'],
.analytics-cash-use-legend-marker[data-pattern='gap-positive'],
.analytics-cash-use-legend-marker[data-pattern='gap-negative'] {
    background: repeating-linear-gradient(135deg, var(--legend-color) 0 2px, transparent 2px 6px);
}

.analytics-cash-use-legend-marker[data-marker-kind='line'] {
    height: 3px;
    border-radius: 2px;
}

.analytics-combination-month-band {
    fill: var(--analytics-selection-band);
    pointer-events: none;
}

.analytics-combination-selected-segment {
    fill: none;
    stroke: var(--analytics-selection-outline);
    stroke-width: 2.5;
    pointer-events: none;
}

.analytics-cash-use-month-cell {
    position: absolute;
    min-width: 56px;
    min-height: 44px;
    transform: translateX(-50%);
}
```

Add CSS custom properties for `--analytics-selection-band` and `--analytics-selection-outline` in both theme variable blocks. Add exact dotted, horizontal, grid, savings, debt, and dotted-line marker rules beside the diagonal examples. In `theme-dark.css`, override only contrast-sensitive surfaces, borders, and focus rings.

- [ ] **Step 5: Add all locale strings and parse them**

Update all 11 locale files. Then run:

```powershell
cd front
node -e "for (const file of require('fs').readdirSync('i18n/locales').filter((name) => name.endsWith('.json'))) JSON.parse(require('fs').readFileSync('i18n/locales/' + file, 'utf8')); console.log('locales ok')"
```

Expected: `locales ok`.

- [ ] **Step 6: Run focused GREEN, static checks, and full analytics**

Run:

```powershell
cd front
node --test tests/utils/AnalyticsCashUseUtils.test.js tests/stores/analyticsStore.test.js
npm run test:analytics
npx eslint --max-warnings 0 components/analytics/analytics-cash-use.vue components/charts/analytics-combination-chart.vue components/charts/analytics-cash-use-legend.vue components/charts/analytics-cash-use-month-row.vue utils/AnalyticsCashUseUtils.js tests/utils/AnalyticsCashUseUtils.test.js tests/stores/analyticsStore.test.js
npx prettier --check components/analytics/analytics-cash-use.vue components/charts/analytics-combination-chart.vue components/charts/analytics-cash-use-legend.vue components/charts/analytics-cash-use-month-row.vue utils/AnalyticsCashUseUtils.js tests/utils/AnalyticsCashUseUtils.test.js tests/stores/analyticsStore.test.js i18n/locales/*.json
npm run build
```

Expected: focused tests, 389-or-higher full analytics tests, touched lint/formatting, and build PASS. Do not claim a fixed test count; report the observed count.

- [ ] **Step 7: Commit Task 5**

```powershell
git add front/components/analytics/analytics-cash-use.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales front/tests/utils/AnalyticsCashUseUtils.test.js front/tests/stores/analyticsStore.test.js
git commit -m "feat: integrate cash use series details"
```

---

### Task 6: Adversarial review and rendered verification

**Files:**
- Modify only if a failing proof identifies a Cash Use defect in the files already owned by Tasks 1-5.
- Record exact commands and observations in the task handoff; do not add a tracked report unless requested.

**Interfaces:**
- Consumes the completed Cash Use slice.
- Produces evidence that calculations, interactions, responsive rendering, and container build work together.

- [ ] **Step 1: Run a focused adversarial self-review**

Probe these cases before broad gates:

- 0, 1, 5, 6, 10, 11, and 20 ranked categories;
- stable Top 5/10/All ordering and `Other` evidence;
- identical amounts with deterministic ID tiebreakers;
- combined and split savings;
- debt repayment with zero savings and savings with zero debt;
- refunds covering one and several categories;
- positive and negative gaps;
- unavailable completed amounts;
- partial, unavailable, fulfilled, and projected-only forecast points;
- first month, middle month, forecast month, and month-guide/area boundary targets;
- pointer, touch, keyboard, outside click, second click, and Escape;
- 24-month compact scroll alignment.

For any defect, add the smallest failing focused test first, reproduce RED, implement one root-cause fix, then rerun GREEN.

- [ ] **Step 2: Run final automated gates**

Run:

```powershell
cd front
npm run test:analytics
npm run build
```

Run touched-file ESLint/Prettier with `--max-warnings 0`, parse all locale JSON, and run from the repository root:

```powershell
git diff --check
pwsh -NoProfile -File .agents/skills/firefly-pico-oss-contribution/scripts/contribution-preflight.ps1
```

Expected: analytics and build PASS, diff check clean, locale parse PASS, and preflight has zero blockers. Report repository-wide baseline warnings separately.

- [ ] **Step 3: Build the Docker image**

Run from the repository root:

```powershell
docker-compose -f docker-compose.pico.local.yml build firefly-pico
```

Expected: `npm ci --ignore-scripts`, Nuxt production build, and final `firefly-pico:local` image export PASS.

- [ ] **Step 4: Verify the built image through authenticated Chrome**

Replace only the disposable `firefly-pico-analytics-preview` container created for this work and start `firefly-pico:local` on `http://localhost:6976`. Preserve the named preview volume.

In Chrome, verify Cash Use against real synchronized data:

1. Top 5/10/All changes chart areas, legend entries, month tooltip categories, and `Other` together.
2. Legend swatches match solid, savings, debt, refund, gap, and line encodings.
3. Legend hover/focus highlights one series; click pins it and opens the row.
4. Area hover between May and June shows June, outlines the Housing segment, and displays the subtle full-height June band.
5. Month-guide hover still shows all series for that month.
6. Clicking a row cell opens the exact transaction list; projected-only cells do not navigate.
7. Debt sits directly above categories and savings sits above debt in Full mode.
8. Desktop and 390x844 mobile layouts work in light and dark themes.
9. Twelve- and 24-month chart/row horizontal scrolling stays aligned and auto-reveals selection.
10. No loading deadlock, duplicate warning, inaccessible target, clipped tooltip, duplicate SVG paint ID, or browser console error appears.

- [ ] **Step 5: Final clean-state gate**

Run:

```powershell
git status --short
git log -6 --oneline
```

Expected: no uncommitted tracked or untracked implementation files, and only the focused plan commits plus any explicit RED-proof commits created by the executor.
