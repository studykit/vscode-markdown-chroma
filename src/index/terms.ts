import { glossaryIdentifier } from '../glossary';
import type { Term } from './types';

export const matchesTermIdentifier = (term: Term, identifier: string) =>
  term.identifier === identifier || term.aliases.some(alias => glossaryIdentifier(alias) === identifier);
export const matchesTermName = (term: Term, name: string) => matchesTermIdentifier(term, glossaryIdentifier(name));
