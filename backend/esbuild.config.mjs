import { build } from 'esbuild'
import { mkdirSync, createWriteStream, existsSync } from 'fs'
import archiver from 'archiver'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const handlers = [
{ name: 'http-chats',       entry: 'src/http/chats.ts' },
  { name: 'http-messages',    entry: 'src/http/messages.ts' },
  { name: 'http-models',      entry: 'src/http/models.ts' },
  { name: 'http-preferences', entry: 'src/http/preferences.ts' },
  { name: 'http-memory',      entry: 'src/http/memory.ts' },
  { name: 'http-projects',    entry: 'src/http/projects.ts' },
  { name: 'ws-authorizer',    entry: 'src/ws/authorizer.ts' },
  { name: 'ws-connect',       entry: 'src/ws/connect.ts' },
  { name: 'ws-disconnect',    entry: 'src/ws/disconnect.ts' },
  { name: 'ws-sendMessage',      entry: 'src/ws/sendMessage.ts' },
  { name: 'ws-cancelMessage',    entry: 'src/ws/cancelMessage.ts' },
]

const distDir = path.join(__dirname, '..', 'terraform', 'dist')
mkdirSync(distDir, { recursive: true })

// playwright-core's browser registry module does an eager `require('../../browsers.json')`
// relative to its own package directory; single-file bundling breaks that relative path.
// chromium-bidi is required unconditionally too, but is dead code for our Chromium-over-CDP-
// only usage and isn't even installed. Both must stay external — for ws-sendMessage (the only
// handler that imports them, via lib/agentcore/browser.ts), the real package directory is
// copied into the zip below so Node's normal require() resolution finds it at runtime.
const PLAYWRIGHT_EXTERNAL = ['@playwright/mcp', 'playwright-core', 'playwright', 'chromium-bidi']
const rootNodeModules = path.join(__dirname, '..', 'node_modules')

for (const { name, entry } of handlers) {
  const outfile = path.join(distDir, name, 'index.js')
  mkdirSync(path.dirname(outfile), { recursive: true })

  await build({
    entryPoints: [path.join(__dirname, entry)],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile,
    minify: false,
    sourcemap: false,
    external: PLAYWRIGHT_EXTERNAL,
  })

  await new Promise((resolve, reject) => {
    const zipPath = path.join(distDir, `${name}.zip`)
    const output = createWriteStream(zipPath)
    const archive = archiver('zip')
    output.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(output)
    archive.file(outfile, { name: 'index.js' })
    if (name === 'ws-sendMessage') {
      archive.directory(path.join(rootNodeModules, '@playwright/mcp'), 'node_modules/@playwright/mcp')
      // @playwright/mcp pins a newer playwright/playwright-core than this repo's e2e test
      // harness (@playwright/test) hoists to the root node_modules, so npm normally installs
      // private nested copies under @playwright/mcp/node_modules/ — those are the ones Node
      // actually require()'s at runtime (nearest node_modules wins), already included by the
      // directory copy above. Don't also ship the root copies (they'd be dead weight — pure
      // e2e-test-harness baggage). Re-check at build time rather than assuming: if npm's
      // dedup behavior ever changes (e.g. the e2e harness version is bumped to match) and no
      // nested copy exists, fall back to shipping the root one so the bundle still resolves.
      for (const pkg of ['playwright', 'playwright-core']) {
        const nested = path.join(rootNodeModules, '@playwright/mcp', 'node_modules', pkg)
        if (!existsSync(nested)) {
          archive.directory(path.join(rootNodeModules, pkg), `node_modules/${pkg}`)
        }
      }
    }
    archive.finalize()
  })

  console.log(`  ✓ ${name}`)
}
