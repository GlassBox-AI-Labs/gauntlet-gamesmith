# Gauntlet Gamesmith desktop

The Electron desktop app drives the stock Claude Code and Codex CLIs while keeping credentials entirely in each CLI's own store.

On first launch the app shows a setup flow instead of the Runs view: a welcome
step, a connect step that detects each CLI and drives its login, and a four-card
tour of the loop.

When a CLI is missing, the connect step offers to install it. On macOS and Linux
**Install** runs the vendor's own native installer — `https://claude.ai/install.sh`
piped to `bash`, `https://chatgpt.com/codex/install.sh` piped to `sh` — in the
login terminal, so every line is visible; the exact command stays available to
copy. Neither installer needs Node. The installer runs with a plain environment
and the real home rather than the harness environment, which rewrites `HOME` and
sets `CODEX_HOME`/`CODEX_INSTALL_DIR` and would otherwise redirect the install
into app-private state. Both land in `~/.local/bin` and edit a shell profile that
the running app never re-reads, so `cli-executable.ts` searches that directory
after `PATH`. Windows has no plan and shows the command instead. Completion is stored in `onboarding.json` under the Electron user-data
directory, read over `onboarding:get` before the first render; a missing or
unreadable file simply means the flow runs again. The flow is skippable, and
**Show the tour again** on the Agents tab resets it.

Two tabs:

- **Agents** — CLI detection, login-status probing, and an interactive PTY for signing in to Claude Code and Codex. It does not read credential files.
- **Run** — paste a goal prompt and start a Reference Study → implement → critique loop. The form selects a parent runs folder; Create makes a fresh prompt-named project directory inside it, with a numeric suffix when needed, so locally created runs never share a workspace. Before Round 1, a solo research run downloads and audits an attributable, per-run Reference Pack under `reference/<loop-id>/`; the pack contains its brief, source manifest, research notes, journey and story notes, stills, journey captures, motion frames, and gameplay video before implementation can begin. Every implementer and critic then consumes that frozen pack. The Reference Study appears as its own expandable attempt with live logs and pack results. Failing delegated workers are marked explicitly and cannot hold a completed phase open forever; the phase artifact must still pass main-process validation before the loop advances. Failing critique findings are fed into the next round's implement prompt. Runs, verdicts, token metrics, and the full event log are mirrored into `.gauntlet-gamesmith/ledger.db` inside the project folder (via `node:sqlite`), while the user-data ledger acts as the local multi-project registry. The loop stops on critic pass, max rounds, budget ceiling (equivalent API cost), or the stop button; rate limits pause with bounded backoff and resume automatically. All roles reuse the subscription logins from the Agents tab (`CLAUDE_CONFIG_DIR`/`CODEX_HOME` point at the app's harness homes; billing and credential-routing environment variables are stripped).

**Play** may launch a trusted local run while its agents are still working. With no completed round selected, it previews the live project folder, so reloads can reflect work-in-progress edits or temporary build errors. Selecting a completed round instead launches that round's immutable Git revision.

Run folders can be shared with **Export** and **Import**. Stop a run first, then Export copies the complete project directory—including source, Git data, downloaded `reference/` material, `critique/` evidence, build files, raw CLI streams, and `.gauntlet-gamesmith/ledger.db`—to a new portable folder. Existing `.gauntlet-loop/` metadata remains supported: after its workspace identity and portable history match are validated, it is migrated to `.gauntlet-gamesmith/`. If both directories exist, current data wins and the legacy tree is retained beneath it before the obsolete top-level `.gauntlet-loop/` path is removed; unsafe folders remain unchanged and fail closed. For trusted local runs, timestamped event-log links open the associated raw stream in a bounded side reader; there is no separate raw-file toolbar. Raw streams are intentionally byte-complete and are not secret-scrubbed; a CLI may have echoed sensitive local text, so review the exported folder before sharing it. Import opens a transferred folder in place and registers every contained run without remapping IDs, timestamps, attempts, logs, metrics, or verdicts. Only the machine-specific absolute workspace path is rebound to the imported folder. Imported history and histories created before trust provenance was recorded start untrusted. Clicking **Play** or **Resume** shows a native warning naming the run and exact folder, with **Cancel** selected by default. **Trust run & folder** permits Gauntlet Gamesmith, its agents, and project scripts to execute with your local permissions. Main rechecks the registered folder identity, matching portable history, process ownership, and folder metadata after confirmation, then records consent and a visible event in both ledgers before continuing the original action. Browsing history never prompts. Changing selection during confirmation cancels the pending launch; consent can only apply to the run named in the dialog.

Existing-folder execution consent does not grant private CLI transcript access or rename privileges, and does not adopt portable CLI session IDs or Git objects as local authority. Imported Resume uses fresh attempts/sessions; missing app-private revisions can still block a historical round or critique. Play the live folder when a transferred round has no local revision. Trust is denied for active or quarantined workspaces, changed or mismatched history, protected directories, external/broken links, special files, and trees exceeding 200,000 entries. A fresh import on another machine requires its own consent.

Generated workspace files are immutable publications. Final report snapshots live under `.gauntlet-gamesmith/reports/<loop-id>/` and their exact relative path is recorded in the loop log; SQLite and the Run tab remain the canonical live view. Claude implementer definitions use definition-addressed `gauntlet-implementer-v2-<digest>.md` names. The app never replaces legacy `gauntlet-report*.md`, `.claude/agents/implementer.md`, or an existing publication with different bytes. Retained generations are capped and require explicit operator cleanup when the cap is reached.

Run the TypeScript development app from the repository root:

```sh
pnpm dev
```

Use Node 22 (`nvm use` will read the checked-in `.nvmrc`).

### Running a second instance

Everything the app owns — run history, harness logins, round revisions, and the
single-instance lock — lives under the Electron user-data directory, so a second
launch is normally refused while one is already running. Pass an absolute
`--gauntlet-user-data` path to get a separate profile that runs beside it:

```sh
pnpm --filter @gauntlet/desktop exec electron . --gauntlet-user-data=/tmp/gg-test-profile
```

That profile starts empty: no runs, no signed-in CLIs, and the first-run setup
flow. Delete the directory to discard it. A missing or relative path fails at
startup rather than falling back to the real profile.

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

The desktop app uses Electron, React, TypeScript, electron-vite, Tailwind CSS, shadcn/ui, and the native `node-pty` module for login terminals. Renderer components live under `src/renderer/src/components`; the typed preload API and shared harness contracts keep Node capabilities out of the renderer.

The app creates isolated CLI homes inside its user-data directory:

- `harnesses/claude`
- `harnesses/codex`

The CLIs own everything stored in those directories. The Electron app only starts their commands and reads their documented status output.
