import assert from 'node:assert/strict'
import test from 'node:test'
import BaseRepository from '../../repository/BaseRepository.js'

test('merged result forwards page size to every sequential page', async () => {
  const calls = []
  const getAll = async ({ page, pageSize }) => {
    calls.push({ page, pageSize })
    return {
      data: [{ id: String(page) }],
      meta: { pagination: { total_pages: 2 } },
    }
  }

  const result = await new BaseRepository('test').getAllWithMergeResult({ getAll, pageSize: 200 })
  assert.deepEqual(calls, [
    { page: 1, pageSize: 200 },
    { page: 2, pageSize: 200 },
  ])
  assert.deepEqual(result, { ok: true, data: [{ id: '1' }, { id: '2' }] })
})

test('merged result discards partial pages when any page is invalid', async () => {
  const getAll = async ({ page }) => (page === 1 ? { data: [{ id: '1' }], meta: { pagination: { total_pages: 2 } } } : { message: 'upstream failure' })

  const result = await new BaseRepository('test').getAllWithMergeResult({ getAll, pageSize: 200 })
  assert.deepEqual(result, { ok: false, data: [] })
})
