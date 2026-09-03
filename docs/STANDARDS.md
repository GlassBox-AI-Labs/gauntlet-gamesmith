# Gauntlet Gamesmith coding and review standards

> **Status:** Active for the desktop app as of 2026-09-03. The local PR reviewer implementation and
> reviewer-specific enforcement remain deferred until the shadow-mode rollout in
> [`LOCAL_PR_REVIEWER.md`](LOCAL_PR_REVIEWER.md); that deferral does not suspend these rules for
> human or agent-authored desktop changes.
>
> **Purpose:** This is the shared standard for code authors and reviewers. Rule IDs are stable so
> automated findings can cite the same language humans use.
>
> **Scope:** the Electron desktop app under `apps/desktop/` and the local PR reviewer described in
> `LOCAL_PR_REVIEWER.md` once it lands in this repository. Rules that only make sense for one of
> them say so.
>
> **Product goal these rules serve:** everything that happens behind the scenes is visible to the
> operator. Every prompt, thought, tool call, command, search, file edit, spawned agent, cost figure,
> and failure shows up in the log and the UI as it happens. Nothing an agent does is hidden for
> tidiness. VIS-001 makes this enforceable; LOG-001, PROC-004, and UI-001 support it.

## Precedence and interpretation

1. Product and policy decisions in [`DECISIONS.md`](DECISIONS.md) take precedence. This covers
   what the product does and what it must never do (for example the credential posture in ADR-002).
   Implementation details an ADR happens to mention (library choices, directory names, migration
   mechanics) are not policy; where they disagree with the code, rule 2 applies. ADR-004 records the
   known drift.
2. The implementation is canonical for current behavior. A document that disagrees with working
   code is evidence to resolve, not permission to silently change behavior.
3. These standards govern new and materially changed code. Existing debt outside the diff is not a
   PR finding unless the change relies on it, worsens it, or makes it unsafe.
4. A requirement or PR acceptance criterion takes precedence over a stylistic preference. Record a
   new durable architectural choice as an ADR instead of hiding it in a code comment.

Review findings must identify a concrete failure mode, cite a rule ID, point to evidence in the
diff or directly affected code, and state the smallest acceptable correction. Do not report taste,
speculative future needs, or a tool's lint/typecheck output as an AI-authored finding.

### Severity

- **Blocker:** credible credential exposure, arbitrary command execution, data loss/corruption,
  wrong-account billing, privilege-boundary violation, stale review publication (PR reviewer only),
  or a required check that cannot pass.
- **Major:** user-visible incorrect behavior, broken restart/recovery behavior, contract drift,
  an unmet acceptance criterion, or missing verification for a risky behavior change.
- **Minor:** bounded maintainability or usability problem with a concrete cost. Minor findings do
  not fail a review by themselves.

## Architecture

### ARCH-001 — Keep Electron privilege lanes intact

**Default severity:** Blocker.

- `apps/desktop/src/main/**` owns Node.js, filesystem, SQLite, subprocess, credential-environment, and Electron
  main-process capabilities.
- `apps/desktop/src/renderer/**` is browser code. It must not import Node/Electron main modules, access the
  filesystem or database, spawn processes, or receive secrets.
- `apps/desktop/src/preload/**` is the only renderer-to-main bridge. Keep context isolation enabled,
  `nodeIntegration` disabled, navigation denied, and the bridge capability-based.
- `apps/desktop/src/shared/**` must remain environment-neutral. It may contain types and pure behavior consumed
  by both sides, but it must not import from `main`, `preload`, Electron, or `node:*`.

### ARCH-002 — IPC is a typed, validated trust seam

**Default severity:** Blocker for privileged inputs; Major otherwise.

- Define the caller-facing contract in `apps/desktop/src/shared/**`; preload and main must implement the same
  contract rather than duplicating shapes.
- Treat every renderer value as `unknown` in main and validate it before filesystem, process,
  database, or network use. A TypeScript cast is not validation.
- Return explicit success/error results for expected operational failures. Do not make the renderer
  infer failure from missing data.
- Event subscriptions must return an unsubscribe function, and React consumers must call it during
  cleanup.

Current channels are named once in `apps/desktop/src/shared/ipc.ts`. Main validates every incoming
value through the bounded parsers in `apps/desktop/src/main/ipc-input.ts` (or a capability-specific
validator such as the raw-stream resolver) before using it.

**What IPC is in this app.** Electron runs two processes. Main is Node: it owns the daemon, SQLite,
the child CLIs, and the filesystem. The renderer is a Chromium page running React with no Node
access. Inter-process communication (IPC) is how the page asks main to do things and how main pushes
state back. The preload script exposes two typed objects, `window.harnesses` and `window.loops`,
through `contextBridge`; each method forwards to a named channel that main handles.

Channel conventions:

- Names are `area:verb` (`loop:start`, `harness:probe`, `play:state`). One area per main-process
  module.
- Request/response uses `ipcMain.handle` in main and `ipcRenderer.invoke` in preload. Reserve
  fire-and-forget `send` for high-frequency input such as terminal keystrokes.
- Main-to-renderer pushes (`loop:update`, `loop:log`, `play:state`) are events; the preload wraps
  them in an `onX(listener)` method that returns the unsubscribe function.
- Adding a channel touches four places: the contract type in `shared/`, the preload method, the
  main handler with its validation, and the renderer call. A PR that adds only some of them is
  incomplete.
- Handlers return `{ ok, error }` style results for expected failures (`loop:start` does this);
  they throw only for programmer errors.

### ARCH-003 — Put behavior behind deep modules

**Default severity:** Major.

- A module should expose a small interface that hides substantial behavior. Callers should not
  reproduce its ordering rules, recovery logic, parsing, or invariants.
- The interface is the test surface. Prefer a result-returning operation over a sequence of public
  setters that callers must coordinate correctly.
- Add an adapter seam only where behavior really varies or where a true external dependency needs a
  production adapter and a test fake. Keep test-only internal seams out of the public interface.
- When adding a substantial responsibility to `apps/desktop/src/main/index.ts`, `loop-runner.ts`,
  `ledger.ts`, or a large renderer view, first extract a coherent module instead of growing another independent control flow inside
  the file.

### ARCH-004 — Keep role and harness decisions canonical

**Default severity:** Major.

- Derive the harness from the selected model through the shared model helpers. Do not maintain a
  second harness/model mapping at a call site.
- Build process invocation through the canonical spawn-plan helpers. Role-specific branches belong
  there, not scattered through the runner.
- Prompt text that is previewed in the renderer and executed in main must come from one shared
  composition path.

## CLI, credentials, and child processes

### PROC-001 — The stock CLI owns authentication

**Default severity:** Blocker.

- Spawn the unmodified Claude Code or Codex binary under the user's own local login. App-controlled
  code never opens, reads, copies, parses, transmits, or intermediates credential-store files or
  subscription tokens. A run receives only the app-managed harness-home paths its selected primary
  and cross-harness workers actually require.
- Keep each harness home private to the user (`0700` where supported). Never inspect or expose
  credential-bearing files, expose the directory itself to the renderer, or include the directory
  in exports. A run may read the CLI's documented, non-credential transcript files from its own
  isolated harness home to surface delegated-agent activity required by VIS-001; copy only bounded,
  parsed events into the ledger and apply the same token/secret redaction as every other log source.
- Subscription runs must remove `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CODEX_API_KEY` from the
  child environment so a local shell setting cannot silently change the billing path.
- SQLite history, renderer projections, errors, events, and reports must not contain tokens,
  complete environments, or credential-file contents. Apply the shared secret redactor before
  those sinks.
- Complete raw CLI streams are opaque evidence, not a credential-safe projection. They remain
  byte-complete for VIS-001 and are included in a portable export; a broad same-user CLI can read
  accessible files and may echo sensitive text into that output. The app never inspects a credential
  store to try to identify those values. Export must warn that raw streams are unsanitized and may
  contain secrets; operators review the folder before sharing it. Removing this limitation requires
  a separately designed OS/account sandbox or a brokered execution boundary.

### PROC-002 — Treat process arguments as untrusted data

**Default severity:** Blocker.

- Prefer `spawn(binary, argv)` with an argument array and `shell: false`. Do not interpolate user,
  repository, PR, path, branch, or prompt data into a shell command.
- Where cross-harness delegation necessarily emits a shell command, use the canonical quoting
  helper in `apps/desktop/src/main/delegation.ts` and regression-test quotes, spaces, leading dashes,
  redirects, substitutions, and traversal attempts.
- Delegated stream names use the one strict grammar in `main/child-stream-name.ts`; producers and
  every parser reject anything outside `[a-z0-9-]+` before constructing or reading a path.
- Use an explicit working directory and a deliberately constructed environment for every child.
  Never pass secrets merely because they happen to exist in `process.env`.

### PROC-003 — Persist lifecycle state before acting

**Default severity:** Blocker for lost/corrupt work; Major otherwise.

- Persist a queued/starting record before launch, then record and validate the returned PID, process
  group, OS identity, original stream-file identities, and a bounded exact snapshot of owned group
  members before declaring the attempt running. Advance the group snapshot only while the leader or
  a previously owned member proves exact continuity; recovery never adopts a fresh group merely
  because it reused the old numeric PGID. Direct POSIX spawn has a narrow
  post-spawn/pre-identity-commit crash window; an incomplete starting marker must quarantine the
  attempt and forbid automatic requeue or Resume. Eliminating that residual requires a separately
  designed launch wrapper/handshake that does not start the CLI until durable ownership exists.
- A run must have deterministic terminal states. Completion, error, timeout, cancellation, app quit,
  and machine restart must not leave it permanently `running` or cause duplicate advancement.
- Preserve session/thread IDs and the last valid result needed to recover or resume. Recovery must be
  idempotent.
- Use SIGINT for graceful agent interruption, then bounded escalation when the caller remains alive.
  Kill the intended process group only after validating its PID and ownership.
- Timers and watchers must be bounded, unreferenced where appropriate, and cleaned up on every
  terminal path.
- Trusted Play launches keep repository code behind an app-controlled gate until the detached
  wrapper's exact group identity is captured. Late descendants are unioned only across exact-member
  continuity. A committed application quit waits for verified Play settlement; cancelling quit must
  not stop the game.

### PROC-004 — Parse streams defensively

**Default severity:** Major.

- CLI output is versioned external data. Parsers must tolerate partial writes, malformed lines,
  repeated messages, unknown event kinds, missing optional fields, and abrupt termination.
- Deduplicate cumulative or repeated usage events before computing tokens or cost. Record which
  source produced each estimate.
- A model's prose is not a durable verdict. Require and validate a machine-readable artifact or
  schema-constrained result before changing loop or review state.
- Pin or record the CLI version used for a run. Any parser change needs representative fixtures from
  the affected version.

## Storage and portable run history

### DATA-001 — SQLite stays in the main process

**Default severity:** Blocker.

- Only main-process modules open SQLite. Renderer and preload code use typed IPC operations.
- Multi-row state transitions and import/synchronization operations are transactions with rollback.
- Prepared statements carry values. Never build SQL with user-controlled interpolation.
- Close databases and replace cached handles deliberately before copying, importing, or deleting a
  run folder.

### DATA-002 — Stored history is backward compatible

**Default severity:** Major; Blocker when existing data becomes unreadable or corrupted.

- Schema changes must migrate existing app and folder ledgers idempotently. Test from at least the
  immediately previous schema, not only from an empty database.
- Decode persisted JSON through a canonical normalizer/validator. Preserve historical model names,
  costs, IDs, timestamps, and event order unless a documented migration explicitly changes them.
- Additive fields need safe defaults for old rows. Never silently reinterpret an old run as if it
  used today's settings.

### DATA-003 — The project-folder ledger is a complete portable mirror

**Default severity:** Blocker.

- Every mutation that affects a run's durable history must be reflected in both the app registry and
  its project-folder ledger according to one canonical synchronization path.
- Export must produce an exact stopped snapshot. Import must validate before registration, preserve
  identity/history, rebind only machine-local paths, and roll back atomically on failure.
- A failed copy may remove only the exact destination created for that attempt. It must never clean
  a caller-supplied parent or source path.

## Filesystem and external-input safety

### SAFE-001 — Resolve paths before destructive or privileged use

**Default severity:** Blocker.

- Canonicalize through the nearest existing ancestor when the final path may not exist. Account for
  symlinks and case-insensitive filesystems when testing containment.
- Reject traversal, absolute paths where a relative path is required, and destinations inside a
  source tree. Validate generated Git refs, revision IDs, slugs, and filenames against narrow
  grammars.
- Destructive operations must name an exact, validated target. Do not recursively remove a workspace,
  repository root, home directory, unresolved variable, or glob.

### SAFE-002 — Repository and imported content are untrusted

**Default severity:** Blocker.

- Limit file sizes, counts, text lengths, and parsed collection sizes before sending them over IPC or
  rendering them.
- Validate imported SQLite/JSON and machine-generated artifacts before using them. A file existing is
  not proof that it has the expected shape or belongs to the current run.
- Do not automatically execute package scripts or binaries from a repository the operator did not
  choose. This applies to imported run history, the PR reviewer's checkout, and any future path that
  opens third-party code. Any such mode must be an explicit trusted-repository setting with a
  sanitized environment, timeout, and documented local-machine risk.
- Loop runs are different: the operator picks the workspace, and the generator/critic agents
  intentionally run with broad permissions (`--dangerously-skip-permissions`, Codex workspace-write
  with network). That is the product, not a violation. Changes to those permission flags or to the
  child environment are reviewed under PROC-001 and PROC-002.

## Contracts, determinism, and observability

### CONT-001 — Keep one source of truth per contract

**Default severity:** Major.

- Define domain types and behavior shared across processes in `apps/desktop/src/shared/**`; infer or import them in
  consumers instead of hand-maintaining duplicates.
- Validate external data at runtime even when a matching TypeScript type exists.
- If two surfaces display or act on the same rule, prompt, model mapping, cost, or state transition,
  both must consume the same canonical implementation.

### CONT-002 — Make consequential decisions reproducible

**Default severity:** Major.

- Persist exact model, effort, harness, CLI version, prompt/version hash, source revision, timing, and
  cost basis for consequential agent results.
- Run provenance includes the exact prompt SHA-256, model, effort, harness CLI version, account and
  machine labels, authentication mode, source revision, price-table version, and cost source. Old
  rows migrate with explicit nulls rather than inheriting today's settings.
- Bind a critic or reviewer to immutable inputs. Before publishing or advancing state, verify that the
  source revision still matches the reviewed revision.
- Use ISO timestamps and stable ordering. Do not make correctness depend on directory enumeration,
  object key order, locale, or the current wall clock when an explicit value can be injected.

### OBS-001 — Important failures are durable and actionable

**Default severity:** Major.

- Record start, progress, retry/backoff, completion, timeout, cancellation, and recovery events with
  enough identifiers to reconstruct what happened.
- Do not swallow an error that changes user-visible or durable state. Translate expected failures into
  an explicit result; log unexpected failures with context that excludes secrets.
- Rate limiting and transient provider failures are retryable states with bounded backoff, not generic
  test failures or tight retry loops.

### LOG-001 — Log lines are a typed, bounded event stream

**Default severity:** Major.

- Every log line is a `LoopLogLine` from `apps/desktop/src/shared/loop.ts`: loop ID, run ID, ISO
  timestamp, `kind`, `text`, and optional `agentId`, `round`, `role`, `channel`. `kind` names the
  specific event (`verdict`, `shot`, `metric`, `stderr`, ...). `channel` is the renderer's filter
  bucket and is derived from `kind` through `channelForKind`; a new kind must be added to that map or
  it silently lands in `system`.
- The exact execution prompt is logged once per run, round-labelled, before the process spawns. The
  log alone must tell the full story of what each agent was asked to do.
- Raw CLI output is the evidence and lives on disk: `.gauntlet-gamesmith/runs/<runId>.out.ndjson`
  and `.err.log` for primary agents, and `.gauntlet-gamesmith/agents/<slug>.<harness>.jsonl` for
  delegated children. A validated legacy `.gauntlet-loop/` directory is migrated to the current
  name without overwriting an existing current directory; unsafe or ambiguous histories fail
  closed. Log lines are the parsed, truncated projection of those files. Truncate before logging;
  never store an unbounded tool result or stream line in the ledger.
- Denormalize `round` and `role` at write time so the renderer filter strip stays a pure predicate
  over lines with no join.
- Metric lines label cost as equivalent API cost (ADR-002) and say which source produced the
  estimate.
- Projected log lines are durable history: they mirror to both ledgers (DATA-003) and must never
  contain tokens, environment dumps, or credential-home contents (PROC-001). Byte-complete raw
  stream evidence is governed by PROC-001's explicit export warning rather than projected as-is.

### VIS-001 — Everything an agent does is visible

**Default severity:** Major; Blocker when an event class is silently dropped.

- Every class of harness event is translated into a log line by the stream translators in
  `apps/desktop/src/main/streams/claude-stream.ts` and `codex-stream.ts`: thinking or reasoning
  (`thought`), tool call with name and key input (`tool`), shell command (`cmd`), search query
  (`search`), file edit, subagent or worker spawn (`spawn`), usage (`metric`), final message
  (`agent`/`verdict`), and errors. An event kind the translator does not recognize is logged under
  `system` with its raw kind so the operator can see that something unhandled happened. It is never
  dropped.
- The model's thought text is shown as the CLI delivers it. The app never reconstructs, paraphrases,
  or filters reasoning. If a CLI or effort setting emits no thinking for a run, the UI should say the
  channel is unavailable for that run rather than showing an empty filter.
- Delegated agents are first-class. Subagents and cross-harness workers are tailed from their stream
  files and shown nested under the agent that launched them, with their own `agentId`, tool calls,
  tokens, and cost. A worker that runs for an hour with no visible activity is a bug, not a quiet
  success.
- New observability defaults to a timestamped entry in the event log, where it inherits the existing
  round, agent, and channel filters. Data does not earn a separate badge, card, icon, or persistent
  control merely because it exists. Promote it out of the log only when a distinct operator workflow
  justifies the additional UI; focused detail may open from an event-log link in a transient drawer.
- Truncation is for the projection only. Log lines cap thought text and tool inputs, but the raw
  stream file for every run and every child stays complete on disk, and the UI must let the operator
  inspect it from a timestamped event-log link. Do not lower a truncation limit to make the log
  tidier or dump byte-complete, potentially sensitive raw output into the projected event log.
- The exact execution prompt for every run, including delegated briefs written to
  `.gauntlet-gamesmith/` (or validated legacy `.gauntlet-loop/` metadata), is visible in the log
  (LOG-001).
- All channels are visible by default. Hiding is an operator choice made in the filter strip, and
  filter state survives incremental updates (UI-001).
- Failures are shown where they happened: a tool error, a non-zero exit, a timeout, a rate-limit
  pause, and a stale or invalid verdict each get their own line at the moment they occur, not a
  summary at the end.
- A new CLI version that adds an event type needs a fixture and a translator case in
  `claude-stream.test.ts` or `codex-stream.test.ts` (PROC-004). A translator test exists for every
  event class the rule above lists.

## Testing and verification

### TEST-001 — Test the changed behavior at the cheapest real seam

**Default severity:** Major.

- Pure computation and parsers get focused Vitest tests. Stateful modules are tested through their
  public interface with temporary directories/databases. Renderer logic should be pulled into pure
  modules under `renderer/src/lib` and tested there; there is no component-test tooling (jsdom,
  Testing Library) installed today, so a reviewer must not require component tests until a PR adds
  that tooling.
- A regression fix includes a test that fails for the reported failure mode. Do not reimplement the
  production algorithm inside its test.
- Tests must not use the real GitHub API, real agent accounts, live subscription calls, or the user's
  credential homes. Use captured fixtures and explicit fakes.
- Time, randomness, filesystem roots, process launch, and external providers must be controllable at
  the module's test seam when they affect correctness.

### TEST-002 — Required checks are explicit

**Default severity:** Major.

- Run `pnpm test` and `pnpm typecheck` for application changes. Build when packaging, Electron entry
  points, preload, Vite, Tailwind, or dependency changes could fail only at bundle time.
- If a required check is already failing on the base revision, record the exact baseline failure and
  prove the PR introduces no new failures. “Pre-existing” without a base comparison is not evidence.
- Never claim a check passed when it did not run, lacked dependencies, timed out, or covered only a
  substitute implementation.

## Loop phases and prompts

The loop today is: **reference** (round 0, one-time Reference Study) → **implement** (round n) →
**critique** (round n) → implement (round n+1, fed the critic's findings) ... until the critic passes,
rounds or budget run out, or the user stops. A fourth phase, **asset** (produce the game's shipping
art, audio, and data with provenance, between reference and the first implement), is planned; the
rules below are written so it can be added by following the checklist rather than by inventing a new
control flow.

### PHASE-001 — A phase is a role with a complete contract

**Default severity:** Major; Blocker when a phase can leave the loop permanently `running`.

Adding or materially changing a phase touches all of the following. A PR that does some of them is
incomplete.

1. **Role.** Add it to `RunRole` in `apps/desktop/src/shared/loop.ts`, give it a `runPromptLabel`,
   and register any new log kinds in the channel map (LOG-001).
2. **Prompt.** One builder in `apps/desktop/src/shared/prompts.ts` (PROMPT-001). Harness-specific
   delegation text comes from `main/delegation.ts` and is passed in as a parameter, never inlined.
3. **Queueing.** The previous phase's `finalize` enqueues the next run with `ledger.createRun`,
   deriving the harness from the model (ARCH-004) and checking `overBudget` first. `executeNext`
   dispatches by role. `resumeLoop` and `recoverAll` have per-role branches and must learn the new
   role; this is the step most often missed.
4. **Execution.** Keep the `executeX` orchestration adapter in `loop-runner.ts`, but put any
   substantial parser/protocol in a public `main/roles/` factory. The role module owns its bounded
   stream state, accounting, and finalization contract; the runner supplies process and persistence
   seams. The parser follows PROC-004 and reports progress so `driveRun`'s idle and hard-cap
   timeouts work.
5. **Owned artifact directory.** Each phase writes to exactly one workspace directory it owns:
   `reference/<loop-id>/`, `critique/round-<n>/`, and for the asset phase `assets/<loop-id>/`.
   Later phases read it and never write it. Reference evidence never ships as a game asset.
6. **Completion artifact validated in main.** The phase succeeds only when a main-process scanner
   says so: `scanReferencePack` for the pack, the parsed attempt-specific
   `verdict-<run-id>.json` for critique. The model's
   prose is not a completion signal (PROC-004). An asset phase needs a manifest scanner that checks
   every file exists, has a hash, a license or generation record, and was not copied from the
   reference pack.
7. **Retry semantics.** The prompt tells the agent to audit existing output first and keep what is
   valid. Attempts are bounded (`MAX_REFERENCE_ATTEMPTS` is the pattern) and preserved files survive
   the retry.
8. **Terminal states and cost.** Every exit path patches the run with tokens, cost, duration,
   session ID, and a terminal status, then calls `accumulateCost` (PROC-003).
9. **Renderer.** A panel per phase (`ReferenceStudyPanel`, `CritiquePanel`) that reads through a
   typed, size-capped IPC operation (`loop:reference`, `loop:critique`). No panel reads the
   workspace directly.
10. **Report.** `report.ts` includes the phase's artifacts in the exported summary.
11. **Tests.** A prompt-contract test in `prompts.test.ts`, a scanner test like
    `reference-pack.test.ts`, a parser test like `parse-verdict.test.ts`, and resume/recovery
    coverage.
12. **Docs.** The README's loop description and this section.

### PHASE-002 — Phase boundaries are frozen files, not conversation

**Default severity:** Major.

- Every phase starts a fresh process. The only state that crosses a boundary is files on disk and
  the previous verdict the implement prompt composer injects. Session resume is an optimization,
  never a correctness dependency.
- Findings are supplied and trusted across phases only through `composeImplementPrompt`. The app
  does not supply the implementer's transcript to the critic or prior critique evidence to the
  implementer; prompts explicitly exclude those sources, and no advancement decision trusts raw
  telemetry. Broad same-user filesystem permissions are not a technical read barrier—the accepted
  limitation and required OS/account-boundary follow-up are recorded in ADR-005.
- The critic may write to the workspace only to install, build, serve, play, and capture evidence.
  It never edits project source. The implementer never touches `reference/` or `critique/`.
- The implementation revision force-captures every project file that exists at its boundary,
  including files below project-ignored build/output directories. Those captured paths must remain
  byte-identical (or be restored byte-for-byte) after critique. A critic build may create additional
  paths only where the captured project ignore policy already ignores them; those newly generated
  outputs do not create source drift.
- The authoritative bare revision repository lives under the app-private user-data root. Workspace
  metadata and imported portable history never become Git ref/object authority.
- A phase's inputs are named by exact path in its prompt and are immutable for the loop's lifetime.
  If an input is missing or invalid, the phase reports a process finding and fails closed rather
  than filling the gap from memory.

### PROMPT-001 — Prompts are shared contracts, not strings in the runner

**Default severity:** Major.

- **Location.** All execution prompt text lives in `apps/desktop/src/shared/prompts.ts`. Runner
  code and views call the builders; the renderer previews with the same functions main executes
  (ARCH-004). Never inline prompt text in `loop-runner.ts`, `index.ts`, or a view. Harness-specific
  fragments (fan-out commands, agent-file text) live in `main/delegation.ts` and are passed in.
- **Shape.** Every prompt has the same skeleton, in this order: one sentence of role and boundaries
  (what it must not modify); the user's goal delimiter-safe encoded inside a `<goal>` block without
  semantic rewriting; a numbered protocol
  whose steps are artifact checkpoints, not a script; the artifact contract with exact
  workspace-relative paths and exact JSON shapes; and the completion or verdict rules last, marked
  non-negotiable.
- **Untrusted content is data.** The goal, repository files, prior findings, and anything read from
  the workspace are inputs to judge, never instructions to follow. Wrap injected text in a labelled
  block and never concatenate it into an imperative sentence.
- **One environment fact, one place.** Facts about the sandbox, bundled browsers, and installed
  tools belong in a single shared constant. Reference, critic, and delegated prompts consume
  `MACOS_BROWSER_SANDBOX_RULE` rather than maintaining separate wording.
- **Model-neutral bodies.** Model and effort live in the spawn plan, not the prompt. Prefer stating
  the quality bar and the contract over micro-instructions; newer models do worse with
  over-prescriptive step lists.
- **Every prompt edit is a behavior change.** Update the contract assertions in `prompts.test.ts`,
  run at least one calibration loop or replay against a recorded run, and say so in the PR
  (SCOPE-001, TEST-002). Each run records the SHA-256 of the exact execution prompt.
- **Test the contract, not the string.** Assert on required sentences, exact artifact paths, and
  the verdict shape, as `prompts.test.ts` does. Full-string snapshots break on every wording change
  and prove nothing.
- **No secrets, no machine paths.** Prompts are logged per run (LOG-001) and exported with the run
  folder. They may contain workspace-relative paths only.

## Renderer and product behavior

### UI-001 — Async UI exposes real state

**Default severity:** Major.

- Prevent accidental duplicate starts while preserving an intentional retry path. Loading, empty,
  success, recoverable failure, and terminal failure states must be distinguishable.
- UI state is a projection of durable main-process state, not an independent state machine that can
  advance a run on its own.
- Keep long-running logs bounded and preserve operator context such as filters, selection, and scroll
  position during incremental updates.

### UI-002 — Interactive controls are accessible

**Default severity:** Major for an unusable path; Minor otherwise.

- Use semantic controls, visible focus, keyboard operation, programmatic labels, and accessible names
  for icon-only actions.
- Do not rely on color alone for status. Pair it with text or an icon and maintain sufficient contrast.
- Dialogs and sheets must manage focus, Escape, dismissal, and destructive confirmation consistently
  through the established UI primitives.

## Change scope and documentation

### SCOPE-001 — One PR has one coherent purpose

**Default severity:** Major.

**One-time exception:** ADR-012 permits PR #24 to land as a single audit-remediation batch. This
does not change the rule for later pull requests.

- Every changed file must support the stated purpose or a necessary refactor/test for it. Split an
  independently releasable feature into its own PR.
- The PR description names the behavior change, risks, verification actually run, known limitations,
  and linked acceptance criteria. Generated summaries are evidence to verify, not authority.
- Keep commits reviewable enough to distinguish independent concerns and integration work.

### DOC-001 — Durable decisions live in durable places

**Default severity:** Minor; Major when operators would act on stale guidance.

- Append accepted architectural/product decisions to `docs/DECISIONS.md` with date, context,
  decision, and consequences.
- Update the README, prompts, standards, and operator instructions in the same PR when behavior makes
  them false. Prefer deleting stale instructions to preserving contradictory history in active docs.
