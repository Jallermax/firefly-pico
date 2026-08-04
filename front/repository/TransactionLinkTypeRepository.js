import BaseRepository from './BaseRepository.js'

export default class TransactionLinkTypeRepository extends BaseRepository {
  constructor() {
    super('link-types')
  }

  async getAll() {
    return super.getAllWithMergeResult({ getAll: (options) => super.getAll(options), pageSize: 200 })
  }
}
