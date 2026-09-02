const fs = require('node:fs');
const path = require('node:path');

if (process.platform === 'darwin') {
  const packageRoot = path.dirname(path.dirname(require.resolve('node-pty')));
  for (const arch of ['arm64', 'x64']) {
    const helper = path.join(packageRoot, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
