import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { afterEach, beforeEach } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive, ref } from 'vue'
import { format, subMonths } from 'date-fns'
import { createAnalyticsStore } from '../../stores/analyticsStoreFactory.js'
import { reconstructBalanceSeries } from '../../utils/AnalyticsBalanceUtils.js'
import { buildAnalyticsLedger } from '../../utils/AnalyticsLedgerUtils.js'

const currency = (id, code, decimalPlaces = 2) => ({ id, attributes: { code, decimal_places: decimalPlaces, default: code === 'USD' } })
const usd = currency('usd', 'USD')
const dashboardStore = reactive({
  dashboardCurrency: usd,
  get dashboardCurrencyCode() {
    return this.dashboardCurrency?.attributes?.code
  },
})
const accountStore = reactive({ accountList: [] })
const currencyStore = reactive({ defaultCurrency: usd, exchangeRates: { rates: { USD: 1, EUR: 0.9 } } })
const transactionRequests = []
const snapshotRequests = []
const storageOverrides = new Map()
let transactionResult = []
let transactionResponse = async () => ({ ok: true, data: transactionResult })
let freshAccountResult = async () => ({ ok: true, data: structuredClone(accountStore.accountList) })
let transactionLinkResult = async () => ({ ok: true, data: [] })
let transactionLinkTypeResult = async () => ({ ok: true, data: [] })
let subscriptionResult = async () => ({ ok: true, data: [] })
let recurringTransactionResult = async () => ({ ok: true, data: [] })
let exchangeRateResponse = async () => {}
let analyticsStore = null
let now = new Date()
const ledgerBuilds = []
const balanceReconstructions = []

const localeNames = ['de-DE', 'en', 'es-MX', 'fr', 'it', 'ko', 'pl', 'pt-BR', 'ro', 'ru-RU', 'zh-CN']
const savingsPresentationKeys = [
  ['savings_view', 'label'],
  ['savings_view', 'combined'],
  ['savings_view', 'split'],
  ['balance', 'savings_included'],
  ['balance', 'savings_excluded'],
  ['balance', 'savings_included_change'],
  ['balance', 'savings_excluded_change'],
  ['common', 'fx_current_rates'],
  ['balance', 'grouped_balance_warning'],
]
const moneyFlowPresentationKeys = [
  ['flow', 'graph_detail'],
  ['flow', 'top_5'],
  ['flow', 'top_10'],
  ['flow', 'all'],
  ['flow', 'other'],
  ['flow', 'available_pool'],
  ['flow', 'savings_pool'],
  ['flow', 'existing_available'],
  ['flow', 'existing_savings_used'],
  ['flow', 'debt_paid'],
  ['flow', 'liability_extended'],
  ['flow', 'liability_collected'],
  ['flow', 'refund_category'],
  ['flow', 'expense_category'],
  ['flow', 'savings_account_deposit'],
  ['flow', 'condensed_mobile'],
  ['flow', 'exact_values'],
  ['flow', 'exact_path'],
  ['flow', 'state', 'unclassified'],
  ['flow', 'audit', 'unclassified'],
  ['flow', 'audit', 'liability_reallocations'],
]

class AccountRepository {
  async getAllWithMergeResult(options) {
    snapshotRequests.push({ input: 'accounts', options })
    return freshAccountResult(options)
  }
}

class TransactionRepository {
  constructor() {
    this.searchTransaction = this.searchTransaction.bind(this)
  }

  async searchTransaction() {
    return { data: [], meta: { pagination: { total_pages: 1 } } }
  }

  async getAllWithMergeResult(options) {
    transactionRequests.push(options)
    return transactionResponse(options)
  }
}

class TransactionLinkRepository {
  async getAll() {
    snapshotRequests.push({ input: 'transaction-links' })
    return transactionLinkResult()
  }
}

class TransactionLinkTypeRepository {
  async getAll() {
    snapshotRequests.push({ input: 'link-types' })
    return transactionLinkTypeResult()
  }
}

class SubscriptionRepository {
  async getAll(startDate, endDate) {
    snapshotRequests.push({ input: 'subscriptions', startDate, endDate })
    return subscriptionResult({ startDate, endDate })
  }
}

class RecurringTransactionRepository {
  async getAllWithMergeResult(options) {
    snapshotRequests.push({ input: 'recurrences', options })
    return recurringTransactionResult(options)
  }
}

class Currency {
  static getCode(value) {
    return value?.attributes?.code
  }

  static getDecimalPlaces(value) {
    return value?.attributes?.decimal_places
  }
}

const useAnalyticsStore = createAnalyticsStore('analytics-test', () => ({
  dashboardStore,
  accountStore,
  currencyStore,
  useStoredValue: (key, initialValue) => ref(structuredClone(storageOverrides.get(key) ?? initialValue)),
  accountRepository: new AccountRepository(),
  transactionRepository: new TransactionRepository(),
  transactionLinkRepository: new TransactionLinkRepository(),
  transactionLinkTypeRepository: new TransactionLinkTypeRepository(),
  subscriptionRepository: new SubscriptionRepository(),
  recurringTransactionRepository: new RecurringTransactionRepository(),
  transformTransactions: (transactions) => transactions,
  getCurrencyCode: (value) => Currency.getCode(value),
  getCurrencyDecimalPlaces: (value) => Currency.getDecimalPlaces(value),
  getExcludedTransactionFilters: () => [],
  buildLedger: (options) => {
    ledgerBuilds.push(options)
    return buildAnalyticsLedger(options)
  },
  reconstructBalances: (options) => {
    balanceReconstructions.push(options)
    return reconstructBalanceSeries(options)
  },
  getNow: () => now,
}))

const activeAsset = () => ({
  id: 'checking',
  attributes: { active: true, type: { fireflyCode: 'asset' }, account_role: { fireflyCode: 'defaultAsset' }, include_net_worth: true, currency_code: 'USD', current_balance: '100' },
})
const includedSaving = () => ({
  id: 'saving-included',
  attributes: { active: true, type: { fireflyCode: 'asset' }, account_role: { fireflyCode: 'savingAsset' }, include_net_worth: true, currency_code: 'USD', current_balance: '200' },
})
const excludedSaving = () => ({
  id: 'saving-excluded',
  attributes: { active: true, type: { fireflyCode: 'asset' }, account_role: { fireflyCode: 'savingAsset' }, include_net_worth: false, currency_code: 'USD', current_balance: '50' },
})
const debitLiability = () => ({
  id: 'loan',
  attributes: {
    active: true,
    type: { fireflyCode: 'liabilities' },
    liability_direction: { fireflyCode: 'debit' },
    include_net_worth: false,
    currency_code: 'USD',
    current_balance: null,
    current_balance_date: format(new Date(), 'yyyy-MM-dd') + 'T23:59:59+00:00',
    current_debt: '250',
  },
})
const activeExpense = () => ({ id: 'expense', attributes: { active: true, type: { fireflyCode: 'expense' } } })
const currentExpenseTransaction = (amount, categoryId = 'food') => ({
  id: 'current-' + amount,
  attributes: {
    transactions: [
      {
        amount: String(amount),
        currency_code: 'USD',
        date: new Date(),
        category_id: categoryId,
        source_id: 'checking',
        destination_id: 'expense',
        accountSource: { attributes: { type: { fireflyCode: 'asset' } } },
        accountDestination: { attributes: { type: { fireflyCode: 'expense' } } },
      },
    ],
  },
})
const deferred = () => {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
}

beforeEach(() => {
  now = new Date()
  setActivePinia(createPinia())
  dashboardStore.dashboardCurrency = usd
  accountStore.accountList = [activeAsset(), activeExpense()]
  currencyStore.defaultCurrency = usd
  currencyStore.exchangeRates = { rates: { USD: 1, EUR: 0.9 } }
  transactionRequests.length = 0
  snapshotRequests.length = 0
  ledgerBuilds.length = 0
  balanceReconstructions.length = 0
  storageOverrides.clear()
  transactionResult = []
  transactionResponse = async () => ({ ok: true, data: transactionResult })
  freshAccountResult = async () => ({ ok: true, data: [...accountStore.accountList] })
  transactionLinkResult = async () => ({ ok: true, data: [] })
  transactionLinkTypeResult = async () => ({ ok: true, data: [] })
  subscriptionResult = async () => ({ ok: true, data: [] })
  recurringTransactionResult = async () => ({ ok: true, data: [] })
  exchangeRateResponse = async () => {}
  currencyStore.fetchExchangeRate = async () => exchangeRateResponse()
})

afterEach(() => analyticsStore?.$dispose())

test('provides every Savings presentation label in all supported locales', () => {
  for (const locale of localeNames) {
    const messages = JSON.parse(readFileSync(new URL(`../../i18n/locales/${locale}.json`, import.meta.url), 'utf8')).analytics
    for (const key of savingsPresentationKeys) {
      const value = key.reduce((parent, segment) => parent?.[segment], messages)
      assert.equal(typeof value, 'string', `${locale}: analytics.${key.join('.')}`)
      assert.notEqual(value.trim(), '', `${locale}: analytics.${key.join('.')}`)
    }
  }
})

test('provides every layered Money flow label and removes the obsolete card-as-debt explanation', () => {
  for (const locale of localeNames) {
    const messages = JSON.parse(readFileSync(new URL(`../../i18n/locales/${locale}.json`, import.meta.url), 'utf8')).analytics
    for (const key of moneyFlowPresentationKeys) {
      const value = key.reduce((parent, segment) => parent?.[segment], messages)
      assert.equal(typeof value, 'string', `${locale}: analytics.${key.join('.')}`)
      assert.notEqual(value.trim(), '', `${locale}: analytics.${key.join('.')}`)
    }
  }
  const english = JSON.parse(readFileSync(new URL('../../i18n/locales/en.json', import.meta.url), 'utf8')).analytics.flow
  assert.doesNotMatch(english.definition, /card purchases.*new debt/i)
})

test('provides the unavailable-amount calculation warning in every supported locale', () => {
  for (const locale of localeNames) {
    const message = JSON.parse(readFileSync(new URL(`../../i18n/locales/${locale}.json`, import.meta.url), 'utf8')).analytics.common.unavailable_amounts
    assert.equal(typeof message, 'string', `${locale}: analytics.common.unavailable_amounts`)
    assert.match(message, /\{ids\}/, `${locale}: analytics.common.unavailable_amounts`)
  }
})

test('builds one coherent ledger and feeds the same entries to every balance projection', async () => {
  now = new Date('2026-08-10T12:00:00')
  const linkTypes = [{ id: 'refund', attributes: { outward: 'refund' } }]
  const checking = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance: '125', current_balance_date: '2026-08-10' } }
  freshAccountResult = async () => ({ ok: true, data: [checking, activeExpense()] })
  transactionLinkTypeResult = async () => ({ ok: true, data: linkTypes })
  transactionResult = [
    {
      id: 'expense-1',
      attributes: {
        transactions: [
          {
            transaction_journal_id: 'journal-1',
            amount: '25',
            currency_code: 'USD',
            date: now,
            source_id: 'checking',
            destination_id: 'expense',
            category_id: 'food',
            accountDestination: { id: 'expense', attributes: { type: { fireflyCode: 'expense' } } },
          },
        ],
      },
    },
  ]
  storageOverrides.set('analyticsSelectedCategoryIds', ['food'])
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(ledgerBuilds.length, 1)
  assert.deepEqual(ledgerBuilds[0].linkTypes, linkTypes)
  assert.equal(store.ledger.entries.length, 1)
  assert.ok(balanceReconstructions.some(({ metric }) => metric === 'savings'))
  assert.equal(store.balanceSeriesByMetric.savings.id, 'savings')
  assert.equal(
    balanceReconstructions.every(({ entries }) => entries === store.ledger.entries),
    true,
  )
  assert.equal(store.categorySummary.series[0].currentActual, 25)
  assert.equal(store.selectedFlow.audit.totalDestinations, 25)
})

test('feeds linked refund metadata from the shared ledger directly into Money flow', async () => {
  now = new Date('2026-08-10T12:00:00')
  const checking = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance_date: '2026-08-10' } }
  const expense = { id: 'expense', attributes: { active: true, type: { fireflyCode: 'expense' } } }
  const split = ({ journalId, amount, sourceId, destinationId, categoryId }) => ({
    transaction_journal_id: journalId,
    amount: String(amount),
    currency_code: 'USD',
    date: now,
    source_id: sourceId,
    destination_id: destinationId,
    category_id: categoryId,
  })
  freshAccountResult = async () => ({ ok: true, data: [checking, expense] })
  transactionLinkTypeResult = async () => ({ ok: true, data: [{ id: 'refund-type', attributes: { outward: 'refund' } }] })
  transactionLinkResult = async () => ({ ok: true, data: [{ id: 'refund-link', attributes: { link_type_id: 'refund-type', inward_id: 'purchase-journal', outward_id: 'refund-journal' } }] })
  transactionResult = [
    { id: 'purchase', attributes: { transactions: [split({ journalId: 'purchase-journal', amount: 100, sourceId: 'checking', destinationId: 'expense', categoryId: 'tech' })] } },
    { id: 'refund', attributes: { transactions: [split({ journalId: 'refund-journal', amount: 40, sourceId: 'expense', destinationId: 'checking', categoryId: 'misc' })] } },
  ]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.selectedFlow.links.find(({ sourceId, targetId }) => sourceId === 'refund:tech' && targetId === 'refundIncome').value, 40)
  assert.equal(store.selectedFlow.links.find(({ sourceId, targetId }) => sourceId === 'refundIncome' && targetId === 'available').value, 40)
  assert.deepEqual(store.selectedFlow.nodes.find(({ id }) => id === 'expense:tech').refundCoverage, { value: 40, transactionIds: ['refund'] })
})

test('reconstructs balance metrics from fresh accounts with explicit transaction-fetch coverage', async () => {
  now = new Date('2026-08-10T12:00:00')
  const staleAccount = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance: '900' } }
  const freshAccount = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance: '125', current_balance_date: '2026-08-10' } }
  accountStore.accountList = [staleAccount]
  freshAccountResult = async () => ({ ok: true, data: [freshAccount] })
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.balanceSeriesByMetric.netWorth.currentPoint.value, 125)
  assert.deepEqual(balanceReconstructions[0].accounts[0], freshAccount)
  assert.deepEqual(balanceReconstructions[0].coverage, { startMonth: '2024-08', endDate: '2026-08-10' })
  assert.equal(accountStore.accountList[0].attributes.current_balance, '900')
})

test('uses transaction fetch coverage for the earliest selectable Money flow month', async () => {
  now = new Date('2026-08-10T12:00:00')
  const invalid = currentExpenseTransaction(null)
  invalid.id = 'unavailable-at-coverage-start'
  invalid.attributes.transactions[0].date = new Date('2024-08-15T12:00:00')
  transactionResult = [invalid]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(format(store.flowMonthMin, 'yyyy-MM'), '2024-08')
})

test('refresh publishes only the newest complete ledger generation', async () => {
  now = new Date('2026-08-10T12:00:00')
  const olderAccounts = deferred()
  const newerAccounts = deferred()
  const olderTransactions = deferred()
  const newerTransactions = deferred()
  const accountResults = [olderAccounts, newerAccounts]
  const transactionResults = [olderTransactions, newerTransactions]
  freshAccountResult = () => accountResults.shift().promise
  transactionResponse = () => transactionResults.shift().promise
  const store = (analyticsStore = useAnalyticsStore())

  const initialLoad = store.init()
  await waitFor(() => snapshotRequests.filter(({ input }) => input === 'accounts').length === 1)
  const refreshedLoad = store.refresh()
  await waitFor(() => snapshotRequests.filter(({ input }) => input === 'accounts').length === 2)

  newerAccounts.resolve({ ok: true, data: [{ ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance: '250', current_balance_date: '2026-08-10' } }] })
  newerTransactions.resolve({ ok: true, data: [currentExpenseTransaction(25)] })
  await refreshedLoad
  olderAccounts.resolve({ ok: true, data: [{ ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance: '100', current_balance_date: '2026-08-10' } }] })
  olderTransactions.resolve({ ok: true, data: [currentExpenseTransaction(10)] })
  await initialLoad

  assert.equal(store.balanceSeriesByMetric.netWorth.currentPoint.value, 250)
  assert.equal(store.ledger.entries[0].value, 25)
  assert.equal(ledgerBuilds.length, 1)
})

test('dedupes one reconciliation warning across affected balance metrics', async () => {
  now = new Date('2026-08-10T12:00:00')
  const savings = { ...includedSaving(), attributes: { ...includedSaving().attributes, current_balance_date: '2026-08-09' } }
  freshAccountResult = async () => ({ ok: true, data: [savings] })
  transactionResult = [
    {
      id: 'saving-expense',
      attributes: {
        transactions: [
          {
            transaction_journal_id: 'saving-expense-journal',
            amount: '20',
            currency_code: 'USD',
            date: now,
            source_id: savings.id,
            destination_id: 'expense',
            accountDestination: { id: 'expense', attributes: { type: { fireflyCode: 'expense' } } },
          },
        ],
      },
    },
  ]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.analyticsAudit.warnings, [
    {
      code: 'current-balance-mismatch',
      metricIds: ['netWorth', 'savings'],
      accountIds: [savings.id],
      transactionIds: ['saving-expense'],
    },
  ])
  assert.deepEqual(store.balanceWarnings, [{ type: 'current-balance-mismatch', metricIds: ['netWorth', 'savings'] }])
  assert.equal(
    store.analyticsAudit.warnings.some(({ code }) => code === 'current-balance-unverified'),
    false,
  )
})

test('keeps unrelated cards ready when an optional Firefly input fails', async () => {
  subscriptionResult = async () => ({ ok: false, data: [] })
  transactionResult = [currentExpenseTransaction(25)]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.ancillaryState.subscriptions.status, 'error')
  assert.equal(store.balanceState.status, 'ready')
  assert.equal(store.categoryState.status, 'ready')
  assert.equal(store.flowState.status, 'ready')
  assert.equal(store.ledger.entries.length, 1)
})

test('publishes one FX disclosure only when conversion is used or incomplete', async () => {
  now = new Date('2026-08-10T12:00:00')
  const euroAccount = { ...activeAsset(), attributes: { ...activeAsset().attributes, currency_code: 'EUR', current_balance: '90', current_balance_date: '2026-08-10' } }
  const expenseAccount = { id: 'expense', attributes: { active: true, type: { fireflyCode: 'expense' }, currency_code: 'JPY' } }
  const yenExpense = {
    id: 'yen-expense',
    attributes: {
      transactions: [
        {
          transaction_journal_id: 'yen-expense-journal',
          amount: '500',
          currency_code: 'JPY',
          date: now,
          source_id: euroAccount.id,
          destination_id: 'expense',
          accountDestination: { id: 'expense', attributes: { type: { fireflyCode: 'expense' } } },
        },
      ],
    },
  }
  freshAccountResult = async () => ({ ok: true, data: [euroAccount, expenseAccount] })
  transactionResult = [yenExpense]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(
    store.ledger.entries.map(({ destinationKind, conversion }) => ({ destinationKind, conversion })),
    [{ destinationKind: 'expense', conversion: { mode: 'unavailable', sourceCurrency: 'JPY', missingCurrency: 'JPY' } }],
  )
  assert.deepEqual(store.fxDisclosure, {
    displayCurrencyCode: 'USD',
    usesCurrentRates: true,
    missingCurrencies: ['JPY'],
    metricIds: ['netWorth', 'expenses'],
  })

  store.$dispose()
  setActivePinia(createPinia())
  freshAccountResult = async () => ({ ok: true, data: [activeAsset()] })
  transactionResult = []
  analyticsStore = useAnalyticsStore()
  await analyticsStore.init()
  assert.equal(analyticsStore.fxDisclosure, null)
})

test('keeps valid category values when another ledger entry has unavailable FX', async () => {
  now = new Date('2026-08-10T12:00:00')
  const checking = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance_date: '2026-08-10' } }
  const expenseAccount = { id: 'expense', attributes: { active: true, type: { fireflyCode: 'expense' } } }
  freshAccountResult = async () => ({ ok: true, data: [checking, expenseAccount] })
  transactionResult = [
    currentExpenseTransaction(25, 'food'),
    {
      id: 'missing-fx-expense',
      attributes: {
        transactions: [
          {
            transaction_journal_id: 'missing-fx-journal',
            amount: '500',
            currency_code: 'JPY',
            date: now,
            source_id: checking.id,
            destination_id: expenseAccount.id,
            category_id: 'travel',
          },
        ],
      },
    },
  ]
  storageOverrides.set('analyticsSelectedCategoryIds', ['food'])
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.categorySummary.series[0].currentActual, 25)
  assert.deepEqual(store.categorySummary.unclassified.transactionIds, [])
  assert.deepEqual(store.categorySummary.missingCurrencies, ['JPY'])
  assert.deepEqual(store.ledger.fx.transactionIds, ['missing-fx-expense'])
  assert.deepEqual(store.analyticsAudit.fx.transactionIds, ['missing-fx-expense'])
})

test('defaults and repairs graph detail while accepting every supported level', () => {
  const defaultStore = (analyticsStore = useAnalyticsStore())

  assert.equal(defaultStore.graphDetail, 5)
  defaultStore.graphDetail = 10
  assert.equal(defaultStore.graphDetail, 10)
  defaultStore.graphDetail = 'all'
  assert.equal(defaultStore.graphDetail, 'all')
  defaultStore.graphDetail = 42
  assert.equal(defaultStore.graphDetail, 5)
})

test('repairs graph detail and derives layered flow with the shared savings view', async () => {
  storageOverrides.set('analyticsMoneyFlowDetail', 42)
  transactionResult = [currentExpenseTransaction(10)]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.graphDetail, 5)
  assert.equal(Array.isArray(store.selectedFlow.nodes), true)
  assert.equal(Array.isArray(store.selectedFlow.links), true)
  assert.equal(store.selectedFlow.sources, undefined)
  store.graphDetail = 'all'
  store.savingsView = 'split'
  await nextTick()
  assert.equal(store.selectedFlow.meta.savingsView, 'split')
  assert.equal(store.selectedFlow.meta.detailLevel, 'all')
})

test('limits only visible flow detail while retaining full audit and transaction details', async () => {
  transactionResult = [70, 60, 50, 40, 30, 20, 10].map((amount, index) => currentExpenseTransaction(amount, `category-${index + 1}`))
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const topFive = store.selectedFlow
  assert.equal(topFive.nodes.filter(({ kind }) => ['expenseCategory', 'otherExpenseCategory'].includes(kind)).length, 6)
  assert.deepEqual(
    topFive.details.nodes.filter(({ kind }) => kind === 'expenseCategory').map(({ id }) => id),
    ['expense:category-1', 'expense:category-2', 'expense:category-3', 'expense:category-4', 'expense:category-5', 'expense:category-6', 'expense:category-7'],
  )
  assert.deepEqual([...new Set(topFive.details.nodes.flatMap(({ transactionIds }) => transactionIds))].sort(), [
    'current-10',
    'current-20',
    'current-30',
    'current-40',
    'current-50',
    'current-60',
    'current-70',
  ])

  store.graphDetail = 'all'
  await nextTick()

  assert.equal(store.selectedFlow.nodes.filter(({ kind }) => kind === 'expenseCategory').length, 7)
  assert.equal(store.selectedFlow.audit.totalSources, topFive.audit.totalSources)
  assert.equal(store.selectedFlow.audit.totalDestinations, topFive.audit.totalDestinations)
})

test('switching the shared savings view repairs persisted metric selections and retains one selection', () => {
  storageOverrides.set('analyticsVisibleBalanceTotalMetrics', ['savings'])
  storageOverrides.set('analyticsVisibleBalanceMetrics', ['savings', 'expenses'])
  const store = (analyticsStore = useAnalyticsStore())

  store.savingsView = 'split'

  assert.equal(store.savingsView, 'split')
  assert.deepEqual(store.availableBalanceMetricIds, ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt'])
  assert.deepEqual(store.availableFinancialMetricIds, ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt', 'expenses'])
  assert.deepEqual(store.visibleBalanceMetrics, ['savingsIncluded', 'savingsExcluded'])
  assert.deepEqual(store.visibleFinancialMetrics, ['savingsIncluded', 'savingsExcluded', 'expenses'])

  store.visibleBalanceMetrics = []
  store.visibleFinancialMetrics = []
  store.savingsView = 'corrupt'

  assert.equal(store.savingsView, 'combined')
  assert.deepEqual(store.visibleBalanceMetrics, ['netWorth'])
  assert.deepEqual(store.visibleFinancialMetrics, ['netWorth'])
})

test('combines included and excluded savings without refetching when the view changes', async () => {
  now = new Date('2026-08-10T12:00:00')
  storageOverrides.set('analyticsBalancePeriod', 6)
  const included = includedSaving()
  const excluded = excludedSaving()
  accountStore.accountList = [
    { ...included, attributes: { ...included.attributes, current_balance: '100' } },
    { ...excluded, attributes: { ...excluded.attributes, current_balance: '40' } },
  ]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const combinedSavings = store.balanceSeries.find(({ id }) => id === 'savings')
  assert.deepEqual(combinedSavings.points.at(-1), { x: '2026-07-31', value: 140, transactionIds: [] })
  assert.deepEqual(combinedSavings.currentPoint, { x: '2026-08-10', value: 140, transactionIds: [] })
  assert.equal(combinedSavings.accountBreakdown.length, 2)
  assert.equal(combinedSavings.reconciliation.status, 'ok')
  const requestCount = snapshotRequests.filter(({ input }) => input === 'accounts').length

  store.savingsView = 'split'
  await nextTick()

  assert.deepEqual(
    store.balanceSeries.map(({ id }) => id),
    ['netWorth', 'savingsIncluded', 'savingsExcluded', 'debt'],
  )
  assert.equal(snapshotRequests.filter(({ input }) => input === 'accounts').length, requestCount)
})

test('withholds public combined savings when a non-empty group contains convertible and missing-rate data', async () => {
  now = new Date('2026-08-10T12:00:00')
  const included = includedSaving()
  const excluded = excludedSaving()
  accountStore.accountList = [
    { ...included, attributes: { ...included.attributes, current_balance: '100' } },
    { ...excluded, attributes: { ...excluded.attributes, current_balance: '40' } },
    { ...excluded, id: 'saving-excluded-jpy', attributes: { ...excluded.attributes, currency_code: 'JPY', current_balance: '500' } },
  ]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const savings = store.balanceSeries.find(({ id }) => id === 'savings')
  assert.equal(
    savings.points.every(({ value }) => value === null),
    true,
  )
  assert.equal(savings.currentPoint, null)
  assert.deepEqual(savings.missingCurrencies, ['JPY'])
})

test('uses included savings as the complete combined series when the excluded group is empty', async () => {
  now = new Date('2026-08-10T12:00:00')
  const included = includedSaving()
  accountStore.accountList = [{ ...included, attributes: { ...included.attributes, current_balance: '100' } }]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const savings = store.balanceSeries.find(({ id }) => id === 'savings')
  assert.deepEqual(savings.points.at(-1), { x: '2026-07-31', value: 100, transactionIds: [] })
  assert.deepEqual(savings.currentPoint, { x: '2026-08-10', value: 100, transactionIds: [] })
})

test('defaults to all financial metrics and preserves valid legacy selections', () => {
  const freshStore = (analyticsStore = useAnalyticsStore())
  assert.deepEqual(freshStore.visibleFinancialMetrics, ['netWorth', 'savings', 'debt', 'expenses'])

  freshStore.$dispose()
  setActivePinia(createPinia())
  storageOverrides.set('analyticsVisibleBalanceMetrics', ['savings', 'netWorth'])
  const legacyStore = (analyticsStore = useAnalyticsStore())
  assert.deepEqual(legacyStore.visibleFinancialMetrics, ['savings', 'netWorth'])
})

test('repairs persisted financial metrics and keeps at least one valid selection', () => {
  storageOverrides.set('analyticsVisibleBalanceMetrics', ['debt', 'unknown', 'debt'])
  const store = (analyticsStore = useAnalyticsStore())
  assert.deepEqual(store.visibleFinancialMetrics, ['debt'])

  store.visibleFinancialMetrics = []
  assert.deepEqual(store.visibleFinancialMetrics, ['netWorth'])
})

test('repairs the financial trend view and keeps balance and change selections independent', () => {
  storageOverrides.set('analyticsFinancialTrendView', 'invalid')
  storageOverrides.set('analyticsVisibleBalanceTotalMetrics', ['savings', 'unknown', 'savings'])
  storageOverrides.set('analyticsVisibleBalanceMetrics', ['expenses', 'debt', 'unknown'])
  const store = (analyticsStore = useAnalyticsStore())

  assert.equal(store.financialTrendView, 'balances')
  assert.deepEqual(store.visibleBalanceMetrics, ['savings'])
  assert.deepEqual(store.visibleFinancialMetrics, ['expenses', 'debt'])

  store.financialTrendView = 'changes'
  store.visibleBalanceMetrics = []
  store.visibleFinancialMetrics = []
  assert.equal(store.financialTrendView, 'changes')
  assert.deepEqual(store.visibleBalanceMetrics, ['netWorth'])
  assert.deepEqual(store.visibleFinancialMetrics, ['netWorth'])
})

test('derives financial trends from the shared ledger and reconstructed balances', async () => {
  now = new Date('2026-08-10T12:00:00')
  const today = now
  const checking = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance_date: '2026-08-10' } }
  const savings = {
    id: 'savings',
    attributes: {
      active: true,
      type: { fireflyCode: 'asset' },
      account_role: { fireflyCode: 'savingAsset' },
      include_net_worth: true,
      currency_code: 'USD',
      current_balance: '200',
      current_balance_date: '2026-08-10',
    },
  }
  const expenseAccount = { id: 'expense', attributes: { active: true, type: { fireflyCode: 'expense' } } }
  accountStore.accountList = [checking, savings, debitLiability(), expenseAccount]
  const expense = (id, amount, date, categoryId) => ({
    id,
    attributes: {
      transactions: [
        { transaction_journal_id: `${id}-journal`, amount: String(amount), currency_code: 'USD', date, category_id: categoryId, source_id: checking.id, destination_id: expenseAccount.id },
      ],
    },
  })
  transactionResult = [
    expense('three-months-ago', 100, new Date(today.getFullYear(), today.getMonth() - 3, 20), 'food'),
    expense('two-months-ago', 20, new Date(today.getFullYear(), today.getMonth() - 2, 20), 'rent'),
    expense('last-month', 30, new Date(today.getFullYear(), today.getMonth() - 1, 20), 'food'),
    expense('current', 10, new Date(today.getFullYear(), today.getMonth(), 1), 'food'),
  ]
  const expectedForecast = today.getDate() < 20 ? 60 : 10
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(balanceReconstructions[0].monthKeys, ['2026-04', '2026-05', '2026-06', '2026-07'])
  assert.deepEqual(store.balanceSeries.find(({ id }) => id === 'netWorth').currentPoint, { x: format(today, 'yyyy-MM-dd'), value: 300, transactionIds: [] })
  assert.equal(store.financialTrend.series.find(({ id }) => id === 'netWorth').currentTotal, 300)
  assert.deepEqual(
    store.financialTrend.expenses.actualPoints.map(({ value }) => value),
    [100, 20, 30],
  )
  assert.equal(store.financialTrend.expenses.currentActual, 10)
  assert.equal(store.financialTrend.expenses.currentForecast, expectedForecast)
})

test('withholds partial category and expense calculations while retaining balance metrics', async () => {
  const valid = currentExpenseTransaction(25)
  const invalid = (id, amount) => ({
    id,
    attributes: { transactions: [{ ...valid.attributes.transactions[0], amount }] },
  })
  transactionResult = [valid, invalid('invalid-z', null), invalid('invalid-a', '   ')]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.categorySummary.unclassified, { value: null, transactionIds: ['invalid-a', 'invalid-z'] })
  assert.deepEqual(store.selectedFlow.unclassified, { value: null, transactionIds: ['invalid-a', 'invalid-z'] })
  assert.deepEqual(store.categorySummary.series, [])
  assert.equal(
    store.categoryRankingItems.every(({ amount }) => amount === null),
    true,
  )
  assert.equal(store.financialTrend.expenses, null)
  assert.equal(store.financialTrend.series.find(({ id }) => id === 'netWorth').currentTotal, 100)
})

test('blocks Money flow only for relevant unavailable entries in the selected month', async () => {
  now = new Date('2026-08-10T12:00:00')
  const checking = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance_date: '2026-08-10' } }
  const expenseAccount = { id: 'expense', attributes: { active: true, type: { fireflyCode: 'expense' } } }
  const unavailableExpense = (id, date) => ({
    id,
    attributes: {
      transactions: [
        {
          transaction_journal_id: `${id}-journal`,
          amount: null,
          currency_code: 'USD',
          date,
          source_id: checking.id,
          destination_id: expenseAccount.id,
          category_id: 'food',
        },
      ],
    },
  })
  freshAccountResult = async () => ({ ok: true, data: [checking, expenseAccount] })
  transactionResult = [currentExpenseTransaction(25), unavailableExpense('invalid-july-expense', new Date('2026-07-15T12:00:00'))]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.selectedFlow.unclassified.transactionIds, [])
  assert.equal(store.selectedFlow.audit.totalDestinations, 25)

  store.selectedFlowMonth = new Date('2026-07-01T12:00:00')
  await nextTick()

  assert.deepEqual(store.selectedFlow.unclassified.transactionIds, ['invalid-july-expense'])
})

test('blocks category summaries only for relevant unavailable spending inside the selected window', async () => {
  now = new Date('2026-08-10T12:00:00')
  storageOverrides.set('analyticsCategoryAverageMonths', 3)
  storageOverrides.set('analyticsSelectedCategoryIds', ['food'])
  const checking = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance_date: '2026-08-10' } }
  const cash = { ...activeAsset(), id: 'cash', attributes: { ...activeAsset().attributes, current_balance_date: '2026-08-10' } }
  const expenseAccount = { id: 'expense', attributes: { active: true, type: { fireflyCode: 'expense' } } }
  const unavailable = (id, date, source, destination) => ({
    id,
    attributes: {
      transactions: [
        {
          transaction_journal_id: `${id}-journal`,
          amount: null,
          currency_code: 'USD',
          date,
          source_id: source.id,
          destination_id: destination.id,
          category_id: 'food',
        },
      ],
    },
  })
  freshAccountResult = async () => ({ ok: true, data: [checking, cash, expenseAccount] })
  transactionResult = [
    currentExpenseTransaction(25),
    unavailable('invalid-current-internal', new Date('2026-08-05T12:00:00'), checking, cash),
    unavailable('invalid-april-expense', new Date('2026-04-15T12:00:00'), checking, expenseAccount),
    unavailable('invalid-june-expense', new Date('2026-06-15T12:00:00'), checking, expenseAccount),
    unavailable('invalid-july-refund', new Date('2026-07-15T12:00:00'), expenseAccount, checking),
  ]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.categorySummary.unclassified, { value: null, transactionIds: ['invalid-july-refund', 'invalid-june-expense'] })
  assert.deepEqual(store.categorySummary.series, [])
})

test('exposes ranked category items with completed-window net totals', async () => {
  const checking = { attributes: { type: { fireflyCode: 'asset' } } }
  const expense = { attributes: { type: { fireflyCode: 'expense' } } }
  const split = (amount, date, categoryId, source = checking, destination = expense) => ({
    amount: String(amount),
    currency_code: 'USD',
    date,
    category_id: categoryId,
    accountSource: source,
    accountDestination: destination,
  })
  const completedMonth = subMonths(new Date(), 1)
  const olderCompletedMonth = subMonths(new Date(), 2)
  transactionResult = [
    { id: 'food', attributes: { transactions: [split(90, completedMonth, 'food')] } },
    { id: 'food-refund', attributes: { transactions: [split(20, completedMonth, 'food', expense, checking)] } },
    { id: 'rent', attributes: { transactions: [split(100, olderCompletedMonth, 'rent')] } },
    { id: 'current-food', attributes: { transactions: [split(500, new Date(), 'food')] } },
  ]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.categoryRanking, ['rent', 'food'])
  assert.deepEqual(store.categoryRankingItems, [
    { id: 'rent', amount: 100 },
    { id: 'food', amount: 70 },
  ])
})

test('treats a corrupted persisted category selection as empty', async () => {
  storageOverrides.set('analyticsSelectedCategoryIds', 'corrupt')
  const store = (analyticsStore = useAnalyticsStore())

  assert.deepEqual(store.categorySummary.series, [])
  await store.init()
  assert.deepEqual(store.selectedCategoryIds, [])
})

test('keeps the newer forced transaction result when an older request finishes last', async () => {
  const olderRequest = deferred()
  const newerRequest = deferred()
  const responses = [olderRequest, newerRequest]
  transactionResponse = () => responses.shift().promise
  storageOverrides.set('analyticsSelectedCategoryIds', ['food'])
  const store = (analyticsStore = useAnalyticsStore())

  const initialLoad = store.init()
  await waitFor(() => transactionRequests.length === 1)
  const forcedLoad = store.retryCategory()
  await waitFor(() => transactionRequests.length === 2)

  newerRequest.resolve({ ok: true, data: [currentExpenseTransaction(25)] })
  await forcedLoad
  assert.equal(store.categorySummary.series[0].currentActual, 25)

  olderRequest.resolve({ ok: true, data: [currentExpenseTransaction(10)] })
  await initialLoad
  assert.equal(store.categoryState.status, 'ready')
  assert.equal(store.categorySummary.series[0].currentActual, 25)
})

test('keeps a newer transaction failure current when an older request later succeeds', async () => {
  const olderRequest = deferred()
  const newerRequest = deferred()
  const responses = [olderRequest, newerRequest]
  transactionResponse = () => responses.shift().promise
  storageOverrides.set('analyticsSelectedCategoryIds', ['food'])
  const store = (analyticsStore = useAnalyticsStore())

  const initialLoad = store.init()
  await waitFor(() => transactionRequests.length === 1)
  const forcedLoad = store.retryFlow()
  await waitFor(() => transactionRequests.length === 2)

  newerRequest.resolve({ ok: false, data: [] })
  await forcedLoad
  assert.equal(store.categoryState.status, 'error')

  olderRequest.resolve({ ok: true, data: [currentExpenseTransaction(10)] })
  await initialLoad
  assert.equal(store.categoryState.status, 'error')
  assert.equal(store.categorySummary.series[0].currentActual, 0)
})

test('shares one in-flight transaction request between non-forced initial loads', async () => {
  const request = deferred()
  transactionResponse = () => request.promise
  const store = (analyticsStore = useAnalyticsStore())

  const firstLoad = store.init()
  const secondLoad = store.init()
  await waitFor(() => transactionRequests.length > 0)
  assert.equal(transactionRequests.length, 1)

  request.resolve({ ok: true, data: [] })
  await Promise.all([firstLoad, secondLoad])
})

test('selects a current-only category and retains its actual with insufficient history', async () => {
  transactionResult = [currentExpenseTransaction(42, 'new-category')]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.categoryRanking, [])
  assert.deepEqual(store.categoryRankingItems, [{ id: 'new-category', amount: 0 }])
  assert.deepEqual(store.selectedCategoryIds, ['new-category'])
  assert.equal(store.categorySummary.usedMonths, 0)
  assert.equal(store.categorySummary.series[0].currentActual, 42)
  assert.equal(store.categorySummary.series[0].forecastAvailable, false)
})

test('keeps an unavailable persisted category visible as a zero-amount candidate', async () => {
  storageOverrides.set('analyticsSelectedCategoryIds', ['archived-category'])
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.selectedCategoryIds, ['archived-category'])
  assert.deepEqual(store.categoryRankingItems, [{ id: 'archived-category', amount: 0 }])
  assert.equal(store.categorySummary.series[0].id, 'archived-category')
})

test('keeps over-limit persisted selection intact until the UI reports and normalizes it', async () => {
  const persistedIds = ['one', 'two', 'three', 'four', 'five', 'six', 'seven']
  storageOverrides.set('analyticsSelectedCategoryIds', persistedIds)
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.selectedCategoryIds, persistedIds)
  assert.deepEqual(
    store.categorySummary.series.map(({ id }) => id),
    persistedIds.slice(0, 6),
  )
})

test('uses fresh analytics accounts without replacing the global account store', async () => {
  const staleAccount = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance: '900' } }
  const freshAccount = { ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance: '125' } }
  accountStore.accountList = [staleAccount]
  freshAccountResult = async () => ({ ok: true, data: [freshAccount] })
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.balanceSeries.find(({ id }) => id === 'netWorth').currentPoint.value, 125)
  assert.equal(accountStore.accountList[0].attributes.current_balance, '900')
  assert.equal(snapshotRequests.filter(({ input }) => input === 'accounts').length, 1)
})

test('keeps transaction analytics available when the fresh account input fails', async () => {
  freshAccountResult = async () => ({ ok: false, data: [] })
  transactionResult = [currentExpenseTransaction(25)]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.balanceState.status, 'error')
  assert.equal(store.categoryState.status, 'ready')
  assert.equal(store.financialTrend.expenses.currentActual, 25)
})

test('refresh reloads every analytics snapshot input', async () => {
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()
  await store.refresh()

  for (const input of ['accounts', 'transaction-links', 'link-types', 'subscriptions', 'recurrences']) {
    assert.equal(snapshotRequests.filter(({ input: requestedInput }) => requestedInput === input).length, 2, input)
  }
  assert.equal(transactionRequests.length, 2)
})

test('loads human-readable transaction link types as an independent analytics snapshot input', async () => {
  const linkTypes = [{ id: 'refund-type', attributes: { name: 'Refund', inward: 'refunded', outward: 'refund' } }]
  transactionLinkTypeResult = async () => ({ ok: true, data: linkTypes })
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.transactionLinkTypes, linkTypes)
  assert.equal(store.ancillaryState.transactionLinkTypes.status, 'ready')
  assert.equal(snapshotRequests.filter(({ input }) => input === 'link-types').length, 1)
})

test('publishes only one generation when an older snapshot resolves after refresh', async () => {
  const olderAccounts = deferred()
  const newerAccounts = deferred()
  const olderTransactions = deferred()
  const newerTransactions = deferred()
  const accountResults = [olderAccounts, newerAccounts]
  const transactionResults = [olderTransactions, newerTransactions]
  freshAccountResult = () => accountResults.shift().promise
  transactionResponse = () => transactionResults.shift().promise
  storageOverrides.set('analyticsSelectedCategoryIds', ['food'])
  const store = (analyticsStore = useAnalyticsStore())

  const initialLoad = store.init()
  await waitFor(() => snapshotRequests.filter(({ input }) => input === 'accounts').length === 1)
  const refreshedLoad = store.refresh()
  await waitFor(() => snapshotRequests.filter(({ input }) => input === 'accounts').length === 2)

  newerAccounts.resolve({ ok: true, data: [{ ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance: '250' } }] })
  newerTransactions.resolve({ ok: true, data: [currentExpenseTransaction(25)] })
  await refreshedLoad

  olderAccounts.resolve({ ok: true, data: [{ ...activeAsset(), attributes: { ...activeAsset().attributes, current_balance: '100' } }] })
  olderTransactions.resolve({ ok: true, data: [currentExpenseTransaction(10)] })
  await initialLoad

  assert.equal(store.balanceSeries.find(({ id }) => id === 'netWorth').currentPoint.value, 250)
  assert.equal(store.categorySummary.series[0].currentActual, 25)
})

test('waits for an in-flight non-forced snapshot before resolving a second init', async () => {
  const accountRequest = deferred()
  freshAccountResult = () => accountRequest.promise
  const store = (analyticsStore = useAnalyticsStore())

  const firstInit = store.init()
  await waitFor(() => snapshotRequests.filter(({ input }) => input === 'accounts').length === 1)
  let secondInitResolved = false
  const secondInit = store.init().then(() => {
    secondInitResolved = true
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(secondInitResolved, false)

  accountRequest.resolve({ ok: true, data: [activeAsset()] })
  await Promise.all([firstInit, secondInit])
  assert.equal(secondInitResolved, true)
})

test('retains failure metadata for each ancillary snapshot input', async () => {
  transactionLinkResult = async () => ({ ok: false, data: [] })
  transactionLinkTypeResult = async () => ({ ok: false, data: [] })
  subscriptionResult = async () => ({ ok: false, data: [] })
  recurringTransactionResult = async () => ({ ok: false, data: [] })
  transactionResult = [currentExpenseTransaction(25)]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  for (const input of ['transactionLinks', 'transactionLinkTypes', 'subscriptions', 'recurringTransactions']) {
    assert.equal(store.ancillaryState[input].status, 'error', input)
    assert.match(store.ancillaryState[input].error.message, /Analytics .* request failed/)
  }
  assert.equal(store.categoryState.status, 'ready')
})

test('keeps a completed snapshot on its captured exchange rates', async () => {
  const euroAccount = { ...activeAsset(), attributes: { ...activeAsset().attributes, currency_code: 'EUR', current_balance: '100' } }
  freshAccountResult = async () => ({ ok: true, data: [euroAccount] })
  currencyStore.exchangeRates = { rates: { USD: 1, EUR: 0.5 } }
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()
  currencyStore.exchangeRates = { rates: { USD: 1, EUR: 0.25 } }
  await nextTick()

  assert.equal(store.balanceSeries.find(({ id }) => id === 'netWorth').currentPoint.value, 200)
})
