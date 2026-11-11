/**
 * Offline self-test: no network, no MinerU token needed.
 * Run: node test/selftest.mjs
 */

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { extractZip, listZipEntries } from '../lib/zip.js'
import { arxivPdfUrl, cacheKey, expandPath, listPapers, normalizeSource, slugify } from '../lib/core.js'
import { resolveSettings, publicSettings } from '../lib/config.js'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

console.log('dsh-paper2md self-test')

// --- zip ---------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'p2m-'))
const src = join(work, 'src')
mkdirSync(join(src, 'images'), { recursive: true })
writeFileSync(join(src, 'full.md'), '# Demo Paper\n\n![](images/fig1.png)\n\n正文内容。\n', 'utf8')
writeFileSync(join(src, 'images', 'fig1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
writeFileSync(join(src, 'demo_middle.json'), JSON.stringify({ huge: 'x'.repeat(500) }))
const zipPath = join(work, 'out.zip')
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${src}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: 'ignore' })

check('zip: central directory is readable', () => {
  const entries = listZipEntries(readFileSync(zipPath))
  const names = entries.map((e) => e.name)
  assert(names.includes('full.md'), `missing full.md in ${names.join(',')}`)
})

check('zip: extracts files and respects skip()', () => {
  const dest = join(work, 'extracted')
  const written = extractZip(readFileSync(zipPath), dest, { skip: (n) => n.endsWith('_middle.json') })
  assert(existsSync(join(dest, 'full.md')), 'full.md not written')
  assert(readFileSync(join(dest, 'full.md'), 'utf8').includes('Demo Paper'), 'full.md content mismatch')
  assert(existsSync(join(dest, 'images', 'fig1.png')), 'image not written')
  assert(!written.some((w) => w.name.endsWith('_middle.json')), 'skip() was ignored')
})

// --- source normalization ---------------------------------------------
check('arxiv: abs url becomes a pdf url', () => {
  assert(arxivPdfUrl('https://arxiv.org/abs/2401.12345') === 'https://arxiv.org/pdf/2401.12345.pdf', 'abs')
  assert(arxivPdfUrl('https://arxiv.org/pdf/2401.12345v2') === 'https://arxiv.org/pdf/2401.12345v2.pdf', 'pdf')
  assert(arxivPdfUrl('https://example.com/x.pdf') === null, 'non-arxiv must be null')
})

check('source: remote pdf is classified as url', () => {
  const s = normalizeSource('https://example.com/papers/abc.pdf')
  assert(s.kind === 'url' && s.name === 'abc.pdf', JSON.stringify(s))
})

check('source: missing local file throws', () => {
  let threw = false
  try {
    normalizeSource(join(work, 'nope.pdf'))
  } catch {
    threw = true
  }
  assert(threw, 'expected a throw')
})

check('source: local file resolves and reports size', () => {
  const p = join(work, 'local.pdf')
  writeFileSync(p, 'x'.repeat(32))
  const s = normalizeSource(p)
  assert(s.kind === 'file' && s.size === 32, JSON.stringify(s))
})

// --- helpers ----------------------------------------------------------
check('slugify: keeps it filesystem safe', () => {
  assert(slugify('Attention Is All You Need.pdf') === 'Attention-Is-All-You-Need', slugify('Attention Is All You Need.pdf'))
  assert(slugify('a/b:c*d?.pdf') === 'a-b-c-d', slugify('a/b:c*d?.pdf'))
  assert(slugify('') === 'paper', slugify(''))
})

check('cacheKey: stable and parameter sensitive', () => {
  const a = cacheKey(['abc', 'vlm', 'ch'])
  const b = cacheKey(['abc', 'vlm', 'ch'])
  const c = cacheKey(['abc', 'pipeline', 'ch'])
  assert(a === b && a !== c, 'cache key must change with model')
})

check('expandPath: expands ~', () => {
  const home = process.env.USERPROFILE ?? process.env.HOME
  assert(expandPath('~/x.pdf').startsWith(home), expandPath('~/x.pdf'))
})

// --- config & listing -------------------------------------------------
check('settings: defaults without a config file', () => {
  const prev = process.env.PAPER2MD_DIR
  process.env.PAPER2MD_DIR = join(work, 'papers')
  const s = resolveSettings()
  assert(s.outputDir === join(work, 'papers'), s.outputDir)
  assert(s.modelVersion === 'vlm', s.modelVersion)
  const pub = publicSettings()
  assert(pub.token === undefined, 'token must never be exposed')
  if (prev === undefined) delete process.env.PAPER2MD_DIR
  else process.env.PAPER2MD_DIR = prev
})

check('listPapers: empty output dir is not an error', () => {
  const prev = process.env.PAPER2MD_DIR
  process.env.PAPER2MD_DIR = join(work, 'papers-empty')
  const res = listPapers({})
  assert(res.ok === true && res.count === 0, JSON.stringify(res))
  if (prev === undefined) delete process.env.PAPER2MD_DIR
  else process.env.PAPER2MD_DIR = prev
})

rmSync(work, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
