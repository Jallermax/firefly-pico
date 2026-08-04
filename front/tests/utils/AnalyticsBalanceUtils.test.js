import assert from 'node:assert/strict'
import test from 'node:test'

import { reconstructBalanceSeries } from '../../utils/AnalyticsBalanceUtils.js'
import { buildAnalyticsLedger } from '../../utils/AnalyticsLedgerUtils.js'

const account = ({ id, type = 'asset', role = 'defaultAsset', includeNetWorth = true, balance = '0', currencyCode = 'USD', direction = null }) => ({
  id,
  attributes: {
    active: true,
    type: { fireflyCode: type },
    account_role: role ? { fireflyCode: role } : null,
    include_net_worth: includeNetWorth,
    current_balance: balance,
    currency_code: currencyCode,
    liability_direction: direction ? { fireflyCode: direction } : null,
  },
})

const checking = account({ id: 'checking', balance: '870' })
const creditCard = account({ id: 'credit-card', role: 'ccAsset', balance: '-120' })
const accessibleSavings = account({ id: 'accessible-savings', role: 'savingAsset', balance: '350' })
const restrictedSavings = account({ id: 'restricted-savings', role: 'savingAsset', includeNetWorth: false, balance: '200' })
const loan = account({ id: 'loan', type: 'liabilities', role: null, balance: '-60', direction: 'debit' })
const receivable = account({ id: 'receivable', type: 'liabilities', role: null, balance: '25', direction: 'credit' })
const revenue = account({ id: 'revenue', type: 'revenue', role: null, includeNetWorth: false })
const expense = account({ id: 'expense', type: 'expense', role: null, includeNetWorth: false })
const accounts = [checking, creditCard, accessibleSavings, restrictedSavings, loan, receivable, revenue, expense]

const split = ({ amount, date, source, destination }) => ({
  transaction_journal_id: `${date}:${source.id}:${destination.id}`,
  amount: String(amount),
  currency_code: 'USD',
  date,
  source_id: source.id,
  destination_id: destination.id,
})
const transaction = (id, value) => ({ id, attributes: { transactions: [value] } })

const ledger = buildAnalyticsLedger({
  accounts,
  displayCurrencyCode: 'USD',
  primaryCurrencyCode: 'USD',
  rates: { USD: 1 },
  transactions: [
    transaction('coverage-transfer', split({ amount: 5, date: '2025-12-15', source: checking, destination: creditCard })),
    transaction('january-expense', split({ amount: 100, date: '2026-01-15', source: checking, destination: expense })),
    transaction('january-income', split({ amount: 200, date: '2026-01-20', source: revenue, destination: checking })),
    transaction('february-transfer', split({ amount: 30, date: '2026-02-05', source: checking, destination: creditCard })),
    transaction('savings-deposit', split({ amount: 40, date: '2026-02-10', source: checking, destination: accessibleSavings })),
    transaction('savings-withdrawal', split({ amount: 10, date: '2026-03-03', source: accessibleSavings, destination: checking })),
    transaction('debt-payment', split({ amount: 20, date: '2026-03-08', source: checking, destination: loan })),
  ],
})

const baseArgs = {
  accounts,
  entries: ledger.entries,
  monthKeys: ['2025-12', '2026-01', '2026-02', '2026-03'],
  asOfDate: '2026-04-15',
  displayCurrencyCode: 'USD',
  primaryCurrencyCode: 'USD',
  rates: { USD: 1 },
  currencyDecimalPlaces: 2,
}

const values = (result) => result.points.map(({ x, value }) => ({ x, value }))

test('rewinds fresh signed account anchors per account without turning credit-card assets into debt', () => {
  const netWorth = reconstructBalanceSeries({ ...baseArgs, metric: 'netWorth' })
  const savings = reconstructBalanceSeries({ ...baseArgs, metric: 'savings' })
  const accessible = reconstructBalanceSeries({ ...baseArgs, metric: 'savingsIncluded' })
  const restricted = reconstructBalanceSeries({ ...baseArgs, metric: 'savingsExcluded' })
  const debt = reconstructBalanceSeries({ ...baseArgs, metric: 'debt' })

  assert.deepEqual(values(netWorth), [
    { x: '2025-12-31', value: 965 },
    { x: '2026-01-31', value: 1065 },
    { x: '2026-02-28', value: 1065 },
    { x: '2026-03-31', value: 1065 },
  ])
  assert.deepEqual(netWorth.currentPoint, { x: '2026-04-15', value: 1065, transactionIds: [] })
  assert.deepEqual(netWorth.reconciliation, {
    status: 'ok',
    anchorValue: 1065,
    reconstructedValue: 1065,
    delta: 0,
    accounts: [],
  })
  assert.deepEqual(values(savings), [
    { x: '2025-12-31', value: 520 },
    { x: '2026-01-31', value: 520 },
    { x: '2026-02-28', value: 560 },
    { x: '2026-03-31', value: 550 },
  ])
  assert.deepEqual(values(accessible), [
    { x: '2025-12-31', value: 320 },
    { x: '2026-01-31', value: 320 },
    { x: '2026-02-28', value: 360 },
    { x: '2026-03-31', value: 350 },
  ])
  assert.deepEqual(values(restricted), [
    { x: '2025-12-31', value: 200 },
    { x: '2026-01-31', value: 200 },
    { x: '2026-02-28', value: 200 },
    { x: '2026-03-31', value: 200 },
  ])
  assert.deepEqual(values(debt), [
    { x: '2025-12-31', value: 105 },
    { x: '2026-01-31', value: 105 },
    { x: '2026-02-28', value: 105 },
    { x: '2026-03-31', value: 85 },
  ])
  assert.equal(debt.currentPoint.value, 85)
  assert.deepEqual(
    debt.accountBreakdown.map(({ id, anchorValue }) => ({ id, anchorValue })),
    [
      { id: 'loan', anchorValue: -60 },
      { id: 'receivable', anchorValue: 25 },
    ],
  )
  assert.equal(
    debt.accountBreakdown.some(({ id }) => id === 'credit-card'),
    false,
  )
})

test('emits completed gross-expense zeros and exact transaction evidence', () => {
  const result = reconstructBalanceSeries({ ...baseArgs, metric: 'expenses' })

  assert.deepEqual(result.points, [
    { x: '2025-12-31', value: 0, transactionIds: [] },
    { x: '2026-01-31', value: 100, transactionIds: ['january-expense'] },
    { x: '2026-02-28', value: 0, transactionIds: [] },
    { x: '2026-03-31', value: 0, transactionIds: [] },
  ])
  assert.deepEqual(result.currentPoint, { x: '2026-04-15', value: 0, transactionIds: [] })
})

test('keeps months before ledger coverage and missing account or FX values unavailable', () => {
  const missingBalanceAccounts = [{ ...checking, attributes: { ...checking.attributes, current_balance: null } }, revenue, expense]
  const missingBalance = reconstructBalanceSeries({ ...baseArgs, accounts: missingBalanceAccounts, metric: 'netWorth' })
  assert.deepEqual(
    missingBalance.points.map(({ value }) => value),
    [null, null, null, null],
  )
  assert.equal(missingBalance.currentPoint, null)
  assert.equal(missingBalance.reconciliation.status, 'unavailable')

  const januaryOnly = reconstructBalanceSeries({
    ...baseArgs,
    accounts: [checking, creditCard, revenue, expense],
    entries: ledger.entries.filter(({ monthKey }) => monthKey >= '2026-01'),
    metric: 'expenses',
    monthKeys: ['2025-12', '2026-01', '2026-02'],
  })
  assert.deepEqual(januaryOnly.points, [
    { x: '2025-12-31', value: null, transactionIds: [] },
    { x: '2026-01-31', value: 100, transactionIds: ['january-expense'] },
    { x: '2026-02-28', value: 0, transactionIds: [] },
  ])
  assert.deepEqual(januaryOnly.coverage, { startMonth: '2026-01', endDate: '2026-04-15', completeMonths: ['2026-01', '2026-02'], unavailableMonths: ['2025-12'] })

  const missingFxEntry = {
    ...ledger.entries.find(({ transactionId }) => transactionId === 'january-expense'),
    value: null,
    conversion: { mode: 'unavailable', sourceCurrency: 'EUR', missingCurrency: 'EUR' },
  }
  const missingFx = reconstructBalanceSeries({ ...baseArgs, entries: [ledger.entries[0], missingFxEntry], metric: 'expenses', monthKeys: ['2025-12', '2026-01'] })
  assert.deepEqual(
    missingFx.points.map(({ value }) => value),
    [0, null],
  )
  assert.deepEqual(missingFx.fx, { isEstimated: false, missingCurrencies: ['EUR'], transactionIds: ['january-expense'] })
})

test('converts fresh anchors with current rates and uses one minor unit for reconciliation', () => {
  const euroChecking = account({ id: 'euro-checking', balance: '90', currencyCode: 'EUR' })
  const converted = reconstructBalanceSeries({
    ...baseArgs,
    accounts: [euroChecking],
    entries: [],
    metric: 'netWorth',
    monthKeys: [],
    rates: { USD: 1, EUR: 0.9 },
  })
  assert.deepEqual(converted.currentPoint, { x: '2026-04-15', value: 100, transactionIds: [], isEstimated: true })
  assert.deepEqual(converted.fx, { isEstimated: true, missingCurrencies: [], transactionIds: [] })

  const futureEntry = buildAnalyticsLedger({
    accounts: [checking, expense],
    transactions: [transaction('future-expense', split({ amount: 0.02, date: '2026-04-16', source: checking, destination: expense }))],
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
  }).entries
  const mismatch = reconstructBalanceSeries({ ...baseArgs, accounts: [checking, expense], entries: [ledger.entries[0], ...futureEntry], metric: 'netWorth', monthKeys: ['2026-03'] })
  assert.equal(mismatch.points[0].value, 870)
  assert.deepEqual(mismatch.reconciliation, {
    status: 'mismatch',
    anchorValue: 870,
    reconstructedValue: 870.02,
    delta: 0.02,
    accounts: [{ id: 'checking', anchorValue: 870, reconstructedValue: 870.02, delta: 0.02, transactionIds: ['future-expense'] }],
  })

  const withinTolerance = reconstructBalanceSeries({
    ...baseArgs,
    accounts: [checking, expense],
    entries: [ledger.entries[0], { ...futureEntry[0], value: 0.01 }],
    metric: 'netWorth',
    monthKeys: ['2026-03'],
  })
  assert.equal(withinTolerance.reconciliation.status, 'ok')
})

test('normalizes liability signs per account without rounding away sub-minor-unit balances', () => {
  const smallDebit = account({ id: 'small-debit', type: 'liabilities', role: null, balance: '-0.006', direction: 'debit' })
  const smallCredit = account({ id: 'small-credit', type: 'liabilities', role: null, balance: '0.006', direction: 'credit' })
  const result = reconstructBalanceSeries({ ...baseArgs, accounts: [smallDebit, smallCredit], entries: [], metric: 'debt', monthKeys: [] })

  assert.equal(result.currentPoint.value, 0.012)
})
