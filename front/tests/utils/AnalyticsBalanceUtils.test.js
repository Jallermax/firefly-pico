import assert from 'node:assert/strict'
import test from 'node:test'

import { reconstructBalanceSeries } from '../../utils/AnalyticsBalanceUtils.js'
import { buildAnalyticsLedger } from '../../utils/AnalyticsLedgerUtils.js'

const account = ({
  id,
  type = 'asset',
  role = 'defaultAsset',
  includeNetWorth = true,
  balance = '0',
  virtualBalance = '0',
  currentDebt = null,
  debtAmount = null,
  balanceDate = '2026-04-15T12:00:00-04:00',
  currencyCode = 'USD',
  direction = null,
}) => ({
  id,
  attributes: {
    active: true,
    type: { fireflyCode: type },
    account_role: role ? { fireflyCode: role } : null,
    include_net_worth: includeNetWorth,
    current_balance: balance,
    virtual_balance: virtualBalance,
    current_debt: currentDebt,
    debt_amount: debtAmount,
    current_balance_date: balanceDate,
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
  coverage: { startMonth: '2025-12', endDate: '2026-04-15' },
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

test('uses Firefly virtual balances for net worth and current debt for liability totals', () => {
  const cardWithLimit = account({ id: 'card-with-limit', role: 'ccAsset', balance: '290.99', virtualBalance: '500' })
  const partlyRepaidLoan = account({ id: 'partly-repaid-loan', type: 'liabilities', role: null, balance: '-3000', virtualBalance: '-2000', debtAmount: '1000', direction: 'debit' })

  const netWorth = reconstructBalanceSeries({ ...baseArgs, accounts: [cardWithLimit, partlyRepaidLoan], entries: [], metric: 'netWorth', monthKeys: [] })
  const debt = reconstructBalanceSeries({ ...baseArgs, accounts: [cardWithLimit, partlyRepaidLoan], entries: [], metric: 'debt', monthKeys: [] })

  assert.equal(netWorth.currentPoint.value, -1209.01)
  assert.deepEqual(
    netWorth.accountBreakdown.map(({ id, anchorValue }) => ({ id, anchorValue })),
    [
      { id: 'card-with-limit', anchorValue: -209.01 },
      { id: 'partly-repaid-loan', anchorValue: -1000 },
    ],
  )
  assert.equal(debt.currentPoint.value, 1000)
  assert.deepEqual(
    debt.accountBreakdown.map(({ id, anchorValue }) => ({ id, anchorValue })),
    [{ id: 'partly-repaid-loan', anchorValue: -1000 }],
  )
})

test('uses exact primary-currency balance and virtual-balance fields when Firefly provides them', () => {
  const euroCard = account({ id: 'euro-card', role: 'ccAsset', balance: '90', virtualBalance: '10', currencyCode: 'EUR' })
  euroCard.attributes.pc_current_balance = '100'
  euroCard.attributes.pc_virtual_balance = '11'

  const result = reconstructBalanceSeries({ ...baseArgs, accounts: [euroCard], entries: [], metric: 'netWorth', monthKeys: [], rates: { USD: 1, EUR: 0.9 } })

  assert.deepEqual(result.currentPoint, { x: '2026-04-15', value: 89, transactionIds: [] })
  assert.deepEqual(result.fx, { isEstimated: false, missingCurrencies: [], transactionIds: [] })
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

test('counts only Available, Savings, and Liability funded gross expenses', () => {
  const secondExpense = account({ id: 'second-expense', type: 'expense', role: null, includeNetWorth: false })
  const unknown = { id: 'unknown-source' }
  const expenseLedger = buildAnalyticsLedger({
    accounts: [...accounts, secondExpense],
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('savings-accessible-funded', split({ amount: 11, date: '2026-02-01', source: accessibleSavings, destination: expense })),
      transaction('savings-restricted-funded', split({ amount: 12, date: '2026-02-02', source: restrictedSavings, destination: expense })),
      transaction('liability-funded', split({ amount: 13, date: '2026-02-03', source: loan, destination: expense })),
      transaction('revenue-not-expense', split({ amount: 20, date: '2026-02-04', source: revenue, destination: expense })),
      transaction('expense-not-expense', split({ amount: 21, date: '2026-02-05', source: secondExpense, destination: expense })),
      transaction('unknown-not-expense', split({ amount: 22, date: '2026-02-06', source: unknown, destination: expense })),
    ],
  })

  const result = reconstructBalanceSeries({ ...baseArgs, entries: expenseLedger.entries, metric: 'expenses', monthKeys: ['2026-02'] })

  assert.deepEqual(result.points, [
    {
      x: '2026-02-28',
      value: 36,
      transactionIds: ['liability-funded', 'savings-accessible-funded', 'savings-restricted-funded'],
    },
  ])
  assert.deepEqual(result.fx.transactionIds, [])
})

test('uses only explicit fetch coverage and keeps missing account or FX values unavailable', () => {
  const missingBalanceAccounts = [{ ...checking, attributes: { ...checking.attributes, current_balance: null } }, revenue, expense]
  const missingBalance = reconstructBalanceSeries({ ...baseArgs, accounts: missingBalanceAccounts, metric: 'netWorth' })
  assert.deepEqual(
    missingBalance.points.map(({ value }) => value),
    [null, null, null, null],
  )
  assert.equal(missingBalance.currentPoint, null)
  assert.equal(missingBalance.reconciliation.status, 'unavailable')

  const absentCoverage = reconstructBalanceSeries({ ...baseArgs, coverage: undefined, metric: 'expenses' })
  assert.deepEqual(
    absentCoverage.points.map(({ value }) => value),
    [null, null, null, null],
  )
  assert.deepEqual(absentCoverage.coverage, { startMonth: null, endDate: null, completeMonths: [], unavailableMonths: ['2025-12', '2026-01', '2026-02', '2026-03'] })

  const coveredEmpty = reconstructBalanceSeries({ ...baseArgs, entries: [], metric: 'expenses', monthKeys: ['2025-12', '2026-01'] })
  assert.deepEqual(coveredEmpty.points, [
    { x: '2025-12-31', value: 0, transactionIds: [] },
    { x: '2026-01-31', value: 0, transactionIds: [] },
  ])

  const januaryOnly = reconstructBalanceSeries({
    ...baseArgs,
    accounts: [checking, creditCard, revenue, expense],
    entries: ledger.entries.filter(({ monthKey }) => monthKey >= '2026-01'),
    coverage: { startMonth: '2026-01', endDate: '2026-02-28' },
    metric: 'expenses',
    monthKeys: ['2025-12', '2026-01', '2026-02'],
  })
  assert.deepEqual(januaryOnly.points, [
    { x: '2025-12-31', value: null, transactionIds: [] },
    { x: '2026-01-31', value: 100, transactionIds: ['january-expense'] },
    { x: '2026-02-28', value: 0, transactionIds: [] },
  ])
  assert.deepEqual(januaryOnly.coverage, { startMonth: '2026-01', endDate: '2026-02-28', completeMonths: ['2026-01', '2026-02'], unavailableMonths: ['2025-12'] })

  const truncatedBalance = reconstructBalanceSeries({ ...baseArgs, coverage: { startMonth: '2025-12', endDate: '2026-03-31' }, metric: 'netWorth' })
  assert.deepEqual(
    truncatedBalance.points.map(({ value }) => value),
    [null, null, null, null],
  )

  const missingFxEntry = {
    ...ledger.entries.find(({ transactionId }) => transactionId === 'january-expense'),
    value: null,
    conversion: { mode: 'unavailable', sourceCurrency: 'EUR', missingCurrency: 'EUR' },
  }
  const missingFx = reconstructBalanceSeries({ ...baseArgs, entries: [missingFxEntry], metric: 'expenses', monthKeys: ['2025-12', '2026-01'] })
  assert.deepEqual(
    missingFx.points.map(({ value }) => value),
    [0, null],
  )
  assert.deepEqual(missingFx.fx, { isEstimated: false, missingCurrencies: ['EUR'], transactionIds: ['january-expense'] })
})

test('converts fresh anchors and reconciles only post-marker movements through the same as-of date', () => {
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

  const staleChecking = account({ id: 'stale-checking', balance: '870', balanceDate: '2026-04-10T23:59:59-04:00' })
  const reconciliationEntries = buildAnalyticsLedger({
    accounts: [staleChecking, expense],
    transactions: [
      transaction('same-snapshot-expense', split({ amount: 20, date: '2026-04-12', source: staleChecking, destination: expense })),
      transaction('post-as-of-expense', split({ amount: 30, date: '2026-04-16', source: staleChecking, destination: expense })),
    ],
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
  }).entries
  const mismatch = reconstructBalanceSeries({ ...baseArgs, accounts: [staleChecking, expense], entries: reconciliationEntries, metric: 'netWorth', monthKeys: ['2026-03'] })
  assert.deepEqual(mismatch.reconciliation, {
    status: 'mismatch',
    anchorValue: 870,
    reconstructedValue: 850,
    delta: -20,
    accounts: [{ id: 'stale-checking', anchorValue: 870, reconstructedValue: 850, delta: -20, transactionIds: ['same-snapshot-expense'] }],
  })

  const toleranceEntries = [{ ...reconciliationEntries[0], value: 0.01 }, reconciliationEntries[1]]
  const withinTolerance = reconstructBalanceSeries({
    ...baseArgs,
    accounts: [staleChecking, expense],
    entries: toleranceEntries,
    metric: 'netWorth',
    monthKeys: ['2026-03'],
  })
  assert.equal(withinTolerance.reconciliation.status, 'ok')

  const noMarker = account({ id: 'no-marker', balance: '50', balanceDate: null })
  const noMarkerEntry = buildAnalyticsLedger({
    accounts: [noMarker, expense],
    transactions: [transaction('unprovable-expense', split({ amount: 10, date: '2026-04-12', source: noMarker, destination: expense }))],
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
  }).entries
  const noMarkerResult = reconstructBalanceSeries({ ...baseArgs, accounts: [noMarker, expense], entries: noMarkerEntry, metric: 'netWorth', monthKeys: [] })
  assert.deepEqual(noMarkerResult.reconciliation, { status: 'ok', anchorValue: 50, reconstructedValue: 50, delta: 0, accounts: [] })
})

test('normalizes liability signs per account without rounding away sub-minor-unit balances', () => {
  const smallDebit = account({ id: 'small-debit', type: 'liabilities', role: null, balance: '-0.006', direction: 'debit' })
  const smallCredit = account({ id: 'small-credit', type: 'liabilities', role: null, balance: '0.006', direction: 'credit' })
  const result = reconstructBalanceSeries({ ...baseArgs, accounts: [smallDebit, smallCredit], entries: [], metric: 'debt', monthKeys: [] })

  assert.equal(result.currentPoint.value, 0.012)
})
