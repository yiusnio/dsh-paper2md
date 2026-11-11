/**
 * dsh-paper2md — host half.
 *
 * Mounts the MinerU-backed paper→Markdown tools, the /api/dsh-paper2md route
 * family, and a system-prompt section that makes "read a paper" resolve to
 * "convert it to Markdown first, then read the Markdown".
 */

import { makeRoutes } from './routes.js'
import { paperTools } from './tools.js'

/** Stable cordis plugin name. */
export const name = 'paper2md'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 151

/** Model-facing announcement: when to call it, what it returns, how to cache. */
export const PAPER2MD_GUIDANCE =
  '本机已安装 dsh-paper2md 插件（论文 PDF → Markdown，MinerU 高保真解析）。' +
  '当需要阅读论文、PDF 文档、arXiv 页面或任何 pdf 链接时，第一步调用 paper_to_md（source 传本地路径 / http(s) 链接 / arXiv abs 链接），' +
  '它会把文件转成 Markdown（标题层级、表格转 HTML、公式转 LaTeX、图片落盘）并返回本地 markdownPath 与前 1200 字预览；' +
  '随后用 read 工具按 offset/limit 读取该 markdownPath，不要直接对 PDF 调用 read。' +
  '同一文件 + 相同参数会命中 sha256 缓存，重复调用零开销；想先确认是否已经转过可用 paper_list。' +
  '一次解析通常 30 秒到数分钟，工具会自行等待；若返回 pending 或等待超时，用返回值里的 task.kind / task.id 调用 paper_task_status 继续收取，不会重复扣额度。' +
  'token 配置可用 paper_config_status 查看，或用环境变量 MINERU_TOKEN / ~/.dsh/paper2md.json 设置。'

/** Mount the paper2md surfaces. */
export function apply(ctx) {
  ctx.effect(
    () => {
      const disposers = paperTools().map((tool) => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-paper2md: tools',
  )

  ctx.effect(
    () => {
      const disposers = makeRoutes().map((route) => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-paper2md: routes',
  )

  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'plugin:dsh-paper2md', order: SECTION_ORDER, text: PAPER2MD_GUIDANCE }),
    'dsh-paper2md: announcement',
  )
}
