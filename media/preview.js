import { icons, createElement } from 'lucide';

(() => {
  if (window.__obsidianMarkdownPreview) return;
  window.__obsidianMarkdownPreview = true;
  // Built-in previews replace their body on updates. Preserve user folding choices.
  const folds = new Map();
  const appliedIcons = new WeakMap();
  const defaultIcons = new WeakMap();
  const svgTags = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'title', 'desc']);
  const svgAttributes = new Set(['viewBox', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'points', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'transform', 'vector-effect']);
  const customSvg = (source) => {
    if (source.length > 20000) return null;
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = parsed.documentElement;
    if (root.localName !== 'svg' || parsed.querySelector('parsererror')) return null;
    for (const element of [root, ...root.querySelectorAll('*')]) {
      if (!svgTags.has(element.localName)) { element.remove(); continue; }
      for (const attribute of [...element.attributes]) {
        if (!svgAttributes.has(attribute.name) || /url\s*\(/i.test(attribute.value)) element.removeAttribute(attribute.name);
      }
    }
    const copy = (sourceElement) => {
      const target = document.createElementNS('http://www.w3.org/2000/svg', sourceElement.localName);
      for (const attribute of sourceElement.attributes) target.setAttribute(attribute.name, attribute.value);
      for (const child of sourceElement.childNodes) target.append(child.nodeType === 1 ? copy(child) : document.importNode(child, true));
      return target;
    };
    const svg = copy(root);
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  };
  const updateIcon = (callout) => {
    const icon = callout.querySelector(':scope > .obsidian-callout-title > .obsidian-callout-icon');
    if (!icon) return;
    const style = getComputedStyle(callout);
    // Older Obsidian snippets use an RGB triplet instead of a CSS color.
    const color = style.getPropertyValue('--callout-color').trim();
    if (/^\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?$/.test(color)) {
      callout.style.setProperty('--obsidian-callout-color', `rgb(${color})`);
    } else {
      callout.style.removeProperty('--obsidian-callout-color');
    }
    let value = style.getPropertyValue('--callout-icon').trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1).replace(/\\([\\'"])/g, '$1');
    if (appliedIcons.get(icon) === value) return;
    appliedIcons.set(icon, value);
    if (!defaultIcons.has(icon)) defaultIcons.set(icon, icon.firstElementChild?.cloneNode(true));
    const name = value.replace(/^lucide-/, '').replace(/(^|-)([a-z0-9])/g, (_, _dash, letter) => letter.toUpperCase());
    const node = Object.hasOwn(icons, name) ? icons[name] : undefined;
    const replacement = value.startsWith('<svg') ? customSvg(value) : node ? createElement(node, { 'aria-hidden': 'true', focusable: 'false' }) : null;
    const fallback = defaultIcons.get(icon)?.cloneNode(true);
    if (replacement || fallback) icon.replaceChildren(replacement ?? fallback);
  };
  const restore = () => {
    if (!document?.body) return;
    document.querySelectorAll('.obsidian-callout').forEach(updateIcon);
    document.querySelectorAll('details.obsidian-callout').forEach((element, index) => {
      const title = element.querySelector('summary')?.textContent ?? '';
      const key = `${index}:${element.dataset.callout}:${title}`;
      if (folds.has(key)) element.open = folds.get(key);
      if (element.dataset.obsidianFoldBound) return;
      element.dataset.obsidianFoldBound = 'true';
      element.addEventListener('toggle', () => folds.set(key, element.open));
    });
  };
  const observer = new MutationObserver(restore);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('load', restore, true);
  restore();
})();
