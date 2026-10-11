# MyST project plugin preview example

1. Open this folder in VS Code with Markdown Chroma installed.
2. Trust the folder when prompted. The folder setting explicitly enables local
   project plugin execution.
3. Open [Preview.md](Preview.md) and use **Markdown: Open Preview to the Side**.

`directives.mjs` is copied unchanged from
[`jupyter-book/mystmd`, revision `59fb1f4d0578c84df4cd6f30e0a546515d617c70`, `docs/directives.mjs`](https://github.com/jupyter-book/mystmd/blob/59fb1f4d0578c84df4cd6f30e0a546515d617c70/docs/directives.mjs).
Its upstream MIT license is included in `MYSTMD-LICENSE`.

The separate `alias-plugin.mjs` compares custom directive and role names with
their registered aliases, including an aliased option and parsed Markdown body.
The `demo:` prefix is part of these project-defined names.

Plugin code has Node.js file and network access. This example generates AST
nodes for directive/role documentation; it needs no project npm installation.
See [the preview guide](../../docs/PREVIEW.md#project-defined-myst-plugins) for
execution controls and compatibility limits.
