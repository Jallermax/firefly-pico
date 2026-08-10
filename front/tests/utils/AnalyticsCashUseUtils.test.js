import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as AnalyticsCashUseUtils from '../../utils/AnalyticsCashUseUtils.js'
import { projectLineChartSelection } from '../../utils/ChartUtils.js'

const { buildCashUseSeries, buildCashUseVisualStyles } = AnalyticsCashUseUtils

const refundDefaults = {
  isRefund: false,
  signals: [],
  linkedPurchaseTransactionId: null,
  linkedPurchaseMonthKey: null,
  coverageCategoryId: null,
  coverageMonthKey: null,
  coverageValue: 0,
  isLinked: false,
}

const entry = ({ id, monthKey = '2026-06', day = 5, value, sourceKind, destinationKind, categoryId = null, sourceAccountId = null, destinationAccountId = null, refund = {} }) => ({
  id: `entry:${id}`,
  transactionId: id,
  date: `${monthKey}-${String(day).padStart(2, '0')}`,
  monthKey,
  day,
  value,
  sourceKind,
  destinationKind,
  sourceAccount: sourceAccountId ? { id: sourceAccountId } : null,
  destinationAccount: destinationAccountId ? { id: destinationAccountId } : null,
  categoryId,
  refund: { ...refundDefaults, ...refund },
})

const ledger = (entries, startMonth = '2026-06') => ({
  entries,
  coverage: { startMonth, endDate: '2026-08-10' },
  fx: { isEstimated: false, missingCurrencies: [], transactionIds: [] },
  audit: { unclassifiedValue: 0, transactionIds: [] },
})

const projected = ({ id, date = '2026-08-20', categoryId = null, flowAmounts, evidenceIds = [], ...context }) => ({
  id,
  date,
  categoryId,
  sourceKind: 'defined',
  sourceId: `source:${id}`,
  candidateId: `candidate:${id}`,
  evidenceIds,
  flowAmounts,
  ...context,
})

const build = ({ entries, mode = 'spending', savingsView = 'combined', categoryIds = [], detailLevel = 'all', remainingActivity = {}, months = ['2026-06', '2026-07'] }) =>
  buildCashUseSeries({
    ledger: ledger(entries),
    remainingActivity: {
      currentMonthKey: '2026-08',
      dailyProjectedEntries: [],
      status: 'ready',
      statusByMetric: {},
      ...remainingActivity,
    },
    months,
    mode,
    savingsView,
    categoryIds,
    detailLevel,
  })

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

const pointFor = (series, x) => series.points.find((point) => point.x === x)
const layerFor = (series, id) => series.useLayers.find((layer) => layer.id === id)
const sourceFor = (series, id) => series.sourceBands.find((layer) => layer.id === id)
const geometryFor = (options) => AnalyticsCashUseUtils.buildCombinationAreaGeometry?.(options) ?? []
const interactionFor = (state, event) => AnalyticsCashUseUtils.reduceCombinationChartInteraction?.(state, event) ?? state
const reconciliationFor = (options) => AnalyticsCashUseUtils.propagateCashUseReconciliation?.(options) ?? options
const cashUseStyles = (series) =>
  buildCashUseVisualStyles({
    series,
    categoryColors: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'],
    sourceColors: ['s1', 's2', 's3'],
    semanticColors: { income: 'green', expense: 'pink', transfer: 'blue', neutral: 'grey' },
  })

test('Cash Use assigns deterministic non-colliding visual tuples', () => {
  for (const series of [
    build({ entries: rankedCategoryEntries(12), detailLevel: 5 }),
    build({ entries: rankedCategoryEntries(12), detailLevel: 10 }),
    build({ entries: rankedCategoryEntries(20), detailLevel: 'all' }),
  ]) {
    const styles = cashUseStyles(series)
    const categoryTuples = Object.entries(styles)
      .filter(([id]) => id.startsWith('category:'))
      .map(([, style]) => `${style.color}|${style.pattern}|${style.markerKind}`)

    assert.equal(new Set(categoryTuples).size, categoryTuples.length)
  }

  const styles = cashUseStyles(build({ entries: rankedCategoryEntries(20), detailLevel: 'all' }))
  assert.deepEqual(styles['gap-positive'], { color: 'green', pattern: 'gap-positive', markerKind: 'area' })
  assert.deepEqual(styles['ordinary-income'], { color: 'green', pattern: 'line', markerKind: 'line' })
  assert.deepEqual(styles['total-sources'], { color: 'grey', pattern: 'dotted-line', markerKind: 'line' })
})

test('Cash Use keeps All category descriptors bounded and renderer-ready at high detail', () => {
  const styles = cashUseStyles({
    useLayers: Array.from({ length: 10000 }, (_, index) => ({ id: `category:${index + 1}`, kind: 'expenseCategory' })),
    sourceBands: [],
  })
  const categoryStyles = Object.entries(styles).filter(([id]) => id.startsWith('category:'))

  assert.equal(categoryStyles.length, 10000)
  assert.deepEqual(styles['category:328'], { color: 'c8', pattern: 'solid', patternVariant: 'stroke-08-01', strokeDasharray: '8 1', markerKind: 'area', legendOrdinal: 328 })
  assert.deepEqual(styles['category:561'], { color: 'c1', pattern: 'solid', patternVariant: 'stroke-14-01', strokeDasharray: '14 1', markerKind: 'area', legendOrdinal: 561 })
  assert.notDeepEqual(styles['category:328'], styles['category:561'])
  assert.ok(
    categoryStyles.every(
      ([, style], index) =>
        /^c\d+$/.test(style.color) &&
        (style.patternVariant === 'primary' || /^stroke-\d{2}-\d{2}$/.test(style.patternVariant)) &&
        (style.patternVariant === 'primary' || AnalyticsCashUseUtils.cashUsePatternVariantStrokeDasharray(style.patternVariant) === style.strokeDasharray) &&
        style.legendOrdinal === index + 1,
    ),
  )
})

test('Cash Use emits 10000 unique color pattern and stroke descriptors without cycling', () => {
  const styles = cashUseStyles({
    useLayers: Array.from({ length: 10000 }, (_, index) => ({ id: `category:${index + 1}`, kind: 'expenseCategory' })),
    sourceBands: [],
  })
  const tuple = ({ color, pattern, strokeDasharray }) => `${color}|${pattern}|${strokeDasharray ?? 'none'}`
  const tuples = Array.from({ length: 10000 }, (_, index) => tuple(styles[`category:${index + 1}`]))

  assert.notEqual(tuples[40], tuples[360], 'category 41 and 361')
  assert.notEqual(tuples[240], tuples[560], 'category 241 and 561')
  assert.equal(new Set(tuples).size, 10000)
})

test('Cash Use renders overflow variants with one shared chart and legend dash encoding', () => {
  const styles = cashUseStyles({
    useLayers: Array.from({ length: 700 }, (_, index) => ({ id: `category:${index + 1}`, kind: 'expenseCategory' })),
    sourceBands: [],
  })
  const chart = readFileSync(new URL('../../components/charts/analytics-combination-chart.vue', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../../assets/styles/theme-white.css', import.meta.url), 'utf8')
  const expected = [
    ['category:41', 'stroke-01-01', '1 1'],
    ['category:241', 'stroke-06-01', '6 1'],
    ['category:361', 'stroke-09-01', '9 1'],
    ['category:561', 'stroke-14-01', '14 1'],
    ['category:681', 'stroke-01-02', '1 2'],
  ]

  assert.equal(typeof AnalyticsCashUseUtils.cashUsePatternVariantStrokeDasharray, 'function')
  for (const [id, patternVariant, strokeDasharray] of expected) {
    const [dash, gap] = strokeDasharray.split(' ')
    assert.equal(styles[id].patternVariant, patternVariant, id)
    assert.equal(styles[id].strokeDasharray, strokeDasharray, id)
    assert.equal(AnalyticsCashUseUtils.cashUsePatternVariantStrokeDasharray(patternVariant), strokeDasharray, id)
    assert.match(css, new RegExp(`\\[data-pattern-variant\\^='stroke-${String(dash).padStart(2, '0')}-'\\] \\{ --pattern-variant-dash: ${dash}px; \\}`), `${id} dash`)
    assert.match(css, new RegExp(`\\[data-pattern-variant\\$='-${String(gap).padStart(2, '0')}'\\] \\{ --pattern-variant-gap: ${gap}px; \\}`), `${id} gap`)
  }
  assert.match(chart, /:stroke-dasharray="layer\.strokeDasharray"/)
  assert.match(chart, /const areaStroke = \(item\) => \(item\.strokeDasharray \? 'var\(--van-text-color\)' : null\)/)
  assert.match(css, /\.analytics-cash-use-legend-marker\[data-pattern-variant\^='stroke-'\]::after/)
  assert.match(
    css,
    /repeating-linear-gradient\(90deg, var\(--van-text-color\) 0 var\(--pattern-variant-dash\), transparent var\(--pattern-variant-dash\) calc\(var\(--pattern-variant-dash\) \+ var\(--pattern-variant-gap\)\)\)/,
  )
})

test('Cash Use keeps Other distinct and ignores non-category source order', () => {
  const entries = [
    ...rankedCategoryEntries(12),
    entry({ id: 'income', value: 500, sourceKind: 'revenue', destinationKind: 'available' }),
    entry({ id: 'savings', value: 100, sourceKind: 'available', destinationKind: 'savingsAccessible' }),
    entry({ id: 'debt', value: 50, sourceKind: 'liability', destinationKind: 'available' }),
  ]
  const ordered = cashUseStyles(build({ entries, mode: 'full', detailLevel: 5 }))
  const shuffled = cashUseStyles(build({ entries: [...rankedCategoryEntries(12), ...entries.slice(12).reverse()], mode: 'full', detailLevel: 5 }))
  const fullCombined = cashUseStyles(build({ entries, mode: 'full', savingsView: 'combined', detailLevel: 5 }))
  const fullSplit = cashUseStyles(build({ entries, mode: 'full', savingsView: 'split', detailLevel: 5 }))

  assert.equal(JSON.stringify(shuffled), JSON.stringify(ordered))
  assert.deepEqual(ordered['category:other'], { color: 'blue', pattern: 'category-dots', markerKind: 'area' })
  assert.notDeepEqual(ordered['category:other'], ordered['category:category-1'])
  assert.deepEqual(fullCombined.refunds, { color: 'pink', pattern: 'refund', markerKind: 'area' })
  assert.deepEqual(fullCombined['savings:combined'], { color: 's1', pattern: 'accessible-savings', markerKind: 'area' })
  assert.deepEqual(fullCombined['savings-withdrawn:combined'], { color: 's2', pattern: 'accessible-savings', markerKind: 'area' })
  assert.deepEqual(fullSplit['refund-coverage'], { color: 'pink', pattern: 'refund', markerKind: 'area' })
  assert.deepEqual(fullSplit['debt:repaid'], { color: 'pink', pattern: 'debt', markerKind: 'area' })
  assert.deepEqual(fullSplit['savings:accessible'], { color: 's1', pattern: 'accessible-savings', markerKind: 'area' })
  assert.deepEqual(fullSplit['savings:restricted'], { color: 's2', pattern: 'restricted-savings', markerKind: 'area' })
  assert.deepEqual(fullSplit['savings-withdrawn:accessible'], { color: 's2', pattern: 'accessible-savings', markerKind: 'area' })
  assert.deepEqual(fullSplit['savings-withdrawn:restricted'], { color: 's3', pattern: 'restricted-savings', markerKind: 'area' })
  assert.deepEqual(fullSplit['new-debt'], { color: 'pink', pattern: 'debt', markerKind: 'area' })
  assert.deepEqual(fullSplit['gap-negative'], { color: 'pink', pattern: 'gap-negative', markerKind: 'area' })
})

test('spending mode reconciles gross category areas, truthful refund cash, coverage, zero months, and exact IDs', () => {
  const result = build({
    entries: [
      entry({ id: 'food-june', value: 100, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' }),
      entry({ id: 'tech-june', value: 50, sourceKind: 'available', destinationKind: 'expense', categoryId: 'tech' }),
      entry({ id: 'salary-june', value: 200, sourceKind: 'revenue', destinationKind: 'available', categoryId: 'salary' }),
      entry({ id: 'salary-july', monthKey: '2026-07', value: 20, sourceKind: 'revenue', destinationKind: 'available', categoryId: 'salary' }),
      entry({
        id: 'refund-tech',
        monthKey: '2026-07',
        value: 20,
        sourceKind: 'expense',
        destinationKind: 'available',
        categoryId: 'tech',
        refund: {
          isRefund: true,
          signals: ['link'],
          linkedPurchaseTransactionId: 'tech-june',
          linkedPurchaseMonthKey: '2026-06',
          coverageCategoryId: 'tech',
          coverageMonthKey: '2026-06',
          coverageValue: 20,
          isLinked: true,
        },
      }),
    ],
  })

  assert.deepEqual(result.monthKeys, ['2026-06', '2026-07', '2026-08:forecast'])
  assert.deepEqual(
    result.useLayers.map(({ id }) => id),
    ['category:food', 'category:tech'],
  )
  assert.deepEqual(pointFor(layerFor(result, 'category:food'), '2026-06'), {
    x: '2026-06',
    kind: 'actual',
    value: 100,
    actualValue: 100,
    projectedValue: 0,
    bottom: 0,
    top: 100,
    transactionIds: ['food-june'],
    projectedSources: [],
    refundCoverage: {
      gross: 100,
      refunded: 0,
      netCost: 100,
      status: 'none',
      refundTransactionIds: [],
      purchaseTransactionIds: [],
      unavailableTransactionIds: [],
    },
  })
  assert.equal(pointFor(layerFor(result, 'category:food'), '2026-07').value, 0)
  assert.deepEqual(pointFor(layerFor(result, 'category:tech'), '2026-06').refundCoverage, {
    gross: 50,
    refunded: 20,
    netCost: 30,
    status: 'ready',
    refundTransactionIds: ['refund-tech'],
    purchaseTransactionIds: ['tech-june'],
    unavailableTransactionIds: [],
  })
  assert.deepEqual(pointFor(sourceFor(result, 'refunds'), '2026-07').transactionIds, ['refund-tech'])
  assert.equal(pointFor(sourceFor(result, 'refunds'), '2026-07').value, 20)
  assert.deepEqual(pointFor(result.ordinaryIncome, '2026-07').transactionIds, ['salary-july'])
  assert.deepEqual(pointFor(result.totals, '2026-06'), {
    x: '2026-06',
    kind: 'actual',
    uses: 150,
    sources: 200,
    gap: 50,
    status: 'ok',
    delta: 0,
  })
  assert.deepEqual(result.audit.reconciliation[0], {
    monthKey: '2026-06',
    status: 'ok',
    grossExpense: 150,
    categoryTotal: 150,
    categoryDelta: 0,
    totalUses: 150,
    useLayerTotal: 150,
    useDelta: 0,
    totalSources: 200,
    sourceComponentTotal: 200,
    sourceDelta: 0,
    gap: 50,
    gapDelta: 0,
    delta: 0,
  })
  assert.deepEqual(pointFor(result.gap, '2026-07'), {
    x: '2026-07',
    kind: 'actual',
    value: 40,
    bottom: 0,
    top: 40,
    direction: 'positive',
    labelKey: 'analytics.cash_use.after_spending',
    pattern: 'gap-positive',
    transactionIds: ['refund-tech', 'salary-july'],
    projectedSources: [],
  })
})

test('full mode uses liability-only debt and splits accessible and restricted net savings', () => {
  const entries = [
    entry({ id: 'salary', value: 200, sourceKind: 'revenue', destinationKind: 'available' }),
    entry({ id: 'card-food', value: 80, sourceKind: 'available', destinationKind: 'expense', sourceAccountId: 'credit-card', categoryId: 'food' }),
    entry({ id: 'accessible-in', value: 70, sourceKind: 'available', destinationKind: 'savingsAccessible', destinationAccountId: 'hysa' }),
    entry({ id: 'accessible-out', value: 20, sourceKind: 'savingsAccessible', destinationKind: 'available', sourceAccountId: 'hysa' }),
    entry({ id: 'restricted-in', value: 30, sourceKind: 'available', destinationKind: 'savingsRestricted', destinationAccountId: '401k' }),
    entry({ id: 'loan-payment', value: 25, sourceKind: 'available', destinationKind: 'liability', destinationAccountId: 'loan' }),
    entry({ id: 'loan-proceeds', value: 10, sourceKind: 'liability', destinationKind: 'available', sourceAccountId: 'loan' }),
  ]

  const split = build({ entries, mode: 'full', savingsView: 'split' })
  assert.deepEqual(
    split.useLayers.map(({ id }) => id),
    ['category:food', 'debt:repaid', 'savings:accessible', 'savings:restricted'],
  )
  assert.equal(pointFor(layerFor(split, 'savings:accessible'), '2026-06').value, 50)
  assert.deepEqual(pointFor(layerFor(split, 'savings:accessible'), '2026-06').transactionIds, ['accessible-in', 'accessible-out'])
  assert.equal(pointFor(layerFor(split, 'savings:restricted'), '2026-06').value, 30)
  assert.deepEqual(pointFor(layerFor(split, 'debt:repaid'), '2026-06').transactionIds, ['loan-payment'])
  assert.equal(pointFor(sourceFor(split, 'new-debt'), '2026-06').value, 10)
  assert.equal(pointFor(split.totals, '2026-06').uses, 185)
  assert.equal(pointFor(split.totals, '2026-06').sources, 210)
  assert.equal(pointFor(split.gap, '2026-06').value, 25)
  assert.ok(!pointFor(layerFor(split, 'debt:repaid'), '2026-06').transactionIds.includes('card-food'))

  const combined = build({ entries, mode: 'full', savingsView: 'combined' })
  assert.ok(layerFor(combined, 'savings:combined'))
  assert.equal(pointFor(layerFor(combined, 'savings:combined'), '2026-06').value, 80)
  assert.equal(layerFor(combined, 'savings:accessible'), undefined)

  const spending = build({ entries, mode: 'spending', savingsView: 'split' })
  assert.deepEqual(
    spending.useLayers.map(({ id }) => id),
    ['category:food'],
  )
  assert.deepEqual(
    spending.sourceBands.map(({ id }) => id),
    ['refunds'],
  )
})

test('full mode places debt before savings without changing Cash Use evidence or reconciliation', () => {
  const series = build({
    entries: [
      entry({ id: 'category-1', value: 60, sourceKind: 'available', destinationKind: 'expense', categoryId: 'category-1' }),
      entry({ id: 'category-2', value: 50, sourceKind: 'available', destinationKind: 'expense', categoryId: 'category-2' }),
      entry({ id: 'category-3', value: 40, sourceKind: 'available', destinationKind: 'expense', categoryId: 'category-3' }),
      entry({ id: 'category-4', value: 30, sourceKind: 'available', destinationKind: 'expense', categoryId: 'category-4' }),
      entry({ id: 'category-5', value: 20, sourceKind: 'available', destinationKind: 'expense', categoryId: 'category-5' }),
      entry({ id: 'category-6', value: 10, sourceKind: 'available', destinationKind: 'expense', categoryId: 'category-6' }),
      entry({ id: 'accessible-in', value: 70, sourceKind: 'available', destinationKind: 'savingsAccessible' }),
      entry({ id: 'accessible-out', value: 20, sourceKind: 'savingsAccessible', destinationKind: 'available' }),
      entry({ id: 'restricted-in', value: 30, sourceKind: 'available', destinationKind: 'savingsRestricted' }),
      entry({ id: 'loan-payment', value: 25, sourceKind: 'available', destinationKind: 'liability' }),
    ],
    mode: 'full',
    savingsView: 'split',
    detailLevel: 5,
    remainingActivity: {
      dailyProjectedEntries: [
        projected({ id: 'future-category-1', categoryId: 'category-1', flowAmounts: { expenses: 11 } }),
        projected({ id: 'future-category-6', categoryId: 'category-6', flowAmounts: { expenses: 9 } }),
        projected({ id: 'future-debt', flowAmounts: { debtRepayments: 15 } }),
        projected({ id: 'future-accessible', destinationKind: 'savingsAccessible', flowAmounts: { savingsDeposits: 20 } }),
        projected({ id: 'future-restricted', destinationKind: 'savingsRestricted', flowAmounts: { savingsDeposits: 10 } }),
      ],
    },
  })

  assert.deepEqual(
    series.useLayers.map(({ kind }) => kind),
    ['expenseCategory', 'expenseCategory', 'expenseCategory', 'expenseCategory', 'expenseCategory', 'otherExpense', 'debtRepaid', 'savingsAccessibleDeposit', 'savingsRestrictedDeposit'],
  )
  assert.deepEqual(
    { value: pointFor(series.totalUses, '2026-06').value, transactionIds: pointFor(series.totalUses, '2026-06').transactionIds },
    { value: 315, transactionIds: ['accessible-in', 'accessible-out', 'category-1', 'category-2', 'category-3', 'category-4', 'category-5', 'category-6', 'loan-payment', 'restricted-in'] },
  )
  assert.deepEqual(
    { value: pointFor(series.totalUses, '2026-08:forecast').value, projectedSources: pointFor(series.totalUses, '2026-08:forecast').projectedSources.map(({ id }) => id) },
    { value: 65, projectedSources: ['future-category-1', 'future-category-6', 'future-debt', 'future-accessible', 'future-restricted'] },
  )
  assert.deepEqual(
    series.audit.reconciliation.find(({ monthKey }) => monthKey === '2026-06'),
    {
      monthKey: '2026-06',
      status: 'ok',
      grossExpense: 210,
      categoryTotal: 210,
      categoryDelta: 0,
      totalUses: 315,
      useLayerTotal: 315,
      useDelta: 0,
      totalSources: 0,
      sourceComponentTotal: 0,
      sourceDelta: 0,
      gap: -315,
      gapDelta: 0,
      delta: 0,
    },
  )
  assert.deepEqual(
    series.audit.reconciliation.find(({ monthKey }) => monthKey === '2026-08:forecast'),
    {
      monthKey: '2026-08:forecast',
      status: 'ok',
      grossExpense: 20,
      categoryTotal: 20,
      categoryDelta: 0,
      totalUses: 65,
      useLayerTotal: 65,
      useDelta: 0,
      totalSources: 0,
      sourceComponentTotal: 0,
      sourceDelta: 0,
      gap: -65,
      gapDelta: 0,
      delta: 0,
    },
  )
})

test('net Savings deposit clears withdrawal-side and zero Total sources transaction IDs', () => {
  const result = build({
    entries: [entry({ id: 'deposit-1', value: 50, sourceKind: 'available', destinationKind: 'savingsAccessible', destinationAccountId: 'hysa' })],
    mode: 'full',
  })

  assert.deepEqual(
    { value: pointFor(layerFor(result, 'savings:combined'), '2026-06').value, transactionIds: pointFor(layerFor(result, 'savings:combined'), '2026-06').transactionIds },
    { value: 50, transactionIds: ['deposit-1'] },
  )
  assert.deepEqual(
    { value: pointFor(sourceFor(result, 'savings-withdrawn:combined'), '2026-06').value, transactionIds: pointFor(sourceFor(result, 'savings-withdrawn:combined'), '2026-06').transactionIds },
    { value: 0, transactionIds: [] },
  )
  assert.deepEqual({ value: pointFor(result.totalUses, '2026-06').value, transactionIds: pointFor(result.totalUses, '2026-06').transactionIds }, { value: 50, transactionIds: ['deposit-1'] })
  assert.deepEqual({ value: pointFor(result.totalSources, '2026-06').value, transactionIds: pointFor(result.totalSources, '2026-06').transactionIds }, { value: 0, transactionIds: [] })
})

test('net Savings withdrawal clears deposit-side and zero Total uses transaction IDs', () => {
  const result = build({
    entries: [entry({ id: 'withdraw-1', value: 50, sourceKind: 'savingsAccessible', destinationKind: 'available', sourceAccountId: 'hysa' })],
    mode: 'full',
  })

  assert.deepEqual(
    { value: pointFor(layerFor(result, 'savings:combined'), '2026-06').value, transactionIds: pointFor(layerFor(result, 'savings:combined'), '2026-06').transactionIds },
    { value: 0, transactionIds: [] },
  )
  assert.deepEqual(
    { value: pointFor(sourceFor(result, 'savings-withdrawn:combined'), '2026-06').value, transactionIds: pointFor(sourceFor(result, 'savings-withdrawn:combined'), '2026-06').transactionIds },
    { value: 50, transactionIds: ['withdraw-1'] },
  )
  assert.deepEqual({ value: pointFor(result.totalUses, '2026-06').value, transactionIds: pointFor(result.totalUses, '2026-06').transactionIds }, { value: 0, transactionIds: [] })
  assert.deepEqual({ value: pointFor(result.totalSources, '2026-06').value, transactionIds: pointFor(result.totalSources, '2026-06').transactionIds }, { value: 50, transactionIds: ['withdraw-1'] })
})

test('full mode keeps a negative shortfall and uses mode-specific gap labels', () => {
  const entries = [
    entry({ id: 'income', value: 40, sourceKind: 'revenue', destinationKind: 'available' }),
    entry({ id: 'expense', value: 100, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' }),
  ]

  const full = build({ entries, mode: 'full' })
  assert.deepEqual(pointFor(full.gap, '2026-06'), {
    x: '2026-06',
    kind: 'actual',
    value: -60,
    bottom: 40,
    top: 100,
    direction: 'negative',
    labelKey: 'analytics.cash_use.existing_available_funds_required',
    pattern: 'gap-negative',
    transactionIds: ['expense', 'income'],
    projectedSources: [],
  })

  const spending = build({ entries, mode: 'spending' })
  assert.equal(pointFor(spending.gap, '2026-06').value, -60)
  assert.equal(pointFor(spending.gap, '2026-06').labelKey, 'analytics.cash_use.after_spending')
})

test('Cash Use detail alone owns visible categories and Other', () => {
  const topFive = build({ entries: rankedCategoryEntries(12), categoryIds: ['category-12'], detailLevel: 5 })

  assert.deepEqual(topFive.visibleCategoryIds, ['category-1', 'category-2', 'category-3', 'category-4', 'category-5'])
  assert.deepEqual(
    topFive.useLayers.filter(({ kind }) => kind === 'expenseCategory').map(({ categoryId }) => categoryId),
    topFive.visibleCategoryIds,
  )
  assert.deepEqual(topFive.useLayers.find(({ kind }) => kind === 'otherExpense').categoryIds, ['category-6', 'category-7', 'category-8', 'category-9', 'category-10', 'category-11', 'category-12'])
})

test('detail ranking is completed-window-only, groups Other last, and includes projected Uncategorized', () => {
  const result = build({
    entries: [
      entry({ id: 'a-june', value: 50, sourceKind: 'available', destinationKind: 'expense', categoryId: 'a' }),
      entry({ id: 'b-june', value: 40, sourceKind: 'available', destinationKind: 'expense', categoryId: 'b' }),
      entry({ id: 'c-june', value: 30, sourceKind: 'available', destinationKind: 'expense', categoryId: 'c' }),
      entry({ id: 'd-june', value: 20, sourceKind: 'available', destinationKind: 'expense', categoryId: 'd' }),
      entry({ id: 'e-june', value: 10, sourceKind: 'available', destinationKind: 'expense', categoryId: 'e' }),
      entry({ id: 'f-june', value: 5, sourceKind: 'available', destinationKind: 'expense', categoryId: 'f' }),
      entry({ id: 'g-june', value: 1, sourceKind: 'available', destinationKind: 'expense', categoryId: 'g' }),
    ],
    categoryIds: ['f'],
    detailLevel: 5,
    remainingActivity: {
      currentMonthKey: '2026-08',
      dailyProjectedEntries: [projected({ id: 'future-uncategorized', categoryId: null, flowAmounts: { expenses: 25 }, evidenceIds: ['candidate-evidence'] })],
    },
  })

  assert.deepEqual(
    result.useLayers.map(({ id }) => id),
    ['category:a', 'category:b', 'category:c', 'category:d', 'category:e', 'category:other'],
  )
  assert.equal(pointFor(layerFor(result, 'category:other'), '2026-06').value, 6)
  assert.deepEqual(pointFor(layerFor(result, 'category:other'), '2026-06').transactionIds, ['f-june', 'g-june'])
  assert.equal(pointFor(layerFor(result, 'category:other'), '2026-08:forecast').value, 25)
  assert.deepEqual(pointFor(layerFor(result, 'category:other'), '2026-08:forecast').transactionIds, [])
  assert.deepEqual(
    pointFor(layerFor(result, 'category:other'), '2026-08:forecast').projectedSources.map(({ id }) => id),
    ['future-uncategorized'],
  )
  assert.equal(
    result.audit.reconciliation.every(({ status }) => status === 'ok'),
    true,
  )
})

test('forecast points separate actual IDs and values from projected source evidence', () => {
  const result = build({
    entries: [
      entry({ id: 'actual-income', monthKey: '2026-08', value: 100, sourceKind: 'revenue', destinationKind: 'available' }),
      entry({ id: 'actual-food', monthKey: '2026-08', value: 60, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' }),
    ],
    remainingActivity: {
      currentMonthKey: '2026-08',
      dailyProjectedEntries: [
        projected({ id: 'future-income', flowAmounts: { income: 50 }, evidenceIds: ['income-pattern'] }),
        projected({ id: 'future-food', categoryId: 'food', flowAmounts: { expenses: 40 }, evidenceIds: ['food-pattern'] }),
        projected({ id: 'future-refund', categoryId: 'food', flowAmounts: { refunds: 10 }, evidenceIds: ['refund-pattern'] }),
      ],
      actualToDate: { income: 100, refunds: 0, expenses: 60 },
      final: { income: 150, refunds: 10, expenses: 100 },
      progress: { expenses: 0.6 },
      progressState: { expenses: 'ready' },
      statusByMetric: { income: 'ready', refunds: 'ready', expenses: 'ready' },
    },
  })

  const food = pointFor(layerFor(result, 'category:food'), '2026-08:forecast')
  assert.equal(food.kind, 'forecast')
  assert.equal(food.value, 100)
  assert.equal(food.actualValue, 60)
  assert.equal(food.projectedValue, 40)
  assert.deepEqual(food.transactionIds, ['actual-food'])
  assert.deepEqual(
    food.projectedSources.map(({ id }) => id),
    ['future-food'],
  )
  assert.equal(food.progress, 0.6)
  assert.equal(food.progressState, 'ready')

  const income = pointFor(result.ordinaryIncome, '2026-08:forecast')
  assert.equal(income.value, 150)
  assert.equal(income.actualValue, 100)
  assert.deepEqual(income.transactionIds, ['actual-income'])
  assert.deepEqual(
    income.projectedSources.map(({ id }) => id),
    ['future-income'],
  )

  const refunds = pointFor(sourceFor(result, 'refunds'), '2026-08:forecast')
  assert.equal(refunds.value, 10)
  assert.deepEqual(refunds.transactionIds, [])
  assert.deepEqual(
    refunds.projectedSources.map(({ id }) => id),
    ['future-refund'],
  )
  assert.deepEqual(pointFor(result.gap, '2026-08:forecast').transactionIds, ['actual-food', 'actual-income'])

  const totalUses = pointFor(result.totalUses, '2026-08:forecast')
  assert.deepEqual(
    {
      value: totalUses.value,
      actualValue: totalUses.actualValue,
      projectedValue: totalUses.projectedValue,
      progress: totalUses.progress,
      progressState: totalUses.progressState,
      status: totalUses.status,
      transactionIds: totalUses.transactionIds,
      projectedSourceIds: totalUses.projectedSources.map(({ id }) => id),
    },
    {
      value: 100,
      actualValue: 60,
      projectedValue: 40,
      progress: 0.6,
      progressState: 'ready',
      status: 'ready',
      transactionIds: ['actual-food'],
      projectedSourceIds: ['future-food'],
    },
  )

  const totalSources = pointFor(result.totalSources, '2026-08:forecast')
  assert.deepEqual(
    {
      value: totalSources.value,
      actualValue: totalSources.actualValue,
      projectedValue: totalSources.projectedValue,
      progress: totalSources.progress,
      progressState: totalSources.progressState,
      status: totalSources.status,
      transactionIds: totalSources.transactionIds,
      projectedSourceIds: totalSources.projectedSources.map(({ id }) => id),
    },
    {
      value: 160,
      actualValue: 100,
      projectedValue: 60,
      progress: 0.625,
      progressState: 'ready',
      status: 'ready',
      transactionIds: ['actual-income'],
      projectedSourceIds: ['future-income', 'future-refund'],
    },
  )

  const gap = pointFor(result.gap, '2026-08:forecast')
  assert.deepEqual(
    {
      value: gap.value,
      actualValue: gap.actualValue,
      projectedValue: gap.projectedValue,
      progress: gap.progress,
      progressState: gap.progressState,
      status: gap.status,
    },
    { value: 60, actualValue: 40, projectedValue: 20, progress: 0.66666667, progressState: 'ready', status: 'ready' },
  )
  assert.equal(totalUses.actualValue + totalUses.projectedValue, totalUses.value)
  assert.equal(totalSources.actualValue + totalSources.projectedValue, totalSources.value)
  assert.equal(gap.actualValue + gap.projectedValue, gap.value)
})

test('signed forecast gap retains opposite-direction metadata without losing reconciliation', () => {
  const result = build({
    entries: [
      entry({ id: 'actual-income', monthKey: '2026-08', value: 50, sourceKind: 'revenue', destinationKind: 'available' }),
      entry({ id: 'actual-food', monthKey: '2026-08', value: 100, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' }),
    ],
    remainingActivity: {
      currentMonthKey: '2026-08',
      dailyProjectedEntries: [projected({ id: 'future-income', flowAmounts: { income: 100 } })],
      statusByMetric: { income: 'ready', refunds: 'ready', expenses: 'ready' },
      progressState: { income: 'ready', refunds: 'noExpectedActivity', expenses: 'noExpectedActivity' },
    },
  })

  const gap = pointFor(result.gap, '2026-08:forecast')
  assert.deepEqual(
    { value: gap.value, actualValue: gap.actualValue, projectedValue: gap.projectedValue, progress: gap.progress, progressState: gap.progressState, status: gap.status },
    { value: 50, actualValue: -50, projectedValue: 100, progress: null, progressState: 'oppositeDirection', status: 'ready' },
  )
  assert.equal(gap.actualValue + gap.projectedValue, gap.value)
})

test('unavailable relevant inputs are audited instead of becoming zero', () => {
  const result = build({
    entries: [entry({ id: 'missing-expense', value: null, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' })],
  })

  assert.equal(pointFor(layerFor(result, 'category:food'), '2026-06').value, null)
  assert.equal(pointFor(result.totals, '2026-06').status, 'unavailable')
  assert.deepEqual(result.audit.unavailable, [{ monthKey: '2026-06', transactionIds: ['missing-expense'] }])
  assert.equal(pointFor(result.gap, '2026-06').value, null)
})

test('unavailable forecast metrics remain unavailable instead of becoming zero projections', () => {
  const result = build({
    entries: [entry({ id: 'actual-food', monthKey: '2026-08', value: 60, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' })],
    remainingActivity: {
      currentMonthKey: '2026-08',
      dailyProjectedEntries: [],
      status: 'partial',
      statusByMetric: { income: 'ready', refunds: 'ready', expenses: 'unavailable' },
      audit: { unavailable: { affectedMetricIds: ['expenses'], candidateIds: ['rent-candidate'] } },
    },
  })

  assert.equal(pointFor(layerFor(result, 'category:food'), '2026-08:forecast').value, null)
  assert.equal(pointFor(layerFor(result, 'category:food'), '2026-08:forecast').status, 'unavailable')
  assert.equal(pointFor(result.totals, '2026-08:forecast').status, 'unavailable')
  assert.deepEqual(result.audit.unavailable.at(-1), {
    monthKey: '2026-08:forecast',
    transactionIds: [],
    projected: {
      metricIds: ['expenses'],
      sourceIds: [],
      candidateIds: ['rent-candidate'],
      evidenceIds: [],
      statuses: [{ metricId: 'expenses', status: 'unavailable' }],
    },
  })
})

test('empty expense categories preserve insufficient-history forecast unavailability in totals, gap, reconciliation, and audit', () => {
  const result = build({
    entries: [],
    remainingActivity: {
      currentMonthKey: '2026-08',
      dailyProjectedEntries: [],
      statusByMetric: { income: 'ready', refunds: 'ready', expenses: 'insufficientHistory' },
      progressState: { income: 'noExpectedActivity', refunds: 'noExpectedActivity', expenses: 'insufficientHistory' },
    },
  })

  const totals = pointFor(result.totals, '2026-08:forecast')
  const totalUses = pointFor(result.totalUses, '2026-08:forecast')
  const gap = pointFor(result.gap, '2026-08:forecast')
  const reconciliation = result.audit.reconciliation.find(({ monthKey }) => monthKey === '2026-08:forecast')

  assert.deepEqual(result.useLayers, [])
  assert.equal(totalUses.value, null)
  assert.equal(totalUses.status, 'insufficientHistory')
  assert.equal(totals.uses, null)
  assert.equal(totals.gap, null)
  assert.equal(totals.status, 'unavailable')
  assert.equal(gap.value, null)
  assert.equal(gap.status, 'unavailable')
  assert.equal(reconciliation.status, 'unavailable')
  assert.equal(result.audit.status, 'unavailable')
  assert.deepEqual(result.audit.unavailable.at(-1).projected.metricIds, ['expenses'])
})

test('reconciliation mismatches invalidate totals and gap instead of leaving audited values usable', () => {
  const result = reconciliationFor({
    totals: {
      id: 'totals',
      points: [{ x: '2026-07', kind: 'actual', uses: 10, sources: 20, gap: 10, status: 'ok', delta: 0 }],
    },
    gap: {
      id: 'gap',
      points: [{ x: '2026-07', kind: 'actual', value: 10, bottom: 10, top: 20, direction: 'positive', status: 'ok' }],
    },
    reconciliation: [{ monthKey: '2026-07', status: 'mismatch', delta: 1 }],
  })

  assert.deepEqual(result.totals.points[0], { x: '2026-07', kind: 'actual', uses: null, sources: null, gap: null, status: 'unavailable', delta: 1 })
  assert.deepEqual(result.gap.points[0], { x: '2026-07', kind: 'actual', value: null, bottom: null, top: null, direction: 'unavailable', status: 'unavailable' })
  assert.equal(result.auditStatus, 'mismatch')
})

test('Task 8 unavailable audit remains authoritative when its metric status is inconsistent', () => {
  const result = build({
    entries: [entry({ id: 'actual-food', monthKey: '2026-08', value: 60, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' })],
    remainingActivity: {
      currentMonthKey: '2026-08',
      dailyProjectedEntries: [projected({ id: 'future-food', categoryId: 'food', flowAmounts: { expenses: 40 } })],
      statusByMetric: { expenses: 'ready' },
      progressState: { expenses: 'ready' },
      audit: { unavailable: { affectedMetricIds: ['expenses'], candidateIds: ['rent-candidate'] } },
    },
  })

  assert.equal(pointFor(layerFor(result, 'category:food'), '2026-08:forecast').status, 'unavailable')
  assert.equal(pointFor(layerFor(result, 'category:food'), '2026-08:forecast').value, null)
})

test('projected unavailable evidence excludes candidates owned only by hidden Full cash-use metrics', () => {
  const result = build({
    entries: [],
    remainingActivity: {
      currentMonthKey: '2026-08',
      dailyProjectedEntries: [],
      statusByMetric: { income: 'ready', refunds: 'ready', expenses: 'unavailable', debtRepayments: 'unavailable' },
      audit: {
        unavailable: { affectedMetricIds: ['expenses', 'debtRepayments'], candidateIds: ['expense-candidate', 'debt-candidate'] },
        recurring: {
          unresolvedCandidates: [
            { candidateId: 'expense-candidate', sourceId: 'expense-source', affectedMetricIds: ['expenses'] },
            { candidateId: 'debt-candidate', sourceId: 'debt-source', affectedMetricIds: ['debtRepayments'] },
          ],
        },
      },
    },
  })

  assert.deepEqual(result.audit.unavailable.at(-1).projected, {
    metricIds: ['expenses'],
    sourceIds: ['expense-source'],
    candidateIds: ['expense-candidate'],
    evidenceIds: [],
    statuses: [{ metricId: 'expenses', status: 'unavailable' }],
  })
})

test('Spending audit excludes unavailable metrics owned only by hidden Full cash-use layers', () => {
  const result = build({
    entries: [entry({ id: 'historical-food', value: 1, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' })],
    remainingActivity: {
      currentMonthKey: '2026-08',
      dailyProjectedEntries: [],
      statusByMetric: { income: 'ready', refunds: 'ready', expenses: 'partial', debtRepayments: 'insufficientHistory' },
      progressState: { income: 'noExpectedActivity', refunds: 'noExpectedActivity', expenses: 'ready', debtRepayments: 'insufficientHistory' },
    },
  })

  assert.deepEqual(result.audit.unavailable.at(-1).projected.metricIds, ['expenses'])
})

const flowMetricDefinitions = [
  {
    id: 'expense',
    metric: 'expenses',
    projection: projected({ id: 'future-expense', categoryId: 'food', flowAmounts: { expenses: 10 } }),
    point: (series) => pointFor(layerFor(series, 'category:food'), '2026-08:forecast'),
  },
  {
    id: 'ordinary income',
    metric: 'income',
    projection: projected({ id: 'future-income', flowAmounts: { income: 10 } }),
    point: (series) => pointFor(series.ordinaryIncome, '2026-08:forecast'),
  },
  {
    id: 'refund',
    metric: 'refunds',
    projection: projected({ id: 'future-refund', categoryId: 'food', flowAmounts: { refunds: 10 } }),
    point: (series) => pointFor(sourceFor(series, 'refunds'), '2026-08:forecast'),
  },
  {
    id: 'savings',
    metric: 'savingsDeposits',
    projection: projected({ id: 'future-savings', flowAmounts: { savingsDeposits: 10 }, destinationAccountKind: 'savingsAccessible' }),
    point: (series) => pointFor(layerFor(series, 'savings:combined'), '2026-08:forecast'),
  },
  {
    id: 'debt',
    metric: 'debtRepayments',
    projection: projected({ id: 'future-debt', flowAmounts: { debtRepayments: 10 } }),
    point: (series) => pointFor(layerFor(series, 'debt:repaid'), '2026-08:forecast'),
  },
]
const forecastContractCases = [
  { id: 'ready', status: 'ready', progressState: 'ready', expectedValue: 10, expectedProgress: 0.25, includeProjection: true },
  { id: 'no expected activity', status: 'ready', progressState: 'noExpectedActivity', expectedValue: 0, expectedProgress: null, includeProjection: false },
  { id: 'opposite direction', status: 'ready', progressState: 'oppositeDirection', expectedValue: 10, expectedProgress: null, includeProjection: true },
  { id: 'partial with evidence', status: 'partial', progressState: 'ready', expectedValue: 10, expectedProgress: 0.25, includeProjection: true },
  { id: 'insufficient history', status: 'insufficientHistory', progressState: 'insufficientHistory', expectedValue: null, expectedProgress: null, includeProjection: false },
]
const readyStatuses = Object.fromEntries(['income', 'refunds', 'expenses', 'savingsDeposits', 'savingsWithdrawals', 'debtRepayments', 'newDebt'].map((metric) => [metric, 'ready']))
const readyProgressStates = Object.fromEntries(Object.keys(readyStatuses).map((metric) => [metric, 'ready']))
const readyProgress = Object.fromEntries(Object.keys(readyStatuses).map((metric) => [metric, 0.25]))

for (const definition of flowMetricDefinitions) {
  for (const contract of forecastContractCases) {
    test(`${definition.id} forecast preserves Task 8 ${contract.id} status and progress`, () => {
      const statusByMetric = { ...readyStatuses, [definition.metric]: contract.status }
      const progressState = { ...readyProgressStates, [definition.metric]: contract.progressState }
      const progress = { ...readyProgress, [definition.metric]: contract.expectedProgress }
      const result = build({
        entries: [entry({ id: 'historical-food', value: 1, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' })],
        mode: 'full',
        remainingActivity: {
          currentMonthKey: '2026-08',
          dailyProjectedEntries: contract.includeProjection ? [definition.projection] : [],
          statusByMetric,
          progressState,
          progress,
        },
      })
      const point = definition.point(result)

      assert.equal(point.status, contract.status)
      assert.equal(point.progressState, contract.progressState)
      assert.equal(point.progress, contract.expectedProgress)
      assert.equal(point.value, contract.expectedValue)
      if (definition.metric === 'refunds') assert.equal(pointFor(layerFor(result, 'category:food'), '2026-08:forecast').refundCoverage.projectedStatus, contract.status)
    })
  }
}

for (const definition of flowMetricDefinitions) {
  test(`${definition.id} partial forecast without projected evidence stays null`, () => {
    const result = build({
      entries: [entry({ id: 'historical-food', value: 1, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' })],
      mode: 'full',
      remainingActivity: {
        currentMonthKey: '2026-08',
        dailyProjectedEntries: [],
        statusByMetric: { ...readyStatuses, [definition.metric]: 'partial' },
        progressState: { ...readyProgressStates, [definition.metric]: 'ready' },
        progress: { ...readyProgress, [definition.metric]: 0.25 },
      },
    })

    assert.equal(definition.point(result).status, 'partial')
    assert.equal(definition.point(result).value, null)
    assert.equal(result.audit.status, 'unavailable')
  })
}

test('area geometry keeps historical fills solid and patterns only the final Forecast interval', () => {
  const paths = geometryFor({
    xValues: ['2026-06', '2026-07', '2026-08:forecast'],
    points: [
      { x: '2026-06', kind: 'actual', bottom: 0, top: 10 },
      { x: '2026-07', kind: 'actual', bottom: 0, top: 20 },
      { x: '2026-08:forecast', kind: 'forecast', bottom: 0, top: 30 },
    ],
    xAt: (index) => index * 100,
    yAt: (value) => value,
  })

  assert.equal(typeof AnalyticsCashUseUtils.buildCombinationAreaGeometry, 'function')
  assert.deepEqual(
    paths.map(({ forecast }) => forecast),
    [false, true],
  )
  assert.match(paths[0].d, /M 0 10 L 100 20/)
  assert.match(paths[1].d, /M 100 20 L 200 30/)
})

for (const [id, point] of [
  ['refund', { x: '2026-07', kind: 'actual', bottom: 10, top: 20, refundCoverage: { refunded: 10 } }],
  ['gap', { x: '2026-07', kind: 'actual', bottom: 15, top: 35, direction: 'positive' }],
]) {
  test(`${id} geometry gives an isolated single-month band finite width`, () => {
    const paths = geometryFor({
      xValues: ['2026-06', '2026-07', '2026-08:forecast'],
      points: [point],
      xAt: (index) => index * 100,
      yAt: (value) => value,
      isolatedWidth: 24,
    })

    assert.equal(paths.length, 1)
    assert.equal(paths[0].forecast, false)
    assert.match(paths[0].d, /M 88 20 L 112 20 L 112 10 L 88 10 Z|M 88 35 L 112 35 L 112 15 L 88 15 Z/)
  })
}

test('area geometry retains explicit zero points and does not bridge unavailable gaps', () => {
  const paths = geometryFor({
    xValues: ['2026-05', '2026-06', '2026-07', '2026-08:forecast'],
    points: [
      { x: '2026-05', kind: 'actual', bottom: 0, top: 5 },
      { x: '2026-06', kind: 'actual', bottom: 0, top: 0 },
      { x: '2026-07', kind: 'actual', bottom: null, top: null },
      { x: '2026-08:forecast', kind: 'forecast', bottom: 0, top: 8 },
    ],
    xAt: (index) => index * 100,
    yAt: (value) => value,
    isolatedWidth: 20,
  })

  assert.equal(paths.length, 2)
  assert.match(paths[0].d, /L 100 0/)
  assert.doesNotMatch(paths[0].d, /300/)
  assert.equal(paths[1].forecast, true)
  assert.match(paths[1].d, /M 290 8 L 310 8/)
})

test('combination target resolver gives areas their right-hand month while guides take precedence', () => {
  const targetFixture = {
    bounds: { left: 0, top: 0, width: 360, height: 240 },
    viewBox: { width: 360, height: 240 },
    padding: { left: 80, right: 80, top: 20, bottom: 20 },
    xValues: ['2026-05', '2026-06', '2026-07'],
    areas: [
      {
        seriesId: 'category:housing',
        points: ['2026-05', '2026-06', '2026-07'].map((x, index) => ({ x, bottom: 0, top: 40, kind: index === 2 ? 'forecast' : 'actual' })),
      },
    ],
    yAt: (value) => 160 - value,
  }
  const resolveTarget = ({ x, y, pointerType = 'mouse' }) => AnalyticsCashUseUtils.resolveCombinationChartTarget({ ...targetFixture, clientPoint: { x, y }, pointerType })

  assert.deepEqual(resolveTarget({ x: 130, y: 120 }), { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 1 })
  assert.deepEqual(resolveTarget({ x: 179, y: 120 }), { mode: 'month', seriesId: null, monthIndex: 1 })
  assert.deepEqual(resolveTarget({ x: 80, y: 120 }), { mode: 'month', seriesId: null, monthIndex: 0 })
  assert.deepEqual(resolveTarget({ x: 230, y: 120 }), { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 2 })
  assert.deepEqual(resolveTarget({ x: 158, y: 120, pointerType: 'touch' }), { mode: 'month', seriesId: null, monthIndex: 1 })
  assert.deepEqual(resolveTarget({ x: 157, y: 120, pointerType: 'touch' }), { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 1 })
})

test('combination target resolver selects the topmost painted boundary', () => {
  const input = {
    bounds: { left: 0, top: 0, width: 360, height: 240 },
    viewBox: { width: 360, height: 240 },
    padding: { left: 80, right: 80, top: 20, bottom: 20 },
    xValues: ['may', 'june', 'july'],
    areas: [
      { seriesId: 'lower', points: ['may', 'june', 'july'].map((x) => ({ x, bottom: 0, top: 40 })) },
      { seriesId: 'upper', points: ['may', 'june', 'july'].map((x) => ({ x, bottom: 40, top: 80 })) },
    ],
    yAt: (value) => 160 - value,
  }

  assert.deepEqual(AnalyticsCashUseUtils.resolveCombinationChartTarget({ ...input, clientPoint: { x: 130, y: 120 } }), { mode: 'seriesMonth', seriesId: 'upper', monthIndex: 1 })
})

test('Cash Use painted refund overlays resolve through the logical composite series', () => {
  const chart = readFileSync(new URL('../../components/charts/analytics-combination-chart.vue', import.meta.url), 'utf8')
  const target = AnalyticsCashUseUtils.resolveCombinationChartTarget({
    bounds: { left: 0, top: 0, width: 360, height: 240 },
    viewBox: { width: 360, height: 240 },
    padding: { left: 80, right: 80, top: 20, bottom: 20 },
    xValues: ['2026-06', '2026-07'],
    areas: [{ seriesId: 'refund-coverage', points: ['2026-06', '2026-07'].map((x) => ({ x, bottom: 0, top: 40, kind: 'actual' })) }],
    yAt: (value) => 160 - value,
    clientPoint: { x: 130, y: 120 },
  })
  const selected = interactionFor({ previewSelection: null, pinnedSelection: null, isDragging: false, pointerStart: null, effect: null }, { type: 'pointerDown', target })
  const pinned = interactionFor(selected, { type: 'pointerUp', target })

  assert.match(chart, /refundSeriesId: 'refund-coverage'/)
  assert.deepEqual(target, { mode: 'seriesMonth', seriesId: 'refund-coverage', monthIndex: 1 })
  assert.deepEqual(pinned.pinnedSelection, { mode: 'seriesMonth', seriesId: 'refund-coverage', monthIndex: 1 })
})

test('Cash Use painted refund overlays retain the logical composite descriptor', () => {
  const chart = readFileSync(new URL('../../components/charts/analytics-combination-chart.vue', import.meta.url), 'utf8')
  const legend = readFileSync(new URL('../../components/charts/analytics-cash-use-legend.vue', import.meta.url), 'utf8')
  const monthRow = readFileSync(new URL('../../components/charts/analytics-cash-use-month-row.vue', import.meta.url), 'utf8')
  const descriptor = { color: 'rebeccapurple', pattern: 'refund', patternVariant: 'dash', markerKind: 'area', legendOrdinal: 12 }
  const series = AnalyticsCashUseUtils.buildCashUseRefundCoverageSeries({ descriptor })

  assert.deepEqual(Object.fromEntries(['color', 'pattern', 'patternVariant', 'markerKind', 'legendOrdinal'].map((key) => [key, series[key]])), descriptor)
  assert.match(chart, /const refundCoverageDescriptor = computed/)
  assert.match(chart, /refundDescriptor: refundCoverageDescriptor\.value/)
  assert.match(chart, /:fill="paintUrl\(layer\.refundDescriptor\.pattern\)"/)
  assert.match(chart, /:style="\{ color: layer\.refundDescriptor\.color \}"/)
  assert.match(chart, /:data-pattern="layer\.refundDescriptor\.pattern"/)
  assert.match(chart, /:data-pattern-variant="layer\.refundDescriptor\.patternVariant"/)
  assert.match(chart, /:data-marker-kind="layer\.refundDescriptor\.markerKind"/)
  assert.match(chart, /:data-legend-ordinal="layer\.refundDescriptor\.legendOrdinal"/)
  assert.match(legend, /:data-pattern-variant="item\.patternVariant"/)
  assert.match(monthRow, /:data-pattern-variant="series\.patternVariant"/)
  assert.match(legend, /:aria-label="item\.ariaLabel \?\? item\.label"/)
  assert.match(monthRow, /:aria-label="series\.ariaLabel \?\? series\.label"/)
})

test('combination highlight geometry keeps the selected area and month band on one interval', () => {
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
  assert.equal(AnalyticsCashUseUtils.buildCombinationSelectedSegment({ points: [], xValues: [], monthIndex: 0, xAt: () => 0, yAt: () => 0 }), null)
  assert.equal(AnalyticsCashUseUtils.buildCombinationMonthBand({ monthIndex: 0, xAt: () => 0 }), null)
})

test('combination interaction separates legend previews from pinned selections', () => {
  const initial = { previewSelection: null, pinnedSelection: null, isDragging: false, pointerStart: null, effect: null }
  let state = interactionFor(initial, { type: 'legendPreview', seriesId: 'category:housing' })
  assert.deepEqual(AnalyticsCashUseUtils.displayCombinationSelection(state), { mode: 'series', seriesId: 'category:housing', monthIndex: -1 })

  state = interactionFor(state, { type: 'legendToggle', seriesId: 'category:housing' })
  assert.deepEqual(state.pinnedSelection, { mode: 'series', seriesId: 'category:housing', monthIndex: -1 })

  state = interactionFor(state, { type: 'pointerMove', target: { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 2 } })
  assert.equal(AnalyticsCashUseUtils.displayCombinationSelection(state).monthIndex, 2)

  state = interactionFor(state, { type: 'pointerLeave' })
  assert.deepEqual(AnalyticsCashUseUtils.displayCombinationSelection(state), state.pinnedSelection)
  assert.deepEqual(interactionFor(state, { type: 'legendToggle', seriesId: 'category:housing' }), { ...initial, effect: { type: 'clear' } })
})

test('combination interaction keeps a pinned legend series during keyboard month traversal', () => {
  const initial = { previewSelection: null, pinnedSelection: null, isDragging: false, pointerStart: null, effect: null }
  let state = interactionFor(initial, { type: 'legendToggle', seriesId: 'refund-coverage', pointCount: 3 })

  for (const [key, monthIndex] of [
    ['ArrowRight', 0],
    ['End', 2],
    ['Home', 0],
  ]) {
    state = interactionFor(state, { type: 'key', key, pointCount: 3 })
    assert.deepEqual(AnalyticsCashUseUtils.displayCombinationSelection(state), { mode: 'seriesMonth', seriesId: 'refund-coverage', monthIndex }, key)
    assert.deepEqual(state.pinnedSelection, { mode: 'series', seriesId: 'refund-coverage', monthIndex: -1 }, key)
  }
})

test('combination interaction repairs preview and pinned selections when the available series change', () => {
  const initial = {
    previewSelection: { mode: 'seriesMonth', seriesId: 'category:ten', monthIndex: 1 },
    pinnedSelection: { mode: 'series', seriesId: 'category:five', monthIndex: -1 },
    isDragging: true,
    pointerStart: { mode: 'seriesMonth', seriesId: 'category:ten', monthIndex: 1 },
    effect: null,
  }
  const previewRepaired = interactionFor(initial, { type: 'seriesRegistryChanged', seriesIds: ['category:five'], pointCount: 3 })

  assert.equal(previewRepaired.previewSelection, null)
  assert.deepEqual(previewRepaired.pinnedSelection, initial.pinnedSelection)
  assert.equal(previewRepaired.pointerStart, null)
  assert.equal(previewRepaired.isDragging, false)

  const pinRepaired = interactionFor(previewRepaired, { type: 'seriesRegistryChanged', seriesIds: ['category:one'], pointCount: 3 })
  assert.equal(pinRepaired.pinnedSelection, null)
  assert.deepEqual(pinRepaired.effect, { type: 'clear' })

  const monthSelection = { ...initial, previewSelection: null, pinnedSelection: { mode: 'month', seriesId: null, monthIndex: 2 }, isDragging: false, pointerStart: null }
  assert.deepEqual(interactionFor(monthSelection, { type: 'seriesRegistryChanged', seriesIds: [], pointCount: 3 }).pinnedSelection, monthSelection.pinnedSelection)
})

test('Cash Use refund coverage aggregates overlay values and exact actual evidence for selection', () => {
  const refundCoverage = AnalyticsCashUseUtils.buildCashUseRefundCoverageSeries({
    monthKeys: ['2026-06', '2026-07:forecast'],
    useLayers: [
      {
        id: 'category:food',
        points: [
          {
            x: '2026-06',
            xLabel: 'Jun 2026',
            kind: 'actual',
            top: 90,
            bottom: 40,
            transactionIds: ['food-purchase', 'food-unrelated'],
            refundCoverage: { totalRefunded: 20, purchaseTransactionIds: ['food-purchase'], refundTransactionIds: ['food-refund'], unavailableTransactionIds: [] },
          },
          {
            x: '2026-07:forecast',
            xLabel: 'Jul 2026',
            kind: 'forecast',
            top: 0,
            bottom: 0,
            transactionIds: [],
            projectedSources: [{ id: 'food-forecast' }, { id: 'food-forecast' }],
            refundCoverage: { totalRefunded: 0, purchaseTransactionIds: [], refundTransactionIds: [], unavailableTransactionIds: [], projectedSources: [{ id: 'food-refund-forecast' }] },
          },
        ],
      },
      {
        id: 'category:travel',
        points: [
          {
            x: '2026-06',
            xLabel: 'Jun 2026',
            kind: 'actual',
            top: 150,
            bottom: 90,
            transactionIds: ['travel-purchase', 'travel-unrelated'],
            refundCoverage: { totalRefunded: 5, purchaseTransactionIds: ['travel-purchase'], refundTransactionIds: ['travel-refund'], unavailableTransactionIds: [] },
          },
          {
            x: '2026-07:forecast',
            xLabel: 'Jul 2026',
            kind: 'forecast',
            top: 0,
            bottom: 0,
            transactionIds: [],
            projectedSources: [{ id: 'travel-forecast' }],
            refundCoverage: { totalRefunded: 0, purchaseTransactionIds: [], refundTransactionIds: [], unavailableTransactionIds: [], projectedSources: [{ id: 'travel-refund-forecast' }] },
          },
        ],
      },
    ],
    descriptor: { label: 'Refund coverage', color: 'pink', pattern: 'refund', markerKind: 'area' },
  })

  assert.deepEqual(refundCoverage.points[0], {
    x: '2026-06',
    xLabel: 'Jun 2026',
    kind: 'actual',
    value: 25,
    actualValue: 25,
    projectedValue: 0,
    transactionIds: ['food-purchase', 'food-refund', 'travel-purchase', 'travel-refund'],
    unavailableTransactionIds: [],
    projectedSources: [],
    status: 'ready',
  })
  assert.equal(refundCoverage.points[1].value, 0)
  assert.deepEqual(refundCoverage.points[1].transactionIds, [])
  assert.deepEqual(refundCoverage.points[1].projectedSources, [{ id: 'food-refund-forecast' }, { id: 'travel-refund-forecast' }])
  assert.equal(refundCoverage.segmentSeries.length, 2)
  assert.equal(refundCoverage.segmentSeries[0].points[0].bottom, 70)
  assert.equal(refundCoverage.segmentSeries[0].points[1].bottom, null)

  const partialRefundCoverage = AnalyticsCashUseUtils.buildCashUseRefundCoverageSeries({
    monthKeys: ['2026-08:forecast'],
    useLayers: [
      {
        id: 'category:food',
        points: [
          {
            x: '2026-08:forecast',
            xLabel: 'Aug 2026',
            kind: 'forecast',
            top: 100,
            bottom: 50,
            refundCoverage: {
              refunded: 5,
              totalRefunded: 9,
              purchaseTransactionIds: ['food-purchase'],
              refundTransactionIds: ['food-refund'],
              unavailableTransactionIds: [],
              projectedSources: [{ id: 'food-refund-forecast' }],
              projectedStatus: 'partial',
            },
          },
        ],
      },
    ],
  })

  assert.deepEqual(partialRefundCoverage.points[0], {
    x: '2026-08:forecast',
    xLabel: 'Aug 2026',
    kind: 'forecast',
    value: 9,
    actualValue: 5,
    projectedValue: 4,
    transactionIds: ['food-purchase', 'food-refund'],
    unavailableTransactionIds: [],
    projectedSources: [{ id: 'food-refund-forecast' }],
    status: 'partial',
  })
  assert.deepEqual(
    projectLineChartSelection({
      activation: 'pointer',
      transactionIds: partialRefundCoverage.points[0].transactionIds,
      kind: partialRefundCoverage.points[0].kind,
      route: '/transactions/list',
      toUrl: (ids) => `id=${ids.join(',')}`,
    }),
    { activation: 'pointer', transactionIds: ['food-purchase', 'food-refund'], route: '/transactions/list?id=food-purchase,food-refund', forecastOnly: false },
  )

  const unavailableRefundCoverage = AnalyticsCashUseUtils.buildCashUseRefundCoverageSeries({
    monthKeys: ['2026-08'],
    useLayers: [
      {
        id: 'category:food',
        points: [
          {
            x: '2026-08',
            xLabel: 'Aug 2026',
            kind: 'actual',
            transactionIds: ['food-purchase'],
            refundCoverage: { totalRefunded: 0, unavailableTransactionIds: ['missing-refund'] },
          },
        ],
      },
    ],
  })

  assert.equal(unavailableRefundCoverage.points[0].status, 'unavailable')
})

test('Cash Use selection descriptions expose month, value, status, and navigation eligibility', () => {
  const series = {
    id: 'refund-coverage',
    label: 'Refund coverage',
    points: [
      { x: '2026-06', xLabel: 'Jun 2026', kind: 'actual', value: 25, transactionIds: ['food-refund'] },
      { x: '2026-07:forecast', xLabel: 'Jul 2026', kind: 'forecast', value: null, transactionIds: [], status: 'unavailable', unavailableTransactionIds: ['future-refund'] },
    ],
  }

  assert.deepEqual(
    AnalyticsCashUseUtils.buildCombinationSelectionDescription({
      selection: { mode: 'series', seriesId: 'refund-coverage', monthIndex: -1 },
      series,
      valueFormatter: (value) => (Number.isFinite(value) ? `$${value}` : '—'),
    }),
    { label: 'Refund coverage', monthLabel: 'Jul 2026', valueLabel: '—', kind: 'forecast', status: 'unavailable', canNavigate: false, unavailableTransactionIds: ['future-refund'] },
  )
  assert.deepEqual(
    AnalyticsCashUseUtils.buildCombinationSelectionDescription({
      selection: { mode: 'seriesMonth', seriesId: 'refund-coverage', monthIndex: 0 },
      series,
      valueFormatter: (value) => (Number.isFinite(value) ? `$${value}` : '—'),
    }),
    { label: 'Refund coverage', monthLabel: 'Jun 2026', valueLabel: '$25', kind: 'actual', status: 'ready', canNavigate: true, unavailableTransactionIds: [] },
  )
  assert.equal(
    AnalyticsCashUseUtils.buildCombinationSelectionDescription({
      selection: { mode: 'seriesMonth', seriesId: 'refund-coverage', monthIndex: 1 },
      series: { ...series, points: [series.points[0], { ...series.points[1], transactionIds: ['unavailable-refund'] }] },
      valueFormatter: (value) => (Number.isFinite(value) ? `$${value}` : '—'),
    }).canNavigate,
    false,
  )
})

test('Cash Use projected qualifiers retain structured evidence without becoming navigation IDs', () => {
  const point = {
    kind: 'forecast',
    transactionIds: ['actual-purchase', 'actual-refund'],
    projectedSources: [
      {
        id: 'expected-refund-occurrence',
        sourceId: 'refund-source',
        candidateId: 'refund-candidate',
        evidenceIds: ['refund-evidence-1', 'refund-evidence-2'],
      },
      {
        id: 'expected-refund-occurrence-duplicate',
        sourceId: 'refund-source',
        candidateId: 'refund-candidate-2',
        evidenceIds: ['refund-evidence-2', 'refund-evidence-3'],
      },
    ],
  }

  assert.deepEqual(AnalyticsCashUseUtils.projectCashUseProjectedQualifiers(point), {
    sourceIds: ['refund-source'],
    candidateIds: ['refund-candidate', 'refund-candidate-2'],
    evidenceIds: ['refund-evidence-1', 'refund-evidence-2', 'refund-evidence-3'],
  })
  assert.deepEqual(
    projectLineChartSelection({
      activation: 'pointer',
      transactionIds: point.transactionIds,
      kind: point.kind,
      route: '/transactions/list',
      toUrl: (ids) => `id=${ids.join(',')}`,
    }),
    { activation: 'pointer', transactionIds: ['actual-purchase', 'actual-refund'], route: '/transactions/list?id=actual-purchase,actual-refund', forecastOnly: false },
  )

  const chart = readFileSync(new URL('../../components/charts/analytics-combination-chart.vue', import.meta.url), 'utf8')
  const monthRow = readFileSync(new URL('../../components/charts/analytics-cash-use-month-row.vue', import.meta.url), 'utf8')
  assert.match(chart, /\$\{description\.label\} · \$\{description\.monthLabel\}: \$\{description\.valueLabel\}/)
  assert.match(monthRow, /projectCashUseProjectedQualifiers/)
  assert.match(monthRow, /analytics\.daily_forecast\.source_id/)
  assert.match(monthRow, /analytics\.daily_forecast\.candidate_id/)
  assert.match(monthRow, /analytics\.daily_forecast\.evidence_ids/)
  assert.doesNotMatch(monthRow, /source\?\.id \?\? source\?\.candidateId \?\? source\?\.sourceId \?\? source\?\.evidenceId/)
})

test('combination interaction supports touch pins, month navigation, repair, dismissal, and row activation', () => {
  const initial = { previewSelection: null, pinnedSelection: null, isDragging: false, pointerStart: null, effect: null }
  const target = { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 2 }
  let state = interactionFor(initial, { type: 'pointerDown', target, pointerType: 'touch' })
  assert.deepEqual(state, { ...initial, previewSelection: target, isDragging: true, pointerStart: target })
  state = interactionFor(state, { type: 'pointerUp', target, pointerType: 'touch' })
  assert.deepEqual(state.pinnedSelection, target)
  assert.equal(state.effect.type, 'select')

  state = interactionFor(initial, { type: 'key', key: 'Home', pointCount: 3 })
  assert.deepEqual(AnalyticsCashUseUtils.displayCombinationSelection(state), { mode: 'month', seriesId: null, monthIndex: 0 })
  state = interactionFor(state, { type: 'key', key: 'End', pointCount: 3 })
  assert.equal(AnalyticsCashUseUtils.displayCombinationSelection(state).monthIndex, 2)
  state = interactionFor(state, { type: 'key', key: 'ArrowLeft', pointCount: 3 })
  assert.equal(AnalyticsCashUseUtils.displayCombinationSelection(state).monthIndex, 1)
  state = interactionFor(state, { type: 'key', key: 'ArrowRight', pointCount: 3 })
  assert.equal(AnalyticsCashUseUtils.displayCombinationSelection(state).monthIndex, 2)
  state = interactionFor(state, { type: 'key', key: 'Enter', pointCount: 3 })
  assert.deepEqual(state.pinnedSelection, { mode: 'month', seriesId: null, monthIndex: 2 })
  state = interactionFor(state, { type: 'pointCountChanged', pointCount: 2 })
  assert.deepEqual(state.pinnedSelection, { mode: 'month', seriesId: null, monthIndex: 1 })

  const item = { seriesId: 'category:housing', point: { transactionIds: ['housing-1'] } }
  assert.deepEqual(interactionFor(state, { type: 'rowSelect', item, activation: 'keyboard' }).effect, { type: 'selectRow', item, activation: 'keyboard' })
  assert.deepEqual(interactionFor(state, { type: 'outside' }), { ...initial, effect: { type: 'clear' } })
  assert.deepEqual(interactionFor(state, { type: 'key', key: 'Escape' }), { ...initial, effect: { type: 'clear' } })
})

test('combination interaction keeps the current chart selection reads synchronized with v2 state', () => {
  const chartState = {
    selectedIndex: -1,
    mode: null,
    selectedSeriesId: null,
    isPinned: false,
    isKeyboardSelection: false,
    isDragging: false,
    pointerStartedOnPinnedIndex: -1,
    pointerStartedOnPinnedSeriesId: null,
    effect: null,
  }
  const target = { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 1 }
  let state = interactionFor(chartState, { type: 'pointerMove', target, pointCount: 3 })
  assert.deepEqual(
    { selectedIndex: state.selectedIndex, mode: state.mode, selectedSeriesId: state.selectedSeriesId, isPinned: state.isPinned, isKeyboardSelection: state.isKeyboardSelection },
    { selectedIndex: 1, mode: 'area', selectedSeriesId: 'category:housing', isPinned: false, isKeyboardSelection: false },
  )

  state = interactionFor(state, { type: 'pointerDown', target, pointCount: 3 })
  state = interactionFor(state, { type: 'pointerUp', target, pointCount: 3 })
  assert.deepEqual(
    { selectedIndex: state.selectedIndex, mode: state.mode, selectedSeriesId: state.selectedSeriesId, isPinned: state.isPinned, effect: state.effect },
    { selectedIndex: 1, mode: 'area', selectedSeriesId: 'category:housing', isPinned: true, effect: { type: 'select' } },
  )

  state = interactionFor(state, { type: 'pointerDown', target, pointCount: 3 })
  state = interactionFor(state, { type: 'pointerUp', target, pointCount: 3 })
  assert.deepEqual(
    { selectedIndex: state.selectedIndex, mode: state.mode, selectedSeriesId: state.selectedSeriesId, isPinned: state.isPinned, effect: state.effect },
    { selectedIndex: -1, mode: null, selectedSeriesId: null, isPinned: false, effect: { type: 'clear' } },
  )

  state = interactionFor(chartState, { type: 'pointerMove', target, pointCount: 3 })
  assert.equal(interactionFor(state, { type: 'pointerLeave', pointCount: 3 }).selectedIndex, -1)
  assert.equal(interactionFor(state, { type: 'outside', pointCount: 3 }).mode, null)
  assert.equal(interactionFor(state, { type: 'key', key: 'Escape', pointCount: 3 }).selectedSeriesId, null)

  state = interactionFor(chartState, { type: 'key', key: 'ArrowRight', pointCount: 3 })
  assert.deepEqual(
    { selectedIndex: state.selectedIndex, mode: state.mode, selectedSeriesId: state.selectedSeriesId, isPinned: state.isPinned, isKeyboardSelection: state.isKeyboardSelection },
    { selectedIndex: 0, mode: 'month', selectedSeriesId: null, isPinned: false, isKeyboardSelection: true },
  )
  state = interactionFor(state, { type: 'key', key: 'Enter', pointCount: 3 })
  assert.equal(state.isPinned, true)
})

test('combination interaction keeps a legacy chart pin visible while v2 previews another target', () => {
  const chartState = {
    selectedIndex: -1,
    mode: null,
    selectedSeriesId: null,
    isPinned: false,
    isKeyboardSelection: false,
    isDragging: false,
    pointerStartedOnPinnedIndex: -1,
    pointerStartedOnPinnedSeriesId: null,
    effect: null,
  }
  const pinnedTarget = { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 1 }
  const previewTarget = { mode: 'month', seriesId: null, monthIndex: 2 }

  for (const pointerType of ['mouse', 'touch']) {
    let state = interactionFor(chartState, { type: 'pointerDown', target: pinnedTarget, pointerType, pointCount: 3 })
    state = interactionFor(state, { type: 'pointerUp', target: pinnedTarget, pointerType, pointCount: 3 })
    state = interactionFor(state, { type: 'pointerMove', target: previewTarget, pointerType, pointCount: 3 })

    assert.deepEqual(AnalyticsCashUseUtils.displayCombinationSelection(state), previewTarget)
    assert.deepEqual(
      { selectedIndex: state.selectedIndex, mode: state.mode, selectedSeriesId: state.selectedSeriesId, isPinned: state.isPinned, effect: state.effect },
      { selectedIndex: 1, mode: 'area', selectedSeriesId: 'category:housing', isPinned: true, effect: null },
      pointerType,
    )
    state = interactionFor(state, { type: 'pointerLeave', pointerType, pointCount: 3 })
    assert.deepEqual(
      { selectedIndex: state.selectedIndex, mode: state.mode, selectedSeriesId: state.selectedSeriesId, isPinned: state.isPinned, effect: state.effect },
      { selectedIndex: 1, mode: 'area', selectedSeriesId: 'category:housing', isPinned: true, effect: null },
      pointerType,
    )
  }
})

test('combination interaction clears stale drags when the point count becomes zero', () => {
  const chartState = {
    selectedIndex: -1,
    mode: null,
    selectedSeriesId: null,
    isPinned: false,
    isKeyboardSelection: false,
    isDragging: false,
    pointerStartedOnPinnedIndex: -1,
    pointerStartedOnPinnedSeriesId: null,
    effect: null,
  }
  const target = { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 1 }

  for (const pointerType of ['mouse', 'touch']) {
    let state = interactionFor(chartState, { type: 'pointerDown', target, pointerType, pointCount: 3 })
    state = interactionFor(state, { type: 'pointCountChanged', pointCount: 0 })
    assert.deepEqual(
      {
        previewSelection: state.previewSelection,
        pinnedSelection: state.pinnedSelection,
        isDragging: state.isDragging,
        pointerStart: state.pointerStart,
        effect: state.effect,
        selectedIndex: state.selectedIndex,
        mode: state.mode,
      },
      { previewSelection: null, pinnedSelection: null, isDragging: false, pointerStart: null, effect: null, selectedIndex: -1, mode: null },
      pointerType,
    )
    state = interactionFor(state, { type: 'pointerUp', target, pointerType, pointCount: 0 })
    assert.deepEqual(
      {
        previewSelection: state.previewSelection,
        pinnedSelection: state.pinnedSelection,
        isDragging: state.isDragging,
        pointerStart: state.pointerStart,
        effect: state.effect,
        selectedIndex: state.selectedIndex,
        mode: state.mode,
      },
      { previewSelection: null, pinnedSelection: null, isDragging: false, pointerStart: null, effect: null, selectedIndex: -1, mode: null },
      pointerType,
    )
  }
})

test('combination interaction accepts legacy chart month and area targets at the selection emission boundary', () => {
  const chartState = {
    selectedIndex: -1,
    mode: null,
    selectedSeriesId: null,
    isPinned: false,
    isKeyboardSelection: false,
    isDragging: false,
    pointerStartedOnPinnedIndex: -1,
    pointerStartedOnPinnedSeriesId: null,
    effect: null,
  }

  for (const { target, selection, legacy } of [
    { target: { mode: 'month', index: 1 }, selection: { mode: 'month', seriesId: null, monthIndex: 1 }, legacy: { selectedIndex: 1, mode: 'month', selectedSeriesId: null } },
    {
      target: { mode: 'area', index: 2, seriesId: 'category:housing' },
      selection: { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 2 },
      legacy: { selectedIndex: 2, mode: 'area', selectedSeriesId: 'category:housing' },
    },
  ]) {
    for (const pointerType of ['mouse', 'touch']) {
      let state = interactionFor(chartState, { type: 'pointerMove', target, pointerType, pointCount: 3 })
      assert.deepEqual(AnalyticsCashUseUtils.displayCombinationSelection(state), selection, `${pointerType}:${target.mode}:preview`)
      assert.deepEqual({ selectedIndex: state.selectedIndex, mode: state.mode, selectedSeriesId: state.selectedSeriesId }, legacy, `${pointerType}:${target.mode}:legacy preview`)
      state = interactionFor(state, { type: 'pointerDown', target, pointerType, pointCount: 3 })
      state = interactionFor(state, { type: 'pointerUp', target, pointerType, pointCount: 3 })
      assert.equal(state.selectedIndex >= 0 && state.effect?.type === 'select', true, `${pointerType}:${target.mode}:emittable`)
      assert.deepEqual({ selectedIndex: state.selectedIndex, mode: state.mode, selectedSeriesId: state.selectedSeriesId }, legacy, `${pointerType}:${target.mode}:legacy pin`)
    }
  }
})

test('combination interaction hydrates already-pinned legacy chart state before previews and repairs', () => {
  const legacyPinned = {
    selectedIndex: 1,
    mode: 'area',
    selectedSeriesId: 'category:housing',
    isPinned: true,
    isKeyboardSelection: false,
    isDragging: false,
    pointerStartedOnPinnedIndex: -1,
    pointerStartedOnPinnedSeriesId: null,
    effect: null,
  }
  const pin = { mode: 'seriesMonth', seriesId: 'category:housing', monthIndex: 1 }

  for (const pointerType of ['mouse', 'touch']) {
    let state = interactionFor(legacyPinned, { type: 'pointerMove', target: { mode: 'month', index: 2 }, pointerType, pointCount: 3 })
    assert.deepEqual(state.pinnedSelection, pin, pointerType)
    assert.deepEqual(AnalyticsCashUseUtils.displayCombinationSelection(state), { mode: 'month', seriesId: null, monthIndex: 2 }, pointerType)
    assert.deepEqual(
      { selectedIndex: state.selectedIndex, mode: state.mode, selectedSeriesId: state.selectedSeriesId, isPinned: state.isPinned, effect: state.effect },
      { selectedIndex: 1, mode: 'area', selectedSeriesId: 'category:housing', isPinned: true, effect: null },
      pointerType,
    )
    state = interactionFor(state, { type: 'pointerLeave', pointerType, pointCount: 3 })
    assert.deepEqual(AnalyticsCashUseUtils.displayCombinationSelection(state), pin, pointerType)
    state = interactionFor(state, { type: 'key', key: 'ArrowRight', pointCount: 3 })
    assert.equal(AnalyticsCashUseUtils.displayCombinationSelection(state).monthIndex, 2, pointerType)
    assert.equal(interactionFor(state, { type: 'key', key: 'Escape', pointCount: 3 }).effect?.type, 'clear', pointerType)
  }

  const cleared = interactionFor(legacyPinned, { type: 'pointCountChanged', pointCount: 0 })
  assert.deepEqual(
    {
      previewSelection: cleared.previewSelection,
      pinnedSelection: cleared.pinnedSelection,
      isDragging: cleared.isDragging,
      pointerStart: cleared.pointerStart,
      selectedIndex: cleared.selectedIndex,
      mode: cleared.mode,
      effect: cleared.effect,
    },
    { previewSelection: null, pinnedSelection: null, isDragging: false, pointerStart: null, selectedIndex: -1, mode: null, effect: null },
  )
})

test('combination chart and card wire accessible interaction targets and exact evidence navigation', () => {
  const chart = readFileSync(new URL('../../components/charts/analytics-combination-chart.vue', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../../components/analytics/analytics-cash-use.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../../assets/styles/theme-white.css', import.meta.url), 'utf8')

  assert.match(chart, /buildCombinationAreaGeometry/)
  assert.match(chart, /resolveCombinationChartTarget/)
  assert.match(chart, /reduceCombinationChartInteraction/)
  assert.match(chart, /applyInteraction/)
  assert.match(chart, /setPointerCapture/)
  assert.match(chart, /applyInteraction\(\{ type: 'pointerDown'/)
  assert.match(chart, /applyInteraction\(\{ type: 'pointerUp'/)
  assert.match(chart, /applyInteraction\(\{ type: 'key'/)
  assert.match(chart, /applyInteraction\(\{ type: 'rowSelect'/)
  assert.match(chart, /onClickOutside\(root, clearSelection\)/)
  assert.doesNotMatch(chart, /<rect v-for="\(key, index\) in xValues"/)
  assert.match(chart, /analytics-combination-area-label/)
  assert.match(chart, /analytics-combination-area-active/)
  assert.match(chart, /analytics-combination-area-dimmed/)
  assert.match(chart, /:key="selectedRow\.seriesId"/)
  assert.match(chart, /class="analytics-chart-tooltip-row"[\s\S]*minHeight: '44px'/)
  assert.match(chart, /refundCoverage\?\.totalRefunded \?\?[^\n]+> 0/)
  assert.match(chart, /v-if="\(selectedRow\.point\.refundCoverage\?\.totalRefunded \?\? selectedRow\.point\.refundCoverage\?\.refunded\) > 0"/)
  assert.match(chart, /valueFormatter\(selectedRow\.point\.refundCoverage\.totalRefunded \?\? selectedRow\.point\.refundCoverage\.refunded\)/)
  assert.doesNotMatch(card, /analyticsStore\.cashUseCategoryRankingItems/)
  assert.match(card, /RouteConstants\.ROUTE_TRANSACTION_LIST/)
  assert.match(card, /TransactionFilterUtils\.filters\.id\.toUrl/)
  assert.match(card, /projectLineChartSelection/)
  assert.match(card, /projectedUnavailableSummary/)
  assert.match(card, /:legend-items="legendItems"/)
  assert.match(card, /analytics\.cash_use\.chart_label/)
  assert.match(card, /refund-coverage/)
  assert.match(card, /gap-positive/)
  assert.match(card, /gap-negative/)
  assert.match(styles, /\.analytics-cash-use-legend\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow-x:\s*visible;/s)
  assert.match(styles, /@media \(max-width: 480px\)[\s\S]*\.analytics-cash-use-legend\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/)
  assert.doesNotMatch(card, /flatMap\(\(\{ metricIds, sourceIds, candidateIds, evidenceIds \}\)/)

  assert.deepEqual(
    projectLineChartSelection({ activation: 'pointer', transactionIds: ['actual-2', 'actual-1'], kind: 'forecast', route: '/transactions/list', toUrl: (ids) => `id=${ids.join(',')}` }),
    { activation: 'pointer', transactionIds: ['actual-2', 'actual-1'], route: '/transactions/list?id=actual-2,actual-1', forecastOnly: false },
  )
  assert.deepEqual(projectLineChartSelection({ activation: 'keyboard', transactionIds: [], kind: 'forecast', route: '/transactions/list' }), {
    activation: 'keyboard',
    transactionIds: [],
    route: null,
    forecastOnly: true,
  })

  for (const locale of ['de-DE', 'en', 'es-MX', 'fr', 'it', 'ko', 'pl', 'pt-BR', 'ro', 'ru-RU', 'zh-CN']) {
    const cashUse = JSON.parse(readFileSync(new URL(`../../i18n/locales/${locale}.json`, import.meta.url), 'utf8')).analytics.cash_use
    assert.equal(typeof cashUse.legend_label, 'string', `${locale}:legend_label`)
    assert.equal(typeof cashUse.area_label, 'string', `${locale}:area_label`)
  }
})

test('Cash Use legend debt and horizontal gradients use renderable color-stop grammar', () => {
  const styles = readFileSync(new URL('../../assets/styles/theme-white.css', import.meta.url), 'utf8')

  assert.doesNotMatch(styles, /var\(--legend-color\)\s+3px\s+4px\s+6px/)
  assert.match(styles, /data-pattern='debt'[\s\S]*transparent 0 3px, var\(--legend-color\) 3px 4px, transparent 4px 6px/)
  assert.match(styles, /data-pattern='category-horizontal'[\s\S]*transparent 0 3px, var\(--legend-color\) 3px 4px, transparent 4px 6px/)
})

test('Cash Use v2 series-month selection renders only its compact positioned callout', () => {
  const chart = readFileSync(new URL('../../components/charts/analytics-combination-chart.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../../assets/styles/theme-white.css', import.meta.url), 'utf8')

  assert.match(chart, /v-if="!legendItems\.length && selectionMode === 'area' && activeAreaLabel" class="analytics-combination-area-label"/)
  assert.match(chart, /v-if="legendItems\.length && displaySelection\.mode === 'seriesMonth'" class="analytics-combination-series-month-callout" :style="areaLabelPosition"/)
  assert.match(styles, /\.analytics-combination-series-month-callout\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*4;[^}]*pointer-events:\s*none;/s)
})

test('cash use consumes the page-level Savings view without rendering a duplicate control', () => {
  const page = readFileSync(new URL('../../pages/analytics.vue', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../../components/analytics/analytics-cash-use.vue', import.meta.url), 'utf8')

  assert.equal(page.match(/<analytics-savings-view-control\b/g)?.length ?? 0, 1)
  assert.doesNotMatch(card, /v-model="analyticsStore\.savingsView"/)
  assert.doesNotMatch(card, /const savingsItems = computed/)
})

test('analytics interaction inventory keeps every compact control at least 44px tall', () => {
  const css = readFileSync(new URL('../../assets/styles/theme-white.css', import.meta.url), 'utf8')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, declarations]) => ({
    selectors: selectors
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean),
    declarations,
  }))
  const targetHeight = (selector) => {
    const rule = rules.find((item) => item.selectors.includes(selector))
    const minHeight = rule?.declarations.match(/min-height:\s*(\d+)px/)?.[1]
    const height = rule?.declarations.match(/(?:^|\s)height:\s*(\d+)px/)?.[1]
    return Math.max(Number(minHeight ?? 0), Number(height ?? 0)) || null
  }
  const interactiveSelectors = [
    '.analytics-card .van-button',
    '.analytics-page .analytics-card .app-tabs-item',
    '.analytics-page .app-tabs.analytics-page-switch .app-tabs-item',
    '.analytics-page .analytics-savings-view-control .app-tabs-item',
    '.analytics-metric-facet-button',
    '.analytics-metric-facet-row',
    '.analytics-category-facet-button',
    '.analytics-category-facet-row',
    '.analytics-calculation-details summary',
    '.analytics-flow-month-button',
    '.analytics-flow-audit summary',
    '.analytics-flow-exact-values summary',
    '.analytics-flow-reallocation-row',
  ]

  assert.deepEqual(Object.fromEntries(interactiveSelectors.map((selector) => [selector, targetHeight(selector)])), Object.fromEntries(interactiveSelectors.map((selector) => [selector, 44])))
})

test('new analytics tablists expose distinct localized accessible names', () => {
  const cashUse = readFileSync(new URL('../../components/analytics/analytics-cash-use.vue', import.meta.url), 'utf8')
  const daily = readFileSync(new URL('../../components/analytics/analytics-daily-forecast.vue', import.meta.url), 'utf8')
  const pageSwitch = readFileSync(new URL('../../components/analytics/analytics-page-switch.vue', import.meta.url), 'utf8')
  const savings = readFileSync(new URL('../../components/analytics/analytics-savings-view-control.vue', import.meta.url), 'utf8')

  assert.match(cashUse, /v-model="analyticsStore\.cashUseMode"[^>]+aria-label="\$t\('analytics\.cash_use\.mode_label'\)"/)
  assert.match(cashUse, /v-model="analyticsStore\.balancePeriod"[^>]+aria-label="\$t\('analytics\.cash_use\.history_window_label'\)"/)
  assert.match(cashUse, /v-model="analyticsStore\.cashUseDetail"[^>]+aria-label="\$t\('analytics\.cash_use\.detail_label'\)"/)
  assert.match(daily, /v-model="analyticsStore\.dailyForecastMonths"[^>]+aria-label="\$t\('analytics\.daily_forecast\.history_window_label'\)"/)
  assert.match(pageSwitch, /aria-label="\$t\('analytics\.title'\)"/)
  assert.match(savings, /aria-labelledby="analytics-savings-view-label"/)

  const localeKeys = [
    ['cash_use', 'mode_label'],
    ['cash_use', 'history_window_label'],
    ['cash_use', 'detail_label'],
    ['daily_forecast', 'history_window_label'],
  ]
  for (const locale of ['de-DE', 'en', 'es-MX', 'fr', 'it', 'ko', 'pl', 'pt-BR', 'ro', 'ru-RU', 'zh-CN']) {
    const analytics = JSON.parse(readFileSync(new URL(`../../i18n/locales/${locale}.json`, import.meta.url), 'utf8')).analytics
    for (const [group, key] of localeKeys) assert.equal(typeof analytics[group][key], 'string', `${locale}: analytics.${group}.${key}`)
  }
})

test('combination chart scopes every SVG paint server to its component instance', () => {
  const chart = readFileSync(new URL('../../components/charts/analytics-combination-chart.vue', import.meta.url), 'utf8')
  const definitions = [...chart.matchAll(/<pattern\s+:id="paintId\('([^']+)'\)"/g)].map(([, name]) => name)
  const references = [...chart.matchAll(/paintUrl\('([^']+)'\)/g)].map(([, name]) => name)

  assert.match(chart, /import \{ nextTick, useId \} from 'vue'/)
  assert.match(chart, /const paintServerPrefix = `analytics-combination-\$\{/)
  assert.doesNotMatch(chart, /id="analytics-combination-/)
  assert.doesNotMatch(chart, /url\(#analytics-combination-/)
  assert.ok(references.every((name) => definitions.includes(name)))
  assert.match(chart, /paintUrl\(item\.pattern\)/)
  assert.equal(new Set(definitions).size, 10)
})

test('Cash Use chart source wires exact v2 legend, selected segment, and pinned month evidence contracts', () => {
  const chart = readFileSync(new URL('../../components/charts/analytics-combination-chart.vue', import.meta.url), 'utf8')
  const legend = readFileSync(new URL('../../components/charts/analytics-cash-use-legend.vue', import.meta.url), 'utf8')
  const monthRow = readFileSync(new URL('../../components/charts/analytics-cash-use-month-row.vue', import.meta.url), 'utf8')

  assert.match(legend, /<button[\s\S]*type="button"[\s\S]*analytics-cash-use-legend-item/)
  assert.match(legend, /class="analytics-cash-use-legend-item"/)
  assert.match(legend, /:data-pattern="item\.pattern"/)
  assert.match(legend, /:data-pattern-variant="item\.patternVariant"/)
  assert.match(legend, /:data-marker-kind="item\.markerKind"/)
  assert.match(legend, /:data-legend-ordinal="item\.legendOrdinal"/)
  assert.match(legend, /--legend-color': item\.color/)
  assert.match(legend, /@pointerenter="\$emit\('preview', item\.id\)"/)
  assert.match(legend, /@focus="\$emit\('preview', item\.id\)"/)
  assert.match(legend, /@click="\$emit\('toggle', item\.id\)"/)

  assert.match(chart, /legendItems: \{ type: Array, default: \(\) => \[\] \}/)
  assert.match(chart, /v-if="legendItems\.length"/)
  assert.match(chart, /@preview="onLegendPreview"/)
  assert.match(chart, /@leave="onLegendLeave"/)
  assert.match(chart, /@toggle="onLegendToggle"/)
  assert.match(chart, /buildCombinationMonthBand/)
  assert.match(chart, /buildCombinationSelectedSegment/)
  assert.match(chart, /analytics-combination-selected-month-band/)
  assert.match(chart, /analytics-combination-selected-segment/)
  assert.match(chart, /analytics-combination-area-active/)
  assert.match(chart, /analytics-combination-area-dimmed/)
  assert.match(chart, /analytics-combination-line-active/)
  assert.match(chart, /analytics-combination-line-dimmed/)
  assert.match(chart, /:data-pattern-variant="layer\.patternVariant"/)
  assert.match(chart, /v-if="pinnedSelection\?\.seriesId"/)
  assert.match(chart, /<analytics-cash-use-month-row/)
  assert.match(chart, /displaySelection\.mode === 'seriesMonth'/)
  assert.match(chart, /buildCombinationSelectionDescription/)
  assert.match(chart, /seriesRegistry\.value\.map\(\(\{ id \}\) => id\)[\s\S]*type: 'seriesRegistryChanged'/)
  assert.match(chart, /description\.status === 'ready' \? t\('analytics\.common\.exact_values'\) : null/)
  assert.match(chart, /description\.canNavigate \? t\('toolbar\.transactions'\) : null/)

  assert.match(monthRow, /const point = props\.series\.points\.find/)
  assert.match(
    monthRow,
    /const canNavigate = \(point\) => !\['unavailable', 'insufficientHistory'\]\.includes\(point\?\.status\) && Array\.isArray\(point\?\.transactionIds\) && point\.transactionIds\.length > 0/,
  )
  assert.match(monthRow, /:disabled="!cell\.canNavigate"/)
  assert.match(monthRow, /@click="\$emit\('activate', \{ point: cell\.point, activation: 'pointer' \}\)"/)
  assert.match(monthRow, /cell\.point\?\.kind === 'forecast'/)
  assert.match(monthRow, /analytics\.cash_use\.actual_to_date/)
  assert.match(monthRow, /analytics\.cash_use\.projected_remaining/)
  assert.match(monthRow, /analytics\.daily_forecast\.source_id/)
  assert.match(monthRow, /analytics\.daily_forecast\.candidate_id/)
  assert.match(monthRow, /analytics\.daily_forecast\.evidence_ids/)
  assert.match(monthRow, /projectCashUseProjectedQualifiers/)
})

test('Cash Use card uses one ordered Top 5, Top 10, or All projection across chart and interactive legend', () => {
  const card = readFileSync(new URL('../../components/analytics/analytics-cash-use.vue', import.meta.url), 'utf8')
  const detailSeries = [
    { detailLevel: 5, expected: ['category:category-1', 'category:category-2', 'category:category-3', 'category:category-4', 'category:category-5', 'category:other'] },
    {
      detailLevel: 10,
      expected: [
        'category:category-1',
        'category:category-2',
        'category:category-3',
        'category:category-4',
        'category:category-5',
        'category:category-6',
        'category:category-7',
        'category:category-8',
        'category:category-9',
        'category:category-10',
        'category:other',
      ],
    },
    {
      detailLevel: 'all',
      expected: [
        'category:category-1',
        'category:category-2',
        'category:category-3',
        'category:category-4',
        'category:category-5',
        'category:category-6',
        'category:category-7',
        'category:category-8',
        'category:category-9',
        'category:category-10',
        'category:category-11',
        'category:category-12',
      ],
    },
  ]

  for (const { detailLevel, expected } of detailSeries) {
    const series = build({ entries: rankedCategoryEntries(12), detailLevel })
    assert.deepEqual(
      series.useLayers.map(({ id }) => id),
      expected,
      String(detailLevel),
    )
  }

  assert.doesNotMatch(card, /analytics-category-facet/)
  assert.doesNotMatch(card, /selectedCategoryIds/)
  assert.doesNotMatch(card, /facetItems/)
  assert.match(card, /buildCashUseVisualStyles/)
  assert.match(card, /:legend-items="legendItems"/)
  assert.match(card, /return \{ \.\.\.style, ariaLabel:/)
  assert.match(card, /\.\.\.visualStyle\(layer\.id, layer\.label\)/)
})
