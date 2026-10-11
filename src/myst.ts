import GithubSlugger from 'github-slugger';
import { footnoteBacklinks, assignFootnoteNumbers } from './footnotes';
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { mystParse } from 'myst-parser';
import { basicTransformations, glossaryTransform, abbreviationTransform, ReferenceState, enumerateTargetsTransform, resolveLinksAndCitationsTransform, resolveReferencesTransform } from 'myst-transforms';
import { previewMystOptions as options } from './myst-options';
import { VFile } from 'vfile';
import { validateNumbering } from 'myst-frontmatter';
import { renderToString } from 'katex';
import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import { parseFrontmatter } from './frontmatter';
import { mystConfiguration, mergeSettings, type Settings } from './myst-config';
import type { PreviewHost, RenderEnvironment } from './types';
import { pluginRecovery } from './preview-plugins/events';

// The official parser owns syntax. This adapter renders its AST in VS Code's
// existing Markdown preview, without a project, server, shell or web theme.
interface Node { type: string; children?: Node[]; [key: string]: any }
const walk = (node: Node, visit: (node: Node) => void) => { visit(node); node.children?.forEach(child => walk(child as Node, visit)); };
const text = (node: Node): string => node.value ?? node.children?.map(child => text(child as Node)).join('') ?? '';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const safeUrl = (url: string) => { const clean = url.trim().replace(/[\u0000-\u0020]/g, ''); return /^[a-z][a-z0-9+.-]*:/i.test(clean) && !/^(?:https?:|mailto:|file:|vscode-webview-resource:)/i.test(clean) ? '' : url; };
const size = (value: unknown) => /^\d+(?:\.\d+)?(?:px|em|rem|%|vw|vh)?$/.test(String(value)) ? (/^\d+(?:\.\d+)?$/.test(String(value)) ? `${value}px` : String(value)) : '';

export function extendMystMarkdown(md: MarkdownIt, host: PreviewHost): MarkdownIt {
  const nativeParse = md.parse.bind(md);
  const TokenClass = nativeParse('', {})[0]?.constructor as typeof Token | undefined;
  // Empty input has no tokens; obtain the constructor from a paragraph.
  const TokenType = TokenClass ?? nativeParse('x', {})[0].constructor as typeof Token;
  const nativeRender = (source: string, env: RenderEnvironment) => md.renderer.render(nativeParse(source, env), md.options, env);
  const nativeInline = (source: string, env: RenderEnvironment) => md.renderer.renderInline(md.parseInline(source, env)[0].children ?? [], md.options, env);
  const parse = (source: string, file?: string, project: Settings = {}) => {
    const vfile = new VFile({ path: file });
    // Executable declarations come from myst.yml only. Re-discover for each
    // included file so plugin paths and definitions stay in its own project.
    const config = file ? mystConfiguration(host, { currentDocument: host.documentUri(file) }) : undefined;
    const plugins = file ? host.parseMystPlugins?.(source, file, { ...project, plugins: config?.project.plugins }) : undefined;
    const tree: ReturnType<typeof mystParse> = plugins?.tree ?? mystParse(source, { ...options, extensions: { ...options.extensions, math: project.settings?.parser?.dollarmath === false ? { dollarmath: false, amsmath: true } : true }, vfile });
    const problems = [...(plugins?.errors ?? []), ...(plugins?.messages ?? []).map(message => `MyST${message.line ? ` line ${message.line}` : ''}: ${message.reason}`)];
    if (plugins?.errors.length || plugins?.diagnostics?.length) problems.push(pluginRecovery);
    if (plugins?.pending) problems.push('Loading MyST project plugins; Preview will refresh when ready.');
    tree.children.unshift(...[...new Set(problems)].map(value => ({ type: 'previewError', value })));
    walk(tree, node => {
      if ((node.type === 'mystDirective' || node.type === 'mystRole') && node.position) for (const child of node.children ?? []) child.position ??= node.position;
      if (node.type !== 'blockquote' || !node.position) return;
      const block = source.split('\n').slice(node.position.start.line - 1, node.position.end.line).join('\n');
      if (/^\s*>\s*\[!/.test(block)) node._obsidianSource = block;
    });
    basicTransformations(tree, vfile);
    glossaryTransform(tree, vfile);
    abbreviationTransform(tree, { abbreviations: project.abbreviations });
    return { tree, vfile };
  };
  const stripHeader = (source: string) => {
    const match = /^---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source);
    if (!match) return { body: source, header: '', metadata: {} as Record<string, any> };
    const metadata = parseFrontmatter(source)?.values ?? {};
    // Blank lines retain the editor's original line positions.
    return { body: match[0].replace(/[^\n]/g, '') + source.slice(match[0].length), header: match[0], metadata };
  };
  const fileFor = (target: string, env: RenderEnvironment) => {
    const file = env.currentDocument;
    if (!file || (file.scheme && file.scheme !== 'file')) return;
    const resolved = host.resolve(target, file.fsPath);
    return resolved.status === 'found' ? resolved.path : undefined;
  };
  const resource = (url: string, env: RenderEnvironment) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(url)) return safeUrl(url);
    let target = url;
    if (target.endsWith('.*')) {
      const stem = target.slice(0, -2);
      target = ['svg', 'png', 'webp', 'jpg', 'jpeg', 'gif', 'mp4'].map(extension => `${stem}.${extension}`).find(candidate => fileFor(candidate, env)) ?? target;
    }
    const file = fileFor(target, env);
    if (file) { env.containingImages?.add(file); return host.resourceUri(file, env); }
    return safeUrl(target);
  };
  const error = (message: string) => `<span class="myst-error" role="note">${escape(message)}</span>`;

  md.parse = (source, env: RenderEnvironment = {}) => {
    const native = nativeParse(source, env);
    // Ordinary Markdown/Obsidian continues through the native token pipeline.
    // Inspect actual tokens so syntax examples in code remain literal.
    const hasMyst = native.some(token => (token.type === 'fence' && /^\{[\w:-]+(?:\s|\})/.test(token.info)) ||
      (token.type === 'inline' && /(?:^|\n)\s*(?::{3,}|:::\{|\+\+\+|\([\w:-]+\)=|%\s|:\s)|\{[\w:-]+(?:\s[^}]*?)?\}`|\[\]\(#[^\s)]+\)|\[\]\([\w:-]+\)/.test(token.content)) ||
      (token.type === 'inline' && token.children?.some(child => child.type === 'text' && /(?:^|\s)@[\w:-]+/.test(child.content))));
    if (!hasMyst && !mystConfiguration(host, env).root) return native;
    const { body, header, metadata } = stripHeader(source);
    // Resolve references and include files once at render time, so cached tokens
    // also see dirty VS Code buffers and resource URLs for the current webview.
    const token = new TokenType('myst_document', '', 0);
    token.meta = { body, metadata };
    token.map = [0, source.split('\n').length];
    const frontmatter = header ? native.filter(item => /^(?:frontmatter|front_matter)/.test(item.type)) : [];
    return [...frontmatter, token];
  };

  md.renderer.rules.myst_document = (tokens, index, _options, env: RenderEnvironment) => {
    const { body, metadata: page } = tokens[index].meta;
    const config = mystConfiguration(host, env);
    const metadata = mergeSettings(config.project, page);
    const { tree } = parse(body, env.currentDocument?.fsPath, metadata);
    const file = env.currentDocument?.fsPath ?? '';
    const vfile = new VFile({ path: file || undefined });
    let readCount = 0, readBytes = 0;
    const read = (target: string, environment: RenderEnvironment) => {
      const resolved = fileFor(target, environment);
      if (!resolved || ++readCount > 100) return;
      const content = host.read(resolved);
      if (content === undefined || (readBytes += Buffer.byteLength(content)) > 4 * 1024 * 1024) return;
      return { file: resolved, content };
    };
    const environments = new WeakMap<Node, RenderEnvironment>();
    const prepare = (node: Node, environment: RenderEnvironment, stack: string[]) => {
      environments.set(node, environment);
      if (node.type === 'include') {
        const included = read(node.file, environment);
        if (!included || stack.includes(included.file) || stack.length > host.settings(environment).maxEmbedDepth) {
          node.type = 'previewError'; node.value = 'Cannot include this file (missing, outside document root, cyclic or over limit).'; return;
        }
        let source = included.content;
        const filter = node.filter;
        if (filter) {
          // Use the same inclusive line conventions as the official include directive.
          const lines = source.split('\n');
          if (filter.lines) source = filter.lines.flatMap((entry: number | number[]) => typeof entry === 'number' ? lines.slice(entry > 0 ? entry - 1 : lines.length + entry, entry > 0 ? entry : lines.length + entry + 1) : lines.slice(entry[0] > 0 ? entry[0] - 1 : lines.length + entry[0], entry[1] == null ? undefined : entry[1] > 0 ? entry[1] : lines.length + entry[1] + 1)).join('\n');
          else {
            const start = filter.startAt ?? filter.startAfter;
            const end = filter.endAt ?? filter.endBefore;
            let first = start ? Math.max(0, lines.findIndex((line: string) => line.includes(start))) + (filter.startAfter ? 1 : 0) : 0;
            const last = end ? lines.findIndex((line: string, position: number) => position >= first && line.includes(end)) : -1;
            source = lines.slice(first, last < 0 ? undefined : last + (filter.endAt ? 1 : 0)).join('\n');
          }
        }
        node.children = node.literal ? [{ type: 'code', value: source, lang: node.lang }] : parse(stripHeader(source).body, included.file, metadata).tree.children;
        const childEnv = { ...environment, currentDocument: host.documentUri(included.file), mystIncluded: true };
        node.children?.forEach(child => prepare(child as Node, childEnv, [...stack, included.file]));
        return;
      }
      node.children?.forEach(child => prepare(child as Node, environment, stack));
    };
    prepare(tree, env, file ? [file] : []);
    const slugger = new GithubSlugger();
    walk(tree, node => { if (node.type === 'heading' && node.implicit) node.html_id = slugger.slug(text(node)); });
    const state = new ReferenceState(file, { vfile, frontmatter: { ...metadata, numbering: validateNumbering(metadata.numbering, { property: 'numbering', messages: {} }) } });
    enumerateTargetsTransform(tree, { state });
    // The project CLI marks unmatched bibliography shorthand before resolving
    // it against local targets. Standalone previews have no citation pipeline.
    walk(tree, node => { if (node.type === 'cite' && state.getTarget(node.identifier)) node.error = true; });
    resolveLinksAndCitationsTransform(tree, { state });
    resolveReferencesTransform(tree, vfile, { state });
    const allNodes: Node[] = [];
    walk(tree, node => allNodes.push(node));
    const definitions = allNodes.filter(node => node.type === 'footnoteDefinition');
    const footnoteNumbers = assignFootnoteNumbers(allNodes.filter(node => node.type === 'footnoteReference').map(node => node.identifier));
    const footnoteReferences = new Map<string, Node[]>();
    allNodes.filter(node => node.type === 'footnoteReference').forEach(node => {
      const references = footnoteReferences.get(node.identifier) ?? [];
      node._footnoteAnchor = `myst-fnref-${node.identifier}${references.length ? `:${references.length}` : ''}`;
      references.push(node);
      footnoteReferences.set(node.identifier, references);
    });
    const bibliography = new Map<string, any>();
    const bibFiles = [...(Array.isArray(metadata.bibliography) ? metadata.bibliography : metadata.bibliography ? [metadata.bibliography] : []), ...allNodes.filter(node => node.type === 'bibliography').flatMap(node => node.files ?? [])];
    for (const bibFile of bibFiles) {
      const bib = read(bibFile, env);
      if (!bib) continue;
      try { for (const entry of new Cite(bib.content).data) bibliography.set(String(entry.id).toLowerCase(), entry); } catch { /* Render unresolved citations below. */ }
    }
    const attr = (node: Node) => `${node.html_id || node.identifier ? ` id="${escape(node.html_id || node.identifier)}"` : ''}${node.class ? ` class="${escape(node.class)}"` : ''}`;
    const render = (node: Node, stack: string[] = []): string => {
      const environment: RenderEnvironment = environments.get(node) ?? env;
      const children = () => node.children?.map(child => render(child as Node, stack)).join('') ?? '';
      const tag = (name: string, attributes = attr(node)) => `<${name}${attributes}>${children()}</${name}>`;
      if (node._obsidianSource) return nativeRender(node._obsidianSource, environment);
      try {
      switch (node.type) {
        case 'root': return children();
        case 'text': return /\[\[|==|%%/.test(node.value ?? '') ? nativeInline(node.value, environment) : escape(node.value);
        case 'paragraph': return /^\s*!\[\[[^\n]+\]\]\s*$/.test(text(node)) ? nativeRender(text(node), environment) : tag('p');
        case 'block': return tag('div', ` class="myst-block ${escape(node.class ?? '')}"${node.html_id || node.identifier ? ` id="${escape(node.html_id || node.identifier)}"` : ''}`);
        case 'heading': return tag(`h${Math.min(6, Math.max(1, node.depth))}`);
        case 'emphasis': return tag('em');
        case 'strong': return tag('strong');
        case 'underline': return tag('u');
        case 'delete': return tag('del');
        case 'subscript': return tag('sub');
        case 'superscript': return tag('sup');
        case 'keyboard': return tag('kbd');
        case 'span': return tag('span');
        case 'div': return tag('div');
        case 'abbreviation': return tag('abbr', ` title="${escape(node.title)}"`);
        case 'inlineCode': return `<code>${escape(node.value)}</code>`;
        case 'code': {
          const token = new TokenType('fence', 'code', 0); token.info = node.lang ?? ''; token.content = node.value ?? '';
          const code = md.renderer.rules.fence?.([token], 0, md.options, environment, md.renderer) ?? `<pre><code>${escape(node.value)}</code></pre>`;
          return `<div${node.html_id || node.identifier ? ` id="${escape(node.html_id || node.identifier)}"` : ''} class="myst-code${node.showLineNumbers ? ' has-line-numbers' : ''}"${node.filename ? ` data-filename="${escape(node.filename)}"` : ''}>${code}</div>`;
        }
        case 'html': return md.options.html ? node.value ?? '' : escape(node.value);
        case 'comment': case 'mystTarget': case 'indexEntry': case 'footnoteDefinition': return '';
        case 'break': return '<br>';
        case 'thematicBreak': return '<hr>';
        case 'blockquote': {
          const start = node.position?.start.line, end = node.position?.end.line;
          const source = start && end ? body.split('\n').slice(start - 1, end).join('\n') : '';
          return /^\s*>\s*\[!/.test(source) ? nativeRender(source, environment) : tag('blockquote');
        }
        case 'list': return tag(node.ordered ? 'ol' : 'ul', attr(node) + (node.ordered && node.start ? ` start="${Number(node.start)}"` : ''));
        case 'listItem': return `<li>${node.checked == null ? '' : `<input type="checkbox" disabled${node.checked ? ' checked' : ''}> `}${children()}</li>`;
        case 'definitionList': return tag('dl');
        case 'definitionTerm': return tag('dt');
        case 'definitionDescription': return tag('dd');
        case 'glossary': return tag('div', ' class="myst-glossary"');
        case 'link': {
          const target = node.url?.startsWith('#') ? state.getTarget(node.url.slice(1))?.node : undefined;
          return `<a href="${escape(safeUrl(node.url ?? ''))}"${node.title ? ` title="${escape(node.title)}"` : ''}>${children() || (target ? escape(`${target.type === 'container' ? target.kind : target.type} ${target.enumerator ?? target.label ?? ''}`) : '')}</a>`;
        }
        case 'crossReference': return node.resolved ? tag('a', ` href="${escape(safeUrl(node.url ?? `#${node.html_id ?? node.identifier}`))}"`) : `<span class="myst-unresolved">${children() || escape(node.label ?? node.identifier)}</span>`;
        case 'image': {
          const url = resource(node.url, environment);
          const style = `width:${size(node.width) || 'auto'};height:${size(node.height) || 'auto'};${node.align === 'center' ? 'display:block;margin-inline:auto;' : node.align === 'right' ? 'display:block;margin-left:auto;' : ''}`;
          if (/\.(?:mp4|webm|ogv)(?:$|[?#])/i.test(url)) return `<video controls preload="metadata" src="${escape(url)}" style="${style}"></video>`;
          return `<img${attr(node)} src="${escape(url)}" alt="${escape(node.alt)}" style="${style}">`;
        }
        case 'container': return tag('figure', ` class="myst-figure ${escape(node.class ?? '')}"${node.html_id || node.identifier ? ` id="${escape(node.html_id || node.identifier)}"` : ''}`);
        case 'caption': return tag('figcaption');
        case 'captionNumber': return tag('span', ' class="myst-caption-number"');
        case 'legend': return tag('div', ' class="myst-legend"');
        case 'table': {
          const rows = node.children ?? [];
          return `<table${attr(node)}>${rows.map((row, rowIndex) => `<tr>${row.children?.map(cell => `<${cell.header || rowIndex === 0 ? 'th' : 'td'}>${cell.children?.map(child => render(child as Node, stack)).join('') ?? ''}</${cell.header || rowIndex === 0 ? 'th' : 'td'}>`).join('') ?? ''}</tr>`).join('')}</table>`;
        }
        case 'aside': return tag('aside', ` class="myst-aside ${escape(node.kind ?? '')}"${node.html_id || node.identifier ? ` id="${escape(node.html_id || node.identifier)}"` : ''}`);
        case 'admonitionTitle': case 'cardTitle': return tag('div', ' class="myst-title"');
        case 'admonition': case 'proof': case 'exercise': case 'solution': {
          const nodes = node.children ?? [];
          const title = nodes[0]?.type === 'admonitionTitle' ? render(nodes[0] as Node, stack) : `<div class="myst-title">${escape(node.kind ?? node.type)}</div>`;
          const content = nodes.slice(nodes[0]?.type === 'admonitionTitle' ? 1 : 0).map(child => render(child as Node, stack)).join('');
          const fold = String(node.class ?? '').split(/\s+/).includes('dropdown');
          return `<${fold ? 'details' : 'aside'} class="myst-admonition ${escape(node.kind ?? node.type)} ${escape(node.class ?? '')}"${node.html_id || node.identifier ? ` id="${escape(node.html_id || node.identifier)}"` : ''}>${fold ? `<summary>${title}</summary>` : title}<div class="myst-content">${content}</div></${fold ? 'details' : 'aside'}>`;
        }
        case 'grid': return tag('div', ` class="myst-grid ${escape(node.class ?? '')}" style="--myst-cols:${Number(node.columns?.at(-1) ?? 2)}"`);
        case 'grid-item': return tag('div', ' class="myst-grid-item"');
        case 'card': return tag('div', ` class="myst-card ${escape(node.class ?? '')}"`);
        case 'tabSet': {
          const tabs = node.children ?? [];
          const selected = Math.max(0, tabs.findIndex(tab => tab.selected));
          return `<div class="myst-tabs"><div role="tablist">${tabs.map((tab, i) => `<button type="button" role="tab" aria-selected="${i === selected}" tabindex="${i === selected ? 0 : -1}">${escape(tab.title)}</button>`).join('')}</div>${tabs.map((tab, i) => `<div role="tabpanel"${i !== selected ? ' hidden' : ''}>${tab.children?.map(child => render(child as Node, stack)).join('') ?? ''}</div>`).join('')}</div>`;
        }
        case 'inlineMath': case 'math': {
          const block = node.type === 'math';
          return `<${block ? 'div' : 'span'}${attr(node)} class="myst-math">${renderToString(node.value ?? '', { displayMode: block, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 1000, macros: metadata.math ?? {} })}${block && node.enumerator ? `<span class="myst-equation-number">(${escape(node.enumerator)})</span>` : ''}</${block ? 'div' : 'span'}>`;
        }
        case 'mermaid': return `<pre class="myst-mermaid"><code>${escape(node.value)}</code></pre>`;
        case 'include': return tag('div', ' class="myst-include"');
        case 'embed': {
          const target = node.source?.label ?? '';
          if (stack.includes(target) || stack.length > host.settings(environment).maxEmbedDepth) return error('Cyclic or deeply nested embed stopped.');
          const [filename, label] = target.split('#');
          const local = allNodes.find(candidate => candidate !== node && (candidate.identifier === target || candidate.label === target));
          if (local) return render(local, [...stack, target]);
          const embedded = read(filename, environment);
          if (!embedded) return error(`Cannot embed: ${target}`);
          if (/\.ipynb$/i.test(filename)) {
            try {
              const notebook = JSON.parse(embedded.content);
              return notebook.cells.filter((cell: any) => !label || cell.id === label || cell.metadata?.tags?.includes(`label:${label}`)).map((cell: any) => {
                const input = Array.isArray(cell.source) ? cell.source.join('') : cell.source ?? '';
                if (cell.cell_type === 'markdown') return nativeRender(input, { ...environment, currentDocument: host.documentUri(embedded.file) });
                return `${node['remove-input'] ? '' : render({ type: 'code', lang: notebook.metadata?.kernelspec?.language ?? 'python', value: input } as Node, stack)}${node['remove-output'] ? '' : cell.outputs?.map((output: any) => output.data?.['image/png'] ? `<img alt="Notebook output" src="data:image/png;base64,${escape(output.data['image/png'].join?.('') ?? output.data['image/png'])}">` : output.data?.['text/html'] ? (md.options.html ? output.data['text/html'].join?.('') ?? output.data['text/html'] : escape(output.data['text/html'])) : `<pre class="myst-output">${escape((output.text ?? output.data?.['text/plain'])?.join?.('') ?? output.text ?? output.data?.['text/plain'] ?? '')}</pre>`).join('') ?? ''}`;
              }).join('');
            } catch { return error('Cannot parse embedded notebook.'); }
          }
          const parsed = parse(stripHeader(embedded.content).body, embedded.file, metadata).tree;
          prepare(parsed, { ...environment, currentDocument: host.documentUri(embedded.file), mystIncluded: true }, [embedded.file]);
          if (label) { let selected: Node | undefined; walk(parsed, candidate => { if (candidate.identifier === label) selected = candidate; }); return selected ? render(selected, [...stack, target]) : error(`Embed target not found: ${label}`); }
          return render(parsed, [...stack, target]);
        }
        case 'footnoteReference': {
          const number = footnoteNumbers.get(node.identifier);
          return `<sup class="footnote-ref"><a id="${escape(node._footnoteAnchor)}" href="#myst-fn-${escape(node.identifier)}">[${number ?? '?'}]</a></sup>`;
        }
        case 'citeGroup': return children();
        case 'cite': {
          const entry = bibliography.get(node.identifier);
          const names = entry?.author?.map((author: any) => author.family ?? author.literal ?? '').filter(Boolean).join(', ');
          const year = entry?.issued?.['date-parts']?.[0]?.[0];
          return `<a class="myst-citation" href="#myst-cite-${escape(node.identifier)}">${escape(names ? `${names}${year ? `, ${year}` : ''}` : node.label ?? node.identifier)}</a>`;
        }
        case 'bibliography': return `<ol class="myst-bibliography">${[...bibliography].map(([id, entry]) => `<li id="myst-cite-${escape(id)}">${escape(entry.author?.map((author: any) => [author.given, author.family].filter(Boolean).join(' ')).join(', '))}. <em>${escape(entry.title)}</em>. ${escape(entry['container-title'])} ${escape(entry.issued?.['date-parts']?.[0]?.[0])}.</li>`).join('')}</ol>`;
        case 'iframe': return `<a class="myst-external-embed" href="${escape(safeUrl(node.src ?? ''))}">${escape(node.title ?? node.src)}</a>`;
        case 'button': return tag('a', ` class="myst-button" href="${escape(safeUrl(node.url ?? ''))}"`);
        case 'mystDirective': case 'mystRole': case 'mystDirectiveError': case 'mystRoleError': return error(node.message ?? `Unsupported or invalid MyST ${node.type.includes('Role') ? 'role' : 'directive'}: ${node.name}`);
        case 'previewError': return error(node.value);
        default: return (node._projectPlugin ? error(`MyST plugin ${node._projectPlugin}: unsupported output node ${node.type}.`) : '') + (children() || (node.value ? escape(node.value) : ''));
      }
      } catch (failure) {
        if (!node._projectPlugin) throw failure;
        return error(`MyST plugin ${node._projectPlugin}: cannot render ${node.type}: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
    };
    // Source markers support the built-in editor/preview scroll synchronization.
    const renderMapped = (node: Node): string => {
      if (node.type === 'block' && !node.identifier && !node.class) return node.children?.map(child => renderMapped(child as Node)).join('') ?? '';
      const line = node.position?.start.line;
      return `<div${line ? ` class="code-line" data-line="${line - 1}"` : ''}>${render(node)}</div>`;
    };
    const content = tree.children?.map(child => renderMapped(child as Node)).join('') ?? '';
    const footnotes = definitions.length ? `<section class="footnotes obsidian-footnotes"><ol class="obsidian-footnotes-list">${definitions.map(node => {
      const backlinks = footnoteBacklinks((footnoteReferences.get(node.identifier) ?? []).map(reference => ({ anchor: reference._footnoteAnchor })));
      return `<li class="footnote-item" id="myst-fn-${escape(node.identifier)}"><span class="obsidian-footnote-number">${footnoteNumbers.get(node.identifier) ?? '?'}.</span><div class="obsidian-footnote-content">${node.children?.map(child => render(child as Node)).join('') ?? ''}${backlinks}</div></li>`;
    }).join('')}</ol></section>` : '';

    return (config.error ? error(config.error) : '') + content + footnotes;
  };
  return md;
}
