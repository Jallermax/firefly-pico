import { useLocalStorage } from '@vueuse/core'
import { useAppStore } from '~/stores/appStore.js'
import { useDashboardStore } from '~/stores/dashboardStore.js'
import { useCurrencyStore } from '~/stores/currencyStore.js'
import AccountRepository from '~/repository/AccountRepository.js'
import TransactionRepository from '~/repository/TransactionRepository.js'
import TransactionLinkRepository from '~/repository/TransactionLinkRepository.js'
import SubscriptionRepository from '~/repository/SubscriptionRepository.js'
import RecurringTransactionRepository from '~/repository/RecurringTransactionRepository.js'
import TransactionTransformer from '~/transformers/TransactionTransformer.js'
import Account from '~/models/Account.js'
import Currency from '~/models/Currency.js'
import ResponseUtils from '~/utils/ResponseUtils.js'
import { getExcludedTransactionFilters } from '~/utils/DashboardUtils.js'
import { createAnalyticsStore } from '~/stores/analyticsStoreFactory.js'

export const useAnalyticsStore = createAnalyticsStore('analytics', () => ({
  appStore: useAppStore(),
  dashboardStore: useDashboardStore(),
  currencyStore: useCurrencyStore(),
  useStoredValue: useLocalStorage,
  accountRepository: new AccountRepository(),
  transactionRepository: new TransactionRepository(),
  transactionLinkRepository: new TransactionLinkRepository(),
  subscriptionRepository: new SubscriptionRepository(),
  recurringTransactionRepository: new RecurringTransactionRepository(),
  transformTransactions: (transactions) => TransactionTransformer.transformFromApiList(transactions),
  getAccountBalance: (account) => Account.getBalance(account),
  getAccountCurrencyCode: (account) => Account.getCurrencyCode(account),
  getCurrencyCode: (currency) => Currency.getCode(currency),
  getCurrencyDecimalPlaces: (currency) => Currency.getDecimalPlaces(currency),
  getExcludedTransactionFilters,
  isResponseSuccess: (response) => ResponseUtils.isSuccess(response),
}))
