import BaseRepository from './BaseRepository.js'

export default class SubscriptionRepository extends BaseRepository {
  constructor() {
    super('subscriptions')
  }

  getParams(startDate, endDate) {
    return { start: startDate, end: endDate }
  }

  async getAll(startDate, endDate) {
    const params = this.getParams(startDate, endDate)
    const filters = Object.entries(params).map(([field, value]) => ({ field, value }))
    return super.getAllWithMergeResult({ filters, getAll: (options) => super.getAll({ ...options, filters }), pageSize: 200 })
  }
}
