import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8').replace(/\\\n/g, ' ')

test('runtime archives omit build dependencies and retain backend and Nitro dependencies', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pico-archives-'))
  try {
    const back = join(tmp, 'back')
    const front = join(back, 'front')
    for (const file of ['vendor/autoload.php', 'VERSION', 'UPSTREAM_VERSION', 'front/package.json', 'front/node_modules/build-only.js', 'front/.nuxt/build.js', 'front/.cache/build.js', 'front/.output/server/index.mjs', 'front/.output/server/node_modules/runtime.js']) {
      const path = join(back, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file)
    }
    for (const [name, cwd] of [['back', back], ['front', front]]) {
      const archive = join(tmp, `app-${name}.tar.gz`)
      const commands = dockerfile.split('\n').filter((line) => line.startsWith('RUN tar ') && line.includes(`/tmp/app-${name}.tar.gz`))
      assert.equal(commands.length, 1, `expected one ${name} archive command`)
      execFileSync('sh', ['-ec', commands[0].slice(4).replace(`/tmp/app-${name}.tar.gz`, archive)], { cwd })
      const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
      if (name === 'back') {
        for (const file of ['./vendor/autoload.php', './VERSION', './UPSTREAM_VERSION']) assert.ok(files.includes(file), `missing ${file}`)
        assert.ok(!files.some((file) => file.startsWith('./front/')), 'backend archive duplicates frontend build dependencies')
      } else {
        for (const file of ['./package.json', './.output/server/index.mjs', './.output/server/node_modules/runtime.js']) assert.ok(files.includes(file), `missing ${file}`)
        for (const dir of ['node_modules', '.nuxt', '.cache']) assert.ok(!files.some((file) => file.startsWith(`./${dir}/`)), `frontend archive includes ${dir}`)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
