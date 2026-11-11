/**
 * Configuration for dsh-paper2md.
 *
 * Stored at ~/.dsh/paper2md.json (0600), same convention as dsh-notion.
 * Environment variables win over the file, so CI / one-off shells can override
 * without touching disk:
 *
 *   MINERU_TOKEN      MinerU API token (精准解析 API)
 *   MINERU_BASE_URL   API origin, default https://mineru.net
 *   PAPER2MD_DIR      output directory for converted papers
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default MinerU API origin. */
export const DEFAULT_BASE_URL = 'https://mineru.net'

/** Config file path. */
export const CONFIG_PATH = join(homedir(), '.dsh', 'paper2md.json')

/** Where converted papers land when nothing else is configured. */
export const DEFAULT_OUTPUT_DIR = join(homedir(), '.dsh', 'paper2md', 'papers')

/** Read the config file; any failure yields an empty object. */
export function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist the config file (0600, parent dir created). */
export function writeConfig(config) {
  mkdirSync(join(homedir(), '.dsh'), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
  chmodSync(CONFIG_PATH, 0o600)
}

/** Remove the config file (idempotent). */
export function clearConfig() {
  rmSync(CONFIG_PATH, { force: true })
}

/** Config file present on disk? */
export function configExists() {
  return existsSync(CONFIG_PATH)
}

/** Expand a leading `~` and make the path absolute. */
function expandHome(p) {
  const s = String(p ?? '').trim()
  if (s === '') return s
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2))
  return s
}

/** Effective runtime settings (env → file → defaults). */
export function resolveSettings() {
  const cfg = readConfig()
  const envToken = (process.env.MINERU_TOKEN ?? '').trim()
  const fileToken = typeof cfg.token === 'string' ? cfg.token.trim() : ''
  const baseUrl = (process.env.MINERU_BASE_URL ?? cfg.baseUrl ?? DEFAULT_BASE_URL).toString().trim().replace(/\/+$/, '')
  const outputDir = expandHome(process.env.PAPER2MD_DIR ?? cfg.outputDir ?? DEFAULT_OUTPUT_DIR)
  const pollTimeoutMs = Number.isFinite(Number(cfg.pollTimeoutMs)) ? Number(cfg.pollTimeoutMs) : 720_000
  return {
    token: envToken !== '' ? envToken : fileToken,
    tokenSource: envToken !== '' ? 'env:MINERU_TOKEN' : fileToken !== '' ? CONFIG_PATH : 'none',
    baseUrl: baseUrl === '' ? DEFAULT_BASE_URL : baseUrl,
    outputDir: outputDir === '' ? DEFAULT_OUTPUT_DIR : outputDir,
    modelVersion: typeof cfg.modelVersion === 'string' && cfg.modelVersion !== '' ? cfg.modelVersion : 'vlm',
    language: typeof cfg.language === 'string' && cfg.language !== '' ? cfg.language : 'ch',
    pollTimeoutMs: Math.min(Math.max(pollTimeoutMs, 30_000), 3_600_000),
    keepJson: cfg.keepJson === true,
  }
}

/** Redacted settings view for tools and the status route. */
export function publicSettings() {
  const s = resolveSettings()
  return {
    baseUrl: s.baseUrl,
    outputDir: s.outputDir,
    modelVersion: s.modelVersion,
    language: s.language,
    pollTimeoutMs: s.pollTimeoutMs,
    keepJson: s.keepJson,
    tokenConfigured: s.token !== '',
    tokenSource: s.tokenSource,
    configPath: CONFIG_PATH,
    envTokenPresent: (process.env.MINERU_TOKEN ?? '').trim() !== '',
  }
}
