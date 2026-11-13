# 回归映射：2026-11 审计修复（第 1～6A 批）

基准提交 `e548e99`（分支 `fix/audit-2026-11`）。下表把本轮每一处修复/新增功能映射到**实际存在的自动化覆盖**：

- `test/*.test.js` — `npm test` 里的测试名（`node --test` 用例）；
- `test/desktop.mjs` — 桌面端到端 STEP 名与序号（`STEP n`，共 103 步）。

核对方式：`npm test` 输出里能搜到测试名全文；`grep -n "STEP" test/desktop.mjs` 能搜到 STEP 名与行号。表中「覆盖」列为空即「无覆盖」，统一列在最后一节并说明原因。

状态取值：**✅ 自动覆盖**（断言直接命中该行为）· **◐ 间接覆盖**（有断言但只约束结果，不约束实现细节）· **无覆盖**。

## 第 1 批：数据安全（保存、恢复、冲突）

| # | 修复 / 功能 | 代码位置 | 单测 | 桌面 STEP | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1.1 | 原子写入（临时文件 + rename）与写入串行化 | `electron/store.cjs` `atomicWrite` | `serializes changes and saves without losing a later edit` | STEP 8 `save` | ✅ |
| 1.2 | 文件身份按 `realpath` 解析（`/tmp` ↔ `/private/tmp`，大小写与符号链接） | `electron/store.cjs` `open` | `UTF-8 BOM, CRLF, YAML, HTML and unsupported syntax survive an unchanged save byte for byte`；`filesystem boundary check rejects prefix siblings and traversal; tree skips symlinks` | STEP 8 | ✅ |
| 1.3 | 保存前检查磁盘版本，拒绝覆盖外部改动 | `electron/store.cjs` `save` | `refuses to overwrite a changed file and leaves recovery text available` | STEP 10 `external change notification` | ✅ |
| 1.4 | 拒绝静默重建被删除的原文 | `electron/store.cjs` `save` | `refuses to silently recreate a deleted original` | STEP 73 `external deletion prompts, then Save As / keep as unsaved` | ✅ |
| 1.5 | 保存失败保留脏文档与原文（不丢字） | `electron/store.cjs` `save` | `save failure retains the dirty document and original file` | — | ✅ |
| 1.6 | 恢复副本只认领一次；主窗口接手次级窗口遗留的草稿 | `electron/store.cjs` `recover` | `recover unsaved work into a new unnamed document, once`；`primary startup recovers unsaved documents left by secondary windows` | STEP 80 `a crashed draft keeps its pasted images through recovery` | ✅ |
| 1.7 | 恢复副本保存「被放弃的本地文本」（`discarded/`） | `electron/store.cjs` `discard` | `reload keeps a discarded copy of dirty local text` | STEP 68 `reload keeps a discarded copy of dirty local text`；STEP 69 `keep-local unblocks saving and backs up the overwritten disk version` | ✅ |
| 1.8 | 保存历史按路径共享、上限 50、旧格式目录仍可读、条目名可读 | `electron/store.cjs` `writeHistory` / `listHistory` / `readHistory` | `history is keyed by the document path, shared, and pruned to 50 versions`；`legacy history folders stay readable but only match the exact file name`；`history labels name the document and time instead of the stored uuid file` | STEP 11 `version history dialog + line diff`；STEP 75 `file menu + palette reach rename / reveal / trash / diagram, history names stay readable` | ✅ |
| 1.9 | 被删除文档 detach 成未保存文档（保留正文） | `electron/store.cjs` `detach` | `detaching a deleted file keeps its text as an unsaved document` | STEP 73 | ✅ |
| 1.10 | 文件夹重命名后 rekey：文档路径、历史目录一起迁移 | `electron/store.cjs` `rekey` / `moveHistory` | `rekey points a document at a renamed folder and moves its history` | STEP 98 `renaming a folder moves the open document with it` | ✅ |
| 1.11 | 新建命名文档初始为「未修改」且有标题 | `electron/store.cjs` `create`；`electron/main.cjs` `newDocument` | `a named new document starts unmodified with its own title` | STEP 2 `welcome page starts unmodified as 欢迎使用.md` | ✅ |
| 1.12 | 拒绝非法 UTF-8 / 二进制文件，且不改动原文件 | `electron/store.cjs` `decodeText` | `rejects invalid UTF-8 and binary files without modifying them` | — | ✅ |
| 1.13 | 重新加载磁盘版本 / 接受磁盘版本后可覆盖保存 | `electron/store.cjs` `reload` / `acceptDisk` | `reload reads the disk version back into an open document`；`accepting the disk version lets the next save overwrite and keeps the disk text in history` | STEP 72 `clean document reloads external changes automatically`；STEP 69 | ✅ |
| 1.14 | 行尾保真：BOM、纯 LF、纯 CRLF、混排文件逐行保持 | `src/eol.js` + `src/editor.js` | `detectEol reports pure LF, pure CRLF and mixed files`；`a pure LF file keeps LF and a pure CRLF file is converted wholesale`；`a mixed file keeps untouched prefix and suffix lines and uses the majority style in between`；`a BOM is preserved and never doubled` | STEP 54 `mixed newline file keeps per-line endings on edit and unchanged save`；STEP 52 `CRLF Enter / Shift+Enter / inserted table stay CRLF and render` | ✅ |
| 1.15 | 命令行文档路径解析（冷启动「打开方式」），忽略 Electron 开关与应用目录 | `electron/argv.cjs` | `command-line document paths ignore Electron switches and the app directory`；`relative paths resolve against the caller working directory`；`only Markdown and text documents are accepted, once each`；`malformed input yields no documents` | STEP 78 `cold start opens the document named on the command line` | ✅ |
| 1.16 | 退出保存提示可超过 5 秒兜底；取消退出保留所有窗口；多窗口逐个走保存流程 | `electron/main.cjs` `finishQuit` / `quitAck` | — | STEP 82 `quit save prompt may outlive the 5s fallback`；STEP 83 `quit cancel keeps every window open`；STEP 84 `multi-window quit walks every window with a 5s fallback` | ◐（只有桌面用例，主进程逻辑无单测） |
| 1.17 | 渲染进程崩溃时提示、重载，且仍可关闭窗口 | `electron/main.cjs` `render-process-gone` | — | STEP 81 `renderer crash prompts, reloads, and still allows closing` | ◐ |

## 第 2 批：按块渲染缓存与 widget 增量更新

| # | 修复 / 功能 | 代码位置 | 单测 | 桌面 STEP | 状态 |
| --- | --- | --- | --- | --- | --- |
| 2.1 | 段落编辑只重渲该块，其余块复用 | `src/editor.js` `blockCache` + `src/markdown.js` `renderBlocks` | `a paragraph edit reuses every other block and re-renders only itself` | STEP 59 `incremental block rendering keeps widget DOM and click positions` | ✅ |
| 2.2 | 引用定义和脚注使用全局签名。标题 ID 在整篇解析时分配，标题与目录块按各自依赖失效 | 同上 | `test/render-cache.test.js` | `test/rfc0001-rendering.mjs` 检查增量编辑后的标题 ID 和目录 | ✅ |
| 2.3 | 签名忽略「任何块都看不见」的编辑（不误触发全量重渲） | 同上 | `the signature ignores edits that no block can see across boundaries` | — | ✅ |
| 2.4 | 块上下文保留重复标题锚点与 `[TOC]` 精确条目 | 同上 | `block context keeps duplicate heading anchors and the table of contents exact`；`the outline and [TOC] are derived from the render parse` | STEP 12 `cross-block rendering parity` | ✅ |
| 2.5 | 逐块渲染结果与整篇一次渲染完全一致 | 同上 | `per-block rendering matches one whole-document render` | STEP 12 | ✅ |
| 2.6 | CRLF / BOM 文档与 LF 形式渲染出同样的块 | 同上 | `CRLF and BOM documents render the same blocks as their LF form` | STEP 51 `CRLF rendered task coordinates`；STEP 53 `CRLF column drag writes the width comment in place` | ✅ |
| 2.7 | widget DOM 与点击定位在增量更新后仍有效 | `src/editor.js` widget 复用 | — | STEP 59 | ◐（DOM 复用时序只能端到端验证） |

## 第 3 批：活跃块排版重写（`md-syntax.js` + `live-preview.js`）

| # | 修复 / 功能 | 代码位置 | 单测 | 桌面 STEP | 状态 |
| --- | --- | --- | --- | --- | --- |
| 3.1 | 用真实语法树（Lezer CommonMark + 与 markdown-it 相同的扩展集）判定「哪些字符是语法」 | `src/md-syntax.js` | `ordinary characters are no longer mistaken for syntax`；`code, formulas and HTML blocks keep their source while editing`；`a fenced block nested in a list item hides no asterisks`；`a block formula is literal from the opening to the closing delimiter` | STEP 38 `ordinary characters stay visible in the active block`；STEP 40 `literal code and formula blocks show their full source` | ✅ |
| 3.2 | 一致性不变量：活跃块可见文本 = 渲染层纯文本 | `src/live-preview.js` / `src/editor.js` | `active block text matches the rendered text for the inline corpus`；`docs/parity/fixtures/parity-sample.md blocks match the rendered text`；`reference links follow the labels the document defines`；`formula delimiters follow texmath on both layers` | STEP 21 `typeset live preview + syntax reveal on caret approach`；STEP 34 `typing in typeset mode keeps Markdown source intact` | ✅ |
| 3.3 | 成对语法共享一个「编辑组」：闭合标记后立即隐藏，光标进入才显现 | `src/live-preview.js` `groups` / `revealFor` | `a completed syntax renders immediately when the caret follows the closing marker`；`code spans, links and images share one editing group across both marks`；`block prefixes typeset at once but reveal under the caret`；`incomplete syntax has no group and therefore stays visible`；`a completed element typesets immediately and reveals under the caret` | STEP 35 `immediate typeset on closing delimiter + reveal only inside element` | ✅ |
| 3.4 | 嵌套强调隐藏内层标记（不再只淡化） | `src/live-preview.js` | `nested emphasis hides inner markers instead of dimming them`；`nested emphasis hides its inner markers instead of dimming them` | STEP 39 `nested emphasis hides every marker` | ✅ |
| 3.5 | 空正文块前缀（`-`、`- [ ]`、`- [x]`、`1.`、`>`）在行尾即完整 | `src/live-preview.js` 前缀规则 | `content-free block prefixes typeset the instant they are complete`；`an incomplete list item is a bullet, never a table delimiter row` | STEP 37 `immediate typesetting for empty list, task and quote prefixes` | ✅ |
| 3.6 | 未闭合语法不隐藏；`~/.bashrc`、`$5`、`x^2 + y^2` 不被当作语法 | `src/live-preview.js` | `unmatched delimiters are content, underscores inside words stay literal`；`ordinary characters are no longer mistaken for syntax` | STEP 38 | ✅ |
| 3.7 | 转义、上下标、HTML 行内标签、表情在活跃块中保持排版 | `src/live-preview.js` `replacements` | `escapes, subscript, superscript, HTML spans and emoji match rendered syntax` | STEP 38 | ✅ |
| 3.8 | 行内区间有序、互不重叠、都在行内 | `src/live-preview.js` | `all ranges are ordered, disjoint and inside the line` | — | ✅ |
| 3.9 | 标题/粗体/代码/删除线/高亮/链接/圆点/编号的真实排版样式 | `src/live-preview.js` + `src/styles.css` | `heading: prefix becomes a hidden range and the line gets display typography`；`inline emphasis: markers are syntax, content is styled`；`links style only the label and hide brackets plus destination`；`bullets, quotes, ordered lists and rules each get the right prefix`；`literal blocks stay as source: fences and table delimiter rows` | STEP 36 `immediate heading, bullet, ordered list and code span typesetting`；STEP 21 | ✅ |
| 3.10 | 任务框暴露精确的复选框字符偏移（点击写回源码） | `src/live-preview.js` | `task list prefix exposes the exact checkbox character offset` | STEP 41 `rendered empty task item stays a checkbox and toggles source` | ✅ |
| 3.11 | IME 组合期间冻结既有排版（不重建、不清空） | `src/editor.js` `preview` StateField | — | STEP 47 `IME composition keeps typesetting across the document` | ◐（CDP 模拟；真实 IME 无覆盖） |

## 第 4 批：图片与资源路径统一解析

| # | 修复 / 功能 | 代码位置 | 单测 | 桌面 STEP | 状态 |
| --- | --- | --- | --- | --- | --- |
| 4.1 | 图片解析统一到 `electron/assets.cjs`（协议、剪贴板、HTML 导出共用一套） | `electron/assets.cjs` `resolveAssetFile` | `images resolve relative to the document, above it, and by absolute path`；`local absolute paths and local file URLs keep resolving`；`asset URLs round-trip every reference spelling the markdown source allows` | STEP 61 `image paths (encoded, angle-bracket, ../, absolute, http) render and export inlines local ones` | ✅ |
| 4.2 | 拒绝 UNC / 设备路径 / 带 host 的 `file://`（防 NTLM 泄露），且在任何文件系统调用之前 | `electron/assets.cjs` `isNetworkPath` / `isNetworkFileURL` | `network references are recognised without any filesystem access`；`the resolver refuses UNC, device and host-ful file URLs without touching the network` | STEP 101 `openPath / openLocalFile / openFolderPath refuse network paths` | ✅ |
| 4.3 | 只返回真实图片文件（白名单扩展名 + realpath 后复查，SVG 作为图片安全） | `electron/assets.cjs` `IMAGE_MIME` | `the resolver only ever returns real image files`；`the sanitizer URI allow-list keeps local image spellings and blocks scripts` | STEP 61 | ✅ |
| 4.4 | 可执行文件/脚本链接拒绝（内置扩展名 + Windows `PATHEXT`） | `electron/assets.cjs` `isExecutableExtension` | `executable and script targets are refused before anything can run them` | STEP 102 `a link to an executable is refused and never reaches the shell` | ✅ |
| 4.5 | DOMPurify 配置化剥离保留属性（`FORBID_ATTR`，不做字符串二次遍历） | `src/markdown.js` `SANITIZE_CONFIG` | `DOMPurify is configured with every reserved attribute (no string pre-pass)` | STEP 62 `document-injected data-* attributes are inert, the real copy button still copies`；STEP 63 `exported HTML and copy-as-HTML carry no copy button` | ✅ |
| 4.6 | 未保存文档的临时图片目录（按文档 id 派生，路径越界拒绝） | `electron/assets.cjs` `unsavedAssetsDirectory`；`electron/store.cjs` | `the unsaved asset folder is keyed by a validated document id`；`an unsaved document resolves assets inside its own temporary folder` | STEP 64 `unsaved document inserts an image, shows it, and migrates it on Save As` | ✅ |
| 4.7 | 首次保存保全临时图片，带标题、尖括号和引用式图片按解析结果迁移 | `electron/store.cjs` `syncAssets` / `save`；`electron/asset-references.mjs` | `test/store.test.js` 覆盖同名冲突和迁移失败 | `test/rfc0001-first-save.mjs` 使用原生保存对话框检查保存与插图顺序 | ✅ |
| 4.8 | 关闭未保存文档时清理临时图片；启动时清理过期目录但保留恢复引用 | `electron/main.cjs` 未保存文档清理 | — | STEP 66 `closing an unsaved document cleans its temporary images`；STEP 79 `stale unsaved image folders are pruned but recovery references are kept` | ◐ |
| 4.9 | 另存为只搬运被引用的 `assets/`，不覆盖同名不同内容的文件，并改写编辑器里的引用 | `electron/store.cjs` `syncAssets` | `Save As carries only referenced assets into the new directory`；`syncAssets never overwrites a same-named asset with different bytes` | STEP 60 `Save As keeps rewritten asset references in the editor` | ✅ |
| 4.10 | 文档内链接解析（任意文件类型，缺失目标给出中文提示） | `electron/assets.cjs` `resolveDocumentLink` | `document links resolve relative references and reuse the network refusal` | STEP 94 `relative .md links, cross-document anchors and network-link refusal` | ✅ |

## 第 5 批：欢迎页、默认外观、侧栏、Windows 标题栏、中文化

| # | 修复 / 功能 | 代码位置 | 单测 | 桌面 STEP | 状态 |
| --- | --- | --- | --- | --- | --- |
| 5.1 | 欢迎页是「未修改」的命名文档（`欢迎使用.md`），首个打开的文件替换它，编辑后成为普通未保存文档 | `src/welcome.js`；`electron/main.cjs` | — | STEP 2 `welcome page starts unmodified as 欢迎使用.md`；STEP 85 `welcome page stays pristine, the first opened file replaces it, edits make it dirty`；STEP 86 `an edited welcome page behaves like a normal unsaved document` | ◐ |
| 5.2 | 默认外观下保留操作入口（侧栏开关、新建、主题、设置、菜单按钮） | `index.html` / `src/main.js` | — | STEP 1 `default Typora-like chrome (title bar, typography, paper, sidebar toggle)` | ◐ |
| 5.3 | 侧栏列出全部已打开文档：切换、未保存标记、键盘、关闭提示 | `src/main.js` `#open-documents` | — | STEP 76 `sidebar lists open documents: switch, dirty marker, keyboard, close prompt` | ◐ |
| 5.4 | Windows 单条 38px 标题栏：`titleBarOverlay`（随主题换色）+ 原生菜单按钮 + 全屏释放右侧留白 | `electron/main.cjs` `titleBarOverlay`；`src/styles.css` | — | STEP 3 `Windows title bar: one 38px row, native menu popup, theme-aware overlay` | ◐（仅非 darwin 分支） |
| 5.5 | 查找/替换面板中文化 | `src/editor.js` `search` 面板配置 | — | STEP 77 `find / replace panel is fully Chinese` | ✅ |
| 5.6 | 菜单与「移到回收站/废纸篓」提示中文化 | `electron/main.cjs` 菜单与 `dialog` | — | STEP 75（点「文件」菜单、断言确认框文案与按钮都用平台对应的“回收站/废纸篓”） | ✅ |
| 5.7 | 工作台外观可一键切回（标签栏/工具栏/完整状态栏） | `src/main.js` `uiMode` | — | STEP 4 `switch back to the full workbench`；STEP 33 `optional toolbar-free layout` | ✅ |
| 5.8 | 默认主题排版（16px/1.6、860px、纯白、`pristine` 整篇渲染） | `tokens.css` / `src/styles.css` / `src/editor.js` | — | STEP 1 | ✅ |
| 5.9 | macOS 红绿灯位置跟随标题栏高度 | `electron/main.cjs` `trafficLightPosition` | — | — | 无覆盖（需 macOS） |

## 第 6A 批：搜索、会话、文件树、链接跳转、代码高亮、实时预览

| # | 修复 / 功能 | 代码位置 | 单测 | 桌面 STEP | 状态 |
| --- | --- | --- | --- | --- | --- |
| 6A.1 | 文件夹全文搜索：逐行匹配、分组结果、片段窗口、上限、跳过 `node_modules` 等目录 | `electron/search.cjs` `searchFolder` / `searchText` / `snippetOf` | `literal search finds every occurrence in a line`；`case-sensitive matching can be switched on, and regex is opt-in`；`long lines are windowed around the first match`；`per-file and total limits cap a very repetitive file`；`folder search groups matches, skips node_modules and oversized files` | STEP 87 `folder search groups matches with highlighted snippets` | ✅ |
| 6A.2 | 未保存的编辑器内容覆盖磁盘字节参与搜索；命中后光标落到匹配处 | `electron/search.cjs` `overrides`；`src/main.js` | `unsaved editor content overrides the bytes on disk` | STEP 88 `unsaved editor content is searchable and a hit moves the caret to the match` | ✅ |
| 6A.3 | 搜索可取消；文件名校验（中文原因）；文件夹边界 | `electron/search.cjs` `validateEntryName` / `inside` | `a cancelled token stops the walk`；`file names are validated with Chinese reasons`；`the inside() boundary rejects paths outside the opened folder` | STEP 90–92 | ✅ |
| 6A.4 | 最近文件/文件夹列表（去重、上限、缺失项剔除） | `electron/session.cjs` `WorkspaceState` | `recent lists keep the newest entry first, never duplicate and stay capped`；`pruneMissing drops entries whose file disappeared` | STEP 89 `recent files menu lists documents and offers a clear action` | ✅ |
| 6A.5 | 独立文件或工作区会话恢复，正常退出保留打开的文档及活动文档 | `electron/main.cjs` `bootstrap` / `finishQuit`；`electron/session.cjs` | `test/session.test.js` | STEP 103 覆盖有文件夹的会话，`test/rfc0001-desktop.mjs` 覆盖独立文件 | ✅ |
| 6A.6 | 文件树新建文件/文件夹 | `electron/main.cjs` `createEntry`；`electron/search.cjs` `validateEntryName` | `file names are validated with Chinese reasons` | STEP 90 `file tree creates files and folders` | ✅ |
| 6A.7 | 文件树重命名迁移打开和已关闭文件的保存历史，拒绝改名工作区根目录 | `electron/main.cjs` `renameEntry`；`electron/store.cjs` `rekey` / `moveHistory` | `test/store.test.js` 覆盖已打开文档及目录迁移 | STEP 91、98、100；`test/rfc0001-desktop.mjs` 覆盖已关闭文件的历史 | ✅ |
| 6A.8 | 文件树移到回收站（未保存文档先确认并保留正文） | `electron/main.cjs` `trashEntry`；`store.detach` | `detaching a deleted file keeps its text as an unsaved document` | STEP 92 `file tree trash confirms dirty documents and keeps the text`；STEP 99 `trashing a folder turns its open documents into unsaved ones` | ✅ |
| 6A.9 | 文件树刷新（外部程序新建的文件能被发现） | `electron/main.cjs` `refreshFolder` | — | STEP 93 `file tree picks up a file created by another program` | ◐ |
| 6A.10 | 本地 `.md` 链接分类、百分号解码、纯锚点/外链/未知协议区分 | `src/links.js` `splitLinkTarget` | `relative Markdown links are classified as local`；`percent-encoded Chinese names and spaces are decoded`；`pure anchors, web links and unsupported schemes`；`UNC and device paths stay local so the main process can refuse them`；`linkAt finds the inline link under the caret, but never an image` | STEP 94 | ✅ |
| 6A.11 | 跨文档锚点按渲染层 slug 解析（含中文标题） | `src/links.js` `headingForAnchor` | `anchors resolve against the renderer slugs` | STEP 94 | ✅ |
| 6A.12 | 链接目标坚决不执行/不联网（可执行扩展名 + 网络路径） | `electron/assets.cjs` | `executable and script targets are refused before anything can run them`；`document links resolve relative references and reuse the network refusal` | STEP 101；STEP 102 | ✅ |
| 6A.13 | 活跃代码块语法高亮（`@codemirror/language-data`） | `src/editor.js` 语言配置 | — | STEP 95 `active code block gets syntax tokens, on-demand haskell included` | ◐ |
| 6A.14 | highlight.js 按需加载（核心语言内置，其余动态 import，导出前预取） | `src/highlight.js` | **本轮新增** `fenceLanguages lists every fenced label once, in order, and skips diagrams`；`the preloaded grammars highlight immediately`；`a document label nobody can load stays plain instead of hanging`；`a non-preloaded grammar arrives on demand and answers to its alias` | STEP 95 | ✅ |
| 6A.15 | 公式块实时预览（输入时更新，语法错误可见） | `src/editor.js` / `src/markdown.js` | — | STEP 96 `formula block preview updates while typing and reports syntax errors` | ◐ |
| 6A.16 | Mermaid 图表实时预览（错误可见、不可编辑） | `src/editor.js` / `src/markdown.js` | — | STEP 97 `diagram block preview renders, reports errors and is not editable`；STEP 9 `math + Mermaid` | ◐ |

## 无自动覆盖项

| 项 | 原因 | 补测成本 |
| --- | --- | --- |
| 真实系统中文 IME（候选窗口、退格、快速连打） | 需要 Windows/macOS 真实输入法与人手操作；现有 STEP 47 用 CDP `Input.imeSetComposition` 模拟组合、确认、源码完整性 | 需实机与人工，无法自动化 |
| macOS 专属行为：红绿灯位置、Finder 文件关联、Cmd 快捷键矩阵、Dock 最近文件 | 本轮只有 Windows 11 机器，macOS 未复测 | 需 macOS 实机 |
| `npm run visual` 的视觉结论（无裸露语法、无重叠/裁切、深色复选框对比度） | 脚本只产出 8 张 PNG，判断依赖人眼，没有任何像素断言 | 可做基线图对比，但截图对字体/缩放敏感，易产生假失败 |
| 输入延迟目标（30k ≤ 50ms/键，100k ≤ 150ms/键） | `test/perf.mjs` 对目标值只报告（依赖宿主机器）；已加宽松上限：超过目标 3 倍或图表被重建时退出码为 1，但不在 CI 中运行 | 只拦截明显退化 |
| 自定义主题 CSS 的 `@import` 剥离 | 逻辑内联在 `electron/main.cjs` 的 `readTheme` IPC 处理函数里（`css.replace(/@import[^;]*;/gi, '')`），没有可导入的纯函数 | 需要先把该逻辑提到可导出模块（改产品代码，本轮范围外） |
| Windows 安装包与文件关联双击 | 本轮按要求未打包，未生成 NSIS；STEP 78 只覆盖命令行传参 | `npm run package:win` + 实机安装/卸载 |
| 非 100% 系统缩放下的像素级拖动 | 桌面用例在像素拖动前会先复位缩放（CDP 坐标与 CSS 坐标在缩放下不一致） | 需按 DPI 矩阵参数化 |
| 跨进程并发写同一文件 | 冲突语义本身未定义（只有应用内多窗口隔离被验收） | 需要先定义语义 |

## 本轮新增测试

`test/highlight.test.js`（4 项）——第 6A 批「highlight.js 按需加载」原本只有 STEP 95 的端到端断言（页面上出现 token），没有约束「文档请求了哪些语言」「未加载语言如何回退」「语言包到达后别名是否注册」这些纯逻辑。该文件只 import `src/highlight.js`，不启动 Electron，属于低成本补测；未改动任何产品代码，也未放宽既有断言。

补充：`npm test` 总数因此从 136 项变为 **140 项**；`node test/desktop.mjs` 仍是 **103 步**。
