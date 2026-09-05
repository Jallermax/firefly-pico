import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = '/tests/browser/fixtures.js'
const globals = ['computed', 'ref', 'watch', 'isRef', 'useAppStore', 'useProfileStore', 'useTagStore', 'useI18n', 'useDevice', 'navigateTo', 'useRouter', 'isStringEmpty']
const server = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 6981, strictPort: true },
  resolve: { alias: { '~': root } },
  plugins: [
    {
      name: 'inbox-test-boundaries',
      enforce: 'pre',
      resolveId(id) {
        if (/\/stores\/\w+(\.js)?$/.test(id)) return root + 'tests/browser/fixtures.js'
        if (/\/(Tag|Transaction)Repository\.js$/.test(id)) return '\0inbox-test-repository:' + id
      },
      load(id) {
        if (id.startsWith('\0inbox-test-repository:')) return `export { ${id.includes('TagRepository') ? 'TagRepository' : 'TransactionRepository'} as default } from '${fixture}'`
      },
      transform(code, id) {
        if (!id.startsWith(root.replaceAll('\\', '/')) || id.includes('/tests/') || id.includes('/node_modules/') || id.includes('?') || !/\.(vue|js)$/.test(id)) return
        const script = id.endsWith('.vue') ? code.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1] : code
        if (!script) return
        const imports = script.match(/import[\s\S]*?from\s*['"][^'"]+['"]/g)?.join('\n') ?? ''
        const missing = globals.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(script) && !new RegExp(`\\b${name}\\b`).test(imports))
        if (!missing.length) return
        const injected = `import { ${missing.join(', ')} } from '${fixture}'\n` + script
        return id.endsWith('.vue') ? code.replace(script, injected) : injected
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/todo-inbox')) return next()
          res.setHeader('Content-Type', 'text/html')
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/tests/browser/client.js"></script></body></html>',
            ),
          )
        })
      },
    },
    vue(),
  ],
})
await server.listen()
server.printUrls()
