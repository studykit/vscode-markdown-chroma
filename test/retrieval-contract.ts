import assert from 'node:assert/strict';

const internal = new Set(['schemaVersion', 'sourceHash', 'root', 'cacheFile', 'generation', 'parsed', 'reused', 'removed',
  'startLine', 'endLine', 'ownEndLine', 'signature', 'configHash', 'properties', 'tags', 'aliases', 'outgoing',
  'diagnostics', 'localId', 'identifier', 'resolution', 'syntax', 'targetId', 'labels']);

export function assertRetrievalResult(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) assertRetrievalResult(item); }
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const termAliases = key === 'aliases' && 'name' in value && 'file' in value && 'id' in value
        && typeof value.id === 'string' && value.id.includes('#term-') && Array.isArray(item) && item.every(alias => typeof alias === 'string');
      assert.ok(!internal.has(key) || termAliases, `Implementation field exposed: ${key}`);
      assertRetrievalResult(item);
    }
  }
}
