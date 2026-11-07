export const welcome = `# 把思路写清楚

墨页 / Inkstone · 技术写作工作台

从一段文字开始。写 Markdown，直接看到排版。点击段落可以编辑原文，离开后恢复阅读视图。

## 为技术写作留出空间

用 **粗体** 强调结论，用 \`行内代码\` 说明接口。用左侧大纲在章节之间跳转，按 ⌘ / Ctrl + / 查看完整源码。

> 好的技术文档，让读者知道发生了什么、为什么发生，以及下一步怎么做。

### 代码与推导

\`\`\`typescript
type Note = { title: string; content: string };

function saveNote(note: Note): string {
  return \`# \${note.title}\\n\\n\${note.content}\`;
}
\`\`\`

把公式写进解释里：$E = mc^2$。

$$
\\nabla_\\theta J(\\theta) = \\frac{1}{m} \\sum_{i=1}^{m} \\nabla_\\theta \\ell_i(\\theta)
$$

### 计划与记录

- [x] 打开一篇 Markdown 文档
- [ ] 记录实现思路
- [ ] 补充验证结果

| 操作 | macOS | Windows |
| :--- | :--- | :--- |
| 保存 | ⌘ S | Ctrl S |
| 查找与替换 | ⌘ F | Ctrl F |
| 源码模式 | ⌘ / | Ctrl / |

### 从输入到输出

\`\`\`mermaid
flowchart LR
    A[想法] --> B[写作]
    B --> C[推敲]
    C --> D[分享]
\`\`\`

---

这是可编辑的示例文档。使用“文件 → 新建”开始自己的文档。当前构建仍处于开发阶段，完整功能进度见项目文档。
`;
