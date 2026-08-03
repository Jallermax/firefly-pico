import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import * as AnalyticsUtils from '../../utils/AnalyticsUtils.js'
import {
  ANALYTICS_UNCATEGORIZED_ID,
  buildCategoryLedger,
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
      missingCurrencies: ['EUR'],
      warnings: ['included warning'],
    },
    excludedSeries: {
      id: 'savingsExcluded',
      points: [
        { x: '2026-02-28', value: 40 },
        { x: '2026-03-31', value: 50 },
      ],
      currentPoint: { x: '2026-04-10', value: 55 },
      missingCurrencies: ['JPY'],
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
  assert.deepEqual(combined.missingCurrencies, ['EUR', 'JPY'])
  assert.deepEqual(combined.warnings, ['included warning', 'excluded warning'])
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
  assert.deepEqual(result.series.find(({ id }) => id === 'netWorth').changePoints, [
    { x: '2026-06', value: 30, kind: 'actual' },
    { x: '2026-07', value: -10, kind: 'actual' },
    { x: '2026-08', value: 30, kind: 'partial' },
  ])
  assert.deepEqual(
    result.series.find(({ id }) => id === 'debt').changePoints.map(({ value }) => value),
    [-20, 15, -5],
  )
})

test('balance forecast reports signed movement remaining from today', () => {
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

  assert.equal(result.forecastTotal, 1400)
  assert.equal(result.remainingFromToday, 50)
})

test('retains zero balance movement and remaining forecast as visible values', () => {
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
  assert.equal(result.forecastChange, 0)
  assert.equal(result.remainingFromToday, 0)
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

  assert.deepEqual(result.series[0].changePoints, [
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

  assert.deepEqual(result.series[0].changePoints, [
    { x: '2026-06', value: 30, kind: 'actual' },
    { x: '2026-07', value: 20, kind: 'actual' },
  ])
})

test('carries sparse account totals through completed months and forecasts from completed changes', () => {
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
  assert.deepEqual(result.series[0], {
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
    forecastChange: 10,
    forecastTotal: 140,
    remainingFromToday: 10,
    forecastAvailable: true,
  })
})

test('does not carry account totals before the first source point or forecast one completed movement', () => {
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

  assert.deepEqual(result.series[0].totalPoints, [
    { x: '2026-06', value: 50, kind: 'actual' },
    { x: '2026-07', value: 50, kind: 'actual' },
    { x: '2026-08', value: 50, kind: 'partial' },
  ])
  assert.deepEqual(result.series[0].changePoints, [
    { x: '2026-07', value: 0, kind: 'actual' },
    { x: '2026-08', value: 0, kind: 'partial' },
  ])
  assert.equal(result.series[0].forecastAvailable, false)
  assert.equal(result.series[0].forecastChange, null)
  assert.equal(result.series[0].forecastTotal, null)
  assert.deepEqual(result.series[1].totalPoints, [
    { x: '2026-05', value: 80, kind: 'actual' },
    { x: '2026-06', value: 80, kind: 'actual' },
    { x: '2026-07', value: 80, kind: 'actual' },
  ])
  assert.deepEqual(result.series[1].changePoints, [
    { x: '2026-05', value: 0, kind: 'actual' },
    { x: '2026-06', value: 0, kind: 'actual' },
    { x: '2026-07', value: 0, kind: 'actual' },
  ])
  assert.equal(result.series[1].currentChange, null)
  assert.deepEqual(result.series[2].totalPoints, [])
  assert.deepEqual(result.series[2].changePoints, [])
  assert.equal(result.series[2].currentTotal, 25)
})

test('builds localized balance and change chart series with real account forecast points', () => {
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

  assert.deepEqual(AnalyticsUtils.buildFinancialTrendChartSeries({ view: 'balances', metrics, selectedIds: ['netWorth'], accountSeries, expenses, currentMonthKey: '2026-08' }), [
    {
      id: 'netWorth',
      label: 'Localized net worth',
      points: [
        { x: '2026-07', value: 130, kind: 'actual' },
        { x: '2026-08', value: 130, kind: 'partial' },
        { x: '2026-08:forecast', value: 140, kind: 'forecast' },
      ],
    },
  ])
  assert.deepEqual(AnalyticsUtils.buildFinancialTrendChartSeries({ view: 'changes', metrics, selectedIds: ['netWorth', 'expenses'], accountSeries, expenses, currentMonthKey: '2026-08' }), [
    {
      id: 'netWorth',
      label: 'Localized net worth',
      points: [
        { x: '2026-07', value: 10, kind: 'actual' },
        { x: '2026-08', value: 0, kind: 'partial' },
        { x: '2026-08:forecast', value: 10, kind: 'forecast' },
      ],
    },
    {
      id: 'expenses',
      label: 'Localized expenses',
      points: [
        { x: '2026-07', value: 30, kind: 'actual' },
        { x: '2026-08', value: 10, kind: 'partial' },
        { x: '2026-08:forecast', value: 40, kind: 'forecast' },
      ],
    },
  ])
})

test('distinguishes insufficient forecast history from a genuinely missing forecast value', () => {
  assert.equal(typeof AnalyticsUtils.formatFinancialTrendForecastValue, 'function')
  const formatValue = (value) => (Number.isFinite(value) ? `${value} USD` : '—')

  assert.equal(
    AnalyticsUtils.formatFinancialTrendForecastValue({ forecastAvailable: false, value: null, formatValue, insufficientHistoryLabel: 'Localized two-month minimum' }),
    'Localized two-month minimum',
  )
  assert.equal(AnalyticsUtils.formatFinancialTrendForecastValue({ forecastAvailable: true, value: null, formatValue, insufficientHistoryLabel: 'Localized two-month minimum' }), '—')
  assert.equal(AnalyticsUtils.formatFinancialTrendForecastValue({ forecastAvailable: true, value: 25, formatValue, insufficientHistoryLabel: 'Localized two-month minimum' }), '25 USD')
})

test('summarizes total expense from every category and forecasts only with two completed months', () => {
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
  assert.equal(result.currentForecast, 40)
  assert.equal(result.forecastAvailable, true)
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

test('money flow keeps card purchases as expenses without classifying card movement as debt', () => {
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
  })
  assert.deepEqual(Object.fromEntries(flow.destinations.map((node) => [node.id, node.value])), {
    expenses: 300,
    savingsDeposited: 300,
    newExcess: 400,
  })
  assert.equal(flow.audit.priorExcessUsed, 0)
  assert.equal(flow.audit.newExcess, 400)
  assert.equal(flow.audit.sourceTotal, 1000)
  assert.equal(flow.audit.destinationTotal, 1000)
  assert.equal(flow.audit.equationDifference, 0)
  assert.equal(flow.isBalanced, true)
  assert.equal(flow.audit.expensePurchases, 300)
  assert.deepEqual(flow.audit.debtIncreaseIds, [])
  assert.deepEqual(flow.audit.debtRepaymentIds, [])
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
  assert.equal(flow.audit.debtRepaid, 25)
  assert.equal(flow.audit.netRefunds, 30)
  assert.equal(flow.audit.priorExcessUsed, 55)
  assert.equal(flow.audit.newExcess, 0)
  assert.equal(flow.audit.sourceTotal, 85)
  assert.equal(flow.audit.destinationTotal, 85)
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
