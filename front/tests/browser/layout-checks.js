export const checkReviewLayout = () => {
  const item = document.querySelector('.todo-inbox-item')
  const properties = item?.querySelector('.todo-inbox-properties')
  if (!properties) return ['FAIL: Expand the first transaction before checking layout.']

  const results = []
  const check = (name, passes) => results.push(`${passes ? 'PASS' : 'FAIL'}: ${name}`)
  const fields = [...properties.querySelectorAll('.todo-inbox-property')]
  const field = (label) => fields.find((element) => element.querySelector('dt').textContent.trim() === label)
  const tags = field('Tags')?.getBoundingClientRect()
  const subscription = field('Subscription')?.getBoundingClientRect()
  const date = field('Processing date')?.getBoundingClientRect()
  const done = item.querySelector('.todo-inbox-done')

  check('Done icon matches the action text', getComputedStyle(done.querySelector('.svg-icon')).color === getComputedStyle(done).color)
  check('Odd field count has no divider-colored blank block', ['rgba(0, 0, 0, 0)', getComputedStyle(item).backgroundColor].includes(getComputedStyle(properties).backgroundColor))
  check('Processing date uses the space directly below Subscription', Boolean(date && subscription && Math.abs(date.left - subscription.left) < 1 && Math.abs(date.top - subscription.bottom) <= 1))
  check('Long Tags do not push Processing date into another row', Boolean(date && tags && date.top < tags.bottom))
  check('Review content does not overflow horizontally', item.scrollWidth <= item.clientWidth)
  return results
}
