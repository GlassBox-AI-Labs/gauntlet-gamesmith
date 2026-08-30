const fs = require('node:fs');
const path = require('node:path');

if (process.platform === 'darwin') {
  const packageRoot = path.dirname(path.dirname(require.resolve('node-pty')));
  const helper = path.join(packageRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  fs.chmodSync(helper, 0o755);
}
