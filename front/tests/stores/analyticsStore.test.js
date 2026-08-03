import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive, ref } from 'vue'
import { format, subDays, subMonths } from 'date-fns'
import { createAnalyticsStore } from '../../stores/analyticsStoreFactory.js'

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
const appStore = { syncEverythingIfOld: async () => {} }
const accountRequests = []
const transactionRequests = []
const storageOverrides = new Map()
let accountResponse = async () => ({ status: 200, data: [] })
let transactionResult = []
let transactionResponse = async () => ({ ok: true, data: transactionResult })
let analyticsStore = null
let now = new Date()

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

  async getAllWithMergeResult(options) {
    transactionRequests.push(options)
    return transactionResponse(options)
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

const useAnalyticsStore = createAnalyticsStore('analytics-test', () => ({
  appStore,
  dashboardStore,
  accountStore,
  currencyStore,
  useStoredValue: (key, initialValue) => ref(structuredClone(storageOverrides.get(key) ?? initialValue)),
  createAccountRepository: () => new AccountRepository(),
  createTransactionRepository: () => new TransactionRepository(),
  transformTransactions: (transactions) => transactions,
  getAccountBalance: (account) => Account.getBalance(account),
  getAccountCurrencyCode: (account) => Account.getCurrencyCode(account),
  getCurrencyCode: (value) => Currency.getCode(value),
  getCurrencyDecimalPlaces: (value) => Currency.getDecimalPlaces(value),
  getExcludedTransactionFilters: () => [],
  isResponseSuccess: (response) => [200, 204].includes(response?.status),
  getNow: () => now,
}))

const activeAsset = () => ({
  id: 'checking',
  attributes: { active: true, type: { fireflyCode: 'asset' }, account_role: { fireflyCode: 'defaultAsset' }, include_net_worth: true, currency_code: 'USD', current_balance: '100' },
})
const includedSavings = () => ({
  id: 'savings',
  attributes: { active: true, type: { fireflyCode: 'asset' }, account_role: { fireflyCode: 'savingAsset' }, include_net_worth: true, currency_code: 'USD', current_balance: '200' },
})
const excludedSavings = () => ({
  id: 'excluded-savings',
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
const chartResponse = (value, date = format(new Date(), 'yyyy-MM-dd')) => ({ status: 200, data: [{ currency_code: 'USD', entries: { [date]: String(value) } }] })
const currentExpenseTransaction = (amount, categoryId = 'food') => ({
  id: 'current-' + amount,
  attributes: {
    transactions: [
      {
        amount: String(amount),
        currency_code: 'USD',
        date: new Date(),
        category_id: categoryId,
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
  accountStore.accountList = [activeAsset()]
  currencyStore.defaultCurrency = usd
  currencyStore.exchangeRates = { rates: { USD: 1, EUR: 0.9 } }
  accountRequests.length = 0
  transactionRequests.length = 0
  storageOverrides.clear()
  accountResponse = async () => chartResponse(100)
  transactionResult = []
  transactionResponse = async () => ({ ok: true, data: transactionResult })
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

test('initializes the real store factory with an included savings account', async () => {
  accountStore.accountList = [activeAsset(), includedSavings(), excludedSavings()]
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.balanceState.status, 'ready')
  assert.deepEqual(
    accountRequests.map(({ accountIds }) => accountIds.sort()),
    [
      ['checking', 'savings'],
      ['excluded-savings', 'savings'],
    ],
  )
})

test('normalizes a current Firefly chart timestamp before validating balances', async () => {
  const date = format(new Date(), 'yyyy-MM-dd')
  const atomDate = date + 'T00:00:00+00:00'
  accountResponse = async () => chartResponse(100, atomDate)
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const netWorth = store.balanceSeries.find(({ id }) => id === 'netWorth')
  assert.deepEqual(netWorth.points, [{ x: date, value: 100 }])
  assert.deepEqual(netWorth.warnings, [])
})

test('validates debit liabilities against current debt', async () => {
  accountStore.accountList = [debitLiability()]
  accountResponse = async () => chartResponse(-200)
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const debt = store.balanceSeries.find(({ id }) => id === 'debt')
  assert.deepEqual(debt.currentPoint, { x: format(new Date(), 'yyyy-MM-dd'), value: 250 })
  assert.deepEqual(debt.warnings, [{ type: 'current-balance-mismatch', sampleDate: format(new Date(), 'yyyy-MM-dd'), chartValue: 200, currentValue: 250 }])
})

for (const { name, direction, currentDebt, currentBalance, expected } of [
  { name: 'negative debit current debt', direction: 'debit', currentDebt: '-250', currentBalance: '-125', expected: 250 },
  { name: 'credit-direction current debt', direction: 'credit', currentDebt: '150', currentBalance: '-125', expected: 150 },
  { name: 'blank current debt fallback', direction: 'debit', currentDebt: '   ', currentBalance: '-125', expected: 125 },
  { name: 'explicit zero current debt', direction: 'debit', currentDebt: '0', currentBalance: '-125', expected: 0 },
]) {
  test(`uses ${name} for the current debt total`, async () => {
    const liability = debitLiability()
    accountStore.accountList = [
      {
        ...liability,
        attributes: {
          ...liability.attributes,
          liability_direction: { fireflyCode: direction },
          current_debt: currentDebt,
          current_balance: currentBalance,
        },
      },
    ]
    accountResponse = async () => chartResponse(-500)
    const store = (analyticsStore = useAnalyticsStore())

    await store.init()

    assert.equal(store.balanceSeries.find(({ id }) => id === 'debt').currentPoint.value, expected)
  })
}

test('marks a weekly final point unverified when no account value exists for its sample date', async () => {
  const sampleDate = format(subDays(new Date(), 3), 'yyyy-MM-dd')
  storageOverrides.set('analyticsBalancePeriod', 6)
  accountStore.accountList = [debitLiability()]
  accountResponse = async () => chartResponse(-200, sampleDate)
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.deepEqual(store.balanceSeries.find(({ id }) => id === 'debt').warnings, [{ type: 'current-balance-unverified', sampleDate, currentDate: format(new Date(), 'yyyy-MM-dd') }])
})

test('uses a same-day debt chart actual when direct current debt is missing and preserves zero change', async () => {
  now = new Date('2026-08-10T12:00:00')
  accountStore.accountList = [
    {
      ...debitLiability(),
      attributes: { ...debitLiability().attributes, current_debt: null },
    },
  ]
  accountResponse = async () => ({ status: 200, data: [{ currency_code: 'USD', entries: { '2026-07-31': '-200', '2026-08-10': '-200' } }] })
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const sourceSeries = store.balanceSeries.find(({ id }) => id === 'debt')
  const trendSeries = store.financialTrend.series.find(({ id }) => id === 'debt')
  assert.deepEqual(sourceSeries.currentPoint, { x: '2026-08-10', value: 200 })
  assert.deepEqual(sourceSeries.warnings, [])
  assert.equal(trendSeries.currentTotal, 200)
  assert.equal(trendSeries.currentChange, 0)
  assert.deepEqual(
    trendSeries.changePoints.find(({ kind }) => kind === 'partial'),
    { x: '2026-08', value: 0, kind: 'partial' },
  )
})

test('uses a current-month daily debt actual without replacing longer-window weekly history', async () => {
  now = new Date('2026-08-10T12:00:00')
  storageOverrides.set('analyticsBalancePeriod', 6)
  accountStore.accountList = [
    {
      ...debitLiability(),
      attributes: { ...debitLiability().attributes, current_debt: null },
    },
  ]
  accountResponse = async ({ period }) =>
    period === '1D' ? chartResponse(-147, '2026-08-07') : { status: 200, data: [{ currency_code: 'USD', entries: { '2026-06-30': '-253', '2026-07-28': '-200' } }] }
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const sourceSeries = store.balanceSeries.find(({ id }) => id === 'debt')
  const trendSeries = store.financialTrend.series.find(({ id }) => id === 'debt')
  assert.deepEqual(
    accountRequests.map(({ start, end, period }) => ({ start, end, period })),
    [
      { start: '2026-01-01', end: '2026-08-10', period: '1W' },
      { start: '2026-08-01', end: '2026-08-10', period: '1D' },
    ],
  )
  assert.deepEqual(sourceSeries.points, [
    { x: '2026-06-30', value: 253 },
    { x: '2026-07-28', value: 200 },
  ])
  assert.deepEqual(sourceSeries.currentPoint, { x: '2026-08-07', value: 147 })
  assert.deepEqual(sourceSeries.warnings, [{ type: 'current-balance-unverified', sampleDate: '2026-08-07', currentDate: '2026-08-10' }])
  assert.equal(trendSeries.currentTotal, 147)
  assert.equal(trendSeries.currentChange, -53)
})

test('does not cache longer-window balances when the current-month auxiliary request fails', async () => {
  now = new Date('2026-08-10T12:00:00')
  storageOverrides.set('analyticsBalancePeriod', 6)
  accountStore.accountList = [
    {
      ...debitLiability(),
      attributes: { ...debitLiability().attributes, current_debt: null },
    },
  ]
  let dailyFails = true
  accountResponse = async ({ period }) => (period === '1D' ? (dailyFails ? { status: 500, data: {} } : chartResponse(-147, '2026-08-10')) : chartResponse(-200, '2026-07-28'))
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(store.balanceState.status, 'error')
  assert.equal(store.balanceSeries.find(({ id }) => id === 'debt').currentPoint, undefined)

  dailyFails = false
  await store.retryBalance()

  assert.equal(accountRequests.length, 4)
  assert.equal(store.balanceState.status, 'ready')
  assert.deepEqual(store.balanceSeries.find(({ id }) => id === 'debt').currentPoint, { x: '2026-08-10', value: 147 })
})

test('keeps a newer currency result current while an older auxiliary debt request finishes', async () => {
  now = new Date('2026-08-10T12:00:00')
  storageOverrides.set('analyticsBalancePeriod', 6)
  accountStore.accountList = [
    {
      ...debitLiability(),
      attributes: { ...debitLiability().attributes, current_debt: null },
    },
  ]
  const olderDaily = deferred()
  const newerDaily = deferred()
  const dailyResponses = [olderDaily, newerDaily]
  accountResponse = ({ period }) => (period === '1D' ? dailyResponses.shift().promise : Promise.resolve(chartResponse(-200, '2026-07-28')))
  const store = (analyticsStore = useAnalyticsStore())

  const initPromise = store.init()
  await waitFor(() => accountRequests.length === 2)
  dashboardStore.dashboardCurrency = eur
  await nextTick()
  await waitFor(() => accountRequests.length === 4)

  newerDaily.resolve(chartResponse(-100, '2026-08-10'))
  await waitFor(() => store.balanceState.status === 'ready')
  assert.deepEqual(store.balanceSeries.find(({ id }) => id === 'debt').currentPoint, { x: '2026-08-10', value: 90, isEstimated: true })

  olderDaily.resolve(chartResponse(-200, '2026-08-10'))
  await initPromise
  await nextTick()

  assert.equal(store.balanceState.status, 'ready')
  assert.deepEqual(store.balanceSeries.find(({ id }) => id === 'debt').currentPoint, { x: '2026-08-10', value: 90, isEstimated: true })
})

test('keeps a prior-month debt chart actual out of current totals when direct current debt is missing', async () => {
  const previousMonthEnd = format(new Date(new Date().getFullYear(), new Date().getMonth(), 0), 'yyyy-MM-dd')
  accountStore.accountList = [
    {
      ...debitLiability(),
      attributes: { ...debitLiability().attributes, current_debt: null, current_balance_date: previousMonthEnd },
    },
  ]
  accountResponse = async () => chartResponse(-130, previousMonthEnd)
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const sourceSeries = store.balanceSeries.find(({ id }) => id === 'debt')
  const trendSeries = store.financialTrend.series.find(({ id }) => id === 'debt')
  assert.equal(sourceSeries.currentPoint, null)
  assert.equal(trendSeries.currentTotal, null)
  assert.equal(trendSeries.currentChange, null)
  assert.equal(
    trendSeries.totalPoints.some(({ kind }) => kind === 'partial'),
    false,
  )
  assert.equal(
    trendSeries.changePoints.some(({ kind }) => kind === 'partial'),
    false,
  )
})

test('retains estimation and staleness metadata on a current-month debt chart fallback', async () => {
  now = new Date('2026-08-10T12:00:00')
  accountStore.accountList = [
    {
      ...debitLiability(),
      attributes: { ...debitLiability().attributes, currency_code: 'EUR', current_debt: '   ' },
    },
  ]
  accountResponse = async () => ({ status: 200, data: [{ currency_code: 'EUR', entries: { '2026-08-07': '-90' } }] })
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const debt = store.balanceSeries.find(({ id }) => id === 'debt')
  assert.deepEqual(debt.currentPoint, { x: '2026-08-07', value: 100, isEstimated: true })
  assert.deepEqual(debt.warnings, [{ type: 'current-balance-unverified', sampleDate: '2026-08-07', currentDate: '2026-08-10' }])
})

test('keeps current-rate estimation on current points without marking exact history estimated', async () => {
  const today = new Date()
  const previousMonthEnd = format(new Date(today.getFullYear(), today.getMonth(), 0), 'yyyy-MM-dd')
  accountStore.accountList = [
    {
      ...activeAsset(),
      attributes: { ...activeAsset().attributes, currency_code: 'EUR', current_balance: '90', current_balance_date: previousMonthEnd },
    },
  ]
  accountResponse = async () => ({ status: 200, data: [{ primary_currency_code: 'USD', pc_entries: { [previousMonthEnd]: '100' } }] })
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  const sourceSeries = store.balanceSeries.find(({ id }) => id === 'netWorth')
  const trendSeries = store.financialTrend.series.find(({ id }) => id === 'netWorth')
  assert.equal(sourceSeries.isEstimated, false)
  assert.deepEqual(sourceSeries.currentPoint, { x: format(today, 'yyyy-MM-dd'), value: 100, isEstimated: true })
  assert.deepEqual(
    trendSeries.totalPoints.find(({ kind }) => kind === 'partial'),
    { x: format(today, 'yyyy-MM'), value: 100, kind: 'partial', isEstimated: true },
  )
  assert.equal(
    trendSeries.totalPoints.filter(({ kind }) => kind === 'actual').every(({ isEstimated }) => isEstimated === undefined),
    true,
  )
  assert.deepEqual(
    trendSeries.changePoints.find(({ kind }) => kind === 'partial'),
    { x: format(today, 'yyyy-MM'), value: 0, kind: 'partial', isEstimated: true },
  )
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

test('requests one baseline month before three completed months', async () => {
  const today = new Date()
  const store = (analyticsStore = useAnalyticsStore())

  await store.init()

  assert.equal(accountRequests[0].start, format(new Date(today.getFullYear(), today.getMonth() - 4, 1), 'yyyy-MM-dd'))
})

test('derives financial trends from three account requests and the transaction ledger', async () => {
  const today = new Date()
  const checking = activeAsset()
  const savings = {
    id: 'savings',
    attributes: { active: true, type: { fireflyCode: 'asset' }, account_role: { fireflyCode: 'savingAsset' }, include_net_worth: true, currency_code: 'USD', current_balance: '200' },
  }
  accountStore.accountList = [checking, savings, debitLiability()]
  accountResponse = async ({ accountIds }) => {
    const sampleDate = format(subDays(today, 3), 'yyyy-MM-dd')
    if (accountIds.includes('loan')) return chartResponse(-225, sampleDate)
    if (accountIds.includes('savings') && !accountIds.includes('checking')) return chartResponse(175, sampleDate)
    return chartResponse(275, sampleDate)
  }
  const checkingAccount = { attributes: { type: { fireflyCode: 'asset' } } }
  const expenseAccount = { attributes: { type: { fireflyCode: 'expense' } } }
  const expense = (id, amount, date, categoryId) => ({
    id,
    attributes: { transactions: [{ amount: String(amount), currency_code: 'USD', date, category_id: categoryId, accountSource: checkingAccount, accountDestination: expenseAccount }] },
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

  assert.equal(accountRequests.length, 3)
  assert.equal(
    accountRequests.some(({ accountIds }) => accountIds.includes('expenses')),
    false,
  )
  assert.equal(accountRequests[0].start, format(new Date(today.getFullYear(), today.getMonth() - 4, 1), 'yyyy-MM-dd'))
  assert.deepEqual(store.balanceSeries.find(({ id }) => id === 'netWorth').currentPoint, { x: format(today, 'yyyy-MM-dd'), value: 300 })
  assert.equal(store.financialTrend.series.find(({ id }) => id === 'netWorth').currentTotal, 300)
  assert.deepEqual(
    store.financialTrend.expenses.actualPoints.map(({ value }) => value),
    [100, 20, 30],
  )
  assert.equal(store.financialTrend.expenses.currentActual, 10)
  assert.equal(store.financialTrend.expenses.currentForecast, expectedForecast)
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
