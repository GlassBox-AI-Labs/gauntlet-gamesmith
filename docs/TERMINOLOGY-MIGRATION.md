# Terminology migration — Build / round / phase attempt

**Status:** complete. PR 1 shipped and verified against the real registry ([#65](https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/pull/65)); PR 2 renames the code, UI and docs.

The word "run" meant two opposite things in this codebase. It was the whole job in the UI
(the sidebar's "Runs", `new-run-workspace.ts`, `ReportRunRow`) and it was a single attempt by a
single agent in the database (`RunRecord`, the `runs` table). `renderer/src/lib/run-pages.ts` (now
`build-pages.ts`) used both senses within four lines of each other. This document is the plan that removed that collision.

Progress markers below use `[ ]` not started, `[~]` in progress, `[x]` done.

## The vocabulary

A **build** is one job: one goal, one project folder, one budget, one final verdict.

A build runs in numbered **rounds**. Round 0 is the Reference Study; rounds 1..`maxRounds` are an
implementation followed by a critique.

A **phase** is one role within one round — the reference study, an implementation, a critique. A
phase is an identity, not a stored row: it is the pair (round, role).

A **phase attempt** is one execution of one phase. A retry produces a second attempt at the same
phase. Attempts are the rows that get stored.

So: build → rounds → phases → attempts.

### Decisions taken

- **`Build` is the top-level noun**, accepting that "build" already means "compile the game" in
  about 205 places, including agent prompt text and the `dist$|build$` file-exclusion pattern.
  Mitigation is a writing rule, not code: never use "build" as a bare noun for compilation in
  user-visible text — say "compile" or "game build" there.
- **`forging` was rejected.** It reads as *faked* in this codebase, where `forged-source.txt` and
  `forged-evidence.txt` are the evidence-tampering test fixtures. `forge/` is also a real directory
  inside the bundled img2threejs skill.
- **The row type is `PhaseAttempt`, not `PhaseRecord`.** One phase can have several attempts, so
  naming the row after the phase would recreate the same one-word-two-sizes problem we are fixing.
- **The short form is `attempt`**, not `phaseAttempt` — `attemptId`, `AttemptStatus`,
  `AttemptMetrics`, `events.attempt_id`. `phaseAttemptId` at 431 sites is noise, and the UI already
  says "3 attempts". The role type stays `PhaseRole`, because a role names the phase, not the
  attempt.
- **There is no `phases` table.** A phase is (build, round, role). Do not add one.
- **No stored *values* change.** Role strings, log `kind` values, and the `'running'` status
  literal all stay as they are. Only table, column, and identifier names move.

### The mapping

| Today | Becomes |
| --- | --- |
| `loops` table | `builds` |
| `runs` table | `phase_attempts` |
| `runs.loop_id`, `events.loop_id` | `build_id` |
| `events.run_id` | `attempt_id` |
| `idx_runs_loop` | `idx_attempts_build` |
| `idx_events_loop` | `idx_events_build` |
| `LoopRecord`, `LoopSnapshot`, `LoopStatus`, `LoopModels` | `BuildRecord`, `BuildSnapshot`, `BuildStatus`, `BuildModels` |
| `LoopLogLine`, `StartLoopInput` | `BuildLogLine`, `StartBuildInput` |
| `RunRecord` | `PhaseAttempt` |
| `RunStatus`, `RunMetrics` | `AttemptStatus`, `AttemptMetrics` |
| `RunRole` | `PhaseRole` |
| `loopId` (811 sites), `runId` (431 sites) | `buildId`, `attemptId` |
| `runPromptLabel` | `attemptPromptLabel` |
| IPC `loop:*`, `window.loops` | `build:*`, `window.builds` |
| `loop-runner.ts` | `build-runner.ts` |
| `run-transition.ts` | `attempt-transition.ts` |
| `new-run-workspace.ts` | `new-build-workspace.ts` |
| `run-transfer.ts`, `run-process.ts`, `run-attachments.ts` | `build-transfer.ts`, `attempt-process.ts`, `build-attachments.ts` |
| `run-pages.ts`, `run-visibility.ts` | `build-pages.ts`, `build-visibility.ts` |
| `run-presets.ts`, `run-timing.ts`, `run-context.ts` | `build-presets.ts`, `attempt-timing.ts`, `build-context.ts` |
| `ReportRunRow`, `ReportRoundRow` | `ReportBuildRow`, `ReportRoundRow` (unchanged) |
| `RunSidebar`, `RunView`, `RunForm`, `RunDetail`, `RunComposerDialog` | `Build*` equivalents |
| Sidebar "Runs", "+ Run", "New run" | "Builds", "+ Build", "New build" |

This rename brings the code in line with `STANDARDS.md`, which already calls these things phases
throughout PHASE-001 ("A phase is a role with a complete contract").

### Deliberately not renamed

- `.gauntlet-gamesmith/runs/` on disk, the per-attempt stream files inside it, and the
  `runsDev`/`runsIno` keys in the process-launch metadata (`run-process.ts`). Recovery reattaches to
  live child processes through those exact paths and identity fields. Renaming them risks orphaning
  a crash-recovered attempt and buys nothing a user sees.
- The word "loop" for the *process* — the reference → implement → critique → repeat cycle. `Build`
  is the noun for the record; the cycle is still a loop.

## PR 1 — database only

Renames the schema and migrates existing data. TypeScript type names are untouched; `ledger.ts`
already maps snake_case rows to camelCase through its `LoopRow`/`RunRow` interfaces, so this change
stays inside that file and its tests. This PR lands alone because it is the only part that can
destroy user data and the only part with real logic rather than mechanical renaming.

- [x] `SCHEMA` in `main/ledger.ts` declares `builds`, `phase_attempts`, and the renamed columns
      and indexes.
- [x] `initializeSchema` migrates an old database in place, guarded on the old table still
      existing so it is idempotent (DATA-002). It is the single seam: the same function initializes
      the app registry (WAL) and every project-folder mirror (DELETE). In practice only the registry
      has old rows to rename — a registered workspace's mirror is rebuilt from canonical rows rather
      than migrated — but the guard covers both. No startup sweep and no version table.
- [x] The migration writes one backup, `ledger.db.pre-build-rename`, before the first `ALTER`.
      It uses `VACUUM INTO` rather than a file copy, so the copy goes through SQLite and cannot
      catch a torn page in WAL mode. This is the only irreversible moment in the project.
- [x] `IMPORT_COLUMNS` and `validateImportSchema` accept **either** shape, so importing a project
      folder written by an older build still works.
- [x] Import migrates the temporary snapshot **after** validation passes, never before. The
      existing code deliberately refuses triggers and views before letting SQLite do real work on an
      untrusted file, and `ALTER TABLE` re-parses trigger bodies.
- [x] All SQL in `ledger.ts` uses the new names (114 `runs` references, 87 `loops`).
- [x] Row interfaces (`LoopRow`, `RunRow`, `EventRow`) use the new column names.
- [x] Tests: migrate a seeded pre-rename registry and assert every row, index, and the
      `process_ownership_json` that recovery depends on; reopen to prove the migration and its backup
      run once; import a pre-rename project folder end to end; reject a ledger holding both
      vocabularies. 931 tests pass.
- [x] `pnpm typecheck` and `pnpm test`.
- [x] Manual check against the real registry. The app was opened on the live
      `~/Library/Application Support/Gauntlet Gamesmith/ledger.db`; the migration ran and wrote
      `ledger.db.pre-build-rename`. Row counts match the backup exactly (11 builds, 32 attempts,
      12,162 events), `PRAGMA foreign_key_check` is clean, there are no orphaned attempts or events,
      SQLite rewrote the foreign key to `REFERENCES "builds"(id)` on its own, and no `loops` or
      `runs` table remains. The operator confirmed the history lists and opens normally. Export and
      re-import against real data were not separately exercised; they are covered by tests.

**Known one-way step.** A project folder migrated by this build will be rejected by an older build
of the app as an unsupported schema. Single user, forward-only; not worth building for.

## PR 2 — code, UI, and docs

One atomic commit. It cannot be split further: the renderer imports its types from `shared/`, so
renaming `LoopSnapshot` breaks the renderer in the same instant. Splitting would mean adding
throwaway type aliases whose only purpose is to be deleted.

- [x] `shared/` types, `main/`, `preload/`, and the file renames from the mapping table.
- [x] IPC channel strings and preload method names. Main and renderer ship in the same build, so no
      compatibility shim is needed.
- [x] `AgentMetric.phase` — **not renamed, deviating from this plan.** In practice the field
      carries either a role (`'reference'`, `'critique'`) or a workflow phase title, which is what
      this vocabulary now calls a phase. The feared collision is not real: it is the same concept at
      a finer grain. Renaming it would have needed a persisted-JSON fallback and would have
      mislabelled the role case.
- [x] `ReportRunRow` → `ReportBuildRow`; bump `REPORT_FILE_VERSION` to 2 and map `loopId` →
      `buildId` when reading a version 1 file. The reader already has legacy-kind handling for the
      old app name to copy.
- [x] Renderer components and user-visible strings.
- [x] The roughly 12 user-facing error strings that say "run" (`raw-streams.ts`, `play.ts`,
      `trust-ipc.ts`, `ledger.ts`, `new-run-workspace.ts`, `reports.ts`).
- [x] `ARCHITECTURE.md`, `STANDARDS.md` (the "Loop phases and prompts" section and PHASE-001 /
      PHASE-002 wording), `README.md`.
- [x] An ADR in `DECISIONS.md` recording the vocabulary, the accepted `build` dual meaning, and the
      one-way folder-ledger migration.
- [x] Verify no stale SQL names survive: `grep -n "loop_id\|run_id\|FROM runs\|FROM loops"` across
      `main/` returns only the migration and import-compatibility code.

77 test files reference these names.

### Folded in: the app's old name in operator-visible text

Separate from this vocabulary change, nine strings still called the app **Gauntlet Loop**, its name
before the Gamesmith rename: six Play error messages, one harness-status message, and the two
`Generated by ...; app-owned.` markers stamped into generated workspace files. They are now
**Gauntlet Gamesmith**, matching the report header, the round-revision git author, and onboarding.

The markers are safe to change because they are write-only — `markedContent()` prepends them and
nothing ever reads one back or compares against it, so files already on disk with the old stamp are
unaffected.

Still **Gauntlet Loop**, deliberately, because they name the former app: `LEGACY_APP_NAME` (which
finds the pre-rename user-data directory), `.gauntlet-loop`, `legacy-gauntlet-loop`,
`gauntlet-loop-report`, two comments describing pre-rename folders, and `HANDOFF.md`.

### Also deliberately unchanged

- **The Workflow tailers.** In `workflow-tail.ts` and `workflow-progress.ts` a "run" is a
  Workflow-tool run (`wf_*` transcript directories), an unrelated concept. Those files were excluded
  from the rename and keep `runId`, `runs`, and `runDir`.
- **Persisted app-rename strings.** `.gauntlet-loop`, `legacy-gauntlet-loop`, `gauntlet-loop-report`
  and the `-gauntlet-run` export folder suffix are values on disk from the app's former name. They
  are not part of this vocabulary and must not be renamed.
- **`pnpm dev:run-form` and `electron.run-form.config.ts`.** A dev-only prototype harness whose
  script names and build output paths would have to move together, for no operator-visible gain.

### Notes for the next reader

The identifier rename was driven by a script (`rename.py` in the session scratchpad) that rewrites
only code regions, leaving comments, strings and regex literals alone, with an explicit
classification of every `Run` identifier as build-sized or attempt-sized. Prose and user-visible
strings were then changed in a separate reviewed pass. Three tokenizer traps are worth knowing if
this is ever repeated: a regex literal containing a quote, a JSX closing tag or `/>` after `}`, and
the spread operator making `...run(` look like SQLite's `.run(`.

The larger risk was the second pass, not the first. A blunt word replacement over prose cannot tell
a noun from a verb, so it produced sentences that compile and pass every test while saying something
false — "its migration did not build", "the shell that builds the piped installer", "npm build build",
"How long an attempt has build". It also rewrote persisted values that happen to contain the word
(`.gauntlet-loop`, the `gauntlet-loop-report` marker) and flattened the attempt/build distinction in
about sixty comments and error strings. Every one of those was found by diffing each changed line
against its original and judging it, never by the test suite. If this is repeated, budget for that
review rather than for the rename.
