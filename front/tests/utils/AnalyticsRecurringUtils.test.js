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

test('does not merge equal-cadence identities when monthly phase or robust amount envelopes do not overlap', () => {
  const defined = buildDefinedOccurrences({
    recurringTransactions: [
      {
        id: 'defined-service',
        attributes: {
          active: true,
          type: 'withdrawal',
          repetitions: [{ type: 'monthly', moment: '1', occurrences: ['2026-06-01'] }],
          transactions: [{ amount: '100', description: 'Same service', source_id: 'checking', destination_id: 'service', category_id: 'service' }],
        },
      },
    ],
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  })
  const wrongPhase = detectRecurringCandidates({
    entries: entriesForDates(['2026-01-20', '2026-02-20', '2026-03-20', '2026-04-20', '2026-05-20'], {
      value: 100,
      destinationId: 'service',
      categoryId: 'service',
      description: 'Same service',
      idPrefix: 'wrong-phase',
    }),
    startDate: '2026-01-01',
    endDate: '2026-06-10',
  }).candidates
  const wrongAmount = detectRecurringCandidates({
    entries: entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'], {
      value: 500,
      destinationId: 'service',
      categoryId: 'service',
      description: 'Same service',
      idPrefix: 'wrong-amount',
    }),
    startDate: '2026-01-01',
    endDate: '2026-06-10',
  }).candidates
  const wrongPhaseAndAmount = detectRecurringCandidates({
    entries: entriesForDates(['2026-01-20', '2026-02-20', '2026-03-20', '2026-04-20', '2026-05-20'], {
      value: 500,
      destinationId: 'service',
      categoryId: 'service',
      description: 'Same service',
      idPrefix: 'wrong-both',
    }),
    startDate: '2026-01-01',
    endDate: '2026-06-10',
  }).candidates

  assert.equal(mergeRecurringCandidates({ defined, inferred: wrongPhase }).length, 2)
  assert.equal(mergeRecurringCandidates({ defined, inferred: wrongAmount }).length, 2)
  assert.equal(mergeRecurringCandidates({ defined, inferred: wrongPhaseAndAmount }).length, 2)
  assert.equal(mergeRecurringCandidates({ defined, inferred: [...wrongPhase, ...wrongAmount] }).length, 3)
})

test('combines two compatible monthly definition repetitions into one authoritative twice-monthly stream', () => {
  const result = buildDefinedOccurrences({
    recurringTransactions: [
      {
        id: 'recurring-salary',
        attributes: {
          active: true,
          type: 'deposit',
          repetitions: [
            { type: 'monthly', moment: '15', occurrences: ['2026-08-14', '2026-09-15'] },
            { type: 'monthly', moment: '31', occurrences: ['2026-08-31', '2026-09-30'] },
          ],
          transactions: [{ amount: '3000', description: 'Payroll', source_id: 'employer', destination_id: 'checking', category_id: 'salary' }],
        },
      },
    ],
    startDate: '2026-08-01',
    endDate: '2026-09-30',
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].source.id, 'recurring-salary')
  assert.deepEqual(result[0].cadence, { type: 'twiceMonthly', days: [15], fromMonthEnd: [0] })
  assert.deepEqual(result[0].expectedDates, ['2026-08-14', '2026-08-31', '2026-09-15', '2026-09-30'])

  const inferred = detectRecurringCandidates({
    entries: entriesForDates(['2026-01-15', '2026-01-31', '2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31', '2026-04-15', '2026-04-30'], {
      direction: 'income',
      value: 3000,
      sourceId: 'employer',
      categoryId: 'salary',
      description: 'Payroll',
      idPrefix: 'defined-overlap-salary',
    }),
    startDate: '2026-01-01',
    endDate: '2026-05-10',
  }).candidates
  const merged = mergeRecurringCandidates({ defined: result, inferred })
  assert.equal(merged.length, 1)
  assert.equal(merged[0].source.authoritative, true)
  assert.equal(merged[0].inference.id, inferred[0].id)
})

test('preserves incompatible authoritative repetitions as deterministic independent streams', () => {
  const recurringTransactions = [
    {
      id: 'recurring-mixed',
      attributes: {
        active: true,
        type: 'withdrawal',
        repetitionType: { fireflyCode: 'monthly' },
        repetitionDay: '1',
        repetitions: [
          { type: 'monthly', moment: '1', occurrences: ['2026-08-01', '2026-09-01'] },
          { type: 'weekly', moment: '5', occurrences: ['2026-08-07', '2026-08-14'] },
        ],
        transactions: [{ amount: '25', description: 'Mixed schedule', source_id: 'checking', destination_id: 'service', category_id: 'service' }],
      },
    },
  ]

  const result = buildDefinedOccurrences({ recurringTransactions, startDate: '2026-08-01', endDate: '2026-09-30' })

  assert.equal(result.length, 2)
  assert.deepEqual(result.map(({ cadence }) => cadence.type).sort(), ['monthly', 'weekly'])
  assert.equal(new Set(result.map(({ id }) => id)).size, 2)
  assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [...recurringTransactions].reverse(), startDate: '2026-08-01', endDate: '2026-09-30' }), result)
})

test('honors recurrence and subscription bounds during normalization and later occurrence matching', () => {
  const expiredRecurrence = {
    id: 'expired-recurrence',
    attributes: {
      active: true,
      type: 'withdrawal',
      first_date: '2026-08-01',
      repeat_until: '2026-08-31',
      repetitions: [{ type: 'monthly', moment: '1' }],
      transactions: [{ amount: '100', description: 'Expired', source_id: 'checking', destination_id: 'expired', category_id: 'service' }],
    },
  }
  const expiredSubscription = {
    id: 'expired-subscription',
    attributes: { active: true, name: 'Expired bill', date: '2026-08-01', end_date: '2026-08-31', repeat_freq: 'monthly', amount_avg: '50' },
  }

  assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [expiredRecurrence], subscriptions: [expiredSubscription], startDate: '2026-09-01', endDate: '2026-09-30' }), [])
  assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [expiredRecurrence], subscriptions: [expiredSubscription], startDate: '2026-07-01', endDate: '2026-07-31' }), [])

  const august = buildDefinedOccurrences({ recurringTransactions: [expiredRecurrence], startDate: '2026-08-01', endDate: '2026-08-31' })
  const matched = matchRecurringOccurrences({ candidates: august, actualEntries: [], today: '2026-09-01' })
  assert.equal(matched.candidates[0].occurrences.length, 0)
  assert.deepEqual(matched.remaining, [])
})

test('uses a capped robust inferred amount envelope when matching current occurrences', () => {
  const history = entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'], {
    destinationId: 'outlier-service',
    categoryId: 'service',
    description: 'Outlier service',
    idPrefix: 'outlier',
  }).map((item, index) => ({ ...item, value: [100, 100, 100, 100, 1000][index] }))
  const candidate = detectRecurringCandidates({ entries: history, startDate: '2026-01-01', endDate: '2026-06-10' }).candidates[0]
  const current = entry({ id: 'outlier-current', date: '2026-06-01', value: 500, destinationId: 'outlier-service', categoryId: 'service', description: 'Outlier service' })

  const result = matchRecurringOccurrences({ candidates: [candidate], actualEntries: [current], today: '2026-06-01' })

  assert.equal(candidate.expectedAmount.value, 100)
  assert.equal(result.fulfilled.length, 0)
  assert.equal(result.remaining.length, 1)
})

test('scores the complete observed identity tuple and rejects synthetic marginal stability', () => {
  const entries = entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'], {
    destinationId: 'joint-service',
    categoryId: 'stable',
    description: 'Stable payee',
    idPrefix: 'joint',
  })
  entries[3] = { ...entries[3], sourceAccount: { id: 'other-checking', attributes: { name: 'other-checking' } } }
  entries[4] = { ...entries[4], categoryId: 'other', description: 'Other payee' }

  const result = detectRecurringCandidates({ entries, startDate: '2026-01-01', endDate: '2026-06-10' })

  assert.equal(result.candidates.length, 0)
  assert.ok(result.audit.rejected[0].reasons.some(({ code, actual, minimum }) => code === 'identityStability' && actual === 0.6 && minimum === 0.8))
  assert.deepEqual(
    result.audit.rejected[0].identityVariants.map(({ count }) => count),
    [3, 1, 1],
  )
})

test('matches an observed minority identity variant but never an unseen identity', () => {
  const history = entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'], {
    destinationId: 'variant-service',
    categoryId: 'stable',
    description: 'Stable payee',
    idPrefix: 'variant',
  })
  history[4] = {
    ...history[4],
    sourceAccount: { id: 'secondary-checking', attributes: { name: 'secondary-checking' } },
    categoryId: 'alternate',
    description: 'Alternate payee',
  }
  const candidate = detectRecurringCandidates({ entries: history, startDate: '2026-01-01', endDate: '2026-06-10' }).candidates[0]
  const observedVariant = entry({
    id: 'observed-variant',
    date: '2026-06-01',
    value: 100,
    sourceId: 'secondary-checking',
    destinationId: 'variant-service',
    categoryId: 'alternate',
    description: 'Alternate payee',
  })
  const unseenVariant = entry({
    id: 'unseen-variant',
    date: '2026-06-01',
    value: 100,
    sourceId: 'third-checking',
    destinationId: 'variant-service',
    categoryId: 'unseen',
    description: 'Unseen payee',
  })

  assert.deepEqual(
    candidate.identityVariants.map(({ count }) => count),
    [4, 1],
  )
  assert.equal(matchRecurringOccurrences({ candidates: [candidate], actualEntries: [observedVariant], today: '2026-06-01' }).fulfilled.length, 1)
  assert.equal(matchRecurringOccurrences({ candidates: [candidate], actualEntries: [unseenVariant], today: '2026-06-01' }).fulfilled.length, 0)
})

test('normalizes local Date ledger values before completed-cycle filtering and remains deterministic when shuffled', () => {
  const entries = entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'], {
    destinationId: 'date-object-service',
    categoryId: 'service',
    description: 'Date object service',
    idPrefix: 'date-object',
  }).map((item, index) => ({ ...item, date: new Date(2026, index, 1, 0, 5) }))
  const ordered = detectRecurringCandidates({ entries, startDate: new Date(2026, 0, 1), endDate: new Date(2026, 5, 10) })
  const shuffled = detectRecurringCandidates({ entries: [entries[4], entries[1], entries[3], entries[0], entries[2]], startDate: new Date(2026, 0, 1), endDate: new Date(2026, 5, 10) })

  assert.equal(ordered.candidates.length, 1)
  assert.deepEqual(shuffled, ordered)
  assert.deepEqual(ordered.candidates[0].evidence.dates, ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'])
})

test('rejects zero-magnitude histories explicitly while accepting signed negative magnitudes', () => {
  const zero = entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01'], { value: 0, destinationId: 'zero-service', idPrefix: 'zero' })
  const negative = entriesForDates(['2026-01-02', '2026-02-02', '2026-03-02'], { value: -100, destinationId: 'negative-service', idPrefix: 'negative' })

  const result = detectRecurringCandidates({ entries: [...zero, ...negative], startDate: '2026-01-01', endDate: '2026-04-10' })

  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].identity.destinationAccountId, 'negative-service')
  assert.deepEqual(result.candidates[0].expectedAmount, { value: 100, min: 100, max: 100 })
  const zeroAudit = result.audit.rejected.find(({ identity }) => identity.destinationAccountId === 'zero-service')
  assert.ok(zeroAudit.reasons.some(({ code }) => code === 'zeroMagnitude'))
})

test('normalizes transformed Pico recurrences and omits inactive or unusable definitions', () => {
  const transformed = {
    id: 'pico-transformed',
    attributes: {
      active: true,
      type: { fireflyCode: 'withdrawal' },
      amount: '-250',
      description: 'Pico schedule',
      repetitionType: { fireflyCode: 'monthly' },
      repetitionDay: '5',
      occurrences: [new Date(2026, 7, 5, 0, 5)],
      accountSource: { id: 'checking' },
      accountDestination: { id: 'pico-service' },
      category: { id: 'service' },
    },
  }
  const inactive = { ...transformed, id: 'inactive', attributes: { ...transformed.attributes, active: false } }
  const unusable = { id: 'unusable', attributes: { active: true, type: 'withdrawal', transactions: [{ amount: '10' }] } }

  const result = buildDefinedOccurrences({ recurringTransactions: [unusable, inactive, transformed], startDate: '2026-08-01', endDate: '2026-08-31' })

  assert.equal(result.length, 1)
  assert.equal(result[0].source.id, 'pico-transformed')
  assert.deepEqual(result[0].expectedDates, ['2026-08-05'])
  assert.deepEqual(result[0].expectedAmount, { value: 250, min: 250, max: 250 })
  assert.equal(result[0].identity.sourceAccountId, 'checking')
  assert.equal(result[0].identity.destinationAccountId, 'pico-service')
})

test('merge and occurrence matching are deterministic for shuffled candidates and actual entries', () => {
  const rentHistory = entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'], {
    destinationId: 'rent-service',
    categoryId: 'housing',
    description: 'Rent',
    idPrefix: 'rent-deterministic',
  })
  const gymHistory = entriesForDates(['2026-01-02', '2026-02-02', '2026-03-02', '2026-04-02', '2026-05-02'], {
    destinationId: 'gym-service',
    categoryId: 'health',
    description: 'Gym',
    idPrefix: 'gym-deterministic',
  })
  const inferred = detectRecurringCandidates({ entries: [...rentHistory, ...gymHistory], startDate: '2026-01-01', endDate: '2026-06-10' }).candidates
  const defined = buildDefinedOccurrences({
    subscriptions: [{ id: 'rent-subscription', attributes: { active: true, name: 'Rent', repeat_freq: 'monthly', amount_avg: '100', pay_dates: ['2026-06-01'] } }],
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  })
  const orderedMerge = mergeRecurringCandidates({ defined, inferred })
  const shuffledMerge = mergeRecurringCandidates({ defined: [...defined].reverse(), inferred: [...inferred].reverse() })
  const actual = [
    entry({ id: 'gym-current', date: '2026-06-02', destinationId: 'gym-service', categoryId: 'health', description: 'Gym' }),
    entry({ id: 'rent-current', date: '2026-06-01', destinationId: 'rent-service', categoryId: 'housing', description: 'Rent' }),
  ]

  assert.deepEqual(shuffledMerge, orderedMerge)
  assert.deepEqual(
    matchRecurringOccurrences({ candidates: [...orderedMerge].reverse(), actualEntries: [...actual].reverse(), today: '2026-06-02' }),
    matchRecurringOccurrences({ candidates: orderedMerge, actualEntries: actual, today: '2026-06-02' }),
  )
  assert.ok(
    matchRecurringOccurrences({ candidates: orderedMerge, actualEntries: actual, today: '2026-06-02' })
      .candidates.flatMap(({ occurrences }) => occurrences)
      .every((occurrence) => !('transactionId' in occurrence)),
  )
})

test('pairs compatible monthly repetitions while preserving other authoritative streams', () => {
  const recurringTransactions = [
    {
      id: 'salary-and-weekly',
      attributes: {
        active: true,
        type: 'deposit',
        first_date: '2026-01-05',
        repetitions: [
          { type: 'weekly', moment: '1', occurrences: ['2026-08-03', '2026-08-10'] },
          { type: 'monthly', moment: '31', occurrences: ['2026-08-31', '2026-09-30'] },
          { type: 'monthly', moment: '15', occurrences: ['2026-08-14', '2026-09-15'] },
        ],
        transactions: [{ amount: '3000', description: 'Payroll', source_id: 'employer', destination_id: 'checking', category_id: 'salary' }],
      },
    },
  ]

  const defined = buildDefinedOccurrences({ recurringTransactions, startDate: '2026-08-01', endDate: '2026-09-30' })

  assert.equal(defined.length, 2)
  assert.deepEqual(defined.map(({ cadence }) => cadence.type).sort(), ['twiceMonthly', 'weekly'])
  const twiceMonthly = defined.find(({ cadence }) => cadence.type === 'twiceMonthly')
  assert.deepEqual(twiceMonthly.cadence, { type: 'twiceMonthly', days: [15], fromMonthEnd: [0] })
  assert.deepEqual(twiceMonthly.expectedDates, ['2026-08-14', '2026-08-31', '2026-09-15', '2026-09-30'])

  const inferred = detectRecurringCandidates({
    entries: entriesForDates(['2026-01-15', '2026-01-31', '2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31', '2026-04-15', '2026-04-30'], {
      direction: 'income',
      value: 3000,
      sourceId: 'employer',
      categoryId: 'salary',
      description: 'Payroll',
      idPrefix: 'multi-stream-salary',
    }),
    startDate: '2026-01-01',
    endDate: '2026-05-10',
  }).candidates
  const merged = mergeRecurringCandidates({ defined, inferred })
  assert.equal(merged.length, 2)
  assert.equal(merged.find(({ cadence }) => cadence.type === 'twiceMonthly').inference.id, inferred[0].id)
})

test('derives an inclusive end for finite recurrence counts and never regenerates an exhausted occurrence', () => {
  const recurrence = {
    id: 'three-months-only',
    attributes: {
      active: true,
      type: 'withdrawal',
      first_date: '2026-01-01',
      nr_of_repetitions: 3,
      repetitions: [{ type: 'monthly', moment: '1' }],
      transactions: [{ amount: '100', description: 'Three months', source_id: 'checking', destination_id: 'service', category_id: 'service' }],
    },
  }

  assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [recurrence], startDate: '2026-08-01', endDate: '2026-08-31' }), [])
  const activeWindow = buildDefinedOccurrences({ recurringTransactions: [recurrence], startDate: '2026-01-01', endDate: '2026-03-31' })
  assert.equal(activeWindow.length, 1)
  assert.deepEqual(activeWindow[0].expectedDates, ['2026-01-01', '2026-02-01', '2026-03-01'])
  assert.deepEqual(activeWindow[0].bounds, { start: '2026-01-01', end: '2026-03-01' })
  assert.deepEqual(matchRecurringOccurrences({ candidates: activeWindow, actualEntries: [], today: '2026-08-01' }).remaining, [])
})

test('falls back to the last authoritative occurrence when a finite recurrence end cannot be reconstructed', () => {
  const recurrence = {
    id: 'finite-without-first-date',
    attributes: {
      active: true,
      type: 'withdrawal',
      nr_of_repetitions: 3,
      repetitions: [{ type: 'monthly', moment: '1', occurrences: ['2026-01-01', '2026-02-01', '2026-03-01'] }],
      transactions: [{ amount: '100', description: 'Finite history', source_id: 'checking', destination_id: 'service', category_id: 'service' }],
    },
  }

  assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [recurrence], startDate: '2026-08-01', endDate: '2026-08-31' }), [])
  const authoritativeWindow = buildDefinedOccurrences({ recurringTransactions: [recurrence], startDate: '2026-01-01', endDate: '2026-03-31' })
  assert.equal(authoritativeWindow.length, 1)
  assert.deepEqual(authoritativeWindow[0].bounds, { start: null, end: '2026-03-01' })
})

test('treats first_date as occurrence one for missing, null, zero, one, and three finite repetitions', () => {
  const recurrence = (count, includeCount = true) => ({
    id: `shifted-${includeCount ? count : 'missing'}`,
    attributes: {
      active: true,
      type: 'withdrawal',
      first_date: '2026-01-03',
      ...(includeCount ? { nr_of_repetitions: count } : {}),
      repetitions: [{ type: 'monthly', moment: '1' }],
      transactions: [{ amount: '100', description: 'Shifted finite', source_id: 'checking', destination_id: 'service', category_id: 'service' }],
    },
  })

  for (const unbounded of [recurrence(null), recurrence(null, false)]) {
    const august = buildDefinedOccurrences({ recurringTransactions: [unbounded], startDate: '2026-08-01', endDate: '2026-08-31' })
    assert.equal(august.length, 1)
    assert.deepEqual(august[0].bounds, { start: '2026-01-03', end: null })
    assert.deepEqual(august[0].expectedDates, ['2026-08-01'])
  }

  assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [recurrence(0)], startDate: '2026-01-01', endDate: '2026-12-31' }), [])

  const once = buildDefinedOccurrences({ recurringTransactions: [recurrence(1)], startDate: '2026-01-01', endDate: '2026-01-31' })
  assert.equal(once.length, 1)
  assert.deepEqual(once[0].bounds, { start: '2026-01-03', end: '2026-01-03' })
  assert.deepEqual(once[0].expectedDates, ['2026-01-03'])
  assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [recurrence(1)], startDate: '2026-02-01', endDate: '2026-02-28' }), [])

  const three = buildDefinedOccurrences({ recurringTransactions: [recurrence(3)], startDate: '2026-01-01', endDate: '2026-03-31' })
  assert.equal(three.length, 1)
  assert.deepEqual(three[0].bounds, { start: '2026-01-03', end: '2026-03-01' })
  assert.deepEqual(three[0].expectedDates, ['2026-01-03', '2026-02-01', '2026-03-01'])
  assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [recurrence(3)], startDate: '2026-03-02', endDate: '2026-08-31' }), [])
})

test('deduplicates finite first_date evidence and preserves authoritative weekend shifts', () => {
  const recurrence = {
    id: 'weekend-shifted-finite',
    attributes: {
      active: true,
      type: 'withdrawal',
      first_date: '2026-01-03',
      nr_of_repetitions: 3,
      repetitions: [{ type: 'monthly', moment: '1', occurrences: ['2026-03-02', '2026-01-03', '2026-02-02', '2026-01-03T12:00:00-05:00'] }],
      transactions: [{ amount: '100', description: 'Weekend finite', source_id: 'checking', destination_id: 'service', category_id: 'service' }],
    },
  }

  const result = buildDefinedOccurrences({ recurringTransactions: [recurrence], startDate: '2026-01-01', endDate: '2026-03-31' })

  assert.equal(result.length, 1)
  assert.deepEqual(result[0].bounds, { start: '2026-01-03', end: '2026-03-02' })
  assert.deepEqual(result[0].expectedDates, ['2026-01-03', '2026-02-02', '2026-03-02'])
  assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [recurrence], startDate: '2026-03-03', endDate: '2026-08-31' }), [])
})

test('uses the configured weekday after a shifted first weekly or biweekly occurrence', () => {
  const recurrence = ({ count, skip }) => ({
    id: `${skip === 1 ? 'biweekly' : 'weekly'}-${count}`,
    attributes: {
      active: true,
      type: 'withdrawal',
      first_date: '2026-01-06',
      nr_of_repetitions: count,
      repetitions: [{ type: 'weekly', moment: '1', skip }],
      transactions: [{ amount: '100', description: 'Shifted weekday', source_id: 'checking', destination_id: 'service', category_id: 'service' }],
    },
  })
  const expected = {
    weekly: {
      1: ['2026-01-06'],
      2: ['2026-01-06', '2026-01-12'],
      3: ['2026-01-06', '2026-01-12', '2026-01-19'],
    },
    biweekly: {
      1: ['2026-01-06'],
      2: ['2026-01-06', '2026-01-19'],
      3: ['2026-01-06', '2026-01-19', '2026-02-02'],
    },
  }

  for (const [name, skip] of [
    ['weekly', 0],
    ['biweekly', 1],
  ]) {
    for (const count of [1, 2, 3]) {
      const result = buildDefinedOccurrences({ recurringTransactions: [recurrence({ count, skip })], startDate: '2026-01-01', endDate: '2026-02-28' })
      assert.equal(result.length, 1)
      assert.deepEqual(result[0].expectedDates, expected[name][count])
      assert.equal(result[0].bounds.end, expected[name][count].at(-1))
      assert.deepEqual(buildDefinedOccurrences({ recurringTransactions: [recurrence({ count, skip })], startDate: '2026-02-03', endDate: '2026-08-31' }), [])
    }
  }
})

test('augments an accepted primary with one exact observed external-endpoint variant when cadence and amount align', () => {
  const primary = entriesForDates(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05'], {
    value: 100,
    destinationId: 'utility-primary',
    categoryId: 'utilities',
    description: 'Utility bill',
    idPrefix: 'utility-primary',
  })
  const minority = entry({ id: 'utility-minority', date: '2026-05-05', value: 100, destinationId: 'utility-secondary', categoryId: 'utilities', description: 'Utility bill' })

  const result = detectRecurringCandidates({ entries: [...primary, minority], startDate: '2026-01-01', endDate: '2026-06-10' })

  assert.equal(result.candidates.length, 1)
  const candidate = result.candidates[0]
  assert.deepEqual(candidate.evidence.transactionIds, [...primary.map(({ transactionId }) => transactionId), 'utility-minority'].sort())
  assert.deepEqual(
    candidate.identityVariants.map(({ identity, count }) => ({ destinationAccountId: identity.destinationAccountId, count })),
    [
      { destinationAccountId: 'utility-primary', count: 4 },
      { destinationAccountId: 'utility-secondary', count: 1 },
    ],
  )
  assert.equal(candidate.confidence.factors.identityStability, 0.8)
  assert.equal(
    result.audit.rejected.some(({ identity }) => identity.destinationAccountId === 'utility-secondary'),
    false,
  )

  const observed = entry({ id: 'utility-observed', date: '2026-06-05', value: 100, destinationId: 'utility-secondary', categoryId: 'utilities', description: 'Utility bill' })
  const unseen = entry({ id: 'utility-unseen', date: '2026-06-05', value: 100, destinationId: 'utility-third', categoryId: 'utilities', description: 'Utility bill' })
  assert.equal(matchRecurringOccurrences({ candidates: [candidate], actualEntries: [observed], today: '2026-06-05' }).fulfilled.length, 1)
  assert.equal(matchRecurringOccurrences({ candidates: [candidate], actualEntries: [unseen], today: '2026-06-05' }).fulfilled.length, 0)
})

test('does not augment an external-endpoint variant whose phase and amount conflict with the primary', () => {
  const primary = entriesForDates(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'], {
    value: 100,
    destinationId: 'safe-primary',
    categoryId: 'service',
    description: 'Same payee',
    idPrefix: 'safe-primary',
  })
  const conflicting = entry({ id: 'unsafe-minority', date: '2026-05-20', value: 500, destinationId: 'unsafe-secondary', categoryId: 'service', description: 'Same payee' })

  const result = detectRecurringCandidates({ entries: [...primary, conflicting], startDate: '2026-01-01', endDate: '2026-06-10' })

  assert.equal(result.candidates.length, 1)
  assert.deepEqual(
    result.candidates[0].evidence.transactionIds,
    primary.map(({ transactionId }) => transactionId),
  )
  assert.ok(result.audit.rejected.some(({ identity }) => identity.destinationAccountId === 'unsafe-secondary'))
})

test('never collapses interleaved day-1 $100 and day-20 $500 same-payee histories into one candidate', () => {
  const entries = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].flatMap((month, index) => [
    entry({ id: `phase-one-${index}`, date: `${month}-01`, value: 100, destinationId: 'shared-service', categoryId: 'service', description: 'Shared service' }),
    entry({ id: `phase-twenty-${index}`, date: `${month}-20`, value: 500, destinationId: 'shared-service', categoryId: 'service', description: 'Shared service' }),
  ])

  const result = detectRecurringCandidates({ entries, startDate: '2026-01-01', endDate: '2026-06-10' })

  assert.equal(result.candidates.length, 0)
  assert.ok(result.audit.rejected.length > 0)
})

test('canonicalizes ambiguous and duplicate monthly streams byte-for-byte under shuffled input', () => {
  const repetitions = [
    { type: 'monthly', moment: '15', occurrences: ['2026-09-15', '2026-08-15'] },
    { type: 'monthly', moment: '31', occurrences: ['2026-08-31', '2026-09-30'] },
    { type: 'monthly', moment: '16', occurrences: ['2026-08-16', '2026-09-16'] },
    { type: 'monthly', moment: '15', occurrences: ['2026-08-15', '2026-09-15'] },
  ]
  const recurrence = (orderedRepetitions) => ({
    id: 'ambiguous-monthly',
    attributes: {
      active: true,
      type: 'deposit',
      first_date: '2026-08-15',
      repetitions: orderedRepetitions,
      transactions: [{ amount: '3000', description: 'Ambiguous payroll', source_id: 'employer', destination_id: 'checking', category_id: 'salary' }],
    },
  })

  const ordered = buildDefinedOccurrences({ recurringTransactions: [recurrence(repetitions)], startDate: '2026-08-01', endDate: '2026-09-30' })
  const shuffled = buildDefinedOccurrences({ recurringTransactions: [recurrence([repetitions[3], repetitions[2], repetitions[0], repetitions[1]])], startDate: '2026-08-01', endDate: '2026-09-30' })

  assert.equal(ordered.length, 3)
  assert.ok(ordered.every(({ cadence }) => cadence.type === 'monthly'))
  assert.equal(new Set(ordered.map(({ id }) => id)).size, 3)
  assert.equal(JSON.stringify(shuffled), JSON.stringify(ordered))
  const dayFifteen = ordered.find(({ cadence }) => cadence.days[0] === 15)
  assert.deepEqual(dayFifteen.definitionAudit, {
    authoritativeOccurrenceDates: ['2026-08-15', '2026-09-15'],
    canonicalStreams: [{ cadence: { type: 'monthly', days: [15] }, authoritativeOccurrenceDates: ['2026-08-15', '2026-09-15'] }],
    sourceRepetitionCount: 2,
    duplicateRepetitionCount: 1,
  })
})
