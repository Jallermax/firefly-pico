import axios from 'axios'
import { get } from 'lodash-es'

const MERGED_PAGE_CONCURRENCY = 6

export default class BaseRepository {
  constructor(endpoint) {
    this.endpoint = endpoint
    this.getAll = this.getAll.bind(this)
  }

  getUrl() {
    const appStore = useAppStore()
    return `${appStore.picoBackendURL}/${this.endpoint}`
  }

  async getOne(id) {
    let result = await axios.get(`${this.getUrl()}/${id}`)
    return get(result, 'data', {})
  }

  async getAll({ filters = [], page = 1, pageSize = 50, showLoading = true } = {}) {
    let url = this.getUrlForRequest({ filters, page, pageSize })
    let response = await axios.get(url, { showLoading })
    return get(response, 'data', {})
  }

  async getTable({ filters = [], page = 1 } = {}) {
    let url = this.getUrlForRequest({ filters, page })
    let response = await axios.get(url)
    return get(response, 'data', {})
  }

  async getAllWithMerge({ filters = [], getAll = null } = {}) {
    let list = []
    let getMethod = getAll ?? this.getAll
    const firstPageResponseBody = await getMethod({ filters, page: 1 })
    let responseList = get(firstPageResponseBody, 'data', [])
    list = [...list, ...responseList]

    // Stop at the first empty page too => Firefly's search endpoint reports total_pages for all transactions, not just the matches.
    // A failed page has no `data` and doesn't stop the pages after it
    let totalPages = get(firstPageResponseBody, 'meta.pagination.total_pages')
    for (let page = 2; page <= totalPages && responseList?.length !== 0; page++) {
      const pageResponse = await getMethod({ filters, page })
      responseList = get(pageResponse, 'data')
      list = [...list, ...(responseList ?? [])]
    }
    return list
  }

  async getAllWithMergeResult({ filters = [], getAll = null, pageSize = 50 } = {}) {
    const list = []
    const getMethod = getAll ?? this.getAll
    const firstPage = await getMethod({ filters, page: 1, pageSize })
    if (!Array.isArray(firstPage?.data)) return { ok: false, data: [] }

    list.push(...firstPage.data)
    const totalPages = Number(firstPage?.meta?.pagination?.total_pages ?? 1)
    const remainingPages = await this.getRemainingPages({ filters, getMethod, pageSize, totalPages })
    for (const response of remainingPages) {
      if (!Array.isArray(response?.data)) return { ok: false, data: [] }
      list.push(...response.data)
    }
    return { ok: true, data: list }
  }

  async update(id, data) {
    let result = await axios.put(`${this.getUrl()}/${id}`, data)
    return result
    // return get(result, 'data', {})
  }

  async insert(data) {
    let result = await axios.post(`${this.getUrl()}`, data)
    return result
    // return get(result, 'data', {})
  }

  async delete(id) {
    let result = await axios.delete(`${this.getUrl()}/${id}`)
    return result
    // return get(result, 'data', {})
  }

  // ---------------------------- PRIVATE --------------------------

  async getRemainingPages({ filters, getMethod, pageSize, totalPages }) {
    const pages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 2)
    const responses = new Array(pages.length)
    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < pages.length) {
        const index = nextIndex++
        responses[index] = await getMethod({ filters, page: pages[index], pageSize })
      }
    }
    await Promise.all(Array.from({ length: Math.min(MERGED_PAGE_CONCURRENCY, pages.length) }, worker))
    return responses
  }

  getUrlForRequest({ filters = [], page = 1, pageSize = 10, url = null } = {}) {
    let requestURL = url ?? this.getUrl()

    let filterParam = this.getURLSuffixFromFilters(filters)
    let pageParam = page ? `page=${page}` : null
    let pageSizeParam = pageSize ? `limit=${pageSize}` : null

    let urlParams = [filterParam, pageParam, pageSizeParam].filter((item) => item)
    if (urlParams.length > 0) {
      requestURL += '?' + urlParams.join('&')
    }

    return requestURL
  }

  getURLSuffixFromFilters(filterArray) {
    if (!filterArray || filterArray.length === 0) {
      return null
    }

    let filters = []
    for (const filter of filterArray) {
      let filterValue = Array.isArray(filter.value) ? filter.value.join(',') : filter.value
      if (filterValue === null || filterValue === undefined || filterValue === '') {
        continue
      }
      filterValue = encodeURIComponent(filterValue)
      // filters.push(`filter[${filter.field}]=${filterValue}`)
      filters.push(`${filter.field}=${filterValue}`)
    }

    return `${filters.join('&')}`
  }
}
