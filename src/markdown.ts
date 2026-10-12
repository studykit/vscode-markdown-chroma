import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import mark from 'markdown-it-mark';
import GithubSlugger from 'github-slugger';
import { installFootnotes } from './footnotes';
import { calloutIcon } from './callout-icons';
import { findSection, parseWiki, plainText, sectionSource } from './references';
import type { PreviewHost, RenderEnvironment, WikiReference } from './types';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.bmp']);
const audioExtensions = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm', '.aac', '.opus']);
const videoExtensions = new Set(['.mp4', '.mkv', '.mov', '.ogv']);
const calloutTypes: Record<string, string> = {
  abstract: 'abstract', summary: 'abstract', tldr: 'abstract', info: 'info', todo: 'todo',
  tip: 'tip', hint: 'tip', important: 'tip', success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question', warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'failure', fail: 'failure', missing: 'failure', danger: 'danger', error: 'danger',
  bug: 'bug', example: 'example', quote: 'quote', cite: 'quote', note: 'note'
};
const colors: Record<string, string> = { '🔴': 'red', '🟠': 'orange', '🟡': 'yellow', '🟢': 'green', '🔵': 'blue', '🟣': 'purple' };

function cloneToken(token: Token): Token {
  return Object.assign(Object.create(Object.getPrototypeOf(token)), token, {
    attrs: token.attrs?.map(attribute => [...attribute]), meta: token.meta ? { ...token.meta } : null
  });
}

export function extendObsidianMarkdown(md: MarkdownIt, host: PreviewHost): MarkdownIt {
  // VS Code owns the markdown-it instance; no second parser/runtime is bundled.
  const TokenClass = md.parseInline('', {})[0].constructor as typeof Token;
  const escape = md.utils.escapeHtml;
  installFootnotes(md);
  md.use(mark);

  const sourcePath = (env: RenderEnvironment) => {
    const document = env.currentDocument;
    return document && (!document.scheme || document.scheme === 'file') ? document.fsPath : undefined;
  };
  const fileHref = (file: string, anchor: string, env: RenderEnvironment) => {
    const previewFile = env.previewDocument?.fsPath ?? sourcePath(env);
    if (file === previewFile && anchor) return `#${encodeURIComponent(anchor)}`;
    const destination = previewFile
      ? path.relative(path.dirname(previewFile), file).split(path.sep).map(encodeURIComponent).join('/')
      : pathToFileURL(file).href;
    return destination + (anchor ? `#${encodeURIComponent(anchor)}` : '');
  };
  const context = (env: RenderEnvironment) => env.obsidian ??= {
    stack: sourcePath(env) ? [`${sourcePath(env)}#`] : [], budget: { count: 0, bytes: 0 }, prefix: ''
  };
  const errorHtml = (reference: WikiReference, message: string, block = false) => {
    const tag = block ? 'aside' : 'span';
    return `<${tag} class="obsidian-embed-error" role="note">${escape(message)} <code>${escape(reference.raw)}</code></${tag}>`;
  };
  const linkHtml = (reference: WikiReference, env: RenderEnvironment): string => {
    const resolution = host.resolve(reference.target, sourcePath(env));
    const label = reference.label ?? (reference.target ? reference.target.replace(/\.md$/i, '') + (reference.fragment ? ` › ${reference.fragment.replace(/^\^/, '')}` : '') : reference.fragment.replace(/^\^/, ''));
    if (resolution.status !== 'found') {
      const title = resolution.status === 'ambiguous' ? 'More than one note matches. Use a folder path.'
        : resolution.status === 'outside' ? 'Link is outside this document root.' : 'File not found in this document root.';
      return `<span class="obsidian-link is-unresolved" title="${escape(title)}" data-target="${escape(reference.target)}">${escape(label)}</span>`;
    }
    let anchor = '';
    if (reference.fragment && path.extname(resolution.path).toLowerCase() === '.md') {
      const source = host.read(resolution.path);
      const section = source === undefined ? undefined : findSection(md, source, reference.fragment);
      if (!section) return `<span class="obsidian-link is-unresolved" title="Heading or block not found.">${escape(label)}</span>`;
      anchor = section.anchor;
    } else anchor = reference.fragment;
    const href = fileHref(resolution.path, anchor, env);
    return `<a class="obsidian-link" href="${escape(href)}" data-href="${escape(href)}">${escape(label)}</a>`;
  };

  const embedHtml = (reference: WikiReference, env: RenderEnvironment, block: boolean): string => {
    const resolution = host.resolve(reference.target, sourcePath(env));
    if (resolution.status !== 'found') return errorHtml(reference,
      resolution.status === 'ambiguous' ? 'Ambiguous embed; specify a folder.' : resolution.status === 'outside' ? 'Embed is outside this document root.' : 'Embedded file not found.', block);
    const extension = path.extname(resolution.path).toLowerCase();
    if (imageExtensions.has(extension)) {
      const image = new TokenClass('image', 'img', 0);
      image.attrSet('src', host.resourceUri(resolution.path, env));
      image.attrSet('alt', '');
      const size = /^(\d+)(?:x(\d+))?$/.exec(reference.label ?? '');
      if (size) {
        image.attrSet('width', size[1]);
        if (size[2]) image.attrSet('height', size[2]);
      }
      image.attrSet('class', 'obsidian-image');
      const alt = new TokenClass('text', '', 0);
      alt.content = size ? path.basename(resolution.path) : reference.label ?? path.basename(resolution.path);
      image.children = [alt];
      image.content = alt.content;
      env.containingImages?.add(pathToFileURL(resolution.path).href);
      return md.renderer.rules.image!([image], 0, md.options, env, md.renderer);
    }
    if (audioExtensions.has(extension) || videoExtensions.has(extension)) {
      const tag = audioExtensions.has(extension) ? 'audio' : 'video';
      return `<${tag} class="obsidian-media" controls preload="metadata" src="${escape(host.resourceUri(resolution.path, env))}">${linkHtml(reference, env)}</${tag}>`;
    }
    if (extension !== '.md') return `<span class="obsidian-attachment">${linkHtml(reference, env)}</span>`;
    if (!block) return `<span class="obsidian-embed-inline" title="Put a note embed on its own line to display its contents.">${linkHtml(reference, env)}</span>`;
    const current = context(env);
    const identity = `${resolution.path}#${reference.fragment}`;
    if (current.stack.includes(identity)) return errorHtml(reference, 'Cyclic embed stopped.', true);
    if (current.stack.length > host.settings(env).maxEmbedDepth) return errorHtml(reference, 'Maximum embed depth reached.', true);
    const source = host.read(resolution.path);
    if (source === undefined) return errorHtml(reference, 'Cannot read this note (limit: 2 MiB).', true);
    if (++current.budget.count > 100 || (current.budget.bytes += Buffer.byteLength(source)) > 4 * 1024 * 1024) {
      return errorHtml(reference, 'Preview embed limit reached.', true);
    }
    let selected = source;
    if (reference.fragment) {
      const section = findSection(md, source, reference.fragment);
      if (!section) return errorHtml(reference, 'Embedded heading or block not found.', true);
      selected = sectionSource(source, section, md);
    }
    const prefix = `obsidian-embed-${current.budget.count}-`;
    const slugger = new GithubSlugger();
    const child: RenderEnvironment = {
      ...env, currentDocument: host.documentUri(resolution.path), previewDocument: env.previewDocument ?? env.currentDocument, docId: prefix,
      slugifier: { add: title => ({ value: slugger.slug(title) }) },
      obsidian: { stack: [...current.stack, identity], budget: current.budget, prefix },
      obsidianSlugger: undefined, footnotes: undefined
    };
    const tokens = md.parse(selected, child);
    // Embedded lines belong to another file, not to the parent editor's scroll map.
    for (const token of tokens) {
      token.map = null;
      token.attrs = token.attrs?.filter(([name]) => name !== 'data-line') ?? null;
      if (token.attrGet('class')) token.attrSet('class', token.attrGet('class')!.split(/\s+/).filter(name => name !== 'code-line').join(' '));
      if (token.children) for (const item of token.children) item.map = null;
    }
    const body = md.renderer.render(tokens, md.options, child);
    return `<article class="obsidian-note-embed"><div class="obsidian-embed-title">${linkHtml(reference, env)}</div><div class="obsidian-embed-content">${body}</div></article>`;
  };

  // Markdown Extended's kbd rule also consumes [[...]] before `link`.
  // Claim wiki syntax earlier, regardless of extension registration order.
  md.inline.ruler.before('escape', 'obsidian_wiki', (state, silent) => {
    if ((state as typeof state & { linkLevel: number }).linkLevel > 0) return false;
    const rest = state.src.slice(state.pos);
    const match = /^(?:!)?\[\[([^\]\n]+)\]\]/.exec(rest);
    if (!match) return false;
    const reference = parseWiki(match[0]);
    if (!reference) return false;
    if (!silent) {
      const token = state.push(match[0].startsWith('!') ? 'obsidian_embed' : 'obsidian_wiki', '', 0);
      token.meta = reference;
      const label = new TokenClass('text', '', 0);
      label.content = reference.label ?? reference.target.replace(/\.md$/i, '') + (reference.fragment ? ` › ${reference.fragment.replace(/^\^/, '')}` : '');
      token.children = [label];
    }
    state.pos += match[0].length;
    return true;
  });
  md.renderer.rules.obsidian_wiki = (tokens, index, _options, env) => linkHtml(tokens[index].meta, env);
  md.renderer.rules.obsidian_embed = (tokens, index, _options, env) => embedHtml(tokens[index].meta, env, false);

  md.block.ruler.before('paragraph', 'obsidian_embed_block', (state, startLine, _endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
    if (!line.startsWith('![[')) return false;
    const reference = parseWiki(line);
    if (!reference) return false;
    if (!silent) {
      const token = state.push('obsidian_embed_block', '', 0);
      token.meta = reference;
      token.map = [startLine, startLine + 1];
      token.block = true;
      state.line = startLine + 1;
    }
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.obsidian_embed_block = (tokens, index, _options, env, self) =>
  {
    const token = cloneToken(tokens[index]);
    token.attrJoin('class', 'obsidian-embed-block');
    return `<div${self.renderAttrs(token)}>${embedHtml(token.meta, env, true)}</div>\n`;
  };

  md.inline.ruler.before('text', 'obsidian_comment', (state, silent) => {
    if (!state.src.startsWith('%%', state.pos)) return false;
    const end = state.src.indexOf('%%', state.pos + 2);
    if (end < 0) return false;
    if (!silent) state.push('obsidian_comment', '', 0);
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.obsidian_comment = () => '';
  md.block.ruler.before('blockquote', 'obsidian_comment_block', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    if (!state.src.startsWith('%%', start)) return false;
    const end = state.src.indexOf('%%', start + 2);
    if (end < 0) return false;
    let closingLine = startLine;
    while (closingLine < endLine && state.eMarks[closingLine] < end + 2) closingLine++;
    if (closingLine >= endLine || state.src.slice(end + 2, state.eMarks[closingLine]).trim()) return false;
    if (!silent) state.line = closingLine + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  // Transform callout structure before inline parsing, keeping title/body syntax intact.
  md.core.ruler.after('block', 'obsidian_callouts', state => {
    for (let index = 0; index < state.tokens.length; index++) {
      const open = state.tokens[index];
      const paragraph = state.tokens[index + 1];
      const inline = state.tokens[index + 2];
      if (open.type !== 'blockquote_open' || paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
      const firstLineEnd = inline.content.indexOf('\n');
      const firstLine = firstLineEnd < 0 ? inline.content : inline.content.slice(0, firstLineEnd);
      const marker = /^\[!([\w-]+)\]([+-])?(?:[ \t]+(.*))?$/.exec(firstLine);
      if (!marker) continue;
      let depth = 1;
      let close: Token | undefined;
      for (let cursor = index + 1; cursor < state.tokens.length; cursor++) {
        if (state.tokens[cursor].type === 'blockquote_open') depth++;
        if (state.tokens[cursor].type === 'blockquote_close' && --depth === 0) { close = state.tokens[cursor]; break; }
      }
      if (!close) continue;
      const identifier = marker[1].toLowerCase();
      const metadata = { identifier, type: calloutTypes[identifier] ?? 'note', fold: marker[2] ?? '' };
      open.type = 'obsidian_callout_open'; open.meta = metadata;
      close.type = 'obsidian_callout_close'; close.meta = metadata;
      const titleOpen = new TokenClass('obsidian_callout_title_open', '', 1);
      const title = new TokenClass('inline', '', 0);
      const titleClose = new TokenClass('obsidian_callout_title_close', '', -1);
      titleOpen.meta = titleClose.meta = metadata;
      title.content = marker[3] ?? identifier.charAt(0).toUpperCase() + identifier.slice(1);
      title.children = [];
      title.map = inline.map ? [inline.map[0], inline.map[0] + 1] : null;
      const body = firstLineEnd < 0 ? '' : inline.content.slice(firstLineEnd + 1);
      const replacement = [titleOpen, title, titleClose];
      if (body) {
        inline.content = body;
        if (inline.map) inline.map = [inline.map[0] + 1, inline.map[1]];
        replacement.push(paragraph, inline, state.tokens[index + 3]);
      }
      state.tokens.splice(index + 1, 3, ...replacement);
    }
  });
  md.renderer.rules.obsidian_callout_open = (tokens, index, _options, _env, self) => {
    const token = cloneToken(tokens[index]);
    const metadata = token.meta;
    const tag = metadata.fold ? 'details' : 'div';
    token.attrJoin('class', 'callout obsidian-callout');
    token.attrSet('data-callout', metadata.identifier);
    token.attrSet('data-callout-style', metadata.type);
    return `<${tag}${self.renderAttrs(token)}${metadata.fold === '+' ? ' open' : ''}>\n`;
  };
  md.renderer.rules.obsidian_callout_title_open = (tokens, index) => {
    const meta = tokens[index].meta;
    return `<${meta.fold ? 'summary' : 'div'} class="callout-title obsidian-callout-title"><span class="callout-icon obsidian-callout-icon" aria-hidden="true">${calloutIcon(meta.type)}</span><span class="callout-title-inner obsidian-callout-title-text">`;
  };
  md.renderer.rules.obsidian_callout_title_close = (tokens, index) => {
    const fold = tokens[index].meta.fold;
    const chevron = fold ? '<svg class="obsidian-callout-fold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>' : '';
    return `</span>${chevron}</${fold ? 'summary' : 'div'}><div class="callout-content obsidian-callout-content">\n`;
  };
  md.renderer.rules.obsidian_callout_close = (tokens, index) => `</div></${tokens[index].meta.fold ? 'details' : 'div'}>\n`;

  md.inline.ruler.before('text', 'obsidian_tag', (state, silent) => {
    if (state.src[state.pos] !== '#' || (state as typeof state & { linkLevel: number }).linkLevel > 0) return false;
    if (state.pos > 0 && !/[\s([{]/.test(state.src[state.pos - 1])) return false;
    const match = /^#([\p{L}\p{M}\p{N}\p{Extended_Pictographic}\uFE0F\u200D_/-]+)/u.exec(state.src.slice(state.pos));
    if (!match || !/[^\p{N}]/u.test(match[1]) || match[1].endsWith('/')) return false;
    if (!silent) { const token = state.push('obsidian_tag', 'span', 0); token.content = match[0]; }
    state.pos += match[0].length;
    return true;
  });
  md.renderer.rules.obsidian_tag = (tokens, index) => `<span class="obsidian-tag">${escape(tokens[index].content)}</span>`;

  md.core.ruler.push('obsidian_blocks', state => {
    const tokens = state.tokens;
    const ancestors: Token[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.nesting === 1) ancestors.push(token);
      if (token.nesting === -1) ancestors.pop();
      if (token.type !== 'inline' || !token.children) continue;
      const children = token.children;
      for (let cursor = 0; cursor < children.length - 1; cursor++) {
        if (children[cursor].type !== 'mark_open' || children[cursor + 1].type !== 'text') continue;
        for (const [emoji, color] of Object.entries(colors)) {
          if (children[cursor + 1].content.startsWith(emoji)) {
            children[cursor].attrSet('data-highlight', color);
            children[cursor + 1].content = children[cursor + 1].content.slice(emoji.length);
            break;
          }
        }
      }
      const itemOpen = ancestors.findLast(item => item.type === 'list_item_open');
      const first = children[0];
      const task = first?.type === 'text' ? /^\[([^\]\n])\][ \t]+/.exec(first.content) : undefined;
      if (task && itemOpen && tokens[index - 1]?.type === 'paragraph_open') {
        first.content = first.content.slice(task[0].length);
        const checkbox = new TokenClass('obsidian_checkbox', 'input', 0);
        checkbox.meta = { checked: task[1] !== ' ', marker: task[1] };
        children.unshift(checkbox);
        itemOpen.attrJoin('class', 'obsidian-task');
        itemOpen.attrSet('data-task', task[1]);
      }

      const last = children.at(-1);
      if (last?.type !== 'text') continue;
      const standalone = /^\^([a-zA-Z0-9-]+)$/.exec(token.content.trim());
      const trailing = /[ \t]+\^([a-zA-Z0-9-]+)[ \t]*$/.exec(last.content);
      if (!standalone && !trailing) continue;
      let block: Token | undefined;
      if (standalone && tokens[index - 1]?.type === 'paragraph_open' && tokens[index + 1]?.type === 'paragraph_close') {
        const previous = tokens[index - 2];
        if (!previous || previous.type === 'inline') continue;
        if (previous.nesting === -1) {
          let depth = 1;
          for (let cursor = index - 3; cursor >= 0; cursor--) {
            depth -= tokens[cursor].nesting;
            if (depth === 0) { block = tokens[cursor]; break; }
          }
        } else block = previous;
        if (!block?.map) continue;
        tokens[index - 1].hidden = token.hidden = tokens[index + 1].hidden = true;
        token.children = [];
      } else {
        block = itemOpen ?? tokens[index - 1];
        if (!block?.map || !trailing) continue;
        last.content = last.content.slice(0, trailing.index);
        token.content = token.content.replace(/[ \t]+\^[a-zA-Z0-9-]+[ \t]*$/, '');
      }
      const id = (standalone ?? trailing)![1];
      block.attrSet('id', `obsidian-block-${id}`);
      block.attrSet('data-obsidian-block', id);
      block.meta = {
        ...block.meta, obsidianBlockRange: [...block.map!],
        obsidianBlockMarker: { map: token.map ? [...token.map] : undefined, standalone: !!standalone }
      };
    }
  });
  md.renderer.rules.obsidian_checkbox = (tokens, index) => {
    const meta = tokens[index].meta;
    return `<input class="obsidian-checkbox" type="checkbox" disabled${meta.checked ? ' checked' : ''} aria-label="${meta.checked ? 'Completed' : 'Incomplete'} task"> `;
  };

  const originalRenderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = (tokens, index, options) => {
    const env = activeEnvironment;
    const prefix = env?.obsidian?.prefix;
    if (prefix && tokens[index].attrGet('data-obsidian-block')) {
      const copy = [...tokens]; copy[index] = cloneToken(tokens[index]);
      copy[index].attrSet('id', prefix + copy[index].attrGet('id'));
      return originalRenderToken(copy, index, options);
    }
    return originalRenderToken(tokens, index, options);
  };
  // renderToken has no env argument. A stack keeps nested renders scoped correctly.
  let activeEnvironment: RenderEnvironment | undefined;
  const originalRender = md.renderer.render.bind(md.renderer);
  md.renderer.render = (tokens, options, env: RenderEnvironment) => {
    const previous = activeEnvironment;
    activeEnvironment = env;
    try { return originalRender(tokens, options, env); } finally { activeEnvironment = previous; }
  };
  const originalHeading = md.renderer.rules.heading_open;
  md.renderer.rules.heading_open = (tokens, index, options, env: RenderEnvironment, self) => {
    const copy = [...tokens];
    copy[index] = cloneToken(tokens[index]);
    const slugger = (env.obsidianSlugger ??= new GithubSlugger()) as GithubSlugger;
    const anchor = copy[index].attrGet('id') ?? slugger.slug(plainText(tokens[index + 1]));
    copy[index].attrSet('id', context(env).prefix + anchor);
    return originalHeading ? originalHeading(copy, index, options, env, self) : self.renderToken(copy, index, options);
  };

  const resolveMarkdown = (href: string, env: RenderEnvironment) => {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return;
    try {
      const hash = href.indexOf('#');
      const target = decodeURIComponent(hash < 0 ? href : href.slice(0, hash));
      const fragment = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
      const relative = host.resolve(target.startsWith('.') ? target : `./${target}`, sourcePath(env));
      return { resolution: relative.status === 'found' ? relative : host.resolve(target, sourcePath(env)), fragment };
    } catch { return; }
  };
  const originalLink = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, index, options, env: RenderEnvironment, self) => {
    const copy = [...tokens]; copy[index] = cloneToken(tokens[index]);
    const target = resolveMarkdown(copy[index].attrGet('href') ?? '', env);
    if (target?.resolution.status === 'found') {
      let fragment = target.fragment;
      if (fragment && path.extname(target.resolution.path).toLowerCase() === '.md') {
        const source = host.read(target.resolution.path);
        fragment = source === undefined ? fragment : findSection(md, source, fragment)?.anchor ?? fragment;
      }
      const href = fileHref(target.resolution.path, fragment, env);
      copy[index].attrSet('href', href);
      copy[index].attrSet('data-href', href);
    }
    return originalLink ? originalLink(copy, index, options, env, self) : self.renderToken(copy, index, options);
  };

  const originalImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, index, options, env: RenderEnvironment, self) => {
    const copy = [...tokens]; copy[index] = cloneToken(tokens[index]);
    const target = resolveMarkdown(copy[index].attrGet('data-src') ?? copy[index].attrGet('src') ?? '', env);
    if (target?.resolution.status === 'found') {
      copy[index].attrSet('src', host.resourceUri(target.resolution.path, env));
      copy[index].attrSet('data-src', pathToFileURL(target.resolution.path).href);
      env.containingImages?.add(pathToFileURL(target.resolution.path).href);
    }
    // Obsidian accepts both ![250](url) and ![alt|250x120](url).
    const size = /^(?:([\s\S]*?)\|)?(\d+)(?:x(\d+))?$/.exec(copy[index].content);
    if (size) {
      copy[index].attrSet('width', size[2]);
      if (size[3]) copy[index].attrSet('height', size[3]);
      const alt = new TokenClass('text', '', 0);
      alt.content = size[1] ?? '';
      copy[index].content = alt.content;
      copy[index].children = [alt];
    }
    return originalImage(copy, index, options, env, self);
  };
  return md;
}
