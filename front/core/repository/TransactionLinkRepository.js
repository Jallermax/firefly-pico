import BaseRepository from './BaseRepository.js'

export default class TransactionLinkRepository extends BaseRepository {
  constructor() {
    super('api/transaction-links')
  }

  async getAll() {
    return super.getAllWithMergeResult({ getAll: (options) => super.getAll(options), pageSize: 200 })
  }
}
