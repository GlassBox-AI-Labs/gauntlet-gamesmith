const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const desktopPackage = require('../package.json');
const productName = desktopPackage.build.productName;
const distDirectory = path.resolve(__dirname, '../../../dist');
const defaultArtifacts = ['arm64', 'x64'].map((arch) =>
  path.join(
    distDirectory,
    `${productName}-${desktopPackage.version}-mac-${arch}.dmg`,
  ),
);
const requestedArtifacts = process.argv.slice(2).filter((argument) => argument !== '--');
const artifacts = requestedArtifacts.length
  ? requestedArtifacts.map((artifact) => path.resolve(artifact))
  : defaultArtifacts;

if (process.platform !== 'darwin') {
  throw new Error('macOS release verification must run on macOS.');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}` +
        (output ? `:\n${output}` : ''),
    );
  }

  return output;
}

function requireMatch(output, pattern, message) {
  if (!pattern.test(output)) throw new Error(`${message}\n${output}`);
}

function verifyArtifact(dmgPath) {
  if (!fs.existsSync(dmgPath)) throw new Error(`Release artifact not found: ${dmgPath}`);

  const artifactName = path.basename(dmgPath);
  const expectedArchitecture = artifactName.includes('-arm64.dmg') ? 'arm64' : 'x86_64';
  const mountDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-release-'));
  let mounted = false;

  try {
    run('hdiutil', ['verify', dmgPath]);
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountDirectory, dmgPath]);
    mounted = true;

    const appPath = path.join(mountDirectory, `${productName}.app`);
    const executablePath = path.join(appPath, 'Contents', 'MacOS', productName);
    const applicationsLink = path.join(mountDirectory, 'Applications');

    if (!fs.statSync(appPath).isDirectory()) {
      throw new Error(`${artifactName} does not contain ${productName}.app.`);
    }
    if (!fs.lstatSync(applicationsLink).isSymbolicLink()) {
      throw new Error(`${artifactName} does not contain an Applications shortcut.`);
    }

    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    const signature = run('codesign', ['--display', '--verbose=4', appPath]);
    requireMatch(
      signature,
      /^Authority=Developer ID Application:/m,
      `${artifactName} is not signed with a Developer ID Application certificate.`,
    );
    requireMatch(
      signature,
      /^TeamIdentifier=(?!not set$).+/m,
      `${artifactName} does not have an Apple Developer team identifier.`,
    );
    requireMatch(
      signature,
      /^CodeDirectory .*flags=.*\bruntime\b/m,
      `${artifactName} is not signed with Apple's hardened runtime.`,
    );

    const architecture = run('file', [executablePath]);
    requireMatch(
      architecture,
      new RegExp(`\\b${expectedArchitecture}\\b`),
      `${artifactName} contains the wrong executable architecture.`,
    );

    const hostArchitecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    if (expectedArchitecture === hostArchitecture) {
      run(process.execPath, [path.join(__dirname, 'smoke-test-mac-app.cjs'), appPath]);
    }

    const gatekeeper = run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
    requireMatch(gatekeeper, /\baccepted\b/, `${artifactName} was rejected by Gatekeeper.`);
    run('xcrun', ['stapler', 'validate', appPath]);

    console.log(`Verified trusted macOS release: ${artifactName}`);
  } finally {
    if (mounted) {
      run('hdiutil', ['detach', mountDirectory]);
    }
    fs.rmSync(mountDirectory, { recursive: true, force: true });
  }
}

for (const artifact of artifacts) verifyArtifact(artifact);
