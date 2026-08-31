# Gauntlet Loop desktop

The Electron desktop app drives the stock Claude Code and Codex CLIs while keeping credentials entirely in each CLI's own store.

Two tabs:

- **Agents** — CLI detection, login-status probing, and an interactive PTY for signing in to Claude Code and Codex. It does not read credential files.
- **Run** — paste a goal prompt and start a generator/critic loop. Claude Code (`claude-fable-5`, high effort) implements each round with `--dangerously-skip-permissions` inside the chosen workspace, orchestrating `implementer` subagents (opus, medium effort, seeded via `.claude/agents/implementer.md`). Codex (`gpt-5.6-sol`, medium reasoning) then judges with fresh eyes and must end with a JSON verdict; a failing verdict's findings are fed into the next round's implement prompt. Rounds, runs, verdicts, per-subagent token metrics, and the full event log are mirrored into `.gauntlet-loop/ledger.db` inside the project folder (via `node:sqlite` — no native deps), while the user-data ledger acts as the local multi-project registry. The loop stops on critic pass, max rounds, budget ceiling (equivalent API cost), stop button, or rate limit. Both runs reuse the subscription logins from the Agents tab (`CLAUDE_CONFIG_DIR`/`CODEX_HOME` point at the app's harness homes; API-key env vars are stripped).

Run folders can be shared with **Export** and **Import**. Stop a run first, then Export copies the complete project directory—including source, Git data, downloaded `reference/` material, `critique/` evidence, build files, and `.gauntlet-loop/ledger.db`—to a new portable folder. Import opens that transferred folder in place and registers every contained run without remapping IDs, timestamps, attempts, logs, metrics, or verdicts. Only the machine-specific absolute workspace path is rebound to the imported folder.

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

The desktop app uses Electron, React, TypeScript, electron-vite, Tailwind CSS, and shadcn/ui. Renderer components live under `src/renderer/src/components`; the typed preload API and shared harness contracts keep Node capabilities out of the renderer.

The app creates isolated CLI homes inside its user-data directory:

- `harnesses/claude`
- `harnesses/codex`

The CLIs own everything stored in those directories. The Electron app only starts their commands and reads their documented status output.
