import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
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

const captureRequests = async (run) => {
  const requests = []
  const originalGet = axios.get
  const originalUseAppStore = globalThis.useAppStore
  globalThis.useAppStore = () => ({ picoBackendURL: 'https://pico.test' })
  axios.get = async (url) => {
    requests.push(new URL(url))
    return { data: { data: [], meta: { pagination: { total_pages: 1 } } } }
  }

  try {
    await run()
    return requests
  } finally {
    axios.get = originalGet
    if (originalUseAppStore) globalThis.useAppStore = originalUseAppStore
    else delete globalThis.useAppStore
  }
}

test('transaction links request the Firefly transaction-links endpoint with the first pagination page', async () => {
  const [url] = await captureRequests(() => new TransactionLinkRepository().getAll())
  const request = { url: url.pathname.slice(1), params: { page: Number(url.searchParams.get('page')) } }

  assert.equal(request.url, 'transaction-links')
  assert.deepEqual(request.params, { page: 1 })
})

test('subscriptions request the supplied date window', async () => {
  const [url] = await captureRequests(() => new SubscriptionRepository().getAll('2026-07-01', '2026-08-31'))
  const subscriptionRequest = {
    url: url.pathname.slice(1),
    params: { start: url.searchParams.get('start'), end: url.searchParams.get('end') },
  }

  assert.equal(subscriptionRequest.url, 'subscriptions')
  assert.equal(subscriptionRequest.params.start, '2026-07-01')
  assert.equal(subscriptionRequest.params.end, '2026-08-31')
})
