import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLineChartGeometry, nearestChartPointIndex, nearestPointIndex } from '../../utils/ChartUtils.js'
import * as ChartUtils from '../../utils/ChartUtils.js'
import { buildFinancialTrendChartSeries } from '../../utils/AnalyticsUtils.js'

test('line geometry shares one x scale and keeps zero in range when needed', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [
      {
        id: 'a',
        points: [
          { x: '2026-01', value: -10, kind: 'actual' },
          { x: '2026-02', value: 10, kind: 'forecast' },
        ],
      },
      {
        id: 'b',
        points: [
          { x: '2026-01', value: 0 },
          { x: '2026-02', value: 5 },
        ],
      },
    ],
  })
  assert.deepEqual(geometry.xValues, ['2026-01', '2026-02'])
  assert.equal(geometry.yMin, -10)
  assert.equal(geometry.yMax, 10)
  assert.deepEqual(
    geometry.series[0].points.map(({ x }) => x),
    [10, 90],
  )
  assert.equal(geometry.series[0].segments[0].dashed, true)
})

test('nearest point clamps pointer and keyboard positions', () => {
  assert.equal(nearestPointIndex({ clientX: 50, left: 0, width: 100, pointCount: 5 }), 2)
  assert.equal(nearestPointIndex({ clientX: -20, left: 0, width: 100, pointCount: 5 }), 0)
  assert.equal(nearestPointIndex({ clientX: 120, left: 0, width: 100, pointCount: 5 }), 4)
  assert.equal(nearestPointIndex({ clientX: 20, left: 0, width: 100, pointCount: 0 }), -1)
})

test('nearest chart point maps the rendered plot bounds instead of the full root', () => {
  assert.equal(nearestChartPointIndex({ clientX: 88, left: 0, width: 1000, viewBoxWidth: 1000, padding: { left: 88, right: 24 }, pointCount: 12 }), 0)
  assert.equal(nearestChartPointIndex({ clientX: 976, left: 0, width: 1000, viewBoxWidth: 1000, padding: { left: 88, right: 24 }, pointCount: 12 }), 11)
})

test('line geometry preserves gaps instead of joining across missing values', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [
      {
        id: 'a',
        points: [
          { x: '2026-01', value: 1 },
          { x: '2026-02', value: null },
          { x: '2026-03', value: 3, kind: 'actual' },
          { x: '2026-04', value: 4, kind: 'forecast' },
        ],
      },
    ],
  })

  assert.equal(geometry.series[0].points[1].y, null)
  assert.deepEqual(geometry.series[0].segments, [{ path: 'M 63.33333333333333 20 L 90 10', dashed: true }])
})

test('forecast segment connects from its own last actual when another series adds the missing current x', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [
      {
        id: 'missing-current',
        points: [
          { x: '2026-07', value: 100, kind: 'actual' },
          { x: '2026-08:forecast', value: 110, kind: 'forecast' },
        ],
      },
      {
        id: 'complete',
        points: [
          { x: '2026-07', value: 20, kind: 'actual' },
          { x: '2026-08', value: 25, kind: 'partial' },
          { x: '2026-08:forecast', value: 30, kind: 'forecast' },
        ],
      },
    ],
  })

  assert.equal(geometry.series[0].segments.length, 1)
  assert.equal(geometry.series[0].segments[0].dashed, true)
  assert.equal(geometry.series[1].segments.filter(({ dashed }) => dashed).length, 1)
})

test('inspection-only points align tooltip values without drawing a line', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [
      {
        id: 'balance',
        points: [
          { x: '2026-08', value: 10 },
          { x: '2026-08:forecast', value: 10, inspectionOnly: true },
        ],
      },
    ],
  })

  assert.deepEqual(geometry.xValues, ['2026-08', '2026-08:forecast'])
  assert.deepEqual(geometry.series[0].segments, [])
})

test('financial forecast crosshair keeps exact values and dashed segments for every selected metric', () => {
  assert.equal(typeof ChartUtils.decorateLineChartPoint, 'function')
  assert.equal(typeof ChartUtils.lineChartPointsAtX, 'function')
  assert.equal(typeof ChartUtils.persistentLineChartPoints, 'function')
  const forecastKey = '2026-08:forecast'
  const accountSeries = ['netWorth', 'savings', 'debt'].map((id, index) => ({
    id,
    changePoints: [{ x: '2026-08', value: 10 + index, kind: 'partial' }],
    forecastChange: 20 + index,
    forecastAvailable: true,
  }))
  const metrics = ['netWorth', 'savings', 'debt', 'expenses'].map((id) => ({ id }))
  const series = buildFinancialTrendChartSeries({
    view: 'changes',
    metrics,
    selectedIds: metrics.map(({ id }) => id),
    accountSeries,
    expenses: { actualPoints: [], currentActual: 20, currentForecast: 30, forecastAvailable: true },
    currentMonthKey: '2026-08',
  }).map((item) => ({
    ...item,
    points: item.points.map((point) => ChartUtils.decorateLineChartPoint(point, { xLabel: 'Aug 2026', valueLabel: `${point.value} USD`, isEstimated: true })),
  }))
  const geometry = buildLineChartGeometry({ width: 100, height: 60, padding: { top: 10, right: 10, bottom: 10, left: 10 }, series })
  const selected = ChartUtils.lineChartPointsAtX(geometry.series, forecastKey)

  assert.equal(selected.length, 4)
  assert.deepEqual(
    selected.map(({ series: item, point }) => [item.id, point.value, point.kind, point.isEstimated]),
    [
      ['netWorth', 20, 'forecast', true],
      ['savings', 21, 'forecast', true],
      ['debt', 22, 'forecast', true],
      ['expenses', 30, 'forecast', true],
    ],
  )
  assert.equal(
    geometry.series.every((item) => item.segments.some(({ dashed }) => dashed) && ChartUtils.persistentLineChartPoints(item.points).some(({ kind }) => kind === 'forecast')),
    true,
  )
})

test('tooltip and live-region qualifiers share partial forecast and estimated labels', () => {
  assert.equal(typeof ChartUtils.lineChartPointQualifierKeys, 'function')
  assert.equal(typeof ChartUtils.buildLineChartLiveDescription, 'function')
  const partial = { kind: 'partial', isEstimated: true, valueLabel: '10 USD' }
  const forecast = { kind: 'forecast', isEstimated: true, valueLabel: '20 USD' }
  const qualifierLabels = { forecast: 'Forecast', partial: 'Partial', estimated_current_rates: 'Estimated at current rates' }

  assert.deepEqual(ChartUtils.lineChartPointQualifierKeys(partial), ['partial', 'estimated_current_rates'])
  assert.deepEqual(ChartUtils.lineChartPointQualifierKeys(forecast), ['forecast', 'estimated_current_rates'])
  assert.equal(
    ChartUtils.buildLineChartLiveDescription({
      xLabel: 'Aug 2026',
      values: [
        { label: 'Net worth', point: partial },
        { label: 'Expenses', point: forecast },
      ],
      qualifierLabels,
    }),
    'Aug 2026. Net worth, 10 USD, Partial, Estimated at current rates. Expenses, 20 USD, Forecast, Estimated at current rates',
  )
})

test('metric facet filters labels and refuses to remove the final selection', () => {
  assert.equal(typeof ChartUtils.filterChartFacetItems, 'function')
  assert.equal(typeof ChartUtils.toggleRequiredChartFacetSelection, 'function')
  const items = [
    { id: 'netWorth', label: 'Net-worth change' },
    { id: 'expenses', label: 'Total expenses' },
  ]

  assert.deepEqual(ChartUtils.filterChartFacetItems(items, 'ExPeNs'), [items[1]])
  assert.deepEqual(ChartUtils.toggleRequiredChartFacetSelection(['netWorth'], 'netWorth'), ['netWorth'])
  assert.deepEqual(ChartUtils.toggleRequiredChartFacetSelection(['netWorth'], 'expenses'), ['netWorth', 'expenses'])
  assert.deepEqual(ChartUtils.toggleRequiredChartFacetSelection(['netWorth', 'expenses'], 'netWorth'), ['expenses'])
})

test('financial trend source states keep account and transaction failures independent', () => {
  assert.equal(typeof ChartUtils.resolveFinancialTrendSourceState, 'function')

  assert.deepEqual(
    ChartUtils.resolveFinancialTrendSourceState({
      hasAccountSelection: true,
      expensesSelected: true,
      balanceState: { status: 'error', isStale: false },
      expenseState: { status: 'ready', isStale: false },
    }),
    {
      balanceBlocking: false,
      expenseBlocking: false,
      balanceStatusVisible: true,
      expenseStatusVisible: false,
      selectedSourcesSettled: false,
    },
  )
  assert.deepEqual(
    ChartUtils.resolveFinancialTrendSourceState({
      hasAccountSelection: false,
      expensesSelected: true,
      balanceState: { status: 'error', isStale: false },
      expenseState: { status: 'error', isStale: false },
    }),
    {
      balanceBlocking: false,
      expenseBlocking: true,
      balanceStatusVisible: false,
      expenseStatusVisible: true,
      selectedSourcesSettled: false,
    },
  )
  assert.deepEqual(
    ChartUtils.resolveFinancialTrendSourceState({
      hasAccountSelection: true,
      expensesSelected: false,
      balanceState: { status: 'loading', isStale: true },
      expenseState: { status: 'idle', isStale: false },
    }),
    {
      balanceBlocking: false,
      expenseBlocking: false,
      balanceStatusVisible: true,
      expenseStatusVisible: false,
      selectedSourcesSettled: false,
    },
  )
})

test('line geometry assigns six persistent non-color marker treatments to every finite point', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
      id,
      points: [
        { x: '2026-01', value: 1, kind: 'actual' },
        { x: '2026-02', value: 2, kind: id === 'a' ? 'forecast' : 'actual' },
      ],
    })),
  })

  assert.deepEqual(
    geometry.series.map(({ marker }) => marker),
    ['circle', 'square', 'diamond', 'triangle', 'cross', 'hollow'],
  )
  assert.equal(
    geometry.series.every((series) => series.points.every((point) => point.marker === series.marker)),
    true,
  )
  assert.equal(geometry.series[0].segments[0].dashed, true)
})
