/**
 * dsh-paper2md — browser half.
 *
 * Registers the "论文转 Markdown" page into the additive `settings.section`
 * list slot. Every value comes from the loopback-fenced /api/dsh-paper2md
 * routes on the host; the token never travels back to the browser.
 *
 * Bundle form: dsh's client module system is a lazy CJS table, so this file
 * registers a factory through `window.__ModuleLoader__.load` and pulls React
 * from the platform seed table. Plain JS — no JSX, no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-paper2md',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Host route prefix (see lib/routes.js). */
    const API = '/api/dsh-paper2md'

    /** Accent colors; everything else inherits the shell theme. */
    const ACCENT = { ok: '#22c55e', err: '#ef4444', primary: '#2563eb', warn: '#f59e0b' }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, lineHeight: 1.55, padding: '4px 2px', maxWidth: 760 },
      head: { display: 'flex', flexDirection: 'column', gap: 2 },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      sub: { opacity: 0.72, fontSize: 12 },
      card: { border: '1px solid rgba(127,127,127,.22)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
      statusRow: { display: 'flex', alignItems: 'center', gap: 10 },
      dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto' },
      statusText: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 },
      statusName: { fontWeight: 600 },
      statusMeta: { fontSize: 12, opacity: 0.7, wordBreak: 'break-all' },
      label: { fontSize: 12, fontWeight: 600, opacity: 0.85 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 220 },
      input: {
        padding: '6px 9px',
        borderRadius: 7,
        border: '1px solid rgba(127,127,127,.35)',
        background: 'rgba(127,127,127,.08)',
        color: 'inherit',
        font: 'inherit',
      },
      button: {
        padding: '5px 12px',
        borderRadius: 7,
        border: '1px solid rgba(127,127,127,.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        padding: '5px 12px',
        borderRadius: 7,
        border: `1px solid ${ACCENT.primary}`,
        background: ACCENT.primary,
        color: '#fff',
        font: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonTiny: {
        padding: '2px 8px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.3)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      disabled: { opacity: 0.5, cursor: 'default' },
      ok: { color: ACCENT.ok },
      err: { color: ACCENT.err },
      warn: { color: ACCENT.warn },
      hint: { fontSize: 12, opacity: 0.72, display: 'flex', flexDirection: 'column', gap: 3 },
      hintP: { margin: 0 },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11.5,
        background: 'rgba(127,127,127,.14)',
        padding: '1px 5px',
        borderRadius: 4,
        wordBreak: 'break-all',
      },
      grid: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', alignItems: 'center' },
      gridKey: { fontSize: 12, opacity: 0.7 },
      sectionRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
      sectionTitle: { fontSize: 12, fontWeight: 600, opacity: 0.85 },
      paperList: { display: 'flex', flexDirection: 'column', gap: 6 },
      paperRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        borderRadius: 7,
        background: 'rgba(127,127,127,.08)',
      },
      paperName: { flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      empty: { fontSize: 12, opacity: 0.6 },
      link: { color: ACCENT.primary, textDecoration: 'none' },
    }

    /** Fetch one JSON route (POST when a body is given). */
    async function api(path, body) {
      const response = await fetch(API + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /** Where the effective token comes from, in one short line. */
    function sourceLabel(status) {
      if (status === null) return '读取中…'
      if (status.tokenConfigured !== true) return '未配置'
      if (status.tokenSource === 'env:MINERU_TOKEN') return '环境变量 MINERU_TOKEN'
      return status.configPath ?? '配置文件'
    }

    /** "12 分钟" from milliseconds. */
    function minutes(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value)) return '—'
      return value >= 60_000 ? `${Math.round(value / 60_000)} 分钟` : `${Math.round(value / 1000)} 秒`
    }

    /** ISO timestamp → local "MM-DD HH:mm". */
    function shortTime(iso) {
      if (typeof iso !== 'string') return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return iso
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** Thousands separator for character counts. */
    function prettyInt(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      return n.toLocaleString('en-US')
    }

    /** The settings page. */
    function Paper2MdSettings() {
      const [status, setStatus] = useState(null)
      const [papers, setPapers] = useState(null)
      const [token, setToken] = useState('')
      const [baseUrl, setBaseUrl] = useState('')
      const [advanced, setAdvanced] = useState(false)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [copied, setCopied] = useState('')

      const notify = useCallback((kind, text) => {
        setMessage({ kind, text })
      }, [])

      const refresh = useCallback(() => {
        api('/status')
          .then((next) => {
            setStatus(next)
            if (typeof next.baseUrl === 'string') setBaseUrl(next.baseUrl)
          })
          .catch((error) => notify('err', `读取配置失败：${error.message}`))
        api('/papers')
          .then((listing) => setPapers(Array.isArray(listing.papers) ? listing.papers : []))
          .catch(() => setPapers([]))
      }, [notify])

      useEffect(() => {
        refresh()
      }, [refresh])

      const save = useCallback(() => {
        const value = token.trim()
        if (value === '') {
          notify('err', '请先粘贴 MinerU API Key')
          return
        }
        setBusy(true)
        setMessage(null)
        const payload = { token: value }
        if (baseUrl.trim() !== '') payload.baseUrl = baseUrl.trim()
        api('/token', payload)
          .then((result) => {
            if (result.ok === true) {
              setToken('')
              notify('ok', '已验证并保存，立即生效，无需重启')
              refresh()
            } else {
              notify('err', result.error ?? '保存失败')
            }
          })
          .catch((error) => notify('err', `保存失败：${error.message}`))
          .finally(() => setBusy(false))
      }, [token, baseUrl, notify, refresh])

      const clear = useCallback(() => {
        setBusy(true)
        api('/clear', {})
          .then(() => {
            notify('ok', '已清除配置文件中保存的 Key')
            refresh()
          })
          .catch((error) => notify('err', `清除失败：${error.message}`))
          .finally(() => setBusy(false))
      }, [notify, refresh])

      const copyPath = useCallback((value) => {
        const done = () => {
          setCopied(value)
          setTimeout(() => setCopied(''), 1500)
        }
        if (navigator.clipboard?.writeText !== undefined) navigator.clipboard.writeText(value).then(done, () => done())
        else done()
      }, [])

      const configured = status !== null && status.tokenConfigured === true
      const envLocked = status !== null && status.envTokenPresent === true
      const list = papers ?? []

      return h(
        'div',
        { style: styles.page },

        h(
          'div',
          { style: styles.head },
          h('h2', { style: styles.title }, '论文转 Markdown'),
          h('p', { style: styles.sub }, 'MinerU 高保真解析 PDF / arXiv：标题层级、表格转 HTML、公式转 LaTeX、图片落盘。AI 读论文前会先调用它。'),
        ),

        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.statusRow },
            h('span', { style: { ...styles.dot, background: configured ? ACCENT.ok : ACCENT.err, boxShadow: `0 0 0 3px ${configured ? 'rgba(34,197,94,.18)' : 'rgba(239,68,68,.18)'}` } }),
            h(
              'div',
              { style: styles.statusText },
              h('span', { style: styles.statusName }, configured ? '已配置 MinerU Key' : '未配置 MinerU Key'),
              h('span', { style: styles.statusMeta }, `来源：${sourceLabel(status)}`),
            ),
            h('button', { style: busy ? { ...styles.buttonTiny, ...styles.disabled } : styles.buttonTiny, disabled: busy, onClick: refresh }, '刷新'),
          ),

          h(
            'div',
            { style: styles.row },
            h('input', {
              style: { ...styles.input, ...styles.grow },
              type: 'password',
              placeholder: '粘贴 MinerU API Key（eyJ…）',
              value: token,
              spellCheck: false,
              autoComplete: 'off',
              onKeyDown: (event) => {
                if (event.key === 'Enter') save()
              },
              onChange: (event) => setToken(event.target.value),
            }),
            h('button', { style: busy ? { ...styles.buttonPrimary, ...styles.disabled } : styles.buttonPrimary, disabled: busy, onClick: save }, busy ? '验证中…' : '验证并保存'),
          ),

          h(
            'div',
            { style: styles.row },
            h('button', { style: busy ? { ...styles.button, ...styles.disabled } : styles.button, disabled: busy, onClick: clear }, '清除已保存的 Key'),
            h('button', { style: styles.button, onClick: () => setAdvanced(!advanced) }, advanced ? '收起高级设置' : '高级设置'),
            h(
              'span',
              { style: styles.hint },
              h('a', { style: styles.link, href: 'https://mineru.net/apiManage', target: '_blank', rel: 'noreferrer' }, 'mineru.net/apiManage'),
              ' 创建 Key',
            ),
          ),

          envLocked
            ? h('div', { style: { ...styles.hint, ...styles.warn } }, '当前进程已从环境变量 MINERU_TOKEN 读到 Key，环境变量优先级更高；在界面上保存不会覆盖它，需要先取消该环境变量。')
            : null,

          advanced
            ? h(
                'div',
                { style: styles.card },
                h('div', { style: styles.label }, 'Base URL'),
                h('input', {
                  style: { ...styles.input },
                  value: baseUrl,
                  spellCheck: false,
                  placeholder: 'https://mineru.net',
                  onChange: (event) => setBaseUrl(event.target.value),
                }),
                h(
                  'div',
                  { style: styles.grid },
                  h('span', { style: styles.gridKey }, '配置文件'),
                  h('code', { style: styles.code }, status?.configPath ?? '—'),
                  h('span', { style: styles.gridKey }, '输出目录'),
                  h('code', { style: styles.code }, status?.outputDir ?? '—'),
                  h('span', { style: styles.gridKey }, '默认模型'),
                  h('code', { style: styles.code }, `${status?.modelVersion ?? 'vlm'} / ${status?.language ?? 'ch'}`),
                  h('span', { style: styles.gridKey }, '单次等待上限'),
                  h('code', { style: styles.code }, minutes(status?.pollTimeoutMs)),
                ),
                h('div', { style: styles.hint }, h('p', { style: styles.hintP }, '也可用环境变量覆盖：MINERU_TOKEN、MINERU_BASE_URL、PAPER2MD_DIR（优先级高于配置文件）。')),
              )
            : null,

          message !== null
            ? h('div', { style: message.kind === 'ok' ? styles.ok : styles.err }, message.text)
            : null,
        ),

        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.sectionRow },
            h('span', { style: styles.sectionTitle }, '最近转换'),
            h('button', { style: styles.buttonTiny, onClick: refresh }, '刷新'),
          ),
          list.length === 0
            ? h('div', { style: styles.empty }, status === null ? '读取中…' : '还没有转换记录。让 AI 读一篇论文就会出现在这里。')
            : h(
                'div',
                { style: styles.paperList },
                list.map((paper) =>
                  h(
                    'div',
                    { key: paper.name, style: styles.paperRow },
                    h('span', { style: styles.paperName, title: paper.markdownPath }, paper.title || paper.name),
                    h('span', { style: styles.empty }, `${shortTime(paper.convertedAt)} · ${prettyInt(paper.chars)} 字`),
                    h('button', { style: styles.buttonTiny, onClick: () => copyPath(paper.markdownPath) }, copied === paper.markdownPath ? '已复制' : '复制路径'),
                  ),
                ),
              ),
        ),

        h(
          'div',
          { style: styles.hint },
          h('p', { style: styles.hintP }, '1. 在 MinerU 控制台创建 API Key（精准解析 API）。'),
          h('p', { style: styles.hintP }, '2. 粘贴到上方 → 验证并保存。保存前会探一次接口，无效 Key 不会写入磁盘。'),
          h('p', { style: styles.hintP }, '3. 之后让 AI 读论文 / PDF / arXiv 链接，它会先转成 Markdown 再读，按内容哈希缓存，同一篇不重复扣额度。'),
          h('p', { style: styles.hintP }, '可用工具：paper_to_md、paper_task_status、paper_list、paper_config_status。'),
        ),
      )
    }

    /** Register the settings page. */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'paper2md', order: 31, label: '论文转 Markdown' },
          () => h(Paper2MdSettings),
        ),
      )
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
