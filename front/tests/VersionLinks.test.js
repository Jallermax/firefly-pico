import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import * as Constants from '../constants/Constants.js'

const EXPECTED_REPO_URL = 'https://github.com/cioraneanu/firefly-pico'
const EXPECTED_RELEASES_URL = `${EXPECTED_REPO_URL}/releases`
const EXPECTED_PERSONAL_REPO_URL = 'https://github.com/Jallermax/firefly-pico'

async function renderSettings(currentCommitSha, isNewVersionAvailable = false) {
  const source = await readFile(new URL('../pages/settings/index.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const { compile: compileTemplate } = await import('@vue/compiler-dom')
  const { code } = compileTemplate(descriptor.template.content, { mode: 'function', prefixIdentifiers: true })
  const render = new Function('Vue', code)(Vue)
  const app = Vue.createSSRApp({
    render,
    setup: () => ({
      appStore: {
        currentAppVersion: '1.12.1-3-dev',
        currentCommitSha,
        isNewVersionAvailable,
        latestAppVersion: isNewVersionAvailable ? '1.12.1-4-dev' : null,
      },
      RELEASES_URL: Constants.RELEASES_URL,
      PERSONAL_REPO_URL: Constants.PERSONAL_REPO_URL,
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

  assert.match(html, new RegExp(`<a href="${EXPECTED_RELEASES_URL}">1\\.12\\.1-3-dev</a>`))
  assert.match(html, new RegExp(`<a href="${EXPECTED_PERSONAL_REPO_URL}/commit/${sha}">${sha}</a>`))
  assert.equal((html.match(new RegExp(`>${sha}</a>`, 'g')) ?? []).length, 1)
})

test('local builds omit the personal commit link when no SHA was embedded', async () => {
  const html = await renderSettings('')

  assert.match(html, new RegExp(`<a href="${EXPECTED_RELEASES_URL}">1\\.12\\.1-3-dev</a>`))
  assert.doesNotMatch(html, new RegExp(`${EXPECTED_PERSONAL_REPO_URL}/commit/`))
})

test('available updates link to upstream releases', async () => {
  const html = await renderSettings('', true)

  assert.ok(html.includes(`<a href="${EXPECTED_RELEASES_URL}">settings.new_version_available: 1.12.1-4-dev`))
})

test('repository and release links have distinct production targets', () => {
  assert.equal(Constants.REPO_URL, EXPECTED_REPO_URL)
  assert.equal(Constants.RELEASES_URL, EXPECTED_RELEASES_URL)
  assert.equal(Constants.PERSONAL_REPO_URL, EXPECTED_PERSONAL_REPO_URL)
})
