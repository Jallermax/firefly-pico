import axios from 'axios'
import BaseRepository from '~/repository/BaseRepository'
import DateUtils from '~/utils/DateUtils.js'
import { buildTodoTransactionsPath, getTodoHistoryFilters, TODO_PAGE_SIZE } from '~/utils/TodoTransactionUtils.js'

export default class TagRepository extends BaseRepository {
  constructor() {
    super('api/tags')
  }

  async computeTotal(id) {
    return await axios.post(`${this.getUrl()}/${id}/total`)
  }

  async getTodoTransactions(tag, { page = 1, pageSize = TODO_PAGE_SIZE, showLoading = true } = {}) {
    const appStore = useAppStore()
    const path = buildTodoTransactionsPath(tag)
    const url = this.getUrlForRequest({
      url: `${appStore.picoBackendURL}/${path}`,
      filters: getTodoHistoryFilters(DateUtils.dateToString(new Date())),
      page,
      pageSize,
    })
    return await axios.get(url, { showLoading, showErrorToast: false })
  }
}
