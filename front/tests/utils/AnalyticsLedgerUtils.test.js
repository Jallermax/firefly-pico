import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAnalyticsLedger } from '../../utils/AnalyticsLedgerUtils.js'

const account = ({ id, type, role = null, includeNetWorth = true, balance = '0' }) => ({
  id,
  attributes: {
    type: { fireflyCode: type },
    account_role: role ? { fireflyCode: role } : null,
    include_net_worth: includeNetWorth,
    current_balance: balance,
  },
})

const split = ({ journalId, amount, date, source, destination, categoryId = null, tags = [], currencyCode = 'USD', primaryAmount = null }) => ({
  transaction_journal_id: journalId,
  amount: String(amount),
  primary_amount: primaryAmount,
  currency_code: currencyCode,
  date,
  source_id: source.id,
  destination_id: destination.id,
  category_id: categoryId,
  tags,
})

const transaction = (id, parts) => ({ id, attributes: { transactions: parts } })

const checking = account({ id: 'checking', type: 'asset' })
const creditCard = account({ id: 'credit-card', type: 'asset', role: 'ccAsset', balance: '-400' })
const savingsAccessible = account({ id: 'saving-accessible', type: 'asset', role: 'savingAsset', includeNetWorth: true })
const savingsRestricted = account({ id: 'saving-restricted', type: 'asset', role: 'savingAsset', includeNetWorth: false })
const loan = account({ id: 'loan', type: 'liabilities' })
const revenue = account({ id: 'revenue', type: 'revenue' })
const expense = account({ id: 'expense', type: 'expense' })
const accounts = [checking, creditCard, savingsAccessible, savingsRestricted, loan, revenue, expense]

const build = ({ transactions, transactionLinks = [], ledgerAccounts = accounts, rates = { USD: 1, EUR: 0.9 } }) =>
  buildAnalyticsLedger({ transactions, transactionLinks, accounts: ledgerAccounts, displayCurrencyCode: 'USD', primaryCurrencyCode: 'USD', rates })

test('normalizes each split with stable provenance and fresh account roles', () => {
  const ledger = build({
    transactions: [
      transaction('expense-group', [split({ journalId: 'purchase-journal', amount: 100, date: '2026-01-15', source: checking, destination: expense, categoryId: 'food' })]),
      transaction('income-group', [split({ journalId: 'income-journal', amount: 200, date: '2026-01-16', source: revenue, destination: checking, categoryId: 'salary' })]),
      transaction('transfer-group', [split({ journalId: 'transfer-journal', amount: 30, date: '2026-01-17', source: checking, destination: creditCard })]),
      transaction('saving-group', [split({ journalId: 'saving-journal', amount: 40, date: '2026-01-18', source: checking, destination: savingsAccessible })]),
      transaction('liability-group', [split({ journalId: 'loan-journal', amount: 50, date: '2026-01-19', source: checking, destination: loan })]),
      transaction('multi-group', [
        split({ journalId: 'multi-one', amount: 10, date: '2026-01-20', source: checking, destination: expense, categoryId: 'food' }),
        split({ journalId: 'multi-two', amount: 20, date: '2026-01-20', source: checking, destination: expense, categoryId: 'travel' }),
      ]),
    ],
  })

  assert.equal(ledger.entries.length, 7)
  assert.deepEqual(
    ledger.entries.map(({ id, transactionId, journalId, splitIndex }) => ({ id, transactionId, journalId, splitIndex })),
    [
      { id: 'expense-group:purchase-journal:0', transactionId: 'expense-group', journalId: 'purchase-journal', splitIndex: 0 },
      { id: 'income-group:income-journal:0', transactionId: 'income-group', journalId: 'income-journal', splitIndex: 0 },
      { id: 'transfer-group:transfer-journal:0', transactionId: 'transfer-group', journalId: 'transfer-journal', splitIndex: 0 },
      { id: 'saving-group:saving-journal:0', transactionId: 'saving-group', journalId: 'saving-journal', splitIndex: 0 },
      { id: 'liability-group:loan-journal:0', transactionId: 'liability-group', journalId: 'loan-journal', splitIndex: 0 },
      { id: 'multi-group:multi-one:0', transactionId: 'multi-group', journalId: 'multi-one', splitIndex: 0 },
      { id: 'multi-group:multi-two:1', transactionId: 'multi-group', journalId: 'multi-two', splitIndex: 1 },
    ],
  )
  assert.deepEqual(
    ledger.entries.map(({ sourceKind, destinationKind }) => [sourceKind, destinationKind]),
    [
      ['available', 'expense'],
      ['revenue', 'available'],
      ['available', 'available'],
      ['available', 'savingsAccessible'],
      ['available', 'liability'],
      ['available', 'expense'],
      ['available', 'expense'],
    ],
  )
  assert.equal(ledger.entries[2].destinationAccount.id, 'credit-card')
  assert.equal(ledger.entries[2].destinationKind, 'available')
  assert.deepEqual(ledger.months['2026-01'], {
    entryIds: ledger.entries.map(({ id }) => id),
    transactionIds: ['expense-group', 'income-group', 'liability-group', 'multi-group', 'saving-group', 'transfer-group'],
  })
})

test('deduplicates linked and tagged refunds while preserving cash and coverage timing', () => {
  const ledger = build({
    transactions: [
      transaction('purchase-group', [split({ journalId: 'purchase-journal', amount: 100, date: '2026-01-15', source: checking, destination: expense, categoryId: 'food' })]),
      transaction('linked-refund-group', [split({ journalId: 'refund-journal', amount: 40, date: '2026-02-04', source: expense, destination: checking, categoryId: 'misc', tags: ['#refund'] })]),
      transaction('tag-refund-group', [split({ journalId: 'tag-refund-journal', amount: 12, date: '2026-02-05', source: expense, destination: checking, categoryId: 'books', tags: ['#refund'] })]),
    ],
    transactionLinks: [
      {
        id: 'refund-link',
        attributes: {
          link_type: { name: 'Refund', inward: 'refunded', outward: 'refund' },
          inward_id: 'purchase-journal',
          outward_id: 'refund-journal',
        },
      },
    ],
  })

  const linked = ledger.entries.find(({ transactionId }) => transactionId === 'linked-refund-group')
  const tagOnly = ledger.entries.find(({ transactionId }) => transactionId === 'tag-refund-group')
  assert.equal(linked.value, 40)
  assert.equal(linked.date, '2026-02-04')
  assert.equal(linked.monthKey, '2026-02')
  assert.deepEqual(linked.refund, {
    isRefund: true,
    signals: ['link', 'tag'],
    linkedPurchaseTransactionId: 'purchase-group',
    linkedPurchaseMonthKey: '2026-01',
    coverageCategoryId: 'food',
    coverageMonthKey: '2026-01',
    coverageValue: 40,
    isLinked: true,
  })
  assert.equal(tagOnly.value, 12)
  assert.deepEqual(tagOnly.refund, {
    isRefund: true,
    signals: ['tag'],
    linkedPurchaseTransactionId: null,
    linkedPurchaseMonthKey: null,
    coverageCategoryId: 'books',
    coverageMonthKey: '2026-02',
    coverageValue: 12,
    isLinked: false,
  })
  assert.deepEqual(ledger.audit.unmatchedRefundLinkIds, [])
})

test('reports unavailable FX and unknown endpoints without inventing zero values', () => {
  const unknown = { id: 'missing-account' }
  const ledger = build({
    transactions: [
      transaction('missing-fx-group', [split({ journalId: 'fx-journal', amount: 90, date: '2026-03-01', source: revenue, destination: checking, currencyCode: 'EUR' })]),
      transaction('unknown-group', [split({ journalId: 'unknown-journal', amount: 15, date: '2026-03-02', source: unknown, destination: expense, categoryId: 'food' })]),
    ],
    transactionLinks: [
      {
        id: 'unmatched-refund-link',
        attributes: {
          link_type: { name: 'Refund' },
          inward_id: 'not-in-ledger',
          outward_id: 'also-not-in-ledger',
        },
      },
    ],
    rates: { USD: 1 },
  })

  const missingFx = ledger.entries.find(({ transactionId }) => transactionId === 'missing-fx-group')
  assert.equal(missingFx.value, null)
  assert.deepEqual(missingFx.conversion, { mode: 'unavailable', sourceCurrency: 'EUR', missingCurrency: 'EUR' })
  assert.deepEqual(ledger.fx, { isEstimated: false, missingCurrencies: ['EUR'], transactionIds: ['missing-fx-group'] })
  assert.equal(ledger.entries.find(({ transactionId }) => transactionId === 'unknown-group').sourceKind, 'unknown')
  assert.deepEqual(ledger.audit, { unclassifiedValue: 15, transactionIds: ['unknown-group'], unmatchedRefundLinkIds: ['unmatched-refund-link'] })
})
