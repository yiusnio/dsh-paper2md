/**
 * Agent tools for dsh-paper2md.
 *
 * paper_to_md           — the main entry: paper (local PDF / URL / arxiv) → Markdown
 * paper_task_status     — collect a task submitted with wait:false or one that timed out
 * paper_list            — list already converted papers (cache index)
 * paper_config_status   — where the token/dirs come from, without leaking the token
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { convertPaper, resumeTask, listPapers } from './core.js'
import { friendlyMineruError } from './mineru.js'
import { publicSettings } from './config.js'

/** One text content block. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** JSON render shared by every tool output. */
function renderJson(_args, value) {
  return text(JSON.stringify(value, null, 2))
}

/** Wrap a failure into a model-readable object instead of throwing raw. */
function failure(error, extra = {}) {
  return { ok: false, error: friendlyMineruError(error), ...extra }
}

/** The main conversion tool. */
export function paperToMdTool() {
  return defineTool({
    name: 'paper_to_md',
    description:
      '把论文/PDF 转成 Markdown（MinerU 高保真解析：标题层级、表格转 HTML、公式转 LaTeX、图片落盘），返回本地 md 路径与预览。' +
      '支持本地文件路径、http(s) 直链、arXiv abs/pdf 链接；同一文件+参数命中本地缓存时秒返回。' +
      '阅读任何论文前先调用本工具，再用 read 读取返回的 markdownPath，不要直接读 PDF。' +
      'Triggers: 读论文, 看论文, 这篇 paper, arXiv, PDF, 转 md, 转 markdown, paper_to_md.',
    parameters: {
      source: { type: 'string', required: true, description: '本地 PDF/文档路径，或 http(s) 链接，或 arXiv abs/pdf 链接' },
      model: { type: 'string', enum: ['vlm', 'pipeline', 'MinerU-HTML'], description: '解析模型，默认 vlm（推荐，版式与表格更准）；pipeline 更快更省' },
      language: { type: 'string', description: '文档语言提示，默认 ch；英文论文可用 en' },
      pageRanges: { type: 'string', description: '只转指定页，如 "1-20" 或 "2,4-6"，省额度' },
      isOcr: { type: 'boolean', description: '强制 OCR（扫描件/图片型 PDF 用）' },
      enableFormula: { type: 'boolean', description: '公式识别，默认 true' },
      enableTable: { type: 'boolean', description: '表格识别，默认 true' },
      outputName: { type: 'string', description: '自定义输出目录名（默认取文件名）' },
      force: { type: 'boolean', description: '忽略缓存重新解析' },
      wait: { type: 'boolean', description: '默认 true 阻塞等结果；false 只提交任务并返回 id，之后用 paper_task_status 收取' },
      timeoutMs: { type: 'integer', description: '本次调用的等待预算（毫秒），默认取配置 pollTimeoutMs' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: 900_000,
    async execute(args, context) {
      try {
        return await convertPaper({
          source: args.source,
          model: args.model,
          language: args.language,
          pageRanges: args.pageRanges,
          isOcr: args.isOcr,
          enableFormula: args.enableFormula,
          enableTable: args.enableTable,
          outputName: args.outputName,
          force: args.force === true,
          wait: args.wait !== false,
          timeoutMs: args.timeoutMs,
          signal: context?.signal,
        })
      } catch (error) {
        return failure(error, { source: args.source })
      }
    },
  })
}

/** Resume / collect a submitted task. */
export function paperTaskStatusTool() {
  return defineTool({
    name: 'paper_task_status',
    description:
      '查询并收取 paper_to_md 提交的 MinerU 任务：已完成则下载结果包、解压出 Markdown 并返回路径；仍在解析则返回当前进度。' +
      'kind 与 id 直接用 paper_to_md 返回值里的 task.kind / task.id（或 pending 返回的 kind/id）。' +
      'Triggers: 论文转换好了吗, 收取解析结果, paper_task_status.',
    parameters: {
      id: { type: 'string', required: true, description: 'paper_to_md 返回的 task_id 或 batch_id' },
      kind: { type: 'string', enum: ['task', 'batch'], description: '任务类型：远程 URL 任务为 task，本地上传为 batch；省略则自动推断' },
      outputName: { type: 'string', description: '输出目录名（任务记录丢失时使用）' },
      force: { type: 'boolean', description: '已有 md 也重新下载解压（默认 false）' },
      timeoutMs: { type: 'integer', description: '本次等待预算（毫秒）' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: 900_000,
    async execute(args, context) {
      try {
        return await resumeTask({
          id: args.id,
          kind: args.kind,
          outputName: args.outputName,
          force: args.force === true,
          timeoutMs: args.timeoutMs,
          signal: context?.signal,
        })
      } catch (error) {
        return failure(error, { id: args.id })
      }
    },
  })
}

/** List converted papers. */
export function paperListTool() {
  return defineTool({
    name: 'paper_list',
    description:
      '列出已转换好的论文（本地缓存索引），含 md 路径、来源、模型与转换时间。想先看看某篇论文是否已经转过时用它，避免重复消耗额度。' +
      'Triggers: 已转换的论文, 论文缓存, paper_list.',
    parameters: {
      query: { type: 'string', description: '按目录名/来源/标题过滤的关键词' },
      limit: { type: 'integer', description: '返回条数上限，默认 20' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: 20_000,
    async execute(args) {
      try {
        return listPapers({ query: args.query, limit: args.limit })
      } catch (error) {
        return failure(error)
      }
    },
  })
}

/** Configuration status (never returns the token). */
export function paperConfigStatusTool() {
  return defineTool({
    name: 'paper_config_status',
    description:
      '查看 dsh-paper2md 的配置状态：MinerU token 是否已配置及其来源、API 地址、输出目录、默认模型与语言。token 本身不会返回。' +
      'Triggers: 论文插件配置, MinerU token 配好了吗, paper_config_status.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: 10_000,
    async execute() {
      try {
        const settings = publicSettings()
        return {
          ok: true,
          ...settings,
          hint:
            settings.tokenConfigured
              ? 'token 已配置，可直接调用 paper_to_md。'
              : 'token 未配置：设置环境变量 MINERU_TOKEN，或写入 ~/.dsh/paper2md.json 的 {"token":"..."}（token 在 https://mineru.net/apiManage 创建）。',
        }
      } catch (error) {
        return failure(error)
      }
    },
  })
}

/** All tools, ready for ctx.tools.register. */
export function paperTools() {
  return [paperToMdTool(), paperTaskStatusTool(), paperListTool(), paperConfigStatusTool()]
}

export { failure, renderJson, text }
