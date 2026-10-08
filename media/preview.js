import { icons, createElement } from 'lucide';
import mermaid from 'mermaid';

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
  let diagramCounter = 0;
  let diagramsReady = false;
  const renderedDiagrams = new WeakSet();
  const boundTabs = new WeakSet();
  const restore = () => {
    if (!document?.body) return;
    document.querySelectorAll('.myst-tabs').forEach(element => {
      if (boundTabs.has(element)) return;
      boundTabs.add(element);
      const tabs = [...element.querySelectorAll(':scope > [role="tablist"] > [role="tab"]')];
      const panels = [...element.querySelectorAll(':scope > [role="tabpanel"]')];
      const select = index => {
        tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
        panels.forEach((panel, i) => { panel.hidden = i !== index; });
      };
      const group = `myst-tabs-${++diagramCounter}`;
      tabs.forEach((tab, index) => {
        tab.id = `${group}-tab-${index}`;
        if (panels[index]) { panels[index].id = `${group}-panel-${index}`; panels[index].setAttribute('aria-labelledby', tab.id); tab.setAttribute('aria-controls', panels[index].id); }
        tab.addEventListener('click', () => select(index));
        tab.addEventListener('keydown', event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
          if (next !== undefined) { event.preventDefault(); select(next); tabs[next].focus(); }
        });
      });
    });
    document.querySelectorAll('.myst-mermaid').forEach(element => {
      if (renderedDiagrams.has(element)) return;
      renderedDiagrams.add(element);
      if (!diagramsReady) { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 50000, theme: document.body.classList.contains('vscode-dark') ? 'dark' : 'default' }); diagramsReady = true; }
      mermaid.render(`myst-diagram-${++diagramCounter}`, element.textContent).then(({ svg }) => {
        if (element.isConnected) element.innerHTML = svg;
      }).catch(() => { element.setAttribute('title', 'Unable to render Mermaid diagram'); });
    });
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
