import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDefinedOccurrences, detectRecurringCandidates, matchRecurringOccurrences, mergeRecurringCandidates } from '../../utils/AnalyticsRecurringUtils.js'

const entry = ({
  id,
  date,
  value = 100,
  direction = 'expense',
  sourceId = direction === 'income' ? 'employer' : 'checking',
  destinationId = direction === 'income' ? 'checking' : 'merchant',
  categoryId = direction === 'income' ? 'salary' : 'general',
  description = direction === 'income' ? 'Salary' : 'Merchant',
}) => ({
  id,
  transactionId: id,
  journalId: `${id}-journal`,
  date,
  monthKey: date.slice(0, 7),
  day: Number(date.slice(-2)),
  value,
  sourceKind: direction === 'income' ? 'revenue' : 'available',
  destinationKind: direction === 'income' ? 'available' : 'expense',
  sourceAccount: { id: sourceId, attributes: { name: sourceId } },
  destinationAccount: { id: destinationId, attributes: { name: destinationId } },
  categoryId,
  description,
  refund: { isRefund: false },
})

const entriesForDates = (dates, overrides = {}) => dates.map((date, index) => entry({ id: `${overrides.idPrefix ?? 'entry'}-${index + 1}`, date, ...overrides }))

const reasonCodes = (result) => result.audit.rejected.flatMap(({ reasons }) => reasons.map(({ code }) => code))

test('normalizes usable recurring transactions and subscriptions as authoritative local-date occurrences', () => {
  const recurringTransactions = [
    {
      id: 'recurring-rent',
      attributes: {
        active: true,
        type: 'withdrawal',
        title: 'Rent',
        repetitions: [{ type: 'monthly', moment: '1', skip: 0, occurrences: ['2026-08-03T00:00:00-04:00', '2026-09-01T00:00:00-04:00'] }],
        transactions: [{ amount: '2321', description: 'Rent', source_id: 'checking', destination_id: 'landlord', category_id: 'housing' }],
      },
    },
  ]
  const subscriptions = [
    {
      id: 'subscription-internet',
      attributes: {
        active: true,
        name: 'Internet',
        repeat_freq: 'monthly',
        amount_min: '80',
        amount_max: '90',
        amount_avg: '85',
        pay_dates: ['2026-08-15T00:00:00-04:00', '2026-09-15T00:00:00-04:00'],
      },
    },
  ]

  const result = buildDefinedOccurrences({ recurringTransactions, subscriptions, startDate: '2026-08-01', endDate: '2026-09-30' })

  assert.equal(result.length, 2)
  assert.deepEqual(
    result.map(({ source, expectedDates }) => ({ source, expectedDates })),
    [
      { source: { type: 'recurringTransaction', id: 'recurring-rent', authoritative: true }, expectedDates: ['2026-08-03', '2026-09-01'] },
      { source: { type: 'subscription', id: 'subscription-internet', authoritative: true }, expectedDates: ['2026-08-15', '2026-09-15'] },
    ],
  )
  assert.deepEqual(result[0].identity, {
    direction: 'expense',
    sourceAccountId: 'checking',
    sourceKind: null,
    destinationAccountId: 'landlord',
    destinationKind: null,
    categoryId: 'housing',
    payee: 'rent',
  })
  assert.deepEqual(result[1].expectedAmount, { value: 85, min: 80, max: 90 })
  assert.deepEqual(
    result.flatMap(({ evidence }) => evidence.transactionIds),
    [],
  )
})

test('infers monthly rent despite local weekend shifts and retains exact evidence', () => {
  const entries = entriesForDates(['2026-01-01', '2026-02-02', '2026-03-02', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'], {
    value: 2321,
    destinationId: 'landlord',
    categoryId: 'housing',
    description: 'Monthly Rent',
    idPrefix: 'rent',
  })

  const result = detectRecurringCandidates({ entries, startDate: '2026-01-01', endDate: '2026-08-10' })

  assert.equal(result.candidates.length, 1)
  const candidate = result.candidates[0]
  assert.equal(candidate.cadence.type, 'monthly')
  assert.deepEqual(candidate.cadence.days, [1])
  assert.equal(candidate.confidence.factors.dateMadDays, 0)
  assert.equal(candidate.confidence.factors.coverage, 1)
  assert.deepEqual(
    candidate.evidence.transactionIds,
    entries.map(({ transactionId }) => transactionId),
  )
  assert.deepEqual(result.audit.accepted, [candidate.id])
})

test('infers twice-monthly salary around the middle and end of each month', () => {
  const entries = entriesForDates(
    ['2026-01-15', '2026-01-30', '2026-02-13', '2026-02-27', '2026-03-16', '2026-03-31', '2026-04-15', '2026-04-30', '2026-05-15', '2026-05-29', '2026-06-15', '2026-06-30'],
    { direction: 'income', value: 3000, sourceId: 'employer', categoryId: 'salary', description: 'Payroll', idPrefix: 'salary' },
  )

  const result = detectRecurringCandidates({ entries, startDate: '2026-01-01', endDate: '2026-07-10' })

  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].cadence.type, 'twiceMonthly')
  assert.deepEqual(result.candidates[0].cadence.days, [15])
  assert.deepEqual(result.candidates[0].cadence.fromMonthEnd, [1])
  assert.equal(result.candidates[0].confidence.factors.coverage, 1)
})

test('infers weekly activity when one completed cycle is missed', () => {
  const entries = entriesForDates(['2026-01-05', '2026-01-12', '2026-01-19', '2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23'], {
    value: 45,
    destinationId: 'fitness',
    categoryId: 'health',
    description: 'Weekly class',
    idPrefix: 'class',
  })

  const result = detectRecurringCandidates({ entries, startDate: '2026-01-05', endDate: '2026-03-01' })

  assert.equal(result.candidates.length, 1)
  assert.deepEqual(result.candidates[0].cadence, { type: 'weekly', intervalWeeks: 1, weekday: 1, anchorDate: '2026-01-05' })
  assert.equal(result.candidates[0].confidence.factors.coverage, 0.875)
})

test('infers a biweekly cadence without misclassifying it as monthly', () => {
  const entries = entriesForDates(['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16', '2026-03-02', '2026-03-16', '2026-03-30'], {
    value: 60,
    destinationId: 'cleaner',
    categoryId: 'home',
    description: 'Cleaning',
    idPrefix: 'cleaning',
  })

  const result = detectRecurringCandidates({ entries, startDate: '2026-01-05', endDate: '2026-04-01' })

  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].cadence.type, 'biweekly')
  assert.equal(result.candidates[0].confidence.factors.coverage, 1)
})

test('accepts exact dispersion and identity threshold boundaries and rejects values above or below them', () => {
  const atAmountBoundary = entriesForDates(['2026-01-05', '2026-02-09', '2026-03-05', '2026-04-09', '2026-05-05'], {
    destinationId: 'amount-boundary',
    categoryId: 'boundary',
    description: 'Boundary',
    idPrefix: 'amount-boundary',
  }).map((item, index) => ({ ...item, value: [75, 75, 100, 125, 125][index] }))
  const aboveAmountBoundary = entriesForDates(['2026-01-05', '2026-02-09', '2026-03-05', '2026-04-09', '2026-05-05'], {
    destinationId: 'amount-reject',
    categoryId: 'boundary',
    description: 'Boundary',
    idPrefix: 'amount-reject',
  }).map((item, index) => ({ ...item, value: [74, 74, 100, 126, 126][index] }))
  const atIdentityBoundary = entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'], {
    destinationId: 'identity-boundary',
    categoryId: 'stable',
    description: 'Stable payee',
    idPrefix: 'identity-boundary',
  })
  atIdentityBoundary[4] = { ...atIdentityBoundary[4], categoryId: 'different', description: 'Different payee' }
  const belowIdentityBoundary = entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'], {
    destinationId: 'identity-reject',
    categoryId: 'stable',
    description: 'Stable payee',
    idPrefix: 'identity-reject',
  })
  belowIdentityBoundary[3] = { ...belowIdentityBoundary[3], categoryId: 'different', description: 'Different payee' }
  const atDateBoundary = entriesForDates(['2026-01-01', '2026-02-05', '2026-03-09'], { destinationId: 'date-boundary', idPrefix: 'date-boundary' })
  const aboveDateBoundary = entriesForDates(['2026-01-01', '2026-02-06', '2026-03-11'], { destinationId: 'date-reject', idPrefix: 'date-reject' })

  const result = detectRecurringCandidates({
    entries: [...atAmountBoundary, ...aboveAmountBoundary, ...atIdentityBoundary, ...belowIdentityBoundary, ...atDateBoundary, ...aboveDateBoundary],
    startDate: '2026-01-01',
    endDate: '2026-06-10',
  })

  const acceptedPayees = result.candidates.map(({ identity }) => identity.destinationAccountId).sort()
  assert.deepEqual(acceptedPayees, ['amount-boundary', 'date-boundary', 'identity-boundary'])
  const rejected = Object.fromEntries(result.audit.rejected.map((item) => [item.identity.destinationAccountId, item.reasons.map(({ code }) => code)]))
  assert.ok(rejected['amount-reject'].includes('amountDispersion'))
  assert.ok(rejected['identity-reject'].includes('identityStability'))
  assert.ok(rejected['date-reject'].includes('dateDispersion'))
})

test('uses only completed cycles so the unfinished current month cannot weaken exact 60 percent coverage', () => {
  const entries = entriesForDates(['2026-01-04', '2026-03-04', '2026-05-04'], {
    destinationId: 'sparse-service',
    categoryId: 'service',
    description: 'Sparse service',
    idPrefix: 'sparse',
  })

  const result = detectRecurringCandidates({ entries, startDate: '2026-01-01', endDate: '2026-06-10' })

  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].cadence.type, 'monthly')
  assert.equal(result.candidates[0].confidence.factors.coverage, 0.6)
  assert.equal(result.candidates[0].confidence.factors.eligibleCycles, 5)
})

test('rejects noisy, inconsistent, and two-occurrence history with explicit threshold audit', () => {
  const noisy = entriesForDates(['2026-01-02', '2026-02-02', '2026-03-02', '2026-04-02', '2026-05-02'], {
    destinationId: 'noisy',
    categoryId: 'shopping',
    description: 'Noisy merchant',
    idPrefix: 'noisy',
  }).map((item, index) => ({ ...item, value: [20, 50, 100, 150, 200][index] }))
  const inconsistent = entriesForDates(['2026-01-03', '2026-02-03', '2026-03-03', '2026-04-03'], {
    destinationId: 'inconsistent',
    categoryId: 'alpha',
    description: 'Alpha',
    idPrefix: 'inconsistent',
  }).map((item, index) => ({ ...item, categoryId: index < 3 ? 'alpha' : 'beta', description: index < 3 ? 'Alpha' : 'Beta' }))
  const two = entriesForDates(['2026-01-04', '2026-02-04'], { destinationId: 'two-only', idPrefix: 'two' })

  const result = detectRecurringCandidates({ entries: [...noisy, ...inconsistent, ...two], startDate: '2026-01-01', endDate: '2026-06-10' })

  assert.equal(result.candidates.length, 0)
  const rejected = Object.fromEntries(result.audit.rejected.map((item) => [item.identity.destinationAccountId, item.reasons]))
  assert.ok(rejected.noisy.some(({ code, actual, maximum }) => code === 'amountDispersion' && actual > maximum))
  assert.ok(rejected.inconsistent.some(({ code, actual, minimum }) => code === 'identityStability' && actual < minimum))
  assert.ok(rejected['two-only'].some(({ code, actual, minimum }) => code === 'occurrenceCount' && actual === 2 && minimum === 3))
  assert.ok(reasonCodes(result).every(Boolean))
})

test('merges an overlapping inferred candidate into the authoritative recurring definition', () => {
  const entries = entriesForDates(['2026-01-01', '2026-02-02', '2026-03-02', '2026-04-01', '2026-05-01'], {
    value: 2321,
    destinationId: 'landlord',
    categoryId: 'housing',
    description: 'Rent',
    idPrefix: 'rent',
  })
  const inferred = detectRecurringCandidates({ entries, startDate: '2026-01-01', endDate: '2026-06-10' }).candidates
  const defined = buildDefinedOccurrences({
    recurringTransactions: [
      {
        id: 'recurring-rent',
        attributes: {
          active: true,
          type: 'withdrawal',
          title: 'Rent',
          repetitions: [{ type: 'monthly', moment: '1', occurrences: ['2026-06-01'] }],
          transactions: [{ amount: '2321', description: 'Rent', source_id: 'checking', destination_id: 'landlord', category_id: 'housing' }],
        },
      },
    ],
    subscriptions: [],
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  })

  const result = mergeRecurringCandidates({ defined, inferred })

  assert.equal(result.length, 1)
  assert.deepEqual(result[0].source, { type: 'recurringTransaction', id: 'recurring-rent', authoritative: true })
  assert.deepEqual(
    result[0].evidence.transactionIds,
    entries.map(({ transactionId }) => transactionId),
  )
  assert.equal(result[0].inference.id, inferred[0].id)
})

test('matches and suppresses an already-observed current occurrence without inventing transaction IDs', () => {
  const history = entriesForDates(['2026-01-01', '2026-02-02', '2026-03-02', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'], {
    value: 2321,
    destinationId: 'landlord',
    categoryId: 'housing',
    description: 'Rent',
    idPrefix: 'rent',
  })
  const candidate = detectRecurringCandidates({ entries: history, startDate: '2026-01-01', endDate: '2026-08-03' }).candidates[0]
  const actual = entry({ id: 'rent-august', date: '2026-08-03', value: 2321, destinationId: 'landlord', categoryId: 'housing', description: 'Rent' })

  const result = matchRecurringOccurrences({ candidates: [candidate], actualEntries: [actual], today: '2026-08-03' })

  assert.equal(result.remaining.length, 0)
  assert.equal(result.fulfilled.length, 1)
  assert.deepEqual(result.fulfilled[0].actualTransactionIds, ['rent-august'])
  assert.equal(result.fulfilled[0].status, 'fulfilled')
  assert.equal('transactionId' in result.fulfilled[0], false)
  assert.equal(result.candidates[0].occurrences[0].expectedId.startsWith('expected:'), true)
})

test('returns identical candidates and audit for shuffled ledger input without mutating entries', () => {
  const entries = entriesForDates(['2026-01-01', '2026-02-02', '2026-03-02', '2026-04-01', '2026-05-01'], {
    value: 2321,
    destinationId: 'landlord',
    categoryId: 'housing',
    description: 'Rent',
    idPrefix: 'rent',
  })
  const original = structuredClone(entries)
  const shuffled = [entries[3], entries[0], entries[4], entries[1], entries[2]]

  const orderedResult = detectRecurringCandidates({ entries, startDate: '2026-01-01', endDate: '2026-06-10' })
  const shuffledResult = detectRecurringCandidates({ entries: shuffled, startDate: '2026-01-01', endDate: '2026-06-10' })

  assert.deepEqual(shuffledResult, orderedResult)
  assert.deepEqual(entries, original)
})
