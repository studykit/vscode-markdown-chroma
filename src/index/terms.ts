import { glossaryIdentifier, termAlternateNames } from '../glossary';
import type { Term } from './types';

export const matchesTermIdentifier = (term: Term, identifier: string) =>
  term.identifier === identifier || termAlternateNames(term).some(name => glossaryIdentifier(name) === identifier);
export const matchesTermName = (term: Term, name: string) => matchesTermIdentifier(term, glossaryIdentifier(name));
