import { gridDirectives } from 'myst-ext-grid';
import { cardDirective } from 'myst-ext-card';
import { tabDirectives } from 'myst-ext-tabs';
import { proofDirective } from 'myst-ext-proof';
import { exerciseDirectives } from 'myst-ext-exercise';
import { buttonRole } from 'myst-ext-button';

// Shared by the synchronous preview and the project-plugin worker.
export const previewMystOptions = {
  directives: [...gridDirectives, cardDirective, ...tabDirectives, proofDirective, ...exerciseDirectives],
  roles: [buttonRole], extensions: { frontmatter: false, strikethrough: true }
};
