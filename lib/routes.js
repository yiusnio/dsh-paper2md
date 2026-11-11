/**
 * The /api/dsh-paper2md route family: status, token save (validated with a
 * probe call before persisting), and token clear. Loopback-only, same fence
 * as dsh-notion — these endpoints write credentials.
 */

import { clearConfig, publicSettings, readConfig, writeConfig } from './config.js'
import { listPapers } from './core.js'

/** Route prefix. */
export const PAPER2MD_API_PREFIX = '/api/dsh-paper2md'

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Loopback literal + browser same-origin fence. */
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Write one JSON response. */
function writeJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

/** Read and parse a bounded JSON request body. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * Probe a token against the API: a 401/403 means bad credentials, anything
 * else (including a "task not found" code) means the token was accepted.
 */
async function probeToken(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/v4/extract/task/00000000-0000-0000-0000-000000000000`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
  })
  if (response.status === 401 || response.status === 403) return { valid: false, status: response.status }
  return { valid: true, status: response.status }
}

/** The settings route family. */
export function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: `${PAPER2MD_API_PREFIX}/status`,
      handler: async (req, res) => {
        if (req.method !== 'GET' || !isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        writeJson(res, 200, publicSettings())
      },
    },
    {
      kind: 'exact',
      path: `${PAPER2MD_API_PREFIX}/token`,
      handler: async (req, res) => {
        if (req.method !== 'POST' || !isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          writeJson(res, 400, { ok: false, error: '请求体无效' })
          return
        }
        const token = typeof body.token === 'string' ? body.token.trim() : ''
        const baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '' ? body.baseUrl.trim().replace(/\/+$/, '') : 'https://mineru.net'
        if (token === '') {
          writeJson(res, 400, { ok: false, error: 'token 不能为空' })
          return
        }
        try {
          const probe = await probeToken(baseUrl, token)
          if (!probe.valid) {
            writeJson(res, 200, { ok: false, error: `MinerU 拒绝该 token（HTTP ${probe.status}）` })
            return
          }
          const current = readConfig()
          writeConfig({ ...current, token, baseUrl })
          writeJson(res, 200, { ok: true, baseUrl, probeStatus: probe.status })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${PAPER2MD_API_PREFIX}/clear`,
      handler: async (req, res) => {
        if (req.method !== 'POST' || !isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        clearConfig()
        writeJson(res, 200, { ok: true })
      },
    },
    {
      kind: 'exact',
      path: `${PAPER2MD_API_PREFIX}/papers`,
      handler: async (req, res) => {
        if (req.method !== 'GET' || !isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        try {
          const url = new URL(req.url ?? '', 'http://127.0.0.1')
          const limit = Number(url.searchParams.get('limit') ?? 8)
          const query = url.searchParams.get('query') ?? undefined
          const listing = listPapers({ limit: Number.isFinite(limit) ? limit : 8, query })
          writeJson(res, 200, { ok: true, ...listing })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}
