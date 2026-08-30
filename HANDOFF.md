# Gauntlet Loop — Handoff for local Claude Code (v2, solo mode)

This file is the brief for the first implementation session. Read it fully before writing code. The first milestone is **contracts only**: types, schemas, interfaces, and IPC/channel definitions that compile and are reviewed, with stub implementations. No UI polish, no real loop execution until the contracts are agreed.

> **v2 changes (2026-08-30).** Team mode is **deferred** (not dead — see ADR-003 in `docs/DECISIONS.md`). Supabase (Postgres + Auth + Realtime) is replaced by local SQLite; app-level auth is removed entirely — the only sign-ins are the harness CLIs themselves. The original multi-team design is preserved in git history (`eb39c79`).

---

## 1. What we are building

A cross-platform Electron desktop app for a single user. The app is both the operator UI and the worker: a daemon runs inside the Electron main process and executes generator / critic rounds for "loops". All state is local — SQLite in the Electron `userData` dir. There is no server, no account system, and no coordinator: the user signs in to their coding-agent CLIs ("harnesses") locally and that is the only authentication in the product.

Product decisions already made (do not relitigate in this session):

- Electron + React + TypeScript. Daemon lives in the main process (no separate service process for now).
- SQLite (better-sqlite3, WAL mode, main process only) for loop configs, the job queue, rounds, and round events. No Supabase.
- **Team mode is deferred.** The daemon talks to storage through thin ports (`LoopStore`, `JobQueue`, `EventLog`) so a remote-coordinator adapter can slot in later; keep the ports minimal — only what the daemon and UI actually need. The config hash spec must stay compatible (see §5.4).
- Harnesses in v1: **Claude Code** (`claude`) and **Codex CLI** (`codex`). Kimi later, API-key only.
- Onboarding flow: sign in to one or more harnesses on this machine → create a loop. No app sign-in, no teams.
- One-shot loops. No mid-run operator steering in the experiment path (it may exist later as a separately flagged feature, off by default, and rounds record whether it was used).
- The CLI's own login flow and credential store are used as-is. The app drives the login through a PTY and reads status; it does not read, copy, or transmit tokens.

## 2. Hard constraints (policy and technical) — bake these into the design

These were verified against current Anthropic/OpenAI/Moonshot docs and terms on 2026-08-30. They are storage-agnostic and carry over from v1 unchanged except attribution (#3).

1. **Unmodified binaries, user's own login, on the user's own machine.** Anthropic permits an end user to sign in to the unmodified Claude Code binary with their own subscription. It prohibits any app from collecting, storing, or intermediating Claude.ai credentials/session tokens, or routing requests through Pro/Max credentials on behalf of others. Therefore: the daemon spawns the stock `claude` binary; it never calls the Anthropic API with a subscription OAuth token, and never uses the Agent SDK with subscription auth. Same posture for `codex`. (Solo mode makes this posture strictly easier: everything is ordinary, individual usage on the user's own machine.)
2. **Do not pass `--bare` to `claude -p`.** Bare mode never reads OAuth credentials and requires an API key. It is slated to become the default for `-p`, so pin the Claude Code version and pass flags explicitly.
3. **Attribution.** Every round records which harness account (local label) and machine ran it. This is an experiment control variable and preserves the audit trail team mode would need.
4. **Auth mode switch from day one.** Every harness account has `authMode: 'subscription' | 'api_key'`. API-key mode uses `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the child environment (and may use `--bare` for Claude). Anthropic's paused plan to move `claude -p` usage onto a separate metered credit may return; the loop config must be able to fail an arm over to API key without changing anything else that is hashed.
5. **Cost figures are estimates.** `total_cost_usd` and `modelUsage[].costUSD` from Claude Code are client-side list-price estimates, not billing. Label them "equivalent API cost" everywhere. Use `modelUsage` / `total_cost_usd` for whole-tree accounting; the result-level `usage` object excludes subagent tokens. Codex `turn.completed` gives tokens only; we price them ourselves.
6. **Price table is part of the config hash.** Bundle a dated price table (per model: input, output, cache-write-5m, cache-write-1h, cache-read) and hash it alongside `prompt.txt`. Record the table version on every round.
7. **Rate limits are real.** Subscription runs will hit 5-hour and weekly windows, and in solo mode a single subscription's windows bound experiment throughput. The daemon must treat `rate_limit` as a retryable pause (with the reset time when known), not a failure, and expose it on the dashboard. Multiple accounts per harness (one config dir each) and API-key failover are the mitigations.
8. **Kill semantics.** SIGTERM on `claude -p` exits 143 and records no result. Use SIGINT (or the SDK-style interrupt) to get a result message. Persist the last good result per round.

## 3. Process model

```
Electron main process
├── Daemon
│   ├── HarnessManager   one HarnessAdapter per (harness, account); login via PTY; status probes
│   ├── Scheduler        pulls the next runnable job from the queue; matches job requirements to
│   │                    available accounts; enforces rate-limit pauses and resume-after-restart
│   ├── RoundRunner      executes one job: builds env + args, spawns CLI, parses stream, writes RoundResult
│   └── Telemetry        normalizes CLI output into RoundEvents; per-round token/cost accounting
├── Store                better-sqlite3 (WAL) in userData, behind LoopStore / JobQueue / EventLog ports
└── IPC bridge (contextBridge) → Renderer (React) : typed request/response + event subscriptions
```

Rules:
- The renderer never spawns processes and never opens the database; everything goes through IPC. Round events stream to the renderer over IPC; SQLite is the durable history/replay record.
- All child processes are spawned by `HarnessAdapter` implementations only.
- Everything crossing IPC is a Zod schema in `packages/contracts`. Types are inferred from schemas; no hand-written duplicate types.

## 4. Repository layout (monorepo, pnpm)

```
gauntlet-loop/
  package.json              pnpm workspaces
  packages/
    contracts/              ← MILESTONE 1 lives here. Zod schemas + inferred TS types. Zero runtime deps beyond zod.
      src/
        ids.ts              branded ID types
        machine.ts          Machine record (control variables)
        harness.ts          HarnessKind, HarnessAccount, HarnessAdapter interface, login state machine
        loop.ts             LoopConfig, arm definitions, stop conditions, hashing spec
        round.ts            Job, Round, RoundResult, RoundEvent
        pricing.ts          PriceTable, cost computation contract
        store.ts            LoopStore / JobQueue / EventLog port interfaces
        ipc.ts              renderer<->main channel map (request/response + events)
        db.ts               row schemas mirroring packages/store/migrations (kept in sync by a test)
        index.ts
    store/                  better-sqlite3 adapter implementing the ports
      migrations/           versioned SQL, applied via PRAGMA user_version
    harness-claude/         adapter for `claude` (stub in M1)
    harness-codex/          adapter for `codex` (stub in M1)
  apps/
    desktop/                Electron (electron-vite), main/preload/renderer
  docs/
    HANDOFF.md              this file
    DECISIONS.md            ADR-style log; append, don't rewrite
```

## 5. Contracts — Milestone 1 spec

Write these as Zod schemas. Names below are normative; field lists are the minimum, extend only with a note in DECISIONS.md.

### 5.1 Identity and machine

```ts
LoopId, RoundId, JobId, HarnessAccountId   // branded strings (uuid)

Machine {                    // singleton row; control variables for every round
  machineLabel: string, platform: 'darwin' | 'win32' | 'linux', appVersion: string
}
```

No users, no teams. `HarnessAccountId` is a local id; the dashboard shows the account's `label`.

### 5.2 Harness accounts

```ts
HarnessKind = 'claude' | 'codex'

HarnessAccount {              // stored locally; metadata in SQLite, secrets via safeStorage only
  id: HarnessAccountId, harness: HarnessKind, label: string,
  authMode: 'subscription' | 'api_key',
  configDir: string,          // claude: CLAUDE_CONFIG_DIR ; codex: CODEX_HOME  — one dir per account
  apiKeyRef?: string,         // safeStorage-encrypted blob ref, api_key mode only
  loginState: LoginState, cliVersion?: string, lastProbeAt?
}

LoginState =
  | { kind: 'logged_out' }
  | { kind: 'awaiting_browser', url: string, startedAt }        // PTY printed an auth URL
  | { kind: 'awaiting_code', url: string }                      // CLI wants a pasted code
  | { kind: 'logged_in', verifiedAt }
  | { kind: 'expired' }
  | { kind: 'error', message }

interface HarnessAdapter {
  kind: HarnessKind
  detect(): Promise<{ found: boolean; path?: string; version?: string }>
  startLogin(account, sink: (ev: LoginEvent) => void): Promise<LoginHandle>   // spawns CLI in a PTY, parses URL / prompts
  submitCode(handle, code: string): Promise<void>
  probe(account): Promise<LoginState>                                         // cheap status check
  run(req: RunRequest, sink: (ev: RoundEvent) => void, signal: AbortSignal): Promise<RunResult>
}
```

Login mechanics to implement behind the adapters (verify exact CLI output strings against the pinned versions; put the version + parsed patterns in the adapter, with fixtures):
- **claude**: spawn `claude` in a PTY with `CLAUDE_CONFIG_DIR=<account.configDir>`, send `/login`, parse the printed OAuth URL, open it in the system browser, then paste the code the user gets back into the PTY. Credentials land in the CLI's own store under that config dir (keychain on macOS, file elsewhere). `probe` = check the CLI reports an authenticated state (prefer a CLI status command if the pinned version has one; otherwise a minimal `-p` call with `--max-turns 1` and small budget, and treat `oauth_*`/`billing_error` retry categories as logged-out/expired).
- **codex**: spawn `codex login --device-auth` (device-code flow avoids the localhost callback port) with `CODEX_HOME=<account.configDir>`; parse URL + user code; `codex login status` for `probe`.
- API-key mode: no PTY; `probe` = a minimal run with the key in env.

### 5.3 Loops and arms

A **loop** is an experiment; it has one or more **arms** (e.g. same-family critic vs cross-family critic); each arm runs N **rounds**; each round is one generator job followed by one critic job.

```ts
LoopConfig {
  schemaVersion: 1,
  id: LoopId, name,
  goal: { promptText: string, promptSha256: string },          // prompt.txt content + hash
  references: { manifestSha256: string, files: {path, sha256, bytes}[] }, // user-provided, frozen
  priceTable: { version: string, sha256: string },
  repo: { kind: 'git', url: string, baseRef: string } | { kind: 'template', name: string },
  arms: Arm[],
  stop: StopCondition,
  controls: ControlVariables,                                   // see §6
  hashes: { config: string /* sha256 of canonical JSON of everything above except id/name */ }
}

Arm {
  id: string, label: string,
  generator: RoleSpec, critic: RoleSpec,
  contextMode: 'fresh' | 'continue',                            // fresh session per round vs --continue
  maxRounds: number
}

RoleSpec {
  harness: HarnessKind, model: string, effort?: string,
  authMode: 'subscription' | 'api_key',
  maxBudgetUsd?: number,   // claude: --max-budget-usd ; codex: enforced by daemon from token pricing
  maxTurns?: number,
  timeoutSec: number
}

StopCondition {
  maxRoundsPerArm: number,
  maxWallClockSec: number,
  maxEquivalentCostUsd: number,                                 // cost ceiling (Reddit point)
  criticPassThreshold: number,                                  // e.g. critic score >= 0.9 for K consecutive rounds
  consecutivePassesRequired: number,
  noProgressRounds: number                                      // stop if critic score hasn't improved in N rounds
}
```

Canonical JSON = sorted keys, no whitespace, UTF-8. `hashes.config` is the "same experiment" fingerprint the dashboard shows. The hashed payload has no team or machine fields, so fingerprints stay comparable if team mode returns later (ADR-003).

Reference files live at `userData/loops/<id>/references/`, verified against the sha256 manifest on load.

### 5.4 Jobs, rounds, results, events

```ts
Job {
  id: JobId, loopId, armId, roundIndex, role: 'generator' | 'critic',
  requires: { harness: HarnessKind, authMode, model },          // denormalized so the queue is self-contained
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'rate_limited',
  startedAt?, finishedAt?, attempt: number,
  input: GeneratorInput | CriticInput
}
GeneratorInput { workspaceRef, priorCriticVerdict?: CriticVerdict }
CriticInput    { workspaceRef, goalPromptSha256, referencesManifestSha256 }

RunRequest  { job: Job, account: HarnessAccount, cwd: string, env: Record<string,string> }
RunResult   {
  status: 'succeeded' | 'failed' | 'rate_limited' | 'timeout' | 'cancelled',
  usage: TokenUsage,                                            // whole tree
  perModel: Record<string, TokenUsage & { costUsdEstimate: number, costBasis: 'cli' | 'table' }>,
  equivalentCostUsd: number, durationMs: number, apiDurationMs?: number, numTurns?: number,
  sessionId?: string, lastMessage?: string, rateLimitResetAt?: string, error?: { category: string, message: string }
}
TokenUsage { input, output, cacheRead, cacheWrite5m, cacheWrite1h, reasoning? }   // reasoning: codex-only, informational

CriticVerdict { score: number /* 0..1 */, pass: boolean, summary: string, findings: {severity, text}[], raw: string }

Round {
  id: RoundId, loopId, armId, index,
  generatorJobId, criticJobId, verdict?: CriticVerdict,
  equivalentCostUsd, wallClockMs,
  accounts: { generator: HarnessAccountId, critic: HarnessAccountId },   // attribution (§2.3)
  artifacts: { screenshotPaths?: string[], diffStatRef?: string }
}

RoundEvent {                      // append-only, streamed to dashboard over IPC
  id, jobId, ts, seq,
  kind: 'started' | 'assistant_text' | 'tool_use' | 'tool_result' | 'subagent_spawn' | 'api_request'
      | 'rate_limited' | 'usage' | 'finished' | 'error',
  parentToolUseId?: string,       // for the delegation tree
  agentId?: string,
  payload: unknown                // kind-specific, schema per kind
}
```

The `Job` status machine is what makes loops survive app restarts, machine sleep, and rate-limit windows: on launch the Scheduler resumes `queued`/`rate_limited` jobs (honoring `rateLimitResetAt`) and re-queues `running` jobs that died with the app. Do not delete it just because there is no remote queue.

Mapping notes for adapters:
- claude: `claude -p <prompt> --output-format stream-json --verbose --forward-subagent-text [--max-budget-usd N] [--max-turns N] [--model M] [--continue]` with `CLAUDE_CONFIG_DIR` set. Rebuild the subagent tree from `parent_tool_use_id`; the Agent tool_use `input` carries each subagent's prompt. Take final token/cost from the `result` message's `modelUsage`/`total_cost_usd`. Dedupe per-step usage by message id. Map `api_retry` categories (`rate_limit`, `overloaded`, `billing_error`, `oauth_*`) to `rate_limited` / `error` events.
- codex: `codex exec --json [-m M] [--sandbox workspace-write] -o <file>` with `CODEX_HOME` set. `turn.completed` carries `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`; price them from the table; verify whether reasoning tokens are already included in `output_tokens` before summing.

### 5.5 Pricing contract

```ts
PriceTable { version: string /* ISO date */, models: Record<string, { input, output, cacheWrite5m, cacheWrite1h, cacheRead } /* USD per MTok */> }
computeCost(usage: TokenUsage, model: string, table: PriceTable, cacheTtl: '5m' | '1h'): number
```

Subscription runs use the 1h cache TTL; API-key and usage-credit runs use 5m. Record `cacheTtl` on the round. Prefer the CLI's own cost figure when present (`costBasis: 'cli'`); use the table for Codex and as a cross-check.

### 5.6 IPC contract (renderer ⇄ main)

Define a single typed channel map; generate `window.gauntlet.*` from it in preload.

```
harness.list / harness.add / harness.remove / harness.detect(kind) / harness.startLogin(id) / harness.submitCode(id, code)
             / harness.probe(id) / harness.onLoginEvent
daemon.status / daemon.setPaused(bool) / daemon.onStatus
loop.list / loop.create(config) / loop.start(id) / loop.cancel(id) / loop.get(id)
rounds.list(loopId) / rounds.onEvent(loopId)     // streaming RoundEvents
```

Every request/response pair is `{ channel, request: ZodSchema, response: ZodSchema }`; events are `{ channel, payload: ZodSchema }`. Add a test that every channel in the map has a handler registered in main.

### 5.7 Storage (SQLite)

Tables mirror §5.1–5.4: `machine` (singleton), `harness_accounts` (metadata only — secrets stay in `safeStorage`), `loops`, `jobs`, `rounds`, `round_events`, `price_tables`. better-sqlite3, WAL mode, one connection, main process only. Migrations are versioned SQL files in `packages/store/migrations`, applied via `PRAGMA user_version`.

Ports in `packages/contracts/src/store.ts` — keep them thin (only operations the Daemon and IPC handlers actually call):
- `LoopStore`: create/get/list loops, save rounds and results.
- `JobQueue`: enqueue, `nextRunnable(now)` (respects `rateLimitResetAt` and paused state), transition status, resume-on-launch sweep.
- `EventLog`: append `RoundEvent`s, read back by job/loop for replay.

A contracts test parses `packages/store/migrations/*.sql` column lists against `db.ts` schemas.

## 6. Control variables (experiment integrity)

Every round must record, and the dashboard must display, these so arms are comparable:

pinned `claude` and `codex` CLI versions; model ids; effort; `contextMode`; `authMode` and cache TTL; `promptSha256`; references `manifestSha256`; `priceTable.version`; repo `baseRef`; machine label + platform + harness account labels; whether operator steering was used (must be `false` in experiment loops); stop-condition parameters; wall clock and equivalent cost.

If any of these differ between two rounds of the same arm, the dashboard flags the arm as "not comparable".

## 7. Onboarding screens (v1, minimal)

1. **Harnesses** — cards for Claude and Codex: Detected version / Not found; "Sign in" button → shows the URL (auto-opened) and, for Claude, a code paste field; status pill from `LoginState`. Toggle to add an API-key account instead. Daemon status + pause switch live here (or in the title bar).
2. **Loops** — list, create (form that writes a `LoopConfig`, computes hashes, copies references into `userData`), and a per-loop dashboard: rounds table, live event stream with the delegation tree, per-round tokens / equivalent cost / wall clock, control-variable panel.

## 8. Milestones

- **M1 — Contracts + store (this session).** `packages/contracts` complete with Zod schemas, canonical-JSON hashing, `computeCost`, IPC map, store ports, DB row schemas; `packages/store` with migrations and the better-sqlite3 adapter; stub harness adapters that satisfy `HarnessAdapter` with fixture-driven fake streams; an Electron shell that boots and lists detected harnesses. Tests: schema round-trips, hash determinism, cost math against known figures, IPC map coverage, migrations-vs-schema sync, job-queue resume semantics.
- **M2 — Harness login.** Real PTY login for Claude and Codex, probes, `safeStorage` for API keys.
- **M3 — Single-machine loop.** Run a generator+critic loop end to end with fresh context; stream events to the dashboard; enforce cost ceiling and stop conditions; survive restart and rate-limit pause/resume.
- **M4 — Team mode (deferred).** Remote coordinator adapter behind the storage ports; multi-machine job claiming; pooled rate windows; attribution across users. Not in scope until solo mode has produced results.

## 9. Tooling notes for the local session

- Node 22+, pnpm, `electron-vite`, React 19, TanStack Router/Query, Zustand, Zod, `node-pty`, `better-sqlite3`, Vitest.
- `better-sqlite3` and `node-pty` are native modules — rebuild both for Electron via `electron-rebuild` (one posture, two modules).
- Pin `claude` and `codex` versions in `packages/contracts/src/harness.ts` as constants and assert them in `detect()`. Capture real stream-json / `codex exec --json` transcripts as fixtures before writing parsers.
- Windows: Claude Code needs Git for Windows' bash on PATH; credentials are a plaintext file under `CLAUDE_CONFIG_DIR` — set restrictive permissions on the dir we create. `node-pty` needs the Windows build tools; use prebuilt binaries via `electron-rebuild`.
- Do not bundle the CLIs in M1–M3; detect the user's installs. Revisit bundling only if version pinning proves unreliable (bundling means "hosting Claude Code" under Anthropic's Commercial Terms).
- `docs/DECISIONS.md` records the decisions in §1 and §2 plus the solo-mode pivot, dated 2026-08-30. Append new ADRs there.

## 10. References checked 2026-08-30

- Claude Code: legal-and-compliance, headless, authentication, monitoring-usage, agent-sdk/cost-tracking, workflows — https://code.claude.com/docs/en/
- Anthropic help center: "Use the Claude Agent SDK with your Claude plan" (paused change) — https://support.claude.com/en/articles/15036540
- Anthropic Consumer Terms — https://www.anthropic.com/legal/consumer-terms
- Codex: non-interactive mode, auth — https://learn.chatgpt.com/docs/non-interactive-mode , https://learn.chatgpt.com/docs/auth
- OpenAI Terms of Use — https://openai.com/policies/terms-of-use
- Pricing — https://platform.claude.com/docs/en/about-claude/pricing , https://developers.openai.com/api/docs/pricing
- Conductor (reference for the "drive the stock CLI, reuse its login" pattern; Tauri, macOS-only) — https://www.conductor.build/docs/faq
