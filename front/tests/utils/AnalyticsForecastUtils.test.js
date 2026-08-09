import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRemainingActivityForecast as buildForecastCore, projectMetricForecast as projectMetricForecastCore } from '../../utils/AnalyticsForecastUtils.js'
import { buildAnalyticsLedger } from '../../utils/AnalyticsLedgerUtils.js'
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

const ledger = (entries, { startMonth = '2026-02', endDate = '2026-08-10', missingCurrencies = [], fetchStartMonth = startMonth, fetchEndDate = endDate } = {}) => ({
  entries,
  months: {},
  coverage: { startMonth, endDate },
  fetchCoverage: fetchStartMonth && fetchEndDate ? { startMonth: fetchStartMonth, endDate: fetchEndDate } : null,
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

const buildRemainingActivityForecast = (options) =>
  buildForecastCore({
    currencyDecimalPlaces: 2,
    fetchCoverage: options.fetchCoverage === undefined ? options.ledger?.fetchCoverage : options.fetchCoverage,
    candidateAmounts: {},
    accountContexts: {},
    ...options,
  })

const projectMetricForecast = (options) => projectMetricForecastCore({ currencyDecimalPlaces: 2, ...options })

const accountContexts = {
  checking: { kind: 'available', includeNetWorth: true },
  cash: { kind: 'available', includeNetWorth: true },
  employer: { kind: 'revenue', includeNetWorth: false },
  landlord: { kind: 'expense', includeNetWorth: false },
  merchant: { kind: 'expense', includeNetWorth: false },
  hysa: { kind: 'savingsAccessible', includeNetWorth: true },
  retirement: { kind: 'savingsRestricted', includeNetWorth: false },
  loan: { kind: 'liability', includeNetWorth: true },
}

const normalizedCandidateInputs = (candidates, contexts = accountContexts) => ({
  candidateAmounts: Object.fromEntries(
    candidates.map((candidate) => [candidate.id, { value: candidate.expectedAmount.value, conversion: { mode: 'exact', sourceCurrency: 'USD', displayCurrency: 'USD', isEstimated: false } }]),
  ),
  accountContexts: contexts,
})

const definedCandidate = ({ id, sourceAccountId, destinationAccountId, direction = 'expense', date = '2026-08-20', amount = 100 }) => ({
  id: `defined:${id}`,
  signature: id,
  identity: { direction, sourceAccountId, sourceKind: null, destinationAccountId, destinationKind: null, categoryId: direction === 'expense' ? 'general' : 'salary', payee: id },
  identityVariants: [],
  direction,
  cadence: { type: 'monthly', days: [Number(date.slice(-2))] },
  expectedAmount: { value: amount, min: amount, max: amount },
  source: { type: 'recurringTransaction', id, authoritative: true },
  evidence: { entryIds: [], transactionIds: [], dates: [] },
  confidence: { score: 1, factors: { authoritative: true }, reasons: ['Authoritative Firefly schedule'] },
  matching: { dateWindowDays: 4, amountTolerance: 0.25, amountEnvelope: { min: amount, max: amount } },
  bounds: { start: '2026-08-01', end: null },
  expectedDates: [date],
})

const reorderSemanticValue = (value) => {
  if (Array.isArray(value)) return [...value].reverse().map(reorderSemanticValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reorderSemanticValue(item)]),
  )
}

const expensesForMonths = (months, value, day = 20, options = {}) =>
  months.map((month, index) => entry({ id: `${options.idPrefix ?? 'expense'}-${index + 1}`, date: `${month}-${String(day).padStart(2, '0')}`, value, ...options }))

const apiAccount = ({ id, type, role = null, includeNetWorth = !['revenue', 'expense'].includes(type) }) => ({
  id,
  attributes: { type: { fireflyCode: type }, account_role: role ? { fireflyCode: role } : null, include_net_worth: includeNetWorth },
})

const buildRealLedger = (transactions = []) => {
  const checking = apiAccount({ id: 'checking', type: 'asset' })
  const merchant = apiAccount({ id: 'merchant', type: 'expense' })
  return buildAnalyticsLedger({
    transactions: transactions.map(({ id, date, amount = 100 }) => ({
      id,
      attributes: {
        transactions: [
          {
            transaction_journal_id: `${id}-journal`,
            amount: String(amount),
            currency_code: 'USD',
            date,
            source_id: checking.id,
            destination_id: merchant.id,
            category_id: 'general',
            tags: [],
          },
        ],
      },
    })),
    transactionLinks: [],
    linkTypes: [],
    accounts: [checking, merchant],
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
  })
}

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

test('uses explicit fetch coverage rather than activity-derived ledger coverage for zero and missing samples', () => {
  const emptyActivityLedger = buildRealLedger()
  const activityLedger = buildRealLedger([
    { id: 'february-activity', date: '2026-02-20' },
    { id: 'july-activity', date: '2026-07-20' },
  ])
  assert.deepEqual(emptyActivityLedger.coverage, { startMonth: null, endDate: null })
  assert.deepEqual(activityLedger.coverage, { startMonth: '2026-02', endDate: '2026-07-20' })

  const coveredEmpty = buildForecastCore({
    ledger: emptyActivityLedger,
    candidates: [],
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })
  const missingCoverage = buildForecastCore({
    ledger: activityLedger,
    candidates: [],
    fetchCoverage: null,
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(coveredEmpty.status, 'ready')
  assert.deepEqual(coveredEmpty.audit.history.samples.expenses, [0, 0, 0, 0, 0, 0])
  assert.equal(missingCoverage.status, 'insufficientHistory')
  assert.equal(missingCoverage.historicalBaseline.expenses, null)
  assert.equal(missingCoverage.audit.history.samples, null)
  assert.equal(missingCoverage.audit.history.variableRemainderSamples, null)
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
  assert.equal(result.audit.history.samples, null)
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

test('removes the union of recurring entry and transaction evidence from historical remainder', () => {
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  const rent = expensesForMonths(months, 100, 20, { destinationId: 'landlord', categoryId: 'housing', description: 'Rent', idPrefix: 'mixed-rent' })
  const detected = detectRecurringCandidates({ entries: rent, startDate: '2026-02-01', endDate: '2026-08-10' }).candidates[0]
  const candidate = {
    ...detected,
    evidence: {
      ...detected.evidence,
      entryIds: rent.slice(0, 3).map(({ id }) => id),
      transactionIds: rent.slice(3).map(({ transactionId }) => transactionId),
    },
  }

  const result = buildRemainingActivityForecast({ ledger: ledger(rent), candidates: [candidate], historyMonths: 6, today: '2026-08-10', endDate: '2026-08-31' })

  assert.equal(result.remainingFromToday.expenses, 100)
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, rent.map(({ id }) => id).sort())
})

test('removes matching authoritative history from the variable remainder without inferred evidence', () => {
  const history = expensesForMonths(['2026-06', '2026-07'], 100, 20, { destinationId: 'landlord', categoryId: 'general', description: 'Rent', idPrefix: 'defined-history' })
  const candidate = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 100 })

  const result = buildRemainingActivityForecast({
    ledger: ledger(history),
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })
  const defined = result.dailyProjectedEntries.filter(({ sourceKind }) => sourceKind === 'defined')
  const variable = result.dailyProjectedEntries.filter(({ sourceKind }) => sourceKind === 'variable')

  assert.equal(result.remainingFromToday.expenses, 100)
  assert.equal(result.final.expenses, 100)
  assert.equal(defined.length, 1)
  assert.equal(defined[0].amount, 100)
  assert.deepEqual(variable, [])
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, history.map(({ id }) => id).sort())
  assert.equal(
    result.dailyProjectedEntries.some(({ candidateId }) => candidateId?.startsWith('inferred:')),
    false,
  )
  assert.equal(
    result.dailyProjectedEntries.some(({ evidenceIds }) => evidenceIds.some((id) => id.startsWith('inferred:'))),
    false,
  )
})

test('does not restore authoritative history to the variable remainder after the current occurrence is fulfilled', () => {
  const history = expensesForMonths(['2026-06', '2026-07'], 100, 20, { destinationId: 'landlord', categoryId: 'general', description: 'Rent', idPrefix: 'fulfilled-defined-history' })
  const actual = entry({ id: 'fulfilled-defined-current', date: '2026-08-20', value: 100, destinationId: 'landlord', categoryId: 'general', description: 'Rent' })
  const candidate = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 100 })

  const result = buildRemainingActivityForecast({
    ledger: ledger([...history, actual], { endDate: '2026-08-20' }),
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    historyMonths: 6,
    today: '2026-08-20',
    endDate: '2026-08-31',
  })

  assert.equal(result.actualToDate.expenses, 100)
  assert.equal(result.remainingFromToday.expenses, 0)
  assert.equal(result.final.expenses, 100)
  assert.deepEqual(result.dailyProjectedEntries, [])
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, history.map(({ id }) => id).sort())
  assert.deepEqual(result.audit.recurring.fulfilledExpectedIds, [`expected:${candidate.id}:2026-08-20`])
})

test('keeps unrelated same-payee activity in the variable baseline when removing authoritative history', () => {
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  const rent = expensesForMonths(months, 100, 20, { destinationId: 'landlord', categoryId: 'general', description: 'Rent', idPrefix: 'protected-rent' })
  const differentAmount = expensesForMonths(months, 20, 20, { destinationId: 'landlord', categoryId: 'general', description: 'Rent', idPrefix: 'same-payee-other-amount' })
  const differentAccount = expensesForMonths(months, 100, 20, { sourceId: 'cash', destinationId: 'landlord', categoryId: 'general', description: 'Rent', idPrefix: 'same-payee-other-account' })
  const candidate = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 100 })

  const result = buildRemainingActivityForecast({
    ledger: ledger([...rent, ...differentAmount, ...differentAccount]),
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })
  const variable = result.dailyProjectedEntries.filter(({ sourceKind }) => sourceKind === 'variable')

  assert.equal(result.remainingFromToday.expenses, 220)
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, rent.map(({ id }) => id).sort())
  assert.ok(variable.length > 0)
  assert.deepEqual(
    [...new Set(variable.flatMap(({ evidenceIds }) => evidenceIds))].sort(),
    [...differentAmount, ...differentAccount]
      .flatMap(({ id, transactionId }) => [id, transactionId])
      .filter((id, index, values) => values.indexOf(id) === index)
      .sort(),
  )
})

test('matches authoritative history by calendar-day distance across a daylight-saving transition', () => {
  const history = [entry({ id: 'dst-shifted-rent', date: '2026-11-01', value: 100, destinationId: 'landlord', categoryId: 'general', description: 'Rent' })]
  const candidate = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', date: '2026-12-05', amount: 100 })

  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-11', endDate: '2026-12-01' }),
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    historyMonths: 1,
    today: '2026-12-01',
    endDate: '2026-12-31',
  })

  assert.equal(result.remainingFromToday.expenses, 100)
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, ['dst-shifted-rent'])
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
  const zeroToNonzero = projectMetricForecast({ metric: 'savingsChange', actual: 0, historicalAverage: 500, remainingActivity: 500 })

  assert.equal(same.progress, 0.48)
  assert.equal(same.progressState, 'ready')
  assert.equal(opposite.progress, null)
  assert.equal(opposite.progressState, 'oppositeDirection')
  assert.equal(zero.progress, null)
  assert.equal(zero.progressState, 'notApplicable')
  assert.equal(zeroToNonzero.progress, null)
  assert.equal(zeroToNonzero.progressState, 'notApplicable')
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

test('uses explicit currency precision for projected amounts and exact residual units', () => {
  const recurring = definedCandidate({ id: 'precision-rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 10.556 })
  const cases = [
    { decimalPlaces: 0, expectedRecurring: 11, variableAmount: 10 },
    { decimalPlaces: 2, expectedRecurring: 10.56, variableAmount: 10 },
    { decimalPlaces: 3, expectedRecurring: 10.556, variableAmount: 1.001 },
  ]

  for (const { decimalPlaces, expectedRecurring, variableAmount } of cases) {
    const recurringResult = buildForecastCore({
      ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
      candidates: [recurring],
      candidateAmounts: {
        [recurring.id]: { value: 10.556, conversion: { mode: 'rate', sourceCurrency: 'EUR', displayCurrency: 'USD', rate: 1, isEstimated: true } },
      },
      accountContexts,
      fetchCoverage: null,
      currencyDecimalPlaces: decimalPlaces,
      historyMonths: 3,
      today: '2026-08-10',
      endDate: '2026-08-31',
    })
    assert.equal(recurringResult.dailyProjectedEntries[0].amount, expectedRecurring)
    assert.equal(recurringResult.remainingFromToday.expenses, expectedRecurring)
    assert.deepEqual(recurringResult.dailyProjectedEntries[0].conversion, {
      mode: 'rate',
      sourceCurrency: 'EUR',
      displayCurrency: 'USD',
      rate: 1,
      isEstimated: true,
    })

    const history = [
      entry({ id: `may-${decimalPlaces}`, date: '2026-05-29', value: variableAmount }),
      entry({ id: `june-${decimalPlaces}`, date: '2026-06-30', value: variableAmount }),
      entry({ id: `july-${decimalPlaces}`, date: '2026-07-31', value: variableAmount }),
    ]
    const variableResult = buildForecastCore({
      ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-28' }),
      candidates: [],
      fetchCoverage: { startMonth: '2026-05', endDate: '2026-08-28' },
      currencyDecimalPlaces: decimalPlaces,
      historyMonths: 3,
      today: '2026-08-28',
      endDate: '2026-08-31',
    })
    const scale = 10 ** decimalPlaces
    assert.equal(
      variableResult.dailyProjectedEntries.reduce((total, item) => total + Math.round(item.amount * scale), 0),
      Math.round(variableResult.remainingFromToday.expenses * scale),
    )
  }
})

test('labels zero-weight timing fallback as even and low confidence', () => {
  const history = [entry({ id: 'may-even', date: '2026-05-25', value: 9 }), entry({ id: 'june-even', date: '2026-06-25', value: 9 }), entry({ id: 'july-even', date: '2026-07-25', value: 9 })]

  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-10' }),
    candidates: [],
    historyMonths: 3,
    today: '2026-08-10',
    endDate: '2026-08-12',
  })
  const variable = result.dailyProjectedEntries.filter(({ sourceKind }) => sourceKind === 'variable')

  assert.deepEqual(
    variable.map(({ profile }) => profile),
    ['even', 'even'],
  )
  assert.ok(variable.every(({ confidence }) => confidence.level === 'low'))
  assert.ok(variable.every(({ reasons }) => reasons.includes('Even fallback because the timing profile is insufficient')))
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

  assert.equal(result.status, 'partial')
  assert.equal(result.actualToDate.expenses, null)
  assert.equal(result.final.expenses, null)
  assert.equal(result.final.income, 0)
  assert.equal(result.statusByMetric.expenses, 'unavailable')
  assert.equal(result.statusByMetric.income, 'ready')
  assert.deepEqual(result.audit.unavailable, {
    affectedMetricIds: ['expenses', 'netWorthChange', 'availableCashChange'],
    missingCurrencies: ['EUR'],
    entryIds: ['missing-fx'],
    candidateIds: [],
  })
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

test('stops current-month actual and FX evidence at today', () => {
  const actual = entry({ id: 'actual-expense', date: '2026-08-02', value: 50 })
  const futureUnavailable = entry({ id: 'future-missing-fx', date: '2026-08-20', value: null, missingCurrency: 'EUR' })

  const result = buildRemainingActivityForecast({
    ledger: ledger([actual, futureUnavailable], { startMonth: '2026-02', endDate: '2026-08-31', missingCurrencies: ['EUR'] }),
    candidates: [],
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-31' },
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.actualToDate.expenses, 50)
  assert.equal(result.final.expenses, 50)
  assert.deepEqual(result.audit.unavailable, { affectedMetricIds: [], missingCurrencies: [], entryIds: [], candidateIds: [] })
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

test('classifies authoritative account flows and net-worth boundaries from explicit account context', () => {
  const cases = [
    {
      candidate: definedCandidate({ id: 'save-accessible', sourceAccountId: 'checking', destinationAccountId: 'hysa' }),
      expected: { savingsDeposits: 100, savingsChange: 100, netWorthChange: 0, availableCashChange: -100 },
    },
    {
      candidate: definedCandidate({ id: 'withdraw-accessible', sourceAccountId: 'hysa', destinationAccountId: 'checking' }),
      expected: { savingsWithdrawals: 100, savingsChange: -100, netWorthChange: 0, availableCashChange: 100 },
    },
    {
      candidate: definedCandidate({ id: 'repay-loan', sourceAccountId: 'checking', destinationAccountId: 'loan' }),
      expected: { debtRepayments: 100, debtChange: -100, netWorthChange: 0, availableCashChange: -100 },
    },
    {
      candidate: definedCandidate({ id: 'borrow-loan', sourceAccountId: 'loan', destinationAccountId: 'checking' }),
      expected: { newDebt: 100, debtChange: 100, netWorthChange: 0, availableCashChange: 100 },
    },
    {
      candidate: definedCandidate({ id: 'save-restricted', sourceAccountId: 'checking', destinationAccountId: 'retirement' }),
      expected: { savingsDeposits: 100, savingsChange: 100, netWorthChange: -100, availableCashChange: -100 },
    },
    {
      candidate: definedCandidate({ id: 'ordinary-expense', sourceAccountId: 'checking', destinationAccountId: 'landlord' }),
      expected: { expenses: 100, netWorthChange: -100, availableCashChange: -100 },
    },
    {
      candidate: definedCandidate({ id: 'ordinary-income', sourceAccountId: 'employer', destinationAccountId: 'checking', direction: 'income' }),
      expected: { income: 100, netWorthChange: 100, availableCashChange: 100 },
    },
  ]

  for (const { candidate, expected } of cases) {
    const result = buildForecastCore({
      ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
      candidates: [candidate],
      candidateAmounts: {
        [candidate.id]: { value: 100, conversion: { mode: 'exact', sourceCurrency: 'USD', displayCurrency: 'USD', isEstimated: false } },
      },
      accountContexts,
      fetchCoverage: null,
      currencyDecimalPlaces: 2,
      historyMonths: 6,
      today: '2026-08-10',
      endDate: '2026-08-31',
    })
    for (const [metric, value] of Object.entries(expected)) assert.equal(result.remainingFromToday[metric], value, `${candidate.id} ${metric}`)
    assert.equal(result.audit.recurring.unresolvedCandidates.length, 0)
  }
})

test('uses normalized authoritative amount evidence and scopes missing candidate FX to affected metrics', () => {
  const candidate = definedCandidate({ id: 'foreign-rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 90 })
  const base = {
    ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
    candidates: [candidate],
    accountContexts,
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  }
  const converted = buildForecastCore({
    ...base,
    candidateAmounts: {
      [candidate.id]: { value: 100, conversion: { mode: 'rate', sourceCurrency: 'EUR', displayCurrency: 'USD', rate: 1.111111, isEstimated: true } },
    },
  })
  const unavailable = buildForecastCore({
    ...base,
    candidateAmounts: {
      [candidate.id]: { value: null, conversion: { mode: 'unavailable', sourceCurrency: 'EUR', displayCurrency: 'USD', missingCurrency: 'EUR' } },
    },
  })

  assert.equal(converted.remainingFromToday.expenses, 100)
  assert.equal(converted.dailyProjectedEntries[0].amount, 100)
  assert.equal(converted.dailyProjectedEntries[0].conversion.rate, 1.111111)
  assert.equal(unavailable.status, 'partial')
  assert.equal(unavailable.final.expenses, null)
  assert.equal(unavailable.final.income, 0)
  assert.deepEqual(unavailable.audit.unavailable, {
    affectedMetricIds: ['expenses', 'netWorthChange', 'availableCashChange'],
    missingCurrencies: ['EUR'],
    entryIds: [],
    candidateIds: [candidate.id],
  })
  assert.deepEqual(unavailable.audit.recurring.unresolvedCandidates, [
    {
      candidateId: candidate.id,
      sourceId: 'foreign-rent',
      reasons: ['unavailableAmount'],
      affectedMetricIds: ['expenses', 'netWorthChange', 'availableCashChange'],
      missingCurrencies: ['EUR'],
      missingAccountIds: [],
      missingAccountEndpoints: [],
    },
  ])
})

test('rejects finite candidate values with unavailable conversion evidence and audits conversion provenance deterministically', () => {
  const projected = definedCandidate({ id: 'audit-a-projected', sourceAccountId: 'checking', destinationAccountId: 'landlord' })
  const unavailableMode = definedCandidate({ id: 'audit-b-mode', sourceAccountId: 'checking', destinationAccountId: 'landlord' })
  const missingCurrency = definedCandidate({ id: 'audit-c-currency', sourceAccountId: 'checking', destinationAccountId: 'landlord' })
  const candidates = [projected, unavailableMode, missingCurrency]
  const candidateAmounts = {
    [projected.id]: { value: 100, conversion: { mode: 'rate', sourceCurrency: 'CAD', displayCurrency: 'USD', rate: 0.75, isEstimated: true } },
    [unavailableMode.id]: { value: 100, conversion: { mode: 'unavailable', sourceCurrency: 'GBP', displayCurrency: 'USD', isEstimated: false } },
    [missingCurrency.id]: { value: 100, conversion: { mode: 'rate', sourceCurrency: 'EUR', displayCurrency: 'USD', rate: 1.1, isEstimated: true, missingCurrency: 'EUR' } },
  }
  const build = (orderedCandidates) =>
    buildForecastCore({
      ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
      candidates: orderedCandidates,
      candidateAmounts,
      accountContexts,
      fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
      currencyDecimalPlaces: 2,
      historyMonths: 6,
      today: '2026-08-10',
      endDate: '2026-08-31',
    })
  const ordered = build(candidates)
  const shuffled = build([...candidates].reverse())

  assert.equal(ordered.dailyProjectedEntries.length, 1)
  assert.equal(ordered.dailyProjectedEntries[0].candidateId, projected.id)
  assert.equal(ordered.final.expenses, null)
  assert.deepEqual(ordered.audit.unavailable.candidateIds, [missingCurrency.id, unavailableMode.id].sort())
  assert.deepEqual(ordered.audit.recurring.candidateConversions, [
    {
      candidateId: projected.id,
      resolution: 'projected',
      mode: 'rate',
      sourceCurrency: 'CAD',
      displayCurrency: 'USD',
      rate: 0.75,
      isEstimated: true,
      missingCurrency: null,
    },
    {
      candidateId: unavailableMode.id,
      resolution: 'unresolved',
      mode: 'unavailable',
      sourceCurrency: 'GBP',
      displayCurrency: 'USD',
      isEstimated: false,
      missingCurrency: null,
    },
    {
      candidateId: missingCurrency.id,
      resolution: 'unresolved',
      mode: 'rate',
      sourceCurrency: 'EUR',
      displayCurrency: 'USD',
      rate: 1.1,
      isEstimated: true,
      missingCurrency: 'EUR',
    },
  ])
  assert.deepEqual(shuffled.audit.recurring.candidateConversions, ordered.audit.recurring.candidateConversions)
})

test('canonicalizes semantically equivalent duplicate candidate IDs before matching and projection', () => {
  const candidate = definedCandidate({ id: 'duplicate-equivalent', sourceAccountId: 'checking', destinationAccountId: 'landlord' })
  candidate.evidence = {
    entryIds: ['entry-b', 'entry-a'],
    transactionIds: ['transaction-b', 'transaction-a'],
    dates: ['2026-07-20', '2026-06-20'],
  }
  const duplicate = reorderSemanticValue(candidate)
  const options = {
    ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
    candidateAmounts: {
      [candidate.id]: { value: 100, conversion: { mode: 'exact', sourceCurrency: 'USD', displayCurrency: 'USD', isEstimated: false } },
    },
    accountContexts,
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  }
  const ordered = buildForecastCore({ ...options, candidates: [candidate, duplicate] })
  const reversed = buildForecastCore({ ...options, candidates: [duplicate, candidate] })

  assert.equal(ordered.remainingFromToday.expenses, 100)
  assert.equal(ordered.dailyProjectedEntries.length, 1)
  assert.deepEqual(ordered.audit.recurring.deduplicatedCandidateIds, [candidate.id])
  assert.deepEqual(ordered.audit.recurring.conflictingCandidateIds, [])
  assert.equal(JSON.stringify(reversed), JSON.stringify(ordered))
})

test('excludes conflicting duplicate candidate IDs without choosing an input-order winner', () => {
  const expense = definedCandidate({ id: 'duplicate-conflict', sourceAccountId: 'checking', destinationAccountId: 'landlord' })
  const income = definedCandidate({ id: 'duplicate-conflict', sourceAccountId: 'employer', destinationAccountId: 'checking', direction: 'income' })
  const options = {
    ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
    candidateAmounts: {
      [expense.id]: { value: 100, conversion: { mode: 'exact', sourceCurrency: 'USD', displayCurrency: 'USD', isEstimated: false } },
    },
    accountContexts,
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  }
  const expenseFirst = buildForecastCore({ ...options, candidates: [expense, income] })
  const incomeFirst = buildForecastCore({ ...options, candidates: [income, expense] })

  assert.equal(expenseFirst.status, 'partial')
  assert.deepEqual(expenseFirst.dailyProjectedEntries, [])
  assert.equal(expenseFirst.final.expenses, null)
  assert.equal(expenseFirst.final.income, null)
  assert.deepEqual(expenseFirst.audit.recurring.deduplicatedCandidateIds, [])
  assert.deepEqual(expenseFirst.audit.recurring.conflictingCandidateIds, [expense.id])
  assert.deepEqual(expenseFirst.audit.recurring.unresolvedCandidates, [
    {
      candidateId: expense.id,
      sourceId: null,
      reasons: ['duplicateCandidateId'],
      affectedMetricIds: [
        'income',
        'refunds',
        'expenses',
        'savingsDeposits',
        'savingsWithdrawals',
        'debtRepayments',
        'newDebt',
        'savingsChange',
        'debtChange',
        'netWorthChange',
        'availableCashChange',
      ],
      missingCurrencies: [],
      missingAccountIds: [],
      missingAccountEndpoints: [],
    },
  ])
  assert.equal(JSON.stringify(incomeFirst), JSON.stringify(expenseFirst))
})

test('requires usable authoritative conversion provenance before accepting a finite amount', () => {
  const candidate = definedCandidate({ id: 'conversion-contract', sourceAccountId: 'checking', destinationAccountId: 'landlord' })
  const invalidEvidence = [
    { value: 100 },
    { value: 100, conversion: { mode: 'unknown', sourceCurrency: 'USD', displayCurrency: 'USD', isEstimated: false } },
    { value: 100, conversion: { mode: 'exact', sourceCurrency: '', displayCurrency: 'USD', isEstimated: false } },
    { value: 100, conversion: { mode: 'exact', sourceCurrency: 'USD', displayCurrency: ' ', isEstimated: false } },
    { value: 100, conversion: { mode: 'rate', sourceCurrency: 'EUR', displayCurrency: 'USD', rate: 0, isEstimated: true } },
    { value: 100, conversion: { mode: 'rate', sourceCurrency: 'EUR', displayCurrency: 'USD', rate: 1.1, isEstimated: false } },
  ]
  const build = (amountEvidence) =>
    buildForecastCore({
      ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
      candidates: [candidate],
      candidateAmounts: { [candidate.id]: amountEvidence },
      accountContexts,
      fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
      currencyDecimalPlaces: 2,
      historyMonths: 6,
      today: '2026-08-10',
      endDate: '2026-08-31',
    })

  for (const evidence of invalidEvidence) {
    const result = build(evidence)
    assert.equal(result.status, 'partial')
    assert.equal(result.final.expenses, null)
    assert.deepEqual(result.dailyProjectedEntries, [])
    assert.deepEqual(result.audit.recurring.unresolvedCandidates[0].reasons, ['unavailableAmount'])
  }

  const exactPrimary = build({ value: 100, conversion: { mode: 'exactPrimary', sourceCurrency: 'USD', displayCurrency: 'USD', isEstimated: false } })
  assert.equal(exactPrimary.remainingFromToday.expenses, 100)
  assert.equal(exactPrimary.dailyProjectedEntries.length, 1)
})

test('keeps authoritative candidates with missing amount or account classification unresolved', () => {
  const missingAmount = definedCandidate({ id: 'missing-amount', sourceAccountId: 'checking', destinationAccountId: 'landlord' })
  const missingClassification = definedCandidate({ id: 'missing-classification', sourceAccountId: 'checking', destinationAccountId: 'unknown-account' })
  const base = {
    ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  }
  const amountResult = buildForecastCore({ ...base, candidates: [missingAmount], candidateAmounts: {}, accountContexts })
  const classificationResult = buildForecastCore({
    ...base,
    candidates: [missingClassification],
    candidateAmounts: {
      [missingClassification.id]: { value: 100, conversion: { mode: 'exact', sourceCurrency: 'USD', displayCurrency: 'USD' } },
    },
    accountContexts,
  })

  assert.equal(amountResult.status, 'partial')
  assert.equal(amountResult.final.expenses, null)
  assert.equal(amountResult.progressState.expenses, 'notApplicable')
  assert.deepEqual(amountResult.audit.recurring.unresolvedCandidates[0].reasons, ['missingAmountEvidence'])
  assert.equal(classificationResult.status, 'unavailable')
  assert.ok(Object.values(classificationResult.final).every((value) => value === null))
  assert.deepEqual(classificationResult.audit.recurring.unresolvedCandidates[0].reasons, ['missingAccountContext'])
  assert.deepEqual(classificationResult.audit.recurring.unresolvedCandidates[0].missingAccountIds, ['unknown-account'])
})

test('rejects authoritative embedded kinds when endpoint IDs are absent', () => {
  const candidate = definedCandidate({ id: 'missing-endpoints', sourceAccountId: '', destinationAccountId: '' })
  candidate.identity = { ...candidate.identity, sourceKind: 'available', destinationKind: 'expense' }

  const result = buildForecastCore({
    ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
    candidates: [candidate],
    candidateAmounts: {
      [candidate.id]: { value: 100, conversion: { mode: 'exact', sourceCurrency: 'USD', displayCurrency: 'USD', isEstimated: false } },
    },
    accountContexts,
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.dailyProjectedEntries, [])
  assert.deepEqual(result.audit.recurring.unresolvedCandidates[0].reasons, ['missingAccountContext'])
  assert.deepEqual(result.audit.recurring.unresolvedCandidates[0].missingAccountIds, [])
  assert.deepEqual(result.audit.recurring.unresolvedCandidates[0].missingAccountEndpoints, ['source', 'destination'])
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
  const partial = buildRemainingActivityForecast({
    ledger: ledger([], { startMonth: null, endDate: '2026-08-03', fetchStartMonth: null }),
    candidates: defined,
    ...normalizedCandidateInputs(defined),
    historyMonths: 6,
    today: '2026-08-03',
    endDate: '2026-08-31',
  })
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

  const result = buildRemainingActivityForecast({
    ledger: ledger([], { startMonth: null, endDate: '2026-08-03', fetchStartMonth: null }),
    candidates: defined,
    ...normalizedCandidateInputs(defined),
    historyMonths: 6,
    today: '2026-08-03',
    endDate: '2026-08-31',
  })
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

  const result = buildRemainingActivityForecast({
    ledger: ledger([], { startMonth: null, endDate: '2026-08-10', fetchStartMonth: null }),
    candidates: defined,
    ...normalizedCandidateInputs(defined),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })
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

test('exports the normalized actual-flow classifier used by daily projections', async () => {
  const module = await import('../../utils/AnalyticsForecastUtils.js')
  assert.equal(typeof module.classifyForecastFlowAmounts, 'function')
  const result = module.classifyForecastFlowAmounts({
    entry: {
      value: 25,
      direction: 'transfer',
      sourceKind: 'available',
      destinationKind: 'savingsAccessible',
      sourceAccount: { id: 'checking', attributes: { include_net_worth: true } },
      destinationAccount: { id: 'savings', attributes: { include_net_worth: true } },
    },
    currencyDecimalPlaces: 2,
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.amount, 25)
  assert.deepEqual(result.affectedMetricIds, ['savingsDeposits', 'savingsChange', 'availableCashChange'])
  assert.equal(result.flowAmounts.savingsDeposits, 25)
  assert.equal(result.flowAmounts.savingsWithdrawals, 0)
  assert.equal(result.flowAmounts.availableCashChange, -25)
})
