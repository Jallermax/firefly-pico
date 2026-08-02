import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLineChartGeometry, nearestChartPointIndex, nearestPointIndex } from '../../utils/ChartUtils.js'

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
