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
    ['category:food', 'savings:accessible', 'savings:restricted', 'debt:repaid'],
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

test('detail ranking is completed-window-only, keeps explicit selections, groups Other last, and includes projected Uncategorized', () => {
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
    ['category:a', 'category:b', 'category:c', 'category:d', 'category:e', 'category:f', 'category:other'],
  )
  assert.equal(pointFor(layerFor(result, 'category:other'), '2026-06').value, 1)
  assert.deepEqual(pointFor(layerFor(result, 'category:other'), '2026-06').transactionIds, ['g-june'])
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

test('combination interaction controller pins a point and dismisses it completely on a second tap', () => {
  const initial = {
    selectedIndex: -1,
    isPinned: false,
    isKeyboardSelection: false,
    isDragging: false,
    pointerStartedOnPinnedIndex: -1,
    effect: null,
  }
  let state = interactionFor(initial, { type: 'pointerDown', index: 1, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 1, isDragging: true })
  state = interactionFor(state, { type: 'pointerUp', index: 1, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 1, isPinned: true, effect: { type: 'select' } })
  state = interactionFor(state, { type: 'pointerDown', index: 1, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 1, isDragging: true, pointerStartedOnPinnedIndex: 1 })
  state = interactionFor(state, { type: 'pointerUp', index: 1, pointCount: 3 })
  assert.deepEqual(state, initial)
})

test('combination interaction controller owns pointer, keyboard, outside, and row-selection transitions', () => {
  const initial = {
    selectedIndex: -1,
    isPinned: false,
    isKeyboardSelection: false,
    isDragging: false,
    pointerStartedOnPinnedIndex: -1,
    effect: null,
  }
  let state = interactionFor(initial, { type: 'pointerMove', index: 2, pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 2 })
  state = interactionFor(state, { type: 'pointerLeave', pointCount: 3 })
  assert.deepEqual(state, initial)
  state = interactionFor(initial, { type: 'key', key: 'ArrowRight', pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 0, isKeyboardSelection: true, effect: { type: 'select' } })
  state = interactionFor(state, { type: 'key', key: 'End', pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 2, isKeyboardSelection: true, effect: { type: 'select' } })
  state = interactionFor(state, { type: 'key', key: 'Enter', pointCount: 3 })
  assert.deepEqual(state, { ...initial, selectedIndex: 2, isPinned: true, isKeyboardSelection: true, effect: { type: 'select' } })
  const item = { seriesId: 'category:food', point: { transactionIds: ['actual-food'] } }
  state = interactionFor(state, { type: 'rowSelect', item, activation: 'keyboard', pointCount: 3 })
  assert.deepEqual(state.effect, { type: 'selectRow', item, activation: 'keyboard' })
  state = interactionFor(state, { type: 'outside', pointCount: 3 })
  assert.deepEqual(state, initial)
})

test('combination chart and card wire accessible interaction targets and exact evidence navigation', () => {
  const chart = readFileSync(new URL('../../components/charts/analytics-combination-chart.vue', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../../components/analytics/analytics-cash-use.vue', import.meta.url), 'utf8')

  assert.match(chart, /buildCombinationAreaGeometry/)
  assert.match(chart, /reduceCombinationChartInteraction/)
  assert.match(chart, /applyInteraction/)
  assert.match(chart, /setPointerCapture/)
  assert.match(chart, /applyInteraction\(\{ type: 'pointerDown'/)
  assert.match(chart, /applyInteraction\(\{ type: 'pointerUp'/)
  assert.match(chart, /applyInteraction\(\{ type: 'key'/)
  assert.match(chart, /applyInteraction\(\{ type: 'rowSelect'/)
  assert.match(chart, /onClickOutside\(root, clearSelection\)/)
  assert.match(chart, /:key="selectedRow\.seriesId"/)
  assert.match(chart, /class="analytics-chart-tooltip-row"[\s\S]*minHeight: '44px'/)
  assert.match(chart, /refundCoverage\?\.totalRefunded \?\?[^\n]+> 0/)
  assert.match(chart, /valueFormatter\(selectedRow\.point\.refundCoverage\.totalRefunded \?\? selectedRow\.point\.refundCoverage\.refunded\)/)
  assert.match(card, /analyticsStore\.cashUseCategoryRankingItems/)
  assert.match(card, /RouteConstants\.ROUTE_TRANSACTION_LIST/)
  assert.match(card, /TransactionFilterUtils\.filters\.id\.toUrl/)
  assert.match(card, /projectLineChartSelection/)
  assert.match(card, /projectedUnavailability/)

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
})
