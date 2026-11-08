# Set up a file-based glossary for a MyST book

Use one Markdown file per term. Markdown Chroma reads the files for VS Code Preview, CLI, and
MCP. The MyST book transform reads the same configuration and creates term links and subject
index entries during the HTML build.

## Install the build dependencies

Use Node.js 20 or later. From the book root, install a Markdown Chroma version that exports
`markdown-chroma/myst-folder-glossary` and MyST. MyST 1.12.0 is the version used in the build example.

```sh
npm install --save-dev markdown-chroma mystmd@1.12.0
```

For a local Chroma build, pass its `npm pack` archive in place of `markdown-chroma`. Run this
command to locate the guide in the installed package.

```sh
node -p "require.resolve('markdown-chroma/docs/myst-folder-glossary.md')"
```

## Declare the glossary files

Create `chroma.index.yml` at the book root. If the file exists, add the rule to its existing
`glossaries` list.

```yaml
version: 1
glossaries:
  - include: "Glossary/*.md"
    definitionHeading: Definition
```

Create `Glossary/chat.md` with ordinary Markdown.

```markdown
---
aliases: [채팅방, room]
---

# Chat

## Definition

A conversation with other participants.
```

The file stem `chat` is the canonical name. The file needs exactly one level-two heading
matching `definitionHeading`. Use `Glossary/**/*.md` to include nested folders. Keep alternate
names in YAML `aliases`. Start the definition with a short paragraph for MyST term previews.

## Connect the MyST build

Add the glossary files to `project.toc` in the existing `myst.yml` if it uses an explicit table of
contents. A minimal `myst.yml` for a new book looks like this.

```yaml
version: 1
project:
  toc:
    - file: index.md
    - file: Glossary/chat.md
site:
  template: book-theme
```

Create `myst-folder-glossary.mjs` at the book root. The root passed to the transform is the
directory containing `chroma.index.yml`.

```js
import { createMystFolderGlossary } from 'markdown-chroma/myst-folder-glossary';

export default createMystFolderGlossary({ root: new URL('./', import.meta.url) });
```

Register the module in `myst-book.yml`. If the book already has a separate build configuration,
append the module to its existing `project.plugins` list. Chroma continues to read the
original glossary files directly.

```yaml
version: 1
extends:
  - myst.yml
project:
  plugins:
    - ./myst-folder-glossary.mjs
```

For the example book, create `index.md`. In a larger book, place the `{show-index}` directive on
whichever page should hold the subject index and include that page in the table of contents.

```markdown
# Messaging Handbook

See {term}`채팅방 <chat>`.

:::{show-index}
:::
```

In MyST book prose, use the canonical name as the role target when displaying an alias.
Chroma Preview also accepts an alias directly as a term target.

## Verify the project

Run both commands from the book root.

```sh
npm exec -- markdown-chroma read-term chat '채팅방' --root . --json
npm exec -- myst --config myst-book.yml build --html --strict
```

The CLI returns one `chat` definition for the two names. In the example HTML, the term link in
`_build/html/index.html` points to `/chat#term-chat`. The subject index also links `채팅방` and
`room` to the glossary page.

Use the same MyST config for local preview.

```sh
npm exec -- myst --config myst-book.yml start
```

Restart the MyST process after editing the folder rules so it reads the new configuration.
