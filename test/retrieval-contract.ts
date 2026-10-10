import assert from 'node:assert/strict';

const internal = new Set(['schemaVersion', 'sourceHash', 'root', 'cacheFile', 'generation', 'parsed', 'reused', 'removed',
  'startLine', 'endLine', 'ownEndLine', 'signature', 'configHash', 'properties', 'tags', 'aliases', 'outgoing',
  'diagnostics', 'localId', 'identifier', 'resolution', 'syntax', 'targetId', 'labels']);

export function assertRetrievalResult(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) assertRetrievalResult(item); }
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!internal.has(key), `Implementation field exposed: ${key}`);
      assertRetrievalResult(item);
    }
  }
}
