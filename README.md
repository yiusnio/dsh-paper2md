# dsh-paper2md

给 DSH 装的「论文先转 Markdown」插件。装了它之后，让 AI 读论文、读 PDF、看 arXiv 时，AI 不会再瞎猜 PDF 内容，而是先调 `paper_to_md` 把文件丢给 [MinerU](https://mineru.net) 解析成 Markdown（标题层级、表格转 HTML、公式转 LaTeX、图片落盘），再用 `read` 读那个 `.md`。

装好后 **dsh 设置里多一页「论文转 Markdown」**，可以在界面里直接粘贴 MinerU API Key、验证、清除，并看到最近的转换记录——不用改文件、不用重启。

- 零第三方依赖、纯 ESM、无构建步骤（host 与浏览器两半都是手写 JS）
- 结果按 `sha256(内容 + 参数)` 落盘缓存，同一篇论文重复读不重复扣额度
- 支持本地文件、http(s) 直链、arXiv `abs`/`pdf` 链接
- 长任务可后台跑：`wait:false` 提交，之后用 `paper_task_status` 收取，不会重跑

## 安装

```powershell
cd C:\Users\aaaa\.dsh\profiles\web
pnpm add file:C:/path/to/paper2md-plugin
```

然后把 `"dsh-paper2md"` 追加到该 `package.json` 的 `dsh.profile.bundles` 数组，重启 dsh。

插件自身的依赖（`@deepseek-ai/dsh-tools` 等）由宿主提供，不需要声明。开发期如果直接改源码，把 `profiles/web/node_modules/dsh-paper2md` 换成指向源码目录的 Junction 即可热更新；`pnpm install` 会把它还原成拷贝。

## 配置 MinerU token

token 在 <https://mineru.net/apiManage> 创建。

**界面方式（推荐）**：dsh → 设置 → 「论文转 Markdown」→ 粘贴 Key → **验证并保存**。保存前会拿 Key 探一次 API，401/403 直接拒收，不会把废 Key 写盘；保存后立即生效（`resolveSettings()` 每次调用现读）。同一页还能看到 Key 来源、配置文件路径、输出目录和最近转换记录。

也可以走下面三种（优先级从高到低）：

1. 环境变量 `MINERU_TOKEN`（会盖过界面上填的 Key，设置页会提醒）
2. `~/.dsh/paper2md.json`：`{"token":"eyJ..."}`（写入后权限收紧为 0600）
3. 插件路由（仅本机回环可调）：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3080/api/dsh-paper2md/token -Method POST `
  -ContentType application/json -Body '{"token":"eyJ..."}'
```

写入前会拿 token 探一次 API，401/403 直接拒收，不会把废 token 存下来。查状态（不回显 token）：

```powershell
Invoke-RestMethod http://127.0.0.1:3080/api/dsh-paper2md/status
```

路由一共四条：`status`(GET)、`token`(POST，写前探活)、`clear`(POST)、`papers`(GET，设置页「最近转换」用的就是它)，全部只接受回环来源（`127.0.0.1` / `::1` + 同源 Origin）。

其他可配项：`MINERU_BASE_URL`、`PAPER2MD_DIR`（输出目录，默认 `~/.dsh/paper2md/papers`）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `paper_to_md` | 主入口。`source` 必填，可传本地路径 / http(s) 链接 / arXiv 链接 |
| `paper_task_status` | 收取 `wait:false` 或等待超时的任务 |
| `paper_list` | 列出已转好的论文（缓存索引） |
| `paper_config_status` | 查 token 是否就位、输出目录、默认模型 |

`paper_to_md` 的常用参数：

- `model`：`vlm`（默认，版式/表格更准）/ `pipeline`（更快更省）/ `MinerU-HTML`
- `language`：默认 `ch`，英文论文传 `en`
- `pageRanges`：`"1-20"`、`"2,4-6"`，只转指定页省额度
- `isOcr`：扫描件/图片型 PDF 打开
- `enableFormula` / `enableTable`：默认都开
- `force`：忽略缓存重转
- `wait`：默认 `true`；`false` 只提交，立刻拿 `task.kind` / `task.id`

返回里最有用的是 `markdownPath` 和 `preview`，图片已经跟 Markdown 一起解压到同目录 (`images/`)，相对链接可用。

## 输出布局

```
~/.dsh/paper2md/papers/
  <slug>-<hash8>/
    full.md          # 正文 + 相对图片引用
    images/          # 图片、公式裁图
    .meta.json       # 来源、模型、参数、耗时、字节数
  .pending/          # 未收完的任务记录，收完自动删除
```

`*_middle.json`、`*_model.json`、`*_content_list.json` 这类中间产物默认丢弃（大且对模型没用），需要时在配置里设 `keepJson: true`。

## MinerU 侧限制

- 单文件 ≤ 200 MB、≤ 200 页；每日高优先级额度 1000 页
- 一次最多申请 50 个上传链接（本插件一次只转一篇）
- MinerU 抓不到国外 URL（github/aws 一类）时会超时；插件会自动降级成「自己下载 → 上传字节」再解析

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `MinerU token 无效或权限不足（401）` | token 过期或复制不全，重新写入 |
| 返回 `pending: true` + `state` | 正常，用 `paper_task_status` 传 `kind`/`id` 继续收 |
| `结果包中没有 Markdown 文件` | ZIP 结构变了，把 `keepJson` 打开重跑一次看成员列表 |
| 解析出来的标题层级乱 | MinerU 的固有短板，多级标题需人工校对 |

## 自测

```powershell
node test/selftest.mjs        # 离线：ZIP 解包、路径归一、缓存键、配置默认值
node test/dryrun.mjs          # 宿主半部分：4 工具 / 4 路由 / 提示词段 / 参数校验
node test/client-dryrun.mjs   # 浏览器半部分：bundle 注册、设置页渲染、保存链路
```
