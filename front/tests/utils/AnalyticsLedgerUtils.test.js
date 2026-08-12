import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

const split = ({ journalId, amount, date, source, destination, categoryId = null, categoryName = null, description = null, tags = [], currencyCode = 'USD', primaryAmount = null }) => ({
  transaction_journal_id: journalId,
  amount: String(amount),
  primary_amount: primaryAmount,
  currency_code: currencyCode,
  date,
  source_id: source.id,
  destination_id: destination.id,
  category_id: categoryId,
  category_name: categoryName,
  description,
  tags,
})

const transaction = (id, parts, tags = []) => ({ id, attributes: { transactions: parts, tags } })

const checking = account({ id: 'checking', type: 'asset' })
const creditCard = account({ id: 'credit-card', type: 'asset', role: 'ccAsset', balance: '-400' })
const savingsAccessible = account({ id: 'saving-accessible', type: 'asset', role: 'savingAsset', includeNetWorth: true })
const savingsRestricted = account({ id: 'saving-restricted', type: 'asset', role: 'savingAsset', includeNetWorth: false })
const loan = account({ id: 'loan', type: 'liabilities' })
const revenue = account({ id: 'revenue', type: 'revenue' })
const expense = account({ id: 'expense', type: 'expense' })
const accounts = [checking, creditCard, savingsAccessible, savingsRestricted, loan, revenue, expense]
const refundLinkType = { id: 'refund-type', attributes: { name: 'Refund', inward: 'refunded', outward: 'refund' } }
const refundLinkTypeByOutward = { id: 'refund-type-by-outward', attributes: { name: 'Transaction relationship', inward: 'refunded', outward: 'refund' } }
const noRefund = () => ({
  isRefund: false,
  signals: [],
  linkedPurchaseTransactionId: null,
  linkedPurchaseMonthKey: null,
  coverageCategoryId: null,
  coverageMonthKey: null,
  coverageValue: null,
  isLinked: false,
})

const build = ({ transactions, transactionLinks = [], linkTypes = [], ledgerAccounts = accounts, rates = { USD: 1, EUR: 0.9 } }) =>
  buildAnalyticsLedger({ transactions, transactionLinks, linkTypes, accounts: ledgerAccounts, displayCurrencyCode: 'USD', primaryCurrencyCode: 'USD', rates })

test('normalizes each split with stable provenance and fresh account roles', () => {
  const ledger = build({
    transactions: [
      transaction('expense-group', [
        split({ journalId: 'purchase-journal', amount: 100, date: '2026-01-15', source: checking, destination: expense, categoryId: 'food', categoryName: 'Groceries', description: 'Grocery split' }),
      ]),
      transaction('income-group', [split({ journalId: 'income-journal', amount: 200, date: '2026-01-16', source: revenue, destination: checking, categoryId: 'salary' })]),
      transaction('transfer-group', [split({ journalId: 'transfer-journal', amount: 30, date: '2026-01-17', source: checking, destination: creditCard })]),
      transaction('saving-group', [split({ journalId: 'saving-journal', amount: 40, date: '2026-01-18', source: checking, destination: savingsAccessible })]),
      transaction('restricted-saving-group', [split({ journalId: 'restricted-saving-journal', amount: 60, date: '2026-01-18', source: checking, destination: savingsRestricted })]),
      transaction('liability-group', [split({ journalId: 'loan-journal', amount: 50, date: '2026-01-19', source: checking, destination: loan })]),
      transaction('multi-group', [
        split({ journalId: 'multi-one', amount: 10, date: '2026-01-20', source: checking, destination: expense, categoryId: 'food' }),
        split({ journalId: 'multi-two', amount: 20, date: '2026-01-20', source: checking, destination: expense, categoryId: 'travel' }),
      ]),
    ],
  })

  assert.equal(ledger.entries.length, 8)
  assert.deepEqual(
    ledger.entries.map(({ id, transactionId, journalId, splitIndex }) => ({ id, transactionId, journalId, splitIndex })),
    [
      { id: 'expense-group:purchase-journal:0', transactionId: 'expense-group', journalId: 'purchase-journal', splitIndex: 0 },
      { id: 'income-group:income-journal:0', transactionId: 'income-group', journalId: 'income-journal', splitIndex: 0 },
      { id: 'transfer-group:transfer-journal:0', transactionId: 'transfer-group', journalId: 'transfer-journal', splitIndex: 0 },
      { id: 'saving-group:saving-journal:0', transactionId: 'saving-group', journalId: 'saving-journal', splitIndex: 0 },
      { id: 'restricted-saving-group:restricted-saving-journal:0', transactionId: 'restricted-saving-group', journalId: 'restricted-saving-journal', splitIndex: 0 },
      { id: 'liability-group:loan-journal:0', transactionId: 'liability-group', journalId: 'loan-journal', splitIndex: 0 },
      { id: 'multi-group:multi-one:0', transactionId: 'multi-group', journalId: 'multi-one', splitIndex: 0 },
      { id: 'multi-group:multi-two:1', transactionId: 'multi-group', journalId: 'multi-two', splitIndex: 1 },
    ],
  )
  assert.deepEqual(
    ledger.entries.map(({ value }) => value),
    [100, 200, 30, 40, 60, 50, 10, 20],
  )
  assert.deepEqual(
    ledger.entries.map(({ sourceKind, destinationKind }) => [sourceKind, destinationKind]),
    [
      ['available', 'expense'],
      ['revenue', 'available'],
      ['available', 'available'],
      ['available', 'savingsAccessible'],
      ['available', 'savingsRestricted'],
      ['available', 'liability'],
      ['available', 'expense'],
      ['available', 'expense'],
    ],
  )
  assert.equal(ledger.entries[2].destinationAccount.id, 'credit-card')
  assert.equal(ledger.entries[2].destinationKind, 'available')
  assert.equal(ledger.entries[0].categoryLabel, 'Groceries')
  assert.equal(ledger.entries[0].description, 'Grocery split')
  assert.deepEqual(ledger.months['2026-01'], {
    entryIds: ledger.entries.map(({ id }) => id),
    transactionIds: ['expense-group', 'income-group', 'liability-group', 'multi-group', 'restricted-saving-group', 'saving-group', 'transfer-group'],
  })
})

test('deduplicates linked and tagged refunds while preserving cash and coverage timing', () => {
  const ledger = build({
    transactions: [
      transaction('purchase-group', [split({ journalId: 'purchase-journal', amount: 100, date: '2026-01-15', source: checking, destination: expense, categoryId: 'food' })]),
      transaction('linked-refund-group', [split({ journalId: 'refund-journal', amount: 40, date: '2026-02-04', source: expense, destination: checking, categoryId: 'misc', tags: ['#refund'] })]),
      transaction('link-only-refund-group', [split({ journalId: 'link-only-refund-journal', amount: 15, date: '2026-02-06', source: expense, destination: checking, categoryId: 'misc' })]),
      transaction('tag-refund-group', [split({ journalId: 'tag-refund-journal', amount: 12, date: '2026-02-05', source: expense, destination: checking, categoryId: 'books', tags: ['#refund'] })]),
    ],
    transactionLinks: [
      {
        id: 'refund-link',
        attributes: {
          link_type_id: 'refund-type',
          inward_id: 'purchase-journal',
          outward_id: 'refund-journal',
        },
      },
      { id: 'link-only-refund-link', attributes: { link_type_id: 'refund-type-by-outward', inward_id: 'purchase-journal', outward_id: 'link-only-refund-journal' } },
    ],
    linkTypes: [refundLinkType, refundLinkTypeByOutward],
  })

  const linked = ledger.entries.find(({ transactionId }) => transactionId === 'linked-refund-group')
  const linkOnly = ledger.entries.find(({ transactionId }) => transactionId === 'link-only-refund-group')
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
  assert.equal(linkOnly.date, '2026-02-06')
  assert.deepEqual(linkOnly.refund, {
    isRefund: true,
    signals: ['link'],
    linkedPurchaseTransactionId: 'purchase-group',
    linkedPurchaseMonthKey: '2026-01',
    coverageCategoryId: 'food',
    coverageMonthKey: '2026-01',
    coverageValue: 15,
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

test('accepts both refund tag forms only on truthful incoming refund legs', () => {
  const ledger = build({
    transactions: [
      transaction('plain-tag-refund', [
        split({ journalId: 'plain-tag-refund-journal', amount: 18, date: '2026-02-07', source: expense, destination: checking, categoryId: 'food', tags: [' Refund '] }),
      ]),
      transaction(
        'hash-tag-refund',
        [split({ journalId: 'hash-tag-refund-journal', amount: 22, date: '2026-02-08', source: expense, destination: savingsAccessible, categoryId: 'travel' })],
        [' #REFUND '],
      ),
    ],
  })

  assert.deepEqual(
    ledger.entries.map(({ transactionId, sourceKind, destinationKind, refund }) => ({ transactionId, sourceKind, destinationKind, refund })),
    [
      {
        transactionId: 'plain-tag-refund',
        sourceKind: 'expense',
        destinationKind: 'available',
        refund: {
          isRefund: true,
          signals: ['tag'],
          linkedPurchaseTransactionId: null,
          linkedPurchaseMonthKey: null,
          coverageCategoryId: 'food',
          coverageMonthKey: '2026-02',
          coverageValue: 18,
          isLinked: false,
        },
      },
      {
        transactionId: 'hash-tag-refund',
        sourceKind: 'expense',
        destinationKind: 'savingsAccessible',
        refund: {
          isRefund: true,
          signals: ['tag'],
          linkedPurchaseTransactionId: null,
          linkedPurchaseMonthKey: null,
          coverageCategoryId: 'travel',
          coverageMonthKey: '2026-02',
          coverageValue: 22,
          isLinked: false,
        },
      },
    ],
  )
})

test('does not relabel outgoing tagged purchases funded by balance-holding accounts', () => {
  const ledger = build({
    transactions: [
      transaction('available-purchase', [
        split({ journalId: 'available-purchase-journal', amount: 30, date: '2026-02-09', source: checking, destination: expense, categoryId: 'food', tags: ['#refund'] }),
      ]),
      transaction('savings-purchase', [
        split({ journalId: 'savings-purchase-journal', amount: 40, date: '2026-02-10', source: savingsAccessible, destination: expense, categoryId: 'travel', tags: ['refund'] }),
      ]),
      transaction('liability-purchase', [
        split({ journalId: 'liability-purchase-journal', amount: 50, date: '2026-02-11', source: loan, destination: expense, categoryId: 'home', tags: ['#REFUND'] }),
      ]),
    ],
  })

  assert.deepEqual(
    ledger.entries.map(({ transactionId, sourceKind, destinationKind, refund }) => ({ transactionId, sourceKind, destinationKind, refund })),
    [
      { transactionId: 'available-purchase', sourceKind: 'available', destinationKind: 'expense', refund: noRefund() },
      { transactionId: 'savings-purchase', sourceKind: 'savingsAccessible', destinationKind: 'expense', refund: noRefund() },
      { transactionId: 'liability-purchase', sourceKind: 'liability', destinationKind: 'expense', refund: noRefund() },
    ],
  )
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
          link_type_id: 'refund-type',
          inward_id: 'not-in-ledger',
          outward_id: 'also-not-in-ledger',
        },
      },
    ],
    linkTypes: [refundLinkType],
    rates: { USD: 1 },
  })

  const missingFx = ledger.entries.find(({ transactionId }) => transactionId === 'missing-fx-group')
  assert.equal(missingFx.value, null)
  assert.deepEqual(missingFx.conversion, { mode: 'unavailable', sourceCurrency: 'EUR', missingCurrency: 'EUR' })
  assert.deepEqual(ledger.fx, { isEstimated: false, missingCurrencies: ['EUR'], transactionIds: ['missing-fx-group'] })
  assert.equal(ledger.entries.find(({ transactionId }) => transactionId === 'unknown-group').sourceKind, 'unknown')
  assert.deepEqual(ledger.audit, { unclassifiedValue: 15, transactionIds: ['unknown-group'], unmatchedRefundLinkIds: ['unmatched-refund-link'] })
})

test('keeps transformed local purchase and refund calendar dates in a UTC-positive timezone', () => {
  const ledgerUrl = new URL('../../utils/AnalyticsLedgerUtils.js', import.meta.url).href
  const script = `
    import { buildAnalyticsLedger } from ${JSON.stringify(ledgerUrl)}

    const account = (id, type) => ({ id, attributes: { type: { fireflyCode: type }, account_role: null, include_net_worth: true } })
    const checking = account('checking', 'asset')
    const expense = account('expense', 'expense')
    const split = (journalId, amount, date, source, destination, categoryId) => ({ transaction_journal_id: journalId, amount: String(amount), currency_code: 'USD', date, source_id: source.id, destination_id: destination.id, category_id: categoryId, tags: [] })
    const ledger = buildAnalyticsLedger({
      accounts: [checking, expense],
      displayCurrencyCode: 'USD',
      primaryCurrencyCode: 'USD',
      rates: { USD: 1 },
      linkTypes: [{ id: 'refund-type', attributes: { name: 'Refund', inward: 'refunded', outward: 'refund' } }],
      transactionLinks: [{ id: 'refund-link', attributes: { link_type_id: 'refund-type', inward_id: 'purchase-journal', outward_id: 'refund-journal' } }],
      transactions: [
        { id: 'purchase-group', attributes: { transactions: [split('purchase-journal', 100, new Date(2026, 1, 1, 0, 5), checking, expense, 'food')] } },
        { id: 'refund-group', attributes: { transactions: [split('refund-journal', 40, new Date(2026, 1, 2, 0, 15), expense, checking, 'misc')] } },
      ],
    })
    console.log(JSON.stringify(ledger.entries.map(({ date, monthKey, refund }) => ({ date, monthKey, coverageMonthKey: refund.coverageMonthKey }))))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', env: { ...process.env, TZ: 'Pacific/Kiritimati' } })

  assert.equal(result.status, 0, result.stderr)
  const entries = JSON.parse(result.stdout)
  assert.deepEqual(entries[1], { date: '2026-02-02', monthKey: '2026-02', coverageMonthKey: '2026-02' })
  assert.deepEqual(entries[0], { date: '2026-02-01', monthKey: '2026-02', coverageMonthKey: null })
})
