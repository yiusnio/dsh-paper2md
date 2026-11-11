/**
 * Core pipeline: source normalization → cache lookup → MinerU submit → poll →
 * result zip → extract → summary.
 *
 * Two submission paths:
 *   local file  → ask for an upload slot, PUT the bytes, poll the batch
 *   remote URL  → create a task directly, poll the task (falling back to the
 *                 upload path when MinerU cannot fetch the URL)
 *
 * Every converted paper lives in its own directory:
 *   <outputDir>/<slug>-<hash8>/{full.md, images/, .meta.json}
 * and the directory doubles as the cache entry (sha256 of bytes + params).
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import * as mineru from './mineru.js'
import { resolveSettings } from './config.js'
import { extractZip } from './zip.js'

/** Pending-task records (tasks submitted with wait:false). */
const PENDING_DIR_NAME = '.pending'

/** Skip these archive members unless keepJson is set — they are huge and useless to the model. */
function shouldSkipMember(name, keepJson) {
  const lower = name.toLowerCase()
  if (keepJson) return false
  if (lower.endsWith('_middle.json') || lower.endsWith('_model.json')) return true
  if (lower.endsWith('layout.json') || lower.endsWith('_content_list.json')) return true
  return false
}

/** Sleep that aborts with the given signal. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Expand ~, resolve relative paths against the process cwd. */
export function expandPath(raw) {
  let s = String(raw ?? '').trim()
  if (s === '') return ''
  if (s === '~') return process.env.USERPROFILE ?? process.env.HOME ?? s
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    s = join(process.env.USERPROFILE ?? process.env.HOME ?? '', s.slice(2))
  }
  return s
}

/** True for http(s) sources. */
export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim())
}

/** Turn an arxiv abs/pdf landing page into a direct PDF URL. */
export function arxivPdfUrl(url) {
  const m = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\?[^#]*)?(?:#.*)?$/i.exec(url)
  if (m === null) return null
  let id = m[1].replace(/\.pdf$/i, '')
  if (!/^[\w.\-]+(\/\d+)?$/i.test(id)) return null
  return `https://arxiv.org/pdf/${id}.pdf`
}

/**
 * Normalize a user-supplied source into { kind, value, name }.
 * `value` is a remote URL or an absolute local path.
 */
export function normalizeSource(raw, signal) {
  const source = String(raw ?? '').trim()
  if (source === '') throw new Error('source 不能为空：请提供本地 PDF 路径或 http(s) 链接')
  if (isHttpUrl(source)) {
    const pdf = arxivPdfUrl(source)
    const finalUrl = pdf !== null ? pdf : source
    const tail = decodeURIComponent(finalUrl.split('/').pop() ?? 'paper')
    const name = tail === '' ? 'paper.pdf' : tail.includes('.') ? tail : `${tail}.pdf`
    return { kind: 'url', value: finalUrl, original: source, name }
  }
  const absolute = expandPath(source)
  if (!existsSync(absolute)) throw new Error(`本地文件不存在：${absolute}`)
  const stat = statSync(absolute)
  if (!stat.isFile()) throw new Error(`不是文件：${absolute}`)
  return { kind: 'file', value: absolute, original: source, name: basename(absolute), size: stat.size }
}

/** Filesystem-safe short slug for a title/filename. */
export function slugify(name) {
  const base = String(name ?? 'paper').replace(/\.[a-z0-9]{1,6}$/i, '')
  const cleaned = base
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return (cleaned === '' ? 'paper' : cleaned).slice(0, 80)
}

/** Build the cache key: content (or URL) plus every parameter that changes output. */
export function cacheKey(parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(String(part ?? ''))
  return hash.digest('hex')
}

/** Read the source bytes for hashing/uploading. */
function readSourceBytes(path) {
  const stat = statSync(path)
  if (stat.size > 300 * 1024 * 1024) throw new Error(`文件过大（${(stat.size / 1048576).toFixed(1)} MB），MinerU 上限 200 MB`)
  return readFileSync(path)
}

/** Locate the markdown produced by MinerU inside an extracted directory. */
function findMarkdown(dir) {
  const rootFull = join(dir, 'full.md')
  if (existsSync(rootFull)) return rootFull
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true })
  const md = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .sort((a, b) => statSync(b).size - statSync(a).size)
  return md[0] ?? null
}

/** Count images referenced by the markdown. */
function countImages(markdown) {
  const matches = markdown.match(/!\[[^\]]*\]\([^)]+\)/g)
  return matches === null ? 0 : matches.length
}

/** Title from the first ATX heading, falling back to the file name. */
function extractTitle(markdown, fallback) {
  const line = markdown.split(/\r?\n/).find((l) => /^#{1,3}\s+\S/.test(l.trim()))
  if (line === undefined) return fallback
  return line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim().slice(0, 200) || fallback
}

/** Build the model-facing summary of one converted paper. */
function summarize(dir, markdownPath, meta) {
  const markdown = readFileSync(markdownPath, 'utf8')
  const lines = markdown.split(/\r?\n/).length
  const headings = (markdown.match(/^#{1,6}\s+\S/gm) ?? []).length
  const images = countImages(markdown)
  const title = extractTitle(markdown, meta.name ?? 'paper')
  return {
    ok: true,
    title,
    markdownPath,
    dir,
    chars: markdown.length,
    lines,
    headings,
    images,
    preview: markdown.slice(0, 1200),
    meta,
  }
}

/** Write the per-paper metadata record. */
function writeMeta(dir, meta) {
  writeFileSync(join(dir, '.meta.json'), JSON.stringify(meta, null, 2), 'utf8')
}

/** Read the metadata record of a converted directory. */
export function readMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, '.meta.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Pending-task record path. */
function pendingPath(settings, id) {
  return join(settings.outputDir, PENDING_DIR_NAME, `${id}.json`)
}

/** Persist a pending record so paper_task_status can finish the job later. */
function writePending(settings, record) {
  const path = pendingPath(settings, record.id)
  mkdirSync(join(settings.outputDir, PENDING_DIR_NAME), { recursive: true })
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf8')
  return path
}

/** Load a pending record. */
export function readPending(settings, id) {
  try {
    return JSON.parse(readFileSync(pendingPath(settings, id), 'utf8'))
  } catch {
    return null
  }
}

/** Drop a pending record once its paper is on disk. */
function clearPending(settings, id) {
  try {
    rmSync(pendingPath(settings, id), { force: true })
  } catch {
    /* best effort */
  }
}

/** Poll the batch endpoint until the only file settles or the deadline passes. */
async function pollBatch(settings, batchId, options) {
  const deadline = Date.now() + options.timeoutMs
  let interval = 2000
  for (;;) {
    const { items } = await mineru.getBatch(settings, batchId, options.signal)
    const item = items[0] ?? {}
    const state = typeof item.state === 'string' ? item.state : 'unknown'
    if (options.onTick !== undefined) options.onTick({ state, item })
    if (state === 'done') {
      const url = item.full_zip_url ?? item.fullZipUrl
      if (typeof url !== 'string' || url === '') throw new Error('MinerU 状态为 done 但未返回 full_zip_url')
      return { done: true, zipUrl: url, item }
    }
    if (state === 'failed') {
      throw new Error(`MinerU 解析失败：${item.err_msg ?? item.errMsg ?? '未知原因'}`)
    }
    if (Date.now() >= deadline) return { done: false, state, item, batchId, kind: 'batch' }
    await sleep(Math.min(interval, Math.max(1000, deadline - Date.now())), options.signal)
    interval = Math.min(interval + 1500, 8000)
  }
}

/** Poll the single-task endpoint until it settles or the deadline passes. */
async function pollTask(settings, taskId, options) {
  const deadline = Date.now() + options.timeoutMs
  let interval = 2000
  for (;;) {
    const data = await mineru.getTask(settings, taskId, options.signal)
    const state = data !== null && typeof data === 'object' && typeof data.state === 'string' ? data.state : 'unknown'
    if (options.onTick !== undefined) options.onTick({ state, item: data })
    if (state === 'done') {
      const url = data.full_zip_url ?? data.fullZipUrl
      if (typeof url !== 'string' || url === '') throw new Error('MinerU 状态为 done 但未返回 full_zip_url')
      return { done: true, zipUrl: url, item: data }
    }
    if (state === 'failed') throw new Error(`MinerU 解析失败：${data.err_msg ?? data.errMsg ?? '未知原因'}`)
    if (Date.now() >= deadline) return { done: false, state, item: data, taskId, kind: 'task' }
    await sleep(Math.min(interval, Math.max(1000, deadline - Date.now())), options.signal)
    interval = Math.min(interval + 1500, 8000)
  }
}

/** Download → extract → write meta → summarize. */
async function materialize(settings, zipUrl, destDir, meta, signal) {
  const buffer = await mineru.downloadZip(zipUrl, signal)
  mkdirSync(destDir, { recursive: true })
  const members = extractZip(buffer, destDir, { skip: (name) => shouldSkipMember(name, settings.keepJson) })
  const markdownPath = findMarkdown(destDir)
  if (markdownPath === null) {
    throw new Error(`结果包中没有 Markdown 文件（成员：${members.slice(0, 8).map((m) => m.name).join(', ')}…）`)
  }
  writeMeta(destDir, { ...meta, bytes: buffer.length, members: members.length, convertedAt: new Date().toISOString() })
  return summarize(destDir, markdownPath, { ...meta, bytes: buffer.length })
}

/**
 * Convert one paper to Markdown.
 *
 * options:
 *   source            local path | http(s) URL | arxiv abs/pdf URL
 *   model             pipeline | vlm | MinerU-HTML
 *   language          MinerU language hint (default ch)
 *   pageRanges        "1-20" / "2,4-6"
 *   isOcr             force OCR
 *   enableFormula     default true
 *   enableTable       default true
 *   outputName        directory slug override
 *   force             bypass cache
 *   wait              default true; false returns a pending task record
 *   timeoutMs         poll budget for this call
 *   signal            AbortSignal
 *   onTick            progress callback
 */
export async function convertPaper(options) {
  const settings = resolveSettings()
  const started = Date.now()
  const src = normalizeSource(options.source, options.signal)
  const model = options.model ?? settings.modelVersion
  const language = options.language ?? settings.language
  const pageRanges = options.pageRanges ?? ''
  const isOcr = options.isOcr
  const enableFormula = options.enableFormula !== false
  const enableTable = options.enableTable !== false
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs ?? settings.pollTimeoutMs), 10_000), 3_600_000)

  // Cache key: bytes for local files, URL for remote ones, plus every knob.
  let keyParts
  let buffer = null
  if (src.kind === 'file') {
    buffer = readSourceBytes(src.value)
    keyParts = [createHash('sha256').update(buffer).digest('hex'), model, language, pageRanges, String(isOcr), String(enableFormula), String(enableTable)]
  } else {
    keyParts = ['url', src.value, model, language, pageRanges, String(isOcr), String(enableFormula), String(enableTable)]
  }
  const key = cacheKey(keyParts)
  const slug = slugify(options.outputName ?? src.name)
  const destDir = join(settings.outputDir, `${slug}-${key.slice(0, 8)}`)
  const markdownPath = join(destDir, 'full.md')

  if (options.force !== true && existsSync(markdownPath)) {
    const meta = readMeta(destDir) ?? { source: src.value, name: src.name, model, cached: true }
    const summary = summarize(destDir, markdownPath, meta)
    return { ...summary, cached: true, elapsedMs: Date.now() - started, kind: src.kind, source: src.value }
  }

  mkdirSync(destDir, { recursive: true })
  const baseMeta = {
    source: src.kind === 'file' ? src.value : src.original,
    resolvedSource: src.value,
    sourceKind: src.kind,
    name: src.name,
    model,
    language,
    pageRanges,
    isOcr: isOcr ?? false,
    key: key.slice(0, 16),
  }

  const submitLocal = async () => {
    if (buffer === null) buffer = readSourceBytes(src.value)
    const { batchId, uploadUrl } = await mineru.requestUploadSlot(settings, {
      spec: {
        name: src.name,
        data_id: `p2m${key.slice(0, 12)}`,
        ...(pageRanges === '' ? {} : { page_ranges: pageRanges }),
        ...(typeof isOcr === 'boolean' ? { is_ocr: isOcr } : {}),
      },
      modelVersion: model,
      language,
      enableFormula,
      enableTable,
    })
    await mineru.uploadBytes(uploadUrl, buffer, options.signal)
    return { kind: 'batch', id: batchId }
  }

  const submitRemote = async () => {
    const taskId = await mineru.createUrlTask(settings, {
      url: src.value,
      model_version: model,
      language,
      enable_formula: enableFormula,
      enable_table: enableTable,
      ...(pageRanges === '' ? {} : { page_ranges: pageRanges }),
      ...(typeof isOcr === 'boolean' ? { is_ocr: isOcr } : {}),
    })
    return { kind: 'task', id: taskId }
  }

  let submitted = src.kind === 'file' ? await submitLocal() : await submitRemote()
  const pendingRecord = {
    id: submitted.id,
    kind: submitted.kind,
    destDir,
    slug,
    createdAt: new Date().toISOString(),
    meta: baseMeta,
    source: options.source,
    timeoutMs,
  }
  writePending(settings, pendingRecord)

  if (options.wait === false) {
    return {
      ok: true,
      pending: true,
      kind: submitted.kind,
      id: submitted.id,
      destDir,
      message: `任务已提交（${submitted.kind}=${submitted.id}）。稍后用 paper_task_status 传入同一个 kind/id 收取结果。`,
      elapsedMs: Date.now() - started,
    }
  }

  const deadlineOptions = { timeoutMs, signal: options.signal, onTick: options.onTick }
  let settled
  try {
    settled = submitted.kind === 'batch' ? await pollBatch(settings, submitted.id, deadlineOptions) : await pollTask(settings, submitted.id, deadlineOptions)
  } catch (error) {
    // A URL MinerU could not fetch: fall back to uploading the bytes ourselves.
    const message = error instanceof Error ? error.message : String(error)
    const urlUnreachable = src.kind === 'url' && /fail|timeout|超时|失败|url|下载/i.test(message)
    if (!urlUnreachable) throw error
    const downloaded = await mineru.downloadFile(src.value, options.signal)
    buffer = downloaded.buffer
    src.kind = 'file'
    const local = await submitLocal()
    submitted = local
    writePending(settings, { ...pendingRecord, id: local.id, kind: local.kind, fallback: true })
    settled = await pollBatch(settings, local.id, deadlineOptions)
  }

  if (settled.done !== true) {
    return {
      ok: false,
      pending: true,
      kind: settled.kind,
      id: settled.kind === 'batch' ? settled.batchId : settled.taskId,
      state: settled.state,
      destDir,
      message: `等待超时，任务仍在解析（state=${settled.state}）。用 paper_task_status 收取结果，不会重复扣额度。`,
      elapsedMs: Date.now() - started,
    }
  }

  const summary = await materialize(settings, settled.zipUrl, destDir, baseMeta, options.signal)
  clearPending(settings, submitted.id)
  return {
    ...summary,
    cached: false,
    kind: src.kind,
    source: src.kind === 'file' ? src.value : src.original,
    task: { kind: submitted.kind, id: submitted.id },
    elapsedMs: Date.now() - started,
  }
}

/**
 * Resume a task submitted earlier (wait:false or a poll timeout):
 * poll once more, and when it is done download + extract into the recorded dir.
 */
export async function resumeTask(options) {
  const settings = resolveSettings()
  const id = String(options.id ?? '').trim()
  if (id === '') throw new Error('id 不能为空：请传入 paper_to_md 返回的 task/batch id')
  const record = readPending(settings, id)
  const kind = options.kind ?? record?.kind ?? (/^[0-9a-f-]{36}$/i.test(id) ? 'task' : 'batch')
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs ?? settings.pollTimeoutMs), 5_000), 3_600_000)
  const destDir = record?.destDir ?? join(settings.outputDir, `${slugify(options.outputName ?? record?.slug ?? id)}-${id.replace(/-/g, '').slice(0, 8)}`)
  const meta = record?.meta ?? { source: record?.source ?? '', id }

  const existing = join(destDir, 'full.md')
  if (existsSync(existing) && options.force !== true) {
    const stored = readMeta(destDir) ?? meta
    return { ...summarize(destDir, existing, stored), cached: true, kind, id }
  }

  mkdirSync(destDir, { recursive: true })
  const pollOptions = { timeoutMs, signal: options.signal, onTick: options.onTick }
  const settled = kind === 'batch' ? await pollBatch(settings, id, pollOptions) : await pollTask(settings, id, pollOptions)
  if (settled.done !== true) {
    return {
      ok: false,
      pending: true,
      kind,
      id,
      state: settled.state,
      destDir,
      message: `仍在解析（state=${settled.state}），稍后再试。`,
    }
  }
  const summary = await materialize(settings, settled.zipUrl, destDir, meta, options.signal)
  clearPending(settings, id)
  return { ...summary, cached: false, kind, id }
}

/** List converted papers (newest first). */
export function listPapers(options = {}) {
  const settings = resolveSettings()
  const limit = Math.min(Math.max(Number(options.limit ?? 20), 1), 200)
  const query = String(options.query ?? '').toLowerCase()
  let entries
  try {
    entries = readdirSync(settings.outputDir, { withFileTypes: true })
  } catch {
    return { ok: true, outputDir: settings.outputDir, count: 0, papers: [], note: '尚无转换记录' }
  }
  const papers = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === PENDING_DIR_NAME) continue
    const dir = join(settings.outputDir, entry.name)
    const md = join(dir, 'full.md')
    if (!existsSync(md)) continue
    const meta = readMeta(dir) ?? {}
    const stat = statSync(md)
    const title = meta.title ?? null
    const haystack = `${entry.name} ${meta.source ?? ''} ${title ?? ''}`.toLowerCase()
    if (query !== '' && !haystack.includes(query)) continue
    papers.push({
      dir,
      markdownPath: md,
      name: entry.name,
      title,
      source: meta.source ?? null,
      model: meta.model ?? null,
      chars: meta.chars ?? stat.size,
      convertedAt: meta.convertedAt ?? stat.mtime.toISOString(),
    })
  }
  papers.sort((a, b) => String(b.convertedAt).localeCompare(String(a.convertedAt)))
  return { ok: true, outputDir: settings.outputDir, count: papers.length, papers: papers.slice(0, limit) }
}
