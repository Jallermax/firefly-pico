import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test, { afterEach, beforeEach, mock } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive, ref } from 'vue'
import { format, subDays, subMonths } from 'date-fns'

const frontUrl = new URL('../../', import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('~/')) return nextResolve(new URL(specifier.slice(2), frontUrl).href, context)
    return nextResolve(specifier, context)
  },
})

const currency = (id, code, decimalPlaces = 2) => ({ id, attributes: { code, decimal_places: decimalPlaces, default: code === 'USD' } })
const usd = currency('usd', 'USD')
const eur = currency('eur', 'EUR')
const dashboardStore = reactive({
  dashboardCurrency: usd,
  get dashboardCurrencyCode() {
    return this.dashboardCurrency?.attributes?.code
  },
})
const accountStore = reactive({ accountList: [] })
const currencyStore = reactive({ defaultCurrency: usd, exchangeRates: { rates: { USD: 1, EUR: 0.9 } } })
const categoryStore = reactive({ categoryDictionary: {} })
const appStore = { syncEverythingIfOld: async () => {} }
const accountRequests = []
const storageOverrides = new Map()
let accountResponse = async () => ({ status: 200, data: [] })
let transactionResult = []
let analyticsStore = null

class AccountRepository {
  async getChartOverview(options) {
    accountRequests.push(options)
    return accountResponse(options)
  }
}

class TransactionRepository {
  constructor() {
    this.searchTransaction = this.searchTransaction.bind(this)
  }

  async searchTransaction() {
    return { data: [], meta: { pagination: { total_pages: 1 } } }
  }

  async getAllWithMergeResult() {
    return { ok: true, data: transactionResult }
  }
}

class Account {
  static getBalance(account) {
    return account?.attributes?.current_balance
  }

  static getCurrencyCode(account) {
    return account?.attributes?.currency_code
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

const modules = [
  ['../../stores/appStore.js', { useAppStore: () => appStore }],
  ['../../stores/dashboardStore.js', { useDashboardStore: () => dashboardStore }],
  ['../../stores/accountStore.js', { useAccountStore: () => accountStore }],
  ['../../stores/currencyStore.js', { useCurrencyStore: () => currencyStore }],
  ['../../stores/categoryStore.js', { useCategoryStore: () => categoryStore }],
]
for (const [path, exports] of modules) mock.module(new URL(path, import.meta.url), { exports, cache: true })
mock.module(new URL('../../repository/AccountRepository.js', import.meta.url), { exports: { default: AccountRepository }, cache: true })
mock.module(new URL('../../repository/TransactionRepository.js', import.meta.url), { exports: { default: TransactionRepository }, cache: true })
mock.module(new URL('../../transformers/TransactionTransformer.js', import.meta.url), {
  exports: {
    default: class TransactionTransformer {
      static transformFromApiList(list) {
        return list
      }
    },
  },
  cache: true,
})
mock.module(new URL('../../models/Account.js', import.meta.url), { exports: { default: Account }, cache: true })
mock.module(new URL('../../models/Currency.js', import.meta.url), { exports: { default: Currency }, cache: true })
mock.module(new URL('../../utils/DashboardUtils.js', import.meta.url), { exports: { getExcludedTransactionFilters: () => [] }, cache: true })
mock.module('@vueuse/core', { exports: { useLocalStorage: (key, initialValue) => ref(structuredClone(storageOverrides.get(key) ?? initialValue)) }, cache: true })

const { useAnalyticsStore } = await import('../../stores/analyticsStore.js')

const activeAsset = () => ({
  id: 'checking',
  attributes: { active: true, type: { fireflyCode: 'asset' }, account_role: { fireflyCode: 'defaultAsset' }, include_net_worth: true, currency_code: 'USD', current_balance: '100' },
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
const chartResponse = (value, date = format(new Date(), 'yyyy-MM-dd')) => ({ status: 200, data: [{ currency_code: 'USD', entries: { [date]: String(value) } }] })
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
  setActivePinia(createPinia())
  dashboardStore.dashboardCurrency = usd
  accountStore.accountList = [activeAsset()]
  currencyStore.defaultCurrency = usd
  currencyStore.exchangeRates = { rates: { USD: 1, EUR: 0.9 } }
  categoryStore.categoryDictionary = {}
  accountRequests.length = 0
  storageOverrides.clear()
  accountResponse = async () => chartResponse(100)
  transactionResult = []
})

afterEach(() => analyticsStore?.$dispose())

test('keeps overlapping balance requests isolated to their captured currency and current state', async () => {
  const usdRequest = deferred()
  const eurRequest = deferred()
  const responses = [usdRequest, eurRequest]
  accountResponse = () => responses.shift().promise
  const store = (analyticsStore = useAnalyticsStore())

  const initPromise = store.init()
  await waitFor(() => accountRequests.length === 1)
  dashboardStore.dashboardCurrency = eur
  await nextTick()
  await waitFor(() => accountRequests.length === 2)

  eurRequest.resolve({ status: 500, data: {} })
  await waitFor(() => store.balanceState.status === 'error')
  usdRequest.resolve(chartResponse(100))
  await initPromise
  await nextTick()

  assert.equal(store.balanceState.status, 'error')
  dashboardStore.dashboardCurrency = usd
  await nextTick()
  await waitFor(() => store.balanceState.status === 'ready')
  assert.equal(accountRequests.length, 2)
  assert.deepEqual(store.balanceSeries.find(({ id }) => id === 'netWorth').points, [{ x: format(new Date(), 'yyyy-MM-dd'), value: 100 }])
})

test('initializes a fallback currency with one request per non-empty group and range', async () => {
  dashboardStore.dashboardCurrency = null
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()
  await nextTick()

  assert.equal(accountRequests.length, 1)
})

test('validates debit liabilities against current debt', async () => {
  accountStore.accountList = [debitLiability()]
  accountResponse = async () => chartResponse(-200)
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.balanceSeries.find(({ id }) => id === 'debt').warnings, [
    { type: 'current-balance-mismatch', sampleDate: format(new Date(), 'yyyy-MM-dd'), chartValue: 200, currentValue: 250 },
  ])
})

test('marks a weekly final point unverified when no account value exists for its sample date', async () => {
  const sampleDate = format(subDays(new Date(), 3), 'yyyy-MM-dd')
  storageOverrides.set('analyticsBalancePeriod', 6)
  accountStore.accountList = [debitLiability()]
  accountResponse = async () => chartResponse(-200, sampleDate)
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.balanceSeries.find(({ id }) => id === 'debt').warnings, [{ type: 'current-balance-unverified', sampleDate, currentDate: format(new Date(), 'yyyy-MM-dd') }])
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
  categoryStore.categoryDictionary = { food: { id: 'food' }, rent: { id: 'rent' } }
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
