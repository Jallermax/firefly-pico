import assert from 'node:assert/strict'
import test from 'node:test'
import BaseRepository from '../../repository/BaseRepository.js'
import SubscriptionRepository from '../../repository/SubscriptionRepository.js'
import TransactionLinkRepository from '../../repository/TransactionLinkRepository.js'

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

test('transaction links use the Firefly transaction-links endpoint with the first pagination page', async () => {
  const repository = new TransactionLinkRepository()
  const request = { url: repository.endpoint, params: { page: 1 } }

  assert.equal(request.url, 'transaction-links')
  assert.deepEqual(request.params, { page: 1 })
})

test('subscriptions include the requested date window', async () => {
  const repository = new SubscriptionRepository()
  const subscriptionRequest = { url: repository.endpoint, params: repository.getParams('2026-07-01', '2026-08-31') }

  assert.equal(subscriptionRequest.url, 'subscriptions')
  assert.equal(subscriptionRequest.params.start, '2026-07-01')
  assert.equal(subscriptionRequest.params.end, '2026-08-31')
})
