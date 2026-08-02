import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  ANALYTICS_UNCATEGORIZED_ID,
  buildCategoryLedger,
  buildMonthlyMoneyFlow,
  convertAnalyticsAmount,
  getAnalyticsAccountGroups,
  normalizeBalanceSeries,
  rankCategoryIds,
  summarizeCategoryWindow,
} from '../../utils/AnalyticsUtils.js'

const account = ({ id, type = 'asset', role = 'defaultAsset', direction = null, active = true, includeNetWorth = true }) => ({
  id,
  attributes: {
    active,
    include_net_worth: includeNetWorth,
    type: { fireflyCode: type },
    account_role: role ? { fireflyCode: role } : null,
    liability_direction: direction ? { fireflyCode: direction } : null,
  },
})

const typedAccount = ({ type, role = null, direction = null }) => ({
  attributes: {
    type: { fireflyCode: type },
    account_role: role ? { fireflyCode: role } : null,
    liability_direction: direction ? { fireflyCode: direction } : null,
  },
})

const split = ({ amount, date, source, destination, categoryId = null, primaryAmount = null }) => ({
  amount: String(amount),
  primary_amount: primaryAmount,
  currency_code: 'USD',
  date: new Date(date + 'T12:00:00Z'),
  accountSource: source,
  accountDestination: destination,
  category_id: categoryId,
})

const transaction = (id, parts) => ({
  id,
  attributes: { transactions: parts },
})

const checking = typedAccount({ type: 'asset' })
const otherChecking = typedAccount({ type: 'asset' })
const card = typedAccount({ type: 'asset', role: 'ccAsset' })
const expense = typedAccount({ type: 'expense' })
const revenue = typedAccount({ type: 'revenue' })
const savings = typedAccount({ type: 'asset', role: 'savingAsset' })

const ledgerBucketInTimezone = ({ timeZone, dateParts }) => {
  const analyticsUrl = new URL('../../utils/AnalyticsUtils.js', import.meta.url).href
  const script = `
    import { buildCategoryLedger } from ${JSON.stringify(analyticsUrl)}

    const account = (type) => ({ attributes: { type: { fireflyCode: type } } })
    const ledger = buildCategoryLedger({
      displayCurrencyCode: 'USD',
      primaryCurrencyCode: 'USD',
      rates: { USD: 1 },
      transactions: [{
        id: 'boundary',
        attributes: {
          transactions: [{
            amount: '1',
            primary_amount: null,
            currency_code: 'USD',
            date: new Date(${dateParts.join(', ')}),
            accountSource: account('asset'),
            accountDestination: account('expense'),
            category_id: 'food',
          }],
        },
      }],
    })
    const category = ledger.months[ledger.ledgerStartMonth].categories.food
    console.log(JSON.stringify({ month: ledger.ledgerStartMonth, days: Object.keys(category.byDay) }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: timeZone },
  })

  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}

test('groups active net-worth, savings, debit liabilities, and credit cards', () => {
  const groups = getAnalyticsAccountGroups([
    account({ id: 'checking' }),
    account({ id: 'saving', role: 'savingAsset' }),
    account({ id: 'card', role: 'ccAsset' }),
    account({ id: 'mortgage', type: 'liabilities', role: null, direction: 'debit' }),
    account({ id: 'receivable', type: 'liabilities', role: null, direction: 'credit' }),
    account({ id: 'hidden', active: false }),
    account({ id: 'excluded', includeNetWorth: false }),
    {
      id: 'cash',
      attributes: {
        active: true,
        include_net_worth: true,
        type: 'cash',
        account_role: 'defaultAsset',
        liability_direction: null,
      },
    },
  ])

  assert.deepEqual(
    groups.netWorth.map(({ id }) => id),
    ['checking', 'saving', 'card', 'mortgage', 'receivable', 'cash'],
  )
  assert.deepEqual(
    groups.savings.map(({ id }) => id),
    ['saving'],
  )
  assert.deepEqual(
    groups.debt.map(({ id }) => id),
    ['card', 'mortgage'],
  )
})

test('prefers exact primary values and labels current-rate conversion', () => {
  assert.deepEqual(
    convertAnalyticsAmount({
      amount: '90',
      currencyCode: 'EUR',
      primaryAmount: '100',
      primaryCurrencyCode: 'USD',
      displayCurrencyCode: 'USD',
      rates: { USD: 1, EUR: 0.9 },
    }),
    { value: 100, isEstimated: false, missingCurrency: null },
  )

  assert.deepEqual(
    convertAnalyticsAmount({
      amount: '90',
      currencyCode: 'EUR',
      primaryAmount: null,
      primaryCurrencyCode: 'USD',
      displayCurrencyCode: 'USD',
      rates: { USD: 1, EUR: 0.9 },
    }),
    { value: 100, isEstimated: true, missingCurrency: null },
  )
})

test('omits amounts when a required rate is missing', () => {
  assert.deepEqual(
    convertAnalyticsAmount({
      amount: '90',
      currencyCode: 'EUR',
      primaryAmount: null,
      primaryCurrencyCode: 'USD',
      displayCurrencyCode: 'USD',
      rates: { USD: 1 },
    }),
    { value: null, isEstimated: false, missingCurrency: 'EUR' },
  )
})

test('aligns dates, carries forward only after first history, and normalizes debt owed', () => {
  const result = normalizeBalanceSeries({
    metric: 'debt',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    chartLines: [
      { currency_code: 'USD', entries: { '2026-01-01': '-100', '2026-01-03': '-80' } },
      { currency_code: 'USD', entries: { '2026-01-02': '-50', '2026-01-03': '10' } },
    ],
  })

  assert.deepEqual(result.points, [
    { x: '2026-01-01', value: 100 },
    { x: '2026-01-02', value: 150 },
    { x: '2026-01-03', value: 80 },
  ])
  assert.equal(result.isEstimated, false)
})

test('uses exact primary chart entries when available', () => {
  const result = normalizeBalanceSeries({
    metric: 'netWorth',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: {},
    chartLines: [
      {
        currency_code: 'EUR',
        entries: { '2026-01-01': '90' },
        pc_currency_code: 'USD',
        pc_entries: { '2026-01-01': '100' },
      },
    ],
  })

  assert.deepEqual(result, {
    points: [{ x: '2026-01-01', value: 100 }],
    isEstimated: false,
    missingCurrencies: [],
  })
})

test('category ledger counts purchases, subtracts refunds, preserves uncategorized, and keeps group IDs', () => {
  const ledger = buildCategoryLedger({
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('history-start', [split({ amount: 1, date: '2025-12-15', source: checking, destination: otherChecking })]),
      transaction('purchase', [split({ amount: 120, date: '2026-01-05', source: card, destination: expense, categoryId: 'food' })]),
      transaction('refund', [split({ amount: 20, date: '2026-01-09', source: expense, destination: checking, categoryId: 'food' })]),
      transaction('unknown', [split({ amount: 15, date: '2026-01-10', source: checking, destination: expense })]),
    ],
  })

  assert.equal(ledger.ledgerStartMonth, '2025-12')
  assert.equal(ledger.months['2026-01'].categories.food.amount, 100)
  assert.deepEqual(ledger.months['2026-01'].categories.food.transactionIds.sort(), ['purchase', 'refund'])
  assert.equal(ledger.months['2026-01'].categories[ANALYTICS_UNCATEGORIZED_ID].amount, 15)
})

for (const { timeZone, dateParts, expected } of [
  { timeZone: 'Pacific/Kiritimati', dateParts: [2026, 1, 1, 0, 30], expected: { month: '2026-02', days: ['1'] } },
  { timeZone: 'America/Los_Angeles', dateParts: [2026, 0, 31, 23, 30], expected: { month: '2026-01', days: ['31'] } },
]) {
  test(`category ledger uses local calendar month and day in ${timeZone}`, () => {
    assert.deepEqual(ledgerBucketInTimezone({ timeZone, dateParts }), expected)
  })
}

test('completed-month averages count zero months only after ledger history begins', () => {
  const ledger = {
    ledgerStartMonth: '2026-01',
    months: {
      '2026-01': { categories: { food: { amount: 90, byDay: { 5: 40, 25: 50 }, transactionIds: ['jan'] } } },
      '2026-03': { categories: { food: { amount: 30, byDay: { 8: 10, 20: 20 }, transactionIds: ['mar'] } } },
      '2026-04': { categories: { food: { amount: 12, byDay: { 8: 12 }, transactionIds: ['apr'], transactionIdsByDay: { 8: ['apr'] } } } },
    },
  }

  const summary = summarizeCategoryWindow({
    ledger,
    categoryIds: ['food'],
    averageMonths: 3,
    today: new Date('2026-04-10T12:00:00Z'),
  })

  assert.deepEqual(summary.monthKeys, ['2026-01', '2026-02', '2026-03'])
  assert.equal(summary.requestedMonths, 3)
  assert.equal(summary.usedMonths, 3)
  assert.deepEqual(summary.series[0].actualPoints, [
    { x: '2026-01', value: 90, transactionIds: ['jan'] },
    { x: '2026-02', value: 0, transactionIds: [] },
    { x: '2026-03', value: 30, transactionIds: ['mar'] },
  ])
  assert.equal(summary.series[0].average, 40)
  assert.equal(summary.series[0].currentActual, 12)
  assert.deepEqual(summary.series[0].currentTransactionIds, ['apr'])
  assert.ok(Math.abs(summary.series[0].currentForecast - (12 + 70 / 3)) < 0.000001)
  assert.equal(summary.series[0].forecastAvailable, true)
})

for (const averageMonths of [3, 6, 12, 24]) {
  test(`completed ${averageMonths}-month window excludes the current month`, () => {
    const summary = summarizeCategoryWindow({
      ledger: { ledgerStartMonth: '2024-04', months: {} },
      categoryIds: ['food'],
      averageMonths,
      today: new Date('2026-04-10T12:00:00Z'),
    })

    assert.equal(summary.requestedMonths, averageMonths)
    assert.equal(summary.usedMonths, averageMonths)
    assert.equal(summary.monthKeys.length, averageMonths)
    assert.equal(summary.monthKeys.at(-1), '2026-03')
    assert.equal(summary.monthKeys.includes('2026-04'), false)
  })
}

test('forecast is absent with fewer than two completed months', () => {
  const summary = summarizeCategoryWindow({
    ledger: {
      ledgerStartMonth: '2026-03',
      months: {
        '2026-03': { categories: { food: { amount: 20, byDay: { 20: 20 }, transactionIds: ['mar'] } } },
        '2026-04': { categories: { food: { amount: 5, byDay: { 5: 5 }, transactionIds: ['apr'] } } },
      },
    },
    categoryIds: ['food'],
    averageMonths: 3,
    today: new Date('2026-04-10T12:00:00Z'),
  })

  assert.equal(summary.usedMonths, 1)
  assert.equal(summary.series[0].currentForecast, null)
  assert.equal(summary.series[0].forecastAvailable, false)
})

test('current actual, drilldown IDs, and forecast base include only splits through today', () => {
  const ledger = buildCategoryLedger({
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('jan-later', [split({ amount: 40, date: '2026-01-20', source: checking, destination: expense, categoryId: 'food' })]),
      transaction('mar-later', [split({ amount: 20, date: '2026-03-20', source: checking, destination: expense, categoryId: 'food' })]),
      transaction('current-past', [split({ amount: 10, date: '2026-04-05', source: checking, destination: expense, categoryId: 'food' })]),
      transaction('current-future', [split({ amount: 90, date: '2026-04-20', source: checking, destination: expense, categoryId: 'food' })]),
    ],
  })

  const summary = summarizeCategoryWindow({
    ledger,
    categoryIds: ['food'],
    averageMonths: 3,
    today: new Date('2026-04-10T12:00:00Z'),
  })

  assert.equal(summary.series[0].currentActual, 10)
  assert.deepEqual(summary.series[0].currentTransactionIds, ['current-past'])
  assert.equal(summary.series[0].currentForecast, 30)
})

test('category ranking uses the selected completed-month window', () => {
  const ids = rankCategoryIds({
    ledger: {
      ledgerStartMonth: '2026-02',
      months: {
        '2026-02': { categories: { food: { amount: 20 }, rent: { amount: 100 } } },
        '2026-03': { categories: { food: { amount: 50 }, rent: { amount: 100 } } },
      },
    },
    averageMonths: 2,
    today: new Date('2026-04-10T12:00:00Z'),
  })
  assert.deepEqual(ids, ['rent', 'food'])
})

test('category ranking uses category ID as a stable tie-breaker', () => {
  const ids = rankCategoryIds({
    ledger: {
      ledgerStartMonth: '2026-03',
      months: {
        '2026-03': { categories: { rent: { amount: 50 }, food: { amount: 50 } } },
      },
    },
    averageMonths: 1,
    today: new Date('2026-04-10T12:00:00Z'),
  })
  assert.deepEqual(ids, ['food', 'rent'])
})

test('money flow treats card purchases as expense plus new debt and card payments as repayment', () => {
  const flow = buildMonthlyMoneyFlow({
    monthKey: '2026-04',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('income', [split({ amount: 1000, date: '2026-04-01', source: revenue, destination: checking })]),
      transaction('expense', [split({ amount: 200, date: '2026-04-02', source: checking, destination: expense })]),
      transaction('save', [split({ amount: 300, date: '2026-04-03', source: checking, destination: savings })]),
      transaction('card-buy', [split({ amount: 100, date: '2026-04-04', source: card, destination: expense })]),
      transaction('card-pay', [split({ amount: 50, date: '2026-04-05', source: checking, destination: card })]),
    ],
  })

  assert.deepEqual(Object.fromEntries(flow.sources.map((node) => [node.id, node.value])), {
    income: 1000,
    newDebt: 50,
  })
  assert.deepEqual(Object.fromEntries(flow.destinations.map((node) => [node.id, node.value])), {
    expenses: 300,
    savingsDeposited: 300,
    newExcess: 450,
  })
  assert.equal(flow.audit.priorExcessUsed, 0)
  assert.equal(flow.audit.newExcess, 450)
  assert.equal(flow.audit.sourceTotal, 1050)
  assert.equal(flow.audit.destinationTotal, 1050)
  assert.equal(flow.audit.equationDifference, 0)
  assert.equal(flow.isBalanced, true)
  assert.deepEqual(flow.audit.debtIncreaseIds, ['card-buy'])
  assert.deepEqual(flow.audit.debtRepaymentIds, ['card-pay'])
})

test('money flow nets savings and debt, cancels internal transfers, and exposes refunds as a source', () => {
  const otherSavings = typedAccount({ type: 'asset', role: 'savingAsset' })
  const otherDebt = typedAccount({ type: 'liabilities', direction: 'debit' })
  const flow = buildMonthlyMoneyFlow({
    monthKey: '2026-05',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('save-in', [split({ amount: 100, date: '2026-05-01', source: checking, destination: savings })]),
      transaction('save-out', [split({ amount: 40, date: '2026-05-02', source: savings, destination: checking })]),
      transaction('save-internal', [split({ amount: 20, date: '2026-05-03', source: savings, destination: otherSavings })]),
      transaction('debt-internal', [split({ amount: 25, date: '2026-05-04', source: card, destination: otherDebt })]),
      transaction('refund', [split({ amount: 30, date: '2026-05-05', source: expense, destination: checking, categoryId: 'food' })]),
    ],
  })

  assert.equal(flow.audit.savingsDeposited, 60)
  assert.equal(flow.audit.savingsWithdrawn, 0)
  assert.equal(flow.audit.newDebt, 0)
  assert.equal(flow.audit.debtRepaid, 0)
  assert.equal(flow.audit.netRefunds, 30)
  assert.equal(flow.audit.priorExcessUsed, 30)
  assert.equal(flow.audit.newExcess, 0)
  assert.equal(flow.audit.sourceTotal, 60)
  assert.equal(flow.audit.destinationTotal, 60)
  assert.equal(flow.audit.equationDifference, 0)
  assert.equal(flow.isBalanced, true)
})

test('empty money flow closes exactly within currency tolerance', () => {
  const flow = buildMonthlyMoneyFlow({
    monthKey: '2026-06',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [],
  })
  assert.equal(flow.audit.equationDifference, 0)
  assert.equal(flow.isBalanced, true)
})

test('split groups contribute their parent transaction ID only once per node', () => {
  const flow = buildMonthlyMoneyFlow({
    monthKey: '2026-06',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    transactions: [
      transaction('split-income', [
        split({ amount: 10, date: '2026-06-01', source: revenue, destination: checking }),
        split({ amount: 15, date: '2026-06-01', source: revenue, destination: checking }),
      ]),
    ],
  })
  const incomeNode = flow.sources.find(({ id }) => id === 'income')
  assert.equal(incomeNode.value, 25)
  assert.deepEqual(incomeNode.transactionIds, ['split-income'])
})
