# Decisions

ADR-style log. Append, don't rewrite. Newest at the bottom.

---

## ADR-001 — Product baseline (2026-08-30)

**Status:** accepted.

- Electron + React + TypeScript desktop app; the daemon (loop executor) lives in the Electron main process — no separate service process for now.
- Harnesses in v1: Claude Code (`claude`) and Codex CLI (`codex`). Kimi later, API-key only.
- One-shot loops. No mid-run operator steering in the experiment path; if steering ships later it is a separately flagged feature, off by default, and rounds record whether it was used.
- The CLIs' own login flows and credential stores are used as-is: the app drives login through a PTY and reads status; it never reads, copies, or transmits tokens.
- Everything crossing IPC is a Zod schema in `packages/contracts`; types are inferred from schemas.

## ADR-002 — Policy and technical constraints (2026-08-30)

**Status:** accepted. Verified against Anthropic/OpenAI/Moonshot docs and terms on 2026-08-30 (links in HANDOFF.md §10).

1. Unmodified binaries, user's own login, on the user's own machine. Never call provider APIs with subscription OAuth tokens; never use the Agent SDK with subscription auth.
2. Never pass `--bare` to `claude -p` in subscription mode; pin the CLI version and pass flags explicitly.
3. Every round records which harness account and machine ran it (attribution / control variable).
4. `authMode: 'subscription' | 'api_key'` on every harness account from day one; an arm must be able to fail over to API key without changing anything that is hashed.
5. CLI cost figures are client-side estimates — label them "equivalent API cost" everywhere.
6. The dated price table is part of the loop config hash; its version is recorded on every round.
7. `rate_limit` is a retryable pause (with reset time when known), never a failure.
8. Kill child CLIs with SIGINT to get a result message; SIGTERM loses it. Persist the last good result per round.

## ADR-003 — Solo mode: defer team mode, SQLite replaces Supabase, no app auth (2026-08-30)

**Status:** accepted. Supersedes the multi-team architecture in the v1 handoff (git `eb39c79`).

**Context.** The v1 design used a shared Supabase project (Postgres + Auth + Realtime) as coordinator: teams, invites, a claimable job queue, RLS, and worker registration across teammates' machines. That bought parallelism and pooled rate-limit windows — not experiment correctness. The core experiment (same-family vs cross-family critic arms) runs fine on one machine with both CLIs signed in, and the multi-party coordinator was the largest ops burden and the riskiest policy surface.

**Decision.**
- **Team mode is deferred, not dead.** The daemon reaches storage only through thin ports (`LoopStore`, `JobQueue`, `EventLog`) defined in `packages/contracts`, so a remote-coordinator adapter can slot in later. Ports stay minimal — only what the daemon and IPC handlers actually call; no speculative multi-worker surface.
- **SQLite replaces Postgres/Supabase.** better-sqlite3, WAL mode, single connection in the Electron main process; versioned SQL migrations via `PRAGMA user_version`. Reference files live under `userData/loops/<id>/references/` with a sha256 manifest instead of Supabase Storage.
- **App-level auth is removed.** No Supabase Auth, no accounts. The only sign-ins are the harness CLIs themselves; identity/attribution is the local harness-account label plus the machine record.
- **Hash-spec compatibility.** `LoopConfig.schemaVersion: 1` and the canonical-JSON hash contain no team, user, or machine fields, so config fingerprints from solo mode remain comparable if team mode returns.
- **Dropped schemas:** `Team`, `TeamMember`, `TeamInvite`, `Worker`, `WorkerCapability` (a singleton `Machine` record keeps the control variables). `Job` loses `claimedBy`/`claimedAt` but keeps its status machine for restart/rate-limit resume. `Round.workerIds` becomes `Round.accounts` (harness-account attribution).
- **IPC:** `auth.*` and `team.*` channels removed; `worker.*` becomes `daemon.status` / `daemon.setPaused` / `daemon.onStatus`.
- **Milestones:** M1 = contracts + SQLite store; M2/M3 unchanged; M4 becomes the deferred team mode (coordinator adapter behind the ports).

**Consequences.**
- M1 shrinks ~30–40% (no Supabase migrations/RLS/RPCs, no auth or team UI) and there is no shared infrastructure to operate.
- Policy posture improves: everything is ordinary, individual usage on the user's own machine; no coordinator moves payloads between users' subscription-backed workers.
- A single subscription's 5-hour/weekly rate windows bound throughput; long experiments pause more. Mitigations already in the design: multiple local accounts per harness (one config dir each) and API-key failover per arm.
- Multi-machine throughput and pooled rate windows are unavailable until M4 is picked up.

## ADR-004 — Record drift between ADR-001/ADR-003 and the shipped code (2026-09-02)

**Status:** proposed. Documents what exists so `docs/STANDARDS.md` can treat the code as canonical
for these details without contradicting an accepted ADR.

**Context.** ADR-001 says everything crossing IPC is a Zod schema in `packages/contracts`, and
ADR-003 says SQLite migrations are versioned via `PRAGMA user_version`. Neither shipped. There is no
`packages/` directory and no Zod dependency; shared types live in `apps/desktop/src/shared` as plain
TypeScript, and IPC handlers in `apps/desktop/src/main/index.ts` validate ad hoc (see the baseline
note under ARCH-002 in `docs/STANDARDS.md`). The ledger in `apps/desktop/src/main/ledger.ts`
migrates by checking for missing columns and issuing `ALTER TABLE`.

**Decision.**
- The contract location is `apps/desktop/src/shared`. `packages/contracts` is not a requirement.
- Runtime validation of renderer input is still required (STANDARDS ARCH-002), but the mechanism is
  not prescribed. Adopting Zod or another schema library is a separate decision.
- Column-existence migrations are the current mechanism. Moving to `PRAGMA user_version` is
  acceptable but must migrate every existing app and folder ledger idempotently (STANDARDS DATA-002).
- The policy content of ADR-001 through ADR-003 (credential posture, kill semantics, cost labelling,
  hash compatibility, solo mode) is unchanged.

**Consequences.**
- Reviewers stop citing ADR-001/ADR-003 implementation details as findings.
- The IPC validation and migration mechanisms remain open items to be decided by their own ADRs when
  someone changes them.

## ADR-005 — Accept shipped local-run mechanics and reproducibility controls (2026-09-02)

**Status:** accepted. Accepts ADR-004 and supersedes conflicting implementation details in ADR-001
through ADR-003; their product and credential policies remain in force.

**Decision.**

- Shared TypeScript contracts and channel names live in `apps/desktop/src/shared`; bounded runtime
  validators in main enforce the IPC trust boundary without requiring Zod or a `packages/` workspace.
- The registry and portable mirror use built-in `node:sqlite`. The registry uses WAL; the independently
  copied folder mirror uses DELETE journaling. Idempotent, per-column migrations replace
  `PRAGMA user_version` and are tested from the prior schema. Import rejects hidden/generated
  columns before any integrity check or row query can evaluate them.
- A frozen pack lives at `reference/<loop-id>/` in the selected workspace. A manifest and pack
  fingerprint bind later phases to those inputs; this replaces the unshipped `userData/loops/...`
  storage and config-hash design.
- The app runs the installed stock CLI and records its exact reported version instead of modifying
  that binary. It resolves an absolute executable outside project/private roots, pins its device and
  inode for the app lifetime, revalidates that identity before use, and gives delegated workers only
  that exact path through app-constructed environment fields. Each attempt also records the exact
  execution-prompt SHA-256, model, effort,
  account label, machine label, authentication mode, price-table version, revision, and exact cost
  source. The current app-managed harness profiles use subscription mode; the schema reserves
  `api_key` for a future explicit account configuration.
- Provider rate limits interrupt the attempt, persist the reset/backoff time, and enqueue a bounded
  retry of the same role and round. They do not fail the loop.
- Primary CLIs run in validated detached process groups. On app quit the operator chooses whether
  they remain alive for recovery or receive SIGINT and the loop becomes stopped. Bounded escalation
  is allowed only while the recorded process identity still matches. The canonical registry owns
  the validated PID/start identity, overlap-advanced identities of captured process-group members,
  and original stdout/stderr file identities; workspace process
  metadata is a replay mirror and never sufficient authority to requeue or signal. A durable starting
  marker is written before direct spawn and canonical ownership immediately afterward. A crash in
  that narrow interval can leave an unowned CLI; recovery quarantines the attempt and forbids
  automatic requeue or Resume. Removing this accepted direct-spawn limitation requires a launch
  wrapper/handshake.
- Implement attempts create immutable bare Git revisions under the app-private user-data root, not
  inside the agent-writable workspace. The workspace contains no authoritative Git object/ref store;
  transferred histories remain read-only rather than promoting portable data into revision authority.
  A critic is bound to that revision and its verdict artifact; advancement fails closed if the
  workspace or artifact fingerprint is stale.
  Every path present at capture remains protected even inside an ignored build/dist directory, while
  a critic may create new output only where the captured project ignore policy already allows it.
- Claude-to-Codex orchestration uses the shared Sonnet dispatcher model only for delegated task
  routing. The selected worker model and effort are bound through the child argv, agent frontmatter,
  or reviewed harness environment as applicable; prompt text describes the same shared selection.
  Loop roles intentionally retain the stock CLIs' broad workspace permissions; browser automation
  must keep the shared sandbox rule and may inspect the frozen Reference Pack without mutating it.
- `maxRounds` counts implementation rounds. Completing the last allowed implementation exhausts the
  loop without launching one additional critic, so the round ceiling cannot silently create more
  billable work. Each completed implementation still has its immutable revision for inspection.
- Complete raw CLI streams remain portable under `.gauntlet-gamesmith/` for exact replay and are
  revealed only by ownership-checked IPC. Validated `.gauntlet-loop/` histories remain compatible
  through a fail-closed migration to the current name. When both names exist, the legacy tree is
  retained below the current directory before its old top-level name is removed. SQLite, reports, and renderer projections apply credential-shaped
  redaction; app code never opens credential files. The raw files themselves are deliberately not
  secret-scrubbed: a broad same-user CLI can read accessible data and may echo it, and discovering
  every such value would itself require reading forbidden credential stores. Export warns the
  operator to review unsanitized raw output before sharing. The critic is told that telemetry is not
  evidence, but same-user filesystem permissions are not claimed as a technical read barrier.
- The app-private registry is canonical and commits before a workspace mirror. A crash can therefore
  leave only a registered mirror-repair obligation; it cannot create an authoritative-looking orphan
  portable history before the registry knows that workspace. Startup and export rebuild mirrors by
  streaming canonical rows, and post-canonical mirror failures are durably visible.
- A locally created loop may launch its own project through Play with a stripped allowlist environment
  and a hard timeout. A fixed app-controlled wrapper holds the workspace command behind a private
  launch gate until main captures the wrapper's exact process-group identity. Verified membership is
  extended only across exact-member overlap, so late background descendants remain supervised if
  their launcher exits. Failure to capture ownership leaves the gate closed and bounded-kills only
  the directly returned wrapper handle, never an unverified numeric process group. A committed app
  quit waits for Play group settlement, while cancelling quit does not stop Play. Every imported folder is forced to untrusted
  and Play is denied. This release intentionally has no IPC or UI that can re-enable imported project
  scripts or resume imported loop execution; imported history is read-only. The schema that first
  records this provenance also treats
  every pre-provenance history as untrusted: older registry rows cannot prove whether they were local
  or imported, so the upgrade fails closed rather than guessing. Those histories remain inspectable,
  but Play, Resume, rename, and private-profile raw reveal require starting a new local loop.

**Consequences.**

- Portable history remains readable across additive schema changes and does not silently claim that
  old attempts used current provenance settings.
- The recorded version and immutable inputs make results reproducible without taking ownership of CLI
  installation or credentials.
- Re-enabling Play for an imported folder requires a separate, explicit trust-policy decision and UI.
- Restoring execution privileges to a pre-provenance history likewise requires a future explicit
  trust/re-attestation design; this release deliberately provides no automatic grandfathering.
- A stronger critic telemetry barrier would require an OS sandbox or separate account; moving files
  elsewhere under the same user does not create one.
- App-private revision storage removes the direct workspace-symlink path into Git refs and objects,
  but same-user permissions are not claimed as an OS isolation boundary.
- A credential-safe raw-export guarantee likewise requires a brokered process or OS/account boundary;
  projection redaction is defense in depth, not a claim that arbitrary CLI output contains no secret.
- Fully recovering or terminating a CLI after a crash between direct spawn and durable PID capture
  requires a future launch wrapper/handshake; quarantine prevents duplicate execution but cannot
  discover ownership that was never committed.

## ADR-006 — One project folder and distinct name per local run (2026-09-03)

**Status:** accepted.

**Context.** The Run form previously treated its selected path as the project itself and used that
folder's basename as the sidebar label. Starting another run could therefore reuse both the visible
name and physical workspace. Besides making histories indistinguishable, pre-provenance rows without
a registered workspace identity could block creation in that shared folder.

**Decision.** The Run form selects a parent runs folder. Each locally created run exclusively creates
a prompt-derived child directory beneath it, adding a numeric suffix when that name already exists.
The history title is independently derived from the prompt and similarly disambiguated. The sidebar
shows that stored title rather than deriving a label from the workspace path. Imported and historical
folders are not moved or split; their stored paths remain part of the preserved history.

**Consequences.** New runs do not share mutable project files or workspace identity. Repeating a
prompt produces distinct titles and sibling directories. Existing portable folders may still contain
multiple historical loops, so the ledger continues to read and mirror that older layout.

## ADR-007 — Safely adopt legacy workspace identities (2026-09-03)

**Status:** accepted.

**Context.** The workspace-identity migration added nullable device and inode columns so existing
registries could open, but left every prior local run unable to read its own critique/reference
artifacts. Blindly trusting whatever directory now occupies an old pathname would defeat the
identity boundary.

**Decision.** On startup, only untrusted rows with both identity fields absent are compatibility
candidates. The saved path must still be an exact canonical real directory outside protected roots.
Its portable ledger is copied through the verified import snapshot path, validated as inert bounded
SQLite, and required to match the canonical registry's loop IDs, paths, prompts, creation times, and
attempt IDs/owners/creation times. Only then does one transaction record the directory's current
device and inode, with the directory identity checked immediately before and after the update.
Missing, aliased, protected, malformed, or mismatched folders remain unbound and the failure is
recorded in each affected run log. The migration is idempotent and never changes `play_trusted`.

**Consequences.** Compatible local histories regain artifact viewing and mirror repair. Their Play,
raw-stream, rename, and Resume restrictions remain in force because legacy history stays untrusted.
A folder without matching portable provenance continues to fail closed and must be imported or
otherwise recovered explicitly.

## ADR-008 — Make delegated-worker exit observable (2026-09-03)

**Status:** accepted.

**Context.** Shell redirection creates a delegated worker's stream before its CLI process starts. A
CLI that failed during initialization therefore left an empty file with no terminal protocol event.
The app treated that absence as a live worker forever, and each app restart renewed the wait. Codex
researchers launched through a second Codex CLI were especially exposed because macOS can deny the
nested app-server initialization inside the orchestrator's existing sandbox. Model tier and effort
do not participate in that initialization failure.

**Decision.** A Codex reference orchestrator delegates Codex researchers through its native
`spawn_agent` capability, preserving the selected worker model and effort, instead of starting a
nested Codex app server. Cross-harness shell delegation remains supported. Its fixed wrapper creates
each stream with no-clobber semantics and appends a bounded, app-owned exit record after the child
process terminates. The child-stream module is the single interpreter of CLI terminal events, exit
records, and compatibility behavior. A pre-marker stream that is still empty after the two-minute
startup grace period is recorded as a failed launch and no longer blocks phase completion. The final
phase artifact is still validated independently before the loop advances.

**Consequences.** Failed child starts are attributed and visible in the run log and agent status,
rather than appearing as indefinitely waiting workers. Existing empty streams recover without
altering their raw evidence. Non-empty historical streams lacking both a terminal event and an exit
record continue to fail closed under the existing bounded deadline because their ownership cannot be
inferred safely. The app-owned exit line is retained in the raw child stream but excluded from CLI
translation and token accounting.

## ADR-009 — Allow Play while a loop is active (2026-09-03)

**Status:** accepted.

**Context.** Play previously rejected a trusted local workspace whenever any agent activity was
running there. That prevented the operator from inspecting and interacting with the game during the
long implementation and critique cycle, even though Play already owns and supervises only its own
process group.

**Decision.** A trusted local loop may start Play regardless of its loop status. Playing the current
workspace uses the live files and can therefore reflect partial edits or temporary build failures
while agents work. Playing a completed round continues to use its isolated immutable Git revision.
Workspace identity, protected-root, launch-command, environment, process-ownership, and imported
history trust checks remain unchanged.

**Consequences.** Operators can test the evolving game without stopping the agent loop. A live Play
server may reload during edits or fail until the current write becomes valid; this is expected and
is reported through the existing Play state. Play does not pause, stop, or otherwise take ownership
of agent processes.

## ADR-010 — Event-log-first observability (2026-09-03)

**Status:** accepted.

**Context.** VIS-001 requires complete operator visibility, but representing every new datum with a
standalone icon, badge, card, or toolbar action makes the default interface harder to scan. Raw
streams are the clearest case: they must remain reachable without filling attempt rows and agent
chips with file controls or projecting potentially sensitive byte-complete output into the log.

**Decision.** A new observability surface begins as a timestamped event-log entry and participates in
the log's existing round, agent, and channel filters. Promotion to persistent UI outside the log must
be justified by a distinct operator workflow, not merely by the existence of data. A log entry may
open a transient focused reader when the detail is too large or structured for an inline event. Raw
stream creation and delegated stream appearance follow this pattern; selecting their inline link
opens only the associated stream in the side drawer through bounded, ownership-checked IPC.

**Consequences.** The event log remains the default source of truth for behind-the-scenes activity,
while the surrounding UI stays compact. Focused readers remain discoverable at the time and source
where the event occurred. New permanent visibility controls require an explicit product rationale,
and raw transcript bytes retain their existing trust and credential-handling boundaries.

## ADR-011 — Activate desktop standards independently of automated review (2026-09-03)

**Status:** accepted.

**Context.** The standards were originally marked as draft until a local automated reviewer
completed shadow calibration. The desktop app and coding agents already rely on those rules, and
delaying reviewer implementation must not leave VIS-001 or the other desktop safeguards advisory.

**Decision.** `docs/STANDARDS.md` is active policy for human and agent-authored desktop changes now.
The proposed local PR reviewer remains deferred and its reviewer-specific enforcement details may
still be calibrated before implementation.

**Consequences.** Reviews cite and enforce stable rule IDs without waiting for reviewer automation.
Deferring `apps/reviewer` does not weaken desktop requirements or imply that a working reviewer
exists.

## ADR-012 — One-time scope exception for PR #24 (2026-09-03)

**Status:** accepted.

**Context.** PR #24 accumulated the initial standards audit remediation, compatibility work, and the
integration fixes required to keep current mainline behavior usable. Splitting the already-verified
batch now would add migration and regression risk while delaying the remediation.

**Decision.** PR #24 may bypass SCOPE-001 and land as one audit-remediation batch after its required
checks and review pass. This exception applies only to PR #24; it does not redefine coherent scope
or authorize similarly broad follow-up changes.

**Consequences.** Reviewers may evaluate PR #24 as an explicitly approved integration batch rather
than reject it solely for breadth. Subsequent work must again satisfy SCOPE-001 normally.

## ADR-016 — The CLI child keeps the user's real HOME (2026-09-05)

**Status:** accepted.

**Context.** `subscriptionEnv` rewrote `HOME` and `USERPROFILE` to the app-managed harness home
whenever one harness was selected. On macOS the Security framework locates the login keychain
through `HOME`, and Claude Code keeps its subscription credentials there. The rewritten home
contained no `Library/Keychains`, so signing in raised the macOS dialog "a default keychain could not
be found", whose primary button offers to reset the user's real login keychain — a destructive action
presented to a user who has done nothing wrong. Verified directly: `security default-keychain`
resolves under the real home and fails with `SecKeychainCopyDefault` under the rewritten one.

**Decision.** `HOME` and `USERPROFILE` are inherited from the parent process like the other
environment values the CLI needs. Account and app isolation comes from `CLAUDE_CONFIG_DIR` and
`CODEX_HOME`, which each CLI documents for exactly this purpose and which the app already sets.
Nothing else about the sanitized environment changes: billing and credential-routing variables are
still stripped, and `PATH` is still filtered against agent-writable roots.

**Consequences.** Sign-in can reach the credential store the CLI actually uses, and the app never
puts a keychain-reset prompt in front of a user. Isolation is unchanged in practice — Claude Code
namespaces its keychain entries per config directory, and a run with the app's config dir still
reports itself signed out while the user's own CLI login is untouched. The app continues never to
read, copy, or inspect any credential store (PROC-001). The harness home is no longer a boundary
against the CLI reading the real home; it never was one on macOS, where the credential store sits
outside `HOME` regardless.
