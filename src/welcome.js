export const welcome = `# Markdown 写作指南

这是一篇可以直接编辑的示例。点进任意段落改几个字，再点击下一段，就能看到改好的排版。

## 标题与段落

用 **粗体** 强调结论，用 \`行内代码\` 说明接口。打开左上角的侧边栏，点选大纲中的标题，就能跳到对应章节。

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

写完后，点击右上角的「导出」选择文件格式。
`;
