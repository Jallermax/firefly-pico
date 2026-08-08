import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCashUseSeries } from '../../utils/AnalyticsCashUseUtils.js'

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

const projected = ({ id, date = '2026-08-20', categoryId = null, flowAmounts, evidenceIds = [] }) => ({
  id,
  date,
  categoryId,
  sourceKind: 'defined',
  sourceId: `source:${id}`,
  candidateId: `candidate:${id}`,
  evidenceIds,
  flowAmounts,
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
  assert.equal(pointFor(result.totals, '2026-08:forecast').status, 'unavailable')
  assert.deepEqual(result.audit.unavailable.at(-1), { monthKey: '2026-08:forecast', transactionIds: [], projectedMetricIds: ['expenses'] })
})
