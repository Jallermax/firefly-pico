import assert from 'node:assert/strict'
import test from 'node:test'
import { getTodoJournalIds, getTodoTagUpdate, isSameTransactionGroup } from '../core/utils/TodoTagUpdate.js'

const transaction = {
  id: '42',
  attributes: {
    group_title: 'Split purchase',
    transactions: [
      { transaction_journal_id: '11', tags: ['todo', 'TÓDO', 'newly-added'] },
      { transaction_journal_id: '12', tags: ['unrelated', 'TODO'] },
    ],
  },
}

test('Done changes only the marked journals and sends the complete group', () => {
  const journalIds = getTodoJournalIds(transaction, 'todo')
  assert.deepEqual(journalIds, ['11'])
  assert.deepEqual(getTodoTagUpdate(transaction, 'todo', journalIds, false), {
    apply_rules: false,
    fire_webhooks: false,
    group_title: 'Split purchase',
    transactions: [{ transaction_journal_id: '11', tags: ['TÓDO', 'newly-added'] }, { transaction_journal_id: '12' }],
  })
})

test('Put Back adds the marker only to the originally marked journals', () => {
  const current = structuredClone(transaction)
  current.attributes.transactions[0].tags = ['newly-added', 'added-after-done']
  assert.deepEqual(getTodoTagUpdate(current, 'todo', ['11'], true).transactions, [
    { transaction_journal_id: '11', tags: ['newly-added', 'added-after-done', 'todo'] },
    { transaction_journal_id: '12' },
  ])
  assert.equal(getTodoTagUpdate(transaction, 'todo', ['11'], true), null)
})

test('rejects writes when a requested journal disappeared or a journal id is missing', () => {
  assert.equal(getTodoTagUpdate(transaction, 'todo', ['11', 'missing'], true), null)
  const malformed = structuredClone(transaction)
  delete malformed.attributes.transactions[1].transaction_journal_id
  assert.equal(getTodoTagUpdate(malformed, 'todo', ['11'], false), null)
})

test('requires a response for the same group with its complete split list', () => {
  const partial = structuredClone(transaction)
  partial.attributes.transactions.pop()
  assert.equal(isSameTransactionGroup(transaction, partial), false)
  assert.equal(isSameTransactionGroup(transaction, { ...transaction, id: '43' }), false)
  assert.equal(isSameTransactionGroup(transaction, transaction), true)
})
