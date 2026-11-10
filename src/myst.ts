import GithubSlugger from 'github-slugger';
import * as path from 'node:path';
import { normalizeLabel } from 'myst-common';
import { footnoteBacklinks, assignFootnoteNumbers } from './footnotes';
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { parseMarkdown } from './markdown-parser';
import { decorateCode } from './code-lines';
import { basicTransformations, glossaryTransform, abbreviationTransform, ReferenceState, enumerateTargetsTransform, resolveLinksAndCitationsTransform, resolveReferencesTransform } from 'myst-transforms';
import { configuredTermDirectives, previewMystOptions as options } from './myst-options';
import { VFile } from 'vfile';
import { validateNumbering } from 'myst-frontmatter';
import { renderToString } from 'katex';
import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import { parseFrontmatter, type Frontmatter } from './frontmatter';
import { attachFolderTerm, findFolderTerm } from './folder-glossary';
import { mystConfiguration, mergeSettings, termDirectiveDeclarations, type Settings } from './myst-config';
import type { PreviewHost, RenderEnvironment } from './types';
import { pluginRecovery } from './preview-plugins/events';
import { applyDeclaredTermTargets, glossaryAliasTargets, glossaryIdentifier, normalizeGlossaries, resolveGlossaryAliases, termDetailLabel } from './glossary';

// The official parser owns syntax. This adapter renders its AST in VS Code's
// existing Markdown preview, without a project, server, shell or web theme.
interface Node { type: string; children?: Node[]; [key: string]: any }
const walk = (node: Node, visit: (node: Node) => void) => { visit(node); node.children?.forEach(child => walk(child as Node, visit)); };
const text = (node: Node): string => node.value ?? node.children?.map(child => text(child as Node)).join('') ?? '';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const safeUrl = (url: string) => { const clean = url.trim().replace(/[\u0000-\u0020]/g, ''); return /^[a-z][a-z0-9+.-]*:/i.test(clean) && !/^(?:https?:|mailto:|file:|vscode-webview-resource:)/i.test(clean) ? '' : url; };
const size = (value: unknown) => /^\d+(?:\.\d+)?(?:px|em|rem|%|vw|vh)?$/.test(String(value)) ? (/^\d+(?:\.\d+)?$/.test(String(value)) ? `${value}px` : String(value)) : '';

// Reuse the native Obsidian rule's block and marker ranges. The MyST parser
// owns the AST; only recognized source markers become preview anchors.
function applyObsidianBlocks(tree: Node, tokens: Token[]): Token[] {
  const types: Record<string, string> = {
    paragraph_open: 'paragraph', heading_open: 'heading', list_item_open: 'listItem',
    bullet_list_open: 'list', ordered_list_open: 'list', blockquote_open: 'blockquote',
    obsidian_callout_open: 'obsidianCallout', table_open: 'table', fence: 'code', code_block: 'code'
  };
  const nodes: Node[] = [];
  walk(tree, node => nodes.push(node));
  return tokens.filter(token => {
    const id = token.attrGet('data-obsidian-block');
    if (!id && token.type !== 'heading_open') return true;
    const target = types[token.type] && token.map
      ? nodes.find(node => node.type === types[token.type] && node.position?.start.line === token.map![0] + 1)
      : undefined;
    // Native Markdown can see apparent headings/IDs inside colon-fenced MyST
    // code. Only actual AST blocks may be reference targets.
    if (token.type === 'heading_open' && !target) return false;
    const marker = token.meta?.obsidianBlockMarker;
    if (!id) return true;
    if (!target || !marker?.map) return false;
    target._obsidianBlockId = id;
    const inMarker = (node: Node) => node.position?.start.line >= marker.map[0] + 1 && node.position?.end.line <= marker.map[1];
    if (marker.standalone) {
      const paragraph = nodes.find(node => node.type === 'paragraph' && inMarker(node) && text(node).trim() === `^${id}`);
      if (paragraph) paragraph._obsidianHidden = true;
    } else {
      const suffix = new RegExp(`[ \\t]+\\^${id}[ \\t]*$`);
      const last = nodes.findLast(node => node.type === 'text' && inMarker(node) && suffix.test(node.value ?? ''));
      if (last) last.value = last.value.replace(suffix, '');
    }
    return true;
  });
}

export function extendMystMarkdown(md: MarkdownIt, host: PreviewHost): MarkdownIt {
  const nativeParse = md.parse.bind(md);
  let referenceCache: { source: string; tokens: Token[] } | undefined;
  const targetCache = new Map<string, { source: string; settings: string; state: ReferenceState }>();
  const externalAliases = new WeakMap<ReferenceState, ReturnType<typeof glossaryAliasTargets>>();
  const targetIdentifier = (state: ReferenceState, label: string) => {
    const aliases = externalAliases.get(state);
    return aliases?.has(label) ? aliases.get(label) : label;
  };
  const isExplicitTarget = (state: ReferenceState, label: string) => {
    const id = targetIdentifier(state, label);
    const target = id ? state.getTarget(id)?.node as Node | undefined : undefined;
    return target && !target.implicit;
  };
  const TokenClass = nativeParse('', {})[0]?.constructor as typeof Token | undefined;
  // Empty input has no tokens; obtain the constructor from a paragraph.
  const TokenType = TokenClass ?? nativeParse('x', {})[0].constructor as typeof Token;
  const reviveToken = (value: Token): Token => Object.assign(new TokenType(value.type, value.tag, value.nesting), value, {
    attrs: value.attrs?.map(([key, value]) => [key, value] as [string, string]) ?? null,
    children: value.children?.map(reviveToken) ?? null
  });
  const previewRender = (source: string, env: RenderEnvironment) => md.render(source, env);
  const nativeRender = md.renderer.render.bind(md.renderer);
  // VS Code also consumes parse tokens for its Markdown language service.
  // Keep a heading outline there while the MyST AST owns rendered content.
  md.renderer.render = (tokens, settings, env) => nativeRender(tokens.filter(token => !token.meta?.mystOutline), settings, env);
  const parse = (source: string, file?: string, project: Settings = {}, allowPlugins = true, frontmatter?: Frontmatter) => {
    const vfile = new VFile({ path: file });
    // Executable declarations come from myst.yml only. Re-discover for each
    // included file so plugin paths and definitions stay in its own project.
    const config = file ? mystConfiguration(host, { currentDocument: host.documentUri(file) }) : undefined;
    const declarations = termDirectiveDeclarations(config?.project.settings);
    const configured = configuredTermDirectives(declarations);
    const plugins = file && allowPlugins ? host.parseMystPlugins?.(source, file, { ...project, plugins: config?.project.plugins,
      settings: { ...project.settings, markdown_chroma: config?.project.settings?.markdown_chroma } }) : undefined;
    const parseOptions = { ...options, directives: [...options.directives, ...configured],
      extensions: { ...options.extensions, math: project.settings?.parser?.dollarmath === false ? { dollarmath: false, amsmath: true } : true }, vfile };
    const parsed = parseMarkdown(source, parseOptions);
    const folderHeading = file && host.folderGlossaryHeading?.(file);
    const folderTerm = file && folderHeading ? findFolderTerm(parsed.tree, path.basename(file), folderHeading, frontmatter).term : undefined;
    const tree = plugins?.tree ?? parsed.tree;
    if (plugins?.tree && configured.length) applyDeclaredTermTargets(parsed.tree, tree, new Set(configured.map(spec => spec.name)));
    const problems = [...(plugins?.errors ?? []), ...(plugins?.messages ?? []).map(message => `MyST${message.line ? ` line ${message.line}` : ''}: ${message.reason}`)];
    if (plugins?.errors.length || plugins?.diagnostics?.length) problems.push(pluginRecovery);
    if (plugins?.pending) problems.push('Loading MyST project plugins; Preview will refresh when ready.');
    tree.children.unshift(...[...new Set(problems)].map(value => ({ type: 'previewError', value })));
    walk(tree, node => {
      if ((node.type === 'mystDirective' || node.type === 'mystRole') && node.position) {
        for (const child of node.children ?? []) child.position ??= node.position;
      }
    });
    normalizeGlossaries(tree, source, body => parseMarkdown(body, parseOptions).tree, vfile);
    const referenceTokens = applyObsidianBlocks(tree, parsed.tokens);
    basicTransformations(tree, vfile);
    const headingsByLine = new Map(referenceTokens.filter(token => token.type === 'heading_open' && token.map).map(token => [token.map![0], token]));
    walk(tree, node => {
      if (node.type !== 'heading') return;
      const token = headingsByLine.get(node.position?.start.line - 1);
      if (token) token.meta = { ...token.meta, mystIdentifier: node.identifier, mystAnchor: node.html_id ?? node.identifier, mystTitle: text(node) };
    });
    glossaryTransform(tree, vfile);
    if (folderTerm) attachFolderTerm(tree, folderTerm);
    abbreviationTransform(tree, { abbreviations: project.abbreviations });
    return { tree, vfile, referenceTokens };
  };
  const stripHeader = (source: string) => {
    const match = /^(?:\uFEFF)?---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source);
    if (!match) return { body: source, header: '', metadata: {} as Record<string, any> };
    const frontmatter = parseFrontmatter(source);
    // Blank lines retain the editor's original line positions.
    return { body: match[0].replace(/[^\n]/g, '') + source.slice(match[0].length), header: match[0], metadata: frontmatter?.values ?? {}, frontmatter };
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
    const { body, header, metadata, frontmatter: headerProperties } = stripHeader(source);
    // Resolve references and include files once at render time, so cached tokens
    // also see dirty VS Code buffers and resource URLs for the current webview.
    const token = new TokenType('myst_document', '', 0);
    // Reference discovery uses the built-in parser without executing project
    // plugins, and validates native targets against actual MyST blocks.
    token.meta = { body, metadata, frontmatter: headerProperties, referenceTokens: () => {
      // A document can contain hundreds of links to itself. Reuse one bounded
      // source snapshot while fresh saved/dirty source still invalidates it.
      if (referenceCache?.source !== source) referenceCache = { source, tokens: parse(body, undefined, metadata).referenceTokens };
      return referenceCache.tokens;
    } };
    token.map = [0, source.split('\n').length];
    const frontmatter = header ? nativeParse(header, env).filter(item => /^(?:frontmatter|front_matter)/.test(item.type)) : [];
    const outline: Token[] = [];
    const references = token.meta.referenceTokens() as Token[];
    for (let index = 0; index < references.length; index++) {
      const heading = references[index];
      if (heading.type !== 'heading_open') continue;
      const open = reviveToken(heading); open.meta = { mystOutline: true };
      const inline = new TokenType('inline', '', 0); inline.meta = { mystOutline: true };
      const title = new TokenType('text', '', 0); title.content = heading.meta?.mystTitle ?? references[index + 1]?.content ?? '';
      inline.content = title.content; inline.children = [title];
      const close = new TokenType('heading_close', heading.tag, -1); close.meta = { mystOutline: true };
      outline.push(open, inline, close);
    }
    return [...frontmatter, token, ...outline];
  };

  md.renderer.rules.myst_document = (tokens, index, _options, env: RenderEnvironment) => {
    const { body, metadata: page, frontmatter } = tokens[index].meta;
    const config = mystConfiguration(host, env);
    const metadata = mergeSettings(config.project, page);
    const { tree } = parse(body, env.currentDocument?.fsPath, metadata, true, frontmatter);
    const file = env.currentDocument?.fsPath ?? '';
    const vfile = new VFile({ path: file || undefined });
    const notebookContext = env.mystNotebookContext as { stack: string[]; budget: { count: number; bytes: number } } | undefined;
    const readBudget = notebookContext?.budget ?? { count: 0, bytes: 0 };
    const read = (target: string, environment: RenderEnvironment) => {
      const resolved = fileFor(target, environment);
      if (!resolved || ++readBudget.count > 100) return;
      const content = host.read(resolved);
      if (content === undefined || (readBudget.bytes += Buffer.byteLength(content)) > 4 * 1024 * 1024) return;
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
        const includedHeader = stripHeader(source);
        node.children = node.literal ? [{ type: 'code', value: source, lang: node.lang }] : parse(includedHeader.body, included.file, metadata, true, includedHeader.frontmatter).tree.children;
        const childEnv = { ...environment, currentDocument: host.documentUri(included.file), mystIncluded: true };
        node.children?.forEach(child => prepare(child as Node, childEnv, [...stack, included.file]));
        return;
      }
      node.aliasNodes?.forEach((alias: Node) => prepare(alias, environment, stack));
      node.children?.forEach(child => prepare(child as Node, environment, stack));
    };
    prepare(tree, env, file ? [file] : []);
    resolveGlossaryAliases(tree);
    const bibliography = new Map<string, any>();
    const bibliographyNodes: Node[] = [];
    walk(tree, node => { if (node.type === 'bibliography') bibliographyNodes.push(node); });
    const bibFiles = [...(Array.isArray(metadata.bibliography) ? metadata.bibliography : metadata.bibliography ? [metadata.bibliography] : []), ...bibliographyNodes.flatMap(node => node.files ?? [])];
    for (const bibFile of bibFiles) {
      const bib = read(bibFile, env);
      if (!bib) continue;
      try { for (const entry of new Cite(bib.content).data) bibliography.set(String(entry.id).toLowerCase(), entry); } catch { /* Render unresolved citations below. */ }
    }
    const slugger = new GithubSlugger();
    walk(tree, node => {
      if (node.type !== 'heading') return;
      node._nativeAnchor = `${env.obsidian?.prefix ?? ''}${slugger.slug(text(node))}`;
      if (node.implicit) node.html_id = node._nativeAnchor;
    });
    const state = new ReferenceState(file, { vfile, frontmatter: { ...metadata, numbering: validateNumbering(metadata.numbering, { property: 'numbering', messages: {} }) } });
    enumerateTargetsTransform(tree, { state });
    // References written without text take it from their target. Remember them
    // before the transforms below rewrite cites and links into cross-references.
    const textless = new WeakSet<Node>();
    walk(tree, node => { if (['crossReference', 'cite', 'link'].includes(node.type) && !node.children?.length) textless.add(node); });
    // The project CLI marks unmatched bibliography shorthand before resolving
    // it against local targets. Standalone previews have no citation pipeline.
    walk(tree, node => { if (node.type === 'cite' && state.getTarget(node.identifier)) node.error = true; });
    resolveLinksAndCitationsTransform(tree, { state });
    resolveReferencesTransform(tree, vfile, { state });
    // Standalone MyST transforms only know the current document. Discover
    // external section labels using the same tokenizer, without running project
    // plugins or expanding includes in documents that are merely link targets.
    const externalStates = new Map<string, ReferenceState>();
    const targetState = (targetFile: string): ReferenceState | undefined => {
      const existing = externalStates.get(targetFile);
      if (existing) return existing;
      if (++readBudget.count > 100) return;
      const source = host.read(targetFile);
      if (source === undefined || (readBudget.bytes += Buffer.byteLength(source)) > 4 * 1024 * 1024) return;
      const header = stripHeader(source);
      const config = mystConfiguration(host, { currentDocument: host.documentUri(targetFile) });
      const settings = mergeSettings(config.project, header.metadata);
      const signature = JSON.stringify([settings, termDirectiveDeclarations(config.project.settings), host.folderGlossaryHeading?.(targetFile)]);
      const cached = targetCache.get(targetFile);
      let target = cached?.source === source && cached.settings === signature ? cached.state : undefined;
      if (!target) {
        const parsed = parse(header.body, targetFile, settings, false, header.frontmatter);
        const slugs = new GithubSlugger();
        walk(parsed.tree, node => {
          if (node.type !== 'heading') return;
          const anchor = slugs.slug(text(node));
          if (node.implicit) node.html_id = anchor;
        });
        // Document links show the page title: frontmatter first, then a
        // leading level-one heading as MyST lifts it, then the file name.
        const content = (nodes: Node[] = []): Node | undefined => {
          const node = nodes.find(candidate => !['previewError', 'mystTarget', 'comment'].includes(candidate.type));
          return node?.type === 'block' ? content(node.children) : node;
        };
        const first = content(parsed.tree.children);
        const title = typeof header.metadata.title === 'string' && header.metadata.title.trim() ? header.metadata.title
          : first?.type === 'heading' && first.depth === 1 && text(first).trim() ? text(first) : path.basename(targetFile, path.extname(targetFile));
        target = new ReferenceState(targetFile, { vfile: parsed.vfile, frontmatter: { ...settings, title, numbering: validateNumbering(settings.numbering, { property: 'numbering', messages: {} }) } });
        enumerateTargetsTransform(parsed.tree, { state: target });
        externalAliases.set(target, glossaryAliasTargets(parsed.tree));
        // Bound retained source/AST snapshots as well as each render's reads.
        while (targetCache.size && (targetCache.size >= 32 || [...targetCache.values()].reduce((sum, entry) => sum + Buffer.byteLength(entry.source), 0) + Buffer.byteLength(source) > 4 * 1024 * 1024)) targetCache.delete(targetCache.keys().next().value!);
        targetCache.set(targetFile, { source, settings: signature, state: target });
      }
      externalStates.set(targetFile, target);
      return target;
    };
    // `[](./page.md)` and {doc} show the target page title when text is empty.
    const documentTitle = (url: string, environment: RenderEnvironment): string | undefined => {
      if (!url || url.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(url)) return;
      let destination: string;
      try { destination = decodeURIComponent(url.split('#')[0]); } catch { return; }
      if (!destination || url.includes('#')) return;
      const resolved = fileFor(destination.startsWith('.') ? destination : `./${destination}`, environment) ?? fileFor(destination, environment);
      if (!resolved || path.extname(resolved).toLowerCase() !== '.md') return;
      return targetState(resolved)?.title;
    };
    // A MyST project resolves `[](#label)`, `@label` and `[](file.md#label)`
    // across pages. Try those links and unmatched citations as cross-references;
    // anything that stays unresolved returns to its original node below.
    const tentative: { node: Node; original: Node }[] = [];
    walk(tree, node => {
      let label: string | undefined;
      if (node.type === 'link' && typeof node.url === 'string' && !/^[a-z][a-z\d+.-]*:/i.test(node.url)) {
        const hash = node.url.indexOf('#');
        if (hash < 0 || hash === node.url.length - 1) return;
        try { label = decodeURIComponent(hash === 0 ? node.url.slice(1) : node.url); } catch { return; }
      } else if (node.type === 'cite' && node.label && !bibliography.has(String(node.identifier ?? node.label).toLowerCase())) {
        label = node.label;
      }
      const reference = label === undefined ? undefined : normalizeLabel(label.includes('#') ? label.slice(label.indexOf('#') + 1) : label);
      if (!reference || !label) return;
      tentative.push({ node, original: { ...node } });
      node.type = 'crossReference';
      node.identifier = reference.identifier;
      node.label = label;
      delete node.url; delete node.error;
    });
    let discovered = false;
    let discoveryComplete = true;
    walk(tree, node => {
      if (node.type !== 'crossReference' || node.resolved || !node.identifier) return;
      const environment = environments.get(node) ?? env;
      const sourceFile = environment.currentDocument?.fsPath;
      if (!sourceFile || (environment.currentDocument?.scheme && environment.currentDocument.scheme !== 'file')) return;
      let label = node.identifier;
      const termReference = typeof node.label === 'string' && label === glossaryIdentifier(node.label);
      let target: ReferenceState | undefined;
      const hash = (node.label ?? '').indexOf('#');
      if (hash > 0 && !termReference) {
        const destination = node.label.slice(0, hash);
        const resolved = fileFor(destination.startsWith('.') ? destination : `./${destination}`, environment) ?? fileFor(destination, environment);
        label = normalizeLabel(node.label.slice(hash + 1))?.identifier;
        if (resolved && path.extname(resolved).toLowerCase() === '.md') target = targetState(resolved);
      } else {
        if (host.referenceFiles) {
          const candidates = [...host.referenceFiles(label, sourceFile)].filter(candidate => candidate !== file);
          if (termReference && candidates.length > 1) return;
          // Like the project index, explicit labels win over implicit heading
          // slugs; a single remaining candidate is selected.
          const states = candidates.length > 1 ? candidates.map(targetState).filter((state): state is ReferenceState => !!state) : [];
          const explicit = states.filter(state => isExplicitTarget(state, label));
          if (candidates.length === 1) target = targetState(candidates[0]);
          else if (states.length === candidates.length && explicit.length === 1) target = explicit[0];
        } else {
          if (!discovered) {
            discovered = true;
            for (const candidate of host.markdownFiles?.(file) ?? []) {
              if (candidate === file) continue;
              if (!targetState(candidate)) { discoveryComplete = false; break; }
            }
          }
          // Legacy hosts without a static inventory must retain bounded reads
          // and cannot choose a target after an incomplete project scan.
          const matches = [...externalStates.values()].filter(state => state.getTarget(label) || externalAliases.get(state)?.has(label));
          const explicit = matches.filter(state => isExplicitTarget(state, label));
          if (discoveryComplete) target = matches.length === 1 ? matches[0] : !termReference && explicit.length === 1 ? explicit[0] : undefined;
        }
      }
      const id = target && targetIdentifier(target, label);
      if (!target || !id || !target.getTarget(id)) return;
      node.identifier = id;
      resolveReferencesTransform({ type: 'root', children: [node] }, vfile, { state: target });
      if (node.resolved) {
        const destination = path.relative(path.dirname(sourceFile), target.filePath).split(path.sep).map(encodeURIComponent).join('/');
        node.url = `./${destination}#${encodeURIComponent(node.html_id ?? id)}`;
      }
    });
    for (const { node, original } of tentative) {
      if (node.resolved) continue;
      for (const key of Object.keys(node)) delete node[key];
      Object.assign(node, original);
    }
    // Upstream text for an untitled, unnumbered target is its kind name alone,
    // e.g. "Paragraph" for `@src-1`. Show the label instead.
    walk(tree, node => {
      if (node.type !== 'crossReference' || !node.resolved) return;
      const [only] = node.children ?? [];
      if (!textless.has(node) || node.enumerator != null || node.children?.length !== 1 || only.type !== 'text' || only.value !== node.template) return;
      const label = String(node.label ?? node.identifier);
      node.children = [{ type: 'text', value: label.slice(label.indexOf('#') + 1) }];
    });
    const allNodes: Node[] = [];
    walk(tree, node => allNodes.push(node));
    const footnoteNumbers = assignFootnoteNumbers(allNodes.filter(node => node.type === 'footnoteReference').map(node => node.identifier));
    const definitions = allNodes.filter(node => node.type === 'footnoteDefinition' && footnoteNumbers.has(node.identifier));
    const footnoteIds = new Map([...footnoteNumbers.keys()].map((label, index) => [label, `${env.docId ? `-${env.docId}-` : ''}${index + 1}`]));
    const footnoteReferences = new Map<string, Node[]>();
    allNodes.filter(node => node.type === 'footnoteReference').forEach(node => {
      const references = footnoteReferences.get(node.identifier) ?? [];
      node._footnoteAnchor = `fnref${footnoteIds.get(node.identifier)}${references.length ? `:${references.length}` : ''}`;
      references.push(node);
      footnoteReferences.set(node.identifier, references);
    });
    const identifier = (node: Node) => node.html_id || node.identifier || (node._obsidianBlockId ? `${env.obsidian?.prefix ?? ''}obsidian-block-${node._obsidianBlockId}` : '');
    const existingIds = new Set(allNodes.map(identifier).filter(Boolean));
    const idAttr = (node: Node) => identifier(node) ? ` id="${escape(identifier(node))}"` : '';
    const attr = (node: Node, sourceMap = false) => {
      const line = sourceMap && Number.isSafeInteger(node.position?.start.line) ? node.position.start.line - 1 : undefined;
      const classes = [node.class, line === undefined ? '' : 'code-line'].filter(Boolean).join(' ');
      return `${idAttr(node)}${classes ? ` class="${escape(classes)}"` : ''}${line === undefined ? '' : ` data-line="${line}"`}`;
    };
    const extraAnchor = (node: Node) => node._obsidianBlockId && (node.html_id || node.identifier)
      ? `<span id="${escape(`${env.obsidian?.prefix ?? ''}obsidian-block-${node._obsidianBlockId}`)}"></span>` : '';
    // VS Code scrolls to a cross-document fragment only through source-mapped
    // `code-line` elements. Map labeled main-document targets the same way as
    // headings; included or embedded content belongs to another editor.
    const sourceAnchor = (node: Node, html: string, environment: RenderEnvironment) => {
      const id = identifier(node);
      const line = node.position?.start.line;
      if (!id || node.type === 'heading' || !Number.isSafeInteger(line) || environment.mystIncluded || environment.obsidian?.prefix || notebookContext) return html;
      const open = /^<([a-z][a-z\d]*)((?:\s[^>]*)?)>/i.exec(html);
      if (!open || !open[2].includes(` id="${escape(id)}"`) || /\bcode-line\b/.test(open[2])) return html;
      const attributes = /\sclass="/.test(open[2])
        ? open[2].replace(/\sclass="([^"]*)"/, (_, classes: string) => ` class="${classes ? `${classes} ` : ''}code-line"`)
        : `${open[2]} class="code-line"`;
      return `<${open[1]}${attributes} data-line="${line - 1}">${html.slice(open[0].length)}`;
    };
    const render = (node: Node, stack: string[] = [], preserveLineBreaks = false): string =>
      sourceAnchor(node, renderNode(node, stack, preserveLineBreaks), environments.get(node) ?? env);
    const renderNode = (node: Node, stack: string[], preserveLineBreaks: boolean): string => {
      const environment: RenderEnvironment = environments.get(node) ?? env;
      const children = () => extraAnchor(node) + (node.children?.map(child => render(child as Node, stack, preserveLineBreaks)).join('') ?? '');
      const tag = (name: string, attributes = attr(node)) => `<${name}${attributes}>${children()}</${name}>`;
      if (node._obsidianHidden) return '';
      try {
      switch (node.type) {
        case 'root': return children();
        case 'obsidianInline': case 'obsidianBlock': {
          const token = reviveToken(node._token);
          return md.renderer.render([token], md.options, environment);
        }
        case 'obsidianCallout': case 'obsidianCalloutTitle': {
          const open = reviveToken(node._token);
          if (node._obsidianBlockId) open.attrSet('id', `${environment.obsidian?.prefix ?? ''}obsidian-block-${node._obsidianBlockId}`);
          const close = new TokenType(open.type.replace(/_open$/, '_close'), open.tag, -1);
          close.meta = open.meta;
          return md.renderer.render([open], md.options, environment) + children() + md.renderer.render([close], md.options, environment);
        }
        case 'mark': return tag('mark', node.color ? ` data-highlight="${escape(node.color)}"` : '');
        case 'text': {
          const value = termDetailLabel(node._termDetailLabel, host.language) ?? node.value ?? '';
          const lines = preserveLineBreaks || md.options.breaks ? String(value).split(/\r?\n/) : [value];
          return lines.map(value => escape(value)).join('<br>');
        }
        case 'paragraph': return tag('p');
        case 'block': return tag('div', ` class="myst-block ${escape(node.class ?? '')}"${idAttr(node)}`);
        // VS Code's cross-document fragment navigation searches its source map,
        // rather than all DOM IDs. Included/embedded source lines belong to a
        // different editor and must not enter the containing preview's map.
        case 'heading': {
          const sourceMap = !environment.mystIncluded && !environment.obsidian?.prefix && !notebookContext;
          const nativeAnchor = node._nativeAnchor ? encodeURIComponent(node._nativeAnchor) : '';
          const alias = nativeAnchor && nativeAnchor !== identifier(node) && !existingIds.has(nativeAnchor)
            ? `<span${attr({ ...node, html_id: nativeAnchor }, sourceMap)}></span>` : '';
          return alias + tag(`h${Math.min(6, Math.max(1, node.depth))}`, attr(node, sourceMap));
        }
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
          const emphasized = Array.isArray(node.emphasizeLines) ? node.emphasizeLines.filter((line: unknown) => Number.isSafeInteger(line) && Number(line) > 0) : [];
          const start = Number.isSafeInteger(node.startingLineNumber) && node.startingLineNumber > 0 ? node.startingLineNumber : 1;
          return `<div${idAttr(node)} class="myst-code${node.showLineNumbers ? ' has-line-numbers' : ''}"${node.filename ? ` data-filename="${escape(node.filename)}"` : ''}>${extraAnchor(node)}${decorateCode(code, !!node.showLineNumbers, start, emphasized)}</div>`;
        }
        case 'html': return md.options.html ? node.value ?? '' : escape(node.value);
        case 'comment': case 'mystTarget': case 'indexEntry': case 'footnoteDefinition': return '';
        case 'break': return '<br>';
        case 'thematicBreak': return '<hr>';
        case 'blockquote': return tag('blockquote');
        case 'list': return tag(node.ordered ? 'ol' : 'ul', attr(node) + (node.ordered && node.start ? ` start="${Number(node.start)}"` : ''));
        case 'listItem': return `<li${attr(node)}${node.task == null ? '' : ` class="obsidian-task" data-task="${escape(node.task)}"`}>${node.checked == null ? '' : `<input type="checkbox" disabled${node.checked ? ' checked' : ''}> `}${children()}</li>`;
        case 'definitionList': return tag('dl');
        case 'definitionTerm': {
          const translated = node.standaloneTerm && node.ko ? ` <span class="myst-term-translation" lang="ko">${escape(node.ko)}</span>` : '';
          const aliases = (node.aliasNodes ?? []).map((alias: Node) => `<br><span class="myst-term-alias">${alias.children?.map(child => render(child, stack)).join('') ?? ''}</span>`).join('');
          return `<dt${attr(node)}>${children()}${translated}${aliases}</dt>`;
        }
        case 'definitionDescription': return tag('dd');
        case 'glossary':
          // Indented glossary syntax can remain paragraphs in the official AST.
          // Keep their source lines visible instead of collapsing term aliases.
          return `<div class="myst-glossary">${node.children?.map(child => render(child as Node, stack, child.type === 'paragraph')).join('') ?? ''}</div>`;
        case 'link': {
          const target = node.url?.startsWith('#') ? state.getTarget(node.url.slice(1))?.node : undefined;
          const open = new TokenType('link_open', 'a', 1);
          open.attrSet('href', safeUrl(node.url ?? ''));
          if (node.title) open.attrSet('title', node.title);
          return md.renderer.render([open], md.options, environment) + (children() || (target ? escape(`${target.type === 'container' ? target.kind : target.type} ${target.enumerator ?? target.label ?? ''}`) : escape((node.static ? undefined : documentTitle(node.url ?? '', environment)) ?? node.url ?? ''))) + '</a>';
        }
        case 'crossReference': {
          if (!node.resolved) return `<span class="myst-unresolved">${children() || escape(node.label ?? node.identifier)}</span>`;
          const open = new TokenType('link_open', 'a', 1);
          open.attrSet('href', safeUrl(node.url ?? `#${node.html_id ?? node.identifier}`));
          return md.renderer.render([open], md.options, environment) + children() + '</a>';
        }
        case 'image': {
          const url = resource(node.url, environment);
          const style = `width:${size(node.width) || 'auto'};height:${size(node.height) || 'auto'};${node.align === 'center' ? 'display:block;margin-inline:auto;' : node.align === 'right' ? 'display:block;margin-left:auto;' : ''}`;
          if (/\.(?:mp4|webm|ogv)(?:$|[?#])/i.test(url)) return `<video controls preload="metadata" src="${escape(url)}" style="${style}"></video>`;
          const image = new TokenType('image', 'img', 0);
          image.attrSet('src', url); image.attrSet('alt', node.alt ?? '');
          if (identifier(node)) image.attrSet('id', identifier(node));
          if (node.width || node.height || node.align) image.attrSet('style', style);
          const alt = new TokenType('text', '', 0); alt.content = node.alt ?? '';
          image.content = alt.content; image.children = [alt];
          return md.renderer.render([image], md.options, environment);
        }
        case 'container': {
          const parts = node.children ?? [];
          const captions = parts.filter(child => child.type === 'caption').map(child => render(child, stack)).join('');
          const content = parts.filter(child => child.type !== 'caption').map(child => render(child, stack)).join('');
          return `<figure${idAttr(node)} class="myst-figure ${escape(node.class ?? '')}">${extraAnchor(node)}${node.kind === 'table' || node.kind === 'code' ? captions + content : content + captions}</figure>`;
        }
        case 'caption': return tag('figcaption');
        case 'captionNumber': return tag('span', ' class="myst-caption-number"');
        case 'legend': return tag('div', ' class="myst-legend"');
        case 'table': {
          const rows = node.children ?? [];
          return `<table${attr(node)}>${rows.map((row, rowIndex) => `<tr>${row.children?.map(cell => `<${cell.header || rowIndex === 0 ? 'th' : 'td'}>${cell.children?.map(child => render(child as Node, stack)).join('') ?? ''}</${cell.header || rowIndex === 0 ? 'th' : 'td'}>`).join('') ?? ''}</tr>`).join('')}</table>`;
        }
        case 'aside': return tag('aside', ` class="myst-aside ${escape(node.kind ?? '')}"${node.html_id || node.identifier ? ` id="${escape(node.html_id || node.identifier)}"` : ''}`);
        case 'admonitionTitle': case 'cardTitle': return tag('div', ' class="myst-title"');
        case 'details': return tag('details', `${attr(node)}${node.open ? ' open' : ''}`);
        case 'summary': return tag('summary');
        case 'chemicalFormula': return escape(node.value).replace(/(?<=[A-Za-z)\]])(\d+)/g, '<sub>$1</sub>');
        case 'smallcaps': return tag('span', ' class="myst-smallcaps"');
        case 'toc': {
          const headings = allNodes.filter(candidate => candidate.type === 'heading' && identifier(candidate) && (!node.depth || candidate.depth <= node.depth));
          return headings.length ? `<nav class="myst-toc" aria-label="Table of contents"><ul>${headings.map(heading => `<li style="margin-left:${Math.max(0, Math.min(5, heading.depth - 1))}em"><a href="#${escape(identifier(heading))}">${escape(text(heading))}</a></li>`).join('')}</ul></nav>` : '';
        }
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
          if (!block && (!node.value || /^\s|\s$/.test(node.value))) return escape(`$${node.value ?? ''}$`);
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
            const notebookStack = notebookContext?.stack ?? [];
            if (notebookStack.includes(embedded.file) || notebookStack.length >= host.settings(environment).maxEmbedDepth) return error('Cyclic or deeply nested notebook embed stopped.');
            try {
              const notebook = JSON.parse(embedded.content);
              return notebook.cells.filter((cell: any) => !label || cell.id === label || cell.metadata?.tags?.includes(`label:${label}`)).map((cell: any) => {
                const input = Array.isArray(cell.source) ? cell.source.join('') : cell.source ?? '';
                if (cell.cell_type === 'markdown') return previewRender(input, { ...environment, currentDocument: host.documentUri(embedded.file), mystNotebookContext: { stack: [...notebookStack, embedded.file], budget: readBudget } });
                return `${node['remove-input'] ? '' : render({ type: 'code', lang: notebook.metadata?.kernelspec?.language ?? 'python', value: input } as Node, stack)}${node['remove-output'] ? '' : cell.outputs?.map((output: any) => output.data?.['image/png'] ? `<img alt="Notebook output" src="data:image/png;base64,${escape(output.data['image/png'].join?.('') ?? output.data['image/png'])}">` : output.data?.['text/html'] ? (md.options.html ? output.data['text/html'].join?.('') ?? output.data['text/html'] : escape(output.data['text/html'])) : `<pre class="myst-output">${escape((output.text ?? output.data?.['text/plain'])?.join?.('') ?? output.text ?? output.data?.['text/plain'] ?? '')}</pre>`).join('') ?? ''}`;
              }).join('');
            } catch { return error('Cannot parse embedded notebook.'); }
          }
          const embeddedHeader = stripHeader(embedded.content);
          const parsed = parse(embeddedHeader.body, embedded.file, metadata, true, embeddedHeader.frontmatter).tree;
          prepare(parsed, { ...environment, currentDocument: host.documentUri(embedded.file), mystIncluded: true }, [embedded.file]);
          if (label) { let selected: Node | undefined; walk(parsed, candidate => { if (candidate.identifier === label) selected = candidate; }); return selected ? render(selected, [...stack, target]) : error(`Embed target not found: ${label}`); }
          return render(parsed, [...stack, target]);
        }
        case 'footnoteReference': {
          const number = footnoteNumbers.get(node.identifier);
          return `<sup class="footnote-ref"><a id="${escape(node._footnoteAnchor)}" href="#fn${escape(footnoteIds.get(node.identifier))}">[${number ?? '?'}]</a></sup>`;
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
      const line = env.obsidian?.prefix ? undefined : node.position?.start.line;
      return `<div${line ? ` class="code-line" data-line="${line - 1}"` : ''}>${render(node)}</div>`;
    };
    const content = tree.children?.map((child: Node) => renderMapped(child)).join('') ?? '';
    const footnotes = definitions.length ? `<section class="footnotes obsidian-footnotes"><ol class="obsidian-footnotes-list">${definitions.map(node => {
      const backlinks = footnoteBacklinks((footnoteReferences.get(node.identifier) ?? []).map(reference => ({ anchor: reference._footnoteAnchor })));
      const parts = node.children ?? [];
      const last = parts.at(-1);
      const content = last?.type === 'paragraph'
        ? parts.slice(0, -1).map(child => render(child)).join('') + `<p${attr(last)}>${last.children?.map(child => render(child)).join('') ?? ''}${backlinks}</p>`
        : parts.map(child => render(child)).join('') + backlinks;
      return `<li class="footnote-item" id="fn${escape(footnoteIds.get(node.identifier))}"><span class="obsidian-footnote-number">${footnoteNumbers.get(node.identifier) ?? '?'}.</span><div class="obsidian-footnote-content">${content}</div></li>`;
    }).join('')}</ol></section>` : '';

    return (config.error ? error(config.error) : '') + content + footnotes;
  };
  return md;
}
