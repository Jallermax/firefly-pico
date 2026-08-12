import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRemainingActivityForecast as buildForecastCore, projectMetricForecast as projectMetricForecastCore, summarizeProjectedSources } from '../../utils/AnalyticsForecastUtils.js'
import { buildAnalyticsLedger } from '../../utils/AnalyticsLedgerUtils.js'
import { buildDefinedOccurrences, detectRecurringCandidates, mergeRecurringCandidates } from '../../utils/AnalyticsRecurringUtils.js'

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
  transactionId = id,
  tags = [],
}) => ({
  id,
  transactionId,
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
  tags,
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
  source: { type: 'recurringTransaction', id, label: `Readable ${id}`, authoritative: true },
  evidence: { entryIds: [], transactionIds: [], dates: [] },
  confidence: { score: 1, factors: { authoritative: true }, reasons: ['Authoritative Firefly schedule'] },
  matching: { dateWindowDays: 4, amountTolerance: 0.25, amountEnvelope: { min: amount, max: amount } },
  bounds: { start: '2026-08-01', end: null },
  expectedDates: [date],
})

const inferredSplitCandidate = ({ id, amount, categoryId, transactionIds }) => {
  const candidate = definedCandidate({ id, sourceAccountId: 'checking', destinationAccountId: 'tax-authority', date: '2026-08-15', amount })
  return {
    ...candidate,
    id: `inferred:${id}`,
    identity: { ...candidate.identity, categoryId, payee: 'payroll taxes' },
    source: { type: 'inferred', id: `inferred:${id}`, label: 'Payroll taxes', authoritative: false },
    evidence: { entryIds: [], transactionIds, dates: transactionIds.map((transactionId) => `${transactionId.slice(-7)}-15`) },
    confidence: { score: 0.9, factors: {}, reasons: ['Recurring split evidence'] },
  }
}

const payrollAmounts = {
  old: { salary: 3000, taxes: 600, insurance: 100, debt: 200, savings: 300, employerContribution: 150 },
  current: { salary: 3150, taxes: 630, insurance: 105, debt: 210, savings: 315, employerContribution: 157.5 },
}

const payrollOccurrence = ({ date, sequence, regime = 'old', reimbursement = false, omittedComponents = [], oneOff = false }) => {
  const transactionId = `payroll-${sequence}`
  const values = payrollAmounts[regime]
  const component = (name, options) => entry({ id: `${transactionId}-${name}`, transactionId, date, tags: ['paystub/payroll'], ...options })
  return [
    component('salary', { value: values.salary, direction: 'income', sourceId: 'employer', destinationId: 'checking', categoryId: 'salary', description: 'Base pay' }),
    component('taxes', { value: values.taxes, sourceId: 'checking', destinationId: 'tax-authority', categoryId: 'taxes', description: 'Payroll taxes' }),
    component('insurance', { value: values.insurance, sourceId: 'checking', destinationId: 'insurer', categoryId: 'insurance', description: 'Insurance deduction' }),
    component('debt', { value: values.debt, sourceKind: 'available', destinationKind: 'liability', sourceId: 'checking', destinationId: 'loan', categoryId: 'debt', description: 'Debt deduction' }),
    component('savings', {
      value: values.savings,
      sourceKind: 'available',
      destinationKind: 'savingsAccessible',
      sourceId: 'checking',
      destinationId: 'hysa',
      categoryId: 'savings',
      description: 'Savings deduction',
    }),
    component('employer-contribution', {
      value: values.employerContribution,
      direction: 'income',
      sourceKind: 'revenue',
      destinationKind: 'savingsRestricted',
      sourceId: 'employer',
      destinationId: 'retirement',
      categoryId: 'benefits',
      description: 'Employer contribution',
    }),
    component('internal-transfer', {
      value: 50,
      sourceKind: 'available',
      destinationKind: 'available',
      sourceId: 'checking',
      destinationId: 'cash',
      categoryId: 'internal',
      description: 'Internal allocation',
    }),
    ...(reimbursement
      ? [component('reimbursement', { value: 75, direction: 'income', sourceId: 'employer', destinationId: 'checking', categoryId: 'reimbursement', description: 'Expense reimbursement' })]
      : []),
    ...(oneOff ? [component('one-off', { value: 777, sourceId: 'checking', destinationId: 'specialist', categoryId: 'one-off', description: 'One-off adjustment' })] : []),
  ].filter(({ id }) => !omittedComponents.some((componentName) => id.endsWith(`-${componentName}`)))
}

const payrollHistory = ({ latestRegimes = ['current', 'current'] } = {}) => [
  ...payrollOccurrence({ date: '2026-05-15', sequence: 'may-mid' }),
  ...payrollOccurrence({ date: '2026-05-29', sequence: 'may-end', reimbursement: true }),
  ...payrollOccurrence({ date: '2026-06-15', sequence: 'june-mid' }),
  ...payrollOccurrence({ date: '2026-06-30', sequence: 'june-end', reimbursement: true }),
  ...payrollOccurrence({ date: '2026-07-15', sequence: 'july-mid', regime: latestRegimes[0] }),
  ...payrollOccurrence({ date: '2026-07-31', sequence: 'july-end', regime: latestRegimes[1], reimbursement: true }),
]

const payrollHistoryWithIdenticalPhases = () => [
  ...payrollOccurrence({ date: '2026-05-15', sequence: 'may-mid' }),
  ...payrollOccurrence({ date: '2026-05-29', sequence: 'may-end' }),
  ...payrollOccurrence({ date: '2026-06-15', sequence: 'june-mid' }),
  ...payrollOccurrence({ date: '2026-06-30', sequence: 'june-end' }),
  ...payrollOccurrence({ date: '2026-07-15', sequence: 'july-mid', regime: 'current' }),
  ...payrollOccurrence({ date: '2026-07-31', sequence: 'july-end', regime: 'current' }),
]

const payrollCandidates = (history) => detectRecurringCandidates({ entries: history, startDate: '2026-05-01', endDate: '2026-08-11' }).candidates

const reorderSemanticValue = (value) => {
  if (Array.isArray(value)) return [...value].reverse().map(reorderSemanticValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reorderSemanticValue(item)]),
  )
}

test('summarizes projected evidence by readable source and caps noisy variable audit IDs', () => {
  const summary = summarizeProjectedSources(
    [
      { id: 'rent-1', sourceKind: 'defined', sourceLabel: 'Rent', sourceId: 'rent', candidateId: 'defined:rent', amount: 500, evidenceIds: ['rent-a'] },
      { id: 'rent-2', sourceKind: 'defined', sourceLabel: 'Rent', sourceId: 'rent', candidateId: 'defined:rent', amount: 300, evidenceIds: ['rent-b'] },
      { id: 'variable-1', sourceKind: 'variable', sourceId: 'variable-1', amount: 10, evidenceIds: ['a', 'b', 'c'] },
      { id: 'variable-2', sourceKind: 'variable', sourceId: 'variable-2', amount: 20, evidenceIds: ['d', 'e', 'f'] },
    ],
    4,
  )

  assert.deepEqual(summary, [
    {
      id: 'defined:defined:rent',
      sourceKind: 'defined',
      sourceLabel: 'Rent',
      sourceId: 'rent',
      candidateId: 'defined:rent',
      amount: 800,
      overdue: false,
      reasons: [],
      confidence: null,
      conversion: null,
      evidenceIds: ['rent-a', 'rent-b'],
      evidenceOmittedCount: 0,
    },
    {
      id: 'variable:variable',
      sourceKind: 'variable',
      sourceLabel: null,
      sourceId: null,
      candidateId: null,
      amount: 30,
      overdue: false,
      reasons: [],
      confidence: null,
      conversion: null,
      evidenceIds: ['a', 'b', 'c', 'd'],
      evidenceOmittedCount: 2,
    },
  ])
})

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

const buildProductionRentLedger = (transactions) => {
  const checking = apiAccount({ id: 'checking', type: 'asset' })
  const landlord = apiAccount({ id: 'landlord', type: 'expense' })
  landlord.attributes.name = 'Landlord account'
  return buildAnalyticsLedger({
    transactions: transactions.map(({ id, date, amount = 100, categoryId = 'general' }) => ({
      id,
      attributes: {
        transactions: [
          {
            transaction_journal_id: `${id}-journal`,
            amount: String(amount),
            currency_code: 'USD',
            date,
            source_id: checking.id,
            destination_id: landlord.id,
            category_id: categoryId,
            tags: [],
          },
        ],
      },
    })),
    transactionLinks: [],
    linkTypes: [],
    accounts: [checking, landlord],
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
  assert.equal(rent.sourceLabel, candidates[0].source.label)
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

test('projects a semimonthly payroll bundle from the newest two-occurrence regime and keeps linked uses on payroll dates', () => {
  const history = payrollHistory()
  const candidates = payrollCandidates(history)
  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-11' }),
    candidates,
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })
  const bundle = result.audit.bundles[0]
  const projected = result.dailyProjectedEntries.filter(({ bundleId }) => bundleId === bundle.id)
  const onDate = (date, label) => projected.find((item) => item.date === date && item.bundleLabel === label)
  const flowTotals = projected.reduce((totals, item) => Object.fromEntries(Object.keys(totals).map((key) => [key, Number((totals[key] + item.flowAmounts[key]).toFixed(2))])), {
    income: 0,
    expenses: 0,
    debtRepayments: 0,
    savingsDeposits: 0,
    availableCashChange: 0,
  })

  assert.deepEqual([...new Set(projected.map(({ date }) => date))], ['2026-08-14', '2026-08-31'])
  assert.equal(onDate('2026-08-14', 'Base pay').amount, 3150)
  assert.equal(onDate('2026-08-31', 'Base pay').amount, 3150)
  assert.equal(onDate('2026-08-14', 'Payroll taxes').amount, 630)
  assert.equal(onDate('2026-08-31', 'Payroll taxes').amount, 630)
  assert.equal(onDate('2026-08-14', 'Insurance deduction').amount, 105)
  assert.equal(onDate('2026-08-31', 'Insurance deduction').amount, 105)
  assert.equal(onDate('2026-08-14', 'Expense reimbursement'), undefined)
  assert.equal(onDate('2026-08-31', 'Expense reimbursement').amount, 75)
  assert.equal(
    projected.some(({ bundleLabel }) => bundleLabel === 'Internal allocation'),
    false,
  )
  assert.deepEqual(flowTotals, { income: 6690, expenses: 1470, debtRepayments: 420, savingsDeposits: 945, availableCashChange: 3855 })
  assert.deepEqual(bundle.occurrenceDates, ['2026-05-15', '2026-05-29', '2026-06-15', '2026-06-30', '2026-07-15', '2026-07-31'])
  assert.deepEqual(bundle.selectedRegimeTransactionIds, ['payroll-july-end', 'payroll-july-mid'])
  assert.equal(bundle.confidence.level, 'high')
  assert.equal(bundle.regimePolicy, 'latestEquivalentPairAtLeastTwoPercent')
  assert.deepEqual(bundle.schedulePolicy, { type: 'semimonthly', middleDay: 15, monthEnd: true, weekendAdjustment: 'previousBusinessDay' })
  assert.equal(bundle.components.find(({ label }) => label === 'Internal allocation').reconciliationOnly, true)
  assert.ok(bundle.components.every(({ evidenceEntryIds }) => evidenceEntryIds.length >= 3))
  assert.ok(projected.every((item) => !('transactionId' in item) && !('actualTransactionIds' in item)))

  const historicalIds = new Set(history.flatMap(({ id, transactionId }) => [id, transactionId]))
  assert.ok(projected.every(({ evidenceIds }) => evidenceIds.every((id) => !historicalIds.has(id))))
  assert.equal(
    result.dailyProjectedEntries.some(({ bundleId, evidenceIds }) => !bundleId && evidenceIds.some((id) => historicalIds.has(id))),
    false,
  )
  const withoutCandidates = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-11' }),
    candidates: [],
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })
  assert.equal(
    withoutCandidates.dailyProjectedEntries.some(({ sourceKind, evidenceIds }) => sourceKind === 'variable' && evidenceIds.some((id) => historicalIds.has(id))),
    false,
  )
})

test('uses a recency-weighted median with medium confidence when only one payroll occurrence changes', () => {
  const history = payrollHistory({ latestRegimes: ['old', 'current'] })
  const candidates = payrollCandidates(history)
  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-11' }),
    candidates,
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })
  const bundle = result.audit.bundles[0]
  const projected = result.dailyProjectedEntries.filter(({ bundleId }) => bundleId === bundle.id)

  assert.equal(bundle.confidence.level, 'medium')
  assert.equal(bundle.regimePolicy, 'recencyWeightedMedian')
  assert.deepEqual(bundle.selectedRegimeTransactionIds, ['payroll-july-end', 'payroll-july-mid'])
  assert.deepEqual(
    projected.filter(({ bundleLabel }) => bundleLabel === 'Base pay').map(({ amount }) => amount),
    [3000, 3000],
  )
  assert.deepEqual(
    projected.filter(({ bundleLabel }) => bundleLabel === 'Payroll taxes').map(({ amount }) => amount),
    [600, 600],
  )
})

test('keeps recurring bundle projection and audit byte-identical under shuffled groups, entries, and candidates without mutating inputs', () => {
  const history = payrollHistory()
  const candidates = payrollCandidates(history)
  const groups = [...history.reduce((grouped, item) => grouped.set(item.transactionId, [...(grouped.get(item.transactionId) ?? []), item]), new Map()).values()]
  const shuffledHistory = groups.reverse().flatMap((group) => [...group].reverse())
  const originalHistory = structuredClone(history)
  const originalCandidates = structuredClone(candidates)

  const ordered = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-11' }),
    candidates,
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })
  const shuffled = buildRemainingActivityForecast({
    ledger: ledger(shuffledHistory, { startMonth: '2026-05', endDate: '2026-08-11' }),
    candidates: [...candidates].reverse(),
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })

  assert.equal(ordered.audit.bundles.length, 1)
  assert.equal(JSON.stringify(shuffled), JSON.stringify(ordered))
  assert.deepEqual(history, originalHistory)
  assert.deepEqual(candidates, originalCandidates)
})

test('suppresses an early fulfilled month-end payroll phase without projecting its salary or linked deductions again', () => {
  const history = payrollHistory()
  const actual = payrollOccurrence({ date: '2026-08-20', sequence: 'august-end-early', regime: 'current', reimbursement: true })
  const candidates = payrollCandidates(history)
  const result = buildRemainingActivityForecast({
    ledger: ledger([...history, ...actual], { startMonth: '2026-05', endDate: '2026-08-20' }),
    candidates,
    historyMonths: 3,
    today: '2026-08-20',
    endDate: '2026-08-31',
  })

  assert.deepEqual(
    result.dailyProjectedEntries.filter(({ bundleId }) => bundleId).map(({ bundleLabel }) => bundleLabel),
    [],
  )
  assert.equal(result.actualToDate.income, 3382.5)
  assert.equal(result.actualToDate.expenses, 735)
  assert.deepEqual(result.audit.bundles[0].projectedDates, [])
  assert.deepEqual(result.audit.bundles[0].fulfilledPhases, [
    {
      phase: 'monthEnd',
      entryIds: actual.map(({ id }) => id).sort(),
      transactionIds: ['payroll-august-end-early'],
    },
  ])
})

test('suppresses only a fulfilled middle payroll phase and keeps the unpaid month-end bundle projected', () => {
  const history = payrollHistory()
  const actual = payrollOccurrence({ date: '2026-08-13', sequence: 'august-mid-early', regime: 'current' })
  const candidates = payrollCandidates(history)
  const orderedLedger = ledger([...history, ...actual], { startMonth: '2026-05', endDate: '2026-08-13' })
  const originalEntries = structuredClone(orderedLedger.entries)
  const ordered = buildRemainingActivityForecast({ ledger: orderedLedger, candidates, historyMonths: 3, today: '2026-08-13', endDate: '2026-08-31' })
  const shuffled = buildRemainingActivityForecast({
    ledger: { ...orderedLedger, entries: [...orderedLedger.entries].reverse() },
    candidates: [...candidates].reverse(),
    historyMonths: 3,
    today: '2026-08-13',
    endDate: '2026-08-31',
  })
  const bundle = ordered.audit.bundles[0]
  const projected = ordered.dailyProjectedEntries.filter(({ bundleId }) => bundleId === bundle.id)

  assert.deepEqual([...new Set(projected.map(({ date }) => date))], ['2026-08-31'])
  assert.equal(projected.find(({ bundleLabel }) => bundleLabel === 'Base pay').amount, 3150)
  assert.equal(projected.find(({ bundleLabel }) => bundleLabel === 'Payroll taxes').amount, 630)
  assert.deepEqual(bundle.fulfilledPhases, [
    {
      phase: 'middle',
      entryIds: actual.map(({ id }) => id).sort(),
      transactionIds: ['payroll-august-mid-early'],
    },
  ])
  assert.equal(JSON.stringify(shuffled), JSON.stringify(ordered))
  assert.deepEqual(orderedLedger.entries, originalEntries)
  assert.deepEqual(candidates, payrollCandidates(history))
})

test('falls back when the latest payroll signatures differ and keeps inconsistent deductions available to variable modeling', () => {
  const history = [
    ...payrollOccurrence({ date: '2026-05-15', sequence: 'may-mid' }),
    ...payrollOccurrence({ date: '2026-05-29', sequence: 'may-end' }),
    ...payrollOccurrence({ date: '2026-06-15', sequence: 'june-mid' }),
    ...payrollOccurrence({ date: '2026-06-30', sequence: 'june-end' }),
    ...payrollOccurrence({ date: '2026-07-15', sequence: 'july-mid', regime: 'current' }),
    ...payrollOccurrence({ date: '2026-07-31', sequence: 'july-end', regime: 'current', omittedComponents: ['taxes'] }),
  ]
  const candidates = payrollCandidates(history)
  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-11' }),
    candidates,
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })
  const bundle = result.audit.bundles[0]
  const taxIds = history.filter(({ description }) => description === 'Payroll taxes').map(({ id }) => id)
  const projectedTaxes = result.dailyProjectedEntries.filter(({ bundleLabel }) => bundleLabel === 'Payroll taxes')
  const variableTaxEvidence = result.dailyProjectedEntries.filter(({ sourceKind, evidenceIds }) => sourceKind === 'variable' && evidenceIds.some((id) => taxIds.includes(id)))

  assert.equal(bundle.regimePolicy, 'recencyWeightedMedian')
  assert.equal(bundle.confidence.level, 'medium')
  assert.equal(
    bundle.components.some(({ label, phase }) => label === 'Payroll taxes' && phase === 'middle'),
    false,
  )
  assert.deepEqual(projectedTaxes, [])
  assert.ok(variableTaxEvidence.length > 0)
  assert.ok(taxIds.every((id) => !bundle.entryIds.includes(id)))
  assert.ok(taxIds.every((id) => !result.audit.recurring.removedHistoryEntryIds.includes(id)))
  assert.ok(bundle.inconsistentComponentKeys.length > 0)
})

test('keeps a one-off split outside bundle components, suppression audit, and variable-history removal', () => {
  const history = [
    ...payrollOccurrence({ date: '2026-05-15', sequence: 'may-mid', oneOff: true }),
    ...payrollOccurrence({ date: '2026-05-29', sequence: 'may-end' }),
    ...payrollOccurrence({ date: '2026-06-15', sequence: 'june-mid' }),
    ...payrollOccurrence({ date: '2026-06-30', sequence: 'june-end' }),
    ...payrollOccurrence({ date: '2026-07-15', sequence: 'july-mid', regime: 'current' }),
    ...payrollOccurrence({ date: '2026-07-31', sequence: 'july-end', regime: 'current' }),
  ]
  const oneOff = history.find(({ description }) => description === 'One-off adjustment')
  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-11' }),
    candidates: payrollCandidates(history),
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })
  const bundle = result.audit.bundles[0]

  assert.equal(
    bundle.components.some(({ label }) => label === 'One-off adjustment'),
    false,
  )
  assert.equal(bundle.entryIds.includes(oneOff.id), false)
  assert.equal(result.audit.recurring.removedHistoryEntryIds.includes(oneOff.id), false)
  assert.ok(result.dailyProjectedEntries.some(({ sourceKind, evidenceIds }) => sourceKind === 'variable' && evidenceIds.includes(oneOff.id)))
})

test('classifies a paid middle bundle from the complete phase schedule after its date has passed', () => {
  const history = payrollHistoryWithIdenticalPhases()
  const actual = payrollOccurrence({ date: '2026-08-14', sequence: 'august-middle', regime: 'current' })
  const input = ledger([...history, ...actual], { startMonth: '2026-05', endDate: '2026-08-20' })
  const original = structuredClone(input.entries)
  const ordered = buildRemainingActivityForecast({ ledger: input, candidates: [], historyMonths: 3, today: '2026-08-20', endDate: '2026-08-31' })
  const reversed = buildRemainingActivityForecast({ ledger: { ...input, entries: [...input.entries].reverse() }, candidates: [], historyMonths: 3, today: '2026-08-20', endDate: '2026-08-31' })
  const bundle = ordered.audit.bundles[0]

  assert.deepEqual(bundle.projectedDates, [{ date: '2026-08-31', phase: 'monthEnd' }])
  assert.deepEqual(bundle.fulfilledPhases, [
    {
      phase: 'middle',
      entryIds: actual.map(({ id }) => id).sort(),
      transactionIds: ['payroll-august-middle'],
    },
  ])
  assert.deepEqual([...new Set(ordered.dailyProjectedEntries.filter(({ bundleId }) => bundleId === bundle.id).map(({ date }) => date))], ['2026-08-31'])
  assert.equal(JSON.stringify(reversed), JSON.stringify(ordered))
  assert.deepEqual(input.entries, original)
})

test('uses phase-only evidence for an early month-end bundle and rejects identical signatures outside the phase window', () => {
  const phasedHistory = payrollHistory()
  const earlyMonthEnd = payrollOccurrence({ date: '2026-08-10', sequence: 'august-month-end-early', regime: 'current', reimbursement: true })
  const phased = buildRemainingActivityForecast({
    ledger: ledger([...phasedHistory, ...earlyMonthEnd], { startMonth: '2026-05', endDate: '2026-08-10' }),
    candidates: [],
    historyMonths: 3,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.deepEqual(phased.audit.bundles[0].projectedDates, [{ date: '2026-08-14', phase: 'middle' }])
  assert.deepEqual(
    phased.audit.bundles[0].fulfilledPhases.map(({ phase }) => phase),
    ['monthEnd'],
  )

  const identicalHistory = payrollHistoryWithIdenticalPhases()
  const outsideWindow = payrollOccurrence({ date: '2026-08-05', sequence: 'outside-phase-window', regime: 'current' })
  const outside = buildRemainingActivityForecast({
    ledger: ledger([...identicalHistory, ...outsideWindow], { startMonth: '2026-05', endDate: '2026-08-05' }),
    candidates: [],
    historyMonths: 3,
    today: '2026-08-05',
    endDate: '2026-08-31',
  })

  assert.deepEqual(outside.audit.bundles[0].fulfilledPhases, [])
  assert.deepEqual(outside.audit.bundles[0].projectedDates, [
    { date: '2026-08-14', phase: 'middle' },
    { date: '2026-08-31', phase: 'monthEnd' },
  ])
})

test('deduplicates exact stable ledger entry IDs without changing bundle output', () => {
  const history = payrollHistory()
  const baseInput = ledger(history, { startMonth: '2026-05', endDate: '2026-08-11' })
  const duplicateEntries = [...history, ...history.map((item) => structuredClone(item))]
  const duplicateInput = ledger(duplicateEntries, { startMonth: '2026-05', endDate: '2026-08-11' })
  const original = structuredClone(duplicateInput.entries)
  const base = buildRemainingActivityForecast({ ledger: baseInput, candidates: [], historyMonths: 3, today: '2026-08-11', endDate: '2026-08-31' })
  const duplicates = buildRemainingActivityForecast({ ledger: duplicateInput, candidates: [], historyMonths: 3, today: '2026-08-11', endDate: '2026-08-31' })

  assert.equal(base.audit.bundles.length, 1)
  assert.equal(JSON.stringify(duplicates), JSON.stringify(base))
  assert.deepEqual(duplicateInput.entries, original)
})

test('rejects conflicting rows with the same stable entry ID as deterministic typed unavailable evidence', () => {
  const history = payrollHistory()
  const originalSalary = history.find(({ id }) => id === 'payroll-may-mid-salary')
  const conflictingSalary = { ...structuredClone(originalSalary), value: originalSalary.value + 123 }
  const entries = [...history, conflictingSalary]
  const input = ledger(entries, { startMonth: '2026-05', endDate: '2026-08-11' })
  const ordered = buildRemainingActivityForecast({ ledger: input, candidates: [], historyMonths: 3, today: '2026-08-11', endDate: '2026-08-31' })
  const reversed = buildRemainingActivityForecast({ ledger: { ...input, entries: [...entries].reverse() }, candidates: [], historyMonths: 3, today: '2026-08-11', endDate: '2026-08-31' })

  assert.deepEqual(ordered.audit.unavailable.conflictingEntryIds, ['payroll-may-mid-salary'])
  assert.ok(ordered.audit.unavailable.entryIds.includes('payroll-may-mid-salary'))
  assert.ok(ordered.audit.unavailable.affectedMetricIds.includes('income'))
  assert.ok(ordered.audit.bundles.every(({ entryIds }) => !entryIds.includes('payroll-may-mid-salary')))
  assert.equal(JSON.stringify(reversed), JSON.stringify(ordered))
})

test('rejects transaction IDs reused across dates so they cannot inflate bundle occurrence evidence', () => {
  const uniqueHistory = payrollHistoryWithIdenticalPhases()
  const reusedHistory = uniqueHistory.map((item) => ({ ...item, transactionId: item.date.endsWith('-15') ? 'shared-middle' : 'shared-month-end' }))
  const input = ledger(reusedHistory, { startMonth: '2026-05', endDate: '2026-08-11' })
  const unique = buildRemainingActivityForecast({
    ledger: ledger(uniqueHistory, { startMonth: '2026-05', endDate: '2026-08-11' }),
    candidates: [],
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })
  const ordered = buildRemainingActivityForecast({ ledger: input, candidates: [], historyMonths: 3, today: '2026-08-11', endDate: '2026-08-31' })
  const reversed = buildRemainingActivityForecast({ ledger: { ...input, entries: [...reusedHistory].reverse() }, candidates: [], historyMonths: 3, today: '2026-08-11', endDate: '2026-08-31' })

  assert.equal(unique.audit.bundles.length, 1)
  assert.equal(new Set(unique.audit.bundles[0].transactionIds).size >= 3, true)
  assert.deepEqual(ordered.audit.bundles, [])
  assert.deepEqual(ordered.audit.recurring.conflictingTransactionIds, ['shared-middle', 'shared-month-end'])
  assert.equal(JSON.stringify(reversed), JSON.stringify(ordered))
})

test('keeps finite unavailable-conversion ledger values out of ready bundle projections', () => {
  const history = payrollHistoryWithIdenticalPhases().map((item) =>
    item.description === 'Base pay' ? { ...item, conversion: { mode: 'unavailable', sourceCurrency: 'EUR', displayCurrency: 'USD', missingCurrency: 'EUR' } } : item,
  )
  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { startMonth: '2026-05', endDate: '2026-08-11', missingCurrencies: ['EUR'] }),
    candidates: [],
    historyMonths: 3,
    today: '2026-08-11',
    endDate: '2026-08-31',
  })
  const unavailableSalaryIds = history.filter(({ description }) => description === 'Base pay').map(({ id }) => id)

  assert.deepEqual(result.audit.bundles, [])
  assert.deepEqual(
    result.dailyProjectedEntries.filter(({ bundleId }) => bundleId),
    [],
  )
  assert.deepEqual(result.audit.unavailable.missingCurrencies, ['EUR'])
  assert.ok(unavailableSalaryIds.every((id) => result.audit.unavailable.entryIds.includes(id)))
  assert.ok(result.audit.unavailable.affectedMetricIds.includes('income'))
  assert.notEqual(result.statusByMetric.income, 'ready')
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

test('removes production-ledger authoritative history when the definition description differs from the external account name', () => {
  const productionLedger = buildProductionRentLedger([
    { id: 'production-rent-june', date: '2026-06-20' },
    { id: 'production-rent-july', date: '2026-07-20' },
  ])
  const candidate = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 100 })

  const result = buildRemainingActivityForecast({
    ledger: productionLedger,
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(productionLedger.entries[0].description, undefined)
  assert.equal(productionLedger.entries[0].destinationAccount.attributes.name, 'Landlord account')
  assert.equal(result.remainingFromToday.expenses, 100)
  assert.equal(result.final.expenses, 100)
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, productionLedger.entries.map(({ id }) => id).sort())
})

test('does not forecast a fulfilled production-ledger occurrence again when definition and account labels differ', () => {
  const productionLedger = buildProductionRentLedger([
    { id: 'fulfilled-production-rent-june', date: '2026-06-20' },
    { id: 'fulfilled-production-rent-july', date: '2026-07-20' },
    { id: 'fulfilled-production-rent-august', date: '2026-08-20' },
  ])
  const candidate = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 100 })

  const result = buildRemainingActivityForecast({
    ledger: productionLedger,
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-20' },
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
  assert.deepEqual(
    result.audit.recurring.removedHistoryEntryIds,
    productionLedger.entries
      .filter(({ monthKey }) => monthKey !== '2026-08')
      .map(({ id }) => id)
      .sort(),
  )
})

test('removes uncategorized production-ledger authoritative history when definition and account labels differ', () => {
  const productionLedger = buildProductionRentLedger([
    { id: 'uncategorized-production-rent-june', date: '2026-06-20', categoryId: null },
    { id: 'uncategorized-production-rent-july', date: '2026-07-20', categoryId: null },
  ])
  const baseCandidate = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 100 })
  const candidate = { ...baseCandidate, identity: { ...baseCandidate.identity, categoryId: null } }

  const result = buildRemainingActivityForecast({
    ledger: productionLedger,
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(productionLedger.entries[0].categoryId, 'uncategorized')
  assert.equal(result.remainingFromToday.expenses, 100)
  assert.equal(result.final.expenses, 100)
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, productionLedger.entries.map(({ id }) => id).sort())
})

test('does not forecast a fulfilled uncategorized production-ledger occurrence again when labels differ', () => {
  const productionLedger = buildProductionRentLedger([
    { id: 'fulfilled-uncategorized-rent-june', date: '2026-06-20', categoryId: null },
    { id: 'fulfilled-uncategorized-rent-july', date: '2026-07-20', categoryId: null },
    { id: 'fulfilled-uncategorized-rent-august', date: '2026-08-20', categoryId: null },
  ])
  const baseCandidate = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 100 })
  const candidate = { ...baseCandidate, identity: { ...baseCandidate.identity, categoryId: null } }

  const result = buildRemainingActivityForecast({
    ledger: productionLedger,
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-20' },
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
  assert.deepEqual(
    result.audit.recurring.removedHistoryEntryIds,
    productionLedger.entries
      .filter(({ monthKey }) => monthKey !== '2026-08')
      .map(({ id }) => id)
      .sort(),
  )
})

test('keeps categorized production-ledger activity out of an uncategorized authoritative match', () => {
  const productionLedger = buildProductionRentLedger(
    ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'].map((month, index) => ({ id: `categorized-nonmatch-${index + 1}`, date: `${month}-20` })),
  )
  const baseCandidate = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 100 })
  const candidate = { ...baseCandidate, identity: { ...baseCandidate.identity, categoryId: null } }

  const result = buildRemainingActivityForecast({
    ledger: productionLedger,
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.remainingFromToday.expenses, 200)
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, [])
  assert.deepEqual(
    [...new Set(result.dailyProjectedEntries.filter(({ sourceKind }) => sourceKind === 'variable').flatMap(({ evidenceIds }) => evidenceIds))].sort(),
    productionLedger.entries.flatMap(({ id, transactionId }) => [id, transactionId]).sort(),
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

test('caps explicit and historical expense allocation at the completed-month category target', () => {
  const history = expensesForMonths(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], 7500)
  const actual = entry({ id: 'august-actual', date: '2026-08-05', value: 140 })
  const rent = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 2321 })

  const result = buildRemainingActivityForecast({
    ledger: ledger([...history, actual]),
    candidates: [rent],
    ...normalizedCandidateInputs([rent]),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.actualToDate.expenses, 140)
  assert.equal(result.historicalBaseline.expenses, 7500)
  assert.equal(result.final.expenses, 7500)
  assert.equal(result.remainingFromToday.expenses, 7360)
  assert.equal(
    result.dailyProjectedEntries.reduce((total, item) => Number((total + item.flowAmounts.expenses).toFixed(2)), 0),
    7360,
  )
  assert.deepEqual(result.audit.allocation.targetsByDimension, { 'category:general': 7500 })
  assert.equal(result.audit.allocation.cappedProjectionIds.length > 0, true)
})

test('lets unfulfilled explicit activity raise an above-average final without adding historical remainder', () => {
  const history = expensesForMonths(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], 7500)
  const actual = entry({ id: 'august-actual', date: '2026-08-05', value: 9000 })
  const rent = definedCandidate({ id: 'rent', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 1000 })

  const result = buildRemainingActivityForecast({
    ledger: ledger([...history, actual]),
    candidates: [rent],
    ...normalizedCandidateInputs([rent]),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.final.expenses, 10000)
  assert.equal(result.remainingFromToday.expenses, 1000)
  assert.deepEqual(
    result.dailyProjectedEntries.map(({ sourceKind, amount }) => ({ sourceKind, amount })),
    [{ sourceKind: 'defined', amount: 1000 }],
  )
  assert.equal(result.audit.allocation.targetsByDimension['category:general'], 10000)
})

test('expands a cumulative target only for explicit due activity and remains deterministic when shuffled', () => {
  const history = expensesForMonths(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], 7500)
  const actual = entry({ id: 'august-actual', date: '2026-08-05', value: 140 })
  const largeBill = definedCandidate({ id: 'large-bill', sourceAccountId: 'checking', destinationAccountId: 'landlord', amount: 8000 })
  const options = {
    candidates: [largeBill],
    ...normalizedCandidateInputs([largeBill]),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  }

  const ordered = buildRemainingActivityForecast({ ...options, ledger: ledger([...history, actual]) })
  const shuffled = buildRemainingActivityForecast({ ...options, ledger: ledger([actual, ...history].reverse()) })

  assert.equal(ordered.final.expenses, 8140)
  assert.equal(ordered.remainingFromToday.expenses, 8000)
  assert.deepEqual(shuffled, ordered)
})

test('forecasts an early-month historical category when its usual transaction has not arrived yet', () => {
  const history = expensesForMonths(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], 2321, 2, { categoryId: 'housing', destinationId: 'landlord' })

  const result = buildRemainingActivityForecast({
    ledger: ledger(history, { endDate: '2026-08-03' }),
    candidates: [],
    historyMonths: 6,
    today: '2026-08-03',
    endDate: '2026-08-31',
  })

  assert.equal(result.actualToDate.expenses, 0)
  assert.equal(result.historicalBaseline.expenses, 2321)
  assert.equal(result.final.expenses, 2321)
  assert.equal(result.remainingFromToday.expenses, 2321)
  assert.equal(
    result.dailyProjectedEntries.every(({ categoryId, sourceKind }) => categoryId === 'housing' && sourceKind === 'variable'),
    true,
  )
})

test('projects one explicit parent occurrence through its inferred category split bundle', () => {
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  const parentTransactionIds = months.map((month) => `payroll-${month}`)
  const history = months.flatMap((month) => [
    { ...entry({ id: `federal-${month}`, date: `${month}-15`, value: 763, destinationId: 'tax-authority', categoryId: 'federal-tax' }), transactionId: `payroll-${month}` },
    { ...entry({ id: `social-${month}`, date: `${month}-15`, value: 568, destinationId: 'tax-authority', categoryId: 'social-security' }), transactionId: `payroll-${month}` },
    { ...entry({ id: `medicare-${month}`, date: `${month}-15`, value: 133, destinationId: 'tax-authority', categoryId: 'medicare' }), transactionId: `payroll-${month}` },
  ])
  const explicit = {
    ...definedCandidate({ id: 'payroll-tax', sourceAccountId: 'checking', destinationAccountId: 'tax-authority', date: '2026-08-15', amount: 1464 }),
    identity: { ...definedCandidate({ id: 'payroll-tax', sourceAccountId: 'checking', destinationAccountId: 'tax-authority' }).identity, categoryId: null, payee: 'payroll taxes' },
  }
  const candidates = mergeRecurringCandidates({
    defined: [explicit],
    inferred: [
      inferredSplitCandidate({ id: 'federal', amount: 763, categoryId: 'federal-tax', transactionIds: parentTransactionIds }),
      inferredSplitCandidate({ id: 'social', amount: 568, categoryId: 'social-security', transactionIds: parentTransactionIds }),
      inferredSplitCandidate({ id: 'medicare', amount: 133, categoryId: 'medicare', transactionIds: parentTransactionIds }),
    ],
  })

  const result = buildRemainingActivityForecast({
    ledger: ledger(history),
    candidates,
    ...normalizedCandidateInputs(candidates, { ...accountContexts, 'tax-authority': { kind: 'expense', includeNetWorth: false } }),
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.deepEqual(
    result.dailyProjectedEntries.map(({ sourceKind, categoryId, amount, bundleCandidateId }) => ({ sourceKind, categoryId, amount, bundleCandidateId })),
    [
      { sourceKind: 'defined', categoryId: 'federal-tax', amount: 763, bundleCandidateId: 'inferred:federal' },
      { sourceKind: 'defined', categoryId: 'social-security', amount: 568, bundleCandidateId: 'inferred:social' },
      { sourceKind: 'defined', categoryId: 'medicare', amount: 133, bundleCandidateId: 'inferred:medicare' },
    ],
  )
  assert.equal(result.final.expenses, 1464)
  assert.deepEqual(result.audit.recurring.suppressedCandidateIds, ['inferred:federal', 'inferred:medicare', 'inferred:social'])
})

test('treats a current transaction split bundle as fulfillment of its explicit parent', () => {
  const parentTransactionIds = ['payroll-2026-02', 'payroll-2026-03', 'payroll-2026-04', 'payroll-2026-05', 'payroll-2026-06', 'payroll-2026-07']
  const explicit = {
    ...definedCandidate({ id: 'payroll-tax', sourceAccountId: 'checking', destinationAccountId: 'tax-authority', date: '2026-08-15', amount: 1464 }),
    identity: { ...definedCandidate({ id: 'payroll-tax', sourceAccountId: 'checking', destinationAccountId: 'tax-authority' }).identity, categoryId: null, payee: 'payroll taxes' },
  }
  const candidates = mergeRecurringCandidates({
    defined: [explicit],
    inferred: [
      inferredSplitCandidate({ id: 'federal', amount: 763, categoryId: 'federal-tax', transactionIds: parentTransactionIds }),
      inferredSplitCandidate({ id: 'social', amount: 568, categoryId: 'social-security', transactionIds: parentTransactionIds }),
      inferredSplitCandidate({ id: 'medicare', amount: 133, categoryId: 'medicare', transactionIds: parentTransactionIds }),
    ],
  })
  const current = [
    { ...entry({ id: 'federal-august', date: '2026-08-15', value: 763, destinationId: 'tax-authority', categoryId: 'federal-tax' }), transactionId: 'payroll-2026-08' },
    { ...entry({ id: 'social-august', date: '2026-08-15', value: 568, destinationId: 'tax-authority', categoryId: 'social-security' }), transactionId: 'payroll-2026-08' },
    { ...entry({ id: 'medicare-august', date: '2026-08-15', value: 133, destinationId: 'tax-authority', categoryId: 'medicare' }), transactionId: 'payroll-2026-08' },
  ]

  const result = buildRemainingActivityForecast({
    ledger: ledger(current, { startMonth: '2026-08', fetchStartMonth: null, fetchEndDate: null }),
    candidates,
    ...normalizedCandidateInputs(candidates, { ...accountContexts, 'tax-authority': { kind: 'expense', includeNetWorth: false } }),
    historyMonths: 6,
    today: '2026-08-16',
    endDate: '2026-08-31',
  })

  assert.deepEqual(result.dailyProjectedEntries, [])
  assert.deepEqual(result.audit.recurring.fulfilledExpectedIds, [`expected:${explicit.id}:2026-08-15`])
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
  assert.equal(classificationResult.status, 'partial')
  assert.equal(classificationResult.final.income, 0)
  assert.equal(classificationResult.final.refunds, 0)
  assert.equal(classificationResult.final.savingsDeposits, 0)
  assert.equal(classificationResult.final.debtRepayments, 0)
  assert.equal(classificationResult.final.expenses, 100)
  assert.deepEqual(classificationResult.audit.recurring.unresolvedCandidates[0].reasons, ['missingAccountContext'])
  assert.deepEqual(classificationResult.audit.recurring.unresolvedCandidates[0].affectedMetricIds, [])
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

  assert.equal(result.status, 'partial')
  assert.equal(result.final.income, 0)
  assert.equal(result.final.refunds, 0)
  assert.equal(result.final.savingsDeposits, 0)
  assert.equal(result.final.debtRepayments, 0)
  assert.equal(result.final.expenses, 100)
  assert.equal(result.knownRemainingFromToday.expenses, 100)
  assert.equal(result.knownRemainingFromToday.netWorthChange, 0)
  assert.equal(result.knownFinal.expenses, 100)
  assert.equal(result.knownFinal.netWorthChange, 0)
  assert.equal(result.dailyProjectedEntries.length, 1)
  assert.equal(result.dailyProjectedEntries[0].flowAmounts.expenses, 100)
  assert.deepEqual(result.audit.recurring.unresolvedCandidates[0].reasons, ['missingAccountContext'])
  assert.deepEqual(result.audit.recurring.unresolvedCandidates[0].affectedMetricIds, ['savingsWithdrawals', 'newDebt', 'savingsChange', 'debtChange', 'netWorthChange', 'availableCashChange'])
  assert.deepEqual(result.audit.recurring.unresolvedCandidates[0].missingAccountIds, [])
  assert.deepEqual(result.audit.recurring.unresolvedCandidates[0].missingAccountEndpoints, ['source', 'destination'])
})

test('uses consistent matched history to classify an authoritative expense with an omitted source endpoint', () => {
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  const candidate = definedCandidate({ id: 'rent-without-source', sourceAccountId: '', destinationAccountId: 'landlord', amount: 100 })
  candidate.identity.payee = 'rent'
  const history = expensesForMonths(months, 100, 20, { idPrefix: 'rent', destinationId: 'landlord', description: 'Rent' })

  const result = buildForecastCore({
    ledger: ledger(history),
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.statusByMetric.expenses, 'ready')
  assert.equal(result.final.expenses, 100)
  assert.equal(result.final.netWorthChange, -100)
  assert.equal(result.final.availableCashChange, -100)
  assert.deepEqual(result.audit.unavailable.candidateIds, [])
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, history.map(({ id }) => id).sort())
  assert.equal(result.dailyProjectedEntries.length, 1)
  assert.equal(result.dailyProjectedEntries[0].sourceAccountId, 'checking')
  assert.equal(result.dailyProjectedEntries[0].destinationAccountId, 'landlord')
})

test('classifies an endpoint-free subscription only from one unique repeated amount and cadence match', () => {
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  const candidate = definedCandidate({ id: 'subscription-without-route', sourceAccountId: '', destinationAccountId: '', date: '2026-08-20', amount: 100 })
  candidate.source.type = 'subscription'
  candidate.identity.categoryId = null
  candidate.identity.payee = 'Scheduled housing'
  const history = expensesForMonths(months, 100, 20, { idPrefix: 'housing-payment', destinationId: 'landlord', categoryId: 'housing', description: 'Housing payment' })

  const result = buildForecastCore({
    ledger: ledger(history),
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.final.expenses, 100)
  assert.equal(result.final.netWorthChange, -100)
  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, history.map(({ id }) => id).sort())
  assert.equal(result.dailyProjectedEntries.length, 1)
  assert.equal(result.dailyProjectedEntries[0].sourceAccountId, 'checking')
  assert.equal(result.dailyProjectedEntries[0].destinationAccountId, 'landlord')
  assert.equal(result.dailyProjectedEntries[0].categoryId, 'housing')
})

test('does not guess an endpoint-free subscription route when repeated matches are ambiguous', () => {
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  const candidate = definedCandidate({ id: 'ambiguous-subscription', sourceAccountId: '', destinationAccountId: '', date: '2026-08-20', amount: 100 })
  candidate.source.type = 'subscription'
  candidate.identity.categoryId = null
  candidate.identity.payee = 'Ambiguous schedule'
  const history = months.flatMap((month, index) => [
    entry({ id: `ambiguous-a-${index}`, date: `${month}-20`, value: 100, destinationId: 'landlord', categoryId: 'housing', description: 'Housing payment' }),
    entry({ id: `ambiguous-b-${index}`, date: `${month}-20`, value: 100, destinationId: 'merchant', categoryId: 'general', description: 'Other payment' }),
  ])

  const result = buildForecastCore({
    ledger: ledger(history),
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.deepEqual(result.audit.recurring.removedHistoryEntryIds, [])
  assert.equal(result.dailyProjectedEntries.filter(({ sourceKind }) => sourceKind === 'defined').length, 1)
  assert.equal(result.dailyProjectedEntries.filter(({ sourceKind }) => sourceKind === 'variable').length > 0, true)
  assert.equal(result.statusByMetric.netWorthChange, 'unavailable')
})

test('uses the unique repeated subscription route to suppress a fulfilled current occurrence', () => {
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  const candidate = definedCandidate({ id: 'fulfilled-subscription-without-route', sourceAccountId: '', destinationAccountId: '', date: '2026-08-20', amount: 100 })
  candidate.source.type = 'subscription'
  candidate.identity.categoryId = null
  candidate.identity.payee = 'Scheduled housing'
  const history = expensesForMonths(months, 100, 20, { idPrefix: 'fulfilled-housing-payment', destinationId: 'landlord', categoryId: 'housing', description: 'Housing payment' })
  const current = entry({ id: 'fulfilled-housing-current', date: '2026-08-20', value: 100, destinationId: 'landlord', categoryId: 'housing', description: 'Housing payment' })

  const result = buildForecastCore({
    ledger: ledger([...history, current], { endDate: '2026-08-20' }),
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-20' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-20',
    endDate: '2026-08-31',
  })

  assert.equal(result.actualToDate.expenses, 100)
  assert.equal(result.remainingFromToday.expenses, 0)
  assert.equal(result.final.expenses, 100)
  assert.deepEqual(result.dailyProjectedEntries, [])
  assert.deepEqual(result.audit.recurring.fulfilledExpectedIds, [`expected:${candidate.id}:2026-08-20`])
})

test('keeps a known authoritative expense forecast when its account route cannot be classified', () => {
  const candidate = definedCandidate({ id: 'known-expense-unknown-route', sourceAccountId: '', destinationAccountId: '', amount: 100 })

  const result = buildForecastCore({
    ledger: ledger([]),
    candidates: [candidate],
    ...normalizedCandidateInputs([candidate]),
    fetchCoverage: { startMonth: '2026-02', endDate: '2026-08-10' },
    currencyDecimalPlaces: 2,
    historyMonths: 6,
    today: '2026-08-10',
    endDate: '2026-08-31',
  })

  assert.equal(result.status, 'partial')
  assert.equal(result.statusByMetric.expenses, 'ready')
  assert.equal(result.remainingFromToday.expenses, 100)
  assert.equal(result.final.expenses, 100)
  assert.equal(result.dailyProjectedEntries.length, 1)
  assert.equal(result.dailyProjectedEntries[0].flowAmounts.expenses, 100)
  assert.equal(result.dailyProjectedEntries[0].flowAmounts.availableCashChange, null)
  assert.equal(result.audit.recurring.unresolvedCandidates[0].reasons.includes('missingAccountContext'), true)
  assert.equal(result.audit.recurring.unresolvedCandidates[0].affectedMetricIds.includes('expenses'), false)
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
