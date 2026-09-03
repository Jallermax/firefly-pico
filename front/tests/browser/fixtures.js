import { computed, ref, watch, isRef, reactive } from 'vue'
import en from '../../i18n/locales/en.json'
export { computed, ref, watch, isRef }

export const mode = reactive({ mobile: false, dark: false, fail: false, hold: false })
const usd = { id: '1', attributes: { code: 'USD', symbol: '$', decimal_places: 2 } }
const accounts = { 1: { id: '1', attributes: { name: 'Checking', type: 'asset' } }, 2: { id: '2', attributes: { name: 'Harbor Market', type: 'expense' } } }
const todo = { id: '1', attributes: { tag: 'todo', is_todo: true } }
const groceries = { id: '2', attributes: { tag: 'family/groceries/weekly-shopping' } }
const reviewTags = ['import/automatic', 'import/provisional', 'review/needs-attention'].map((tag, index) => ({ id: String(index + 3), attributes: { tag } }))
const category = { id: '1', attributes: { name: 'Groceries' } }
export const app = reactive({
  get isDesktopLayout() {
    return !mode.mobile
  },
  isSyncRequiredByMissingExtras: false,
})
export const profile = reactive({ dateFormat: 'MM/dd/yyyy', categoriesEnabled: true, budgetsEnabled: true, tagsEnabled: true, recurringTransactionsEnabled: true, showAnimations: false })
export const useAppStore = () => app
export const useProfileStore = () => profile
export const useAccountStore = () => ({ accountDictionary: accounts })
export const useCategoryStore = () => ({ categoryDictionary: { 1: category } })
export const useTagStore = () => ({ tagTodo: todo, tagDictionaryByName: Object.fromEntries([todo, groceries, ...reviewTags].map((tag) => [tag.attributes.tag, tag])) })
export const useBudgetStore = () => ({ budgetDictionary: { 1: { id: '1', attributes: { name: 'Household' } } } })
export const usePiggyBankStore = () => ({ piggyBankDictionary: {} })
export const useCurrencyStore = () => ({ currencyDictionary: { 1: usd } })
export const useLoadingStore = () => ({})
export const useDevice = () => ({ isDesktop: !mode.mobile })
export const isStringEmpty = (value) => !value
export const useRouter = () => ({ options: { history: { state: {} } } })
export const navigateTo = async () => alert('Existing transaction editor would open here. No real transaction is involved.')
const t = (key, values = {}) => String(key.split('.').reduce((value, part) => value?.[part], en) ?? key).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '')
export const useI18n = () => ({ locale: ref('en'), t })

const data = Array.from({ length: 30 }, (_, index) => ({
  id: String(index + 1),
  type: 'transactions',
  attributes: {
    transactions: [
      {
        transaction_journal_id: String(index + 101),
        type: index === 2 ? 'deposit' : 'withdrawal',
        description: ['Harbor Market', 'Cloud hosting', 'Expense reimbursement'][index % 3],
        amount: '84.29',
        currency_id: '1',
        currency_code: 'USD',
        currency_symbol: '$',
        date: '2026-09-01T14:35:00+00:00',
        source_id: '1',
        source_name: 'Checking',
        destination_id: '2',
        destination_name: 'Harbor Market',
        category_id: '1',
        category_name: 'Groceries',
        budget_id: index % 2 ? null : '1',
        budget_name: index % 2 ? null : 'Household',
        tags: index === 0 ? ['todo', 'family/groceries/weekly-shopping', ...reviewTags.map((tag) => tag.attributes.tag)] : ['todo', 'family/groceries/weekly-shopping'],
        process_date: index === 0 ? '2026-09-02T00:00:00+00:00' : null,
        bill_name: index % 2 ? 'Cloud hosting' : null,
        notes:
          index % 2
            ? 'Monthly subscription. **Verify the plan and billing period.**'
            : '### Order details\n\n**Delivered** · Verify category and budget.\n\n```text\nMilk 4.29 · Bread 6.00 · This deliberately long receipt line must wrap on mobile and desktop without horizontal scrolling or clipping any important review information.\n```\n\n| Item | Cost |\n|---|---|\n| Groceries | 84.29 |',
      },
    ],
  },
}))
data[3].attributes.group_title = 'Split grocery purchase'
data[3].attributes.transactions.push({ ...data[3].attributes.transactions[0], transaction_journal_id: '999', description: 'Household supplies', amount: '12.30', notes: 'Second split notes' })
const response = (item) => ({ status: 200, data: { data: structuredClone(item) } })
const pending = []
export const releaseSaves = () => pending.splice(0).forEach((resolve) => resolve())
const pause = () => new Promise((resolve) => (mode.hold ? pending.push(resolve) : setTimeout(resolve, 2000)))
export class TagRepository {
  async getTodoTransactions() {
    const items = data.filter((item) => item.attributes.transactions.some((split) => split.tags.includes('todo')))
    return { ...response(items), data: { data: structuredClone(items), meta: { pagination: { current_page: 1, per_page: 50, total_pages: 1, total: items.length } } } }
  }
}
export class TransactionRepository {
  async getTodoTransaction(id) {
    return response(data.find((item) => item.id === id))
  }
  async updateTodoTags(id, request) {
    const shouldFail = mode.fail
    await pause()
    if (shouldFail) return { status: 422, data: { message: 'Test save failed. Your transaction was not changed.' } }
    const item = data.find((item) => item.id === id)
    request.transactions.forEach((update) => {
      item.attributes.transactions.find((split) => split.transaction_journal_id === update.transaction_journal_id).tags = update.tags
    })
    return response(item)
  }
}
