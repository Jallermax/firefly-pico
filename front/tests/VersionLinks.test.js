import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'

const RELEASES_URL = 'https://github.com/cioraneanu/firefly-pico/releases'
const PERSONAL_REPO_URL = 'https://github.com/Jallermax/firefly-pico'

async function renderSettings(currentCommitSha) {
  const source = await readFile(new URL('../pages/settings/index.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const { compile: compileTemplate } = await import('@vue/compiler-dom')
  const { code } = compileTemplate(descriptor.template.content, { mode: 'function', prefixIdentifiers: true })
  const render = new Function('Vue', code)(Vue)
  const app = Vue.createSSRApp({
    render,
    setup: () => ({
      appStore: {
        currentAppVersion: '1.10.0',
        currentCommitSha,
        isNewVersionAvailable: false,
        latestAppVersion: null,
      },
      REPO_URL: RELEASES_URL,
      PERSONAL_REPO_URL,
      RouteConstants: {},
      TablerIconConstants: {},
      onSyncEverything() {},
    }),
  })
  app.config.globalProperties.$t = (key) => key
  for (const name of ['app-top-toolbar', 'van-cell-group', 'app-field-link']) {
    app.component(name, { render: () => null })
  }
  return renderToString(app)
}

test('personal builds link the upstream version and exact deployed commit separately', async () => {
  const sha = '710523ef10dddb4fd569726ed69eb21826a37ed7'
  const html = await renderSettings(sha)

  assert.match(html, new RegExp(`<a href="${RELEASES_URL}">1\\.10\\.0</a>`))
  assert.match(html, new RegExp(`<a href="${PERSONAL_REPO_URL}/commit/${sha}">${sha}</a>`))
  assert.equal((html.match(new RegExp(`>${sha}</a>`, 'g')) ?? []).length, 1)
})

test('local builds omit the personal commit link when no SHA was embedded', async () => {
  const html = await renderSettings('')

  assert.match(html, new RegExp(`<a href="${RELEASES_URL}">1\\.10\\.0</a>`))
  assert.doesNotMatch(html, new RegExp(`${PERSONAL_REPO_URL}/commit/`))
})
