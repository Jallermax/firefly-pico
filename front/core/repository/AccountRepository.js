import BaseRepository from '~/core/repository/BaseRepository'
import axios from 'axios'
import { cloneDeep, get } from 'lodash-es'
import Account from '~/core/models/Account'
import AccountTransformer from '~/core/transformers/AccountTransformer'

export default class AccountRepository extends BaseRepository {
  constructor() {
    super('api/accounts')
  }

  async getGroups(text) {
    const url = `${useAppStore().picoBackendURL}/api/accounts/groups?text=${encodeURIComponent(text)}`
    let response = await axios.get(url)
    return get(response, 'data') ?? []
  }

  async getChartOverview({ start, end, period, accountIds, showLoading = false } = {}) {
    const params = new URLSearchParams({ start, end, period })
    accountIds.forEach((accountId) => params.append('accounts[]', accountId))
    const url = useAppStore().picoBackendURL + '/api/chart/account/overview?' + params.toString()
    return axios.get(url, { showLoading, showErrorToast: false })
  }

  async adjustBalance(account, balance) {
    const body = cloneDeep(account)
    body.attributes.opening_balance = parseFloat(body.attributes.opening_balance) + parseFloat(balance) - parseFloat(Account.getBalance(account))
    return await this.update(account.id, AccountTransformer.transformToApi(body))
  }
}
