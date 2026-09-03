# Standards audit resolution — 2026-09-02

This records how the findings in [`STANDARDS_AUDIT.md`](STANDARDS_AUDIT.md) were closed. The
original report remains unchanged below its historical-snapshot banner so its evidence and severity
counts remain reviewable.

## Blocker closure

- **Owned processes.** Failed spawns never invent a PID. A starting marker is durable before launch;
  the returned PID/group, overlap-advanced identities of captured group members, and original stream-file identities are validated before the attempt becomes
  running. The canonical registry is authoritative for retained ownership, while workspace process
  metadata is only a replay mirror. Supervision retains ownership through finalization and clears it in `finally` only after verified process-group absence; parser,
  stream, timeout, stop, escalation, and recovery failures are visible events. An incomplete launch
  marker is permanently quarantined instead of requeued; the narrow direct-spawn crash limitation is
  stated below rather than represented as recoverable ownership.
- **Workspace metadata.** Run metadata and streams use one component-by-component real-directory
  boundary. Exact paths, schemas, sizes, link counts, offsets, and file identities are checked
  before use. Imported active attempts become interrupted and cannot cause a signal or path read.
- **Project execution.** Play uses a minimal environment, isolated home/cache, local installed
  scripts only, a hard timeout, and bounded group shutdown. A fixed wrapper keeps the project command
  behind a private launch gate until exact process-group ownership is captured. Membership is unioned
  only across exact overlap, retaining late background-server supervision after launcher exit; an
  unverified wrapper never releases project code, is interrupted through its direct child handle,
  and is never signaled by numeric process-group id. Committed app quit waits for settlement, while
  Cancel leaves Play running. Imported folders are forced untrusted;
  Play, rename, raw private-profile reveal, and loop resume remain disabled because this release has
  no re-trust UI. Pre-provenance histories also migrate fail-closed because their local/imported
  origin cannot be proven; this accepted upgrade limitation is recorded in ADR-005 and the README.
- **Event visibility.** Claude, Codex, delegated-child, and workflow translators emit malformed,
  unknown, progress, failure, spawn, completion, and raw-line events instead of dropping them.
  Every projected event is attributed where the CLI supplies an identity and passes through the
  same credential redactor before SQLite or renderer delivery.

## Lifecycle, phase, and verdict integrity

- The runner injects process, clock, wait, timer, CLI-version, hostname, and harness-home boundaries.
  Public lifecycle tests cover spawn failure, recovery, hard-link replacement, finalization
  ownership, rate-limit pause, and phase-boundary rejection.
- Reference Study persists a round-zero source revision before launch and refuses completion or
  retry if project source changed. Implement persists a critique-tree fingerprint and refuses
  completion or retry if critique evidence changed. Both bindings survive recovery and requeue.
- The frozen Reference Pack is schema-checked, attributed, size/count bounded, link-safe, hashed,
  and reverified before and after later phases. Critique must leave the captured implementation
  revision unchanged.
- The attempt-specific `verdict-<run-id>.json` is the sole advancement channel. It is never prepared
  by deleting a prior pathname; it must be a fresh, bounded, singly linked regular file with an exact
  schema, pass/score invariant, and implementation revision binding. Prose output can be retained as
  a summary but cannot advance the loop.
- Resume sends and logs the complete shared prompt with a shared preamble. Session lookup is scoped
  to the exact round. Rate limits create a durable bounded pause without consuming a failure attempt;
  same-phase retries check the budget and preserve their phase bindings.
- All usage sources reject negative, fractional, non-finite, unsafe, and unknown counters. Streaming
  Claude usage is last-value-per-message, Codex cumulative usage is last-value-per-session, and
  research/workflow/delegated usage participates in totals and the budget.

## Storage, paths, and reproducibility

- Renderer inputs are `unknown` at main and pass bounded validators. IPC channel names and expected
  result shapes are shared across main, preload, and renderer. History lists and attempt detail are
  SQL-paged before decoding; the UI navigates bounded pages, uses canonical SQL aggregates, and loads
  only the currently viewed exact prompt through a dedicated one-record IPC operation.
- SQLite JSON is normalized before use. Import validates schema, relationships, row counts, values,
  IDs, timestamps, database/sidecar sizes, links, and collisions before registry mutation. Hidden or
  generated columns are rejected before integrity checks or row reads can evaluate them. Migration
  is idempotent per column and tested from the previous schema. Multi-row transitions use the ledger
  transaction boundary, and export first rebuilds the portable mirror.
- Canonical SQLite commits precede portable-mirror commits. Startup repair streams registered
  workspaces and their loop/run/event rows rather than materializing complete histories; post-commit
  mirror failures remain canonical repair obligations instead of rolling authority back to a folder.
- Workspace identity is canonical. Media, report evidence, Reference Pack files, process streams,
  raw-stream reveal, revision storage, Play storage, and child archives reject traversal, unsafe
  components, symbolic links, hard links, devices, and out-of-root canonical paths as appropriate.
  Directory and file processing is bounded before allocation or whole-file reads.
- Delegated-child streams require a phase-scoped directory identity, exact bounded inventory, singly
  linked files, bounded per-file and aggregate reads, and a real terminal event plus quiet interval.
  Missing/replaced metadata after observation, unknown entries, oversize streams, and active workers
  at the phase deadline fail the attempt instead of being reported as complete.
- Git runs with a minimal environment, global/system config disabled, and hooks/fsmonitor disabled.
  Its authoritative bare revision repository is app-private rather than agent-writable; imported
  portable history is never promoted into revision authority. Destructive cleanup targets only
  exact app-created directories.
- Each attempt records and logs effective prompt SHA-256, harness, exact reported CLI version, model,
  effort, authentication mode, account and machine labels, implementation revision, price-table
  version, and exact cost source. Equivalent API cost wording is used throughout.
- Installed CLI resolution yields one absolute path outside project/private roots, pins and
  revalidates its device/inode identity, and passes delegated workers only those app-constructed
  exact paths; arbitrary inherited or plan-supplied executable variables remain stripped.

## UI, prompts, and maintainability

- `RunView` is split into `RunForm` and `RunDetail`; harness login, status parsing, stream naming,
  persisted-data decoding, verdicts, process supervision policy, phase fingerprints, rate limits,
  child archiving, metrics, renderer predicates, and raw-stream resolution have focused modules and
  tests.
- Prompts live in `shared/prompts.ts`, use one browser-sandbox statement, contain explicit role,
  goal, evidence, directory, artifact, and verdict contracts, and expose the effective implement
  contract before round one. Caller text and critic feedback are delimiter-safe. The full effective
  prompt is logged and hashed.
- Raw primary and delegated streams can be revealed only through typed ownership-checked IPC. The
  UI explicitly represents unavailable thinking, truncated evidence, async failures, process state,
  and full nested-agent identity.
- Evidence controls, disclosures, status indicators, project chooser, and lightbox have semantic
  keyboard/focus behavior and descriptive alternatives. Pure filtering/visibility predicates live
  under renderer `lib/` with tests.
- Shared agent instructions, README, HANDOFF history, current standards, and accepted ADR-005 now
  agree with the shipped SQLite, IPC, signal, Reference Pack, provenance, Play, revision, and
  detached-process policies.

## Defense-in-depth added during recurrence review

The post-fix review also closed issues not named in the original snapshot: prompt close-tag
injection and credential-shaped provenance; malformed stored model IDs; hostile workflow arithmetic;
hard-linked evidence, workflow files, and SQLite sidecars; SQLite UUID/cross-workspace collisions;
mirror crash repair; protected credential/app roots; bounded history/prompt/media projections;
unbounded directory and parser-state materialization; partial stream lines and crash-safe workflow
cursors; ambiguous raw-stream discovery; and packaged loading of an environment-selected remote
renderer.

## Post-`main` synchronization review — 2026-09-03

After this remediation was rebased onto the latest `origin/main`, every newly introduced account,
asset, engine, report, delete, and phase-folding change was reviewed against the same standards:

- Attempt start time is captured only after CLI-version and account probes complete, immediately
  before durable launch metadata and spawn. Recovery therefore compares like-for-like process time.
- Rate-limit classification consumes terminal provider failures, not arbitrary visible model/tool
  prose. Provider wording remains recognized, while incidental “rate-limit” or “usage limit” text
  cannot replace the real terminal error.
- The canonical terminal transition stamps `finishedAt`, including retry-budget, cost-budget,
  cancellation, and interruption branches.
- Engine gates, contracts, asset tools, and generated agent definitions use workspace-identity,
  symlink, hard-link, inode, size, and descriptor checks. Asset state/factory reads are bounded and
  reject unsafe directory chains.
- Account registries are bounded and normalized, account paths are walked as real private
  directories, forged shared links and registry links are rejected, and account deletion resolves
  only an exact registered account directory.
- Report files and persisted report JSON use one complete bounded decoder. Import uses a bounded,
  identity-checked file descriptor; file deletion revalidates the ledger's registered workspace
  identity before removing a project folder.
- Account rotation, report comparison, report import/export, and guarded run deletion remain
  available in the split renderer architecture, alongside the folded asset/implement workflow and
  current Gauntlet Gamesmith metadata paths.

## Explicit limitation

The critic is instructed to treat `.gauntlet-gamesmith/` (and legacy `.gauntlet-loop/` metadata) as private telemetry rather than evidence, and
source/reference/evidence fingerprints prevent it from changing phase inputs or forging advancement.
The raw streams still live in the portable workspace because replayability is a product requirement.
A same-user Claude process running with the product's broad permission mode can technically read that
directory; moving it to another same-user path or changing `cwd` would not create an access boundary.
True read denial requires a separately designed OS sandbox or account boundary. No correctness or
advancement decision trusts transcript contents.

Direct detached spawn returns a PID only after the child has begun executing. The app writes a
starting marker first and commits validated PID/group identity immediately after spawn, but a crash
between those operations can leave a CLI that cannot be safely rediscovered or signaled. Recovery
quarantines that attempt and refuses automatic requeue or Resume, preventing duplicate work; true
recovery of that orphan requires a future wrapper/handshake process that waits for durable ownership
before launching the stock CLI.

## Verification

Run with the repository-required Node 22 runtime:

```text
pnpm test       # full Vitest suite
pnpm typecheck  # main and renderer TypeScript
pnpm build      # Electron production build
git diff --check
```

The pre-sync remediation baseline on 2026-09-03 used Node 22.23.1: `pnpm test` passed all 598 tests
across 61 files, `pnpm typecheck` passed, `pnpm build` passed, and `git diff --check` passed. The
post-sync verification result is recorded in the pull request because it includes the added mainline
features and their regression coverage.

### PROMPT-001 live calibration

An explicitly authorized live calibration ran on 2026-09-03 in an isolated, zero-dependency browser
game fixture outside this repository. It used the stock Codex CLI 0.147.0 with the
subscription-authenticated `gpt-5.6-luna` model at medium effort and preserved exact prompt files,
SHA-256 hashes, JSONL streams, final messages, artifacts, and run metadata locally. Raw streams are
not committed because they are intentionally unsanitized evidence.

- Reference Study prompt `9c5c95131f7bbd16ea8cbdbcd617285ffdfbb0cd9523488437cd9c9414461fbf`
  completed in 429 seconds. The product scanner accepted the resulting pack with 8 stills, 24
  projected motion frames, 4 journey shots, 1 gameplay video, all required text artifacts, a valid
  manifest, and no readiness issue.
- Implement prompt `1818a0bf8293744743f3a34f3a0ba611baf1897ebdd09185c0a22811902a93ce`
  completed in 760 seconds. The project still passed its build, the agent exercised the three-room
  progression, and no Reference Pack or tracked source boundary was modified after capture.
- The first critic replay correctly produced a low, revision-bound JSON verdict but exposed a real
  environment fact: normal multi-process Playwright Chromium could not register its Mach rendezvous
  port inside the Codex macOS sandbox. `MACOS_BROWSER_SANDBOX_RULE` was corrected once, in its shared
  source, to require the already-proven single-process compatibility arguments.
- A replay against the same immutable revision used the final critic prompt
  `75e4ce2c5fbcf521eed2f7aca5c2380131fcef796a58108a83d1699c6119d179` and completed in 244
  seconds. The strict verdict parser accepted its revision-bound 0.16 fail verdict; the artifact
  scanner projected 32 screenshots/motion frames, 8 copied references, 2 gameplay videos, and 8
  comparison pairs; the final message was exactly one fenced JSON object; and tracked source stayed
  byte-identical. The deliberately modest fixture failed the AAA quality threshold, which is the
  expected critic behavior rather than a calibration failure.

The successful Reference → Implement → final Critique path represents about $0.27 equivalent API
cost; all calibration attempts, including two diagnostic critic replays and one zero-usage
authentication failure, represent about $0.35 equivalent API cost using price table 2026-08-31.
The app-managed Codex profile lost authentication before critique, so the recorded critic replays
used a separately status-verified ChatGPT subscription profile; no API-key/provider-billed profile
was used. The final shared browser-rule edit was therefore calibrated by the recorded-run replay,
as PROMPT-001 permits, while the preceding live phases retain their original exact prompt hashes.
