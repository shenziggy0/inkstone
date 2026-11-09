# 墨页 / Inkstone

墨页是一个本地优先的 Markdown 桌面编辑器：Electron 负责窗口、文件系统与系统集成，CodeMirror 6 负责编辑，markdown-it 负责阅读视图。Markdown 源码始终是唯一数据源，排版只是同一份文本的另一种显示——打开文档先得到整篇排版好的阅读视图，点到哪一块，那一块就变回可编辑的源码。

## 主要功能

- **排版态就地编辑**：成对语法的标记在闭合的瞬间隐藏（`**粗体**`、`` `代码` ``、`~~删除线~~`、`==高亮==`、链接、图片、`$公式$`），光标进入该元素才显现淡化源码；标题在换行或光标离开当前行后排版；列表、任务框和引用在标记后的空格输入时排版，分隔线在标记完整时排版。输入中的 Setext 下划线不提前改变上一行字号。
- **整篇一致的渲染**：一次解析、逐块渲染并共享同一个解析上下文，重复标题锚点、脚注、引用式链接、`[TOC]`、YAML 属性卡片、GitHub 警示块都能跨块解析；阅读层与活跃块的可见文本由同一棵语法树决定。
- **技术文档语法**：GFM 表格（就地输入、Enter 追加行、Tab 走单元格、拖动列宽）、公式（KaTeX，`$…$` / `$$…$$` / `\(…\)` / `\[…\]`）、Mermaid 图表、代码高亮（常用语言内置，其余按需动态加载）。
- **文件与工作区**：文件树（新建、重命名、移到回收站、外部刷新）、文件夹全文搜索、最近文件、会话恢复、崩溃恢复、保存历史与逐行 diff、外部修改实时提示。
- **链接与图片**：本地 `.md` 链接与跨文档锚点跳转；本地图片按文档相对路径解析，另存为/重命名时同步 `assets/`。
- **界面**：默认是 38px 单行标题栏 + 纯白纸面的极简外观（Windows 上窗口按钮走 `titleBarOverlay`，主题切换时同步换色），偏好设置里可切回带标签栏与工具栏的工作台外观；中文界面，命令面板（`Ctrl/Cmd+P`）、大纲、专注/打字机模式、自定义 CSS 主题（含 `#write` 的 Typora 主题走受限正文映射；未使用 `#write` 的旧墨页 CSS 保留 `.topbar` 等原始选择器语义，二者共用本地资源安全处理）。
- **导出**：自包含 HTML、无样式 HTML、整篇 PNG、PDF（带文档大纲；可选页眉页脚、页码、纸张与页边距预设）、复制为 Markdown/HTML；Pandoc 未安装时对应格式自动降级并提示。

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | CI 使用 `26.x`。本轮 macOS 本机验证使用 Node.js `22.23.2` 和 npm `10.9.8` |
| 操作系统 | Windows 10/11 x64、macOS（Apple Silicon / Intel）或 Linux（AppImage）。本轮通过 macOS 桌面验证与 Linux x64 交叉打包，Windows、Linux 的安装与运行待实机验证 |
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
| `npm test` | 16 个测试文件、**140 项**单元测试：存储与恢复、行尾处理、命令行路径、资源路径安全、Markdown 渲染、表格、行内标记、排版态纯函数、渲染缓存、文件夹搜索、会话、链接、按需高亮、源码映射、版本 diff、大纲重排 | 约 2.5～4.5 秒 |
| `node test/desktop.mjs` | Playwright 驱动真实 Electron，**103 个 STEP**：编辑/撤销、字符级点击定位、保存与外部冲突、公式与图表、版本历史、表格编辑、剪贴板、多窗口、IME、CRLF、欢迎页、Windows 标题栏、文件夹搜索、最近文件、文件树操作、链接跳转、实时预览、会话恢复等 | 约 2 分钟 |
| `node test/perf.mjs` | 排版态输入延迟基准（5k / 30k / 100k 字符，默认每档 10 次按键）；平均延迟超过目标 3 倍（5k/30k 150 ms、100k 450 ms）或图表被输入重建时退出码为 1，`--report-only` 只报告 | 约 7 秒 |
| `npm run visual` | 生成 8 张真实桌面截图（初始界面、侧栏、浅色、输入态、IME 组合中、三类空前缀、深色、工作台对照）供人工视觉检查 | 约 8 秒 |

关于桌面用例：

- 它依赖**真实剪贴板**（复制为 HTML/Markdown、粘贴纯文本、复制图片）和**真实鼠标时序**（列宽拖动按像素计算命中点），会在临时用户目录里启动独立实例并模拟保存对话框。剪贴板不可用的环境（部分远程会话、无剪贴板权限的容器）会在剪贴板断言处失败，这不是产品缺陷。
- 像素拖动类步骤必须先复位缩放、关闭打字机模式并等待布局稳定，否则 CDP 坐标与页面 CSS 坐标不一致。
- 宿主若注入 `ELECTRON_RUN_AS_NODE=1`，脚本会在派生应用进程时剔除它，并加 `--no-sandbox --disable-gpu`。
- `test/visual-check.mjs` 把截图写到系统临时目录下的 `inkstone-shots/inkstone-live-*.png`（可用环境变量 `INKSTONE_SHOT_DIR` 指定），运行结束时打印实际目录。

这些用例**不在 CI 的必过流程里**：`.github/workflows/ci.yml` 在 Windows/macOS/Linux 上跑 `npm test` + `npm run build`，桌面用例只作为手动触发的独立 job（`continue-on-error`），因为它对显示环境和时序敏感。

## 导出参数与兼容范围

导出对话框里保留原有 HTML / PDF 两个入口，并新增「HTML（无样式）」与「PNG」。浏览器开发预览（`npm run dev`）只有 HTML / PDF，因为 PNG、无样式 HTML 的离线资产解析和 PDF 页眉页脚都依赖 Electron 主进程；新增格式只在真实支持时出现。

| 格式 | 默认行为 | 可选项 / 限制 |
| --- | --- | --- |
| HTML | 自包含：主题/应用 CSS、公式字体、本地图片全部内嵌；外部图片仍保留原 URL。 | 无额外设置。 |
| HTML（无样式） | 语义正文：标题/脚注/公式锚点 ID、链接、表格、图表 SVG、本地图片 data URI 均保留；不写任何应用/主题样式、class 或行内样式。公式输出为单一 MathML 树，不暴露 KaTeX 的 `.katex-html` 视觉层；SVG 内部的自包含 `<style>` 保留。 | 仅 `.html` 文件，不发起网络请求，不加载外部字体或样式表。 |
| PNG | 在隐藏的 sandbox 窗口中按 `devicePixelRatio` 捕获整篇正文，不含工具栏、光标、选区、对话框或滚动位置。默认 CSS 宽度为偏好中的正文宽度加左右各 48px（默认 860 + 96 = 956px），实际像素宽高再乘以设备像素比。 | 宽度上限 8192px、高度上限 32000px、总像素上限 60,000,000；超限时明确报错且不保存截断图，临时窗口总会关闭。外部图片不会被下载。 |
| PDF | 保持原 `printToPDF` 参数：打印背景、优先 CSS `@page`（A4，20mm / 18mm 页边距）、生成文档大纲与 tagged PDF。渲染在隔离窗口中完成，避免导出弹窗抑制大纲。 | 页眉/页脚为纯文本，支持 `${pageNo}`、`${pageCount}` / `${totalPages}`；可勾选自动页码。纸张可选跟随打印样式 / A0–A6 / Letter / Legal / Tabloid / Ledger，页边距可选跟随打印样式 / 常规 / 窄 / 宽，并可横向。命名预设与上次成功配置写入 `settings.json` 的 `pdfPresets` / `pdfExport`。 |

**兼容与安全边界。** 所有导出都沿用现有的本地资产解析，不上传图片，不扩展第三方转换器，也不执行自定义命令。HTML/PNG/PDF 的临时渲染页面会拒绝网络和其他本地文件请求；PNG/PDF 的临时数据放在系统临时目录并在结束时删除。PDF 的页眉/页脚先按纯文本转义，只识别上述三个页码占位符，未知 `${...}` 保持字面量；非默认纸张、方向和页边距通过生成的 `@page` 覆盖应用，避免 Chromium 的 printToPDF 页边距与文档自身 `@page` 冲突。预设字段和值在白名单内归一化，旧版 `settings.json` 缺少新字段时使用默认值，未知字段被忽略。保存对话框取消时不写文件；PNG 先检查尺寸再截图，PDF/PNG/HTML 都通过原子写入保存。

## 打包

```bash
npm run package:win     # electron-builder --win nsis，输出 release/*.exe 与 release/win-unpacked/
npm run package:mac     # electron-builder --mac dir（macOS 主机上执行），输出 release/mac-<arch>/Inkstone.app
npm run package:linux   # electron-builder --linux AppImage，输出 release/*.AppImage
```

本地验证时可向打包命令传入 `--publish never`。签名取决于构建机的配置。本轮 Linux x64 AppImage 在 Apple Silicon Mac 上交叉生成，默认封装工具需要 Intel 运行环境，本次通过临时 ARM 版 SquashFS 工具完成。Linux 桌面启动和系统关联仍待实机验证。

Linux 包内的 `inkstone.desktop` 声明 `Name=Inkstone` / `Name[zh_CN]=墨页`、`MimeType=text/markdown;` 与 `md` / `markdown` 扩展名关联；这些是包内元数据，系统是否实际注册取决于桌面环境或 AppImage 集成工具。

本轮 macOS 验证包未做发行签名和公证。

## 目录结构

```text
inkstone/
├── .github/workflows/ci.yml   # CI：push/PR 在 Windows/macOS/Linux 跑单测与构建，手动触发桌面用例
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

渲染层是隔离的：`contextIsolation` + `sandbox`、权限请求全部拒绝、自定义 `inkstone-asset://` 协议只服务已登记的文档、DOMPurify 白名单清洗（`data-*` 除白名单属性外整体禁止，SVG/MathML 走同一套属性检查），预览里注入的 `data-*` 不会变成可执行指令。自定义主题 CSS 只从本地主题目录读取：相对 `@import`、字体和图片经 `realpath` 校验后内联，网络、UNC、绝对路径和符号链接逃逸一律拒绝；`image-set`、转义 `url` 函数名等复杂资源写法明确拒绝，避免绕过离线资源检查；文件夹搜索的正则模式默认关闭，只是给用户自己的目录提供的选项。

## 已知限制

- 活动块由 CodeMirror 编辑 Markdown 源码。超长文档超过排版阈值时回退为源码模式。
- 常规 Markdown 表格支持就地编辑、行列重排和调整列宽。混合原始 HTML 的表格保留源码编辑。
- 公式引擎是 KaTeX，宏支持范围与 MathJax 不同；PDF 的纸张、页边距、页码、分页、大纲及 PNG 尺寸上限已在 macOS 自动化中验证，Windows 实机的字体替换与打印视口仍需复测。浏览器开发预览只支持 HTML/PDF；PNG 不下载远程图片。Pandoc 未安装时 DOCX/ODT/EPUB/LaTeX/RST 只能降级提示。
- 跨进程（两个应用实例或多个外部程序）并发写同一文件的冲突语义没有定义；应用内多窗口是隔离的。
- macOS Apple Silicon 验证包已通过系统拼音组字、退格、候选确认和保存。Windows 与 Linux 的真实系统输入法和系统文件关联待验证。
- 桌面用例对时序敏感，未纳入 CI 必过流程；`test/perf.mjs` 也不在 CI 中运行（托管机器慢且波动大），只拦截超过目标 3 倍的明显退化，目标值本身仍要人工看表。
