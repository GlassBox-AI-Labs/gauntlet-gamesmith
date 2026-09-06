# Gauntlet Gamesmith — agent brief

This is the single instruction file for coding agents working on this repository. Codex reads it as
`AGENTS.md`; Claude Code reads it through `CLAUDE.md`, which only imports this file. Edit it here.

## What this is

An Electron desktop app for one user that drives the stock Claude Code and Codex CLIs through a
Reference Study → implement → critique loop to build games against an AAA reference. All state is
local SQLite in the Electron main process. The app never reads, copies, or transmits CLI credentials;
the user's own CLI logins are the only authentication.

A core product goal: everything happening behind the scenes is visible. Every prompt, thought, tool
call, command, spawned agent, cost figure, and failure shows in the build log as it happens. When you
add or change anything an agent does, make sure the operator can see it (STANDARDS VIS-001).

## Read before changing code

1. `docs/STANDARDS.md` — the rules, with stable IDs. Reviews cite them; so should you.
2. `docs/DECISIONS.md` — ADRs. Product and policy decisions there win over everything else.
3. `apps/desktop/README.md` — how to run the app and what the two tabs do.
4. `HANDOFF.md` — the original design brief. Its `packages/contracts` and Zod details never shipped;
   see ADR-004. Treat it as history, not layout.
5. `docs/LOCAL_PR_REVIEWER.md` — proposed automated PR reviewer. Not built yet.
6. `docs/ARCHITECTURE.md` — current layout, build/harness/evaluation boundaries, and persistence.

## Layout

```
apps/desktop/src/main/       Node: daemon, SQLite ledger, child CLIs, IPC handlers (index.ts)
apps/desktop/src/preload/    the only renderer↔main bridge (window.harnesses, window.builds)
apps/desktop/src/renderer/   React UI, no Node access
apps/desktop/src/shared/     types, prompts, model helpers used by both sides; no Node, no Electron
```

Key files: `main/build-runner.ts` (phase execution), `main/ledger.ts` (SQLite, both ledgers),
`main/harness-plans.ts` (CLI argv), `main/harness-env.ts` (child environment),
`main/delegation.ts` (fan-out rules), `shared/prompts.ts` (all prompt text).

## Commands

```
pnpm install
pnpm typecheck
pnpm test
pnpm dev
pnpm build
```

Node 22 (`.nvmrc`). Run `pnpm typecheck` and `pnpm test` before opening a PR and say in the PR
what you ran (STANDARDS TEST-002).

## Non-negotiables

- Never read, parse, log, or transmit the CLIs' stored credentials (PROC-001, ADR-002).
- Never pass `--bare` to `claude` in subscription mode (ADR-002).
- Kill child CLIs with SIGINT, never SIGTERM (PROC-003).
- Cost figures are estimates; label them "equivalent API cost" (ADR-002).
- SQLite is opened only in main. The renderer never touches Node or the filesystem (ARCH-001,
  DATA-001).
- Treat every IPC value from the renderer as `unknown` and validate it (ARCH-002).
- Build child processes with `spawn(binary, argv)`; never interpolate data into a shell string
  (PROC-002).
- Never drop, hide, or summarize away an agent event to keep the log tidy. Unknown event kinds are
  logged, not ignored (VIS-001).

## Where things go

- New or changed prompt text → `shared/prompts.ts`, following PROMPT-001.
- New build phase → the PHASE-001 checklist. Do not add a new control flow inside `build-runner.ts`.
- New IPC channel → shared type, preload method, validated main handler, renderer call (ARCH-002).
- Schema change → idempotent migration for both ledgers, tested from the previous schema
  (DATA-002).
- Durable decision → append an ADR to `docs/DECISIONS.md` (DOC-001).

## Pull requests

One coherent purpose per PR (SCOPE-001). Describe the behavior change, risks, verification actually
run, and known limitations. Do not report a check as passed if it did not run.
