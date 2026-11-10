# Changelog

## Unreleased

- Add the `{src}` role for evidence citations. `` {src}`s1` `` shows a superscript label link, and `` {src}`s1, s2` `` groups labels in `⟨ ⟩`. The CLI and MCP index record each label as a reference.
- Remove the angle-bracket label display for `<@label, @label>` added in 0.2.3; bare `@label` shows its target's text again.

## 0.2.3

- Show labels for angle-bracketed citations such as `<@src-1, @src-2>` regardless of the target, including labeled headings and numbered targets. Bare `@label` keeps MyST's target text.

## 0.2.2

- Show the label for a reference without text to an untitled, unnumbered target such as a labeled paragraph. `<@src-1, @src-2>` previously displayed as `<Paragraph, Paragraph>`.

## 0.2.1

- Exclude `_build` output from Preview lookup, as the CLI and MCP index already did. Repeated MyST builds no longer duplicate every label, which made `{ref}` targets ambiguous and slowed rendering.
- Add a root-level `.chromaignore` with `.gitignore` syntax to exclude more paths from Preview, CLI, and MCP. Writes to excluded paths no longer re-index the root or refresh previews.
- Look up cross-file reference targets through an identifier index instead of rechecking every Markdown file per reference.

## 0.2.0

- Organize a MyST glossary as one Markdown file per term. Preview, CLI, API, and MCP resolve canonical names and aliases, and the new MyST book transform generates term links and subject index entries.
- Preview standalone term definitions and index definitions from supported project directive mappings.
- Resolve cross-file MyST section and figure references, including shorthand labels and document links. Explicit labels take precedence over implicit heading targets.
- Share Markdown syntax across Preview, CLI, API, and MCP so visible headings, Obsidian comments, highlights, and footnotes stay consistent. Source reads still return the original saved Markdown.
- Resolve file-local Obsidian block IDs in backlinks and explicit embeds, report duplicate IDs as ambiguous, and rebuild older indexes automatically.
- Preserve prose after Obsidian comments and serialize dropdown summaries, chemistry roles, and supported inline formatting in directive expansion.
- Use one MyST parser with Obsidian syntax for all previews, including project-plugin bodies. Highlights, callouts, tags, and inline footnotes compose with MyST directives and roles.
- Apply MyST math, definition lists, and comments without requiring a project or another MyST construct, and preserve straight quotes.
- Keep footnote return links inside the final paragraph, including multiple references.
- Render code line numbers and emphasis with native syntax highlighting, table/code captions above their content, heading contents lists, dropdowns, and chemical formula subscripts.
- Avoid duplicate Mermaid diagrams when VS Code already supplies a Mermaid renderer.

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
