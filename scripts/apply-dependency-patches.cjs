const { existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Published consumers use prebuilt bundles and do not ship source or patches.
// Source checkouts must apply the pinned export-only patch before type checking.
const root = path.resolve(__dirname, '..');
if (existsSync(path.join(root, 'patches/myst-parser+1.7.4.patch'))) {
  execFileSync(process.execPath, [require.resolve('patch-package'), '--error-on-fail'], { cwd: root, stdio: 'inherit' });
}
