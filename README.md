# 墨页 / Inkstone

墨页是一个本地优先的 Markdown 桌面编辑器：Electron 负责窗口、文件系统与系统集成，CodeMirror 6 负责编辑，markdown-it 负责阅读视图。Markdown 源码始终是唯一数据源，排版只是同一份文本的另一种显示——打开文档先得到整篇排版好的阅读视图，点到哪一块，那一块就变回可编辑的源码。

## 主要功能

- **排版态就地编辑**：成对语法的标记在闭合的瞬间隐藏（`**粗体**`、`` `代码` ``、`~~删除线~~`、`==高亮==`、链接、图片、`$公式$`），光标进入该元素才显现淡化源码；标题、列表、任务框、引用、分隔线在前缀敲完的当下就排版。
- **整篇一致的渲染**：一次解析、逐块渲染并共享同一个解析上下文，重复标题锚点、脚注、引用式链接、`[TOC]`、YAML 属性卡片、GitHub 警示块都能跨块解析；阅读层与活跃块的可见文本由同一棵语法树决定。
- **技术文档语法**：GFM 表格（就地输入、Enter 追加行、Tab 走单元格、拖动列宽）、公式（KaTeX，`$…$` / `$$…$$` / `\(…\)` / `\[…\]`）、Mermaid 图表、代码高亮（常用语言内置，其余按需动态加载）。
- **文件与工作区**：文件树（新建、重命名、移到回收站、外部刷新）、文件夹全文搜索、最近文件、会话恢复、崩溃恢复、保存历史与逐行 diff、外部修改实时提示。
- **链接与图片**：本地 `.md` 链接支持跨文档锚点，源码中的行内链接可用 Ctrl/Cmd+点击打开。图片迁移支持带标题、尖括号及引用式 Markdown，首次保存会保全临时图片，跨目录另存为和移动会复制文档引用的本地 `assets/` 图片。
- **界面**：默认是 38px 单行标题栏 + 纯白纸面的极简外观（Windows 上窗口按钮走 `titleBarOverlay`，主题切换时同步换色），偏好设置里可切回带标签栏与工具栏的工作台外观；中文界面，命令面板（`Ctrl/Cmd+P`）、大纲、专注/打字机模式、自定义 CSS 主题。
- **导出**：自包含 HTML、PDF（带文档大纲）、复制为 Markdown/HTML；Pandoc 未安装时对应格式自动降级并提示。

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | 26.x（本轮验证 `v26.13.0`，npm `11.20.0`）。仓库未声明 `engines` 也没有 `.nvmrc`，CI 固定 `26.x` |
| 操作系统 | Windows 10/11 x64 或 macOS（Apple Silicon / Intel）。本轮只在 **Windows 11** 上完成自动化验证，macOS 本轮未复测 |
| Electron | 45.2.3（`devDependencies`，随 `npm ci` 安装对应平台二进制） |
| 显示环境 | `npm start` 与桌面用例都需要真实桌面会话（无头环境无法完成窗口与剪贴板断言） |

## 安装与运行

```bash
npm ci          # 全新检出按 package-lock.json 安装；已有 node_modules 时可用 npm install
npm start       # 先 vite build 再启动 Electron（加载 dist/）
npm run dev     # 浏览器开发预览：vite --host 127.0.0.1，终端会打印地址
```

`npm start` 等同于 `npm run build && electron .`，因此每次启动都用当前源码重新构建 `dist/`。浏览器预览（`npm run dev`）使用 `src/browser.js` 提供的简化文件桥接，没有真实文件系统、原生菜单与导出能力，只适合调界面。

Electron 首次启动需要下载对应平台的二进制；下载受阻时可单独执行 `npx install-electron`。

## 测试

| 命令 | 覆盖内容 | 大致耗时（Windows 11 实测） |
| --- | --- | --- |
| `npm test` | 16 个测试文件、**147 项**测试，覆盖真实文件存储与恢复、图片迁移、Markdown 渲染、会话、导航、版本对比等 | 约 2.5～4.5 秒 |
| `node test/desktop.mjs` | Playwright 驱动真实 Electron，**103 个 STEP**：编辑/撤销、字符级点击定位、保存与外部冲突、公式与图表、版本历史、表格编辑、剪贴板、多窗口、IME、CRLF、欢迎页、Windows 标题栏、文件夹搜索、最近文件、文件树操作、链接跳转、实时预览、会话恢复等 | 约 2 分钟 |
| `node test/perf.mjs` | 排版态输入延迟基准（5k / 30k / 100k 字符，默认每档 10 次按键）；平均延迟超过目标 3 倍（5k/30k 150 ms、100k 450 ms）或图表被输入重建时退出码为 1，`--report-only` 只报告 | 约 7 秒 |
| `npm run visual` | 生成 8 张真实桌面截图（初始界面、侧栏、浅色、输入态、IME 组合中、三类空前缀、深色、工作台对照）供人工视觉检查 | 约 8 秒 |

RFC 0001 的独立桌面回归使用真实文件和 IPC。构建后可运行 `node test/rfc0001-desktop.mjs` 检查双窗口冲突、恢复、会话、历史和导航，再运行 `node test/rfc0001-rendering.mjs` 检查长文档差异和重复标题。运行 `node test/rfc0001-first-save.mjs` 时，在系统保存对话框输入脚本打印的临时路径，以验证首次保存与插图的执行顺序。

关于桌面用例：

- 它依赖**真实剪贴板**（复制为 HTML/Markdown、粘贴纯文本、复制图片）和**真实鼠标时序**（列宽拖动按像素计算命中点），会在临时用户目录里启动独立实例并模拟保存对话框。剪贴板不可用的环境（部分远程会话、无剪贴板权限的容器）会在剪贴板断言处失败，这不是产品缺陷。
- 像素拖动类步骤必须先复位缩放、关闭打字机模式并等待布局稳定，否则 CDP 坐标与页面 CSS 坐标不一致。
- 宿主若注入 `ELECTRON_RUN_AS_NODE=1`，脚本会在派生应用进程时剔除它，并加 `--no-sandbox --disable-gpu`。
- `test/visual-check.mjs` 把截图写到系统临时目录下的 `inkstone-shots/inkstone-live-*.png`（可用环境变量 `INKSTONE_SHOT_DIR` 指定），运行结束时打印实际目录。

这些用例**不在 CI 的必过流程里**：`.github/workflows/ci.yml` 在 Windows/macOS 上跑 `npm test` + `npm run build`，桌面用例只作为手动触发的独立 job（`continue-on-error`），因为它对显示环境和时序敏感。

## 打包

```bash
npm run package:win   # electron-builder --win nsis，输出到 release/
npm run package:mac   # electron-builder --mac dir（macOS 主机上执行）
```

产物**未签名、未公证**：Windows 会触发 SmartScreen 警告，macOS 需要手动允许打开。打包脚本只做构建与封装，不包含任何签名、发布或上传步骤。

## 目录结构

```text
inkstone/
├── .github/workflows/ci.yml   # CI：push/PR 跑单测与构建，手动触发桌面用例
├── electron/
│   ├── main.cjs               # 主进程：菜单与快捷键、窗口、IPC 路由、导出、会话恢复
│   ├── preload.cjs            # contextBridge 暴露的最小桌面接口
│   ├── store.cjs              # 文档存储：原子写入、冲突检查、保存历史、恢复副本、资源同步
│   ├── assets.cjs             # 图片/链接路径解析（网络路径与可执行文件拒绝）
│   ├── search.cjs             # 文件夹全文搜索与文件名校验
│   ├── session.cjs            # 最近文件/文件夹与会话状态
│   └── argv.cjs               # 命令行文档路径解析（冷启动“打开方式”）
├── src/
│   ├── main.js                # 渲染层工作台：侧栏、命令面板、对话框、偏好、导出
│   ├── editor.js              # CodeMirror 6 状态与装饰：块渲染、排版态、拖选、表格输入
│   ├── live-preview.js        # 活跃块排版纯函数（mark / style / prefix / group）
│   ├── md-syntax.js           # 用 Lezer 解析出的语法树决定“哪些字符是语法”
│   ├── markdown.js            # 整篇解析与 HTML 渲染（KaTeX、Mermaid、警示块、脚注…）
│   ├── highlight.js           # highlight.js 核心语言 + 其余按需动态加载
│   ├── source-map.js          # 渲染文本 → 源码字符偏移
│   ├── table.js               # GFM 表格解析/序列化、单元格区间、列宽
│   ├── inline-marks.js        # 字面量块内的 Markdown 标记区间（纯函数）
│   ├── links.js               # 链接目标分类：锚点 / 外部 / 本地文件
│   ├── eol.js                 # BOM 与 LF/CRLF（含混排）保真
│   ├── outline.js / diff.js   # 章节切分与重排、逐行 LCS 差异
│   ├── emoji.js / welcome.js  # 表情短代码词表、欢迎文档内容
│   ├── browser.js             # 浏览器预览用的桌面接口替身
│   ├── styles.css             # 排版与界面样式（含两套外观、深色主题）
│   └── …
├── tokens.css                 # 主题色板（浅色 Typora 风格 / 深色 Night）
├── index.html                 # 渲染层入口
├── vite.config.js             # 构建配置（base './'，target es2022）
├── test/
│   ├── *.test.js              # 单元测试（node --test）
│   ├── desktop.mjs            # 桌面端到端回归（Playwright + Electron）
│   ├── perf.mjs               # 输入延迟基准
│   └── visual-check.mjs       # 真实截图脚本
├── docs/
│   ├── parity-baseline.md     # 与 Typora 的对等基准与逐项状态
│   ├── parity/fixtures/       # 冻结的 Markdown 回归语料
│   ├── regression-map.md      # 第 1～6A 批修复项 → 自动化测试映射
│   └── evidence/              # 构建日志与历史截图
├── HANDOFF.md                 # 交接记录：轮次历史、验证结果、已知边界
└── dist/                      # 构建产物（npm run build 生成，git 忽略）
```

## 安全说明

文档是不可信输入，因此**打开一个 Markdown 文件不应该让机器联系任何其他主机，也不应该执行任何东西**。所有资源路径都在主进程里统一解析（`electron/assets.cjs`）：UNC 路径（`\\host\share`）、`\\?\UNC\` 与 `\\.\` 设备路径、带 host 的 `file://host/…` 在第一次文件系统调用之前就被拒绝——仅仅对这类路径调用 `realpath()` 在 Windows 上就会建立 SMB 会话并泄露用户的 NTLM 哈希。本地路径在 `realpath` 之后再检查一次，防止符号链接把请求带到网络上。图片只接受白名单扩展名（png/jpg/gif/webp/svg/avif/bmp/ico）并必须是真实存在的普通文件；文档链接允许任意文件类型，但扩展名属于可执行/脚本类（exe、bat、cmd、ps1、lnk、app、sh、jar……以及 Windows `PATHEXT` 声明的全部类型）时一律拒绝，不会交给 shell。

渲染层是隔离的：`contextIsolation` + `sandbox`、权限请求全部拒绝、自定义 `inkstone-asset://` 协议只服务已登记的文档、DOMPurify 白名单清洗（`data-*` 除白名单属性外整体禁止，SVG/MathML 走同一套属性检查），预览里注入的 `data-*` 不会变成可执行指令。自定义主题 CSS 只从本地主题目录读取，并剥离 `@import` 防止远端加载；文件夹搜索的正则模式默认关闭，只是给用户自己的目录提供的选项。

## 已知限制

- 活跃块是**行内装饰模拟排版**，不是 Typora 那样的可编辑渲染 DOM；嵌套强调（`**粗 *斜* 字**`）的内层标记、跨块拖选中间块的保留渲染，仍有差距。
- 表格就地输入是「选中该单元格源码区间后键入」，不是渲染单元格内的富文本编辑；列宽拖动按表头右边缘命中。
- 公式引擎是 KaTeX，宏支持范围与 MathJax 不同；导出 HTML/PDF 的分页与视觉结果未验收，Pandoc 未安装时 DOCX/ODT/EPUB/LaTeX/RST 只能降级提示。
- 同一应用进程的多个窗口按真实文件路径协调保存。同一磁盘版本上的冲突保存仅允许先写入的一方成功，另一方保留草稿。多个进程之间仍使用磁盘版本检测，无法保证其他程序不会在检查与替换之间写入。
- 真实系统中文输入法（候选窗口、退格、快速连打）未在实机上验收，自动化只覆盖 CDP 模拟的组合开始/更新/确认；macOS 本轮未复测（Finder 文件关联、Cmd 快捷键矩阵、签名公证均待办）。
- 桌面用例对时序敏感，未纳入 CI 必过流程；`test/perf.mjs` 也不在 CI 中运行（托管机器慢且波动大），只拦截超过目标 3 倍的明显退化，目标值本身仍要人工看表。
