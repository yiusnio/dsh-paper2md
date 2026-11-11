/**
 * MinerU 精准解析 API (v4) client.
 *
 * Endpoints used:
 *   POST /api/v4/file-urls/batch            → batch_id + per-file upload URLs
 *   PUT  <upload url>                       → raw file body (no Content-Type)
 *   GET  /api/v4/extract-results/batch/:id  → { extract_result: [...] }
 *   POST /api/v4/extract/task               → { task_id }          (remote URL)
 *   GET  /api/v4/extract/task/:id           → { state, full_zip_url }
 *
 * Auth: `Authorization: Bearer <token>`. Every JSON reply carries
 * `code`/`msg`; code !== 0 is an API-level failure even on HTTP 200.
 */

/** Normalized MinerU failure. */
export class MineruError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'MineruError'
    this.code = options.code
    this.status = options.status
    this.traceId = options.traceId
    this.meta = options.meta
  }
}

/** One authenticated JSON call. */
async function call(settings, method, path, body, signal) {
  if (settings.token === '') {
    throw new MineruError(
      'MinerU 尚未配置 token：设置环境变量 MINERU_TOKEN，或写入 ' +
        '~/.dsh/paper2md.json（{"token":"..."}）。token 在 https://mineru.net/apiManage 创建。',
    )
  }
  const response = await fetch(settings.baseUrl + path, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${settings.token}`,
      'Content-Type': 'application/json',
      Accept: '*/*',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  if (text !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text.slice(0, 2000) }
    }
  }
  const apiCode = data !== null && typeof data === 'object' && typeof data.code === 'number' ? data.code : null
  // Two generations of the envelope are in the wild: {code, msg} and {success, msgCode, msg}.
  const apiFailed =
    data !== null &&
    typeof data === 'object' &&
    ((data.success === false) || (apiCode !== null && apiCode !== 0))
  if (!response.ok || apiFailed) {
    const msg =
      data !== null && typeof data.msg === 'string'
        ? data.msg
        : data !== null && typeof data.raw === 'string' && data.raw.trim() !== ''
          ? data.raw.trim().slice(0, 300)
          : `HTTP ${response.status}`
    const tag = apiCode !== null ? `code=${apiCode}` : typeof data?.msgCode === 'string' ? data.msgCode : ''
    throw new MineruError(`MinerU API 失败 [HTTP ${response.status}${tag === '' ? '' : ` ${tag}`}]: ${msg}`, {
      status: response.status,
      code: apiCode,
      traceId: data !== null && typeof data.trace_id === 'string' ? data.trace_id : undefined,
      meta: data,
    })
  }
  return data
}

/** Request one upload slot for a local file; returns { batchId, uploadUrl }. */
export async function requestUploadSlot(settings, file) {
  const data = await call(settings, 'POST', '/api/v4/file-urls/batch', {
    files: [file.spec],
    model_version: file.modelVersion,
    language: file.language,
    enable_formula: file.enableFormula !== false,
    enable_table: file.enableTable !== false,
  })
  const batchId = data?.data?.batch_id
  const urls = data?.data?.file_urls
  if (typeof batchId !== 'string' || !Array.isArray(urls) || typeof urls[0] !== 'string') {
    throw new MineruError('MinerU 未返回 batch_id / file_urls', { meta: data })
  }
  return { batchId, uploadUrl: urls[0] }
}

/** PUT the raw bytes to the presigned upload URL. */
export async function uploadBytes(uploadUrl, buffer, signal) {
  const response = await fetch(uploadUrl, { method: 'PUT', body: buffer, signal })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new MineruError(`上传失败 [HTTP ${response.status}] ${detail.slice(0, 300)}`, { status: response.status })
  }
}

/** Batch result snapshot. */
export async function getBatch(settings, batchId, signal) {
  const data = await call(settings, 'GET', `/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, undefined, signal)
  const raw = data?.data?.extract_result ?? data?.data?.extract_results ?? []
  const items = Array.isArray(raw) ? raw : [raw]
  return { items, meta: data?.data ?? null }
}

/** Create a task from a remote URL. */
export async function createUrlTask(settings, body) {
  const data = await call(settings, 'POST', '/api/v4/extract/task', body)
  const taskId = data?.data?.task_id
  if (typeof taskId !== 'string' || taskId === '') throw new MineruError('MinerU 未返回 task_id', { meta: data })
  return taskId
}

/** Single task snapshot. */
export async function getTask(settings, taskId, signal) {
  const data = await call(settings, 'GET', `/api/v4/extract/task/${encodeURIComponent(taskId)}`, undefined, signal)
  return data?.data ?? null
}

/** Download a result zip into memory. */
export async function downloadZip(url, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new MineruError(`下载结果包失败 [HTTP ${response.status}]`, { status: response.status })
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new MineruError('结果包为空')
  return buffer
}

/** Download an arbitrary remote file (fallback path for URL sources). */
export async function downloadFile(url, signal) {
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok) throw new MineruError(`下载源文件失败 [HTTP ${response.status}]`, { status: response.status })
  return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? '' }
}

/** Human-readable state summary for a batch/task item. */
export function describeState(item) {
  if (item === null || typeof item !== 'object') return 'unknown'
  const state = typeof item.state === 'string' ? item.state : 'unknown'
  const progress = item.extract_progress ?? item.extractProgress ?? null
  if (progress !== null && typeof progress === 'object') {
    const done = progress.extracted_pages ?? progress.extractedPages
    const total = progress.total_pages ?? progress.totalPages
    if (done !== undefined && total !== undefined) return `${state} (${done}/${total} 页)`
  }
  return state
}

/** Map an error to a friendly, actionable Chinese message. */
export function friendlyMineruError(error) {
  if (error instanceof MineruError) {
    const message = error.message || '未知错误'
    if (error.status === 401 || error.status === 403) return `MinerU token 无效或权限不足（${error.status}）：${message}`
    if (error.status === 429) return `MinerU 请求过于频繁（429）：${message}`
    if (error.meta !== null && typeof error.meta === 'object' && typeof error.meta.msg === 'string') return message
    return message
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return '请求超时（MinerU 或下载链路太慢）'
    const cause = error.cause
    if (cause !== undefined && cause !== null) return `${error.message}（${cause.code ?? cause.message ?? cause}）`
    return error.message
  }
  return String(error)
}
