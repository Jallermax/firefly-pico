import { Marked } from 'marked'
import { formatAmount } from './AmountUtils.js'

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const markdown = new Marked({
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text),
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return text
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  },
})

export const renderTodoNotes = (notes) => markdown.parse(notes ?? '')

export const getTodoReviewAmounts = (splits, locale) => {
  const groups = new Map()
  for (const split of splits) {
    const type = split.type?.code ?? split.type
    const currency = split.currency_symbol ?? split.currency_code ?? ''
    const key = `${type}-${split.currency_id ?? split.currency_code ?? currency}`
    const group = groups.get(key) ?? { key, type, currency, values: [] }
    group.values.push(String(split.amount ?? ''))
    groups.set(key, group)
  }
  return [...groups.values()].map(({ key, type, currency, values }) => {
    if (values.some((value) => !/^-?\d+(\.\d+)?$/.test(value))) return { key, type, text: ['—', currency].filter(Boolean).join(' ') }
    const scale = Math.max(...values.map((value) => value.split('.')[1]?.length ?? 0))
    const sum = values.reduce((total, value) => {
      const [integer, fraction = ''] = value.split('.')
      return total + BigInt(integer + fraction.padEnd(scale, '0'))
    }, 0n)
    const digits = (sum < 0n ? -sum : sum).toString().padStart(scale + 1, '0')
    const amount = `${sum < 0n ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`
    const sign = sum < 0n ? '' : type === 'expense' ? '-' : type === 'income' ? '+' : ''
    return { key, type, text: [`${sign}${formatAmount(amount, locale)}`, currency].filter(Boolean).join(' ') }
  })
}
