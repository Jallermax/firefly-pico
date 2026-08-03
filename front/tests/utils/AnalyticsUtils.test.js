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
  assert.equal(result.currentForecast, 60)
  assert.equal(result.remainingFromToday, 50)
  assert.equal(result.forecastAvailable, true)
})

test('total forecast sums every category forecast including current-only uncategorized', () => {
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
    result.currentForecast,
    result.categoryForecasts.reduce((sum, item) => sum + item.currentForecast, 0),
  )
  assert.equal(result.currentForecast, 5461)
  assert.equal(result.remainingFromToday, 3321)
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

test('category forecast preserves a recurring expense missing early this month', () => {
  const summary = summarizeCategoryWindow({ ledger: housingLedger, categoryIds: ['housing'], averageMonths: 3, today: new Date('2026-08-03T12:00:00') }).series[0]
  assert.equal(summary.currentActual, 0)
  assert.equal(summary.average, 2321)
  assert.equal(summary.currentForecast, 2321)
  assert.equal(summary.remainingFromToday, 2321)
})

test('category forecast never falls below spending already recorded', () => {
  const summary = summarizeCategoryWindow({ ledger: overspentLedger, categoryIds: ['food'], averageMonths: 6, today: new Date('2026-08-25T12:00:00') }).series[0]
  assert.equal(summary.average, 7500)
  assert.equal(summary.currentActual, 9000)
  assert.equal(summary.currentForecast >= 9000, true)
  assert.equal(summary.remainingFromToday, summary.currentForecast - 9000)
})

test('category forecast preserves the historical remainder after today', () => {
  const summary = summarizeCategoryWindow({ ledger: pacedLedger, categoryIds: ['food'], averageMonths: 3, today: new Date('2026-08-03T12:00:00') }).series[0]
  assert.equal(summary.average, 1000)
  assert.equal(summary.currentActual, 1000)
  assert.equal(summary.pacedForecast, 1400)
  assert.equal(summary.currentForecast, 1400)
  assert.equal(summary.remainingFromToday, 400)
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
    { x: '2026-01', value: 90, transactionIds: ['jan'] },
    { x: '2026-02', value: 0, transactionIds: [] },
    { x: '2026-03', value: 30, transactionIds: ['mar'] },
  ])
  assert.equal(summary.series[0].average, 40)
  assert.equal(summary.series[0].currentActual, 12)
  assert.deepEqual(summary.series[0].currentTransactionIds, ['apr'])
  assert.ok(Math.abs(summary.series[0].pacedForecast - (12 + 70 / 3)) < 0.000001)
  assert.equal(summary.series[0].currentForecast, 40)
  assert.equal(summary.series[0].remainingFromToday, 28)
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

test('publishes only the layered monthly money-flow contract', () => {
  const graph = buildMonthlyMoneyFlow({
    monthKey: '2026-04',
    displayCurrencyCode: 'USD',
    primaryCurrencyCode: 'USD',
    rates: { USD: 1 },
    savingsView: 'combined',
    transactions: [transaction('card-buy', [split({ amount: 100, date: '2026-04-04', source: card, destination: expense, categoryId: 'food' })])],
  })

  assert.equal(Array.isArray(graph.nodes), true)
  assert.equal(Array.isArray(graph.links), true)
  assert.equal(graph.sources, undefined)
  assert.equal(graph.destinations, undefined)
  assert.deepEqual(graph.meta, { savingsView: 'combined' })
  assert.equal(linkValue(graph, 'available', 'expenses'), 100)
})

const flowArgs = { monthKey: '2026-08', displayCurrencyCode: 'USD', primaryCurrencyCode: 'USD', rates: { USD: 1 }, currencyDecimalPlaces: 2, savingsView: 'combined' }
const nodeValue = (graph, id) => graph.nodes.find((node) => node.id === id)?.value ?? 0
const nodeTransactions = (graph, id) => graph.nodes.find((node) => node.id === id)?.transactionIds ?? []
const linkValue = (graph, sourceId, targetId) => graph.links.filter((link) => link.sourceId === sourceId && link.targetId === targetId).reduce((sum, link) => sum + link.value, 0)
const linkTotal = (graph, id, direction) => graph.links.filter((link) => link[`${direction}Id`] === id).reduce((sum, link) => sum + link.value, 0)

const manyCategoryGraph = {
  nodes: [
    { id: 'available', layer: 2, kind: 'available', value: 280, transactionIds: [] },
    { id: 'expenses', layer: 3, kind: 'expenses', value: 280, transactionIds: [] },
    { id: 'expense:category-1', layer: 4, kind: 'expenseCategory', refId: 'category-1', value: 70, transactionIds: ['expense-1'] },
    { id: 'expense:category-2', layer: 4, kind: 'expenseCategory', refId: 'category-2', value: 60, transactionIds: ['expense-2'] },
    { id: 'expense:category-3', layer: 4, kind: 'expenseCategory', refId: 'category-3', value: 50, transactionIds: ['expense-3'] },
    { id: 'expense:category-4', layer: 4, kind: 'expenseCategory', refId: 'category-4', value: 40, transactionIds: ['expense-4'] },
    { id: 'expense:category-5', layer: 4, kind: 'expenseCategory', refId: 'category-5', value: 30, transactionIds: ['expense-5'] },
    { id: 'expense:category-6', layer: 4, kind: 'expenseCategory', refId: 'category-6', value: 20, transactionIds: ['expense-6'] },
    { id: 'expense:category-7', layer: 4, kind: 'expenseCategory', refId: 'category-7', value: 10, transactionIds: ['expense-7'] },
  ],
  links: [
    { id: 'available->expenses', sourceId: 'available', targetId: 'expenses', kind: 'expense', fundingPool: 'available', value: 280, transactionIds: [] },
    { id: 'expenses->category-1', sourceId: 'expenses', targetId: 'expense:category-1', kind: 'expense', fundingPool: 'available', value: 70, transactionIds: ['expense-1'] },
    { id: 'expenses->category-2', sourceId: 'expenses', targetId: 'expense:category-2', kind: 'expense', fundingPool: 'available', value: 60, transactionIds: ['expense-2'] },
    { id: 'expenses->category-3', sourceId: 'expenses', targetId: 'expense:category-3', kind: 'expense', fundingPool: 'available', value: 50, transactionIds: ['expense-3'] },
    { id: 'expenses->category-4', sourceId: 'expenses', targetId: 'expense:category-4', kind: 'expense', fundingPool: 'available', value: 40, transactionIds: ['expense-4'] },
    { id: 'expenses->category-5', sourceId: 'expenses', targetId: 'expense:category-5', kind: 'expense', fundingPool: 'available', value: 30, transactionIds: ['expense-5'] },
    { id: 'expenses->category-6', sourceId: 'expenses', targetId: 'expense:category-6', kind: 'expense', fundingPool: 'available', value: 20, transactionIds: ['expense-6'] },
    { id: 'expenses->category-7', sourceId: 'expenses', targetId: 'expense:category-7', kind: 'expense', fundingPool: 'available', value: 10, transactionIds: ['expense-7'] },
  ],
  pools: { available: { incoming: 280, outgoing: 280, net: 0 }, savings: { incoming: 0, outgoing: 0, net: 0 } },
  audit: { totalSources: 280, totalDestinations: 280, equationDifference: 0 },
  meta: { savingsView: 'combined' },
  isEstimated: false,
  missingCurrencies: [],
  unclassified: { value: 0, transactionIds: [] },
  isBalanced: true,
}

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

test('classifies layered money-flow endpoints without treating credit cards as debt', () => {
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(flowAccounts.card), 'available')
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(flowAccounts.debit), 'liabilityDebit')
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(flowAccounts.credit), 'liabilityCredit')
  assert.equal(AnalyticsUtils.getAnalyticsAccountKind(flowAccounts.unknownLiability), 'liabilityUnknown')
})

test('routes card purchases through Available and never through Debt', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [transaction('card-food', [split({ amount: 80, date: '2026-08-02', source: flowAccounts.card, destination: flowAccounts.expense, categoryId: 'food' })])],
  })

  assert.equal(linkValue(graph, 'available', 'expenses'), 80)
  assert.equal(
    graph.nodes.some(({ kind }) => ['newDebt', 'debtPaid', 'liabilityExtended', 'liabilityCollected'].includes(kind)),
    false,
  )
})

test('routes immediate account transitions through their literal layered endpoints', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('revenue-available', [split({ amount: 10, date: '2026-08-01', source: flowAccounts.revenue, destination: flowAccounts.checking, categoryId: 'salary' })]),
      transaction('revenue-savings', [split({ amount: 11, date: '2026-08-01', source: flowAccounts.revenue, destination: flowAccounts.savings, categoryId: 'bonus' })]),
      transaction('available-expense', [split({ amount: 12, date: '2026-08-01', source: flowAccounts.checking, destination: flowAccounts.expense, categoryId: 'food' })]),
      transaction('savings-expense', [split({ amount: 13, date: '2026-08-01', source: flowAccounts.savings, destination: flowAccounts.expense, categoryId: 'food' })]),
      transaction('available-savings', [split({ amount: 14, date: '2026-08-01', source: flowAccounts.checking, destination: flowAccounts.savings })]),
      transaction('savings-available', [split({ amount: 5, date: '2026-08-01', source: flowAccounts.savings, destination: flowAccounts.checking })]),
      transaction('debit-available', [split({ amount: 15, date: '2026-08-01', source: flowAccounts.debit, destination: flowAccounts.checking })]),
      transaction('debit-expense', [split({ amount: 16, date: '2026-08-01', source: flowAccounts.debit, destination: flowAccounts.expense, categoryId: 'medical' })]),
      transaction('available-debit', [split({ amount: 17, date: '2026-08-01', source: flowAccounts.checking, destination: flowAccounts.debit })]),
      transaction('revenue-debit', [split({ amount: 18, date: '2026-08-01', source: flowAccounts.revenue, destination: flowAccounts.debit, categoryId: 'salary' })]),
      transaction('refund-debit', [split({ amount: 19, date: '2026-08-01', source: flowAccounts.expense, destination: flowAccounts.debit, categoryId: 'food' })]),
      transaction('credit-available', [split({ amount: 20, date: '2026-08-01', source: flowAccounts.credit, destination: flowAccounts.checking })]),
      transaction('credit-expense', [split({ amount: 21, date: '2026-08-01', source: flowAccounts.credit, destination: flowAccounts.expense, categoryId: 'medical' })]),
      transaction('available-credit', [split({ amount: 22, date: '2026-08-01', source: flowAccounts.checking, destination: flowAccounts.credit })]),
      transaction('revenue-credit', [split({ amount: 23, date: '2026-08-01', source: flowAccounts.revenue, destination: flowAccounts.credit, categoryId: 'salary' })]),
      transaction('refund-credit', [split({ amount: 24, date: '2026-08-01', source: flowAccounts.expense, destination: flowAccounts.credit, categoryId: 'food' })]),
    ],
  })

  assert.equal(linkValue(graph, 'income', 'available'), 10)
  assert.equal(linkValue(graph, 'income', 'savings'), 11)
  assert.equal(linkValue(graph, 'available', 'expenses'), 12)
  assert.equal(linkValue(graph, 'savings', 'expenses'), 13)
  assert.equal(linkValue(graph, 'available', 'savings'), 9)
  assert.equal(linkValue(graph, 'newDebt:loan', 'available'), 15)
  assert.equal(linkValue(graph, 'newDebt:loan', 'expenses'), 16)
  assert.equal(linkValue(graph, 'available', 'debtPaid'), 17)
  assert.equal(linkValue(graph, 'income', 'debtPaid'), 18)
  assert.equal(linkValue(graph, 'refund:food', 'debtPaid'), 19)
  assert.equal(linkValue(graph, 'liabilityCollected:receivable', 'available'), 20)
  assert.equal(linkValue(graph, 'liabilityCollected:receivable', 'expenses'), 21)
  assert.equal(linkValue(graph, 'available', 'liabilityExtended'), 22)
  assert.equal(linkValue(graph, 'income', 'liabilityExtended'), 23)
  assert.equal(linkValue(graph, 'refund:food', 'liabilityExtended'), 24)
})

test('uses the income category before revenue account name and sorts graph drilldowns', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('z-income', [split({ amount: 10, date: '2026-08-01', source: flowAccounts.revenue, destination: flowAccounts.checking, categoryId: 'salary' })]),
      transaction('a-income', [split({ amount: 5, date: '2026-08-02', source: flowAccounts.revenue, destination: flowAccounts.checking, categoryId: 'salary' })]),
    ],
  })

  assert.equal(nodeValue(graph, 'income:salary'), 15)
  assert.deepEqual(nodeTransactions(graph, 'income:salary'), ['a-income', 'z-income'])
  assert.equal(graph.links.find(({ sourceId, targetId }) => sourceId === 'income:salary' && targetId === 'income').transactionIds.join(','), 'a-income,z-income')
})

test('keeps uncategorized income node IDs stable across account renames and duplicate account names', () => {
  const beforeRename = typedAccount({ id: 'salary-one', name: 'Salary', type: 'revenue' })
  const afterRename = typedAccount({ id: 'salary-one', name: 'New Salary', type: 'revenue' })
  const sameNamedAccount = typedAccount({ id: 'salary-two', name: 'Salary', type: 'revenue' })
  const buildGraph = (source) =>
    buildMonthlyMoneyFlow({
      ...flowArgs,
      transactions: [transaction('income', [split({ amount: 10, date: '2026-08-01', source, destination: flowAccounts.checking })])],
    })

  assert.equal(nodeValue(buildGraph(beforeRename), 'income:salary-one'), 10)
  assert.equal(nodeValue(buildGraph(afterRename), 'income:salary-one'), 10)
  const duplicateNamesGraph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('first', [split({ amount: 10, date: '2026-08-01', source: beforeRename, destination: flowAccounts.checking })]),
      transaction('second', [split({ amount: 20, date: '2026-08-02', source: sameNamedAccount, destination: flowAccounts.checking })]),
    ],
  })
  assert.equal(nodeValue(duplicateNamesGraph, 'income:salary-one'), 10)
  assert.equal(nodeValue(duplicateNamesGraph, 'income:salary-two'), 20)
})

test('preserves immediate Available and Savings funding on shared liability outcomes', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('available-payment', [split({ amount: 30, date: '2026-08-01', source: flowAccounts.checking, destination: flowAccounts.debit })]),
      transaction('savings-payment', [split({ amount: 20, date: '2026-08-02', source: flowAccounts.savings, destination: flowAccounts.debit })]),
    ],
  })

  assert.equal(graph.links.find(({ sourceId, targetId }) => sourceId === 'available' && targetId === 'debtPaid').fundingPool, 'available')
  assert.equal(graph.links.find(({ sourceId, targetId }) => sourceId === 'savings' && targetId === 'debtPaid').fundingPool, 'savings')
})

test('keeps a purchase from Available and refund to Savings as separate category paths', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('purchase', [split({ amount: 100, date: '2026-08-02', source: flowAccounts.checking, destination: flowAccounts.expense, categoryId: 'food' })]),
      transaction('refund', [split({ amount: 40, date: '2026-08-03', source: flowAccounts.expense, destination: flowAccounts.savings, categoryId: 'food' })]),
    ],
  })
  assert.equal(linkValue(graph, 'available', 'expenses'), 100)
  assert.equal(linkValue(graph, 'refund:food', 'savings'), 40)
  assert.equal(graph.nodes.find(({ id }) => id === 'expense:food').kind, 'expenseCategory')
})

test('retains sorted unique transaction IDs on netted and residual layered nodes', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('z-purchase', [split({ amount: 100, date: '2026-08-01', source: flowAccounts.checking, destination: flowAccounts.expense, categoryId: 'food' })]),
      transaction('a-refund', [split({ amount: 40, date: '2026-08-02', source: flowAccounts.expense, destination: flowAccounts.checking, categoryId: 'food' })]),
      transaction('save', [split({ amount: 20, date: '2026-08-03', source: flowAccounts.checking, destination: flowAccounts.savings })]),
    ],
  })

  assert.deepEqual(nodeTransactions(graph, 'expense:food'), ['a-refund', 'z-purchase'])
  assert.deepEqual(nodeTransactions(graph, 'savingsDeposit:hysa'), ['save'])
})

test('shows opposing savings account movements and their net', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('hysa-in', [split({ amount: 1000, date: '2026-08-04', source: flowAccounts.checking, destination: flowAccounts.savings })]),
      transaction('hsa-out', [split({ amount: 500, date: '2026-08-05', source: flowAccounts.hsa, destination: flowAccounts.checking })]),
    ],
  })
  assert.equal(nodeValue(graph, 'savingsDeposit:hysa'), 1000)
  assert.equal(nodeValue(graph, 'existingSavings:hsa'), 500)
  assert.equal(graph.audit.netSavings, 500)
})

test('annotates per-account savings residual nodes with their net-worth group', () => {
  for (const savingsView of ['combined', 'split']) {
    const graph = buildMonthlyMoneyFlow({
      ...flowArgs,
      savingsView,
      transactions: [
        transaction('hysa-in', [split({ amount: 1000, date: '2026-08-04', source: flowAccounts.checking, destination: flowAccounts.savings })]),
        transaction('hsa-out', [split({ amount: 500, date: '2026-08-05', source: flowAccounts.hsa, destination: flowAccounts.checking })]),
      ],
    })

    assert.equal(graph.nodes.find(({ id }) => id === 'savingsDeposit:hysa').savingsGroup, 'included')
    assert.equal(graph.nodes.find(({ id }) => id === 'existingSavings:hsa').savingsGroup, 'excluded')
  }
})

test('keeps liability reallocations out of outer funding while retaining their exact transaction', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [transaction('reallocate', [split({ amount: 30, date: '2026-08-06', source: flowAccounts.debit, destination: flowAccounts.credit })])],
  })

  assert.deepEqual(graph.audit.liabilityReallocations, [{ sourceId: 'loan', targetId: 'receivable', value: 30, transactionIds: ['reallocate'] }])
  assert.equal(graph.audit.totalSources, 0)
  assert.equal(graph.audit.totalDestinations, 0)
})

test('reconciles pool and outer equations with literal totals', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('income', [split({ amount: 100, date: '2026-08-01', source: flowAccounts.revenue, destination: flowAccounts.checking, categoryId: 'salary' })]),
      transaction('expense-available', [split({ amount: 60, date: '2026-08-02', source: flowAccounts.checking, destination: flowAccounts.expense, categoryId: 'food' })]),
      transaction('save', [split({ amount: 20, date: '2026-08-03', source: flowAccounts.checking, destination: flowAccounts.savings })]),
      transaction('expense-savings', [split({ amount: 10, date: '2026-08-04', source: flowAccounts.savings, destination: flowAccounts.expense, categoryId: 'food' })]),
    ],
  })

  assert.deepEqual(graph.pools, {
    available: { incoming: 100, outgoing: 80, net: 20 },
    savings: { incoming: 20, outgoing: 10, net: 10 },
  })
  assert.equal(graph.audit.totalSources, 100)
  assert.equal(graph.audit.totalDestinations, 100)
  assert.equal(graph.audit.equationDifference, 0)
  assert.equal(graph.audit.positiveSavingsMovement, 10)
  assert.equal(graph.audit.negativeSavingsMovement, 0)
  assert.equal(graph.isBalanced, true)
  assert.deepEqual(graph.meta, { savingsView: 'combined' })
})

test('sets each pool node to its reconciled incoming and outgoing link total', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('income', [split({ amount: 100, date: '2026-08-01', source: flowAccounts.revenue, destination: flowAccounts.checking, categoryId: 'salary' })]),
      transaction('expense-available', [split({ amount: 60, date: '2026-08-02', source: flowAccounts.checking, destination: flowAccounts.expense, categoryId: 'food' })]),
      transaction('save', [split({ amount: 20, date: '2026-08-03', source: flowAccounts.checking, destination: flowAccounts.savings })]),
      transaction('expense-savings', [split({ amount: 10, date: '2026-08-04', source: flowAccounts.savings, destination: flowAccounts.expense, categoryId: 'food' })]),
    ],
  })

  for (const pool of ['available', 'savings']) {
    assert.equal(nodeValue(graph, pool), linkTotal(graph, pool, 'target'))
    assert.equal(linkTotal(graph, pool, 'target'), linkTotal(graph, pool, 'source'))
  }
})

test('withholds unknown, unsupported, and missing-rate transactions from a balanced graph', () => {
  const graph = buildMonthlyMoneyFlow({
    ...flowArgs,
    transactions: [
      transaction('unknown-liability', [split({ amount: 25, date: '2026-08-01', source: flowAccounts.unknownLiability, destination: flowAccounts.checking })]),
      transaction('unsupported', [split({ amount: 15, date: '2026-08-02', source: flowAccounts.other, destination: flowAccounts.checking })]),
      transaction('missing-rate', [split({ amount: 10, date: '2026-08-03', source: flowAccounts.revenue, destination: flowAccounts.checking, currencyCode: 'EUR' })]),
    ],
  })

  assert.deepEqual(graph.unclassified, { value: 40, transactionIds: ['unknown-liability', 'unsupported'] })
  assert.deepEqual(graph.missingCurrencies, ['EUR'])
  assert.equal(graph.isBalanced, false)
})

test('returns an empty layered graph as balanced', () => {
  const graph = buildMonthlyMoneyFlow({ ...flowArgs, savingsView: 'split', transactions: [] })

  assert.deepEqual(graph.pools, {
    available: { incoming: 0, outgoing: 0, net: 0 },
    savings: { incoming: 0, outgoing: 0, net: 0 },
  })
  assert.deepEqual(graph.unclassified, { value: 0, transactionIds: [] })
  assert.equal(graph.audit.equationDifference, 0)
  assert.deepEqual(graph.meta, { savingsView: 'split' })
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
      'other:expenses:available:positive',
      'other:expenses:savings:positive',
      'other:refunds:available:negative',
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
