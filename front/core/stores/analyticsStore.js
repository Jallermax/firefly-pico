import { useLocalStorage } from '@vueuse/core'
import { useAppStore } from '~/core/stores/appStore.js'
import { useDashboardStore } from '~/core/stores/dashboardStore.js'
import { useBudgetStore } from '~/core/stores/budgetStore.js'
import { useCurrencyStore } from '~/core/stores/currencyStore.js'
import AccountRepository from '~/core/repository/AccountRepository.js'
import TransactionRepository from '~/core/repository/TransactionRepository.js'
import TransactionLinkRepository from '~/core/repository/TransactionLinkRepository.js'
import TransactionLinkTypeRepository from '~/core/repository/TransactionLinkTypeRepository.js'
import SubscriptionRepository from '~/core/repository/SubscriptionRepository.js'
import RecurringTransactionRepository from '~/core/repository/RecurringTransactionRepository.js'
import Currency from '~/core/models/Currency.js'
import { reconstructBalanceSeries } from '~/core/utils/AnalyticsBalanceUtils.js'
import { buildAnalyticsLedger } from '~/core/utils/AnalyticsLedgerUtils.js'
import { getExcludedTransactionFilters } from '~/core/utils/DashboardUtils.js'
import { createAnalyticsStore } from '~/core/stores/analyticsStoreFactory.js'

export const useAnalyticsStore = createAnalyticsStore('analytics', () => ({
  appStore: useAppStore(),
  dashboardStore: useDashboardStore(),
  budgetStore: useBudgetStore(),
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
