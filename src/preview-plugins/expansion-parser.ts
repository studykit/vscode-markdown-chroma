import { defaultOptions, mystParse } from 'myst-parser';
import { previewMystOptions } from '../myst-options';
import { occurrences } from '../index/expansion-source';

/** Parse only the caller-selected source. Gate callbacks before nested parsing. */
export function parseExpansion(source: string, vfile: any, directives: any[], roles: any[], settings: any, maxDepth: number, depth = 0): any {
  const items = occurrences(source);
  const known = new Set([...defaultOptions.directives, ...previewMystOptions.directives, ...directives].flatMap(spec => [spec.name, ...(typeof spec.alias === 'string' ? [spec.alias] : spec.alias ?? [])]));
  const unknown = [...new Set(items.filter(item => !known.has(item.name) && item.name !== 'obsidian-embed').map(item => item.name))].map(name => ({
    name, arg: { type: 'string' }, body: { type: 'string' }, options: Object.fromEntries(items.filter(item => item.name === name).flatMap(item => Object.keys(item.node.options ?? {})).map(key => [key, { type: 'string' }])),
    run(data: any, file: any) { file.message(`Directive ${name} could not be expanded; original syntax retained.`); return [{ type: 'expansionSource', value: items.find(item => item.name === name && item.startLine === data.node.position.start.line)?.source ?? '' }]; },
  }));
  const parse = (text: string, nextDepth: number) => parseExpansion(text, vfile, directives, roles, settings, maxDepth, nextDepth);
  const wrap = (spec: any, kind: 'directive' | 'role') => ({ ...spec,
    // Prevent upstream from eagerly executing children of a custom directive.
    ...(kind === 'directive' && spec.body?.type === 'myst' ? { body: { ...spec.body, type: 'string' } } : {}),
    ...(kind === 'directive' && spec.arg?.type === 'myst' ? { arg: { ...spec.arg, type: 'string' } } : {}),
    run(data: any, file: any, context: any) {
      const line = data.node?.position?.start.line;
      const occurrence = items.find(item => item.startLine === line && item.name === data.name);
      const ancestors = kind === 'directive' ? items.filter(item => item.startLine < line && item.endLine >= (occurrence?.endLine ?? line)).length : 0;
      const level = depth + ancestors;
      if (kind === 'role' && level > maxDepth) {
        file.message('Nested role depth limit reached; original syntax retained.');
        return [{ type: 'expansionSource', value: `{${data.name}}\`${data.node?.value ?? ''}\`` }];
      }
      if (kind === 'directive' && level >= maxDepth) {
        file.message('Nested directive depth limit reached; original syntax retained.');
        return [{ type: 'expansionSource', value: occurrence?.source ?? data.node?.value ?? '' }];
      }
      if (kind === 'directive') {
        if (spec.body?.type === 'myst' && typeof data.body === 'string') data.body = parse(data.body, level + 1).children;
        if (spec.arg?.type === 'myst' && typeof data.arg === 'string') data.arg = parse(data.arg, level + 1).children[0]?.children ?? [];
      }
      const output = spec.run(data, file, { ...context, parseMyst: (text: string) => parse(text, level + 1) });
      const mark = (nodes: any[]) => { for (const node of nodes) { if (node.type === 'include' || node.type === 'embed') node._expansionDepth ??= level + 2; if (node.children) mark(node.children); } };
      mark(output); return output;
    },
  });
  const tree = mystParse(source, { ...previewMystOptions, vfile,
    directives: [...previewMystOptions.directives, ...directives.map(spec => wrap(spec, 'directive')), ...unknown],
    roles: [...previewMystOptions.roles, ...roles.map(spec => wrap(spec, 'role'))],
    extensions: { ...previewMystOptions.extensions, math: settings?.parser?.dollarmath === false ? { dollarmath: false, amsmath: true } : true },
  });
  const mark = (node: any) => {
    if (node.type === 'include' || node.type === 'embed') node._expansionDepth ??= depth + 1;
    if (node.type === 'mystDirective' && ['include', 'literalinclude'].includes(node.name)) for (const child of node.children ?? []) if (child.type === 'include') child._expansionOptions = node.options ?? {};
    node.children?.forEach(mark);
  };
  mark(tree); return tree;
}
