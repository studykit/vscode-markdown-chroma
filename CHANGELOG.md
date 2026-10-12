# Changelog

## 0.1.2

- Preserve Obsidian block anchors, wikilinks, and block embeds in documents that also use MyST syntax or project configuration.
- Keep block markers hidden, preserve MyST heading labels, and exclude code examples from block reference targets.

## 0.1.1

- Render indented glossary names on separate lines, with the first name as the canonical term and subsequent names as aliases.
- Support alias lookup and references across Preview, CLI, the shared API, and MCP while preserving original definition source and backlinks.
- Report ambiguous aliases and automatically rebuild existing indexes for the updated glossary records.

## 0.1.0

- Preview Obsidian Markdown with wikilinks, note embeds, foldable callouts, highlights, tags, tasks, and footnotes.
- Preview MyST / Jupyter Book 2 syntax, including equations, references, citations, glossaries, tabs, cards, local includes, and saved notebook outputs.
- Enable project-defined JavaScript directives, roles, and aliases in trusted workspaces, with plugin logs and reload commands.
- Read saved Markdown documents through the CLI and MCP server, with automatic indexing, section and glossary reads, batch reads, and explicit directive expansion.
