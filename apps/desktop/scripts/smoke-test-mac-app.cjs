const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const desktopPackage = require('../package.json');
const productName = desktopPackage.build.productName;
const defaultAppPath = path.resolve(__dirname, `../../../dist/mac-arm64/${productName}.app`);
const appPath = path.resolve(process.argv[2] || defaultAppPath);
const executablePath = path.join(appPath, 'Contents', 'MacOS', productName);
const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-smoke-data-'));
const successMarker = 'GAUNTLET_SMOKE_TEST_OK';
const timeoutMs = 15_000;

if (process.platform !== 'darwin') {
  throw new Error('The packaged macOS app smoke test must run on macOS.');
}
if (!fs.existsSync(executablePath)) {
  throw new Error(`Packaged app executable not found: ${executablePath}`);
}

const child = spawn(executablePath, ['--gauntlet-smoke-test', '--disable-error-dialogs'], {
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    GAUNTLET_SMOKE_USER_DATA: userDataPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let settled = false;

function record(chunk) {
  output += chunk.toString();
}

function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  fs.rmSync(userDataPath, { recursive: true, force: true });
  if (error) throw error;
  console.log(`Packaged app launched successfully: ${appPath}`);
}

child.stdout.on('data', record);
child.stderr.on('data', record);
child.on('error', (error) => finish(error));
child.on('exit', (code, signal) => {
  if (!output.includes(successMarker)) {
    finish(
      new Error(
        `Packaged app exited without completing startup (code=${code}, signal=${signal}).` +
          (output.trim() ? `\n${output.trim()}` : ''),
      ),
    );
    return;
  }
  if (code !== 0) {
    finish(new Error(`Packaged app completed startup but exited with code ${code}.\n${output}`));
    return;
  }
  finish();
});

const timer = setTimeout(() => {
  child.kill('SIGKILL');
  finish(
    new Error(
      `Packaged app did not complete startup within ${timeoutMs / 1000} seconds.` +
        (output.trim() ? `\n${output.trim()}` : ''),
    ),
  );
}, timeoutMs);
