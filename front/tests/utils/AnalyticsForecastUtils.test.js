import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRemainingActivityForecast, projectMetricForecast } from '../../utils/AnalyticsForecastUtils.js'
import { buildDefinedOccurrences, detectRecurringCandidates } from '../../utils/AnalyticsRecurringUtils.js'

const endpoint = (id, kind, includeNetWorth = !['revenue', 'expense'].includes(kind)) => ({ id, attributes: { name: id, include_net_worth: includeNetWorth } })

const entry = ({
  id,
  date,
  value = 100,
  direction = 'expense',
  sourceId = direction === 'income' ? 'employer' : 'checking',
  destinationId = direction === 'income' ? 'checking' : 'merchant',
  sourceKind = direction === 'income' ? 'revenue' : 'available',
  destinationKind = direction === 'income' ? 'available' : 'expense',
  categoryId = direction === 'income' ? 'salary' : 'general',
  description = direction === 'income' ? 'Salary' : 'Merchant',
  refund = false,
  missingCurrency = null,
}) => ({
  id,
  transactionId: id,
  journalId: `${id}-journal`,
  date,
  monthKey: date.slice(0, 7),
  day: Number(date.slice(-2)),
  value,
  sourceKind,
  destinationKind,
  sourceAccount: endpoint(sourceId, sourceKind, !['revenue', 'expense', 'savingsRestricted'].includes(sourceKind)),
  destinationAccount: endpoint(destinationId, destinationKind, !['revenue', 'expense', 'savingsRestricted'].includes(destinationKind)),
  categoryId,
  description,
  conversion: missingCurrency ? { mode: 'unavailable', sourceCurrency: missingCurrency, missingCurrency } : { mode: 'exact', sourceCurrency: 'USD' },
  refund: {
    isRefund: refund,
    signals: refund ? ['tag'] : [],
    linkedPurchaseTransactionId: null,
    linkedPurchaseMonthKey: null,
    coverageCategoryId: refund ? categoryId : null,
    coverageMonthKey: refund ? date.slice(0, 7) : null,
    coverageValue: refund && Number.isFinite(value) ? Math.abs(value) : null,
    isLinked: false,
  },
})

const ledger = (entries, { startMonth = '2026-02', endDate = '2026-08-10', missingCurrencies = [] } = {}) => ({
  entries,
  months: {},
  coverage: { startMonth, endDate },
  fx: {
    isEstimated: false,
    missingCurrencies,
    transactionIds: entries
      .filter(({ conversion }) => conversion?.missingCurrency)
      .map(({ transactionId }) => transactionId)
      .sort(),
  },
  audit: { unclassifiedValue: 0, transactionIds: [], unmatchedRefundLinkIds: [] },
})

const expensesForMonths = (months, value, day = 20, options = {}) =>
  months.map((month, index) => entry({ id: `${options.idPrefix ?? 'expense'}-${index + 1}`, date: `${month}-${String(day).padStart(2, '0')}`, value, ...options }))

test('excludes the unfinished current month from a six-completed-month historical mean', () => {
  const completed = expensesForMonths(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], 600)
  const current = entry({ id: 'current-large-expense', date: '2026-08-02', value: 9999 })

  const result = buildRemainingActivityForecast({ ledger: ledger([...completed, current]), candidates: [], historyMonths: 6, today: '2026-08-10', endDate: '2026-08-31' })

  assert.equal(result.historicalBaseline.expenses, 600)
  assert.equal(result.actualToDate.expenses, 9999)
})

test('keeps covered zero months in the completed-month sample', () => {
  const result = buildRemainingActivityForecast({
    ledger: ledger([entry({ id: 'only-february', date: '2026-02-20', value: 600 })]),
    candidates: [],
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.historicalBaseline.expenses, 100)
  assert.deepEqual(result.audit.history.months, ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'])
  assert.deepEqual(result.audit.history.samples.expenses, [600, 0, 0, 0, 0, 0])
})

test('does not invent completed-month zeros when fetch coverage ends before the selected window', () => {
  const result = buildRemainingActivityForecast({
    ledger: ledger([], { startMonth: '2026-02', endDate: '2026-06-15' }),
    candidates: [],
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.status, 'insufficientHistory')
  assert.equal(result.historicalBaseline.expenses, null)
  assert.equal(result.audit.history.coverage, 'partial')
})

test('projects an unpaid inferred rent after its usual weekend-shifted date', () => {
  const history = expensesForMonths(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], 2321, 1, {
    destinationId: 'landlord',
    categoryId: 'housing',
    description: 'Monthly rent',
    idPrefix: 'rent',
  }).map((item, index) => ({ ...item, date: ['2026-01-01', '2026-02-02', '2026-03-02', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'][index] }))
  const candidates = detectRecurringCandidates({ entries: history, startDate: '2026-01-01', endDate: '2026-08-03' }).candidates

  const result = buildRemainingActivityForecast({ ledger: ledger(history, { startMonth: '2026-01', endDate: '2026-08-03' }), candidates, historyMonths: 6, today: '2026-08-03', endDate: '2026-08-31' })
  const rent = result.dailyProjectedEntries.find(({ candidateId }) => candidateId === candidates[0].id)

  assert.equal(result.actualToDate.expenses, 0)
  assert.equal(result.remainingFromToday.expenses, 2321)
  assert.equal(result.final.expenses, 2321)
  assert.ok(rent.date > '2026-08-03')
  assert.equal(rent.sourceKind, 'inferred')
  assert.equal(rent.overdue, true)
})

test('does not duplicate rent already fulfilled in the current month', () => {
  const history = expensesForMonths(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], 2321, 1, {
    destinationId: 'landlord',
    categoryId: 'housing',
    description: 'Monthly rent',
    idPrefix: 'rent-paid',
  })
  const actual = entry({ id: 'august-rent', date: '2026-08-03', value: 2321, destinationId: 'landlord', categoryId: 'housing', description: 'Monthly rent' })
  const candidates = detectRecurringCandidates({ entries: history, startDate: '2026-01-01', endDate: '2026-08-03' }).candidates

  const result = buildRemainingActivityForecast({
    ledger: ledger([...history, actual], { startMonth: '2026-01', endDate: '2026-08-03' }),
    candidates,
    historyMonths: 6,
    today: '2026-08-03',
    endDate: '2026-08-31',
  })

  assert.equal(result.actualToDate.expenses, 2321)
  assert.equal(result.remainingFromToday.expenses, 0)
  assert.equal(result.final.expenses, 2321)
  assert.equal(
    result.dailyProjectedEntries.some(({ candidateId }) => candidateId === candidates[0].id),
    false,
  )
  assert.equal(result.audit.recurring.fulfilledExpectedIds.length, 1)
})

test('projects only the second occurrence of twice-monthly salary after the first is actual', () => {
  const historyDates = ['2026-02-13', '2026-02-27', '2026-03-16', '2026-03-31', '2026-04-15', '2026-04-30', '2026-05-15', '2026-05-29', '2026-06-15', '2026-06-30', '2026-07-15', '2026-07-31']
  const history = historyDates.map((date, index) => entry({ id: `salary-${index + 1}`, date, value: 3000, direction: 'income', sourceId: 'employer', categoryId: 'salary', description: 'Payroll' }))
  const actual = entry({ id: 'salary-august-first', date: '2026-08-14', value: 3000, direction: 'income', sourceId: 'employer', categoryId: 'salary', description: 'Payroll' })
  const candidates = detectRecurringCandidates({ entries: history, startDate: '2026-02-01', endDate: '2026-08-16' }).candidates

  const result = buildRemainingActivityForecast({
    ledger: ledger([...history, actual], { startMonth: '2026-02', endDate: '2026-08-16' }),
    candidates,
    historyMonths: 6,
    today: '2026-08-16',
    endDate: '2026-08-31',
  })
  const projectedSalary = result.dailyProjectedEntries.filter(({ candidateId }) => candidateId === candidates[0].id)

  assert.equal(result.actualToDate.income, 3000)
  assert.equal(result.remainingFromToday.income, 3000)
  assert.equal(result.final.income, 6000)
  assert.equal(projectedSalary.length, 1)
  assert.equal(projectedSalary[0].date, '2026-08-31')
})

test('removes recurring history before calculating the variable remainder', () => {
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  const rent = expensesForMonths(months, 100, 1, { destinationId: 'landlord', categoryId: 'housing', description: 'Rent', idPrefix: 'baseline-rent' })
  const variable = expensesForMonths(months, 20, 20, { destinationId: 'shop', categoryId: 'shopping', description: 'Variable purchase', idPrefix: 'variable' })
  const candidates = detectRecurringCandidates({ entries: rent, startDate: '2026-02-01', endDate: '2026-08-10' }).candidates

  const result = buildRemainingActivityForecast({ ledger: ledger([...rent, ...variable]), candidates, historyMonths: 6, today: '2026-08-10', endDate: '2026-08-31' })

  assert.equal(result.historicalBaseline.expenses, 120)
  assert.equal(result.remainingFromToday.expenses, 120)
  assert.equal(result.final.expenses, 120)
  assert.equal(result.audit.recurring.removedHistoryEntryIds.length, 6)
})

test('floors cumulative expense at actual and exposes above-average and empty states', () => {
  assert.deepEqual(projectMetricForecast({ metric: 'expenses', actual: 9000, historicalAverage: 7500, remainingActivity: -1200 }), {
    metric: 'expenses',
    actualToDate: 9000,
    historicalBaseline: 7500,
    final: 9000,
    remainingFromToday: 0,
    progress: 1,
    progressState: 'aboveHistoricalAverage',
    status: 'ready',
  })
  assert.equal(projectMetricForecast({ metric: 'expenses', actual: 0, historicalAverage: 0, remainingActivity: 0 }).progressState, 'noExpectedActivity')
})

test('shows signed progress only for matching nonzero directions', () => {
  const same = projectMetricForecast({ metric: 'savingsChange', actual: 1200, historicalAverage: 2500, remainingActivity: 1300 })
  const opposite = projectMetricForecast({ metric: 'debtChange', actual: 100, historicalAverage: 200, remainingActivity: -250 })
  const zero = projectMetricForecast({ metric: 'netWorthChange', actual: 100, historicalAverage: 100, remainingActivity: -100 })

  assert.equal(same.progress, 0.48)
  assert.equal(same.progressState, 'ready')
  assert.equal(opposite.progress, null)
  assert.equal(opposite.progressState, 'oppositeDirection')
  assert.equal(zero.progress, null)
  assert.equal(zero.progressState, 'notApplicable')
})

test('distributes variable activity over future days with an exact rounding residual', () => {
  const history = [
    entry({ id: 'may-variable', date: '2026-05-29', value: 10 }),
    entry({ id: 'june-variable', date: '2026-06-30', value: 10 }),
    entry({ id: 'july-variable', date: '2026-07-31', value: 10 }),
  ]

  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-28' }),
    candidates: [],
    historyMonths: 3,
    today: '2026-08-28',
    endDate: '2026-08-31',
  })
  const variable = result.dailyProjectedEntries.filter(({ sourceKind }) => sourceKind === 'variable')

  assert.deepEqual(
    variable.map(({ date }) => date),
    ['2026-08-29', '2026-08-30', '2026-08-31'],
  )
  assert.equal(
    variable.reduce((total, { amount }) => Number((total + amount).toFixed(2)), 0),
    result.remainingFromToday.expenses,
  )
  assert.equal(result.remainingFromToday.expenses, 10)
})

test('keeps missing-FX input unavailable instead of coercing it to zero', () => {
  const unavailable = entry({ id: 'missing-fx', date: '2026-08-02', value: null, missingCurrency: 'EUR' })

  const result = buildRemainingActivityForecast({
    ledger: ledger([unavailable], { startMonth: '2026-02', endDate: '2026-08-10', missingCurrencies: ['EUR'] }),
    candidates: [],
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.status, 'unavailable')
  assert.equal(result.actualToDate.expenses, null)
  assert.equal(result.final.expenses, null)
  assert.deepEqual(result.dailyProjectedEntries, [])
})

test('does not block the selected forecast window for unavailable FX outside that window', () => {
  const oldUnavailable = entry({ id: 'old-missing-fx', date: '2026-01-02', value: null, missingCurrency: 'EUR' })

  const result = buildRemainingActivityForecast({
    ledger: ledger([oldUnavailable], { startMonth: '2026-01', endDate: '2026-08-10', missingCurrencies: ['EUR'] }),
    candidates: [],
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.final.expenses, 0)
  assert.deepEqual(result.audit.missingCurrencies, [])
})

test('classifies current cash, savings, and liability movements without treating internal transfers as activity', () => {
  const current = [
    entry({ id: 'income', date: '2026-08-02', value: 1000, direction: 'income' }),
    entry({ id: 'refund', date: '2026-08-03', value: 100, sourceKind: 'expense', destinationKind: 'available', sourceId: 'merchant', destinationId: 'checking', refund: true }),
    entry({ id: 'expense', date: '2026-08-04', value: 500 }),
    entry({ id: 'save', date: '2026-08-05', value: 200, sourceKind: 'available', destinationKind: 'savingsAccessible', sourceId: 'checking', destinationId: 'hysa' }),
    entry({ id: 'withdraw', date: '2026-08-06', value: 50, sourceKind: 'savingsAccessible', destinationKind: 'available', sourceId: 'hysa', destinationId: 'checking' }),
    entry({ id: 'repay', date: '2026-08-07', value: 75, sourceKind: 'available', destinationKind: 'liability', sourceId: 'checking', destinationId: 'loan' }),
    entry({ id: 'borrow', date: '2026-08-08', value: 25, sourceKind: 'liability', destinationKind: 'available', sourceId: 'loan', destinationId: 'checking' }),
    entry({ id: 'internal', date: '2026-08-09', value: 999, sourceKind: 'available', destinationKind: 'available', sourceId: 'checking', destinationId: 'cash' }),
  ]

  const result = buildRemainingActivityForecast({ ledger: ledger(current), candidates: [], historyMonths: 6, today: '2026-08-10', endDate: '2026-08-31' })

  assert.deepEqual(
    Object.fromEntries(
      ['income', 'refunds', 'expenses', 'savingsDeposits', 'savingsWithdrawals', 'debtRepayments', 'newDebt', 'savingsChange', 'debtChange', 'netWorthChange', 'availableCashChange'].map((key) => [
        key,
        result.actualToDate[key],
      ]),
    ),
    {
      income: 1000,
      refunds: 100,
      expenses: 500,
      savingsDeposits: 200,
      savingsWithdrawals: 50,
      debtRepayments: 75,
      newDebt: 25,
      savingsChange: 150,
      debtChange: -50,
      netWorthChange: 600,
      availableCashChange: 400,
    },
  )
  assert.equal(result.actualTransactionIds.availableCashChange.includes('internal'), false)
})

test('returns partial for defined-only activity and insufficient history when no defensible source exists', () => {
  const defined = buildDefinedOccurrences({
    recurringTransactions: [
      {
        id: 'defined-rent',
        attributes: {
          active: true,
          type: 'withdrawal',
          first_date: '2026-08-05',
          repetitions: [{ type: 'monthly', moment: '5' }],
          transactions: [{ amount: '100', description: 'Rent', source_id: 'checking', destination_id: 'landlord', category_id: 'housing' }],
        },
      },
    ],
    startDate: '2026-08-01',
    endDate: '2026-08-31',
  })
  const partial = buildRemainingActivityForecast({ ledger: ledger([], { startMonth: null, endDate: '2026-08-03' }), candidates: defined, historyMonths: 6, today: '2026-08-03', endDate: '2026-08-31' })
  const insufficient = buildRemainingActivityForecast({ ledger: ledger([], { startMonth: null, endDate: '2026-08-03' }), candidates: [], historyMonths: 6, today: '2026-08-03', endDate: '2026-08-31' })

  assert.equal(partial.status, 'partial')
  assert.equal(partial.historicalBaseline.expenses, null)
  assert.equal(partial.final.expenses, 100)
  assert.equal(insufficient.status, 'insufficientHistory')
  assert.equal(insufficient.final.expenses, null)
})

test('moves an overdue defined occurrence to the next forecast day without losing its source evidence', () => {
  const defined = buildDefinedOccurrences({
    recurringTransactions: [
      {
        id: 'overdue-rent',
        attributes: {
          active: true,
          type: 'withdrawal',
          first_date: '2026-08-01',
          repetitions: [{ type: 'monthly', moment: '1', occurrences: ['2026-08-01'] }],
          transactions: [{ amount: '100', description: 'Rent', source_id: 'checking', destination_id: 'landlord', category_id: 'housing' }],
        },
      },
    ],
    startDate: '2026-08-01',
    endDate: '2026-08-31',
  })

  const result = buildRemainingActivityForecast({ ledger: ledger([], { startMonth: null, endDate: '2026-08-03' }), candidates: defined, historyMonths: 6, today: '2026-08-03', endDate: '2026-08-31' })
  const projected = result.dailyProjectedEntries[0]

  assert.equal(projected.date, '2026-08-04')
  assert.equal(projected.overdue, true)
  assert.equal(projected.candidateId, defined[0].id)
  assert.equal(projected.sourceId, 'overdue-rent')
  assert.equal('transactionId' in projected, false)
  assert.equal('actualTransactionIds' in projected, false)
})

test('rounds projected occurrences before aggregation so daily rows exactly equal remaining totals', () => {
  const defined = buildDefinedOccurrences({
    recurringTransactions: [
      {
        id: 'fractional-rent',
        attributes: {
          active: true,
          type: 'withdrawal',
          first_date: '2026-08-20',
          repetitions: [{ type: 'monthly', moment: '20' }],
          transactions: [{ amount: '10.005', description: 'Fractional rent', source_id: 'checking', destination_id: 'landlord', category_id: 'housing' }],
        },
      },
    ],
    startDate: '2026-08-01',
    endDate: '2026-08-31',
  })

  const result = buildRemainingActivityForecast({ ledger: ledger([], { startMonth: null, endDate: '2026-08-10' }), candidates: defined, historyMonths: 6, today: '2026-08-10', endDate: '2026-08-31' })
  const dailyTotal = result.dailyProjectedEntries.reduce((total, item) => Number((total + item.amount).toFixed(2)), 0)

  assert.equal(dailyTotal, result.remainingFromToday.expenses)
})

test('returns byte-for-byte deterministic forecasts for shuffled input without mutating inputs', () => {
  const history = [
    ...expensesForMonths(['2026-05', '2026-06', '2026-07'], 10, 29, { destinationId: 'shop', categoryId: 'shopping', description: 'Shop', idPrefix: 'deterministic-variable' }),
    ...expensesForMonths(['2026-05', '2026-06', '2026-07'], 100, 1, { destinationId: 'landlord', categoryId: 'housing', description: 'Rent', idPrefix: 'deterministic-rent' }),
  ]
  const candidates = detectRecurringCandidates({ entries: history.filter(({ categoryId }) => categoryId === 'housing'), startDate: '2026-05-01', endDate: '2026-08-03' }).candidates
  const originalLedger = ledger(history, { startMonth: '2026-05', endDate: '2026-08-03' })
  const originalCandidates = structuredClone(candidates)
  const shuffledLedger = { ...originalLedger, entries: [history[5], history[0], history[3], history[2], history[4], history[1]] }

  const ordered = buildRemainingActivityForecast({ ledger: originalLedger, candidates, historyMonths: 3, today: '2026-08-03', endDate: '2026-08-31' })
  const shuffled = buildRemainingActivityForecast({ ledger: shuffledLedger, candidates: [...candidates].reverse(), historyMonths: 3, today: '2026-08-03', endDate: '2026-08-31' })

  assert.equal(JSON.stringify(shuffled), JSON.stringify(ordered))
  assert.deepEqual(originalLedger.entries, history)
  assert.deepEqual(candidates, originalCandidates)
  assert.ok(ordered.dailyProjectedEntries.every((item) => item.id && item.sourceId && Array.isArray(item.evidenceIds) && !('transactionId' in item)))
})
