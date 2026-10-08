import {
  Pencil, ClipboardList, Info, CircleCheck, Flame, Check, CircleHelp,
  TriangleAlert, X, Zap, Bug, List, Quote, type IconNode
} from 'lucide';

const icons: Record<string, IconNode> = {
  note: Pencil, abstract: ClipboardList, info: Info, todo: CircleCheck,
  tip: Flame, success: Check, question: CircleHelp, warning: TriangleAlert,
  failure: X, danger: Zap, bug: Bug, example: List, quote: Quote
};

export function calloutIcon(type: string): string {
  const children = (icons[type] ?? Pencil).map(([tag, attrs]) => {
    const attributes = Object.entries(attrs).map(([key, value]) => ` ${key}="${value}"`).join('');
    return `<${tag}${attributes}/>`;
  }).join('');
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">${children}</svg>`;
}
