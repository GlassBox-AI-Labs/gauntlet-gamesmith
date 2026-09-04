# Standards audit — 2026-09-02

> **Historical snapshot.** The findings and line numbers below describe the pre-remediation tree.
> They are retained as the audit input, not as a list of current defects. See
> [`STANDARDS_AUDIT_RESOLUTION.md`](STANDARDS_AUDIT_RESOLUTION.md) for the implemented controls,
> regression coverage, verification, and remaining explicitly accepted limitations.

Whole-codebase gap audit of `apps/desktop/src` against every rule in [`STANDARDS.md`](STANDARDS.md).
Five read-only auditors covered the rule groups in parallel; the four Blockers were re-verified by
hand against the source. Tests were not run (no `node_modules` in this worktree). Line numbers are
from the current tree and will drift.

Because this is a full audit rather than a PR review, precedence rule 3 (existing debt is not a
finding) does not apply. Gaps the standards already record as known are marked **(known)**.

| Severity | Count |
|---|---|
| Blocker | 4 |
| Major | 46 |
| Minor | 31 |

## Blockers

1. **PROC-003 — a failed spawn stores pid -1 and later signals every process you own.**
   `main/loop-runner.ts:631` writes `pid: child.pid ?? -1`. `interruptPid` (`:479-490`) and
   `pidAlive` (`:470-477`) call `process.kill(pid, …)` with no check. On POSIX, pid -1 targets all
   processes the user may signal, and `kill(-1, 0)` succeeds, so the run never looks dead and the
   idle timeout eventually fires SIGINT, SIGTERM, SIGKILL at the whole session.
   Fix: if `child.pid` is undefined, mark the run failed and return; guard both helpers with
   `Number.isInteger(pid) && pid > 1`.

2. **SAFE-002 / CONT-001 — process metadata from the workspace is trusted unvalidated.**
   `readMeta` (`:496-502`) casts `.gauntlet-loop/runs/<runId>.json` to `ProcMeta`. On next launch
   `recoverAll` (`:331`) signals whatever pid it names and tails whatever absolute `outPath` it
   names into both ledgers and the UI. An imported folder with a `running` loop reaches this path
   because `importRunFolder` does not reject running state. Agents also write to this directory.
   Fix: validate shape, require `outPath`/`errPath` under `runsDir(workspaceDir)`, and on import
   downgrade `running`/`queued` rows to `interrupted`.

3. **SAFE-002 / PROC-001 — Play runs agent-written scripts with the operator's full environment.**
   `main/play.ts:52-59` picks `npm run dev|start|serve|preview` from the workspace `package.json`
   or `npx --yes vite`; `:84` spawns with `{ ...process.env }`, no timeout, no trusted-workspace
   gate, and it works on imported loops. Any API key or cloud token in the shell reaches AI-authored
   code. Fix: allowlisted env (or at least `subscriptionEnv` plus a KEY/TOKEN/SECRET strip), a hard
   timeout, and a per-loop trusted flag that imported loops do not get by default.

4. **VIS-001 — unknown harness events are silently dropped.**
   `streams/claude-stream.ts:102` and `streams/codex-stream.ts:58` end in a bare `return out` for
   any unhandled top-level type. Dropped today: Claude `rate_limit_event`, `stream_event`,
   `tool_progress`, `auth_status`, system subtypes other than `init`, content blocks
   `redacted_thinking`/`server_tool_use`/`web_search_tool_result`/`mcp_tool_use`, non-error
   `tool_result`; Codex `turn.started`, `item.started`, `item.updated`, top-level `error`,
   `mcp_tool_call`, `todo_list`. Non-JSON lines are also dropped (`:36-40`, `:18-22`).
   Fix: a terminal `else` on every branch emitting `system` with the raw kind and a 160-char
   excerpt.

## Major

### Process lifecycle (PROC-003)

- **PID reuse is not detected.** `recoverAll` (`:331`) and the kill escalation (`:488`) treat "some
  process has this pid" as "our agent". After a reboot the app re-attaches to a stranger and later
  kills it. Fix: record process start time or command name in `ProcMeta` and require a match.
- **Duplicate advancement during finalize.** `this.current = null` (`:752`) precedes
  `await parser.finalize` (`:754`), and implement finalize can block for hours in `awaitChildren`.
  In that window `stop()` takes the not-current branch and `resumeLoop` passes its guards, spawning
  a second implement for the same round. Fix: keep `current` (or a `finalizing` flag) set until
  finalize returns, in a `finally`.
- **Stop signals only the orchestrator.** `:482` kills a bare pid although the child was spawned
  detached and leads its own group; delegated `codex exec`/`claude -p` workers keep running and
  billing, and `finishImplement` (`:1468`) waits on them up to the 12 h cap even when the user
  stopped. Fix: signal `-pid` on the escalation steps; skip or cap `awaitChildren` when
  `stopRequested` or `timedOut`.
- **Meta is written after spawn and a failed write is swallowed.** `spawn` (`:615`) precedes
  `writeMeta` (`:632`), whose catch is `/* non-fatal */` (`:505-509`). A detached agent can exist
  with no recovery record; on restart it is requeued and two agents edit one workspace. Fix: write a
  placeholder before spawn, make `writeMeta` throw, kill the child and fail the run on write error.
- **`driveRun` has no `try/finally`.** `:654-756`. An exception from `onStderr` (`:708`),
  `tick` (`:724`), the tail `onLine` (`:750`), or `pumpChildStreams` leaves `current`/`childTail`
  set forever and blocks `start()` until restart. Fix: guard the interval body; clear both in
  `finally`.
- **Successor run loses child-stream tailing.** Each finalize calls `executeNext` synchronously
  (`:929`, `:948`, `:1539`, `:1873`, `:1916`), which sets `childTail` for the next run; the
  predecessor's epilogue (`:756`) then nulls it. Delegated-worker lines for the whole successor run
  are invisible until an app restart. Fix: only null `childTail` if it still belongs to this run.
- **Three exit paths skip fields.** Crash (`:587-591`) has no cost/duration; stream-open failure
  (`:611`) has no `finishedAt`; quit cancel (`:380`) has no duration and never accumulates the
  detached process's later tokens. Fix: one `terminate(run, status, error)` helper.

### Verdicts, revisions, reproducibility (PROC-004, CONT-002, PHASE-002)

- **Prose-first verdict with weak validation.** `:1819-1823` regex-extracts the JSON from the
  critic's final message and only falls back to `verdict.json`; `normalizeVerdict` (`:167-185`)
  accepts any object with a numeric `score`. A quoted example containing `"score"` can become the
  verdict. The prompt calls the file "a required protocol step". Fix: read and schema-validate the
  artifact first, require `pass` boolean, `summary` string, `findings` array; treat a missing or
  invalid artifact as a failed attempt.
- **Stale verdict from a previous attempt is accepted.** `:1821` bounds freshness by
  `loop.createdAt`, not the attempt's `startedAtMs` (in scope at `:1718`). With
  `MAX_CRITIQUE_ATTEMPTS = 2`, attempt 2 can inherit attempt 1's file. Three auditors flagged this
  independently. Fix: pass `startedAtMs`; add a `parse-verdict.test.ts` case.
- **Verdict is not bound to the reviewed revision.** The critique run never gets `revision`
  (`:1531-1537`, `:1835-1844`) and nothing checks the tree still matches the implement revision
  before pass or next-round (`:1895-1913`). Fix: copy the implement run's revision onto the
  critique run; before advancing, diff against it via `round-revision.ts` and log a stale-verdict
  line if it differs.
- **Reference/critique parsers do not dedupe usage.** `:845-851` and `:1753-1759` sum every
  `assistant` usage event although the same message id repeats while streaming (the implement
  parser dedupes at `:1222`). A timeout or stop persists the inflated tally and can trip the budget
  stop early. Fix: `Map<messageId, usage>` as in `child-agents.ts:53`.
- **CLI version is neither pinned nor recorded.** `index.ts:152-161` reads `--version` only for
  the Agents tab; `runs` has no column; the binary is whatever `PATH` resolves. Fix: detect once per
  run, persist `cli_version`, log a system line.
- **Run rows lack effort, CLI version, price-table version, cost source (known).**
  `ledger.ts:38-61`. `implementCostUsd` (`:62-70`) picks among three sources silently. Fix: four
  columns via the existing ALTER pattern; a `costSource` field on `RunRecord`.
- **Research workers' cost is never counted.** `makeReferenceParser` (`:818-836`, `:892-908`)
  never calls `readChildAgents`; their tokens bypass metrics, cost, and the budget ceiling.
- **Rate limits are terminal, contradicting ADR-002 §7.** Implement (`:1494-1502`) finishes the
  loop as stopped; reference (`:915-933`) and critique (`:1859-1878`) retry instantly with no
  backoff and burn the second attempt. Claude `rate_limit_event` is dropped (Blocker 4). Fix: detect
  in all three paths, log a pause line, bounded backoff, do not count against attempts.

### Resume and phase boundaries (PHASE-002, PROMPT-001, ARCH-004, LOG-001)

- **Resumed implement runs replace the whole prompt with an inline stub.** `:976-980` sends a
  one-sentence resume text in place of goal, reference rule, findings, and delegation rules, so
  correctness depends on `--resume`/`--continue` (`harness-plans.ts:114`) finding the right
  transcript. The stub lives in the runner, not `shared/prompts.ts`, is unpreviewable and untested,
  and the log records `run.prompt` (`:630`), which is not what ran. Four auditors flagged aspects of
  this. Fix: always send the full prompt prefixed by a `composeResumePreamble()` from
  `shared/prompts.ts`; log the effective prompt before spawn.
- **`lastImplementSessionId` is not round-scoped.** `:765-771` returns the newest implement
  session in the loop, so a requeued round n whose first attempt died before `init` resumes round
  n-1's session. `--continue` picks the newest session in the harness home, possibly another loop's
  (`:774-781`). Fix: filter by `run.round`; treat resume as best-effort only.
- **Implement prompt breaks the skeleton.** `shared/prompts.ts:36` concatenates the raw goal with
  no `<goal>` block and no role sentence; `:42-44` splices the critic's summary and findings straight
  under an imperative heading. Fix: role and boundary sentence (including never writing to
  `reference/` or `critique/`), `<goal>` block, findings inside a labelled data block; assert in
  `prompts.test.ts`.
- **Phase boundaries are prompt-enforced only.** Both CLIs have write access
  (`harness-plans.ts:67`, `:44-47`); the implement prompt never mentions `critique/`; the pack is
  scanned only at freeze (`:895`); nothing verifies the critic left source untouched. Fix: pack hash
  at freeze checked before implement/critique; post-critique diff against the revision.
- **Critic can read the implementer's raw transcript.** `.gauntlet-loop/runs/*.out.ndjson` and
  worker streams sit inside the workspace the critic inspects. Fix: at minimum tell the critic that
  `.gauntlet-loop/` is telemetry, not evidence; longer term move transcripts to `userData`.

### Visibility (VIS-001)

- **Previous round's child raw streams are deleted.** `:968-971` `rmSync(agentsDir)` at each
  implement start; nothing archives them and `round-revision.ts` excludes `.gauntlet-loop`. Fix:
  move to `.gauntlet-loop/agents/<previousRunId>/`.
- **Workflow (ultracode) agents are compressed to one line per minute.** `workflow-tail.ts:222-230`
  keeps only counts; `:1084-1090` throttles at 60 s and emits without `agentId`. Thoughts and tool
  calls never reach the log. Fix: translate each transcript line and log with the agent's id.
- **Delegated briefs are never logged.** `.gauntlet-loop/{codex,claude}-<slug>.md` is written by
  the agent and read by nobody in the app; no spawn line is emitted when a child stream appears
  (`child-tailer.ts:54-57`). Fix: on first sight of a stream, log the brief as a `prompt` event and
  a `spawn` event with `agentId`.
- **Codex command failures are shown as plain `$ cmd`.** `codex-stream.ts:37-38` ignores
  `exit_code` and `status`. Fix: push an `error` line on non-zero exit or `failed`.
- **No way to open raw streams from the UI.** `LoopApi` has no reveal method; grep for
  `showItemInFolder`/`openPath` is empty. Fix: `revealRunStream(runId, which)` constrained to
  `runsDir`/`agentsDir`, plus a button per run row and agent chip.
- **Parser exceptions are swallowed silently.** `:691-695` catches with no log line; a bad
  `result` line finalizes as "exited without a result" with no visible cause. Fix: log inside the
  catch.

### Storage and paths (DATA, SAFE)

- **`verdict_json` and `metrics_json` are cast, not validated.** `ledger.ts:263-264`. Import
  claims to "fail before registration" (`:579`) but only catches syntax errors; malformed rows
  crash `report.ts:131` and `loop:critique`. Fix: route through `normalizeVerdict` (move to
  `shared/`) and a new `normalizeMetrics`.
- **No migration test from the previous schema.** `ledger.test.ts` always starts empty. Fix: create
  the original DDL, insert rows, open `Ledger`, assert readback.
- **Events migration is one non-atomic `exec` behind a single column check.** `ledger.ts:144-146`.
  A crash after the first ALTER leaves `agent_id` present and `round/role/channel` missing forever;
  every event insert then fails. Fix: check each column, or wrap in a transaction.
- **Multi-row transitions are autocommits.** `requeueInterruptedRun` (`:621-635`), resume
  (`loop-runner.ts:395-398`), implement→critique (`:1516`, `:1531`), critique→next round
  (`:1906-1907`). Fix: `Ledger.transaction(fn)`.
- **Folder mirror is not resynced before export.** A full `syncWorkspaceFolder` runs only when the
  folder file is missing (`:336`, `:556`); a crash between app write and mirror write leaves the
  export permanently behind. Fix: always resync in `prepareRunFolder`.
- **`workspaceDir` is not canonicalized.** `loop-runner.ts:286-287` checks `isAbsolute` only.
  `/x/proj` and `/x/proj/` are different keys; the second's `syncWorkspaceFolder` runs
  `DELETE FROM …` (`ledger.ts:345`) and re-inserts only its own rows, wiping the first's folder
  history. Fix: resolve through the nearest existing ancestor (helper exists in
  `run-transfer.ts:26-36`).
- **Media server containment is a string prefix with no realpath.** `media-server.ts:37-42`. A
  symlink under `critique/` or `reference/` named `*.png` serves any readable file. Fix:
  `realpathSync` both sides, or `lstat` and refuse symlinks.
- **Git runs against a folder-shipped bare repo with inherited env.** `round-revision.ts:49-50`,
  `:102`. An imported `revisions.git/config` can carry `core.fsmonitor`/`core.hooksPath` that
  executes on the next `git add -A`. Fix: `-c core.fsmonitor=false -c core.hooksPath=/dev/null`.
- **No count cap on critique artifacts.** `report.ts:29-45` lists every round and every file;
  `CritiquePanel` renders one `<img>` each. Fix: cap rounds and entries; report truncation.

### Process arguments (PROC-001, PROC-002)

- **Slug grammar unenforced (known).** `child-agents.ts:97`, `child-tailer.ts:44`,
  `loop-runner.ts:1243` accept any filename. Fix: `([a-z0-9-]+)` in all three.
- **`quote()` is unexported and untested.** `delegation.ts:23-25`; `delegation.test.ts` has one
  quoting assertion. Fix: export and add the regression table PROC-002 requires.
- **Only three env vars are stripped.** `harness-env.ts:24-26`. `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK/VERTEX`,
  `OPENAI_BASE_URL` equally change the billing path. Fix: extend the list and PROC-001 together.
- **Translators throw on JSON `null`.** `claude-stream.ts:42`, `:58-59`; `child-tailer.ts:82` and
  `loop-runner.ts:750` call unguarded, feeding the `driveRun` gap above. Fix: object check after
  parse; `try/catch` in the tailer.

### Architecture and contracts (ARCH, CONT-001)

- **`loop-runner.ts` holds five control flows.** Stop/timeout/retry handling is repeated in three
  finalizers (`:909-914`, `:1487-1492`, `:1853-1858`); next-round creation appears six times;
  tests reach private parsers by cast. Concrete extractions: `main/verdict.ts`,
  `main/run-process.ts` (spawn/drive/meta/kill), `main/roles/{reference,implement,critique}.ts`
  parsers, `main/round-planner.ts` owning the transition table.
- **IPC handlers cast and coerce (known baseline).** `index.ts:294-308` for `loop:start`; every
  id handler uses `String(value)` (`:319-457`). Fix: `parseStartLoopInput` and an `assertId` helper.
- **Model ids duplicated outside `shared/models.ts`.** `DISPATCHER_MODEL` (`harness-plans.ts:170`)
  and `PRICES` keys (`pricing.ts:11-17`, with substring fallback at `:22`). Fix: define in shared;
  test that every choice has a price row.
- **`criticHarness` is a stored copy of a derived value.** `models.ts:196` prefers the stored
  field; `critiquePlan` branches on it while `implementPlan` derives. Fix: derive at call sites.

### Tests and checks (TEST-001, TEST-002, PHASE-001 step 11)

- **No CI.** No `.github/workflows`. Required checks exist only in prose. Fix: one workflow running
  install, typecheck, test on PRs and main.
- **The loop control flow is untested and its seams are not injectable.** `spawn` imported
  directly (`:1`, `:615`), 28 bare `Date.now()`, module-constant timeouts (`:43-50`). Untested:
  `start`, `recoverAll`, `resumeLoop`, `stop`, all three `execute*`, `driveRun`, `spawnDetached`,
  reference and critique stream parsers, `finishImplement`, `awaitChildren`, `overBudget`.
- **`subscriptionEnv` has no test** and reads `process.env` directly (`harness-env.ts:20-27`).
- **`index.ts` has zero tests**, including the two parsers that decide "logged in" (`:167-207`).
- **Security paths untested:** media-server token/traversal/Range, `play.ts` launch detection,
  `scanCritiqueArtifacts` traversal rejection, `copyRunFolder` rollback (`run-transfer.ts:61`).

### Documentation (DOC-001)

- **ADR-002 and ADR-003 contradict the code beyond what ADR-004 records.** Rate limit is a stop,
  not a pause (§7); no per-round account or machine attribution (§3); price-table version only in
  the report footer (§6); `node:sqlite` with `DELETE` journal for the mirror, not better-sqlite3 WAL;
  pack lives at `reference/<loop-id>/` with a sources manifest, not `userData/loops/…` with sha256.
  Fix: extend ADR-004 one bullet per item.

## Minor

- ARCH-003: `index.ts:94-289` grew a harness detect/probe/login subsystem; `loop:critique`
  hard-codes the `[critic]` log prefix from `loop-runner.ts:1761`. `RunView.tsx` is a 965-line
  component. Extract `harness-login.ts`, `RunForm.tsx`, `RunDetail.tsx`.
- ARCH-002: `loop:rename`, `loop:report`, `loop:critique` signal failure with `null`/`''`/`[]`
  (`index.ts:331`, `:346`, `:394`). Channel names are string literals on both sides with no shared
  constant. `claude auth status` JSON is cast (`:169`).
- ARCH-004 / CONT-001: reference-dir rule re-derived in four places (`RunView.tsx:617`,
  `reference-pack.ts:11`, `loop-runner.ts:279`, `index.ts:348`); `CLAUDE_CONFIG_DIR`/`CODEX_HOME`
  spelled at five sites; `PlayState & { loopId }` inline in three places; agent-id prefix
  conventions duplicated between `LogFilter.tsx:24-25` and main; `AgentsView.tsx:21` re-declares
  `LoginEvent`; harness labels repeated per view.
- PROC-002: git and probe/detect children get full inherited env and no explicit `cwd`
  (`round-revision.ts:50`, `index.ts:116-119`).
- PROC-001 vs VIS-001 conflict: workflow transcript prompts and results from inside the Claude
  harness home are persisted in `metrics_json` and exported (`workflow-tail.ts:264-266`). Either
  scope PROC-001's "do not expose its contents" to credential material, or keep these renderer-only.
- PROC-003: stream-open failure lacks `finishedAt` (`:611`); `stopForQuit` and the SIGTERM/SIGKILL
  escalation log nothing (`:376-382`, `:488-489`); `awaitChildren` logs "finished" when it gave up
  at the deadline (`:1015-1023`).
- PROC-004 / CONT-002: run ordering has no `rowid` tiebreak (`ledger.ts:472`, `:478`); reference
  and critique persist the configured model, not the CLI-reported one (`:801`, `:1703`); implement
  metric line omits the cost source (`:1659`).
- VIS-001: Codex-native subagent rows never report done (`codex-usage.ts:164-174`); native Claude
  subagent lines carry the label only in text, not `agentId` (`:1247-1249`); no Codex spawn-event
  test; empty-thought-channel UI message (known target); child stream read failures skipped silently
  (`child-tailer.ts:69-71`).
- DATA-003 / SAFE-002: import mutates the operator-opened file before validation
  (`ledger.ts:566-567`) and follows symlinks (`run-transfer.ts:68`); caps applied after whole-file
  reads and none on `pairs.json`, `verdict.json`, `package.json`, child streams
  (`reference-pack.ts:14-20`, `report.ts:48-54`, `:157-165`, `play.ts:52`, `child-agents.ts:129`);
  export destination not created atomically before the rollback `rm` (`run-transfer.ts:52-61`).
- PHASE-001: same-phase retries skip `overBudget` (`:918-930`, `:1863-1874`); reference and
  critique parsers expose no `progressAt`, so idle detection is a no-op for them (`:726`).
- PROMPT-001: sandbox sentence in three wordings (known); model ids and efforts written into
  informational prompt text (`delegation.ts:149`, `:169`); critic preview re-derives the reference
  dir and there is no implement preview before round 1 (`RunView.tsx:610-617`); contract tests do
  not assert the verdict JSON shape or `<goal>` tags.
- UI-002: evidence images are `<img onClick>` with empty alt; lightbox is a bare div with no
  Escape/focus handling; run-table rows expand on mouse only; project chooser lacks `aria-expanded`
  (`CritiquePanel.tsx:104`, `:145`; `RunView.tsx:267-306`, `:399-402`). Running state is a coloured
  dot alone (`RunView.tsx:196`, `:1307-1311`; `AgentsView.tsx:123`).
- UI-001: Resume is not guarded by `busy` (`RunView.tsx:1122-1132`); log empty state always says
  "Waiting for output…" (`:1424`); Refresh clickable during a probe (`AgentsView.tsx:152-158`).
- TEST-001: pure renderer logic lives in `components/LogFilter.tsx` and `RunView.tsx` rather than
  `lib/` with tests.
- DOC-001: `AGENTS.md:56` says "never SIGTERM" while PROC-003 allows bounded escalation; README
  pack list omits `research.md`, `journey.md`, `story.md`, journey shots; README's "no native deps"
  is true for SQLite but `node-pty` is native; HANDOFF has no superseded banner. No ADR for detached
  survive-quit agents, the Sonnet dispatcher, the Playwright sandbox rule, the all-runs permission
  posture, per-round bare-repo revisions, or "no critique on the last round".

## What is compliant

Renderer and shared lanes are clean (no Node or Electron imports anywhere). Window hardening is
correct. Preload is typed from the shared contract and every subscription returns and calls its
unsubscribe. Privileged inputs for harness, terminal, and play handlers are validated. All argv is
built in `harness-plans.ts` with no shell strings; every loop child gets an explicit cwd and a
plan-built env with the three API keys stripped; harness homes are 0700. SIGINT-first escalation,
session-id persistence, and byte-offset re-attach work. Both translators tolerate bad JSON and hold
partial lines; Codex cumulative usage is last-value-wins with a test. SQLite is main-only with bound
parameters; import and folder rebuild are transactional; export refuses running loops and import
rebinds only the workspace path. Path grammars for loop id, revision, refs, and harness kind are
narrow; destructive ops name exact targets. Log kinds all map to channels, prompts are logged per
run and chunked, lines are bounded, cost lines say "equiv", filters default to all channels and
survive updates, cross-harness children are tailed with ids and priced. Prompt bodies live in
`shared/prompts.ts` with contract-style tests; reference and critique wrap the goal in `<goal>`.
Tests use temp dirs and captured fixtures only.

## PHASE-001 matrix

| Step | reference | implement | critique |
|---|---|---|---|
| 1 Role, label, kinds | ✓ | ✓ | ✓ |
| 2 Prompt builder, delegation passed in | ✓ | partial: inline resume stub | ✓ |
| 3 Queueing incl. resume/recover, budget first | partial: retry skips budget | ✓ | partial: retry skips budget |
| 4 Execute + parser with progress | partial: no `progressAt` | ✓ | partial: no `progressAt` |
| 5 Owned artifact dir | ✓ | ✓ | ✓ |
| 6 Completion validated in main | ✓ | partial: exit + commit only | partial: stale bound wrong |
| 7 Retry semantics | ✓ | partial: resume drops prompt | partial: no audit of prior evidence |
| 8 Terminal states + cost | ✓ (crash path lacks cost) | ✓ (spawn-fail lacks finishedAt) | ✓ |
| 9 Renderer panel via capped IPC | ✓ | ✓ (row metrics) | ✓ |
| 10 Report | ✓ | ✓ | ✓ |
| 11 Tests: prompt / scanner / parser / resume | ✓ / ✓ / ✗ / ✗ | ✓ / ✓ / partial / ledger-only | ✓ / ✗ / partial / ✗ |
| 12 Docs | ✓ (README pack list short) | ✓ | ✓ |

## Suggested order of work

1. **Safety PR:** pid guard, `ProcMeta` validation and import downgrade, Play env allowlist and
   trusted flag, media-server realpath, git config overrides. Small, independent, all Blocker or
   high Major.
2. **Lifecycle PR:** `driveRun` try/finally, `current` held through finalize, process-group kill,
   meta-before-spawn, `childTail` ownership, PID identity check. Needs the injectable seams from the
   test PR to be testable, so land the seams first or together.
3. **Verdict PR:** artifact-first validation, attempt-scoped staleness, revision binding, usage
   dedupe in reference/critique parsers, rate-limit backoff.
4. **Visibility PR:** unknown-event fallthrough in both translators, JSON-null guard, Codex exit
   codes, brief logging, child-stream archiving instead of delete, workflow per-line events, raw
   stream reveal.
5. **Storage PR:** transaction helper, per-column migration, resync before export, workspace
   canonicalization, JSON normalizers, previous-schema test.
6. **Test and CI PR:** GitHub workflow, injectable `spawn`/`now`/timeouts, loop-runner role tests,
   `subscriptionEnv` and `quote` tests, media-server and rollback tests.
7. **Prompt PR:** implement prompt skeleton, resume preamble in shared, shared sandbox constant,
   critic `.gauntlet-loop` exclusion.
8. **Docs PR:** extend ADR-004, fix AGENTS.md SIGTERM wording, README pack list, HANDOFF banner.
