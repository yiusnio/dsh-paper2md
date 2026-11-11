/**
 * Integration dry run: mounts the plugin onto a fake cordis context and checks
 * that every surface registers the expected shape. No network, no dsh process.
 * Run: node test/dryrun.mjs
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject, PAPER2MD_GUIDANCE } from '../lib/index.js'

// Keep the dry run off the real paper cache.
process.env.PAPER2MD_DIR = join(tmpdir(), 'p2m-dryrun-out')

let failed = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ''}`)
  }
}

const registered = { tools: [], routes: [], prompts: [] }
const disposals = []

const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposals.push(dispose)
    else disposals.push(() => {})
  },
  tools: {
    register(tool) {
      registered.tools.push(tool)
      return () => {
        const i = registered.tools.indexOf(tool)
        if (i >= 0) registered.tools.splice(i, 1)
      }
    },
  },
  webServer: {
    register(route) {
      registered.routes.push(route)
      return () => {
        const i = registered.routes.indexOf(route)
        if (i >= 0) registered.routes.splice(i, 1)
      }
    },
  },
  systemPrompt: {
    section(section) {
      registered.prompts.push(section)
      return () => {
        const i = registered.prompts.indexOf(section)
        if (i >= 0) registered.prompts.splice(i, 1)
      }
    },
  },
}

console.log('dsh-paper2md dry run')

apply(ctx)

check('plugin name is stable', name === 'paper2md', name)
check('injects the expected services', ['webServer', 'tools', 'systemPrompt'].every((s) => inject.includes(s)), inject.join(','))
check('registers 4 tools', registered.tools.length === 4, String(registered.tools.length))

const names = registered.tools.map((t) => t.name)
for (const expected of ['paper_to_md', 'paper_task_status', 'paper_list', 'paper_config_status']) {
  check(`tool ${expected}`, names.includes(expected), names.join(','))
}

const main = registered.tools.find((t) => t.name === 'paper_to_md')
const params = main?.parameters ?? {}
check('parameters compile to an object schema', params.type === 'object', JSON.stringify(Object.keys(params)))
check('paper_to_md requires source', (params.required ?? []).includes('source'), JSON.stringify(params.required))
check('source is a string parameter', params.properties?.source?.type === 'string', JSON.stringify(params.properties?.source))
check('model keeps its enum', JSON.stringify(params.properties?.model?.enum) === JSON.stringify(['vlm', 'pipeline', 'MinerU-HTML']), JSON.stringify(params.properties?.model))
check('paper_to_md declares an output renderer', typeof main?.output?.render === 'function')
check('paper_to_md has a generous timeout', (main?.timeoutMs ?? 0) >= 600_000, String(main?.timeoutMs))

const routes = registered.routes.map((r) => r.path).sort()
check('registers 4 loopback routes', routes.length === 4, routes.join(','))
check('status route path', routes.includes('/api/dsh-paper2md/status'), routes.join(','))
check('papers route path', routes.includes('/api/dsh-paper2md/papers'), routes.join(','))

check('registers one prompt section', registered.prompts.length === 1, String(registered.prompts.length))
check('prompt mentions paper_to_md', PAPER2MD_GUIDANCE.includes('paper_to_md'))
check('prompt tells the model to read markdownPath', PAPER2MD_GUIDANCE.includes('markdownPath'))

// Exercise a tool end to end (offline path).
const listTool = registered.tools.find((t) => t.name === 'paper_list')
const result = await listTool.execute({ limit: 3 }, {})
check('paper_list returns a json object', typeof result === 'object' && result !== null)
check('paper_list reports count', typeof result.count === 'number', JSON.stringify(result).slice(0, 160))

const configTool = registered.tools.find((t) => t.name === 'paper_config_status')
const cfg = await configTool.execute({}, {})
check('paper_config_status omits the token', cfg.token === undefined, Object.keys(cfg).join(','))
check('paper_config_status reports tokenConfigured', typeof cfg.tokenConfigured === 'boolean', String(cfg.tokenConfigured))

// The failure path must never throw out of a tool.
const bad = await main.execute({ source: 'C:/definitely/not/here.pdf' }, {})
check('missing file fails softly', bad.ok === false && typeof bad.error === 'string', JSON.stringify(bad).slice(0, 160))

// Argument validation must reject a call without the required source.
let rejected = false
try {
  await main.execute({}, {})
} catch (error) {
  rejected = error instanceof Error && error.message.includes('source')
}
check('missing source is rejected by validation', rejected)

// The papers route the settings page polls must answer on loopback.
const papersRoute = registered.routes.find((r) => r.path === '/api/dsh-paper2md/papers')
const res = {
  status: 0,
  body: '',
  writeHead(status) {
    this.status = status
  },
  end(body) {
    this.body = String(body)
  },
}
await papersRoute.handler(
  { method: 'GET', url: '/api/dsh-paper2md/papers?limit=3', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } },
  res,
)
const listing = JSON.parse(res.body || '{}')
check('papers route answers 200', res.status === 200, String(res.status))
check('papers route returns a listing', listing.ok === true && Array.isArray(listing.papers), res.body.slice(0, 120))

// The same route must refuse a non-loopback caller.
const denied = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = String(b) } }
await papersRoute.handler(
  { method: 'GET', url: '/api/dsh-paper2md/papers', socket: { remoteAddress: '10.0.0.9' }, headers: { host: '127.0.0.1:3080' } },
  denied,
)
check('papers route refuses remote callers', denied.status === 403, String(denied.status))

// Disposal must unmount everything.
for (const dispose of disposals) dispose()
check('disposing clears tools', registered.tools.length === 0, String(registered.tools.length))
check('disposing clears routes', registered.routes.length === 0, String(registered.routes.length))
check('disposing clears prompts', registered.prompts.length === 0, String(registered.prompts.length))

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — dry run ${failed === 0 ? 'clean' : `${failed} failed`}`)
process.exit(failed === 0 ? 0 : 1)
