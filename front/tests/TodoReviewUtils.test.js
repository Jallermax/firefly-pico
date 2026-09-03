import test from 'node:test'
import assert from 'node:assert/strict'

import { renderTodoNotes, getTodoReviewAmounts } from '../utils/TodoReviewUtils.js'

test('renders markdown blocks, lists and tables without losing text', () => {
  const html = renderTodoNotes?.('## Order\n\n**Verified**\n\n- Milk\n- Bread\n\n```text\nvery long line\n```\n\n| Item | Cost |\n|---|---|\n| Milk | 4 |')
  assert.match(html ?? '', /<h2>Order<\/h2>/)
  assert.match(html, /<strong>Verified<\/strong>/)
  assert.match(html, /<li>Milk<\/li>/)
  assert.match(html, /<pre><code[^>]*>very long line/)
  assert.match(html, /<table>/)
})

test('raw HTML and image URLs cannot execute or load remote content', () => {
  const html = renderTodoNotes?.('<img src=x onerror=alert(1)>\n\n![receipt](https://example.com/tracker.png)\n\n<script>alert(1)</script>')
  assert.match(html ?? '', /&lt;img/)
  assert.doesNotMatch(html, /<img|<script/)
  assert.match(html, /receipt/)
})

test('unsafe markdown links cannot become clickable links', () => {
  for (const url of ['javascript:alert%281%29', 'data:text/html,test', 'vbscript:test', 'java&#x73;cript:alert%281%29']) {
    const html = renderTodoNotes?.(`[Open](${url})`)
    assert.equal(html?.includes('<a '), false, url)
  }
})

test('safe links escape attributes and protect the opener', () => {
  const html = renderTodoNotes?.('[Open](https://example.com/path?q=1&other=2 "Title")')
  assert.match(html ?? '', /href="https:\/\/example.com\/path\?q=1&amp;other=2"/)
  assert.match(html, /rel="noopener noreferrer"/)
})

test('review totals retain exact decimals and separate currencies and transaction types', () => {
  const splits = [
    { type: { code: 'expense' }, amount: '9007199254740993.01', currency_code: 'USD' },
    { type: { code: 'expense' }, amount: '0.09', currency_code: 'USD' },
    { type: { code: 'income' }, amount: '5.25', currency_code: 'EUR' },
    { type: { code: 'transfer' }, amount: '3.00', currency_code: 'USD' },
  ]
  assert.deepEqual(getTodoReviewAmounts?.(splits, 'en'), [
    { key: 'expense-USD', type: 'expense', text: '-9,007,199,254,740,993.10 USD' },
    { key: 'income-EUR', type: 'income', text: '+5.25 EUR' },
    { key: 'transfer-USD', type: 'transfer', text: '3.00 USD' },
  ])
})
