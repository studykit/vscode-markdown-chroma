# Research notes

Scientific Markdown, directly in VS Code's **built-in preview**.

:::{note} Explain the idea
MyST brings equations, references, and structured content to Markdown.
Use {kbd}`Ctrl + Enter` and {abbr}`AST (Abstract Syntax Tree)` inline.
:::

## Equations and references

```{math}
:label: energy
E = mc^2
```

Refer to the equation with {eq}`energy`.

## Switch between examples

::::{tab-set}
:::{tab-item} Python
```python
energy = mass * speed_of_light ** 2
```
:::
:::{tab-item} JavaScript
```javascript
const energy = mass * speedOfLight ** 2;
```
:::
::::

::::{grid} 1 1 2 2
:::{card} Write once
Keep your document in portable Markdown.
:::
:::{card} Read comfortably
Use your familiar VS Code preview and theme.
:::
::::
