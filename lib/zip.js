/**
 * Minimal ZIP reader (store + deflate only) — enough for MinerU result
 * archives and dependency-free on every platform Node runs on.
 */

import { inflateRawSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** Locate the End Of Central Directory record (scans back over the comment). */
function findEocd(buf) {
  if (buf.length < 22) throw new Error('zip: 文件太小，不是有效 zip')
  const floor = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  throw new Error('zip: 找不到 End Of Central Directory（响应可能不是 zip）')
}

/** List the central-directory entries of a zip buffer. */
export function listZipEntries(buf) {
  const eocd = findEocd(buf)
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || total === 0xffff) throw new Error('zip: 不支持 zip64')
  const entries = []
  let p = cdOffset
  const end = Math.min(buf.length, cdOffset + cdSize)
  for (let i = 0; i < total && p + 46 <= end; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, method, compSize, uncompSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Decompress one entry. */
function entryData(buf, entry) {
  const p = entry.localOffset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) throw new Error(`zip: 本地头损坏 (${entry.name})`)
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + entry.compSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`zip: 不支持的压缩方法 ${entry.method} (${entry.name})`)
}

/** Resolve an archive member path inside destDir, rejecting traversal. */
function safeTarget(root, name) {
  const cleaned = name.replace(/\\/g, '/').replace(/^\/+/, '')
  const rootAbs = resolve(root)
  const out = resolve(rootAbs, cleaned)
  if (out !== rootAbs && !out.startsWith(rootAbs + sep)) {
    throw new Error(`zip: 非法成员路径 ${name}`)
  }
  return out
}

/**
 * Extract a zip buffer under destDir.
 * `skip(name)` may veto individual members (used to drop the huge model JSON).
 * Returns the list of written members.
 */
export function extractZip(buf, destDir, options = {}) {
  const skip = typeof options.skip === 'function' ? options.skip : () => false
  const entries = listZipEntries(buf)
  mkdirSync(destDir, { recursive: true })
  const written = []
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    if (skip(entry.name)) continue
    const target = safeTarget(destDir, entry.name)
    mkdirSync(dirname(target), { recursive: true })
    const data = entryData(buf, entry)
    writeFileSync(target, data)
    written.push({ name: entry.name, size: data.length })
  }
  return written
}

/** Kept for callers that only want the member names. */
export function zipMemberNames(buf) {
  return listZipEntries(buf).map((e) => e.name)
}
