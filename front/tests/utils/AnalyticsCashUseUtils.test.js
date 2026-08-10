import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as AnalyticsCashUseUtils from '../../utils/AnalyticsCashUseUtils.js'
import { projectLineChartSelection } from '../../utils/ChartUtils.js'

const { buildCashUseSeries } = AnalyticsCashUseUtils

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
      entry({ id: 'food', value: 80, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' }),
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
        projected({ id: 'future-food', categoryId: 'food', flowAmounts: { expenses: 40 } }),
        projected({ id: 'future-debt', flowAmounts: { debtRepayments: 15 } }),
        projected({ id: 'future-accessible', destinationKind: 'savingsAccessible', flowAmounts: { savingsDeposits: 20 } }),
        projected({ id: 'future-restricted', destinationKind: 'savingsRestricted', flowAmounts: { savingsDeposits: 10 } }),
      ],
    },
  })

  assert.deepEqual(series.useLayers.map(({ kind }) => kind), ['expenseCategory', 'debtRepaid', 'savingsAccessibleDeposit', 'savingsRestrictedDeposit'])
  assert.deepEqual(
    { value: pointFor(series.totalUses, '2026-06').value, transactionIds: pointFor(series.totalUses, '2026-06').transactionIds },
    { value: 185, transactionIds: ['accessible-in', 'accessible-out', 'food', 'loan-payment', 'restricted-in'] },
  )
  assert.deepEqual(pointFor(series.totalUses, '2026-08:forecast').projectedSources.map(({ id }) => id), ['future-food', 'future-debt', 'future-accessible', 'future-restricted'])
  assert.deepEqual(series.audit.reconciliation.find(({ monthKey }) => monthKey === '2026-06'), {
    monthKey: '2026-06',
    status: 'ok',
    grossExpense: 80,
    categoryTotal: 80,
    categoryDelta: 0,
    totalUses: 185,
    useLayerTotal: 185,
    useDelta: 0,
    totalSources: 0,
    sourceComponentTotal: 0,
    sourceDelta: 0,
    gap: -185,
    gapDelta: 0,
    delta: 0,
  })
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

test('combination target resolver distinguishes month corridors from interpolated filled areas', () => {
  assert.equal(typeof AnalyticsCashUseUtils.interpolateCombinationArea, 'function')
  assert.equal(typeof AnalyticsCashUseUtils.resolveCombinationChartTarget, 'function')
  const input = {
    bounds: { left: 100, top: 50, width: 800, height: 440 },
    viewBox: { width: 400, height: 220 },
    padding: { left: 40, right: 40, top: 20, bottom: 30 },
    xValues: ['2026-06', '2026-07', '2026-08'],
    areas: [
      {
        seriesId: 'expense:housing',
        points: [
          { x: '2026-06', bottom: 0, top: 100 },
          { x: '2026-07', bottom: 0, top: 100 },
          { x: '2026-08', bottom: 0, top: 100 },
        ],
      },
    ],
    yAt: (value) => 190 - value,
    pointerType: 'mouse',
  }

  assert.deepEqual(AnalyticsCashUseUtils.resolveCombinationChartTarget({ ...input, clientPoint: { x: 500, y: 250 } }), { mode: 'month', index: 1 })
  assert.deepEqual(AnalyticsCashUseUtils.resolveCombinationChartTarget({ ...input, clientPoint: { x: 340, y: 330 } }), {
    mode: 'area',
    index: 1,
    seriesId: 'expense:housing',
  })
  assert.equal(AnalyticsCashUseUtils.resolveCombinationChartTarget({ ...input, clientPoint: { x: 340, y: 80 } }), null)
  assert.deepEqual(
    AnalyticsCashUseUtils.interpolateCombinationArea({
      points: [
        { x: '2026-06', bottom: 0, top: 100 },
        { x: '2026-07', bottom: 20, top: 200 },
      ],
      xValues: ['2026-06', '2026-07'],
      position: 0.5,
    }),
    {
      bottom: 10,
      top: 150,
      point: null,
      leftPoint: { x: '2026-06', bottom: 0, top: 100 },
      rightPoint: { x: '2026-07', bottom: 20, top: 200 },
    },
  )
})

test('combination target resolver uses visual paint order for shared boundaries and keeps touch guides 44px wide', () => {
  const input = {
    bounds: { left: 0, top: 0, width: 400, height: 220 },
    viewBox: { width: 400, height: 220 },
    padding: { left: 40, right: 40, top: 20, bottom: 30 },
    xValues: ['one', 'two', 'three'],
    areas: [
      { seriesId: 'lower', points: ['one', 'two', 'three'].map((x) => ({ x, bottom: 0, top: 100 })) },
      { seriesId: 'upper', points: ['one', 'two', 'three'].map((x) => ({ x, bottom: 100, top: 200 })) },
      { seriesId: 'negative-gap', points: ['one', 'two', 'three'].map((x) => ({ x, bottom: -50, top: 0 })) },
    ],
    yAt: (value) => 190 - value,
  }

  assert.deepEqual(AnalyticsCashUseUtils.resolveCombinationChartTarget({ ...input, pointerType: 'mouse', clientPoint: { x: 120, y: 90 } }), {
    mode: 'area',
    index: 1,
    seriesId: 'upper',
  })
  assert.deepEqual(AnalyticsCashUseUtils.resolveCombinationChartTarget({ ...input, pointerType: 'mouse', clientPoint: { x: 120, y: 215 } }), {
    mode: 'area',
    index: 1,
    seriesId: 'negative-gap',
  })
  assert.deepEqual(AnalyticsCashUseUtils.resolveCombinationChartTarget({ ...input, pointerType: 'touch', clientPoint: { x: 179, y: 90 } }), { mode: 'month', index: 1 })
})

test('combination interaction controller pins a point and dismisses it completely on a second tap', () => {
  const initial = {
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
  let state = interactionFor(initial, { type: 'pointerDown', index: 1, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 1, mode: 'month', isDragging: true })
  state = interactionFor(state, { type: 'pointerUp', index: 1, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 1, mode: 'month', isPinned: true, effect: { type: 'select' } })
  state = interactionFor(state, { type: 'pointerDown', index: 1, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 1, mode: 'month', isDragging: true, pointerStartedOnPinnedIndex: 1 })
  state = interactionFor(state, { type: 'pointerUp', index: 1, pointCount: 3 })
  assert.deepEqual(state, { ...initial, effect: { type: 'clear' } })
})

test('combination interaction controller owns pointer, keyboard, outside, and row-selection transitions', () => {
  const initial = {
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
  let state = interactionFor(initial, { type: 'pointerMove', index: 2, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 2, mode: 'month' })
  state = interactionFor(state, { type: 'pointerLeave', pointCount: 3 })
  assert.deepEqual(state, initial)
  state = interactionFor(initial, { type: 'key', key: 'ArrowRight', pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 0, mode: 'month', isKeyboardSelection: true, effect: { type: 'select' } })
  state = interactionFor(state, { type: 'key', key: 'End', pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 2, mode: 'month', isKeyboardSelection: true, effect: { type: 'select' } })
  state = interactionFor(state, { type: 'key', key: 'Enter', pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 2, mode: 'month', isPinned: true, isKeyboardSelection: true, effect: { type: 'select' } })
  const item = { seriesId: 'category:food', point: { transactionIds: ['actual-food'] } }
  state = interactionFor(state, { type: 'rowSelect', item, activation: 'keyboard', pointCount: 3 })
  assert.deepEqual(state.effect, { type: 'selectRow', item, activation: 'keyboard' })
  state = interactionFor(state, { type: 'outside', pointCount: 3 })
  assert.deepEqual(state, { ...initial, effect: { type: 'clear' } })
})

test('combination interaction controller previews and pins area or month targets without mode leakage', () => {
  const initial = {
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
  const area = { mode: 'area', index: 0, seriesId: 'expense:housing' }
  let state = interactionFor(initial, { type: 'pointerMove', target: area, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 0, mode: 'area', selectedSeriesId: 'expense:housing' })
  state = interactionFor(state, { type: 'pointerDown', target: area, pointCount: 3 })
  state = interactionFor(state, { type: 'pointerUp', target: area, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 0, mode: 'area', selectedSeriesId: 'expense:housing', isPinned: true, effect: { type: 'select' } })
  assert.deepEqual(interactionFor(state, { type: 'pointerMove', target: { mode: 'month', index: 2 }, pointCount: 3 }), { ...state, effect: null })
  state = interactionFor(state, { type: 'pointerDown', target: area, pointCount: 3 })
  state = interactionFor(state, { type: 'pointerUp', target: area, pointCount: 3 })
  assert.deepEqual(state, { ...initial, effect: { type: 'clear' } })

  state = interactionFor(initial, { type: 'key', key: 'End', pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 2, mode: 'month', isKeyboardSelection: true, effect: { type: 'select' } })
})

test('combination interaction controller emits an explicit clear effect for every dismissal path', () => {
  const selected = {
    selectedIndex: 1,
    mode: 'month',
    selectedSeriesId: null,
    isPinned: true,
    isKeyboardSelection: true,
    isDragging: false,
    pointerStartedOnPinnedIndex: -1,
    pointerStartedOnPinnedSeriesId: null,
    effect: { type: 'select' },
  }
  const cleared = {
    selectedIndex: -1,
    mode: null,
    selectedSeriesId: null,
    isPinned: false,
    isKeyboardSelection: false,
    isDragging: false,
    pointerStartedOnPinnedIndex: -1,
    pointerStartedOnPinnedSeriesId: null,
    effect: { type: 'clear' },
  }

  assert.deepEqual(interactionFor(selected, { type: 'clear', pointCount: 3 }), cleared)
  assert.deepEqual(interactionFor(selected, { type: 'outside', pointCount: 3 }), cleared)
  assert.deepEqual(interactionFor(selected, { type: 'key', key: 'Escape', pointCount: 3 }), cleared)
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
  assert.match(card, /analyticsStore\.cashUseCategoryRankingItems/)
  assert.match(card, /RouteConstants\.ROUTE_TRANSACTION_LIST/)
  assert.match(card, /TransactionFilterUtils\.filters\.id\.toUrl/)
  assert.match(card, /projectLineChartSelection/)
  assert.match(card, /projectedUnavailableSummary/)
  assert.match(card, /analytics-cash-use-legend/)
  assert.match(card, /analytics\.cash_use\.legend_label/)
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

  assert.match(chart, /import \{ useId \} from 'vue'/)
  assert.match(chart, /const paintServerPrefix = `analytics-combination-\$\{/)
  assert.doesNotMatch(chart, /id="analytics-combination-/)
  assert.doesNotMatch(chart, /url\(#analytics-combination-/)
  assert.deepEqual([...new Set(references)].sort(), [...new Set(definitions)].sort())
  assert.equal(new Set(definitions).size, 7)
})
