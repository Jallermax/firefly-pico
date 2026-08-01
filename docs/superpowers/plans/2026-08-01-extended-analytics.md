# Extended Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a dedicated, responsive Analytics page with accurate balance trends, category-spending history and forecast, and a reconciled monthly money-flow view.

**Architecture:** Load analytics only on /analytics through a dedicated Pinia store. Reuse one paginated 25-calendar-month transaction collection for category and flow calculations, use Firefly's range account-chart endpoint for balances, keep all finance semantics in deterministic utilities, and render charts with dependency-free SVG components.

**Tech Stack:** Nuxt 4 / Vue 3 script setup, Pinia 3 composition stores, Vant 4, date-fns 4, lodash-es, axios, native SVG, Node's built-in test runner, plain JavaScript only.

## Global Constraints

- The approved design is docs/superpowers/specs/2026-08-01-extended-analytics-design.md; do not change formulas or product decisions during implementation.
- Work on personal/extended-analytics. Do not push, publish, open an issue, or open a pull request without explicit user approval.
- Firefly III remains the system of record. Add no database migration, Laravel controller, or Nuxt server route.
- Add no npm or Composer dependency.
- Use plain .js and .vue files; no TypeScript or JSDoc type declarations.
- Follow front/.prettierrc: single quotes, no semicolons, trailing commas, two-space indentation, print width 200.
- Use repositories for HTTP, Pinia composition stores, defineModel(), auto-imported components, route constants, UIUtils feedback, and shared theme CSS.
- All labels must be present in every locale available at implementation time.
- Preserve the existing dashboard and its configured transaction exclusions. Apply getExcludedTransactionFilters() to transaction-derived analytics and disclose that assumption in the card notes.
- Never sum unlike raw currencies. Prefer Firefly primary-currency history; label current-rate conversion and omit missing conversions with their currency codes.
- Calculate split transactions exactly and retain Firefly transaction-group IDs for drilldown.
- Do not stage docs/local, .agents, .superpowers, local compose files, secrets, tokens, hostnames, or unrelated user changes.
- Every task ends with focused proof and a commit. Use PASS, FAIL, or NOT RUN honestly.

---

## Planning Context and Scope Boundary

**User decision improved:** The page answers three connected questions: how net worth/savings/debt changed, what category spending implies for the rest of the current month, and where the selected month's resources came from and went. Every summary retains an exact-value inspection path and transaction-backed drilldown where transactions exist.

**Owner-context anchors:** docs/local/firefly-ux-analytics-handoff.md sections Product values and non-negotiable behavior, Firefly usage and data-model expectations, Financial dashboard and analytics requirements, Mapping these needs onto the current Pico repo, and Acceptance benchmarks; docs/local/plans/2026-08-01-personal-improvements-roadmap.md workstreams 1 and 2; docs/local/zenmoney_charts_references/ for information-density and interaction inspiration only.

**Current code anchors:** front/pages/dashboard.vue and front/stores/dashboardStore.js for currency/month/dashboard patterns; front/utils/DashboardUtils.js for configured exclusions; front/models/Account.js and front/models/Transaction.js for transformed account/split semantics; front/repository/BaseRepository.js, TransactionRepository.js, and AccountRepository.js for HTTP; front/stores/appStore.js plus the bottom toolbar and left sidebar for navigation; front/assets/styles/variables.css, theme-white.css, and theme-dark.css for presentation.

**Personal-fork scope:** The /analytics information architecture, default periods, combined three-card page, category forecast policy, flow policy, and personal navigation ship first on personal/extended-analytics.

**Potential upstreamable slice:** Pure period/currency/account calculations, all-or-nothing paginated loading, and accessible dependency-free SVG chart inspection may later be promoted as focused commits. Upstream acceptance does not block the personal page.

**Unresolved owner decisions:** None block this implementation. Historical transaction/account values use the approved primary-value-first rule and visible current-rate fallback. Choosing a first upstream proposal remains a packaging decision after the personal feature is verified.

---

## File and Interface Map

### Pure calculation layer

- Create front/utils/AnalyticsUtils.js: account membership, amount conversion, balance normalization, category ledger/averages/forecast, and money-flow conservation.
- Create front/tests/utils/AnalyticsUtils.test.js: deterministic finance fixtures.
- Create front/utils/ChartUtils.js: dependency-free SVG coordinate/path helpers and nearest-point selection.
- Create front/tests/utils/ChartUtils.test.js: geometry and interaction-index proof.

AnalyticsUtils.js exports these stable interfaces:

~~~js
export const ANALYTICS_UNCATEGORIZED_ID = 'uncategorized'

export function getAnalyticsAccountGroups(accounts)
// returns { netWorth: Account[], savings: Account[], debt: Account[] }

export function convertAnalyticsAmount({
  amount,
  currencyCode,
  primaryAmount,
  primaryCurrencyCode,
  displayCurrencyCode,
  rates,
})
// returns { value: Number|null, isEstimated: Boolean, missingCurrency: String|null }

export function normalizeBalanceSeries({
  chartLines,
  metric,
  displayCurrencyCode,
  primaryCurrencyCode,
  rates,
})
// returns { points: [{ x, value }], isEstimated, missingCurrencies }

export function buildCategoryLedger({
  transactions,
  displayCurrencyCode,
  primaryCurrencyCode,
  rates,
})
// returns { months, ledgerStartMonth, isEstimated, missingCurrencies }

export function summarizeCategoryWindow({
  ledger,
  categoryIds,
  averageMonths,
  today,
})
// returns { requestedMonths, usedMonths, monthKeys, series }

export function rankCategoryIds({ ledger, averageMonths, today })
// returns category IDs ordered by descending completed-month net spending

export function buildMonthlyMoneyFlow({
  transactions,
  monthKey,
  displayCurrencyCode,
  primaryCurrencyCode,
  rates,
  currencyDecimalPlaces = 2,
})
// returns { sources, destinations, total, audit, isEstimated, missingCurrencies, isBalanced }
~~~

ChartUtils.js exports:

~~~js
export function buildLineChartGeometry({ series, width, height, padding })
// returns { xValues, yMin, yMax, series: [{ id, points, segments }] }

export function nearestPointIndex({ clientX, left, width, pointCount })
// returns a clamped integer or -1 when pointCount is zero
~~~

### HTTP and state layer

- Modify front/repository/BaseRepository.js: forward an optional pageSize through all merged pages and add an all-or-nothing merged result.
- Modify front/repository/TransactionRepository.js: allow analytics to suppress global loading/toasts while preserving defaults.
- Modify front/repository/AccountRepository.js: add getChartOverview().
- Create front/stores/analyticsStore.js: lazy requests, session caching, independent card states, selected periods/categories/month, computed results, and retry actions.

BaseRepository adds:

~~~js
async getAllWithMergeResult({ filters = [], getAll = null, pageSize = 50 } = {})
// returns { ok: true, data: Entity[] } or { ok: false, data: [] }
~~~

AccountRepository adds:

~~~js
async getChartOverview({ start, end, period, accountIds, showLoading = false } = {})
// returns the axios response so ResponseUtils.isSuccess(response) remains available
~~~

### Reusable presentation layer

- Create front/components/charts/multi-series-line-chart.vue: line rendering, shared crosshair, pinning, pointer/touch/keyboard behavior, edge-aware tooltip, live region, and selection event.
- Create front/components/charts/money-flow-chart.vue: central-bus flow rendering, proportional bands, selectable nodes, and equivalent accessible list.

multi-series-line-chart.vue consumes:

~~~js
[
  {
    id: 'net-worth',
    label: 'Net worth',
    color: 'var(--analytics-net-worth)',
    marker: 'circle',
    points: [
      {
        x: '2026-08-01',
        xLabel: 'Aug 1, 2026',
        value: 12500,
        valueLabel: '$12,500',
        kind: 'actual',
        isEstimated: false,
        transactionIds: [],
      },
    ],
  },
]
~~~

It also requires valueFormatter(Number) for y-axis labels and accepts ariaLabel. Cards provide already localized xLabel and valueLabel strings for exact point inspection.

It emits select with the full crosshair and select-point when a user activates one tooltip row:

~~~js
{
  x: '2026-08-01',
  index: 0,
  values: [{ seriesId: 'net-worth', point: Object }],
}
~~~

select-point emits { x, index, seriesId, point }. money-flow-chart.vue consumes the buildMonthlyMoneyFlow() result after analytics-money-flow.vue enriches each node with localized label, valueLabel, color, and side; it emits select-node with the selected source or destination node.

### Feature presentation layer

- Create front/components/analytics/analytics-page-switch.vue.
- Create front/components/analytics/analytics-balance-trends.vue.
- Create front/components/analytics/analytics-category-facet.vue.
- Create front/components/analytics/analytics-category-spending.vue.
- Create front/components/analytics/analytics-money-flow.vue.
- Create front/pages/analytics.vue.
- Modify front/pages/dashboard.vue to show the Overview / Analytics switch.

### Navigation, theme, and copy

- Modify front/constants/RouteConstants.js.
- Modify front/constants/TablerIconConstants.js.
- Modify front/stores/appStore.js.
- Modify front/components/ui-kit/theme/app-left-sidebar/app-left-sidebar.vue.
- Modify front/assets/styles/variables.css.
- Modify front/assets/styles/theme-white.css.
- Modify front/assets/styles/theme-dark.css.
- Modify all JSON files under front/i18n/locales/.

---

### Task 1: Pin Account, Currency, and Balance Semantics

**Files:**
- Create: front/utils/AnalyticsUtils.js
- Create: front/tests/utils/AnalyticsUtils.test.js
- Modify: front/package.json

**Interfaces:**
- Consumes: transformed JSON:API accounts and Firefly ChartLine response objects.
- Produces: ANALYTICS_UNCATEGORIZED_ID, getAnalyticsAccountGroups(), convertAnalyticsAmount(), and normalizeBalanceSeries() with the signatures in the file map.

- [ ] **Step 1: Add the analytics test command and failing account-group tests**

Add this script to front/package.json:

~~~json
"test:analytics": "node --test tests/utils/AnalyticsUtils.test.js"
~~~

Create front/tests/utils/AnalyticsUtils.test.js with Node imports and account fixtures:

~~~js
import assert from 'node:assert/strict'
import test from 'node:test'
import { convertAnalyticsAmount, getAnalyticsAccountGroups, normalizeBalanceSeries } from '../../utils/AnalyticsUtils.js'

const account = ({ id, type = 'asset', role = 'defaultAsset', direction = null, active = true, includeNetWorth = true }) => ({
  id,
  attributes: {
    active,
    include_net_worth: includeNetWorth,
    type: { fireflyCode: type },
    account_role: role ? { fireflyCode: role } : null,
    liability_direction: direction ? { fireflyCode: direction } : null,
  },
})

test('groups active net-worth, savings, debit liabilities, and credit cards', () => {
  const groups = getAnalyticsAccountGroups([
    account({ id: 'checking' }),
    account({ id: 'saving', role: 'savingAsset' }),
    account({ id: 'card', role: 'ccAsset' }),
    account({ id: 'mortgage', type: 'liabilities', role: null, direction: 'debit' }),
    account({ id: 'receivable', type: 'liabilities', role: null, direction: 'credit' }),
    account({ id: 'hidden', active: false }),
    account({ id: 'excluded', includeNetWorth: false }),
  ])

  assert.deepEqual(groups.netWorth.map(({ id }) => id), ['checking', 'saving', 'card', 'mortgage', 'receivable'])
  assert.deepEqual(groups.savings.map(({ id }) => id), ['saving'])
  assert.deepEqual(groups.debt.map(({ id }) => id), ['card', 'mortgage'])
})
~~~

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run:

~~~powershell
cd front
npm run test:analytics
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND for AnalyticsUtils.js.

- [ ] **Step 3: Implement account membership and currency conversion**

Start AnalyticsUtils.js with pure helpers that accept both raw Firefly strings and Pico-transformed value objects:

~~~js
const codeOf = (value) => value?.fireflyCode ?? value ?? null
const unique = (values) => [...new Set(values.filter(Boolean))]

export const ANALYTICS_UNCATEGORIZED_ID = 'uncategorized'

export function getAnalyticsAccountGroups(accounts) {
  const active = accounts.filter((account) => account?.attributes?.active === true)
  const typeOf = (account) => codeOf(account?.attributes?.type)
  const roleOf = (account) => codeOf(account?.attributes?.account_role)
  const directionOf = (account) => codeOf(account?.attributes?.liability_direction)
  const balanceHolding = (account) => ['asset', 'cash', 'liabilities'].includes(typeOf(account))

  return {
    netWorth: active.filter((account) => balanceHolding(account) && account?.attributes?.include_net_worth === true),
    savings: active.filter((account) => typeOf(account) === 'asset' && roleOf(account) === 'savingAsset'),
    debt: active.filter((account) => (typeOf(account) === 'asset' && roleOf(account) === 'ccAsset') || (typeOf(account) === 'liabilities' && directionOf(account) === 'debit')),
  }
}

export function convertAnalyticsAmount({ amount, currencyCode, primaryAmount, primaryCurrencyCode, displayCurrencyCode, rates }) {
  const hasPrimary = primaryAmount !== null && primaryAmount !== undefined && primaryCurrencyCode
  const sourceAmount = Number(hasPrimary ? primaryAmount : amount)
  const sourceCurrency = hasPrimary ? primaryCurrencyCode : currencyCode

  if (!Number.isFinite(sourceAmount) || !sourceCurrency || !displayCurrencyCode) {
    return { value: null, isEstimated: false, missingCurrency: sourceCurrency ?? displayCurrencyCode ?? null }
  }
  if (sourceCurrency === displayCurrencyCode) {
    return { value: sourceAmount, isEstimated: false, missingCurrency: null }
  }

  const sourceRate = Number(rates?.[sourceCurrency])
  const destinationRate = Number(rates?.[displayCurrencyCode])
  if (!Number.isFinite(sourceRate) || !Number.isFinite(destinationRate) || sourceRate === 0) {
    return { value: null, isEstimated: false, missingCurrency: !Number.isFinite(sourceRate) ? sourceCurrency : displayCurrencyCode }
  }

  return {
    value: (sourceAmount * destinationRate) / sourceRate,
    isEstimated: true,
    missingCurrency: null,
  }
}
~~~

- [ ] **Step 4: Add failing currency and balance-series tests**

Append these tests:

~~~js
test('prefers exact primary values and labels current-rate conversion', () => {
  assert.deepEqual(
    convertAnalyticsAmount({
      amount: '90',
      currencyCode: 'EUR',
      primaryAmount: '100',
      primaryCurrencyCode: 'USD',
      displayCurrencyCode: 'USD',
      rates: { USD: 1, EUR: 0.9 },
    }),
    { value: 100, isEstimated: false, missingCurrency: null },
  )

  assert.deepEqual(
    convertAnalyticsAmount({
      amount: '90',
      currencyCode: 'EUR',
      primaryAmount: null,
      primaryCurrencyCode: 'USD',
      displayCurrencyCode: 'USD',
      rates: { USD: 1, EUR: 0.9 },
    }),
    { value: 100, isEstimated: true, missingCurrency: null },
  )
})

test('omits amounts when a required rate is missing', () => {
  assert.deepEqual(
    convertAnalyticsAmount({
      amount: '90',
      currencyCode: 'EUR',
      primaryAmount: null,
      primaryCurrencyCode: 'USD',
      displayCurrencyCode: 'USD',
      rates: { USD: 1 },
    }),
    { value: null, isEstimated: false, missingCurrency: 'EUR' },
  )
})

test('aligns dates, carries forward only after first history, and normalizes debt owed', () => {
  const result = normalizeBalanceSeries({
    metric: 'debt',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    chartLines: [
      { currency_code: 'USD', entries: { '2026-01-01': '-100', '2026-01-03': '-80' } },
      { currency_code: 'USD', entries: { '2026-01-02': '-50', '2026-01-03': '10' } },
    ],
  })

  assert.deepEqual(result.points, [
    { x: '2026-01-01', value: 100 },
    { x: '2026-01-02', value: 150 },
    { x: '2026-01-03', value: 80 },
  ])
  assert.equal(result.isEstimated, false)
})
~~~

Run:

~~~powershell
node --test tests/utils/AnalyticsUtils.test.js
~~~

Expected: account and conversion tests PASS; balance test FAIL because normalizeBalanceSeries() is not exported.

- [ ] **Step 5: Implement balance normalization**

Implement normalizeBalanceSeries() with these rules:

~~~js
const entriesForLine = ({ line, primaryCurrencyCode }) => {
  if (line?.pc_entries && Object.keys(line.pc_entries).length > 0) {
    return {
      entries: line.pc_entries,
      currencyCode: line.pc_currency_code ?? primaryCurrencyCode,
      isPrimary: true,
    }
  }
  return {
    entries: line?.entries ?? {},
    currencyCode: line?.currency_code,
    isPrimary: false,
  }
}

export function normalizeBalanceSeries({ chartLines, metric, displayCurrencyCode, primaryCurrencyCode, rates }) {
  const normalizedLines = chartLines.map((line) => {
    const source = entriesForLine({ line, primaryCurrencyCode })
    const points = Object.entries(source.entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([x, amount]) => {
        const converted = convertAnalyticsAmount({
          amount,
          currencyCode: source.currencyCode,
          primaryAmount: source.isPrimary ? amount : null,
          primaryCurrencyCode: source.isPrimary ? source.currencyCode : primaryCurrencyCode,
          displayCurrencyCode,
          rates,
        })
        return { x, ...converted }
      })
    return { points }
  })

  const xValues = unique(normalizedLines.flatMap((line) => line.points.map(({ x }) => x))).sort()
  const missingCurrencies = unique(normalizedLines.flatMap((line) => line.points.map(({ missingCurrency }) => missingCurrency)))
  const isEstimated = normalizedLines.some((line) => line.points.some((point) => point.isEstimated))

  const points = xValues.map((x) => {
    let value = 0
    let hasValue = false
    for (const line of normalizedLines) {
      const available = line.points.filter((point) => point.x <= x && point.value !== null)
      const point = available.at(-1)
      if (!point) continue
      hasValue = true
      value += metric === 'debt' ? Math.max(0, -point.value) : point.value
    }
    return hasValue ? { x, value } : null
  }).filter(Boolean)

  return { points, isEstimated, missingCurrencies }
}
~~~

- [ ] **Step 6: Run focused proof and commit**

Run:

~~~powershell
node --test tests/utils/AnalyticsUtils.test.js
npm run lint:eslint -- --no-warn-ignored utils/AnalyticsUtils.js tests/utils/AnalyticsUtils.test.js
git diff --check
~~~

Expected: PASS for all Task 1 tests and no whitespace errors. Then commit only these files:

~~~powershell
git add front/package.json front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsUtils.test.js
git commit -m "feat: add analytics balance calculations"
~~~

---

### Task 2: Implement Category History, Averages, and Forecast

**Files:**
- Modify: front/utils/AnalyticsUtils.js
- Modify: front/tests/utils/AnalyticsUtils.test.js

**Interfaces:**
- Consumes: convertAnalyticsAmount() from Task 1 and transformed Firefly transaction groups.
- Produces: buildCategoryLedger(), summarizeCategoryWindow(), and rankCategoryIds() with the stable signatures in the file map.

- [ ] **Step 1: Add split fixtures and a failing net-spending test**

Append fixture helpers:

~~~js
const typedAccount = ({ type, role = null, direction = null }) => ({
  attributes: {
    type: { fireflyCode: type },
    account_role: role ? { fireflyCode: role } : null,
    liability_direction: direction ? { fireflyCode: direction } : null,
  },
})

const split = ({ amount, date, source, destination, categoryId = null, primaryAmount = null }) => ({
  amount: String(amount),
  primary_amount: primaryAmount,
  currency_code: 'USD',
  date: new Date(date + 'T12:00:00Z'),
  accountSource: source,
  accountDestination: destination,
  category_id: categoryId,
})

const transaction = (id, parts) => ({
  id,
  attributes: { transactions: parts },
})

const checking = typedAccount({ type: 'asset' })
const otherChecking = typedAccount({ type: 'asset' })
const card = typedAccount({ type: 'asset', role: 'ccAsset' })
const expense = typedAccount({ type: 'expense' })

test('category ledger counts purchases, subtracts refunds, preserves uncategorized, and keeps group IDs', () => {
  const ledger = buildCategoryLedger({
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('history-start', [split({ amount: 1, date: '2025-12-15', source: checking, destination: otherChecking })]),
      transaction('purchase', [split({ amount: 120, date: '2026-01-05', source: card, destination: expense, categoryId: 'food' })]),
      transaction('refund', [split({ amount: 20, date: '2026-01-09', source: expense, destination: checking, categoryId: 'food' })]),
      transaction('unknown', [split({ amount: 15, date: '2026-01-10', source: checking, destination: expense })]),
    ],
  })

  assert.equal(ledger.ledgerStartMonth, '2025-12')
  assert.equal(ledger.months['2026-01'].categories.food.amount, 100)
  assert.deepEqual(ledger.months['2026-01'].categories.food.transactionIds.sort(), ['purchase', 'refund'])
  assert.equal(ledger.months['2026-01'].categories.uncategorized.amount, 15)
})
~~~

Update the import list to include ANALYTICS_UNCATEGORIZED_ID, buildCategoryLedger, rankCategoryIds, and summarizeCategoryWindow.

- [ ] **Step 2: Run the focused test and confirm missing exports**

Run:

~~~powershell
node --test tests/utils/AnalyticsUtils.test.js
~~~

Expected: FAIL because buildCategoryLedger() is not exported.

- [ ] **Step 3: Implement the category ledger**

Add account classification and month/day bucketing:

~~~js
const accountType = (account) => codeOf(account?.attributes?.type)

const splitDirection = (item) => {
  const sourceType = accountType(item?.accountSource)
  const destinationType = accountType(item?.accountDestination)
  if (destinationType === 'expense') return 1
  if (sourceType === 'expense') return -1
  return 0
}

const splitMonthKey = (item) => {
  const date = item?.date instanceof Date ? item.date : new Date(item?.date)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 7)
}

const splitDay = (item) => {
  const date = item?.date instanceof Date ? item.date : new Date(item?.date)
  return Number.isNaN(date.getTime()) ? null : date.getUTCDate()
}

export function buildCategoryLedger({ transactions, displayCurrencyCode, primaryCurrencyCode, rates }) {
  const months = {}
  const missingCurrencies = []
  let isEstimated = false
  let ledgerStartMonth = null

  for (const transaction of transactions) {
    for (const item of transaction?.attributes?.transactions ?? []) {
      const direction = splitDirection(item)
      const monthKey = splitMonthKey(item)
      const day = splitDay(item)
      if (monthKey && (!ledgerStartMonth || monthKey < ledgerStartMonth)) ledgerStartMonth = monthKey
      if (direction === 0 || !monthKey || !day) continue

      const converted = convertAnalyticsAmount({
        amount: Math.abs(Number(item.amount)),
        currencyCode: item.currency_code,
        primaryAmount: item.primary_amount,
        primaryCurrencyCode,
        displayCurrencyCode,
        rates,
      })
      if (converted.missingCurrency) {
        missingCurrencies.push(converted.missingCurrency)
        continue
      }

      const categoryId = item.category_id ?? ANALYTICS_UNCATEGORIZED_ID
      const month = (months[monthKey] ??= { categories: {} })
      const category = (month.categories[categoryId] ??= { amount: 0, byDay: {}, transactionIds: [] })
      const value = direction * converted.value
      category.amount += value
      category.byDay[day] = (category.byDay[day] ?? 0) + value
      category.transactionIds.push(transaction.id)
      category.transactionIds = unique(category.transactionIds)
      isEstimated ||= converted.isEstimated
    }
  }

  return {
    months,
    ledgerStartMonth,
    isEstimated,
    missingCurrencies: unique(missingCurrencies),
  }
}
~~~

- [ ] **Step 4: Add failing average and forecast tests**

Append a compact ledger fixture proving zero-month inclusion, pre-ledger exclusion, top-category ranking, unequal month length, and the two-month forecast minimum:

~~~js
test('completed-month averages count zero months only after ledger history begins', () => {
  const ledger = {
    ledgerStartMonth: '2026-01',
    months: {
      '2026-01': { categories: { food: { amount: 90, byDay: { 5: 40, 25: 50 }, transactionIds: ['jan'] } } },
      '2026-03': { categories: { food: { amount: 30, byDay: { 8: 10, 20: 20 }, transactionIds: ['mar'] } } },
      '2026-04': { categories: { food: { amount: 12, byDay: { 8: 12 }, transactionIds: ['apr'] } } },
    },
  }

  const summary = summarizeCategoryWindow({
    ledger,
    categoryIds: ['food'],
    averageMonths: 3,
    today: new Date('2026-04-10T12:00:00Z'),
  })

  assert.deepEqual(summary.monthKeys, ['2026-01', '2026-02', '2026-03'])
  assert.equal(summary.usedMonths, 3)
  assert.equal(summary.series[0].average, 40)
  assert.equal(summary.series[0].currentActual, 12)
  assert.ok(Math.abs(summary.series[0].currentForecast - (12 + 70 / 3)) < 0.000001)
  assert.equal(summary.series[0].forecastAvailable, true)
})

test('forecast is absent with fewer than two completed months', () => {
  const summary = summarizeCategoryWindow({
    ledger: {
      ledgerStartMonth: '2026-03',
      months: {
        '2026-03': { categories: { food: { amount: 20, byDay: { 20: 20 }, transactionIds: ['mar'] } } },
        '2026-04': { categories: { food: { amount: 5, byDay: { 5: 5 }, transactionIds: ['apr'] } } },
      },
    },
    categoryIds: ['food'],
    averageMonths: 3,
    today: new Date('2026-04-10T12:00:00Z'),
  })

  assert.equal(summary.usedMonths, 1)
  assert.equal(summary.series[0].currentForecast, null)
  assert.equal(summary.series[0].forecastAvailable, false)
})

test('category ranking uses the selected completed-month window', () => {
  const ids = rankCategoryIds({
    ledger: {
      ledgerStartMonth: '2026-02',
      months: {
        '2026-02': { categories: { food: { amount: 20 }, rent: { amount: 100 } } },
        '2026-03': { categories: { food: { amount: 50 }, rent: { amount: 100 } } },
      },
    },
    averageMonths: 2,
    today: new Date('2026-04-10T12:00:00Z'),
  })
  assert.deepEqual(ids, ['rent', 'food'])
})
~~~

The expected forecast is current actual 12 plus the average completed-month remainder after day 10: January 50, February 0, March 20, averaging 70 / 3.

- [ ] **Step 5: Implement completed-month selection, summaries, and ranking**

Use date-fns imports startOfMonth(), subMonths(), and format() so local month selection is explicit. The implementation must:

~~~js
import { format, startOfMonth, subMonths } from 'date-fns'

const monthKey = (date) => format(date, 'yyyy-MM')

const completedMonthKeys = ({ today, averageMonths, ledgerStartMonth }) => {
  const current = startOfMonth(today)
  const requested = Array.from({ length: averageMonths }, (_, index) => monthKey(subMonths(current, averageMonths - index)))
  return ledgerStartMonth ? requested.filter((key) => key >= ledgerStartMonth) : []
}

const categoryForMonth = (ledger, key, categoryId) => ledger.months?.[key]?.categories?.[categoryId] ?? { amount: 0, byDay: {}, transactionIds: [] }
~~~

For each selected category, return:

~~~js
{
  id: categoryId,
  actualPoints: monthKeys.map((key) => ({
    x: key,
    value: categoryForMonth(ledger, key, categoryId).amount,
    transactionIds: categoryForMonth(ledger, key, categoryId).transactionIds,
  })),
  average: usedMonths > 0 ? completedTotal / usedMonths : null,
  currentActual,
  currentTransactionIds,
  currentForecast: usedMonths >= 2 ? currentActual + averageRemainderAfterToday : null,
  forecastAvailable: usedMonths >= 2,
}
~~~

rankCategoryIds() must sum every category over completedMonthKeys(), sort by descending total, and use category ID as the stable tie-breaker.

- [ ] **Step 6: Run focused proof and commit**

Run:

~~~powershell
node --test tests/utils/AnalyticsUtils.test.js
npm run lint:eslint -- --no-warn-ignored utils/AnalyticsUtils.js tests/utils/AnalyticsUtils.test.js
git diff --check
~~~

Expected: PASS, including 12 + 70 / 3 for the forecast fixture. Commit:

~~~powershell
git add front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsUtils.test.js
git commit -m "feat: add category spending forecasts"
~~~

---

### Task 3: Implement the Conserved Monthly Money-Flow Ledger

**Files:**
- Modify: front/utils/AnalyticsUtils.js
- Modify: front/tests/utils/AnalyticsUtils.test.js

**Interfaces:**
- Consumes: convertAnalyticsAmount(), account classification, and transformed split transactions.
- Produces: buildMonthlyMoneyFlow() with non-negative source/destination nodes, exact group IDs, an audit object, and a conservation flag.

- [ ] **Step 1: Add a failing credit-card and savings flow test**

Append:

~~~js
const revenue = typedAccount({ type: 'revenue' })
const savings = typedAccount({ type: 'asset', role: 'savingAsset' })

test('money flow treats card purchases as expense plus new debt and card payments as repayment', () => {
  const flow = buildMonthlyMoneyFlow({
    monthKey: '2026-04',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('income', [split({ amount: 1000, date: '2026-04-01', source: revenue, destination: checking })]),
      transaction('expense', [split({ amount: 200, date: '2026-04-02', source: checking, destination: expense })]),
      transaction('save', [split({ amount: 300, date: '2026-04-03', source: checking, destination: savings })]),
      transaction('card-buy', [split({ amount: 100, date: '2026-04-04', source: card, destination: expense })]),
      transaction('card-pay', [split({ amount: 50, date: '2026-04-05', source: checking, destination: card })]),
    ],
  })

  assert.deepEqual(Object.fromEntries(flow.sources.map((node) => [node.id, node.value])), {
    income: 1000,
    newDebt: 50,
  })
  assert.deepEqual(Object.fromEntries(flow.destinations.map((node) => [node.id, node.value])), {
    expenses: 300,
    savingsDeposited: 300,
    newExcess: 450,
  })
  assert.equal(flow.isBalanced, true)
  assert.deepEqual(flow.audit.debtIncreaseIds, ['card-buy'])
  assert.deepEqual(flow.audit.debtRepaymentIds, ['card-pay'])
})
~~~

Update the AnalyticsUtils.test.js import list to include buildMonthlyMoneyFlow.

The new-excess node is represented once in the returned destinations. Do not put newExcess in sources.

- [ ] **Step 2: Run the test and confirm the missing function failure**

Run:

~~~powershell
node --test tests/utils/AnalyticsUtils.test.js
~~~

Expected: FAIL because buildMonthlyMoneyFlow() is not exported.

- [ ] **Step 3: Implement gross classification and netting**

Add getAnalyticsAccountKind() as an exported helper so the logic is shared and testable:

~~~js
export function getAnalyticsAccountKind(account) {
  const type = codeOf(account?.attributes?.type)
  const role = codeOf(account?.attributes?.account_role)
  const direction = codeOf(account?.attributes?.liability_direction)
  if (type === 'expense') return 'expense'
  if (type === 'revenue') return 'revenue'
  if (type === 'asset' && role === 'savingAsset') return 'savings'
  if ((type === 'asset' && role === 'ccAsset') || (type === 'liabilities' && direction === 'debit')) return 'debt'
  if (['asset', 'cash', 'liabilities'].includes(type)) return 'balance'
  return 'other'
}
~~~

Within buildMonthlyMoneyFlow(), create gross buckets for income, expense purchases, refunds, savings in/out, and debt increase/repayment. For every split in the selected month:

~~~js
const sourceKind = getAnalyticsAccountKind(item.accountSource)
const destinationKind = getAnalyticsAccountKind(item.accountDestination)

if (sourceKind === 'revenue') add('income', amount, transaction.id)
if (destinationKind === 'expense') add('expensePurchases', amount, transaction.id)
if (sourceKind === 'expense') add('refunds', amount, transaction.id)

if (sourceKind !== 'savings' && destinationKind === 'savings') add('savingsIn', amount, transaction.id)
if (sourceKind === 'savings' && destinationKind !== 'savings') add('savingsOut', amount, transaction.id)

if (sourceKind === 'debt' && destinationKind !== 'debt') add('debtIncrease', amount, transaction.id)
if (sourceKind !== 'debt' && destinationKind === 'debt') add('debtRepayment', amount, transaction.id)
~~~

Net the gross buckets exactly:

~~~js
const expenses = Math.max(0, expensePurchases - refunds)
const netRefunds = Math.max(0, refunds - expensePurchases)
const savingsDeposited = Math.max(0, savingsIn - savingsOut)
const savingsWithdrawn = Math.max(0, savingsOut - savingsIn)
const debtRepaid = Math.max(0, debtRepayment - debtIncrease)
const newDebt = Math.max(0, debtIncrease - debtRepayment)
const classifiedSources = income + savingsWithdrawn + newDebt + netRefunds
const classifiedDestinations = expenses + savingsDeposited + debtRepaid
const priorExcessUsed = Math.max(0, classifiedDestinations - classifiedSources)
const newExcess = Math.max(0, classifiedSources - classifiedDestinations)
~~~

Return only positive nodes. Include newExcess as a destination and priorExcessUsed as a source. total is the common side after residuals. A net savings or debt node retains the unique union of IDs from both gross directions because both sets explain the net amount; the audit object also preserves each gross-direction ID list separately. Calculate equationDifference after residuals and set isBalanced when its absolute value is at most 0.5 * 10 ** -currencyDecimalPlaces.

- [ ] **Step 4: Add cancellation, refunds, splits, and conservation tests**

Append:

~~~js
test('money flow nets savings and debt, cancels internal transfers, and exposes refunds as a source', () => {
  const otherSavings = typedAccount({ type: 'asset', role: 'savingAsset' })
  const otherDebt = typedAccount({ type: 'liabilities', direction: 'debit' })
  const flow = buildMonthlyMoneyFlow({
    monthKey: '2026-05',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('save-in', [split({ amount: 100, date: '2026-05-01', source: checking, destination: savings })]),
      transaction('save-out', [split({ amount: 40, date: '2026-05-02', source: savings, destination: checking })]),
      transaction('save-internal', [split({ amount: 20, date: '2026-05-03', source: savings, destination: otherSavings })]),
      transaction('debt-internal', [split({ amount: 25, date: '2026-05-04', source: card, destination: otherDebt })]),
      transaction('refund', [split({ amount: 30, date: '2026-05-05', source: expense, destination: checking, categoryId: 'food' })]),
    ],
  })

  assert.equal(flow.audit.savingsDeposited, 60)
  assert.equal(flow.audit.savingsWithdrawn, 0)
  assert.equal(flow.audit.newDebt, 0)
  assert.equal(flow.audit.debtRepaid, 0)
  assert.equal(flow.audit.netRefunds, 30)
  assert.equal(flow.audit.priorExcessUsed, 30)
  assert.equal(flow.isBalanced, true)
})

test('empty money flow closes exactly within currency tolerance', () => {
  const flow = buildMonthlyMoneyFlow({
    monthKey: '2026-06',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [],
  })
  assert.equal(flow.audit.equationDifference, 0)
  assert.equal(flow.isBalanced, true)
})

test('split groups contribute their parent transaction ID only once per node', () => {
  const flow = buildMonthlyMoneyFlow({
    monthKey: '2026-06',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('split-income', [
        split({ amount: 10, date: '2026-06-01', source: revenue, destination: checking }),
        split({ amount: 15, date: '2026-06-01', source: revenue, destination: checking }),
      ]),
    ],
  })
  const incomeNode = flow.sources.find(({ id }) => id === 'income')
  assert.equal(incomeNode.value, 25)
  assert.deepEqual(incomeNode.transactionIds, ['split-income'])
})
~~~

- [ ] **Step 5: Run proof and commit**

Run:

~~~powershell
node --test tests/utils/AnalyticsUtils.test.js
npm run lint:eslint -- --no-warn-ignored utils/AnalyticsUtils.js tests/utils/AnalyticsUtils.test.js
git diff --check
~~~

Expected: PASS for account, conversion, balance, category, forecast, refund, transfer, split, debt, residual, and conservation cases. Commit:

~~~powershell
git add front/utils/AnalyticsUtils.js front/tests/utils/AnalyticsUtils.test.js
git commit -m "feat: add monthly money flow calculations"
~~~

---

### Task 4: Add Complete Pagination, Chart Retrieval, and the Analytics Store

**Files:**
- Create: front/tests/repository/BaseRepository.test.js
- Modify: front/package.json
- Modify: front/repository/BaseRepository.js
- Modify: front/repository/TransactionRepository.js
- Modify: front/repository/AccountRepository.js
- Create: front/stores/analyticsStore.js

**Interfaces:**
- Consumes: Task 1-3 utility exports, dashboardStore.dashboardCurrencyCode, account/currency/category stores, getExcludedTransactionFilters(), and existing repositories/transformers.
- Produces: repository methods in the file map and useAnalyticsStore() state/actions consumed by every card.

- [ ] **Step 1: Write failing all-or-nothing pagination tests**

Create front/tests/repository/BaseRepository.test.js:

~~~js
import assert from 'node:assert/strict'
import test from 'node:test'
import BaseRepository from '../../repository/BaseRepository.js'

test('merged result forwards page size to every sequential page', async () => {
  const calls = []
  const getAll = async ({ page, pageSize }) => {
    calls.push({ page, pageSize })
    return {
      data: [{ id: String(page) }],
      meta: { pagination: { total_pages: 2 } },
    }
  }

  const result = await new BaseRepository('test').getAllWithMergeResult({ getAll, pageSize: 200 })
  assert.deepEqual(calls, [
    { page: 1, pageSize: 200 },
    { page: 2, pageSize: 200 },
  ])
  assert.deepEqual(result, { ok: true, data: [{ id: '1' }, { id: '2' }] })
})

test('merged result discards partial pages when any page is invalid', async () => {
  const getAll = async ({ page }) =>
    page === 1
      ? { data: [{ id: '1' }], meta: { pagination: { total_pages: 2 } } }
      : { message: 'upstream failure' }

  const result = await new BaseRepository('test').getAllWithMergeResult({ getAll, pageSize: 200 })
  assert.deepEqual(result, { ok: false, data: [] })
})
~~~

- [ ] **Step 2: Run the repository test and confirm the missing method**

Run:

~~~powershell
cd front
node --test tests/repository/BaseRepository.test.js
~~~

Expected: FAIL because getAllWithMergeResult() does not exist.

- [ ] **Step 3: Implement safe merged pagination and request controls**

In BaseRepository.js:

- Add pageSize = 50 to getAllWithMerge() and pass it on every call.
- Add getAllWithMergeResult() using the same sequential loop.
- Treat a page as valid only when responseBody.data is an array.
- Return { ok: false, data: [] } immediately on an invalid page.
- Do not change existing callers' default page size or return type.

Core loop:

~~~js
async getAllWithMergeResult({ filters = [], getAll = null, pageSize = 50 } = {}) {
  const list = []
  const getMethod = getAll ?? this.getAll
  const firstPage = await getMethod({ filters, page: 1, pageSize })
  if (!Array.isArray(firstPage?.data)) return { ok: false, data: [] }

  list.push(...firstPage.data)
  const totalPages = Number(firstPage?.meta?.pagination?.total_pages ?? 1)
  for (let page = 2; page <= totalPages; page++) {
    const response = await getMethod({ filters, page, pageSize })
    if (!Array.isArray(response?.data)) return { ok: false, data: [] }
    list.push(...response.data)
  }
  return { ok: true, data: list }
}
~~~

Extend TransactionRepository.searchTransaction() arguments with showLoading = true and showErrorToast = true, then pass both flags to axios.get(). Existing calls keep existing behavior.

Extend the package script now that the repository test exists:

~~~json
"test:analytics": "node --test tests/utils/AnalyticsUtils.test.js tests/repository/BaseRepository.test.js"
~~~

- [ ] **Step 4: Add the Firefly account-chart repository method**

In AccountRepository.js add ResponseUtils-compatible response behavior:

~~~js
async getChartOverview({ start, end, period, accountIds, showLoading = false } = {}) {
  const params = new URLSearchParams({ start, end, period })
  accountIds.forEach((accountId) => params.append('accounts[]', accountId))
  const url = useAppStore().picoBackendURL + '/api/chart/account/overview?' + params.toString()
  return axios.get(url, { showLoading, showErrorToast: false })
}
~~~

Do not add a Laravel route. The catch-all in back/routes/api.php forwards the request and query unchanged.

- [ ] **Step 5: Create analyticsStore state and derived data**

Create a composition store with these public fields:

~~~js
export const useAnalyticsStore = defineStore('analytics', () => {
  const balancePeriod = useLocalStorage('analyticsBalancePeriod', 3)
  const categoryAverageMonths = useLocalStorage('analyticsCategoryAverageMonths', 6)
  const selectedCategoryIds = useLocalStorage('analyticsSelectedCategoryIds', [])
  const visibleBalanceMetrics = useLocalStorage('analyticsVisibleBalanceMetrics', ['netWorth', 'savings', 'debt'])
  const selectedFlowMonth = ref(startOfMonth(new Date()))

  const balanceState = reactive({ status: 'idle', error: null, isStale: false })
  const categoryState = reactive({ status: 'idle', error: null, isStale: false })
  const flowState = reactive({ status: 'idle', error: null, isStale: false })
  const balanceCache = ref({})
  const transactions = ref([])
~~~

Add computed values:

- displayCurrencyCode from useDashboardStore().dashboardCurrencyCode.
- primaryCurrencyCode from Currency.getCode(useCurrencyStore().defaultCurrency).
- displayCurrencyDecimalPlaces from the selected dashboard currency, defaulting to 2 only when Firefly omits the currency precision.
- rates from useCurrencyStore().exchangeRates.rates.
- accountGroups from getAnalyticsAccountGroups(useAccountStore().accountList).
- categoryLedger, categoryRanking, categorySummary, and selectedFlow from Task 2-3 utilities. Pass displayCurrencyDecimalPlaces to buildMonthlyMoneyFlow().
- flowMonthMin as the first loaded month and flowMonthMax as the current month.
- balanceSeries as one object per metric: { id, points, isEstimated, missingCurrencies, warnings }.

Compose category metadata instead of making cards reach into two store values:

~~~js
const categorySummary = computed(() => ({
  ...summarizeCategoryWindow({
    ledger: categoryLedger.value,
    categoryIds: selectedCategoryIds.value,
    averageMonths: categoryAverageMonths.value,
    today: new Date(),
  }),
  isEstimated: categoryLedger.value.isEstimated,
  missingCurrencies: categoryLedger.value.missingCurrencies,
}))
~~~

When category data first becomes ready, keep valid persisted category IDs; if none remain, select categoryRanking.value.slice(0, 5). Enforce a maximum of six IDs in the facet component, not by silently truncating persisted state.

- [ ] **Step 6: Implement lazy fetch, cache, retry, and current-point validation**

Implement:

~~~js
async function fetchTransactions({ force = false } = {})
async function fetchBalances({ force = false } = {})
async function init()
async function refresh()
async function retryBalance()
async function retryCategory()
async function retryFlow()
~~~

fetchTransactions():

1. Skip when ready and force is false.
2. Set both category and flow to loading while preserving existing data with isStale true on refresh.
3. Build a date_after/date_before search from the start of the month 24 months before the current month through today.
4. Append getExcludedTransactionFilters().
5. Call getAllWithMergeResult() with TransactionRepository.searchTransaction bound as getAll, pageSize 200, and global loading/toasts disabled.
6. On ok false, set both cards to error and leave the previous complete collection visible as stale.
7. On success, transform with TransactionTransformer.transformFromApiList(), replace transactions atomically, and mark both cards ready or empty.

fetchBalances():

1. Cache by balancePeriod + displayCurrencyCode + primaryCurrencyCode + the relevant exchange-rate values + account-group IDs so a rate refresh cannot reuse a stale normalized result.
2. Use subMonths(today, balancePeriod), period 1D for 3 months and 1W for 6/12.
3. Skip empty groups.
4. Request netWorth, savings, and debt groups independently with Promise.all().
5. Require ResponseUtils.isSuccess(response) for every non-empty group.
6. Normalize each response.data with normalizeBalanceSeries().
7. Compare each final point against current account totals converted into the selected currency. If sign or value differs beyond half of 10 to the negative selected-currency decimal places after accounting for weekly sampling date, attach a warning; never flip the series silently.

init() calls appStore.syncEverythingIfOld(). If dashboardStore.dashboardCurrency has no ID after sync, assign currencyStore.defaultCurrency before reading displayCurrencyCode. Then start balance and transaction loads concurrently. refresh() forces both sources with Promise.allSettled(). Retry actions call only their required source.

Register store-local watchers after the action declarations:

~~~js
watch(balancePeriod, () => fetchBalances())
watch(displayCurrencyCode, () => fetchBalances())
~~~

Changing categoryAverageMonths, selectedCategoryIds, or selectedFlowMonth recomputes the existing transaction collection and must not issue an HTTP request.

- [ ] **Step 7: Export the stable store contract**

Return:

~~~js
return {
  balancePeriod,
  categoryAverageMonths,
  selectedCategoryIds,
  visibleBalanceMetrics,
  selectedFlowMonth,
  balanceState,
  categoryState,
  flowState,
  balanceSeries,
  categoryRanking,
  categorySummary,
  selectedFlow,
  flowMonthMin,
  flowMonthMax,
  displayCurrencyCode,
  displayCurrencyDecimalPlaces,
  init,
  refresh,
  retryBalance,
  retryCategory,
  retryFlow,
}
~~~

- [ ] **Step 8: Run repository and compile proof, then commit**

Run:

~~~powershell
npm run test:analytics
npm run lint:eslint -- --no-warn-ignored repository/BaseRepository.js repository/TransactionRepository.js repository/AccountRepository.js stores/analyticsStore.js tests/repository/BaseRepository.test.js
npm run build
git diff --check
~~~

Expected: tests PASS and Nuxt build succeeds. Commit:

~~~powershell
git add front/package.json front/repository/BaseRepository.js front/repository/TransactionRepository.js front/repository/AccountRepository.js front/stores/analyticsStore.js front/tests/repository/BaseRepository.test.js
git commit -m "feat: load extended analytics data"
~~~

---

### Task 5: Build the Accessible Multi-Series SVG Chart

**Files:**
- Create: front/utils/ChartUtils.js
- Create: front/tests/utils/ChartUtils.test.js
- Create: front/components/charts/multi-series-line-chart.vue
- Modify: front/package.json
- Modify: front/assets/styles/theme-white.css
- Modify: front/assets/styles/theme-dark.css

**Interfaces:**
- Consumes: aligned series described in the file map plus value/x label strings prepared by cards.
- Produces: buildLineChartGeometry(), nearestPointIndex(), and a chart that emits select.

- [ ] **Step 1: Write failing geometry and nearest-point tests**

Create front/tests/utils/ChartUtils.test.js:

~~~js
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLineChartGeometry, nearestPointIndex } from '../../utils/ChartUtils.js'

test('line geometry shares one x scale and keeps zero in range when needed', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [
      { id: 'a', points: [{ x: '2026-01', value: -10, kind: 'actual' }, { x: '2026-02', value: 10, kind: 'forecast' }] },
      { id: 'b', points: [{ x: '2026-01', value: 0 }, { x: '2026-02', value: 5 }] },
    ],
  })
  assert.deepEqual(geometry.xValues, ['2026-01', '2026-02'])
  assert.equal(geometry.yMin, -10)
  assert.equal(geometry.yMax, 10)
  assert.deepEqual(geometry.series[0].points.map(({ x }) => x), [10, 90])
  assert.equal(geometry.series[0].segments[0].dashed, true)
})

test('nearest point clamps pointer and keyboard positions', () => {
  assert.equal(nearestPointIndex({ clientX: 50, left: 0, width: 100, pointCount: 5 }), 2)
  assert.equal(nearestPointIndex({ clientX: -20, left: 0, width: 100, pointCount: 5 }), 0)
  assert.equal(nearestPointIndex({ clientX: 120, left: 0, width: 100, pointCount: 5 }), 4)
  assert.equal(nearestPointIndex({ clientX: 20, left: 0, width: 100, pointCount: 0 }), -1)
})
~~~

- [ ] **Step 2: Run the test and confirm the missing module**

Run:

~~~powershell
node --test tests/utils/ChartUtils.test.js
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement chart geometry**

Implement a pure SVG view-box geometry:

~~~js
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function nearestPointIndex({ clientX, left, width, pointCount }) {
  if (pointCount <= 0 || width <= 0) return -1
  const ratio = clamp((clientX - left) / width, 0, 1)
  return Math.round(ratio * (pointCount - 1))
}

export function buildLineChartGeometry({ series, width, height, padding }) {
  const xValues = [...new Set(series.flatMap((item) => item.points.map((point) => point.x)))].sort()
  const values = series.flatMap((item) => item.points.map((point) => point.value)).filter(Number.isFinite)
  const yMin = Math.min(0, ...values)
  const yMaxCandidate = Math.max(0, ...values)
  const yMax = yMaxCandidate === yMin ? yMin + 1 : yMaxCandidate
  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom
  const xAt = (x) => padding.left + (xValues.indexOf(x) / Math.max(1, xValues.length - 1)) * innerWidth
  const yAt = (value) => padding.top + ((yMax - value) / (yMax - yMin)) * innerHeight
  const outputSeries = series.map((item) => {
    const points = item.points.map((point) => ({ ...point, x: xAt(point.x), y: yAt(point.value), key: point.x }))
    const segments = points.slice(1).map((point, index) => {
      const previous = points[index]
      return {
        path: 'M ' + previous.x + ' ' + previous.y + ' L ' + point.x + ' ' + point.y,
        dashed: point.kind === 'forecast',
      }
    })
    return {
      ...item,
      points,
      segments,
    }
  })
  return { xValues, yMin, yMax, series: outputSeries }
}
~~~

- [ ] **Step 4: Run geometry proof**

Extend the package script now that all three test files exist:

~~~json
"test:analytics": "node --test tests/utils/AnalyticsUtils.test.js tests/utils/ChartUtils.test.js tests/repository/BaseRepository.test.js"
~~~

Run:

~~~powershell
npm run test:analytics
~~~

Expected: all utility and repository tests PASS.

- [ ] **Step 5: Implement the line-chart component**

Use a 1000 x 320 viewBox and no scoped style. Required template structure:

~~~vue
<template>
  <div ref="root" class="analytics-line-chart">
    <svg
      class="analytics-line-chart-svg"
      viewBox="0 0 1000 320"
      role="application"
      :aria-label="ariaLabel"
      tabindex="0"
      @pointermove="onPointerMove"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointerleave="onPointerLeave"
      @keydown="onKeydown"
    >
      <template v-for="item in geometry.series" :key="item.id">
        <path v-for="(segment, segmentIndex) in item.segments" :key="item.id + segmentIndex" :d="segment.path" fill="none" :stroke="item.color" :stroke-dasharray="segment.dashed ? '8 6' : null" />
      </template>
      <g v-if="selectedIndex >= 0">
        <line class="analytics-chart-crosshair" :x1="selectedX" :x2="selectedX" y1="16" y2="282" />
        <template v-for="item in selectedValues" :key="item.seriesId">
          <circle v-if="item.marker === 'circle'" :cx="item.x" :cy="item.y" r="7" :fill="item.color" />
          <rect v-else-if="item.marker === 'square'" :x="item.x - 7" :y="item.y - 7" width="14" height="14" rx="2" :fill="item.color" />
          <path v-else-if="item.marker === 'diamond'" :d="'M ' + item.x + ' ' + (item.y - 8) + ' L ' + (item.x + 8) + ' ' + item.y + ' L ' + item.x + ' ' + (item.y + 8) + ' L ' + (item.x - 8) + ' ' + item.y + ' Z'" :fill="item.color" />
          <circle v-else :cx="item.x" :cy="item.y" r="7" fill="var(--van-background-2)" :stroke="item.color" stroke-width="3" />
        </template>
      </g>
    </svg>

    <div v-if="selectedIndex >= 0" class="analytics-chart-tooltip" :class="{ right: tooltipOnRight, interactive: isPinned || isKeyboardSelection }">
      <div class="font-weight-600">{{ selectedXLabel }}</div>
      <button v-for="item in selectedValues" :key="item.seriesId" type="button" class="analytics-chart-tooltip-row" :tabindex="isPinned || isKeyboardSelection ? 0 : -1" @click="emitPoint(item)">
        <span class="analytics-chart-legend-marker" :style="{ backgroundColor: item.color }"></span>
        <span class="flex-1">{{ item.label }}</span>
        <span>{{ item.point.valueLabel }}</span>
        <span v-if="item.point.kind === 'forecast'">{{ $t('analytics.common.forecast') }}</span>
        <span v-if="item.point.isEstimated">{{ $t('analytics.common.estimated_current_rates') }}</span>
      </button>
    </div>

    <div class="sr-only" aria-live="polite">{{ liveDescription }}</div>
  </div>
</template>
~~~

Implementation rules:

- Use defineProps() for series, ariaLabel, valueFormatter, and pinned initial false; use defineEmits(['select', 'select-point']).
- Render five evenly spaced horizontal grid lines with valueFormatter(yValue) labels and first/middle/last x-axis labels from point.xLabel. valueFormatter is a required function prop supplied by each card.
- Convert clientX using root.getBoundingClientRect() and nearestPointIndex().
- pointermove changes selection while not pinned; pointerdown starts drag; pointerup pins; clicking the pinned point again unpins it; click outside via onClickOutside(root, clearSelection); pointerleave clears only an unpinned selection.
- Left/Right clamp selectedIndex, Home sets zero, End sets last, Enter pins, Escape clears.
- Track isKeyboardSelection separately from isPinned so tooltip rows become reachable after keyboard movement without changing pointer-hover behavior.
- tooltipOnRight is selectedIndex < xValues.length / 2 so the tooltip opens away from the nearest edge.
- selectedValues must include every visible series with a point at the selected x.
- emit select whenever a point becomes pinned or keyboard-selected.
- Tooltip rows become interactive only while pinned or keyboard-selected. Clicking a row or focusing it and pressing Enter emits select-point for that exact series/point; do not guess the first visible series in the card.
- Use setPointerCapture() during touch drag and CSS touch-action: pan-y.

- [ ] **Step 6: Add theme styles and compile**

Add shared chart classes to theme-white.css and only dark overrides to theme-dark.css. Use CSS variables for surface/text/grid/crosshair; do not hardcode a second palette inside the component. Include:

~~~css
.analytics-line-chart {
  position: relative;
  min-height: 240px;
  user-select: none;
}

.analytics-line-chart-svg {
  display: block;
  width: 100%;
  min-height: 240px;
  overflow: visible;
  touch-action: pan-y;
}

.analytics-chart-crosshair {
  stroke: var(--van-text-color-2);
  stroke-width: 1;
  stroke-dasharray: 4 4;
}

.analytics-chart-tooltip {
  position: absolute;
  top: 12px;
  max-width: min(280px, 80%);
  padding: 10px;
  border-radius: 8px;
  background: var(--van-background-2);
  box-shadow: rgba(0, 0, 0, 0.24) 0 3px 8px;
  font-size: 12px;
  pointer-events: none;
}

.analytics-chart-tooltip.interactive {
  pointer-events: auto;
}
~~~

Run:

~~~powershell
npm run lint:fix
npm run test:analytics
npm run build
git diff --check
~~~

Expected: tests and build PASS.

- [ ] **Step 7: Commit**

~~~powershell
git add front/package.json front/utils/ChartUtils.js front/tests/utils/ChartUtils.test.js front/components/charts/multi-series-line-chart.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css
git commit -m "feat: add accessible analytics line chart"
~~~

---

### Task 6: Build the Balance-Trends Card

**Files:**
- Create: front/components/analytics/analytics-balance-trends.vue
- Modify: front/assets/styles/theme-white.css
- Modify: front/assets/styles/theme-dark.css

**Interfaces:**
- Consumes: analyticsStore.balanceSeries, balancePeriod, visibleBalanceMetrics, balanceState, displayCurrencyCode, and retryBalance().
- Produces: the full-width balance card with 3/6/12 controls, 1-3 visible metrics, latest/change summaries, warnings, and exact chart points.

- [ ] **Step 1: Create the card state shell**

Use one van-cell-group inset card. Keep controls visible in ready and empty states:

~~~vue
<template>
  <van-cell-group inset class="analytics-card analytics-balance-card">
    <div class="van-cell-group-title analytics-card-title">
      <span class="flex-1">{{ $t('analytics.balance.title') }}</span>
      <app-tabs v-model="analyticsStore.balancePeriod" :items="periodItems" />
    </div>

    <div class="analytics-series-toggles">
      <button
        v-for="metric in metrics"
        :key="metric.id"
        type="button"
        class="analytics-series-toggle"
        :class="{ active: visibleMetrics.includes(metric.id) }"
        :aria-pressed="visibleMetrics.includes(metric.id)"
        @click="toggleMetric(metric.id)"
      >
        {{ metric.label }}
      </button>
    </div>

    <div v-if="analyticsStore.balanceState.status === 'loading' && chartSeries.length === 0" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="analyticsStore.balanceState.status === 'error' && chartSeries.length === 0" class="analytics-card-state">
      <span>{{ $t('analytics.balance.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryBalance">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <div v-else-if="chartSeries.length === 0" class="analytics-card-state">{{ $t('analytics.balance.empty') }}</div>
    <template v-else>
      <multi-series-line-chart :series="chartSeries" :value-formatter="formatNumberForDashboard" :aria-label="$t('analytics.balance.chart_label')" />
      <div class="analytics-metric-summary-grid"></div>
      <div v-if="isEstimated" class="analytics-assumption-note">{{ $t('analytics.common.estimated_current_rates') }}</div>
      <div v-if="missingCurrencies.length" class="analytics-warning">{{ $t('analytics.common.missing_rates', { currencies: missingCurrencies.join(', ') }) }}</div>
    </template>
  </van-cell-group>
</template>
~~~

- [ ] **Step 2: Implement period, metric, and summary computeds**

Use:

~~~js
const periodItems = computed(() => [3, 6, 12].map((value) => ({ label: t('analytics.period.months_short', { count: value }), value })))

const metrics = computed(() => [
  { id: 'netWorth', label: t('analytics.balance.net_worth'), color: 'var(--analytics-net-worth)', marker: 'circle' },
  { id: 'savings', label: t('analytics.balance.savings'), color: 'var(--analytics-savings)', marker: 'square' },
  { id: 'debt', label: t('analytics.balance.debt'), color: 'var(--analytics-debt)', marker: 'diamond' },
])

const visibleMetrics = computed(() => analyticsStore.visibleBalanceMetrics)
~~~

toggleMetric() must refuse to remove the final visible metric. chartSeries maps the store points to the line-chart contract, including DateUtils-formatted xLabel and formatNumberForDashboard() valueLabel. Summary values are:

- latest: last valid point;
- absoluteChange: latest - first;
- percentageChange: null when first is zero, otherwise absoluteChange / abs(first) * 100.

Debt up uses danger semantics; debt down uses success. Net worth and savings use the inverse. Do not infer success from raw sign without the metric ID.

- [ ] **Step 3: Add card styles**

Add reusable analytics card/title/control/summary classes. Define semantic variables in variables.css only in Task 9; temporarily refer to their final names now:

~~~css
.analytics-card {
  break-inside: avoid;
  overflow: visible;
}

.analytics-card-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.analytics-series-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px 8px;
}

.analytics-series-toggle {
  min-height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 25px;
  background: var(--van-background-2-5);
  color: var(--van-text-color-2);
}

.analytics-series-toggle.active {
  box-shadow: inset 0 0 0 2px currentColor;
  color: var(--van-text-color);
}
~~~

- [ ] **Step 4: Compile and commit**

Run:

~~~powershell
npm run lint:fix
npm run build
git diff --check
~~~

Expected: build PASS. Commit:

~~~powershell
git add front/components/analytics/analytics-balance-trends.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css
git commit -m "feat: add balance trend analytics card"
~~~

---

### Task 7: Build Category Faceting, History, Forecast, and Drilldown

**Files:**
- Create: front/components/analytics/analytics-category-facet.vue
- Create: front/components/analytics/analytics-category-spending.vue
- Modify: front/assets/styles/theme-white.css
- Modify: front/assets/styles/theme-dark.css

**Interfaces:**
- Consumes: analyticsStore.categoryRanking, categorySummary, categoryAverageMonths, selectedCategoryIds, categoryState, displayCurrencyCode, and retryCategory().
- Produces: searchable maximum-six category facet, actual and forecast series, average summary, and exact-ID drilldown.

- [ ] **Step 1: Build the category facet with defineModel()**

Use defineModel({ type: Array, default: () => [] }) and props items/max. The component contains a compact button showing selected count and a van-popup with app-list-search plus checkboxes. Selection logic:

~~~js
const selectedIds = defineModel({ type: Array, default: () => [] })
const props = defineProps({
  items: { type: Array, default: () => [] },
  max: { type: Number, default: 6 },
})

const toggle = (id) => {
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id)
    return
  }
  if (selectedIds.value.length >= props.max) {
    UIUtils.showToastError(t('analytics.category.selection_limit', { count: props.max }))
    return
  }
  selectedIds.value = [...selectedIds.value, id]
}
~~~

The list label comes from Category.getDisplayName(categoryStore.categoryDictionary[id]); use analytics.category.uncategorized when id equals ANALYTICS_UNCATEGORIZED_ID. Show the completed-window amount beside each option.

- [ ] **Step 2: Build category card controls and series**

Use period tabs 3/6/12/24 and the facet in the card header. Map each category summary to one series whose final segment is forecast-styled:

Import format and parseISO from date-fns for stable month labels.

~~~js
const CATEGORY_COLORS = [
  'var(--analytics-category-1)',
  'var(--analytics-category-2)',
  'var(--analytics-category-3)',
  'var(--analytics-category-4)',
  'var(--analytics-category-5)',
  'var(--analytics-category-6)',
]
const CATEGORY_MARKERS = ['circle', 'square', 'diamond', 'hollow', 'circle', 'square']
const profileStore = useProfileStore()
const summary = computed(() => analyticsStore.categorySummary)
const formatMonthKey = (value) => new Intl.DateTimeFormat(profileStore.language, { month: 'short', year: 'numeric' }).format(parseISO(value.slice(0, 7) + '-01'))
const currentMonthKey = computed(() => format(new Date(), 'yyyy-MM'))
const currentMonthLabel = computed(() => formatMonthKey(currentMonthKey.value))
const categoryLabel = (categoryId) =>
  categoryId === ANALYTICS_UNCATEGORIZED_ID ? t('analytics.category.uncategorized') : Category.getDisplayName(categoryStore.categoryDictionary[categoryId])
const toChartPoint = (point, kind) => ({
  ...point,
  xLabel: point.xLabel ?? formatMonthKey(point.x),
  valueLabel: formatNumberForDashboard(point.value),
  kind,
  isEstimated: analyticsStore.categorySummary.isEstimated,
})

const chartSeries = computed(() =>
  (summary.value?.series ?? []).map((category, index) => ({
    id: category.id,
    label: categoryLabel(category.id),
    color: CATEGORY_COLORS[index],
    marker: CATEGORY_MARKERS[index],
    points: [
      ...category.actualPoints.map((point) => toChartPoint(point, 'actual')),
      toChartPoint({ x: currentMonthKey.value, value: category.currentActual, transactionIds: category.currentTransactionIds }, 'actual'),
      ...(category.forecastAvailable
        ? [toChartPoint({ x: currentMonthKey.value + ':forecast', xLabel: currentMonthLabel.value, value: category.currentForecast, transactionIds: [] }, 'forecast')]
        : []),
    ],
  })),
)
~~~

The shared chart renders a segment as dashed when its destination point has kind forecast. The synthetic currentMonthKey + ':forecast' key sorts immediately after the actual current-month key, while xLabel remains the same human-readable current month. At the forecast position, each category with sufficient history exposes its forecast amount across the shared crosshair.

Pass formatNumberForDashboard as the chart's valueFormatter prop.

Show a summary row for each selected category with average, current actual, and forecast. Show Based on X of N months whenever usedMonths differs from requestedMonths. When usedMonths is below two, omit forecast and show the localized insufficient-history note.

- [ ] **Step 3: Implement exact drilldown and forecast explanation**

Handle the line-chart select-point event:

~~~js
const onSelectPoint = async ({ point }) => {
  if (point.kind === 'forecast') {
    forecastDetailsVisible.value = true
    return
  }
  if (!point.transactionIds?.length) return
  const ids = [...new Set(point.transactionIds)].join(',')
  const query = TransactionFilterUtils.filters.id.toUrl(ids)
  await navigateTo(RouteConstants.ROUTE_TRANSACTION_LIST + '?' + query)
}
~~~

When a forecast point is selected, show:

~~~text
Forecast = actual through today + average spending after today's day-of-month in the selected completed months.
~~~

Use localized text and show the actual, average remainder, used month count, and forecast value.

- [ ] **Step 4: Cover states and assumption labels**

Implement inline loading, empty, error/retry, stale, missing-rate, and current-rate-estimate states exactly as the design specifies. The note must disclose:

- completed months only;
- current month shown separately;
- refunds reduce spending;
- savings/debt/ordinary transfers are excluded;
- configured dashboard transaction exclusions are applied.

- [ ] **Step 5: Add responsive styles, compile, and commit**

Keep the chart readable at 320px, make facet rows at least 44px high, and allow the summary table to horizontally scroll only if labels cannot wrap. Add dark overrides for popup borders and chart summary surfaces.

Run:

~~~powershell
npm run lint:fix
npm run build
git diff --check
~~~

Expected: build PASS. Commit:

~~~powershell
git add front/components/analytics/analytics-category-facet.vue front/components/analytics/analytics-category-spending.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css
git commit -m "feat: add category spending analytics"
~~~

---

### Task 8: Build the Money-Flow Diagram, Audit View, and Drilldown

**Files:**
- Create: front/components/charts/money-flow-chart.vue
- Create: front/components/analytics/analytics-money-flow.vue
- Modify: front/assets/styles/theme-white.css
- Modify: front/assets/styles/theme-dark.css

**Interfaces:**
- Consumes: analyticsStore.selectedFlow, selectedFlowMonth, flowMonthMin/max, flowState, displayCurrencyCode, and retryFlow().
- Produces: a central-bus SVG flow, accessible node list, month navigation, formula/audit details, and exact-ID drilldown.

- [ ] **Step 1: Implement the central-bus flow chart**

Do not imply an allocation from any individual source to an individual destination. Draw every source into a central Available bus and every destination out of that bus:

~~~vue
<template>
  <div class="analytics-flow">
    <svg viewBox="0 0 1000 520" class="analytics-flow-svg" :aria-label="ariaLabel" role="img">
      <g v-for="node in sourceGeometry" :key="node.id" tabindex="0" role="button" @click="emit('select-node', node)" @keydown.enter="emit('select-node', node)">
        <path :d="node.path" class="analytics-flow-band" :style="{ strokeWidth: node.width, stroke: node.color }" />
        <text :x="node.labelX" :y="node.labelY">{{ node.label }} · {{ node.valueLabel }}</text>
      </g>
      <rect class="analytics-flow-bus" x="478" y="40" width="44" height="440" rx="10" />
      <g v-for="node in destinationGeometry" :key="node.id" tabindex="0" role="button" @click="emit('select-node', node)" @keydown.enter="emit('select-node', node)">
        <path :d="node.path" class="analytics-flow-band" :style="{ strokeWidth: node.width, stroke: node.color }" />
        <text :x="node.labelX" :y="node.labelY">{{ node.label }} · {{ node.valueLabel }}</text>
      </g>
    </svg>

    <ul class="analytics-flow-list">
      <li v-for="node in accessibleNodes" :key="node.side + node.id">
        <button type="button" @click="emit('select-node', node)">{{ node.sideLabel }}: {{ node.label }} — {{ node.valueLabel }}</button>
      </li>
    </ul>
  </div>
</template>
~~~

Band widths use max(4, node.value / total * 180). Stack source and destination anchor positions separately with stable node ordering from AnalyticsUtils. Keep the list visible as a compact source/destination summary immediately below the SVG; do not hide it behind hover, display:none, or a collapsed disclosure.

- [ ] **Step 2: Build month controls and card states**

Use previous/next icon buttons and a formatted selectedFlowMonth title. Disable previous at flowMonthMin and next at flowMonthMax. The card must keep controls visible for empty months.

Map node IDs to localized labels and semantic colors:

- income;
- savingsWithdrawn;
- newDebt;
- priorExcessUsed;
- netRefunds;
- expenses;
- savingsDeposited;
- debtRepaid;
- newExcess.

When selectedFlow.isBalanced is false, suppress money-flow-chart and show audit source total, destination total, and equationDifference.

- [ ] **Step 3: Implement exact drilldown and residual formula**

~~~js
const onSelectNode = async (node) => {
  if (node.transactionIds?.length > 0) {
    const ids = [...new Set(node.transactionIds)].join(',')
    await navigateTo(RouteConstants.ROUTE_TRANSACTION_LIST + '?' + TransactionFilterUtils.filters.id.toUrl(ids))
    return
  }
  selectedResidual.value = node
}
~~~

For priorExcessUsed show max(0, classifiedDestinations - classifiedSources). For newExcess show max(0, classifiedSources - classifiedDestinations). Display the exact substituted values from flow.audit.

- [ ] **Step 4: Add note, currency warning, and responsive theme styles**

The card note states that savings and debt are monthly net movement, card purchases are expenses plus new debt, card payments reduce debt, and ordinary transfers cancel. Show current-rate estimate and missing currencies using the shared wording.

On mobile, stack labels vertically around the central bus and keep each accessible list row at least 44px. On desktop, keep left-to-right source/bus/destination layout. Add dark overrides for bus, labels, and focus outlines.

- [ ] **Step 5: Compile and commit**

Run:

~~~powershell
npm run lint:fix
npm run build
git diff --check
~~~

Expected: build PASS. Commit:

~~~powershell
git add front/components/charts/money-flow-chart.vue front/components/analytics/analytics-money-flow.vue front/assets/styles/theme-white.css front/assets/styles/theme-dark.css
git commit -m "feat: add monthly money flow analytics"
~~~

---

### Task 9: Integrate the Analytics Page, Navigation, Themes, and Localization

**Files:**
- Create: front/components/analytics/analytics-page-switch.vue
- Create: front/pages/analytics.vue
- Modify: front/pages/dashboard.vue
- Modify: front/constants/RouteConstants.js
- Modify: front/constants/TablerIconConstants.js
- Modify: front/stores/appStore.js
- Modify: front/components/ui-kit/theme/app-left-sidebar/app-left-sidebar.vue
- Modify: front/assets/styles/variables.css
- Modify: front/assets/styles/theme-white.css
- Modify: front/assets/styles/theme-dark.css
- Modify: front/i18n/locales/de-DE.json
- Modify: front/i18n/locales/en.json
- Modify: front/i18n/locales/es-MX.json
- Modify: front/i18n/locales/fr.json
- Modify: front/i18n/locales/it.json
- Modify: front/i18n/locales/ko.json
- Modify: front/i18n/locales/pl.json
- Modify: front/i18n/locales/pt-BR.json
- Modify: front/i18n/locales/ro.json
- Modify: front/i18n/locales/ru-RU.json
- Modify: front/i18n/locales/zh-CN.json

**Interfaces:**
- Consumes: all feature/store/chart components from Tasks 4-8.
- Produces: reachable /analytics route, mobile Dashboard-tab selection, desktop Analytics sidebar entry, Overview / Analytics page switch, final responsive layout, and complete copy.

- [ ] **Step 1: Add route, icon, and active-page mapping**

Add:

~~~js
ROUTE_ANALYTICS: '/analytics',
~~~

Add TablerIconConstants.analytics = 'IconChartLine'. In appStore.activePage, map both routes to the Dashboard bottom item:

~~~js
[RouteConstants.ROUTE_DASHBOARD]: [RouteConstants.ROUTE_DASHBOARD, RouteConstants.ROUTE_ANALYTICS],
~~~

In the desktop sidebar main pages, use localized labels and add:

~~~js
{ key: 'dashboard', label: t('dashboard.title'), icon: TablerIconConstants.dashboard, route: RouteConstants.ROUTE_DASHBOARD },
{ key: 'analytics', label: t('analytics.title'), icon: TablerIconConstants.analytics, route: RouteConstants.ROUTE_ANALYTICS },
~~~

Do not add a sixth app-bottom-toolbar item.

- [ ] **Step 2: Create the shared Overview / Analytics switch**

~~~vue
<template>
  <app-tabs v-model="selectedRoute" :items="items" class="analytics-page-switch" />
</template>

<script setup>
import RouteConstants from '~/constants/RouteConstants.js'

const route = useRoute()
const { t } = useI18n()
const selectedRoute = computed({
  get: () => (route.path === RouteConstants.ROUTE_ANALYTICS ? RouteConstants.ROUTE_ANALYTICS : RouteConstants.ROUTE_DASHBOARD),
  set: (value) => navigateTo(value),
})
const items = computed(() => [
  { label: t('analytics.overview'), value: RouteConstants.ROUTE_DASHBOARD },
  { label: t('analytics.title'), value: RouteConstants.ROUTE_ANALYTICS },
])
</script>
~~~

Place analytics-page-switch immediately below app-top-toolbar in dashboard.vue and analytics.vue. Preserve the existing dashboard control below it on mobile and in the toolbar subtitle on desktop.

- [ ] **Step 3: Create the analytics page**

~~~vue
<template>
  <div class="app-form analytics-page">
    <app-top-toolbar />
    <analytics-page-switch />

    <van-pull-refresh v-model="isRefreshing" @refresh="onRefresh">
      <div class="analytics-layout">
        <analytics-balance-trends class="analytics-layout-balance" />
        <analytics-category-spending v-if="profileStore.categoriesEnabled" class="analytics-layout-category" />
        <analytics-money-flow class="analytics-layout-flow" />
      </div>
    </van-pull-refresh>
  </div>
</template>

<script setup>
import { useToolbar } from '~/composables/useToolbar'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const isRefreshing = ref(false)
const { t } = useI18n()

const onRefresh = async () => {
  isRefreshing.value = true
  await analyticsStore.refresh()
  isRefreshing.value = false
}

onMounted(() => analyticsStore.init())
useToolbar().init({ title: t('analytics.title') })
</script>
~~~

- [ ] **Step 4: Add the complete English key structure**

Add this analytics object to en.json, adjusting JSON commas at its insertion point:

~~~json
"analytics": {
  "title": "Analytics",
  "overview": "Overview",
  "period": {
    "months_short": "{count}M",
    "average_months": "{count}-month average"
  },
  "common": {
    "actual": "Actual",
    "loading": "Loading analytics",
    "forecast": "Forecast",
    "average": "Average",
    "current_month": "Current month",
    "estimated_current_rates": "Estimated at current rates",
    "missing_rates": "Missing exchange rates: {currencies}",
    "based_on_months": "Based on {used} of {requested} months",
    "retry": "Retry",
    "stale": "Showing the previous complete result while refreshing",
    "details": "Details"
  },
  "balance": {
    "title": "Balance trends",
    "chart_label": "Net worth, savings, and debt over time",
    "net_worth": "Net worth",
    "savings": "Savings",
    "debt": "Debt",
    "latest": "Latest",
    "change": "Change",
    "empty": "No matching balance accounts",
    "error": "Balance history could not be loaded",
    "definition": "Active accounts follow the net-worth, savings-role, and debt account rules."
  },
  "category": {
    "title": "Spending by category",
    "chart_label": "Completed-month spending and current-month forecast by category",
    "select": "Select categories",
    "selected_count": "{count} selected",
    "selection_limit": "Select up to {count} categories",
    "search": "Search categories",
    "uncategorized": "Uncategorized",
    "current_actual": "Current actual",
    "current_forecast": "Current forecast",
    "insufficient_history": "At least two completed months are required for a forecast.",
    "empty": "No category spending in this period",
    "error": "Category history could not be loaded",
    "forecast_formula": "Forecast = actual through today + average spending after today's day-of-month in the selected completed months.",
    "definition": "Completed months only. Refunds reduce spending; savings, debt payments, ordinary transfers, and configured dashboard exclusions are excluded."
  },
  "flow": {
    "title": "Money flow",
    "chart_label": "Sources and destinations of money for the selected month",
    "previous_month": "Previous month",
    "next_month": "Next month",
    "source": "Source",
    "destination": "Destination",
    "available": "Available",
    "income": "New income",
    "savings_withdrawn": "Savings withdrawn",
    "new_debt": "New debt",
    "prior_excess_used": "Past excess used",
    "net_refunds": "Net refunds",
    "expenses": "Expenses",
    "savings_deposited": "Savings deposited",
    "debt_repaid": "Debt repaid",
    "new_excess": "New excess",
    "empty": "No money flow in this month",
    "error": "Money flow could not be loaded",
    "not_balanced": "The classified flow does not balance, so the diagram is hidden.",
    "definition": "Savings and debt are net monthly movement. Card purchases are expenses plus new debt; card payments reduce debt; ordinary transfers cancel.",
    "prior_excess_formula": "Past excess used = max(0, destinations - classified sources)",
    "new_excess_formula": "New excess = max(0, classified sources - destinations)"
  }
}
~~~

- [ ] **Step 5: Translate the same keys in every locale**

Add the identical key structure with semantically equivalent translations to de-DE, es-MX, fr, it, ko, pl, pt-BR, ro, ru-RU, and zh-CN. Keep formula operators, 3M/6M/12M/24M abbreviations, currency codes, and placeholder names unchanged. Do not leave an English fallback for warnings or financial definitions.

Parse all locale files:

~~~powershell
Get-ChildItem i18n/locales/*.json | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json | Out-Null }
~~~

Expected: no output and exit code 0.

- [ ] **Step 6: Add final responsive and semantic theme variables**

In variables.css add light values under :root and dark values under .van-theme-dark:

~~~css
--analytics-net-worth: #1e88e5;
--analytics-savings: #66bb6a;
--analytics-debt: #ec407a;
--analytics-forecast: #7e57c2;
--analytics-grid: rgba(100, 116, 139, 0.18);
--analytics-category-1: #1e88e5;
--analytics-category-2: #66bb6a;
--analytics-category-3: #ec407a;
--analytics-category-4: #7e57c2;
--analytics-category-5: #ffa726;
--analytics-category-6: #26a69a;
~~~

Under .van-theme-dark override the grid while retaining the semantic series colors:

~~~css
--analytics-grid: rgba(226, 232, 240, 0.2);
~~~

Add final layout:

~~~css
.analytics-page-switch {
  margin: 10px 16px;
}

.analytics-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  padding-bottom: 100px;
}

@media (min-width: 1100px) {
  .analytics-layout {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .analytics-layout-balance {
    grid-column: 1 / -1;
  }
}
~~~

Because layout switching is normally appStore.isDesktopLayout, use the CSS grid breakpoint only for card packing inside the already-selected desktop content shell; do not use it to choose mobile/desktop components or navigation.

- [ ] **Step 7: Run integrated static proof and commit**

Run:

~~~powershell
npm run lint:fix
npm run test:analytics
npm run lint
npm run build
Get-ChildItem i18n/locales/*.json | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json | Out-Null }
git diff --check
~~~

Expected: all commands PASS. Inspect git status and ensure only analytics implementation, tests, styles, routes, locales, and this already-created plan/spec are present. Commit:

~~~powershell
git add front/pages/analytics.vue front/pages/dashboard.vue front/components/analytics/analytics-page-switch.vue front/constants/RouteConstants.js front/constants/TablerIconConstants.js front/stores/appStore.js front/components/ui-kit/theme/app-left-sidebar/app-left-sidebar.vue front/assets/styles/variables.css front/assets/styles/theme-white.css front/assets/styles/theme-dark.css front/i18n/locales
git commit -m "feat: add extended analytics page"
~~~

---

### Task 10: Verify Financial Semantics and Rendered Interaction

**Files:**
- Modify only if verification exposes a defect: files introduced or changed in Tasks 1-9.
- Record evidence in the implementation handoff or final response; do not create a second product specification.

**Interfaces:**
- Consumes: the complete feature.
- Produces: honest automated and rendered proof, with any fixes isolated in a final commit.

- [ ] **Step 1: Run the complete automated verification ladder**

From front:

~~~powershell
npm run test:analytics
npm run lint
npm run build
Get-ChildItem i18n/locales/*.json | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json | Out-Null }
~~~

From the repository root:

~~~powershell
git diff --check upstream/dev...HEAD
pwsh -NoProfile -File .agents/skills/firefly-pico-oss-contribution/scripts/contribution-preflight.ps1
~~~

Expected: tests/lint/build/JSON parsing/diff check PASS. Preflight must show no blockers; warnings remain review items, not failures.

- [ ] **Step 2: Validate calculation fixtures against the approved definitions**

Read the passing test names and explicitly confirm coverage for:

- active include_net_worth accounts;
- savings-role assets;
- debit liabilities and credit cards as debt;
- credit-direction liabilities excluded from debt;
- historical primary amounts and current-rate labels;
- missing rates omitted;
- completed 3/6/12/24-month windows;
- zero-spend months after ledger start;
- current month excluded from averages;
- current forecast remainder after today's date;
- at least two months required for forecast;
- refunds, splits, uncategorized, savings, debt, card purchase/payment, internal transfer cancellation, residual exclusivity, and conservation.

If a named behavior lacks a passing assertion, add the exact fixture before proceeding.

- [ ] **Step 3: Start the app and inspect mobile light theme**

Run the existing development command:

~~~powershell
cd front
npm run dev
~~~

Open /analytics with the browser-control skill. Use a mobile viewport at or below 800px and light theme. Verify:

- Dashboard bottom item remains selected;
- Overview / Analytics switch navigates both ways;
- cards render in balance/category/flow order;
- 3/6/12 balance selection and series toggles work;
- category facet searches, deselects, and rejects a seventh selection;
- 3/6/12/24 average selection updates Based on X of N months;
- actual and forecast use distinct markers/lines;
- flow month arrows stop at bounds;
- exact drilldowns open a transaction list with id= IDs;
- loading, empty, retry, stale, missing-rate, and insufficient-history fixtures remain legible.

Record unavailable states as NOT RUN if live data cannot produce them; do not infer them from build success.

- [ ] **Step 4: Verify touch chart inspection**

In mobile emulation:

- touch-drag from the leftmost to rightmost balance/category point;
- confirm one vertical crosshair follows;
- confirm every visible series shows its exact amount;
- release and confirm the tooltip remains pinned;
- tap outside and confirm it dismisses;
- drag vertically over the chart and confirm page scrolling remains usable;
- select an actual point and confirm drilldown;
- select a forecast point and confirm formula details rather than a transaction route.

- [ ] **Step 5: Inspect desktop light/dark and keyboard behavior**

Use a desktop viewport above 1100px:

- Analytics appears as its own sidebar item;
- balance is full width and category/flow sit side by side;
- tooltip flips at both chart edges;
- pointer hover updates, click pins, and outside click dismisses;
- Tab focuses chart/nodes;
- Left/Right/Home/End move the crosshair;
- Enter pins and Escape dismisses;
- the live-region text matches the selected date and all visible values;
- the flow accessible list contains the same amounts as the SVG.

Repeat the main page, popups, charts, tooltips, warnings, focus rings, and flow bands in dark theme.

- [ ] **Step 6: Inspect real-data reconciliation boundaries**

For one visible month and one category:

1. Record the card amount.
2. Drill into its exact ID list.
3. Sum the included split amounts in the selected currency.
4. Confirm the value reconciles, or record the exact mismatch and fix the classifier.

For flow, compare source total, destination total, and audit equationDifference. For balance, compare the latest daily 3M point with the current account aggregate; note that a 1W sample can precede today.

- [ ] **Step 7: Fix only observed defects and rerun the narrow proof**

For every observed issue:

1. Add or tighten a deterministic test when the defect is financial or geometric.
2. Make the smallest implementation change.
3. Rerun the focused test.
4. Rerun npm run lint and npm run build after all fixes.

If files changed, commit only verified fixes:

~~~powershell
git add front
git commit -m "fix: resolve extended analytics verification issues"
~~~

If no files changed, do not create an empty commit.

- [ ] **Step 8: Produce the completion handoff**

Report:

- commit list and changed-file scope;
- exact PASS commands and outcomes;
- mobile/desktop and light/dark states actually inspected;
- live-data reconciliation performed;
- any NOT RUN interaction or data state;
- personal-fork status;
- generic upstreamable slices: AnalyticsUtils primitives, safe pagination, and accessible SVG chart behavior;
- rollback: revert the feature commits in reverse order;
- publication gate: no push or PR without a new explicit approval.

Do not claim the feature complete until superpowers:verification-before-completion has been used and all required proof has been reviewed.
