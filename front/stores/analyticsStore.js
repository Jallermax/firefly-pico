import { useLocalStorage } from '@vueuse/core'
import { useAppStore } from '~/stores/appStore.js'
import { useDashboardStore } from '~/stores/dashboardStore.js'
import { useCurrencyStore } from '~/stores/currencyStore.js'
import AccountRepository from '~/repository/AccountRepository.js'
import TransactionRepository from '~/repository/TransactionRepository.js'
import TransactionLinkRepository from '~/repository/TransactionLinkRepository.js'
import TransactionLinkTypeRepository from '~/repository/TransactionLinkTypeRepository.js'
import SubscriptionRepository from '~/repository/SubscriptionRepository.js'
import RecurringTransactionRepository from '~/repository/RecurringTransactionRepository.js'
import Currency from '~/models/Currency.js'
import { reconstructBalanceSeries } from '~/utils/AnalyticsBalanceUtils.js'
import { buildAnalyticsLedger } from '~/utils/AnalyticsLedgerUtils.js'
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
  transactionLinkTypeRepository: new TransactionLinkTypeRepository(),
  subscriptionRepository: new SubscriptionRepository(),
  recurringTransactionRepository: new RecurringTransactionRepository(),
  getCurrencyCode: (currency) => Currency.getCode(currency),
  getCurrencyDecimalPlaces: (currency) => Currency.getDecimalPlaces(currency),
  getExcludedTransactionFilters,
  buildLedger: buildAnalyticsLedger,
  reconstructBalances: reconstructBalanceSeries,
}))
