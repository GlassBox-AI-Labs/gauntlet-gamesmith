# Gauntlet Gamesmith desktop

The Electron desktop app drives the stock Claude Code and Codex CLIs while keeping credentials entirely in each CLI's own store.

Two tabs:

- **Agents** — CLI detection, login-status probing, and an interactive PTY for signing in to Claude Code and Codex. It does not read credential files.
- **Run** — paste a goal prompt and start a Reference Study → implement → critique loop. Before Round 1, a solo research run downloads and audits an attributable, per-run Reference Pack under `reference/<loop-id>/`; the pack must contain its brief, manifest, stills, motion frames, and gameplay video before implementation can begin. Every implementer and critic then consumes that frozen pack. The Reference Study appears as its own expandable attempt with live logs and pack results. Failing critique findings are fed into the next round's implement prompt. Runs, verdicts, token metrics, and the full event log are mirrored into `.gauntlet-gamesmith/ledger.db` inside the project folder (via `node:sqlite` — no native deps), while the user-data ledger acts as the local multi-project registry. The loop stops on critic pass, max rounds, budget ceiling (equivalent API cost), stop button, or rate limit. All roles reuse the subscription logins from the Agents tab (`CLAUDE_CONFIG_DIR`/`CODEX_HOME` point at the app's harness homes; API-key env vars are stripped).

Run folders can be shared with **Export** and **Import**. Stop a run first, then Export copies the complete project directory—including source, Git data, downloaded `reference/` material, `critique/` evidence, build files, and `.gauntlet-gamesmith/ledger.db`—to a new portable folder. Import opens that transferred folder in place and registers every contained run without remapping IDs, timestamps, attempts, logs, metrics, or verdicts. Only the machine-specific absolute workspace path is rebound to the imported folder.

Run the TypeScript development app from the repository root:

```sh
pnpm dev
```

Use Node 22 (`nvm use` will read the checked-in `.nvmrc`).

Useful commands:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start    # preview the production build
```

## Downloadable app

Create a distributable for the current operating system from the repository root:

```sh
pnpm package
```

Artifacts are written to `dist/`. Recipients can run them without installing Node,
pnpm, or this repository. Platform-specific commands are also available:

```sh
pnpm package:mac    # ad hoc-signed macOS DMG and ZIP, Apple Silicon and Intel
pnpm package:mac:release # signed and Apple-notarized macOS DMG and ZIP
pnpm --filter @gauntlet/desktop verify:mac:release # verify existing trusted DMGs
pnpm --filter @gauntlet/desktop smoke:mac # launch-test the packaged ARM64 app
pnpm package:win    # Windows x64 portable EXE (run on Windows)
pnpm package:linux  # Linux x64 AppImage (run on Linux)
pnpm package:dir    # unpacked current-platform app for a quick smoke test
```

### Trusted macOS release

Apple-trusted downloads require an active Apple Developer Program membership and
a **Developer ID Application** certificate. Create and install that certificate
with Xcode (Settings → Accounts → Manage Certificates), or provide an exported
certificate to electron-builder with `CSC_LINK` and `CSC_KEY_PASSWORD`.

Configure notarization using an App Store Connect API key (recommended):

```sh
export APPLE_API_KEY=/absolute/path/to/AuthKey_ABC123.p8
export APPLE_API_KEY_ID=ABC123
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
pnpm package:mac:release
```

Alternatively, store Apple ID credentials in the macOS keychain so the password is
not left in shell history:

```sh
xcrun notarytool store-credentials gauntlet-notary \
  --apple-id "developer@example.com" \
  --team-id "YOUR_TEAM_ID" \
  --password "APP_SPECIFIC_PASSWORD"
export APPLE_KEYCHAIN_PROFILE=gauntlet-notary
pnpm package:mac:release
```

The release command deliberately fails when notarization credentials or a valid
distribution certificate are unavailable. electron-builder enables Apple's
hardened runtime, signs the app and native terminal helper, submits both
architectures to Apple's notary service, staples the accepted ticket, and creates
the DMG/ZIP downloads in `dist/`. It then mounts both DMGs and verifies their
checksums, Developer ID signatures, hardened runtime, architectures, packaged-app
startup, Gatekeeper acceptance, stapled tickets, and Applications shortcuts before
succeeding.

The regular `package:mac` command uses a complete ad hoc signature so local builds
launch cleanly without a partially signed app bundle. Ad hoc signatures do not
identify the publisher to Gatekeeper, so downloads intended for other users must
still be created with `package:mac:release`.

Verify an artifact before publishing it:

```sh
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Gauntlet Gamesmith.app"
spctl --assess --type execute --verbose=2 "dist/mac-arm64/Gauntlet Gamesmith.app"
xcrun stapler validate "dist/mac-arm64/Gauntlet Gamesmith.app"
```

The desktop app uses Electron, React, TypeScript, electron-vite, Tailwind CSS, and shadcn/ui. Renderer components live under `src/renderer/src/components`; the typed preload API and shared harness contracts keep Node capabilities out of the renderer.

The app creates isolated CLI homes inside its user-data directory:

- `harnesses/claude`
- `harnesses/codex`

The CLIs own everything stored in those directories. The Electron app only starts their commands and reads their documented status output.
