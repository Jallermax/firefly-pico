import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import * as AnalyticsUtils from '../../utils/AnalyticsUtils.js'
import {
  ANALYTICS_UNCATEGORIZED_ID,
  buildFinancialTrendChartSeries,
  buildCategoryLedger,
  buildGrossCategoryLedger,
  buildMonthlyMoneyFlow,
  combineSavingsBalanceSeries,
  convertAnalyticsAmount,
  getAnalyticsAccountGroups,
  getAnalyticsCurrentAmount,
  normalizeBalanceSeries,
  rankCategoryIds,
  summarizeBalanceMovements,
  summarizeCategoryWindow,
  summarizeTotalExpenseWindow,
} from '../../utils/AnalyticsUtils.js'

const withoutTransactionIds = (point) => {
  const copy = { ...point }
  delete copy.transactionIds
  return copy
}

test('gross category ledger preserves usable gross spending when refund conversion is unavailable', () => {
  const ledger = {
    coverage: { startMonth: '2026-07' },
    entries: [
      { transactionId: 'purchase', monthKey: '2026-08', day: 3, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food', value: 40 },
      {
        transactionId: 'refund-unavailable',
        monthKey: '2026-08',
        day: 4,
        sourceKind: 'expense',
        destinationKind: 'available',
        categoryId: 'food',
        value: null,
        refund: { isRefund: true, coverageCategoryId: 'food' },
        conversion: { missingCurrency: 'EUR' },
      },
    ],
    fx: { isEstimated: false, missingCurrencies: [] },
  }

  const result = buildGrossCategoryLedger({ ledger, coverage: ledger.coverage })

  assert.deepEqual(result.months['2026-08'].categories.food, {
    amount: 40,
    byDay: { 3: 40 },
    transactionIds: ['purchase'],
    transactionIdsByDay: { 3: ['purchase'] },
    refundedAmount: 0,
    refundedAmountByDay: {},
    refundTransactionIds: [],
    refundTransactionIdsByDay: {},
    unavailableRefundTransactionIds: ['refund-unavailable'],
  })
  assert.deepEqual(result.unclassified.transactionIds, [])
  assert.deepEqual(result.unavailableRefundTransactionIds, ['refund-unavailable'])
})

test('attributes only explicit linked or tagged refunds to their coverage month', () => {
  const result = buildGrossCategoryLedger({
    coverage: { startMonth: '2026-07' },
    ledger: {
      entries: [
        { transactionId: 'ordinary-deposit', monthKey: '2026-08', day: 2, sourceKind: 'expense', destinationKind: 'available', categoryId: 'food', value: 20 },
        {
          transactionId: 'linked-refund',
          monthKey: '2026-08',
          day: 3,
          sourceKind: 'expense',
          destinationKind: 'available',
          value: 15,
          refund: { coverageMonthKey: '2026-07', coverageCategoryId: 'food' },
        },
      ],
      fx: { isEstimated: false, missingCurrencies: [] },
    },
  })
  assert.equal(result.months['2026-08']?.categories?.food, undefined)
  assert.equal(result.months['2026-07'].categories.food.refundedAmount, 15)
  assert.deepEqual(result.months['2026-07'].categories.food.refundTransactionIds, ['linked-refund'])
})

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

const typedAccount = ({ id = null, name = null, type, role = null, direction = null, includeNetWorth = true }) => ({
  id,
  attributes: {
    name,
    include_net_worth: includeNetWorth,
    type: { fireflyCode: type },
    account_role: role ? { fireflyCode: role } : null,
    liability_direction: direction ? { fireflyCode: direction } : null,
  },
})

const split = ({ amount, date, source, destination, categoryId = null, categoryName = null, primaryAmount = null, currencyCode = 'USD' }) => ({
  amount: String(amount),
  primary_amount: primaryAmount,
  currency_code: currencyCode,
  date: new Date(date + 'T12:00:00Z'),
  accountSource: source,
  accountDestination: destination,
  category_id: categoryId,
  category_name: categoryName,
})

const transaction = (id, parts) => ({
  id,
  attributes: { transactions: parts },
})

const checking = typedAccount({ type: 'asset' })
const otherChecking = typedAccount({ type: 'asset' })
const card = typedAccount({ type: 'asset', role: 'ccAsset' })
const expense = typedAccount({ type: 'expense' })

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

test('groups all liabilities as debt and keeps credit cards in available net worth', () => {
  const groups = getAnalyticsAccountGroups([
    account({ id: 'checking' }),
    account({ id: 'saving-in', role: 'savingAsset', includeNetWorth: true }),
    account({ id: 'saving-out', role: 'savingAsset', includeNetWorth: false }),
    account({ id: 'card', role: 'ccAsset' }),
    account({ id: 'loan', type: 'liabilities', role: null, direction: 'debit' }),
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
    ['checking', 'saving-in', 'card', 'loan', 'receivable', 'cash'],
  )
  assert.deepEqual(
    groups.savingsIncluded.map(({ id }) => id),
    ['saving-in'],
  )
  assert.deepEqual(
    groups.savingsExcluded.map(({ id }) => id),
    ['saving-out'],
  )
  assert.deepEqual(
    groups.debt.map(({ id }) => id),
    ['loan', 'receivable'],
  )
  assert.equal(
    groups.debt.some(({ id }) => id === 'card'),
    false,
  )
})

test('classifies credit cards and non-savings asset accounts as available', () => {
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(typedAccount({ type: 'asset', role: 'ccAsset' })), 'available')
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(typedAccount({ type: 'asset' })), 'available')
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(typedAccount({ type: 'cash' })), 'available')
})

test('normalizes each current liability amount before it is aggregated', () => {
  const liability = account({ id: 'loan', type: 'liabilities', role: null, direction: 'credit' })
  liability.attributes.current_debt = '-900'

  assert.equal(getAnalyticsCurrentAmount({ account: liability, metric: 'debt', fallbackAmount: 250 }), 900)
  assert.equal(getAnalyticsCurrentAmount({ account: { attributes: { current_debt: '   ' } }, metric: 'debt', fallbackAmount: -250 }), 250)
  assert.equal(getAnalyticsCurrentAmount({ account: liability, metric: 'netWorth', fallbackAmount: -100 }), -100)
  assert.equal(getAnalyticsCurrentAmount({ account: liability, metric: 'debt', fallbackAmount: 'not a number' }), 900)
  assert.equal(getAnalyticsCurrentAmount({ account: { attributes: { current_debt: 'not a number' } }, metric: 'debt', fallbackAmount: 10 }), null)
  assert.equal(getAnalyticsCurrentAmount({ account: { attributes: { current_debt: '   ' } }, metric: 'debt', fallbackAmount: '   ' }), null)
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

test('keeps absent source amounts missing instead of coercing them to zero', () => {
  for (const amount of [null, undefined, '   ']) {
    assert.deepEqual(convertAnalyticsAmount({ amount, currencyCode: 'USD', primaryAmount: null, primaryCurrencyCode: 'USD', displayCurrencyCode: 'USD', rates: { USD: 1 } }), {
      value: null,
      isEstimated: false,
      missingCurrency: null,
    })
  }
})

test('withholds invalid category amounts and audits their transaction IDs', () => {
  const transactions = [
    transaction('null-amount', [{ ...split({ amount: 1, date: '2026-08-01', source: checking, destination: expense, categoryId: 'food' }), amount: null }]),
    transaction('blank-amount', [{ ...split({ amount: 1, date: '2026-08-02', source: checking, destination: expense, categoryId: 'food' }), amount: '   ' }]),
    transaction('non-finite-amount', [{ ...split({ amount: 1, date: '2026-08-03', source: checking, destination: expense, categoryId: 'food' }), amount: Number.NaN }]),
  ]
  const ledger = buildCategoryLedger({ transactions, displayCurrencyCode: 'USD', primaryCurrencyCode: 'USD', rates: { USD: 1 } })

  assert.deepEqual(ledger.months, {})
  assert.deepEqual(ledger.unclassified, { value: null, transactionIds: ['blank-amount', 'non-finite-amount', 'null-amount'] })
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
    { x: '2026-01-03', value: 90 },
  ])
  assert.equal(result.isEstimated, false)
})

test('normalizes every liability magnitude before aggregation', () => {
  const result = normalizeBalanceSeries({
    metric: 'debt',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    chartLines: [
      { currency_code: 'USD', entries: { '2026-07-31': '-900' } },
      { currency_code: 'USD', entries: { '2026-07-31': '250' } },
    ],
  })
  assert.deepEqual(result.points, [{ x: '2026-07-31', value: 1150 }])
})

test('combines complete savings groups on their union of dates without inventing early history', () => {
  const combined = combineSavingsBalanceSeries({
    includedSeries: {
      id: 'savingsIncluded',
      points: [
        { x: '2026-01-31', value: 100 },
        { x: '2026-03-31', value: 150 },
      ],
      currentPoint: { x: '2026-04-10', value: 160 },
      isEstimated: true,
      missingCurrencies: [],
      warnings: ['included warning'],
    },
    excludedSeries: {
      id: 'savingsExcluded',
      points: [
        { x: '2026-02-28', value: 40 },
        { x: '2026-03-31', value: 50 },
      ],
      currentPoint: { x: '2026-04-10', value: 55 },
      missingCurrencies: [],
      warnings: ['excluded warning'],
    },
    includedIsEmpty: false,
    excludedIsEmpty: false,
  })

  assert.deepEqual(combined.points, [
    { x: '2026-02-28', value: 140 },
    { x: '2026-03-31', value: 200 },
  ])
  assert.equal(combined.currentPoint.value, 215)
  assert.equal(combined.isEstimated, true)
  assert.deepEqual(combined.missingCurrencies, [])
  assert.deepEqual(combined.warnings, ['included warning', 'excluded warning'])
})

test('withholds combined current savings when one non-empty group has no current point', () => {
  const combined = combineSavingsBalanceSeries({
    includedSeries: {
      points: [
        { x: '2026-01-31', value: 100 },
        { x: '2026-02-28', value: 120 },
      ],
      currentPoint: { x: '2026-03-10', value: 125 },
      missingCurrencies: [],
      warnings: [],
    },
    excludedSeries: {
      points: [{ x: '2026-02-28', value: 40 }],
      currentPoint: null,
      missingCurrencies: [],
      warnings: [],
    },
    includedIsEmpty: false,
    excludedIsEmpty: false,
  })

  assert.deepEqual(combined.points, [{ x: '2026-02-28', value: 160 }])
  assert.equal(combined.currentPoint, null)
})

test('withholds combined savings when a non-empty group reports a missing currency', () => {
  const combined = combineSavingsBalanceSeries({
    includedSeries: {
      points: [{ x: '2026-03-31', value: 100 }],
      currentPoint: { x: '2026-04-10', value: 100 },
      missingCurrencies: [],
      warnings: [],
    },
    excludedSeries: {
      points: [{ x: '2026-03-31', value: 40 }],
      currentPoint: { x: '2026-04-10', value: 40 },
      missingCurrencies: ['JPY'],
      warnings: ['missing rate'],
    },
    includedIsEmpty: false,
    excludedIsEmpty: false,
  })

  assert.deepEqual(combined, {
    points: [],
    currentPoint: null,
    isEstimated: false,
    missingCurrencies: ['JPY'],
    warnings: ['missing rate'],
  })
})

test('requires each non-empty savings group but treats an empty group as zero', () => {
  const includedSeries = { points: [{ x: '2026-03-31', value: 100 }], currentPoint: { x: '2026-04-10', value: 110 } }
  const excludedSeries = { points: [{ x: '2026-03-31', value: 50 }], currentPoint: { x: '2026-04-10', value: 55 } }

  assert.equal(combineSavingsBalanceSeries({ includedSeries: null, excludedSeries, includedIsEmpty: false, excludedIsEmpty: false }), null)
  assert.deepEqual(combineSavingsBalanceSeries({ includedSeries, excludedSeries: null, includedIsEmpty: false, excludedIsEmpty: true }).points, [{ x: '2026-03-31', value: 100 }])
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

test('retains estimation metadata on normalized account-chart points', () => {
  const result = normalizeBalanceSeries({
    metric: 'debt',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1, EUR: 0.9 },
    chartLines: [{ currency_code: 'EUR', entries: { '2026-08-07': '-90' } }],
  })

  assert.deepEqual(result.points, [{ x: '2026-08-07', value: 100, isEstimated: true }])
})

test('normalizes Firefly Atom chart keys without shifting the source day', () => {
  const result = normalizeBalanceSeries({
    metric: 'netWorth',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: {},
    chartLines: [{ primary_currency_code: 'USD', pc_entries: { '2026-08-02T00:00:00+00:00': '125' } }],
  })

  assert.deepEqual(result.points, [{ x: '2026-08-02', value: 125 }])
})

test('ignores invalid account-chart date keys', () => {
  const result = normalizeBalanceSeries({
    metric: 'netWorth',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    chartLines: [{ currency_code: 'USD', entries: { invalid: '10', '2026-08-02': '20' } }],
  })

  assert.deepEqual(result.points, [{ x: '2026-08-02', value: 20 }])
})

test('builds completed and partial monthly account movement from month-end totals', () => {
  const result = summarizeBalanceMovements({
    months: 3,
    today: new Date('2026-08-10T12:00:00Z'),
    balanceSeries: [
      {
        id: 'netWorth',
        points: [
          { x: '2026-05-31', value: 100 },
          { x: '2026-06-30', value: 130 },
          { x: '2026-07-31', value: 120 },
          { x: '2026-08-07', value: 140 },
        ],
        currentPoint: { x: '2026-08-10', value: 150 },
      },
      {
        id: 'debt',
        points: [
          { x: '2026-05-31', value: 80 },
          { x: '2026-06-30', value: 60 },
          { x: '2026-07-31', value: 75 },
          { x: '2026-08-07', value: 72 },
        ],
        currentPoint: { x: '2026-08-10', value: 70 },
      },
    ],
  })

  assert.deepEqual(result.monthKeys, ['2026-05', '2026-06', '2026-07', '2026-08'])
  assert.deepEqual(result.series.find(({ id }) => id === 'netWorth').changePoints.map(withoutTransactionIds), [
    { x: '2026-06', value: 30, kind: 'actual' },
    { x: '2026-07', value: -10, kind: 'actual' },
    { x: '2026-08', value: 30, kind: 'partial' },
  ])
  assert.deepEqual(
    result.series.find(({ id }) => id === 'debt').changePoints.map(({ value }) => value),
    [-20, 15, -5],
  )
})

test('uses adjacent cumulative-anchor differences for completed balance and change transaction IDs', () => {
  const result = summarizeBalanceMovements({
    months: 2,
    today: new Date('2026-08-10T12:00:00Z'),
    balanceSeries: [
      {
        id: 'netWorth',
        points: [
          { x: '2026-05-31', value: 100, transactionIds: ['may', 'june', 'july'] },
          { x: '2026-06-30', value: 120, transactionIds: ['june', 'july'] },
          { x: '2026-07-31', value: 130, transactionIds: ['july'] },
        ],
        currentPoint: { x: '2026-08-10', value: 140, transactionIds: ['august'] },
      },
    ],
  }).series[0]

  assert.deepEqual(
    result.totalPoints.map(({ x, transactionIds }) => [x, transactionIds]),
    [
      ['2026-06', ['may']],
      ['2026-07', ['june']],
      ['2026-08', ['august']],
    ],
  )
  assert.deepEqual(
    result.changePoints.map(({ x, transactionIds }) => [x, transactionIds]),
    [
      ['2026-06', ['may']],
      ['2026-07', ['june']],
      ['2026-08', ['august']],
    ],
  )
})

test('keeps Task 8 metadata on Today and forecast points while omitting legacy utility forecasts', () => {
  const trend = buildFinancialTrendChartSeries({
    view: 'balances',
    metrics: [{ id: 'netWorth' }],
    selectedIds: ['netWorth'],
    accountSeries: [
      {
        id: 'netWorth',
        totalPoints: [
          { x: '2026-07', value: 10, kind: 'actual' },
          { x: '2026-08', value: 12, kind: 'partial' },
        ],
        forecastAvailable: true,
        forecastTotal: 15,
        actualTransactionIds: ['actual'],
        actualToDate: 2,
        final: 5,
        remainingFromToday: 3,
        progress: 0.4,
        progressState: 'ready',
        status: 'ready',
        projectedSources: [
          { id: 'zero', flowAmounts: { netWorthChange: 0 } },
          { id: 'missing', flowAmounts: {} },
          { id: 'nonzero', flowAmounts: { netWorthChange: 3 } },
        ],
      },
    ],
    expenses: null,
    currentMonthKey: '2026-08',
  })[0].points
  assert.deepEqual(trend.find(({ kind }) => kind === 'partial').transactionIds, ['actual'])
  assert.deepEqual(
    trend.find(({ kind }) => kind === 'forecast').projectedSources.map(({ id }) => id),
    ['nonzero'],
  )
  const summary = summarizeCategoryWindow({ ledger: { ledgerStartMonth: '2026-07', months: {} }, categoryIds: ['food'], averageMonths: 1, today: new Date('2026-08-10') }).series[0]
  assert.equal('pacedForecast' in summary, false)
  assert.equal('currentForecast' in summary, false)
})

test('category summary utility exposes completed actual evidence only, never a legacy forecast', () => {
  const summary = summarizeCategoryWindow({
    ledger: { ledgerStartMonth: '2026-07', months: { '2026-07': { categories: { food: { amount: 4, byDay: {}, transactionIds: [], transactionIdsByDay: {} } } } } },
    categoryIds: ['food'],
    averageMonths: 1,
    today: new Date('2026-08-10'),
  }).series[0]
  assert.equal('pacedForecast' in summary, false)
  assert.equal('currentForecast' in summary, false)
  assert.equal('remainingFromToday' in summary, false)
})

test('balance utility exposes actual movement evidence without a legacy forecast', () => {
  const result = summarizeBalanceMovements({
    balanceSeries: [
      {
        id: 'savings',
        points: [
          { x: '2025-12-31', value: 1000 },
          { x: '2026-01-31', value: 1100 },
          { x: '2026-02-28', value: 1200 },
          { x: '2026-03-31', value: 1300 },
        ],
        currentPoint: { x: '2026-04-10', value: 1350 },
      },
    ],
    months: 3,
    today: new Date('2026-04-10T12:00:00'),
  }).series[0]

  assert.equal(result.currentTotal, 1350)
  assert.equal('forecastTotal' in result, false)
  assert.equal('remainingFromToday' in result, false)
})

test('retains zero balance movement while leaving forecasts to the store', () => {
  const result = summarizeBalanceMovements({
    balanceSeries: [
      {
        id: 'savings',
        points: [
          { x: '2025-12-31', value: 1000 },
          { x: '2026-01-31', value: 1000 },
          { x: '2026-02-28', value: 1000 },
          { x: '2026-03-31', value: 1000 },
        ],
        currentPoint: { x: '2026-04-10', value: 1000 },
      },
    ],
    months: 3,
    today: new Date('2026-04-10T12:00:00'),
  }).series[0]

  assert.equal(result.currentChange, 0)
  assert.equal('forecastChange' in result, false)
  assert.equal('remainingFromToday' in result, false)
})

test('omits monthly movement without a preceding baseline', () => {
  const result = summarizeBalanceMovements({
    months: 3,
    today: new Date('2026-08-10T12:00:00Z'),
    balanceSeries: [
      {
        id: 'netWorth',
        points: [
          { x: '2026-06-30', value: 100 },
          { x: '2026-07-31', value: 120 },
        ],
        currentPoint: { x: '2026-08-10', value: 130 },
      },
    ],
  })

  assert.deepEqual(result.series[0].changePoints.map(withoutTransactionIds), [
    { x: '2026-07', value: 20, kind: 'actual' },
    { x: '2026-08', value: 10, kind: 'partial' },
  ])
})

test('uses the final weekly sample in a completed month and requires current point for partial movement', () => {
  const result = summarizeBalanceMovements({
    months: 3,
    today: new Date('2026-08-10T12:00:00Z'),
    balanceSeries: [
      {
        id: 'netWorth',
        points: [
          { x: '2026-05-31', value: 100 },
          { x: '2026-06-07', value: 120 },
          { x: '2026-06-30', value: 130 },
          { x: '2026-07-31', value: 150 },
          { x: '2026-08-07', value: 170 },
        ],
        currentPoint: null,
      },
    ],
  })

  assert.deepEqual(result.series[0].changePoints.map(withoutTransactionIds), [
    { x: '2026-06', value: 30, kind: 'actual' },
    { x: '2026-07', value: 20, kind: 'actual' },
  ])
})

test('carries sparse account totals through completed months without a legacy forecast', () => {
  const result = summarizeBalanceMovements({
    months: 3,
    today: new Date('2026-08-10T12:00:00Z'),
    balanceSeries: [
      {
        id: 'netWorth',
        points: [
          { x: '2026-04-30', value: 100 },
          { x: '2026-05-31', value: 120 },
          { x: '2026-07-31', value: 130 },
          { x: '2026-08-07', value: 135 },
        ],
        currentPoint: { x: '2026-08-10', value: 130 },
      },
    ],
  })

  assert.deepEqual(result.monthKeys, ['2026-05', '2026-06', '2026-07', '2026-08'])
  assert.deepEqual(
    {
      ...result.series[0],
      totalPoints: result.series[0].totalPoints.map(withoutTransactionIds),
      changePoints: result.series[0].changePoints.map(withoutTransactionIds),
    },
    {
      id: 'netWorth',
      totalPoints: [
        { x: '2026-05', value: 120, kind: 'actual' },
        { x: '2026-06', value: 120, kind: 'actual' },
        { x: '2026-07', value: 130, kind: 'actual' },
        { x: '2026-08', value: 130, kind: 'partial' },
      ],
      changePoints: [
        { x: '2026-05', value: 20, kind: 'actual' },
        { x: '2026-06', value: 0, kind: 'actual' },
        { x: '2026-07', value: 10, kind: 'actual' },
        { x: '2026-08', value: 0, kind: 'partial' },
      ],
      currentTotal: 130,
      currentChange: 0,
      averageChange: 10,
    },
  )
})

test('does not carry account totals before the first source point', () => {
  const result = summarizeBalanceMovements({
    months: 3,
    today: new Date('2026-08-10T12:00:00Z'),
    balanceSeries: [
      {
        id: 'savings',
        points: [{ x: '2026-06-15', value: 50 }],
        currentPoint: { x: '2026-08-10', value: 50 },
      },
      {
        id: 'debt',
        points: [{ x: '2026-04-30', value: 80 }],
        currentPoint: null,
      },
      {
        id: 'newAccount',
        points: [{ x: '2026-08-07', value: 25 }],
        currentPoint: { x: '2026-08-10', value: 25 },
      },
    ],
  })

  assert.deepEqual(result.series[0].totalPoints.map(withoutTransactionIds), [
    { x: '2026-06', value: 50, kind: 'actual' },
    { x: '2026-07', value: 50, kind: 'actual' },
    { x: '2026-08', value: 50, kind: 'partial' },
  ])
  assert.deepEqual(result.series[0].changePoints.map(withoutTransactionIds), [
    { x: '2026-07', value: 0, kind: 'actual' },
    { x: '2026-08', value: 0, kind: 'partial' },
  ])
  assert.equal('forecastAvailable' in result.series[0], false)
  assert.equal('forecastChange' in result.series[0], false)
  assert.equal('forecastTotal' in result.series[0], false)
  assert.deepEqual(result.series[1].totalPoints.map(withoutTransactionIds), [
    { x: '2026-05', value: 80, kind: 'actual' },
    { x: '2026-06', value: 80, kind: 'actual' },
    { x: '2026-07', value: 80, kind: 'actual' },
  ])
  assert.deepEqual(result.series[1].changePoints.map(withoutTransactionIds), [
    { x: '2026-05', value: 0, kind: 'actual' },
    { x: '2026-06', value: 0, kind: 'actual' },
    { x: '2026-07', value: 0, kind: 'actual' },
  ])
  assert.equal(result.series[1].currentChange, null)
  assert.deepEqual(result.series[2].totalPoints, [])
  assert.deepEqual(result.series[2].changePoints, [])
  assert.equal(result.series[2].currentTotal, 25)
})

test('builds balance today separately while change and expense charts contain completed months plus a forecast', () => {
  assert.equal(typeof AnalyticsUtils.buildFinancialTrendChartSeries, 'function')
  const metrics = [
    { id: 'netWorth', label: 'Localized net worth' },
    { id: 'expenses', label: 'Localized expenses' },
  ]
  const accountSeries = [
    {
      id: 'netWorth',
      totalPoints: [
        { x: '2026-07', value: 130, kind: 'actual' },
        { x: '2026-08', value: 130, kind: 'partial' },
      ],
      changePoints: [
        { x: '2026-07', value: 10, kind: 'actual' },
        { x: '2026-08', value: 0, kind: 'partial' },
      ],
      forecastTotal: 140,
      forecastChange: 10,
      forecastAvailable: true,
    },
  ]
  const expenses = {
    actualPoints: [{ x: '2026-07', value: 30, kind: 'actual' }],
    currentActual: 10,
    currentForecast: 40,
    forecastAvailable: true,
  }

  const balancePoints = AnalyticsUtils.buildFinancialTrendChartSeries({ view: 'balances', metrics, selectedIds: ['netWorth'], accountSeries, expenses, currentMonthKey: '2026-08' })[0].points
  assert.deepEqual(
    balancePoints.map(({ x, value, kind }) => ({ x, value, kind })),
    [
      { x: '2026-07', value: 130, kind: 'actual' },
      { x: '2026-08', value: 130, kind: 'partial' },
      { x: '2026-08:forecast', value: 140, kind: 'forecast' },
    ],
  )
  const changeSeries = AnalyticsUtils.buildFinancialTrendChartSeries({ view: 'changes', metrics, selectedIds: ['netWorth', 'expenses'], accountSeries, expenses, currentMonthKey: '2026-08' })
  assert.deepEqual(
    changeSeries.map((series) => [series.id, series.points.map(({ x, kind }) => [x, kind])]),
    [
      [
        'netWorth',
        [
          ['2026-07', 'actual'],
          ['2026-08:forecast', 'forecast'],
        ],
      ],
      [
        'expenses',
        [
          ['2026-07', 'actual'],
          ['2026-08:forecast', 'forecast'],
        ],
      ],
    ],
  )
})

test('distinguishes insufficient forecast history from a genuinely missing forecast value', () => {
  assert.equal(typeof AnalyticsUtils.formatFinancialTrendForecastValue, 'function')
  const formatValue = (value) => (Number.isFinite(value) ? `${value} USD` : '—')

  assert.equal(
    AnalyticsUtils.formatFinancialTrendForecastValue({
      forecastAvailable: false,
      status: 'insufficientHistory',
      value: null,
      formatValue,
      insufficientHistoryLabel: 'Localized two-month minimum',
      unavailableLabel: 'Localized unavailable input',
    }),
    'Localized two-month minimum',
  )
  assert.equal(
    AnalyticsUtils.formatFinancialTrendForecastValue({
      forecastAvailable: false,
      status: 'unavailable',
      value: null,
      formatValue,
      insufficientHistoryLabel: 'Localized two-month minimum',
      unavailableLabel: 'Localized unavailable input',
    }),
    'Localized unavailable input',
  )
  assert.equal(AnalyticsUtils.formatFinancialTrendForecastValue({ forecastAvailable: true, value: null, formatValue, insufficientHistoryLabel: 'Localized two-month minimum' }), '—')
  assert.equal(AnalyticsUtils.formatFinancialTrendForecastValue({ forecastAvailable: true, value: 25, formatValue, insufficientHistoryLabel: 'Localized two-month minimum' }), '25 USD')
})

test('summarizes total expense from every category without a legacy forecast', () => {
  const result = summarizeTotalExpenseWindow({
    averageMonths: 3,
    today: new Date('2026-04-10T12:00:00Z'),
    ledger: {
      ledgerStartMonth: '2026-01',
      months: {
        '2026-01': { categories: { food: { amount: 40, byDay: { 20: 40 } }, rent: { amount: 60, byDay: { 2: 60 } } } },
        '2026-02': { categories: { food: { amount: 20, byDay: { 20: 20 } } } },
        '2026-03': { categories: { food: { amount: 30, byDay: { 20: 30 } } } },
        '2026-04': { categories: { food: { amount: 10, byDay: { 5: 10 } } } },
      },
    },
  })

  assert.deepEqual(
    result.actualPoints.map(({ value }) => value),
    [100, 20, 30],
  )
  assert.equal(result.currentActual, 10)
  assert.equal(result.average, 50)
  assert.equal('currentForecast' in result, false)
  assert.equal('remainingFromToday' in result, false)
  assert.equal('forecastAvailable' in result, false)
})

test('total expense aggregates historical and through-today refund coverage without plotting Today', () => {
  const result = summarizeTotalExpenseWindow({
    averageMonths: 1,
    today: new Date('2026-04-10T12:00:00Z'),
    ledger: {
      ledgerStartMonth: '2026-03',
      months: {
        '2026-03': { categories: { food: { amount: 20, refundedAmount: 5, refundTransactionIds: ['refund'], unavailableRefundTransactionIds: [], transactionIds: ['expense'], byDay: { 2: 20 } } } },
        '2026-04': {
          categories: {
            food: {
              amount: 30,
              refundedAmount: 10,
              refundTransactionIds: ['past-refund', 'future-refund'],
              unavailableRefundTransactionIds: [],
              transactionIds: ['past', 'future'],
              transactionIdsByDay: { 2: ['past'], 20: ['future'] },
              byDay: { 2: 10, 20: 20 },
            },
          },
        },
      },
    },
  })
  assert.deepEqual(result.actualPoints[0].refundCoverage, { gross: 20, refunded: 5, netCost: 15, transactionIds: ['refund'], unavailableTransactionIds: [], status: 'ready' })
  assert.deepEqual(result.refundCoverage, { gross: 10, refunded: 0, netCost: 10, transactionIds: [], unavailableTransactionIds: [], status: 'none' })
  assert.equal('currentPoint' in result, false)
})

test('total expense retains current-only uncategorized evidence without a legacy forecast', () => {
  const completedCategories = {
    housing: { amount: 2321, byDay: { 2: 2321 }, transactionIds: [], transactionIdsByDay: {} },
    food: { amount: 1000, byDay: { 25: 1000 }, transactionIds: [], transactionIdsByDay: {} },
  }
  const ledger = {
    ledgerStartMonth: '2026-05',
    months: {
      '2026-05': { categories: structuredClone(completedCategories) },
      '2026-06': { categories: structuredClone(completedCategories) },
      '2026-07': { categories: structuredClone(completedCategories) },
      '2026-08': {
        categories: {
          food: { amount: 2000, byDay: { 3: 2000 }, transactionIds: ['food-now'], transactionIdsByDay: { 3: ['food-now'] } },
          [ANALYTICS_UNCATEGORIZED_ID]: { amount: 140, byDay: { 3: 140 }, transactionIds: ['uncategorized-now'], transactionIdsByDay: { 3: ['uncategorized-now'] } },
        },
      },
    },
  }
  assert.equal(typeof AnalyticsUtils.getForecastCategoryIds, 'function')
  assert.deepEqual(AnalyticsUtils.getForecastCategoryIds({ ledger, averageMonths: 3, today: new Date('2026-08-03T12:00:00') }), ['food', 'housing', ANALYTICS_UNCATEGORIZED_ID])

  const result = summarizeTotalExpenseWindow({ ledger, averageMonths: 3, today: new Date('2026-08-03T12:00:00') })
  assert.equal(result.categoryIds.includes(ANALYTICS_UNCATEGORIZED_ID), true)
  assert.equal(result.currentActual, 2140)
  assert.equal(result.average, 3321)
  assert.equal(
    result.categoryForecasts.some((item) => item.id === ANALYTICS_UNCATEGORIZED_ID),
    true,
  )
  assert.equal('currentForecast' in result, false)
  assert.equal('remainingFromToday' in result, false)
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

const completedMonths = (keys, categories) => Object.fromEntries(keys.map((key) => [key, { categories: structuredClone(categories) }]))
const housingLedger = {
  ledgerStartMonth: '2026-05',
  months: {
    ...completedMonths(['2026-05', '2026-06', '2026-07'], {
      housing: { amount: 2321, byDay: { 2: 2321 }, transactionIds: [], transactionIdsByDay: {} },
    }),
    '2026-08': { categories: {} },
  },
}
const overspentLedger = {
  ledgerStartMonth: '2026-02',
  months: {
    ...completedMonths(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], {
      food: { amount: 7500, byDay: { 1: 7500 }, transactionIds: [], transactionIdsByDay: {} },
    }),
    '2026-08': {
      categories: {
        food: { amount: 9000, byDay: { 25: 9000 }, transactionIds: ['food-now'], transactionIdsByDay: { 25: ['food-now'] } },
      },
    },
  },
}
const pacedLedger = {
  ledgerStartMonth: '2026-05',
  months: {
    ...completedMonths(['2026-05', '2026-06', '2026-07'], {
      food: { amount: 1000, byDay: { 2: 600, 25: 400 }, transactionIds: [], transactionIdsByDay: {} },
    }),
    '2026-08': {
      categories: {
        food: { amount: 1000, byDay: { 3: 1000 }, transactionIds: ['food-now'], transactionIdsByDay: { 3: ['food-now'] } },
      },
    },
  },
}

test('category summary preserves a recurring expense as completed-history evidence', () => {
  const summary = summarizeCategoryWindow({ ledger: housingLedger, categoryIds: ['housing'], averageMonths: 3, today: new Date('2026-08-03T12:00:00') }).series[0]
  assert.equal(summary.currentActual, 0)
  assert.equal(summary.average, 2321)
  assert.equal('currentForecast' in summary, false)
  assert.equal('remainingFromToday' in summary, false)
})

test('category summary retains spending already recorded without a legacy forecast', () => {
  const summary = summarizeCategoryWindow({ ledger: overspentLedger, categoryIds: ['food'], averageMonths: 6, today: new Date('2026-08-25T12:00:00') }).series[0]
  assert.equal(summary.average, 7500)
  assert.equal(summary.currentActual, 9000)
  assert.equal('currentForecast' in summary, false)
  assert.equal('remainingFromToday' in summary, false)
})

test('category summary does not calculate a historical pace forecast', () => {
  const summary = summarizeCategoryWindow({ ledger: pacedLedger, categoryIds: ['food'], averageMonths: 3, today: new Date('2026-08-03T12:00:00') }).series[0]
  assert.equal(summary.average, 1000)
  assert.equal(summary.currentActual, 1000)
  assert.equal('pacedForecast' in summary, false)
  assert.equal('currentForecast' in summary, false)
  assert.equal('remainingFromToday' in summary, false)
})

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
    { x: '2026-01', value: 90, transactionIds: ['jan'], refundCoverage: { gross: 90, refunded: 0, netCost: 90, transactionIds: [], unavailableTransactionIds: [], status: 'none' } },
    { x: '2026-02', value: 0, transactionIds: [], refundCoverage: { gross: 0, refunded: 0, netCost: 0, transactionIds: [], unavailableTransactionIds: [], status: 'none' } },
    { x: '2026-03', value: 30, transactionIds: ['mar'], refundCoverage: { gross: 30, refunded: 0, netCost: 30, transactionIds: [], unavailableTransactionIds: [], status: 'none' } },
  ])
  assert.equal(summary.series[0].average, 40)
  assert.equal(summary.series[0].currentActual, 12)
  assert.deepEqual(summary.series[0].currentTransactionIds, ['apr'])
  assert.equal('pacedForecast' in summary.series[0], false)
  assert.equal('currentForecast' in summary.series[0], false)
  assert.equal('remainingFromToday' in summary.series[0], false)
  assert.equal('forecastAvailable' in summary.series[0], false)
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

test('category summary exposes evidence only with fewer than two completed months', () => {
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
  assert.equal('currentForecast' in summary.series[0], false)
  assert.equal('forecastAvailable' in summary.series[0], false)
})

test('current actual and drilldown IDs include only splits through today', () => {
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
  assert.equal('currentForecast' in summary.series[0], false)
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

const flowArgs = { monthKey: '2026-08', displayCurrencyCode: 'USD', primaryCurrencyCode: 'USD', rates: { USD: 1 }, currencyDecimalPlaces: 2, savingsView: 'combined' }
const nodeValue = (graph, id) => graph.nodes.find((node) => node.id === id)?.value ?? 0
const nodeTransactions = (graph, id) => graph.nodes.find((node) => node.id === id)?.transactionIds ?? []
const linkValue = (graph, sourceId, targetId) => graph.links.filter((link) => link.sourceId === sourceId && link.targetId === targetId).reduce((sum, link) => sum + link.value, 0)
const linkTotal = (graph, id, direction) => graph.links.filter((link) => link[`${direction}Id`] === id).reduce((sum, link) => sum + link.value, 0)

const ledgerEntry = ({
  id,
  value,
  sourceKind,
  destinationKind,
  categoryId = ANALYTICS_UNCATEGORIZED_ID,
  sourceAccountId = `${sourceKind}-source`,
  destinationAccountId = `${destinationKind}-destination`,
  monthKey = '2026-08',
  refund = {},
}) => ({
  id: `${id}:${id}-journal:0`,
  transactionId: id,
  journalId: `${id}-journal`,
  splitIndex: 0,
  date: `${monthKey}-05`,
  monthKey,
  day: 5,
  value,
  isEstimated: false,
  conversion: { mode: 'exact', sourceCurrency: 'USD' },
  sourceAccount: { id: sourceAccountId },
  destinationAccount: { id: destinationAccountId },
  sourceKind,
  destinationKind,
  categoryId,
  tags: [],
  refund: {
    isRefund: false,
    signals: [],
    linkedPurchaseTransactionId: null,
    linkedPurchaseMonthKey: null,
    coverageCategoryId: null,
    coverageMonthKey: null,
    coverageValue: null,
    isLinked: false,
    ...refund,
  },
})

const buildLedgerFlow = (entries, overrides = {}) => buildMonthlyMoneyFlow({ entries, ...flowArgs, ...overrides })

test('sorts income and expense categories by amount descending with stable ID ties', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({ id: 'income-z', value: 40, sourceKind: 'revenue', destinationKind: 'available', categoryId: 'z-art' }),
    ledgerEntry({ id: 'income-a', value: 40, sourceKind: 'revenue', destinationKind: 'available', categoryId: 'a-art' }),
    ledgerEntry({ id: 'income-big', value: 90, sourceKind: 'revenue', destinationKind: 'available', categoryId: 'salary' }),
    ledgerEntry({ id: 'expense-z', value: 20, sourceKind: 'available', destinationKind: 'expense', categoryId: 'z-food' }),
    ledgerEntry({ id: 'expense-a', value: 20, sourceKind: 'available', destinationKind: 'expense', categoryId: 'a-food' }),
    ledgerEntry({ id: 'expense-big', value: 50, sourceKind: 'available', destinationKind: 'expense', categoryId: 'rent' }),
  ])

  assert.deepEqual(
    graph.nodes.filter(({ kind, refId }) => kind === 'income' && refId).map(({ id }) => id),
    ['income:salary', 'income:a-art', 'income:z-art'],
  )
  assert.deepEqual(
    graph.nodes.filter(({ kind }) => kind === 'expenseCategory').map(({ id }) => id),
    ['expense:rent', 'expense:a-food', 'expense:z-food'],
  )
})

test('keeps ordinary Art income and Art expense as distinct cash paths', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({ id: 'art-income', value: 80, sourceKind: 'revenue', destinationKind: 'available', categoryId: 'art' }),
    ledgerEntry({ id: 'art-expense', value: 30, sourceKind: 'available', destinationKind: 'expense', categoryId: 'art' }),
  ])

  assert.equal(nodeValue(graph, 'income:art'), 80)
  assert.equal(linkValue(graph, 'income:art', 'income'), 80)
  assert.equal(linkValue(graph, 'income', 'available'), 80)
  assert.equal(nodeValue(graph, 'expense:art'), 30)
  assert.equal(linkValue(graph, 'expenses', 'expense:art'), 30)
})

test('keeps a linked Tech refund receipt and annotates gross Tech expense coverage', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({ id: 'tech-purchase', value: 100, sourceKind: 'available', destinationKind: 'expense', categoryId: 'tech' }),
    ledgerEntry({
      id: 'tech-refund',
      value: 40,
      sourceKind: 'expense',
      destinationKind: 'available',
      categoryId: 'misc',
      refund: {
        isRefund: true,
        signals: ['link'],
        isLinked: true,
        linkedPurchaseTransactionId: 'tech-purchase',
        linkedPurchaseMonthKey: '2026-08',
        coverageCategoryId: 'tech',
        coverageMonthKey: '2026-08',
        coverageValue: 40,
      },
    }),
  ])

  assert.equal(linkValue(graph, 'refund:tech', 'refundIncome'), 40)
  assert.equal(linkValue(graph, 'refundIncome', 'available'), 40)
  assert.equal(nodeValue(graph, 'expense:tech'), 100)
  assert.deepEqual(graph.nodes.find(({ id }) => id === 'expense:tech').refundCoverage, { value: 40, transactionIds: ['tech-refund'] })
  assert.equal(graph.audit.totalSources, 100)
  assert.equal(graph.audit.totalDestinations, 100)
})

test('attaches a tag-only refund to its category in the receipt month', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({
      id: 'tag-refund',
      value: 25,
      sourceKind: 'expense',
      destinationKind: 'available',
      categoryId: 'books',
      refund: { isRefund: true, signals: ['tag'], coverageCategoryId: 'books', coverageMonthKey: '2026-08', coverageValue: 25 },
    }),
  ])

  assert.equal(linkValue(graph, 'refund:books', 'refundIncome'), 25)
  assert.equal(linkValue(graph, 'refundIncome', 'available'), 25)
  assert.deepEqual(graph.nodes.find(({ id }) => id === 'expense:books').refundCoverage, { value: 25, transactionIds: ['tag-refund'] })
  assert.equal(graph.nodes.find(({ id }) => id === 'expense:books').value, 0)
})

test('routes Available deposits through accessible and restricted Savings with exact thickness', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({ id: 'accessible-deposit', value: 70, sourceKind: 'available', destinationKind: 'savingsAccessible', destinationAccountId: 'hysa' }),
    ledgerEntry({ id: 'restricted-deposit', value: 30, sourceKind: 'available', destinationKind: 'savingsRestricted', destinationAccountId: 'hsa' }),
  ])

  assert.equal(linkValue(graph, 'available', 'savingsAccessible'), 70)
  assert.equal(linkValue(graph, 'available', 'savingsRestricted'), 30)
  assert.equal(linkValue(graph, 'savingsAccessible', 'savingsDeposited:accessible'), 70)
  assert.equal(linkValue(graph, 'savingsRestricted', 'savingsDeposited:restricted'), 30)
  assert.equal(linkValue(graph, 'savingsDeposited:accessible', 'savingsDeposit:hysa'), 70)
  assert.equal(linkValue(graph, 'savingsDeposited:restricted', 'savingsDeposit:hsa'), 30)
})

test('renders an acyclic net Available-to-Savings bridge after separate income grouping stages', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({ id: 'salary', value: 100, sourceKind: 'revenue', destinationKind: 'available', categoryId: 'salary' }),
    ledgerEntry({
      id: 'refund',
      value: 20,
      sourceKind: 'expense',
      destinationKind: 'available',
      categoryId: 'tech',
      refund: { isRefund: true, coverageCategoryId: 'tech', coverageMonthKey: '2026-08', coverageValue: 20 },
    }),
    ledgerEntry({ id: 'deposit', value: 70, sourceKind: 'available', destinationKind: 'savingsAccessible', destinationAccountId: 'hysa' }),
    ledgerEntry({ id: 'withdraw', value: 30, sourceKind: 'savingsAccessible', destinationKind: 'available', sourceAccountId: 'hysa' }),
  ])

  assert.deepEqual(
    ['income:salary', 'income', 'refund:tech', 'refundIncome', 'available', 'savingsAccessible', 'savingsDeposited:accessible', 'savingsDeposit:hysa'].map((id) => [
      id,
      graph.nodes.find((node) => node.id === id)?.layer,
    ]),
    [
      ['income:salary', 0],
      ['income', 1],
      ['refund:tech', 0],
      ['refundIncome', 1],
      ['available', 2],
      ['savingsAccessible', 3],
      ['savingsDeposited:accessible', 4],
      ['savingsDeposit:hysa', 5],
    ],
  )
  assert.equal(linkValue(graph, 'income:salary', 'income'), 100)
  assert.equal(linkValue(graph, 'income', 'available'), 100)
  assert.equal(linkValue(graph, 'refund:tech', 'refundIncome'), 20)
  assert.equal(linkValue(graph, 'refundIncome', 'available'), 20)
  assert.equal(linkValue(graph, 'available', 'savingsAccessible'), 40)
  assert.equal(linkValue(graph, 'savingsAccessible', 'available'), 0)
  assert.deepEqual(graph.links.find(({ sourceId, targetId }) => sourceId === 'available' && targetId === 'savingsAccessible').details, {
    availableToSavings: { value: 70, transactionIds: ['deposit'] },
    savingsToAvailable: { value: 30, transactionIds: ['withdraw'] },
    net: 40,
  })
  assert.equal(
    graph.links.every((link) => graph.nodes.find(({ id }) => id === link.sourceId).layer < graph.nodes.find(({ id }) => id === link.targetId).layer),
    true,
  )
  assert.equal(graph.isBalanced, true)
})

test('renders a negative net Savings bridge as existing Savings feeding Available', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({ id: 'deposit', value: 20, sourceKind: 'available', destinationKind: 'savingsAccessible', destinationAccountId: 'hysa' }),
    ledgerEntry({ id: 'withdraw', value: 50, sourceKind: 'savingsAccessible', destinationKind: 'available', sourceAccountId: 'hysa' }),
  ])

  assert.equal(linkValue(graph, 'savingsAccessible', 'available'), 0)
  assert.equal(linkValue(graph, 'savingsWithdrawal:hysa', 'available'), 30)
  assert.deepEqual(graph.links.find(({ sourceId, targetId }) => sourceId === 'savingsWithdrawal:hysa' && targetId === 'available').details, {
    availableToSavings: { value: 20, transactionIds: ['deposit'] },
    savingsToAvailable: { value: 50, transactionIds: ['withdraw'] },
    net: -30,
  })
  assert.equal(graph.isBalanced, true)
})

test('represents same-group and cross-group Savings reallocations without pool self-loops', () => {
  const sameGroup = buildLedgerFlow([
    ledgerEntry({ id: 'same-group', value: 50, sourceKind: 'savingsAccessible', destinationKind: 'savingsAccessible', sourceAccountId: 'old-hysa', destinationAccountId: 'new-hysa' }),
  ])

  assert.equal(
    sameGroup.links.some(({ sourceId, targetId }) => sourceId === targetId),
    false,
  )
  assert.equal(linkValue(sameGroup, 'savingsWithdrawal:old-hysa', 'savingsAccessible'), 50)
  assert.equal(linkValue(sameGroup, 'savingsAccessible', 'savingsDeposited:accessible'), 50)
  assert.equal(linkValue(sameGroup, 'savingsDeposited:accessible', 'savingsDeposit:new-hysa'), 50)
  assert.deepEqual(sameGroup.audit.pools.savingsAccessible, { incoming: 50, outgoing: 50, net: 0 })
  assert.equal(sameGroup.isBalanced, true)

  const crossGroup = buildLedgerFlow([
    ledgerEntry({ id: 'cross-group', value: 35, sourceKind: 'savingsAccessible', destinationKind: 'savingsRestricted', sourceAccountId: 'hysa', destinationAccountId: 'hsa' }),
  ])

  assert.equal(
    crossGroup.links.some(({ sourceId, targetId }) => sourceId === targetId),
    false,
  )
  assert.equal(linkValue(crossGroup, 'savingsWithdrawal:hysa', 'savingsRestricted'), 35)
  assert.equal(linkValue(crossGroup, 'savingsRestricted', 'savingsDeposited:restricted'), 35)
  assert.deepEqual(crossGroup.audit.pools.savingsRestricted, { incoming: 35, outgoing: 35, net: 0 })
  assert.equal(crossGroup.isBalanced, true)
})

test('routes a Savings-originated expense through its savings pool', () => {
  const graph = buildLedgerFlow([ledgerEntry({ id: 'savings-medical', value: 45, sourceKind: 'savingsAccessible', destinationKind: 'expense', sourceAccountId: 'hysa', categoryId: 'medical' })])

  assert.equal(linkValue(graph, 'savingsWithdrawal:hysa', 'savingsAccessible'), 45)
  assert.equal(linkValue(graph, 'savingsAccessible', 'expenses'), 45)
  assert.equal(linkValue(graph, 'expenses', 'expense:medical'), 45)
  assert.equal(graph.audit.netSavings, -45)
})

test('shows net negative Savings as a left-side withdrawal source', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({ id: 'deposit', value: 20, sourceKind: 'available', destinationKind: 'savingsAccessible', destinationAccountId: 'hysa' }),
    ledgerEntry({ id: 'withdraw', value: 50, sourceKind: 'savingsAccessible', destinationKind: 'available', sourceAccountId: 'hysa' }),
  ])

  assert.equal(nodeValue(graph, 'savingsWithdrawal:hysa'), 50)
  assert.deepEqual((({ kind, movementKind, savingsGroup }) => ({ kind, movementKind, savingsGroup }))(graph.nodes.find(({ id }) => id === 'savingsWithdrawal:hysa')), {
    kind: 'existingSavings',
    movementKind: 'savingsWithdrawal',
    savingsGroup: 'accessible',
  })
  assert.equal(linkValue(graph, 'savingsWithdrawal:hysa', 'savingsAccessible'), 20)
  assert.equal(linkValue(graph, 'savingsWithdrawal:hysa', 'available'), 30)
  assert.equal(linkValue(graph, 'savingsAccessible', 'available'), 0)
  assert.equal(graph.audit.netSavings, -30)
})

test('keeps refund coverage IDs out of multi-pool cash expense paths and aggregates coverage separately in Other', () => {
  const coveredExpense = (categoryId, prefix, availableValue, savingsValue, refundValue) => [
    ledgerEntry({ id: `${prefix}-available`, value: availableValue, sourceKind: 'available', destinationKind: 'expense', categoryId }),
    ledgerEntry({ id: `${prefix}-savings`, value: savingsValue, sourceKind: 'savingsAccessible', destinationKind: 'expense', sourceAccountId: 'hysa', categoryId }),
    ledgerEntry({
      id: `${prefix}-refund`,
      value: refundValue,
      sourceKind: 'expense',
      destinationKind: 'available',
      categoryId,
      refund: { isRefund: true, coverageCategoryId: categoryId, coverageMonthKey: '2026-08', coverageValue: refundValue },
    }),
  ]
  const graph = buildLedgerFlow([...coveredExpense('tech', 'tech', 60, 40, 25), ...coveredExpense('travel', 'travel', 30, 20, 10)])

  assert.deepEqual(nodeTransactions(graph, 'expense:tech'), ['tech-available', 'tech-savings'])
  assert.deepEqual(graph.nodes.find(({ id }) => id === 'expense:tech').refundCoverage, { value: 25, transactionIds: ['tech-refund'] })
  assert.deepEqual(
    graph.links.filter(({ targetId }) => targetId === 'expense:tech').map(({ fundingPool, transactionIds }) => ({ fundingPool, transactionIds })),
    [
      { fundingPool: 'available', transactionIds: ['tech-available'] },
      { fundingPool: 'savingsAccessible', transactionIds: ['tech-savings'] },
    ],
  )

  const limited = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph, detailLevel: 0 })
  const other = limited.nodes.find(({ kind }) => kind === 'otherExpenseCategory')
  assert.equal(other.value, 150)
  assert.deepEqual(other.transactionIds, ['tech-available', 'tech-savings', 'travel-available', 'travel-savings'])
  assert.deepEqual(other.refundCoverage, { value: 35, transactionIds: ['tech-refund', 'travel-refund'] })
})

test('adds existing Available funds when uses exceed new sources', () => {
  const graph = buildLedgerFlow([ledgerEntry({ id: 'rent', value: 125, sourceKind: 'available', destinationKind: 'expense', categoryId: 'rent' })])

  assert.equal(linkValue(graph, 'existingAvailable', 'available'), 125)
  assert.equal(graph.audit.totalSources, 125)
  assert.equal(graph.audit.totalDestinations, 125)
  assert.equal(graph.audit.equationDifference, 0)
})

test('withholds nonzero unclassified ledger value without emitting a ribbon', () => {
  const graph = buildLedgerFlow([ledgerEntry({ id: 'unknown-expense', value: 35, sourceKind: 'unknown', destinationKind: 'expense', categoryId: 'food' })])

  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.links, [])
  assert.deepEqual(graph.unclassified, { value: 35, transactionIds: ['unknown-expense'] })
  assert.equal(graph.isBalanced, false)
})

test('groups Top 5 detail from ledger values, leaves Top 10 expanded, and preserves Other transaction IDs', () => {
  const entries = [70, 60, 50, 40, 30, 20, 10].map((value, index) =>
    ledgerEntry({ id: `expense-${index + 1}`, value, sourceKind: 'available', destinationKind: 'expense', categoryId: `category-${index + 1}` }),
  )
  const graph = buildLedgerFlow(entries)
  const topFive = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph, detailLevel: 5 })
  const topTen = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph, detailLevel: 10 })

  assert.deepEqual(
    topFive.nodes.filter(({ layer }) => layer === 5).map(({ id }) => id),
    ['expense:category-1', 'expense:category-2', 'expense:category-3', 'expense:category-4', 'expense:category-5', 'other:expenses:available:positive'],
  )
  assert.equal(nodeValue(topFive, 'other:expenses:available:positive'), 30)
  assert.deepEqual(nodeTransactions(topFive, 'other:expenses:available:positive'), ['expense-6', 'expense-7'])
  assert.deepEqual(topFive.links.find(({ targetId }) => targetId === 'other:expenses:available:positive').transactionIds, ['expense-6', 'expense-7'])
  assert.deepEqual(
    topFive.nodes.map(({ layer }) => layer),
    [...topFive.nodes.map(({ layer }) => layer)].sort(),
  )
  assert.equal(
    topTen.nodes.some(({ id }) => id.startsWith('other:')),
    false,
  )
  assert.equal(AnalyticsUtils.limitMoneyFlowGraphDetail({ graph, detailLevel: 'all' }), graph)
})

test('groups only compatible income, refund, accessible Savings, and restricted Savings siblings', () => {
  const entries = []
  for (let index = 1; index <= 6; index++) {
    entries.push(ledgerEntry({ id: `income-${index}`, value: 10, sourceKind: 'revenue', destinationKind: 'available', categoryId: `income-${index}` }))
    entries.push(
      ledgerEntry({
        id: `refund-${index}`,
        value: 5,
        sourceKind: 'expense',
        destinationKind: 'available',
        categoryId: `refund-${index}`,
        refund: { isRefund: true, signals: ['tag'], coverageCategoryId: `refund-${index}`, coverageMonthKey: '2026-08', coverageValue: 5 },
      }),
    )
    entries.push(ledgerEntry({ id: `accessible-${index}`, value: index, sourceKind: 'available', destinationKind: 'savingsAccessible', destinationAccountId: `accessible-${index}` }))
    entries.push(ledgerEntry({ id: `restricted-${index}`, value: index, sourceKind: 'available', destinationKind: 'savingsRestricted', destinationAccountId: `restricted-${index}` }))
  }

  const limited = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph: buildLedgerFlow(entries), detailLevel: 5 })
  const otherNodes = limited.nodes.filter(({ id }) => id.startsWith('other:'))

  assert.equal(
    otherNodes.some(({ kind }) => kind === 'otherIncome'),
    true,
  )
  assert.equal(
    otherNodes.some(({ kind }) => kind === 'otherRefund'),
    true,
  )
  assert.equal(
    otherNodes.some(({ kind, savingsGroup }) => kind === 'otherSavingsDeposit' && savingsGroup === 'accessible'),
    true,
  )
  assert.equal(
    otherNodes.some(({ kind, savingsGroup }) => kind === 'otherSavingsDeposit' && savingsGroup === 'restricted'),
    true,
  )
})

const manyCategoryGraph = buildLedgerFlow(
  [70, 60, 50, 40, 30, 20, 10].map((value, index) => ledgerEntry({ id: `expense-${index + 1}`, value, sourceKind: 'available', destinationKind: 'expense', categoryId: `category-${index + 1}` })),
)

const flowAccounts = {
  checking: typedAccount({ id: 'checking', type: 'asset' }),
  card: typedAccount({ id: 'card', type: 'asset', role: 'ccAsset' }),
  savings: typedAccount({ id: 'hysa', type: 'asset', role: 'savingAsset' }),
  hsa: typedAccount({ id: 'hsa', type: 'asset', role: 'savingAsset', includeNetWorth: false }),
  expense: typedAccount({ id: 'expense', type: 'expense' }),
  revenue: typedAccount({ id: 'paycheck', name: 'Paycheck', type: 'revenue' }),
  debit: typedAccount({ id: 'loan', type: 'liabilities', direction: 'debit' }),
  credit: typedAccount({ id: 'receivable', type: 'liabilities', direction: 'credit' }),
  unknownLiability: typedAccount({ id: 'unknown-liability', type: 'liabilities' }),
  other: typedAccount({ id: 'other', type: 'bill' }),
}

test('withholds unavailable ledger values and blocks on their exact transaction IDs', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({ id: 'invalid-z', value: null, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' }),
    ledgerEntry({ id: 'invalid-a', value: null, sourceKind: 'available', destinationKind: 'expense', categoryId: 'food' }),
  ])

  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.links, [])
  assert.deepEqual(graph.unclassified, { value: null, transactionIds: ['invalid-a', 'invalid-z'] })
  assert.equal(graph.isBalanced, false)
})

test('classifies layered money-flow endpoints without treating credit cards as debt', () => {
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(flowAccounts.card), 'available')
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(flowAccounts.debit), 'liabilityDebit')
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(flowAccounts.credit), 'liabilityCredit')
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(flowAccounts.unknownLiability), 'liabilityUnknown')
})

test('routes only normalized liabilities through debt outcomes', () => {
  const graph = buildLedgerFlow([
    ledgerEntry({ id: 'card-food', value: 80, sourceKind: 'available', destinationKind: 'expense', sourceAccountId: 'card', categoryId: 'food' }),
    ledgerEntry({ id: 'loan-proceeds', value: 50, sourceKind: 'liability', destinationKind: 'available', sourceAccountId: 'loan' }),
    ledgerEntry({ id: 'loan-payment', value: 20, sourceKind: 'available', destinationKind: 'liability', destinationAccountId: 'loan' }),
  ])

  assert.equal(linkValue(graph, 'available', 'expenses'), 80)
  assert.equal(linkValue(graph, 'newDebt:loan', 'available'), 50)
  assert.equal(linkValue(graph, 'available', 'debtPaid'), 20)
  assert.equal(
    graph.nodes.some(({ id }) => id === 'newDebt:card' || id === 'debtPaid:card'),
    false,
  )
})

test('keeps liability reallocations out of outer funding with exact transaction IDs', () => {
  const graph = buildLedgerFlow([ledgerEntry({ id: 'reallocate', value: 30, sourceKind: 'liability', destinationKind: 'liability', sourceAccountId: 'loan', destinationAccountId: 'receivable' })])

  assert.deepEqual(graph.audit.liabilityReallocations, [{ sourceId: 'loan', targetId: 'receivable', value: 30, transactionIds: ['reallocate'] }])
  assert.equal(graph.audit.totalSources, 0)
  assert.equal(graph.audit.totalDestinations, 0)
  assert.equal(graph.isBalanced, true)
})

test('returns an empty ledger flow as balanced without a balancing node', () => {
  const graph = buildLedgerFlow([])

  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.links, [])
  assert.equal(
    graph.nodes.some(({ id }) => /balanc/i.test(id)),
    false,
  )
  assert.deepEqual(graph.audit.pools, {
    available: { incoming: 0, outgoing: 0, net: 0 },
    savings: { incoming: 0, outgoing: 0, net: 0 },
    savingsAccessible: { incoming: 0, outgoing: 0, net: 0 },
    savingsRestricted: { incoming: 0, outgoing: 0, net: 0 },
  })
  assert.equal(graph.audit.equationDifference, 0)
  assert.equal(graph.isBalanced, true)
})

test('limits each compatible breakdown independently and preserves exact Other totals', () => {
  assert.equal(typeof AnalyticsUtils.limitMoneyFlowGraphDetail, 'function')

  const limited = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph: manyCategoryGraph, detailLevel: 5 })
  const expenseNodes = limited.nodes.filter(({ kind }) => ['expenseCategory', 'otherExpenseCategory'].includes(kind))

  assert.equal(expenseNodes.length, 6)
  assert.equal(nodeValue(limited, 'other:expenses:available:positive'), 30)
  assert.deepEqual(nodeTransactions(limited, 'other:expenses:available:positive'), ['expense-6', 'expense-7'])
  assert.equal(linkValue(limited, 'expenses', 'other:expenses:available:positive'), 30)
  assert.equal(linkTotal(limited, 'expenses', 'source'), 280)
  assert.equal(linkTotal(limited, 'expenses', 'target'), 280)
  assert.deepEqual(limited.pools, manyCategoryGraph.pools)
  assert.deepEqual(limited.audit, manyCategoryGraph.audit)
})

test('uses stable entity IDs to break equal-value detail ties regardless of input order', () => {
  assert.equal(typeof AnalyticsUtils.limitMoneyFlowGraphDetail, 'function')

  const reversedEqualGraph = {
    ...manyCategoryGraph,
    nodes: [
      { id: 'expenses', layer: 3, kind: 'expenses', value: 60, transactionIds: [] },
      ...['f', 'e', 'd', 'c', 'b', 'a'].map((refId) => ({ id: `expense:${refId}`, layer: 4, kind: 'expenseCategory', refId, value: 10, transactionIds: [`expense-${refId}`] })),
    ],
    links: ['f', 'e', 'd', 'c', 'b', 'a'].map((refId) => ({
      id: `expenses->${refId}`,
      sourceId: 'expenses',
      targetId: `expense:${refId}`,
      kind: 'expense',
      fundingPool: 'available',
      value: 10,
      transactionIds: [`expense-${refId}`],
    })),
  }

  const limited = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph: reversedEqualGraph, detailLevel: 5 })

  assert.deepEqual(
    limited.nodes.filter(({ kind }) => kind === 'expenseCategory').map(({ refId }) => refId),
    ['a', 'b', 'c', 'd', 'e'],
  )
  assert.deepEqual(nodeTransactions(limited, 'other:expenses:available:positive'), ['expense-f'])
})

test('never combines incompatible graph sides, pools, signs, or savings groups into one Other node', () => {
  assert.equal(typeof AnalyticsUtils.limitMoneyFlowGraphDetail, 'function')

  const nodes = [
    { id: 'available', layer: 2, kind: 'available', value: 12, transactionIds: [] },
    { id: 'savings', layer: 2, kind: 'savings', value: 18, transactionIds: [] },
    { id: 'expenses', layer: 3, kind: 'expenses', value: 12, transactionIds: [] },
    { id: 'savingsDeposited', layer: 3, kind: 'savingsDeposited', value: 12, transactionIds: [] },
  ]
  const links = []
  const addGroup = ({ prefix, layer, kind, parentId, side, fundingPool, savingsGroup }) => {
    for (let index = 1; index <= 6; index++) {
      const value = 7 - index
      const id = `${prefix}:${index}`
      const transactionId = `${prefix}-${index}`
      nodes.push({ id, layer, kind, refId: String(index), value, transactionIds: [transactionId], ...(savingsGroup ? { savingsGroup } : {}) })
      links.push({
        id: side === 'source' ? `${id}->${parentId}` : `${parentId}->${id}`,
        sourceId: side === 'source' ? id : parentId,
        targetId: side === 'source' ? parentId : id,
        kind,
        fundingPool,
        value,
        transactionIds: [transactionId],
      })
    }
  }
  addGroup({ prefix: 'expense-available', layer: 4, kind: 'expenseCategory', parentId: 'expenses', side: 'destination', fundingPool: 'available' })
  addGroup({ prefix: 'expense-savings', layer: 4, kind: 'expenseCategory', parentId: 'expenses', side: 'destination', fundingPool: 'savings' })
  addGroup({ prefix: 'refund-available', layer: 0, kind: 'refund', parentId: 'available', side: 'source', fundingPool: 'available' })
  addGroup({ prefix: 'deposit-included', layer: 4, kind: 'savingsDeposit', parentId: 'savingsDeposited', side: 'destination', fundingPool: 'savings', savingsGroup: 'included' })
  addGroup({ prefix: 'deposit-excluded', layer: 4, kind: 'savingsDeposit', parentId: 'savingsDeposited', side: 'destination', fundingPool: 'savings', savingsGroup: 'excluded' })
  addGroup({ prefix: 'withdraw-included', layer: 0, kind: 'existingSavings', parentId: 'savings', side: 'source', fundingPool: 'savings', savingsGroup: 'included' })

  const limited = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph: { ...manyCategoryGraph, nodes, links }, detailLevel: 5 })
  const otherNodes = limited.nodes.filter(({ id }) => id.startsWith('other:'))

  assert.deepEqual(
    otherNodes.map(({ id }) => id),
    [
      'other:existingSavings:savings:negative:included',
      'other:refunds:available:negative',
      'other:expenses:available:positive',
      'other:expenses:savings:positive',
      'other:savingsDeposited:savings:positive:excluded',
      'other:savingsDeposited:savings:positive:included',
    ],
  )
  assert.equal(
    otherNodes.every(({ value }) => value === 1),
    true,
  )
  assert.deepEqual(otherNodes.flatMap(({ transactionIds }) => transactionIds).sort(), [
    'deposit-excluded-6',
    'deposit-included-6',
    'expense-available-6',
    'expense-savings-6',
    'refund-available-6',
    'withdraw-included-6',
  ])
})

test('keeps colliding Other identities path-unique and independently rewired', () => {
  const nodes = []
  const links = []
  for (const parentId of ['expenses-primary', 'expenses-secondary']) {
    nodes.push({ id: parentId, layer: 3, kind: 'expenses', value: 21, transactionIds: [] })
    for (let index = 1; index <= 6; index++) {
      const value = 7 - index
      const id = `${parentId}:category-${index}`
      const transactionId = `${parentId}-${index}`
      nodes.push({ id, layer: 4, kind: 'expenseCategory', refId: `${parentId}-${index}`, value, transactionIds: [transactionId] })
      links.push({ id: `${parentId}->category-${index}`, sourceId: parentId, targetId: id, kind: 'expense', fundingPool: 'available', value, transactionIds: [transactionId] })
    }
  }

  const limited = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph: { ...manyCategoryGraph, nodes, links }, detailLevel: 5 })
  const reversed = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph: { ...manyCategoryGraph, nodes: [...nodes].reverse(), links: [...links].reverse() }, detailLevel: 5 })
  const otherIds = limited.nodes.filter(({ id }) => id.startsWith('other:')).map(({ id }) => id)

  assert.deepEqual(otherIds, ['other:expenses:available:positive:destination:expenses-primary:available', 'other:expenses:available:positive:destination:expenses-secondary:available'])
  assert.deepEqual(
    reversed.nodes.filter(({ id }) => id.startsWith('other:')).map(({ id }) => id),
    otherIds,
  )
  for (const [parentId, otherId] of [
    ['expenses-primary', otherIds[0]],
    ['expenses-secondary', otherIds[1]],
  ]) {
    assert.equal(nodeValue(limited, otherId), 1)
    assert.deepEqual(nodeTransactions(limited, otherId), [`${parentId}-6`])
    assert.equal(linkValue(limited, parentId, otherId), 1)
    assert.equal(linkTotal(limited, parentId, 'source'), 21)
  }
})

test('All graph detail preserves every original node and link', () => {
  assert.equal(typeof AnalyticsUtils.limitMoneyFlowGraphDetail, 'function')

  const limited = AnalyticsUtils.limitMoneyFlowGraphDetail({ graph: manyCategoryGraph, detailLevel: 'all' })

  assert.equal(limited, manyCategoryGraph)
  assert.deepEqual(limited.nodes, manyCategoryGraph.nodes)
  assert.deepEqual(limited.links, manyCategoryGraph.links)
})

test('places conditional FX disclosure once at page level and never on cards', () => {
  const disclosure = { displayCurrencyCode: 'USD', usesCurrentRates: true, missingCurrencies: ['JPY'], metricIds: ['expenses'] }

  assert.deepEqual(AnalyticsUtils.resolveAnalyticsFxDisclosurePlacements(null), [])
  assert.deepEqual(AnalyticsUtils.resolveAnalyticsFxDisclosurePlacements(disclosure), [{ surface: 'page', disclosure }])
})
