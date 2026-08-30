# Gauntlet Loop — Handoff for local Claude Code

This file is the brief for the first implementation session. Read it fully before writing code. The first milestone is **contracts only**: types, schemas, interfaces, and IPC/channel definitions that compile and are reviewed, with stub implementations. No UI polish, no real loop execution until the contracts are agreed.

---

## 1. What we are building

A cross-platform Electron desktop app. The app is both the operator UI and the worker: a daemon runs inside the Electron main process and executes generator / critic rounds for "loops" that belong to a team. Teammates each run the app on their own machine, sign in to the app, and sign in to their coding-agent CLIs ("harnesses") locally. A shared Supabase project (Postgres + Auth + Realtime) is the coordinator: it holds teams, loop configs, the job queue, and round results. The coordinator moves task payloads and results only — **never harness credentials**.

Product decisions already made (do not relitigate in this session):

- Electron + React + TypeScript. Daemon lives in the main process (no separate service process for now).
- Supabase for app auth, team membership, and the loop/round/job store.
- Harnesses in v1: **Claude Code** (`claude`) and **Codex CLI** (`codex`). Kimi later, API-key only.
- Onboarding flow: sign in to app → create or join a team → sign in to one or more harnesses on this machine → machine becomes a worker for that team.
- One-shot loops. No mid-run operator steering in the experiment path (it may exist later as a separately flagged feature, off by default, and rounds record whether it was used).
- The CLI's own login flow and credential store are used as-is. The app drives the login through a PTY and reads status; it does not read, copy, or transmit tokens.

## 2. Hard constraints (policy and technical) — bake these into the design

These were verified against current Anthropic/OpenAI/Moonshot docs and terms on 2026-08-30.

1. **Unmodified binaries, user's own login, on the user's own machine.** Anthropic permits an end user to sign in to the unmodified Claude Code binary with their own subscription. It prohibits any app from collecting, storing, or intermediating Claude.ai credentials/session tokens, or routing requests through Pro/Max credentials on behalf of others. Therefore: the daemon spawns the stock `claude` binary; it never calls the Anthropic API with a subscription OAuth token, and never uses the Agent SDK with subscription auth. Same posture for `codex`.
2. **Do not pass `--bare` to `claude -p`.** Bare mode never reads OAuth credentials and requires an API key. It is slated to become the default for `-p`, so pin the Claude Code version and pass flags explicitly.
3. **Attribution.** A worker only claims jobs from loops its owner's team owns, and every round records which worker/account ran it. This is both a policy guard ("ordinary, individual usage") and an experiment control variable.
4. **Auth mode switch from day one.** Every harness account has `authMode: 'subscription' | 'api_key'`. API-key mode uses `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the child environment (and may use `--bare` for Claude). Anthropic's paused plan to move `claude -p` usage onto a separate metered credit may return; the loop config must be able to fail an arm over to API key without changing anything else that is hashed.
5. **Cost figures are estimates.** `total_cost_usd` and `modelUsage[].costUSD` from Claude Code are client-side list-price estimates, not billing. Label them "equivalent API cost" everywhere. Use `modelUsage` / `total_cost_usd` for whole-tree accounting; the result-level `usage` object excludes subagent tokens. Codex `turn.completed` gives tokens only; we price them ourselves.
6. **Price table is part of the config hash.** Bundle a dated price table (per model: input, output, cache-write-5m, cache-write-1h, cache-read) and hash it alongside `prompt.txt`. Record the table version on every round.
7. **Rate limits are real.** Subscription runs will hit 5-hour and weekly windows. The daemon must treat `rate_limit` as a retryable pause (with the reset time when known), not a failure, and expose it on the dashboard.
8. **Kill semantics.** SIGTERM on `claude -p` exits 143 and records no result. Use SIGINT (or the SDK-style interrupt) to get a result message. Persist the last good result per round.

## 3. Process model

```
Electron main process
├── AppAuth        Supabase session (email/OAuth), team membership
├── Daemon
│   ├── WorkerRegistry   registers this machine as a worker for the active team; heartbeats
│   ├── HarnessManager   one HarnessAdapter per (harness, account); login via PTY; status probes
│   ├── JobClaimer       polls/subscribes Supabase for claimable jobs matching this worker's capabilities
│   ├── RoundRunner      executes one job: builds env + args, spawns CLI, parses stream, writes RoundResult
│   └── Telemetry        normalizes CLI output into RoundEvents; per-round token/cost accounting
└── IPC bridge (contextBridge) → Renderer (React) : typed request/response + event subscriptions

Supabase (shared)
├── auth.users
├── teams, team_members
├── workers, worker_capabilities
├── loops (config + hashes), rounds, jobs
└── round_events (append-only, for the dashboard) + Realtime channels
```

Rules:
- The renderer never spawns processes and never talks to Supabase directly for job/worker state; it goes through IPC. (It may use the Supabase client directly for read-only dashboard subscriptions if that simplifies Realtime; decide in the contracts review.)
- All child processes are spawned by `HarnessAdapter` implementations only.
- Everything crossing IPC or the wire is a Zod schema in `packages/contracts`. Types are inferred from schemas; no hand-written duplicate types.

## 4. Repository layout (monorepo, pnpm)

```
gauntlet-loop/
  package.json              pnpm workspaces
  packages/
    contracts/              ← MILESTONE 1 lives here. Zod schemas + inferred TS types. Zero runtime deps beyond zod.
      src/
        ids.ts              branded ID types
        team.ts
        worker.ts
        harness.ts          HarnessKind, HarnessAccount, HarnessAdapter interface, login state machine
        loop.ts             LoopConfig, arm definitions, stop conditions, hashing spec
        round.ts            Job, Round, RoundResult, RoundEvent
        pricing.ts          PriceTable, cost computation contract
        ipc.ts              renderer<->main channel map (request/response + events)
        db.ts               row schemas mirroring supabase/migrations (kept in sync by a test)
        index.ts
    harness-claude/         adapter for `claude` (stub in M1)
    harness-codex/          adapter for `codex` (stub in M1)
  apps/
    desktop/                Electron (electron-vite), main/preload/renderer
  supabase/
    migrations/             SQL
    seed.sql
  docs/
    HANDOFF.md              this file
    DECISIONS.md            ADR-style log; append, don't rewrite
```

## 5. Contracts — Milestone 1 spec

Write these as Zod schemas. Names below are normative; field lists are the minimum, extend only with a note in DECISIONS.md.

### 5.1 Identity and teams

```ts
TeamId, UserId, WorkerId, LoopId, RoundId, JobId, HarnessAccountId   // branded strings (uuid)

Team        { id, name, slug, createdBy: UserId, createdAt }
TeamMember  { teamId, userId, role: 'owner' | 'member', joinedAt }
TeamInvite  { teamId, code: string /* short, single-use or N-use */, expiresAt, createdBy }
```

Join flow: "create team" inserts Team + owner membership; "join team" redeems an invite code via a Postgres RPC (`redeem_invite(code)`) that inserts the membership under RLS.

### 5.2 Workers

```ts
Worker {
  id: WorkerId, teamId, ownerUserId: UserId,
  machineLabel: string, platform: 'darwin' | 'win32' | 'linux', appVersion: string,
  status: 'online' | 'busy' | 'paused' | 'offline', lastHeartbeatAt
}
WorkerCapability {
  workerId, harness: HarnessKind, accountRef: HarnessAccountId /* local id, opaque to server */,
  authMode: 'subscription' | 'api_key', cliVersion: string, models: string[] /* advertised */,
  roles: ('generator' | 'critic')[]
}
```

The server never sees account emails or tokens. `accountRef` is a random local id; the dashboard shows `ownerUserId` + `machineLabel` + `harness`.

### 5.3 Harnesses

```ts
HarnessKind = 'claude' | 'codex'

HarnessAccount {              // stored LOCALLY only (electron userData, encrypted with safeStorage)
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

### 5.4 Loops and arms

A **loop** is an experiment; it has one or more **arms** (e.g. same-family critic vs cross-family critic); each arm runs N **rounds**; each round is one generator job followed by one critic job.

```ts
LoopConfig {
  schemaVersion: 1,
  id: LoopId, teamId, name,
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

Canonical JSON = sorted keys, no whitespace, UTF-8. `hashes.config` is what the dashboard shows as the "same experiment" fingerprint.

### 5.5 Jobs, rounds, results, events

```ts
Job {
  id: JobId, loopId, armId, roundIndex, role: 'generator' | 'critic',
  requires: { harness: HarnessKind, authMode, model },
  status: 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'rate_limited',
  claimedBy?: WorkerId, claimedAt?, startedAt?, finishedAt?, attempt: number,
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
  equivalentCostUsd, wallClockMs, workerIds: { generator: WorkerId, critic: WorkerId },
  artifacts: { screenshotPaths?: string[], diffStatRef?: string }
}

RoundEvent {                      // append-only, streamed to dashboard
  id, jobId, ts, seq,
  kind: 'started' | 'assistant_text' | 'tool_use' | 'tool_result' | 'subagent_spawn' | 'api_request'
      | 'rate_limited' | 'usage' | 'finished' | 'error',
  parentToolUseId?: string,       // for the delegation tree
  agentId?: string,
  payload: unknown                // kind-specific, schema per kind
}
```

Mapping notes for adapters:
- claude: `claude -p <prompt> --output-format stream-json --verbose --forward-subagent-text [--max-budget-usd N] [--max-turns N] [--model M] [--continue]` with `CLAUDE_CONFIG_DIR` set. Rebuild the subagent tree from `parent_tool_use_id`; the Agent tool_use `input` carries each subagent's prompt. Take final token/cost from the `result` message's `modelUsage`/`total_cost_usd`. Dedupe per-step usage by message id. Map `api_retry` categories (`rate_limit`, `overloaded`, `billing_error`, `oauth_*`) to `rate_limited` / `error` events.
- codex: `codex exec --json [-m M] [--sandbox workspace-write] -o <file>` with `CODEX_HOME` set. `turn.completed` carries `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`; price them from the table; verify whether reasoning tokens are already included in `output_tokens` before summing.

### 5.6 Pricing contract

```ts
PriceTable { version: string /* ISO date */, models: Record<string, { input, output, cacheWrite5m, cacheWrite1h, cacheRead } /* USD per MTok */> }
computeCost(usage: TokenUsage, model: string, table: PriceTable, cacheTtl: '5m' | '1h'): number
```

Subscription runs use the 1h cache TTL; API-key and usage-credit runs use 5m. Record `cacheTtl` on the round. Prefer the CLI's own cost figure when present (`costBasis: 'cli'`); use the table for Codex and as a cross-check.

### 5.7 IPC contract (renderer ⇄ main)

Define a single typed channel map; generate `window.gauntlet.*` from it in preload.

```
auth.getSession / auth.signIn / auth.signOut / auth.onChange
team.list / team.create / team.join(code) / team.createInvite / team.setActive
harness.list / harness.add / harness.remove / harness.detect(kind) / harness.startLogin(id) / harness.submitCode(id, code)
             / harness.probe(id) / harness.onLoginEvent
worker.status / worker.setPaused(bool) / worker.onStatus
loop.list / loop.create(config) / loop.start(id) / loop.cancel(id) / loop.get(id)
rounds.list(loopId) / rounds.onEvent(loopId)     // streaming RoundEvents
```

Every request/response pair is `{ channel, request: ZodSchema, response: ZodSchema }`; events are `{ channel, payload: ZodSchema }`. Add a test that every channel in the map has a handler registered in main.

### 5.8 Database (Supabase)

Tables mirror §5.1–5.5: `teams`, `team_members`, `team_invites`, `workers`, `worker_capabilities`, `loops`, `jobs`, `rounds`, `round_events`. RLS: rows visible to members of the row's team; workers can only update jobs they claimed. RPCs:
- `redeem_invite(code)`
- `claim_job(worker_id, capabilities jsonb)` → uses `FOR UPDATE SKIP LOCKED`, returns at most one job whose `requires` matches a capability and whose loop belongs to the worker's team.
- `heartbeat(worker_id)`.
Realtime on `jobs`, `rounds`, `round_events` for the dashboard. A contracts test parses `supabase/migrations/*.sql` column lists against `db.ts` schemas (or generate `db.ts` from `supabase gen types` and wrap in Zod).

## 6. Control variables (experiment integrity)

Every round must record, and the dashboard must display, these so arms are comparable:

pinned `claude` and `codex` CLI versions; model ids; effort; `contextMode`; `authMode` and cache TTL; `promptSha256`; references `manifestSha256`; `priceTable.version`; repo `baseRef`; worker id + platform; whether operator steering was used (must be `false` in experiment loops); stop-condition parameters; wall clock and equivalent cost.

If any of these differ between two rounds of the same arm, the dashboard flags the arm as "not comparable".

## 7. Onboarding screens (v1, minimal)

1. **Sign in** — Supabase Auth (email magic link + GitHub OAuth). 
2. **Team** — "Create a team" or "Join with code". Active team selector in the title bar.
3. **Harnesses** — cards for Claude and Codex: Detected version / Not found; "Sign in" button → shows the URL (auto-opened) and, for Claude, a code paste field; status pill from `LoginState`. Toggle to add an API-key account instead.
4. **Worker** — this machine's status, roles it will accept, pause switch.
5. **Loops** — list, create (form that writes a `LoopConfig`, computes hashes, uploads references to Supabase Storage), and a per-loop dashboard: rounds table, live event stream with the delegation tree, per-round tokens / equivalent cost / wall clock, control-variable panel.

## 8. Milestones

- **M1 — Contracts (this session).** `packages/contracts` complete with Zod schemas, canonical-JSON hashing, `computeCost`, IPC map, DB row schemas; Supabase migrations + RLS + RPCs; stub adapters that satisfy `HarnessAdapter` with fixture-driven fake streams; an Electron shell that boots, signs in to Supabase, and creates/joins a team. Tests: schema round-trips, hash determinism, cost math against known figures, IPC map coverage, DB-vs-schema sync.
- **M2 — Harness login.** Real PTY login for Claude and Codex, probes, `safeStorage` for API keys, worker registration + heartbeat.
- **M3 — Single-machine loop.** Run a generator+critic loop end to end on one worker with fresh context; stream events to the dashboard; enforce cost ceiling and stop conditions.
- **M4 — Multi-worker.** Job claiming across teammates' machines; rate-limit pause/resume; attribution in the dashboard.

## 9. Tooling notes for the local session

- Node 22+, pnpm, `electron-vite`, React 19, TanStack Router/Query, Zustand, Zod, `node-pty`, `@supabase/supabase-js`, Vitest.
- Pin `claude` and `codex` versions in `packages/contracts/src/harness.ts` as constants and assert them in `detect()`. Capture real stream-json / `codex exec --json` transcripts as fixtures before writing parsers.
- Windows: Claude Code needs Git for Windows' bash on PATH; credentials are a plaintext file under `CLAUDE_CONFIG_DIR` — set restrictive permissions on the dir we create. `node-pty` needs the Windows build tools; use prebuilt binaries via `electron-rebuild`.
- Do not bundle the CLIs in M1–M3; detect the user's installs. Revisit bundling only if version pinning proves unreliable (bundling means "hosting Claude Code" under Anthropic's Commercial Terms).
- Start `docs/DECISIONS.md` with the decisions in §1 and §2, dated 2026-08-30.

## 10. References checked 2026-08-30

- Claude Code: legal-and-compliance, headless, authentication, monitoring-usage, agent-sdk/cost-tracking, workflows — https://code.claude.com/docs/en/
- Anthropic help center: "Use the Claude Agent SDK with your Claude plan" (paused change) — https://support.claude.com/en/articles/15036540
- Anthropic Consumer Terms — https://www.anthropic.com/legal/consumer-terms
- Codex: non-interactive mode, auth — https://learn.chatgpt.com/docs/non-interactive-mode , https://learn.chatgpt.com/docs/auth
- OpenAI Terms of Use — https://openai.com/policies/terms-of-use
- Pricing — https://platform.claude.com/docs/en/about-claude/pricing , https://developers.openai.com/api/docs/pricing
- Conductor (reference for the "drive the stock CLI, reuse its login" pattern; Tauri, macOS-only) — https://www.conductor.build/docs/faq
