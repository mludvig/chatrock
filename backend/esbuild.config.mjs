import { build } from 'esbuild'
import { mkdirSync, createWriteStream } from 'fs'
import archiver from 'archiver'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Handlers to bundle — add more here as phases progress
const handlers = [
  { name: 'http-hello',       entry: 'src/http/hello.ts' },
]

const distDir = path.join(__dirname, '..', 'terraform', 'dist')
mkdirSync(distDir, { recursive: true })

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
  })

  await new Promise((resolve, reject) => {
    const zipPath = path.join(distDir, `${name}.zip`)
    const output = createWriteStream(zipPath)
    const archive = archiver('zip')
    output.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(output)
    archive.file(outfile, { name: 'index.js' })
    archive.finalize()
  })

  console.log(`  ✓ ${name}`)
}
