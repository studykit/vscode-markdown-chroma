import { fileWarn, normalizeLabel, RuleId, type GenericNode, type RoleSpec } from 'myst-common';

/** Labels in a `{src}` body: comma-separated, as written. */
export function sourceCitationLabels(body: string): string[] {
  return body.split(',').map(label => label.trim()).filter(Boolean);
}

/**
 * `{src}`s1`` and `{src}`s1, s2`` cite evidence by label. Each label links to its
 * target and shows the label itself, whatever the target is; one label is a bare
 * superscript and several are grouped in mathematical angle brackets ⟨ ⟩, apart
 * from bracketed footnotes.
 */
export const sourceCitationRole: RoleSpec = {
  name: 'src',
  doc: 'Cites labeled evidence. Shows each label as a superscript link; several labels are grouped in ⟨ ⟩.',
  body: { type: String, required: true },
  run(data, vfile) {
    const labels = sourceCitationLabels(String(data.body ?? ''));
    if (!labels.length) {
      fileWarn(vfile, 'The {src} role needs at least one label.', { node: data.node, source: 'role:src', ruleId: RuleId.roleBodyCorrect });
      return [];
    }
    const references: GenericNode[] = labels.map(label => {
      const reference = normalizeLabel(label);
      return { type: 'crossReference', identifier: reference?.identifier ?? label, label: reference?.label ?? label, children: [{ type: 'text', value: label }] };
    });
    const listed = references.flatMap((reference, index) => (index ? [{ type: 'text', value: ', ' }, reference] : [reference]));
    const children = labels.length > 1 ? [{ type: 'text', value: '⟨' }, ...listed, { type: 'text', value: '⟩' }] : listed;
    return [{ type: 'superscript', class: 'source-citation', sourceLabels: labels, children }];
  },
};
