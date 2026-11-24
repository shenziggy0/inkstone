# 墨页 × Typora 对等基准（基线 v0.1）

菜单、偏好和后续逐项验收见[macOS 功能对齐清单](parity/Typora-macOS功能对齐清单.md)。

2026-11-24 的全项目复测、同源文件双端比较和当前差距见[最新复测报告](evidence/2026-11-24-Typora全项目功能复测.md)。

2026-11-07 · 最初对应 `HANDOFF.md`「接手顺序」第 1 步，现已作为**逐轮收敛的对照基准**（第 1 轮：基准 + 字符级定位；第 2 轮：整篇解析上下文、语法、命令矩阵、主题/历史/外部变更；第 3 轮：表格编辑、剪贴板、快速打开、缩放记忆；第 4 轮：即时编辑交互与全新工作台界面；第 5 轮：文件/窗口/导出、版本 diff、大纲重排与性能；第 6 轮：活跃块排版态、表格就地输入与列宽、表情、多窗口、Pandoc 降级；第 7 轮：语法「输入即排版」规则对齐；第 8 轮：无正文块前缀即时排版与渲染层一致性；第 9 轮：IME 组合输入期间保持全文排版；第 10 轮：界面外观与默认主题排版完全向 Typora 对齐；第 11 轮：审查问题闭环；**2026-11 审计修复（第 1～6A 批）**：数据安全、按块渲染缓存、活跃块排版重写、图片与资源路径统一解析、欢迎页与 Windows 标题栏、中文化、文件夹搜索、最近文件与会话恢复、文件树操作、本地链接跳转、按需代码高亮、公式与图表实时预览）。状态列只在实际验证通过后更新，⧗ 不算完成；本轮更新依据是 `npm test` 140 项、Windows 11 上 `node test/desktop.mjs` 的 103 个 STEP 与 `node test/perf.mjs`。

## 0. 基准冻结与口径

| 项 | 冻结值 |
| --- | --- |
| Typora 对照版本 | **稳定版 1.14.15**（2026-10-25 发布），基线日期 2026-11-07 |
| 对照依据 | [Typora 功能页](https://typora.io/)、[Markdown 语法参考](https://support.typora.io/Markdown-Reference/)、[快捷键参考](https://support.typora.io/Shortcut-Keys/)、[稳定版发布记录](https://www.typora.io/releases/stable) |
| 墨页对照版本 | 0.1.0（本次推进后的工作树；`npm start` 为验收入口，`dist/` 与 `release/` 内的旧包不参与对照） |
| macOS 环境 | Apple Silicon，Node.js 22.x / Electron 45.2.3，`npm ci && npm start`。**2026-11 审计轮未复测 macOS**，上一轮记录仍按下表状态保留 |
| Windows 环境 | **Windows 11 x64 实机，Node.js 26.13.0 / npm 11.20.0 / Electron 45.2.3**，以 `npm start`（源码 + 当前 `dist/`）验收；`npm test` 140 项通过、`node test/desktop.mjs` 103 步通过、`node test/perf.mjs` 通过。`release/win-unpacked/` 未参与本轮验收，NSIS 安装器仍未生成 |
| 平台快捷键写法 | macOS `Command/Option/Control`，Windows `Ctrl/Alt/Shift`；墨页菜单统一用 Electron `CmdOrCtrl` 映射 |

状态图例：`✅` 已实现且有自动回归 · `◐` 部分实现或有行为偏差 · `✗` 未实现 · `⧗` 本环境无法闭环（需 macOS 实机 / Pandoc / 真实系统中文 IME / 签名公证）。状态只在实际验证通过后更新，本轮（2026-11 审计修复，第 1～6A 批）只改动被桌面 STEP 或单测真实覆盖的条目。

每条用例按 **输入 → 操作 → 预期表现** 记录；「验收」列给出可执行的复测方式。所有语法类用例统一使用 §8 的同一批样例。

## 1. 命令与快捷键

预期值取自 Typora 官方快捷键页；「墨页」列取自 `electron/main.cjs` 的菜单定义与 `src/editor.js` 的 keymap。

| # | 功能 | 输入 | 操作 | macOS 预期 | Windows 预期 | 墨页现状 | 状态 | 验收 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.1 | 新建 | 空文档 | 按快捷键 | Command+N | Ctrl+N | `CmdOrCtrl+N` | ✅ | 桌面用例已覆盖新文档 |
| 1.2 | 新建窗口 / 标签 | 已打开文档 | 按快捷键 | Command+Shift+N / Command+T | Ctrl+Shift+N / 不支持 | 新建标签（macOS Command+T / Windows Ctrl+Alt+N）与**独立新窗口**均已实现；每个窗口持独立 `DocumentStore` / 恢复目录，IPC 按调用窗口路由，菜单按活动窗口发送命令 | ✅ | 桌面用例 `independent new window with its own document store` |
| 1.3 | 打开 | `sample.md` | 按快捷键 | Command+O | Ctrl+O | `CmdOrCtrl+O` | ◐ | 桌面用例覆盖保存，未覆盖打开对话框 |
| 1.4 | 打开文件夹 / 快速打开 | 含 md 的目录 | 按快捷键 | Command+Shift+O（Typora 为 Open Quickly） | Ctrl+P（Open Quickly） | 已补 `CmdOrCtrl+P`「快速打开」（合并文件树与已打开文档，支持文件名筛选）；`CmdOrCtrl+Shift+O` 仍是打开文件夹，macOS 语义与 Typora 不完全一致 | ◐ | 桌面用例覆盖快速打开面板 |
| 1.5 | 重新打开已关闭文件 | 关闭一个标签 | 按快捷键 | Command+Shift+T | Ctrl+Shift+T | 已实现（`recentlyClosed` 栈 + `reopenClosed`） | ✅ | 菜单/快捷键矩阵 |
| 1.6 | 保存 / 另存为 | 已命名文档 | 按快捷键 | Command+S / Command+Shift+S | Ctrl+S / Ctrl+Shift+S | 一致 | ✅ | 桌面用例覆盖保存与外部冲突 |
| 1.7 | 偏好设置 | 任意 | 按快捷键 | Command+, | Ctrl+, | Windows 已在「文件」菜单补齐偏好设置项与 `Ctrl+,`；两平台一致 | ✅ | 两平台菜单检查 |
| 1.8 | 关闭文档 | 有未保存改动 | 按快捷键 | Command+W | Ctrl+W | 一致，弹「保存/取消/不保存」 | ◐ | 手工（含取消分支） |
| 1.9 | 撤销 / 重做 | 输入后立即 | 按快捷键或点菜单 | Command+Z / Command+Shift+Z | Ctrl+Z / Ctrl+Shift+Z | 菜单转交 CodeMirror，keymap 同时绑定 | ✅ | 桌面用例已覆盖，**回归点** |
| 1.10 | 查找 / 替换 / 下一个 | 多段文本 | Command+F 等 | Command+F / Command+H / Command+G | Ctrl+F / Ctrl+H / F3 | 已补齐 `CmdOrCtrl+H` 替换与菜单项，下一个/上一个沿用 CodeMirror `searchKeymap`（Command+G / F3）与面板按钮 | ◐ | 快捷键逐项比对 |
| 1.11 | 复制为 Markdown / HTML · 粘贴为纯文本 | 渲染态选区 | 按快捷键 | Command+Shift+C / Command+Shift+V | Ctrl+Shift+C / Ctrl+Shift+V | 三个命令均已实现并走原生剪贴板（Electron 45 W3C API）；复制为 HTML 无独立快捷键，走编辑菜单。渲染态跨块选区仍不可用，复制默认为整篇/源码选区 | ◐ | 桌面用例覆盖剪贴板 HTML 与 Markdown |
| 1.12 | 标题 1–6 / 正文 / 升降级 | 光标在段落 | 按快捷键 | Command+1…6 / Command+0 / Command+= - | Ctrl+1…6 / Ctrl+0 / Ctrl+= - | 已补齐正文 `Mod-0`、提升 `Mod-=`、降低 `Mod--` 与菜单项 | ✅ | 快捷键矩阵 |
| 1.13 | 代码块 / 公式块 | 光标在段落 | 按快捷键 | Command+Option+C / Command+Option+B | Ctrl+Shift+K / Ctrl+Shift+M | macOS 菜单已改为 `Command+Option+C/B`，Windows 保持 `Ctrl+Shift+K/M`，与 Typora 一致 | ✅ | 快捷键矩阵 |
| 1.14 | 插入表格 | 空行 | 按快捷键 | Command+Option+T | Ctrl+T | 已补齐两套平台快捷键与菜单项 | ✅ | 快捷键矩阵 |
| 1.15 | 引用 / 有序无序列表 / 缩进反缩进 | 选中多行 | 按快捷键 | Command+Option+Q / O / U / Command+[ ] | Ctrl+Shift+Q / [ ] / Tab | 已补齐引用、有序/无序列表、缩进/反缩进命令与平台快捷键 | ✅ | 快捷键矩阵 |
| 1.16 | 粗体 / 斜体 / 链接 | 选中文字 | 按快捷键 | Command+B / I / K | Ctrl+B / I / K | 一致 | ✅ | 桌面用例覆盖源码切换与格式命令入口 |
| 1.17 | 行内代码 / 删除线 / 下划线 / 清除格式 | 选中文字 | 按快捷键 | Command+Shift+` / Control+Shift+` / Command+U / Command+\ | Ctrl+Shift+` / Alt+Shift+5 / Ctrl+U / Ctrl+\ | 四个命令均已实现（`Mod-Shift-\``、`Mod-U` 插入 `<u>`、`Mod-\` 清除标记）；下划线/清除格式在菜单中未绑定特殊字符加速器，靠编辑器 keymap | ✅ | 快捷键矩阵 |
| 1.18 | 插入图片 | 光标在段落 | 按快捷键 | Command+Control+I | Ctrl+Shift+I | 已补齐两套平台快捷键；选择文件 / 粘贴 / 拖放三个入口保持 | ✅ | 快捷键矩阵 |
| 1.19 | 源码模式 | 渲染态 | 按快捷键 | Command+/ | Ctrl+/ | 一致；切换后恢复编辑器焦点 | ✅ | 桌面用例覆盖，**回归点** |
| 1.20 | 侧边栏 / 大纲 / 文章列表 / 文件树 | 任意 | 按快捷键 | Command+Shift+L / Command+Control+1…3 | Ctrl+Shift+L / Ctrl+Shift+1…3 | 已补齐大纲与文件树两套平台快捷键；「文章列表」概念在墨页中合并到文件树，仍无独立面板 | ◐ | 快捷键矩阵 |
| 1.21 | 专注 / 打字机 / 全屏 | 任意 | 按快捷键 | F8 / F9 / Command+Option+F | F8 / F9 / F11 | 已补齐 F8 专注、F9 打字机、macOS Command+Option+F 全屏，Windows 保留 Electron 全屏 role | ✅ | 桌面用例覆盖打字机与主题切换 |
| 1.22 | 切换文档 / 缩放 | 多标签 | 按快捷键 | Command+` / 缩放部分不支持 | Ctrl+Tab / Ctrl+Shift+= | 已补齐切换文档（macOS Command+` / Windows Ctrl+Tab）与实际大小/放大/缩小 | ✅ | 快捷键矩阵 |
| 1.23 | 导出 | 已保存文档 | 按快捷键 | 官方未列 | 官方未列 | `CmdOrCtrl+Shift+E` 为墨页自定义 | ◐ | 桌面用例覆盖 HTML/PDF |

## 2. 语法扩展与渲染

| # | 特性 | 输入（见 §8 样例） | 操作 | Typora 预期 | 墨页现状 | 状态 | 验收 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2.1 | 标题与大纲 | 六级标题 + 重复标题 | 打开文档 | 大纲列出全部标题，重复标题锚点自动加序号 | 已改为整篇一次解析 + 共享 `env` 逐块渲染；桌面用例断言 `标题` / `标题-2`，无冲突时兼容旧链接 `#标题-1` | ✅ | 桌面用例 `cross-block rendering parity` |
| 2.2 | 行内样式 | `**粗**` `*斜*` `~~删~~` `` `码` `` | 逐字符输入，光标停在闭合标记后 | 语法一闭合立即排版，光标进入该元素时才显现源码 | **输入即排版已实现**：`src/live-preview.js` 把成对语法归为一个编辑组，闭合标记后的光标视为组外 → 立即隐藏语法；光标进入组（或选区覆盖）才显现淡化源码。桌面用例逐字符验证 `**`、反引号、`# `、`- `、`1. ` | ✅ | 桌面用例 `immediate typeset on closing delimiter` + `immediate heading, bullet, ordered list and code span typesetting` |
| 2.3 | CJK 强调 | `中文**加粗**中文` | 输入 | 中文与标记之间无需空格即可正确加粗 | 已验证紧贴加粗可渲染；标点边界、中英混排未验收，IME 组合输入行为已用 CDP 模拟验收（真实系统 IME 实机仍待） | ⧗ | 同批样例 + 系统中文 IME |
| 2.4 | 链接（行内 / 引用式 / 内部） | `[文字](url)`、`[文字][id]` + 定义块、`[跳转](#标题)` | Cmd/Ctrl+点击 | 引用式链接正确解析；内部链接跳转章节 | 共享 `env.references` 后引用式链接可用；桌面用例断言解析出的 `<a href>` | ✅ | 桌面用例 + 单测 |
| 2.5 | 脚注 | `正文[^1]` + `[^1]: 内容` | 悬停 / 点击 | 悬停显示脚注内容 | 共享 `env.footnotes` 后正文上标与文末脚注区均可渲染；引用链接带脚注全文悬停提示 | ✅ | 桌面用例 + 单测 |
| 2.6 | 文内目录 | `[toc]` 单独成块 | 打开文档 | 自动列出全文标题并随编辑更新 | 目录由整篇 `headings()` 生成；`renderBlocks` 按整篇文本缓存，文档变更后逐个 widget 用新 HTML 重绘，目录会随之刷新 | ✅ | 桌面用例 `cross-block rendering parity` 断言条目数 ≥ 2 |
| 2.7 | YAML Front Matter | `---\ntitle: x\n---` 开头 | 打开 / 未修改保存 | 作为元数据块渲染，导出时可用 | 新增 `front_matter` block rule，渲染为属性卡片；原文仍逐字节保留 | ✅ | 单测 + 桌面用例 |
| 2.8 | 表格 | GFM 表格 + 冒号对齐 | 点击单元格 | 就地编辑单元格、增删行列、拖动调整、对齐 | 单击渲染态单元格**直接就地输入并选中该单元格源码**（Alt+单击/右键仍开图形化编辑器）；Enter 追加行、Tab/Shift+Tab 走单元格；拖动表头右边缘调整列宽并把宽度写入文档末尾不可见注释，重开与导出保持。图形化编辑器保留改值、增删行列、逐列对齐 | ✅ | 桌面用例 `graphical table editing`、`in-place table cell editing`、`Enter appends a table row`、`draggable table column widths` |
| 2.9 | 任务列表 | `- [ ] 项` | 点击复选框 | 切换完成态并回写源码 | 已实现（桌面用例覆盖） | ✅ | 桌面用例 |
| 2.10 | 代码高亮 | 带语言围栏 | 打开 / 在活跃块输入 | 约 100 种语言高亮 | 阅读层用 highlight.js 渲染（语言徽标为生成文本，已排除出源码映射）；活跃代码块同样高亮，语言由 `@codemirror/language-data` 提供。核心 18 种语言内置，其余按需动态 import（`src/highlight.js`），导出前预取文档用到的语言包 | ✅ | `test/highlight.test.js`（4 项）+ 桌面 STEP `active code block gets syntax tokens, on-demand haskell included` |
| 2.11 | 公式 | `$...$` / `$$...$$` / `\(…\)` / `\[…\]` | 打开 / 导出 | MathJax，可编号 | texmath 同时启用 `dollars` + `brackets` 两套分隔符；公式自动编号作为偏好开关（CSS 计数器作用于 `.katex-display`）。**引擎为 KaTeX 而非 MathJax**，宏支持范围不同 | ✅ | 单测 + 桌面用例（两种分隔符 + 编号开关） |
| 2.12 | 图表 | `mermaid` 围栏 | 打开 | Mermaid 多图类型 + 错误提示 | Mermaid 12，SVG 文字标签（**回归点**）；解析失败时在块内显示可见错误信息与原始源码；主题切换调用 `refreshDiagrams` 重绘已渲染图 | ✅ | 桌面用例覆盖节点文字 + 主题切换 |
| 2.13 | 警示块 / Callouts | `> [!NOTE]` | 打开 | GitHub 风格警示块 | 新增 `blockquote_open` 渲染规则，支持 NOTE / TIP / IMPORTANT / WARNING / CAUTION 五种类型与中文标签，普通引用不受影响 | ✅ | 单测 + 桌面用例 |
| 2.14 | 表情 / 上下标 / 标记 / 分割线 / 引用 / 水平线 | `:smile:` `H~2~` `x^2^` `==高亮==` 等 | 打开 / 输入 `:smi` | 即时渲染 + 短代码补全 | 已装 emoji / sub / sup / mark 插件；新增 `:shortcode` 自动补全与可搜索表情选择器（`⌘/Ctrl+P` 命令面板入口） | ✅ | 桌面用例 `emoji shortcode autocomplete`、`searchable emoji picker` |
| 2.15 | 图片 | `![alt](assets/a.png)` | 打开 / 导出 / 另存为 | 显示图片，相对路径可配置 | `inkstone-asset://` 协议 + 导出时内嵌，解析统一由 `electron/assets.cjs` 负责：相对路径、`../`、绝对路径、`file:///` 都支持且必须真实存在、扩展名在白名单内；UNC / 设备路径 / 带 host 的 `file://` 在第一次文件系统调用前拒绝；未保存文档的图片进入临时目录并在首次保存时迁移；另存为/重命名只搬运被引用的 `assets/` 并改写引用 | ✅ | 桌面 STEP `image paths (encoded, angle-bracket, ../, absolute, http) render and export inlines local ones`、`Save As keeps rewritten asset references in the editor`、`unsaved document inserts an image, shows it, and migrates it on Save As` + `test/assets.test.js` |
| 2.16 | 实时预览（公式 / 图表） | `$$…$$` 公式块与 mermaid 围栏 | 在活跃块里输入 | 输入过程中即时预览，语法错误可见 | 活跃块内的公式与 Mermaid 块随输入实时重渲：公式出现语法错误时块内显示错误信息，图表渲染成功后不接受编辑（点击即回到源码），主题切换会重绘已有图表 | ✅ | 桌面 STEP `formula block preview updates while typing and reports syntax errors`、`diagram block preview renders, reports errors and is not editable` |

## 3. 打开与保存

| # | 用例 | 输入 | 操作 | 预期表现 | 墨页现状 | 状态 | 验收 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3.1 | UTF-8 BOM / CRLF 保真 | 带 BOM+CRLF 的文件 | 打开后未修改直接保存 | 逐字节一致 | 存储测试覆盖 | ✅ | `npm test` |
| 3.2 | 混合换行 | LF/CRLF 混排 | 编辑中间一行再保存 | 不改动的换行保持不变 | `src/eol.js` 记住每一行自己的行尾，只把编辑区域按文件主流行尾归一；BOM 不会被重复写入。桌面用例直接对比保存后的字节 | ✅ | `test/eol.test.js`（4 项）+ 桌面 STEP `mixed newline file keeps per-line endings on edit and unchanged save` |
| 3.3 | 外部修改冲突 | 文件被另一程序改写 | 保存 | 拦截覆盖并提示 | 已实现，桌面用例覆盖 | ✅ | 桌面用例 |
| 3.4 | 外部删除冲突 | 文件被删除 | 保存 | 拦截重建并提示 | 存储测试覆盖 | ✅ | `npm test` |
| 3.5 | 同文件多标签 | 两个标签指向同一路径 | 另存为同名 | 拒绝覆盖 | 存储测试覆盖 | ✅ | `npm test` |
| 3.6 | 同文件不同路径写法 | `/tmp/x` 与 `/private/tmp/x` | 打开 + 保存 | 视为同一文件 | 真实路径解析修复（**回归点**） | ✅ | 存储测试 |
| 3.7 | 实时外部变更 | 文件在编辑器外被改 | 不点保存 | 提示重新加载 / 保留本地副本 | 主进程每 2 秒轮询已保存文件的摘要，变更时推送提示；对话框可「重新加载磁盘版本」或「保留本地内容」，保存冲突检查保留 | ✅ | 桌面用例 `external change notification` |
| 3.8 | 恢复副本 / 版本历史 | 崩溃后重启 | 打开 | 界面内可浏览并恢复历史版本 | 新增「保存历史」对话框：按时间列出历史版本、可预览前 4000 字符、可恢复到当前文档并标记未保存；恢复副本机制保留 | ✅ | 桌面用例 `version history dialog` |
| 3.9 | 重命名 / 移动 / 废纸篓 | 已保存文档 | 文档菜单 / 文件树操作 | 引用与资源同步、可撤销 | 重命名走 `rekey()`（同时迁移路径、标签与历史目录），移到回收站走 `shell.trashItem`，未保存文档先确认再 detach 保留正文；文件夹重命名 / 回收站会同步处理其中已打开文档；工作区根目录拒绝重命名与回收站。另存为/重命名时同步 `assets/` 引用 | ✅ | 桌面 STEP `file menu + palette reach rename / reveal / trash / diagram…`、`file tree rename renames the file and the open tab`、`file tree trash confirms dirty documents and keeps the text`、`renaming a folder moves the open document with it`、`trashing a folder turns its open documents into unsaved ones`、`the workspace root refuses rename / trash but allows create / reveal` |
| 3.10 | 多窗口 / 外部程序同时写 | 两个实例 | 同时编辑 | 单实例锁 + 冲突提示 | 单实例锁 + `second-instance` 文件入队保留；应用内独立新窗口各自持有文档存储（桌面用例验证互不污染）；**跨进程并发写同一文件仍未定义** | ◐ | 桌面用例 + Windows 实机 |
| 3.11 | 文件夹全文搜索 | 含 md 的目录 | `Ctrl/Cmd+Shift+F` | 分组结果、命中高亮、片段、可取消 | `electron/search.cjs` 在主进程遍历（跳过 `node_modules`/`.git`/`dist` 等，单文件 >5MB 跳过），逐行匹配并给出片段；默认按字面量、可切分大小写与正则；未保存的编辑器内容覆盖磁盘字节，命中后光标跳到匹配处；单文件 20 条 / 总计 500 条上限并标记截断 | ✅ | `test/search.test.js`（9 项）+ 桌面 STEP `folder search groups matches with highlighted snippets`、`unsaved editor content is searchable and a hit moves the caret to the match` |
| 3.12 | 最近文件 / 会话恢复 | 关闭后重开 | 菜单「最近打开的文件」 | 列出最近文档、可清除 | `electron/session.cjs` 记录最近文件（去重、上限 20）与文件夹（上限 10），会话记录文件夹 + 最多 30 个文档 + 当前文档；缺失项与网络位置在加载时剔除，启动时按会话恢复 | ✅ | `test/session.test.js`（5 项）+ 桌面 STEP `recent files menu lists documents and offers a clear action`、`session restore reopens the folder, its documents and the active one` |
| 3.13 | 文件树新建 / 重命名 / 回收站 / 刷新 | 已打开文件夹 | 文件树右键或命令 | 新建、重命名、删除、刷新 | 文件树支持新建文件/文件夹、重命名（同步标签与历史）、移到回收站（脏文档先确认并保留正文）、刷新发现外部新建的文件；名称经 `validateEntryName()` 校验（Windows 保留名、非法字符、首尾句点/空格、空名，中文原因），路径经 `inside()` 边界检查 | ✅ | `test/search.test.js` 中的文件名校验 / 边界用例 + 桌面 STEP `file tree creates files and folders`、`file tree picks up a file created by another program` |
| 3.14 | 本地 `.md` 链接与跨文档锚点 | `[文字](./b.md#标题)` | Cmd/Ctrl+点击 | 打开相对路径文档并跳到锚点，拒绝网络与可执行目标 | `src/links.js` 分类链接目标（锚点 / 外链 / 本地），百分号编码的中文与空格会解码，锚点按渲染层 slug 匹配；主进程解析真实路径，UNC 与带 host 的 `file://` 一律拒绝，可执行/脚本扩展名（含 `PATHEXT`）拒绝且不会交给 shell | ✅ | `test/links.test.js`（6 项）+ `test/assets.test.js` 的链接/可执行用例 + 桌面 STEP `relative .md links, cross-document anchors and network-link refusal`、`a link to an executable is refused and never reaches the shell` |

## 4. 导入与导出

| # | 格式 | 输入 | 操作 | 预期表现 | 墨页现状 | 状态 | 验收 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4.1 | HTML | 含公式、本地图片 | 导出 | 自包含、样式与图片内嵌、目录锚点可用 | 公式字体与本地图片内嵌已实现，桌面用例校验字体；**分页与视觉结果未验收** | ◐ | 导出后浏览器打开比对 |
| 4.2 | PDF | 含标题层级 | 导出 | 书签/大纲、正确分页、可打印 | `generateDocumentOutline: true`；书签与分页未专项验收 | ◐ | 桌面用例仅校验 `%PDF` 文件头 |
| 4.3 | DOCX / ODT / EPUB / LaTeX / RST | 同批样例 | 导出 / 导入 | 双向转换、图片与公式保留 | 走 Pandoc，**本机未安装**；已补能力探测：未安装时导出对话框中对应格式按钮禁用，导入 HTML 走无依赖清洗，错误信息明确提示安装 Pandoc | ⧗ | 桌面用例 `Pandoc capability gating in export dialog` + 安装 Pandoc 后逐格式 |
| 4.4 | 复制为 HTML / Markdown | 渲染态选区 | 复制 | 保留或去除主题样式 | 已实现（走原生剪贴板，HTML 与纯文本同时写入）；受 §7 跨块选区限制 | ◐ | 桌面用例 `copy as HTML / Markdown` |
| 4.5 | 自定义导出主题 | 已装自定义主题 | 导出 PDF/HTML | 导出使用指定主题 | 导出 HTML 会内联全部样式表（含 `<style id="custom-theme">`），PDF 走同一套打印样式；桌面用例断言导出文件含自定义 CSS 变量 | ✅ | 桌面用例 `themed HTML export` |

## 5. 主题与界面

| # | 用例 | 输入 | 操作 | 预期表现 | 墨页现状 | 状态 | 验收 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.1 | 主题切换 | 浅/深/纸张/自定义 | 工具栏切换 / 偏好设置 | 编辑与图表同步换色 | 三主题 + 自定义 CSS 已实现；切换时 `refreshDiagrams` 重绘已有 Mermaid 图并重新读取主题 | ✅ | 桌面用例覆盖深色切换与自定义主题 |
| 5.2 | 自定义 CSS 主题 | 用户 CSS | 放入主题目录 | 加载并可自动编号标题 | `userData/themes/*.css` 自动列入偏好设置并内联到导出；读取时剥离 `@import` 防远端加载；标题编号可由用户 CSS 计数器实现（无内置开关） | ✅ | 桌面用例 `custom CSS theme` |
| 5.3 | 字号 / 行宽 / 专注 / 打字机 / 拼写检查 | 偏好设置 | 修改并保存 | 立即生效并持久化 | 已实现，桌面用例覆盖打字机 | ✅ | 桌面用例 + 设置对话框 |
| 5.4 | 字号缩放、窗口与全屏状态 | 重启应用 | 恢复 | 保持上次缩放与窗口状态 | 缩放级别、窗口位置/尺寸、最大化状态均写入 `settings.json` 并在启动时恢复（拒绝把窗口恢复到屏幕外） | ✅ | 桌面用例 `persisted zoom level`、`persisted window bounds` |
| 5.5 | 窄屏无横向溢出 | 760×620 桌面窗口 | 设置窗口尺寸 | 根节点无横向溢出、编辑区可见 | 已在**桌面 Electron 窗口**（非浏览器预览）实测 760×620 无横向溢出 | ✅ | 桌面用例 `narrow desktop viewport` |
| 5.6 | 字数 / 字数统计 / 阅读时长 / 行列位置 | 中英混排 | 查看状态栏 | 与 Typora 口径一致 | 用 `Intl.Segmenter` 统计；口径未与 Typora 对照 | ◐ | 同批样例比对 |
| 5.7 | 默认界面外观 | 首次启动 | 打开窗口 | 单条 38px 标题栏（居中文件名 + 未保存圆点）、无品牌/标签/工具栏、侧栏默认隐藏、右下字数、纯白纸面 | 默认 `uiMode=typora`；偏好设置与命令面板可切回工作台（保留标签栏/排版工具栏/完整状态栏，功能零删减）；侧栏开合持久化、macOS 红绿灯跟随标题栏高度 | ✅ | 桌面用例 `default Typora-like chrome`、`switch back to the full workbench` + 初始/侧栏/工作台三张真实截图 |
| 5.8 | 默认主题排版 | §8 同一批样例 | 打开 / 输入 / 切换主题 | 16px/1.6、860px 列宽、h1/h2 细线下边框、纯白纸面、浅灰无边框代码块、蓝色链接、深色 Night 风格 | `tokens.css` + `src/styles.css` 按 Typora 默认主题重设；主进程默认偏好 16/860 且旧 `settings.json` 一次性迁移；刚打开且未交互的文档整篇渲染（`pristine`），点击后才展开活跃块，消除首行裸露 `#` | ✅ | 桌面用例字号/行高/列宽/纸面/整篇渲染断言 + 初始/输入态/深色截图 |
| 5.9 | 侧栏已打开文档 | 打开多个文档 | 展开侧栏 | 列出全部已打开文档，可切换、有未保存标记 | 侧栏 `#open-documents` 列出全部已打开文档：点击/键盘 Enter 切换、当前项 `aria-current` + 未保存圆点、关闭按钮对脏文档走保存提示。默认极简外观下侧栏隐藏，一键开合 | ✅ | 桌面 STEP `sidebar lists open documents: switch, dirty marker, keyboard, close prompt` |

## 6. 系统集成

| # | 用例 | macOS 预期 | Windows 预期 | 墨页现状 | 状态 | 验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 6.1 | 冷启动文件关联 | Finder 双击 .md 打开 | 资源管理器双击 .md 打开 | `fileAssociations` 已配置（`md`/`markdown`），冷启动未实机验收 | ⧗ | 两平台冷启动 |
| 6.2 | 原生菜单与对话框 | 应用菜单在屏幕顶部 | 窗口内菜单 | Electron 原生菜单/对话框已实现。**Windows 11 实机已验证**：菜单栏默认隐藏，38px 标题栏上的「菜单」按钮调用 `Menu.popup` 弹出完整原生菜单，菜单项（文件/重命名/移到回收站/图表等）与保存、冲突、退出、回收站确认对话框均可用 | ✅（Windows）；macOS 本轮未复测 | 桌面 STEP `Windows title bar: one 38px row, native menu popup, theme-aware overlay`、`file menu + palette reach rename / reveal / trash / diagram…` |
| 6.3 | 系统中文拼音 IME | 组合输入、候选确认、退格不丢字 | 同左，另需 Ctrl 组合 | 组合期间**冻结已有排版**（不再清空装饰），CDP 模拟组合开始/更新/候选确认与源码完整性已自动化验收；**真实系统 IME 实机（含退格、候选窗口）未验收** | ⧗ | 两平台系统拼音 |
| 6.4 | 带中文与空格的路径 | 正常打开/保存 | 正常打开/保存 | 存储层用 `realpath` + 原子写；未专项 | ⧗ | 两平台 |
| 6.5 | 最近文件 / 在文件管理器中显示 | Dock 最近文件 | 跳转列表 | 应用内「最近打开的文件」菜单已实现（可清除、缺失项自动剔除，`test/session.test.js` 覆盖）；`addRecentDocument`（macOS Dock）与 `showItemInFolder` 在 Windows 上已验证可唤起资源管理器 | ✅（Windows 侧）；macOS Dock 集成本轮未复测 | 桌面 STEP `recent files menu lists documents and offers a clear action` |
| 6.6 | 安装包与卸载 | DMG / ZIP | NSIS 安装与卸载 | macOS 仅未签名开发包；Windows 仅解包目录，**NSIS 未构建** | ⧗ | `npm run package:win` + 实机 |
| 6.7 | 签名与公证 | 已签名已公证 | 已签名 | 均未做 | ⧗ | 发行流程 |
| 6.8 | 安全边界 | 隔离渲染进程 | 同左 | contextIsolation + sandbox + 自定义协议白名单 + 权限全拒 + DOMPurify 白名单（保留属性走 `FORBID_ATTR`，SVG/MathML 同规则）；资源路径在第一次文件系统调用前拒绝 UNC/设备/带 host 的 `file://`（防 NTLM 泄露），图片限白名单扩展名且 `realpath` 后复查，文档链接的可执行扩展名与 `PATHEXT` 类型一律拒绝；自定义主题 CSS 剥离 `@import` | ✅ | `test/assets.test.js`（12 项）+ 桌面 STEP `document-injected data-* attributes are inert…`、`openPath / openLocalFile / openFolderPath refuse network paths`、`a link to an executable is refused and never reaches the shell` |

## 7. 即时编辑行为（Typora 的核心差异）

| # | 用例 | 输入 | 操作 | 预期表现 | 墨页现状 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 7.1 | 点击渲染文字定位 | `# 标题 内容` | 点击渲染态的「内容」中间 | 光标落到对应源码字符，块展开为源码 | **本次已实现**：`src/source-map.js` 渲染文本↔源码字符对齐，桌面用例验证两个点击位置得到不同列号 | ✅ |
| 7.2 | 点击非文字区域 | 公式、图表、图片、目录、表格 | 点击 | 进入对应编辑器或落在源码标记处 | 公式/图表回退块首，图片落在 `![alt]` 的 alt，目录交给文档级跳转；表格单元格单击即就地输入，Alt+单击打开图形化编辑器 | ✅ |
| 7.3 | 行内标记显隐 + 输入即排版 | `**粗体**` | 逐字符输入；再把光标移入该元素 | 语法一闭合立即排版；只在光标所在元素显示标记 | **已实现**：活跃块为排版态 DOM，成对语法归为一个「编辑组」整体显隐。闭合标记后的光标算组外 → 立即隐藏语法；光标进入组或选区覆盖才显现淡化源码。单测锁死边界，桌面用例逐字符验证 `**`、反引号、`# `、`- `、`1. ` | ✅ |
| 7.4 | 跨块选区 | 从渲染块 A 拖到块 B | 拖动 / Shift+方向键 | 连续选区、复制、删除 | 已实现：`mousedown` 记录锚点，document 级 `mousemove` 反复解析命中点，拖过的块展开为源码行，松开后保留跨块选区 | ✅ |
| 7.5 | 连续撤销 | 连续输入 20 次 | 连续撤销 | 按合理粒度回退、不丢字 | `history({ minDepth: 100, newGroupDelay: 600 })`；桌面用例验证源码切换后连续输入合并为一次撤销且可重做 | ✅ |
| 7.6 | 大文档 | >200,000 源码字符 | 输入 / 滚动 | 保持流畅 | 超过 200,000 字符自动回退纯源码（桌面用例实测）；整篇解析按文档版本缓存，选区变化不重新 parse，段落编辑只重渲该块。`node test/perf.mjs` 在 Windows 11 实测每键平均 21.8 ms（5k）/ 37.9 ms（30k）/ 81.7 ms（100k），目标 50 / 50 / 150 ms；该脚本对目标值只报告，超过目标 3 倍时退出码为 1，增量解析与大文档长距离滚动仍未实测 | ◐ |
| 7.7 | 组合输入 | 系统拼音 | 输入 + 候选确认 + 退格 | 不吞字、不重复渲染 | 组合期间冻结排版装饰（`preview` StateField 返回既有 `DecorationSet`，文档变化时仅 `map` 位置），CDP 模拟组合/确认已验证不吞字不重复；真实系统 IME 实机未验收 | ⧗ |

**已知映射边界（7.1）**：当前采用「渲染文本是源码字符子序列」的贪心对齐，不解析 markdown-it inline token 的绝对位置。对长 HTML 属性中的同形字符、复杂转义实体仍可能偏移；§2 的跨块解析上下文已补齐，但 inline 绝对位置映射未做。CRLF 文档的偏移已按真实行分隔符换算。改动时务必保留六个既有回归点：`/tmp`↔`/private/tmp` 真实路径、撤销/重做交给 CodeMirror 且源码切换后恢复焦点、Mermaid 用 SVG 文字标签、点击渲染文字必须落到对应源码字符、跨块拖选必须产生覆盖多个渲染块的选区、打字机模式在选区非空时不得滚动居中且点击渲染块不得改变视口位置。

## 8. 同一批公开 Markdown 样例（回归语料）

两平台、每次改动后**必须使用同一批样例**，`docs/parity/fixtures/parity-sample.md` 为冻结的本地副本（覆盖下列全部类别），外部来源固定版本：

| 来源 | 固定版本 / 地址 | 覆盖 |
| --- | --- | --- |
| CommonMark Spec | 0.31.2 · <https://spec.commonmark.org/0.31.2/> | 段落、标题、列表、引用、代码、链接、转义、HTML 块 |
| GFM Spec | 0.29 · <https://github.github.com/gfm/> | 表格、任务列表、删除线、自动链接 |
| Typora Markdown Reference | <https://support.typora.io/Markdown-Reference/>（含 PDF 版） | 脚注、TOC、YAML、对齐表格、内部链接、警示块 |
| KaTeX / Mermaid 官方示例 | <https://katex.org/docs/supported.html> · <https://mermaid.js.org/syntax/flowchart.html> | 公式、流程图/时序图/甘特图、公式错误输入 |

固定语料文件：`docs/parity/fixtures/parity-sample.md`。建议回归顺序：① `npm test` + `node test/desktop.mjs`；② 用样例文件在 macOS 打开，逐项记录 §2 状态；③ 同一文件拷到 Windows，重复 ②；④ 原生模式下按 §1 快捷键矩阵逐项比对；⑤ 导出 HTML/PDF 并与 Typora 导出结果比对。

## 9. 当前结论与优先级

**结论：所有能在本机自动化验收的 Typora 对等项已闭合；剩余缺口依赖外部设备、系统输入法或商业证书。** 十轮推进后：

| 批次 | 已闭合 | 验证 |
| --- | --- | --- |
| 第 1 轮 | §7.1 字符级定位、基准与冻结语料 | 9 项映射单测 + 桌面用例 |
| 第 2 轮 | §1 命令矩阵（新建标签、重开、偏好、标题升降级、表格/引用/列表、缩进、格式、面板、缩放、切文档、清除格式）；§2 整篇共享 `env`（重复锚点、脚注、引用式链接、TOC、YAML、警示块、双分隔符、公式编号、图表错误与主题重绘）；§3.7 实时外部变更；§3.8 历史界面；§5.2 自定义 CSS | `npm test` + `node test/desktop.mjs` |
| 第 3 轮 | §2.8 图形化表格编辑（对话框式）、§1.11/§4.4 复制为 Markdown/HTML 与粘贴纯文本、§1.4 快速打开、§4.5 自定义主题随导出、§5.4 缩放记忆 | 6 项表格单测 + 5 个新增桌面步骤 |
| 第 4 轮 | §7.3 活跃块正文字体 + 仅淡化 Markdown 标记、§7.4 渲染态跨块拖选（自动展开为源码块）、§7.5 连续输入分组撤销；沉浸式标题栏、命令面板（命令+文件、键盘导航）、文章列表面板、可拖拽侧边栏、状态栏面包屑/编码/选区字数、代码块一键复制、图片双击放大、标题自动编号；修复打字机拖选抖动与点击后自动滚动两处体验缺陷 | 6 项新单测 + 8 个新增桌面步骤 |
| 第 5 轮 | §2.15 另存为/重命名同步 `assets/` 图片、§5.4 窗口尺寸/位置/最大化持久化、§5.6 汉字按字计数；版本历史逐行 diff、大纲拖拽重排整章、单次整篇解析缓存、表格 Tab/Shift+Tab 单元格跳转、20 万字以上回退纯源码 | 8 项新单测 + 6 个新增桌面步骤 |
| 第 6 轮 | §7.3 活跃块升级为排版态就地编辑（语法字符可隐藏、内容带真实排版样式）；§2.8 表格单击就地输入、Enter 追加行、拖动列宽；§2.14 表情短代码补全与选择器；§1.2 独立新窗口（每窗口独立 store）；§4.3 Pandoc 能力探测与 HTML 无依赖导入；图片右键复制；§5.5 桌面端窄屏验收；真实截图视觉检查（浅色/深色/命令面板/输入态） | 11 项新单测 + 10 个新增桌面步骤 |
| 第 7 轮 | **§7.3 语法「输入即排版」规则对齐 Typora**：改为按成对语法的「编辑组」判定显隐，闭合标记后的光标立即隐藏语法；修复 `-` / `- ` 被误判成表格分隔行导致项目符号延迟；有序列表前缀即时排版；新增逐字符桌面回归与 4 组边界单测 | 4 项新单测 + 2 个新增桌面步骤 + 输入态截图 |
| 第 8 轮 | **§7.3 无正文块前缀即时排版**：`-`、`- [ ]`、`- [x]`、`1.`、`>` 在行尾即为完整块前缀，最后一个字符敲下立即显示圆点/复选框/引用竖线；渲染层把纯 `[ ]` 的 `<li>` 也转成复选框，消除「离开块变回裸语法」；深色主题自绘复选框解决原生控件不可见 | 1 项新单测 + 2 个新增桌面步骤 + 前缀/深色截图 |
| 第 9 轮 | **§6.3/§7.7 IME 组合输入期间保持全文排版**：`liveDecorations()` 不再因 `composing` 清空全部装饰，`preview` StateField 改为冻结既有 `DecorationSet`（变化时仅 `map`），组合结束后重算；CDP 模拟组合开始/更新/候选确认，验证渲染块与活跃块排版均保持、中文不丢字不重复 | 1 个新增桌面步骤（含两个场景）+ 组合输入进行中的真实截图 |
| 第 10 轮 | **§5.7/§5.8 界面外观与默认主题排版向 Typora 对齐**：默认极简 chrome（38px 标题栏、隐藏品牌/标签/工具栏、侧栏隐藏、右下字数）、工作台一键切回；纯白 16px/1.6/860px 默认主题、标题细线、浅灰代码块、深色 Night 色板、旧偏好迁移；`pristine` 让刚打开且未交互的文档整篇渲染 | 2 个新增桌面步骤 + 3 张新增真实截图（初始/侧栏/工作台），原 41 步在工作台模式下全量回归 |
| 第 11 轮 | **审查问题闭环**：修复 CRLF 渲染点击错位、子窗口崩溃恢复遗漏、标题升降级命令被截获、代码块管道符误触发表格 Enter；Return/Shift+Return 对齐段落/软换行；转义、上下标、HTML 行内样式和表情在活跃块中保持排版；表格改为渲染态单元格直接编辑；导出目录使用真实标题锚点并补脚注悬停；浏览器预览与桌面默认参数一致 | 2 项新单测 + 4 个新增桌面步骤 + ego-browser 语法/表格真实界面复测 |
| 2026-11 审计（第 1～6A 批） | **数据安全**：原子写入与串行化、`realpath` 身份、外部改动/删除/保存失败保护、恢复副本与 `discarded/`、detach/rekey、BOM 与逐行混行保真、命令行路径。**渲染**：按块缓存与 widget 增量更新（主包 2,278 kB → 953 kB）、活跃块排版改用真实语法树（不变量「活跃块可见文本 = 渲染层纯文本」）。**资源安全**：图片/链接路径统一解析，拒绝 UNC/设备/带 host 的 `file://` 与可执行扩展名，DOMPurify 保留属性配置化，未保存文档临时图片目录与迁移。**界面**：欢迎页状态、默认外观入口、侧栏已打开文档、Windows 38px 标题栏 + `titleBarOverlay`、中文化。**能力**：文件夹全文搜索、最近文件与会话恢复、文件树新建/重命名/回收站/刷新、本地 `.md` 链接与跨文档锚点、活跃代码块高亮与 highlight.js 按需加载、公式与 Mermaid 实时预览 | `npm test` 140 项（新增 `test/highlight.test.js`）、Windows 11 上 `node test/desktop.mjs` 103 步、`node test/perf.mjs` 通过 |

`npm test` 共 **140 项通过**（16 个测试文件）；`npm run build` 通过（主包 `index-*.js` 952.98 kB / gzip 308.02 kB）；`node test/desktop.mjs` 在 **Windows 11 上 103 个 STEP 全部通过**（含原有全部回归、六个回归点与第 1～6A 批新增用例）；`node test/perf.mjs` 通过（100k 字符 81.7 ms/键，目标 150 ms）；`node test/visual-check.mjs` 生成初始、侧栏、浅色、深色、「刚输入完」、「三类空前缀」、组合输入进行中与工作台对照八张真实桌面截图，视觉结论仍靠人工检查。**macOS 本轮未复测。**

**新增回归点（第五、六条）**：跨块拖选必须产生覆盖多个渲染块的选区；打字机模式在选区非空时不得滚动居中，点击渲染块不得改变视口位置。测试中的像素拖动必须先复位缩放、关闭打字机模式并等待布局稳定，否则 CDP 坐标与页面 CSS 坐标不一致（第 7 轮列宽拖动步骤即因此把复位提前到该步骤之前）。

**仍未闭合（按优先级）**：

1. **活跃块排版态仍有差距**：窗口 chrome 与默认主题排版已按 Typora 对齐，但活跃块仍用 CodeMirror 行内装饰模拟排版，不是 Typora 的可编辑渲染 DOM；嵌套强调（`**粗 *斜* 字**`）的内层标记仍只淡化不隐藏；跨块拖选时中间块展开为源码行而非保持渲染高亮。原生菜单栏、系统窗口装饰与逐条主题 CSS 也非像素级复刻。
2. **§4.1/4.2 导出 HTML/PDF 的视觉与分页结果**、**§4.3 Pandoc 全格式**（本机未安装，已做能力探测与清晰降级）。
3. **§6 剩余**：Windows 11 实机自动化与原生菜单已在 2026-11 轮通过（§6.2 / §6.5），仍未闭环的是冷启动文件关联双击（STEP 78 只覆盖命令行传参）、非 100% 系统缩放下的像素拖动、真实中文 IME 与中文空格路径（§6.3 / §6.4）、NSIS 安装卸载（§6.6）、签名公证（§6.7），以及 **macOS 全项**（本轮未复测）。
4. **跨进程多窗口并发写同一文件**的冲突语义未定义；应用内多窗口隔离已验收。
5. **发行产物**：按用户要求**暂不打包**，待本地验收后再执行 `npm run package:mac` / `package:win`；`release/` 内仍是旧构建，最新版以 `npm start` 为验收入口。仓库已完成本地首次提交（未推送）。

⧗ 类项目不是「已完成」，只是当前环境无法闭环；需要在具备 macOS 主机、Pandoc、真实系统中文 IME、开发者签名证书的条件下补齐（Windows 11 侧的功能项已在 2026-11 审计轮补齐一部分）。
