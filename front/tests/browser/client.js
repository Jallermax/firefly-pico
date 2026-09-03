import { createApp, h, ref } from 'vue'
import Vant, { ConfigProvider } from 'vant'
import 'vant/lib/index.css'
import '../../assets/styles/bootstrap.min.css'
import '../../assets/styles/variables.css'
import '../../assets/styles/theme-white.css'
import '../../assets/styles/theme-dark.css'
import '../../assets/styles/helper.css'
import { mode, profile, useI18n, releaseSaves } from './fixtures.js'
import Inbox from '../../pages/todo-inbox.vue'
import Item from '../../components/todo-inbox/todo-inbox-transaction-item.vue'
import Details from '../../components/todo-inbox/todo-inbox-review-details.vue'
import Toolbar from '../../components/ui-kit/theme/app-top-toolbar.vue'
import AccountBadge from '../../components/general/account-badge.vue'
import CategoryBadge from '../../components/general/category-badge.vue'
import TagBadge from '../../components/general/tag-badge.vue'
import SplitBadge from '../../components/transaction/transaction-split-badge.vue'
import AppIcon from '../../components/ui-kit/app-icon.vue'
import * as icons from '@tabler/icons-vue'
import { checkReviewLayout } from './layout-checks.js'

const layoutResults = ref([])

const app = createApp({
  render: () =>
    h(
      ConfigProvider,
      { theme: mode.dark ? 'dark' : 'light', style: { overflowAnchor: 'none', minHeight: '100vh', background: 'var(--van-background)', color: 'var(--van-text-color)' } },
      {
        default: () => [
          h('div', { style: { padding: '8px 16px', display: 'flex', flexWrap: 'wrap', gap: '12px', background: '#dce7ef', color: '#182733' } }, [
            h('span', 'Synthetic test data'),
            ...[
              ['mobile', 'Mobile layout'],
              ['dark', 'Dark theme'],
              ['fail', 'Fail saves'],
              ['hold', 'Hold saves'],
            ].map(([key, label]) =>
              h('label', [
                h('input', {
                  type: 'checkbox',
                  checked: mode[key],
                  onChange: (event) => {
                    mode[key] = event.target.checked
                  },
                }),
                label,
              ]),
            ),
            ...[
              ['categoriesEnabled', 'tagsEnabled', 'Category and tag fields'],
              ['budgetsEnabled', 'recurringTransactionsEnabled', 'Budget and subscription fields'],
            ].map(([first, second, label]) =>
              h('label', [h('input', { type: 'checkbox', checked: profile[first], onChange: (event) => (profile[first] = profile[second] = event.target.checked) }), label]),
            ),
            h('button', { onClick: releaseSaves, style: { position: 'fixed', bottom: '8px', left: '8px', zIndex: 9999 } }, 'Release saves'),
            h('button', { onClick: () => (layoutResults.value = checkReviewLayout()) }, 'Check layout'),
            h('output', { 'aria-label': 'Layout checks', style: { width: '100%', whiteSpace: 'pre-wrap' } }, layoutResults.value.join('\n')),
          ]),
          h('div', { class: mode.mobile ? 'layout-mobile' : 'layout-desktop', style: mode.mobile ? { width: '390px', maxWidth: '100%', margin: '0 auto' } : { marginLeft: '240px' } }, [
            h(Inbox, { key: mode.mobile }),
          ]),
        ],
      },
    ),
})
app.use(Vant)
app.config.globalProperties.$t = useI18n().t
for (const [name, component] of Object.entries({
  'todo-inbox-transaction-item': Item,
  'todo-inbox-review-details': Details,
  'app-top-toolbar': Toolbar,
  'account-badge': AccountBadge,
  'category-badge': CategoryBadge,
  'tag-badge': TagBadge,
  'transaction-split-badge': SplitBadge,
  'app-icon': AppIcon,
}))
  app.component(name, component)
for (const [name, icon] of Object.entries(icons)) app.component(name, icon)
for (const name of ['empty-list', 'app-tutorial']) app.component(name, { render: () => null })
app.mount('#app')
