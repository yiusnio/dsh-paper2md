/**
 * Browser-half dry run: loads the bundle through a fake __ModuleLoader__,
 * materializes the factory against a React stub, renders the settings page,
 * and walks the element tree. No browser, no network.
 * Run: node test/client-dryrun.mjs
 */

let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
}

await import('../lib/client.js')

let failed = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ''}`)
  }
}

console.log('dsh-paper2md client dry run')

/* ------------------------------------------------------- package manifest */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const clientExport = manifest.exports?.['./client']
check('manifest exports "./client"', typeof clientExport === 'string', String(clientExport))
check('the client export exists on disk', clientExport !== undefined && readFileSync(join(packageDir, clientExport), 'utf8').length > 0)
check('dsh.client.platform is web', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))
check('dsh.client.inject is a string array', Array.isArray(manifest.dsh?.client?.inject))
check('dsh.client.external is absent or a string array', manifest.dsh?.client?.external === undefined || Array.isArray(manifest.dsh.client.external), JSON.stringify(manifest.dsh?.client?.external))
check('bundle patch is declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml', String(manifest.dsh?.bundle?.patch))

check('bundle registers through __ModuleLoader__', registration !== null && registration.id === 'dsh-paper2md', registration?.id)
check('factory is a function', typeof registration?.factory === 'function')

/* ---------------------------------------------------------------- react stub */

let hookStates = []
let hookIndex = 0
let pendingEffects = []

function useState(initial) {
  const i = hookIndex++
  if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial
  return [
    hookStates[i],
    (value) => {
      hookStates[i] = typeof value === 'function' ? value(hookStates[i]) : value
    },
  ]
}
function useCallback(fn) {
  hookIndex += 1
  return fn
}
function useEffect(fn) {
  const i = hookIndex++
  if (!hookStates[i]) {
    hookStates[i] = true
    pendingEffects.push(fn)
  }
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState,
  useEffect,
  useCallback,
}

const exports_ = registration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})

check('exports inject=["slots"]', Array.isArray(exports_.inject) && exports_.inject.join() === 'slots', JSON.stringify(exports_.inject))
check('exports apply()', typeof exports_.apply === 'function')

/* ------------------------------------------------------------------ context */

let sectionSpec = null
let componentFactory = null
const ctx = {
  slots: {
    inject(name, fn) {
      check('injects into settings.section', name === 'settings.section', name)
      fn()
    },
    register(spec, factory) {
      sectionSpec = spec
      componentFactory = factory
    },
  },
}

exports_.apply(ctx)

check('registers a settings section', sectionSpec !== null && sectionSpec.name === 'settings.section')
check('section id is paper2md', sectionSpec?.id === 'paper2md', sectionSpec?.id)
check('section label is set', typeof sectionSpec?.label === 'string' && sectionSpec.label.length > 0, sectionSpec?.label)
check('section orders after notion', (sectionSpec?.order ?? 0) > 30, String(sectionSpec?.order))
check('register returns an element factory', typeof componentFactory === 'function')

/* --------------------------------------------------------------- fetch stub */

const calls = []
function json(value) {
  return { ok: true, status: 200, json: async () => value }
}
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body })
  if (String(url).endsWith('/status')) {
    return json({
      ok: true,
      baseUrl: 'https://mineru.net',
      outputDir: 'C:\\out\\papers',
      modelVersion: 'vlm',
      language: 'ch',
      pollTimeoutMs: 720000,
      keepJson: false,
      tokenConfigured: true,
      tokenSource: 'C:\\cfg\\paper2md.json',
      configPath: 'C:\\cfg\\paper2md.json',
      envTokenPresent: false,
    })
  }
  if (String(url).includes('/papers')) {
    return json({
      ok: true,
      papers: [
        { name: 'attention-abc', title: 'Attention Is All You Need', markdownPath: 'C:\\out\\papers\\attention-abc\\full.md', chars: 51000, convertedAt: '2026-11-11T10:20:00Z' },
      ],
    })
  }
  return json({ ok: true })
}

/* -------------------------------------------------------------- render tree */

function render() {
  hookIndex = 0
  pendingEffects = []
  const element = componentFactory()
  const tree = element.type(element.props)
  const effects = pendingEffects.slice()
  pendingEffects = []
  return { tree, effects }
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') return
  if (typeof node !== 'object') return
  visit(node)
  if (node.props !== undefined) walk(node.props.children, visit)
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (typeof node === 'object' && node.props !== undefined) collectText(node.props.children, out)
  return out
}

let { tree, effects } = render()
check('renders the page title', collectText(tree).includes('论文转 Markdown'), collectText(tree).slice(0, 6).join(' | '))

// The status + papers effects run once on mount.
for (const effect of effects) effect()
await new Promise((resolve) => setTimeout(resolve, 0))
;({ tree, effects } = render())

const text = collectText(tree)
check('status card shows configured', text.some((t) => t === '已配置 MinerU Key'), text.filter((t) => t.includes('配置')).join(' | '))
check('status card shows the token source', text.some((t) => t.startsWith('来源：')), text.filter((t) => t.startsWith('来源')).join(' | '))
check('converted papers are listed', text.includes('Attention Is All You Need'), text.filter((t) => t.includes('Attention')).join(' | '))
check('advanced section starts collapsed', !text.includes('单次等待上限'))

const buttons = []
walk(tree, (node) => {
  if (node.type === 'button') buttons.push(node)
})
const labels = buttons.map((b) => b.props.children)
check('has a save button', labels.includes('验证并保存'), labels.join(' / '))
check('has a clear button', labels.some((l) => String(l).includes('清除')), labels.join(' / '))

const inputs = []
walk(tree, (node) => {
  if (node.type === 'input') inputs.push(node)
})
const password = inputs.find((i) => i.props.type === 'password')
check('has a password input', password !== undefined, JSON.stringify(inputs.length))

// Type a key, re-render, then press save.
password.props.onChange({ target: { value: 'PROBE-KEY-123' } })
;({ tree } = render())
const saveButton = buttonsOf(tree).find((b) => b.props.children === '验证并保存')
check('save button found after typing', saveButton !== undefined)
saveButton?.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))

const tokenCall = calls.find((c) => c.url.endsWith('/token'))
check('save posts to /api/dsh-paper2md/token', tokenCall !== undefined, calls.map((c) => `${c.method} ${c.url}`).join(', '))
check('save posts the pasted key', tokenCall !== undefined && JSON.parse(tokenCall.body ?? '{}').token === 'PROBE-KEY-123', tokenCall?.body)

;({ tree } = render())
check('success message is shown', collectText(tree).some((t) => t.includes('已验证并保存')), collectText(tree).filter((t) => t.includes('保存')).join(' | '))

// Advanced pane reveals the read-only paths.
const advancedButton = buttonsOf(tree).find((b) => b.props.children === '高级设置')
advancedButton?.props.onClick()
;({ tree } = render())
const advancedText = collectText(tree)
check('advanced pane shows the output dir', advancedText.includes('C:\\out\\papers'), advancedText.filter((t) => t.includes('papers')).join(' | '))
check('advanced pane shows the model', advancedText.includes('vlm / ch'), advancedText.filter((t) => t.includes('vlm')).join(' | '))

function buttonsOf(node) {
  const out = []
  walk(node, (n) => {
    if (n.type === 'button') out.push(n)
  })
  return out
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — client dry run ${failed === 0 ? 'clean' : `${failed} failed`}`)
process.exit(failed === 0 ? 0 : 1)
