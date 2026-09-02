const { execFileSync } = require('node:child_process');

const notarizationCredentials = [
  {
    label: 'App Store Connect API key',
    variables: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  },
  {
    label: 'Apple ID',
    variables: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  },
  { label: 'notarytool keychain profile', variables: ['APPLE_KEYCHAIN_PROFILE'] },
];

if (process.platform !== 'darwin') {
  throw new Error('Trusted macOS releases must be built on macOS.');
}

const activeCredentialSets = notarizationCredentials.filter(({ variables }) =>
  variables.some((variable) => process.env[variable]),
);

if (activeCredentialSets.length === 0) {
  const expected = notarizationCredentials
    .map(({ label, variables }) => `  ${label}: ${variables.join(', ')}`)
    .join('\n');
  throw new Error(
    `Apple notarization credentials are missing. Set one complete credential group:\n${expected}`,
  );
}

if (activeCredentialSets.length > 1) {
  throw new Error(
    'Multiple Apple notarization credential groups are set. Keep exactly one of: ' +
      notarizationCredentials.map(({ label }) => label).join(', '),
  );
}

const completeCredentialSet = activeCredentialSets[0];
const missingCredentialVariables = completeCredentialSet.variables.filter(
  (variable) => !process.env[variable],
);
if (missingCredentialVariables.length > 0) {
  throw new Error(
    `${completeCredentialSet.label} credentials are incomplete. Missing: ` +
      missingCredentialVariables.join(', '),
  );
}

const certificateVariables = ['CSC_LINK', 'CSC_KEY_PASSWORD'];
const activeCertificateVariables = certificateVariables.filter((variable) => process.env[variable]);
if (activeCertificateVariables.length === 1) {
  throw new Error(
    `Certificate credentials are incomplete. Set both: ${certificateVariables.join(', ')}`,
  );
}

const certificateProvidedByEnvironment = activeCertificateVariables.length === 2;
if (!certificateProvidedByEnvironment) {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  if (!identities.includes('Developer ID Application:')) {
    throw new Error(
      'No valid Developer ID Application certificate was found in the keychain. ' +
        'Install one with Xcode or set CSC_LINK and CSC_KEY_PASSWORD.',
    );
  }
}

execFileSync('xcrun', ['--find', 'notarytool'], { stdio: 'ignore' });
execFileSync('xcrun', ['--find', 'stapler'], { stdio: 'ignore' });

console.log(`Apple notarization credentials: ${completeCredentialSet.label}`);
console.log('electron-builder will require a valid Developer ID Application signing certificate.');
