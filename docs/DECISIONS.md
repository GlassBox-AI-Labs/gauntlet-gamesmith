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

## ADR-013 — First-run setup flow gates the app on connecting an agent (2026-09-05)

**Status:** accepted.

**Context.** The app cannot run a single round without a signed-in Claude Code or Codex CLI, but
nothing said so before the Run tab failed. A new user landed on a run form whose start button could
not work, with the sign-in buried behind an Agents tab they had no reason to visit. The packaged
0.1.0 download made this worse: recipients have neither the repository nor its README.

**Decision.** First launch renders a four-step flow — welcome, connect, tour, ready — instead of the
Runs view. The connect step detects each CLI, drives its existing PTY login, and shows the
`npm install -g` command when a CLI is missing. The flow is skippable and never blocks: someone
without an agent may continue, and the step says plainly that runs cannot start until one is
connected. Completion is a flag in `onboarding.json` under the Electron user-data directory, read
over typed IPC (`onboarding:get`) before the first render. A missing, corrupt, or unwritable file
means the flow runs again, which is the safe direction to fail. **Show the tour again** on the
Agents tab resets it.

**Consequences.** The prerequisite is stated where it is discovered rather than in a README the
downloader never sees. Onboarding state is one boolean outside SQLite, so it stays readable before
the ledger opens and cannot corrupt run history. Detection, probing, and login-phase reduction now
live in one renderer hook shared by the setup flow and the Agents tab, so login states cannot drift
between them.

## ADR-014 — The app installs the harness CLIs with the vendors' native installers (2026-09-05)

**Status:** accepted.

**Context.** The first-run connect step told a new user to open a terminal and paste
`npm install -g …`, which is the exact task the flow exists to remove. It also required Node.js,
which the non-technical downloader of the packaged build is least likely to have, and a global npm
install fails with EACCES on system Node without sudo the app must never take.

**Decision.** On macOS and Linux the connect step runs each vendor's own native installer
(`https://claude.ai/install.sh | bash`, `https://chatgpt.com/codex/install.sh | sh`) in the same PTY
panel the login uses, with the exact command shown before and during the run. Neither installer
needs Node; both download a platform binary. The installer runs in a plain environment with the real
home — not the harness environment, which rewrites `HOME` and sets `CODEX_HOME` and
`CODEX_INSTALL_DIR`, and would install the CLI into app-private state. Windows offers no plan and
shows its documented PowerShell/CMD command to copy.

**Consequences.** A user with neither CLI can reach a working run without leaving the app or knowing
what a terminal is, and Node stops being a prerequisite for the agents (it is still needed to preview
a built game). Both installers place their launcher in `~/.local/bin` and append it to a shell
profile that an already-running GUI process never re-reads, so `resolveCliExecutable` now searches
that directory after `PATH`, under the same validation as every other candidate. The app executes
vendor-published scripts fetched at run time: the URLs are pinned constants, no user input reaches
the command line, and the output is shown in full rather than hidden.
## ADR-015 — Executable resolution guards agent-writable roots, not git checkouts (2026-09-05)

**Status:** accepted.

**Context.** `resolveCliExecutable` rejected any candidate whose directory sat under a `.git` marker,
to stop an agent that had planted an executable in the project it was building from being spawned as
the CLI. Homebrew's prefix is itself a git repository, so `/opt/homebrew/bin/claude` — installed by
the documented `brew install --cask claude-code` — was rejected, and the app reported Claude Code as
not installed on a machine where it was installed and working.

**Decision.** The guard now names the directories agents can actually write into: the app's private
roots, the folder new runs are created in, and every project folder in the ledger. A `.git` marker
says nothing about who can write to a directory, so it is no longer consulted. The run path already
passed `loop.workspaceDir` explicitly; a process-wide provider adds the rest so the protection holds
for resolutions that happen outside a run, such as detection during setup.

**Consequences.** CLIs installed by Homebrew, or by any other tool that ships its prefix as a git
checkout, are usable. A binary planted inside any run folder the app knows about is still refused,
and a provider failure falls back to the caller's own roots rather than making every CLI
unresolvable. Detection stops depending on how the user chose to install the CLI.
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

## ADR-017 — Explicit execution trust for existing run folders (2026-09-05)

**Status:** accepted. Supersedes ADR-005's lack of an existing-history execution trust control;
its credential, ownership, raw-stream, import, and revision protections remain in force.

**Decision.** Play and Resume offer a native main-process warning at the privileged action boundary.
It names the registered run and exact folder, explains local-user execution permissions, and uses
Cancel as both default and escape action. Confirmation is bound to the captured registry row,
workspace device/inode, matching inert portable history, and a bounded metadata fingerprint of the
folder. Main checks these before and after the dialog and rejects retained/unknown process ownership,
quarantine, protected roots, escaping/broken links, special files, or concurrent changes. Browsing
history never grants trust. The renderer captures the action's run ID and selection generation;
changing selection prevents continuation, including changing away and back.

An additive `execution_trusted` column defaults to false in both ledgers, and import always clears it.
Only explicit consent sets it through the canonical mirrored transaction and records a visible trust
event. Play and Resume accept local creation provenance or this local execution consent. The existing
`play_trusted` provenance stays unchanged, so consent does not unlock private transcript access or
rename, adopt portable CLI session IDs, or promote workspace Git objects into app-private revision
authority. Resume of an imported queued attempt creates a new attempt, and imported histories use
fresh CLI sessions. New local runs retain their behavior.

**Consequences.** Existing teammates' games can Play without creating another run or clicking twice.
Resume and historical-round Play still fail closed if an app-private revision or validated phase
artifact is unavailable. Trees above 200,000 entries require reducing the tree before consent. The
metadata fingerprint does not read project file contents or follow external links. This is explicit
folder trust, not an OS sandbox or a permanent content signature: later edits are permitted, and
same-user concurrent filesystem mutation cannot be made atomic with SQLite and process launch.
Registry-first crash/mirror recovery remains as in ADR-005; a reported persistence failure revokes
canonical execution consent, records the failure, and attempts mirror repair before returning.

## ADR-018 — Supplied context and explicit Reference Study modes (2026-09-05)

**Status:** accepted.

**Context.** The selected run composer must reflect real execution. User-supplied files belong to
the run's reference evidence, and skipping Reference Study must not launch a research agent.

**Decision.** Persist `referenceMode` in the existing models/configuration JSON. Missing values in
historical records retain the original web Reference Study. `web` studies the web and supplied
files; `files` queues one study of supplied evidence without researcher fan-out or web research;
`skip` queues implementation directly, including after recovery or an empty-history Resume.
Files-only study has a local-source artifact contract without downloaded-media quotas. Skip-mode
implementation and critique use the goal and supplied context without requiring an AAA pack.
Sculptor configuration is disabled in skip mode because it requires a studied reference cast.

Main snapshots selected files into bounded in-memory drafts, returning opaque IDs. At Create,
the snapshot is published under `reference/<loop-id>/supplied/` before queueing any agent. Its
manifest records original relative names, sizes, and SHA-256 hashes; its fingerprint is recorded
in both ledgers' event history and checked at phase boundaries, including Reference Study retries.
Supplied files remain untrusted evidence, not instructions or automatic redistribution permission.
The existing whole-project export includes them; no original machine path is needed for replay.
Folders are flattened into uniquely numbered files with original relative paths in the manifest.
No symlinks, hidden/credential files, generated dependency trees, or private app/CLI roots are read.
Limits are 100 files, 20 MB per file, 100 MB total, and 2,000 scanned entries per selected tree.

**Consequences.** Reloading before Create discards draft attachments; created runs retain their
copies even if originals move or change. Folder chips open the original selected directory in
Finder through an identity-checked main-process capability. No SQLite schema migration is needed:
the additive JSON policy field normalizes with the historical default. The reference mode is an
execution/prompt policy; it does not introduce an OS network sandbox around implementation tools.



## ADR-019 — Explicit delegation instead of Ultra for new runs (2026-09-05)

**Status:** accepted.

**Context.** Gauntlet prescribes phase execution, agent roles, worker models, and delegation.
The harness-specific `ultra` (Codex) and `ultracode` (Claude) efforts additionally enable
harness-managed automatic delegation/workflows. Offering them as simply higher reasoning
levels overlaps our orchestration policy and makes solo behavior harder to explain and control.

**Decision.** New runs offer only `low`, `medium`, `high`, `xhigh`, and `max` reasoning efforts.
Remove Ultra/Ultracode from the run composer and reject those values at the new-run IPC boundary.
Defaults and presets must never enable them; the Maximum preset uses `max`. Delegation remains
explicitly configured by the app. Solo means the orchestrator implements the code itself without
implementation subagents; reference researchers, critics, and sculptors have separate controls.

**Compatibility.** Preserve stored Ultra/Ultracode settings and their execution support when
reading or resuming existing runs. Do not migrate their historical configuration or reinterpret
past logs. When copying historical settings into a new-run draft, map `ultra` to `max` and
`ultracode` to `xhigh`, keeping reasoning effort without the automatic delegation mode.

**Visibility remains mandatory.** This decision removes a new-run configuration option; it does
not disable Workflow tools or remove their observability. Retain workflow transcript tailing,
progress and agent metrics, token/cost accounting, raw event visibility, and persisted offsets
and file identities for recovery. Observe workflows whenever they occur, regardless of the
selected effort. `roles/implement-claude.ts`, `workflow-tail.ts`, and `workflow-progress.ts`
remain necessary for historical runs and any workflow activity in ordinary-effort sessions.
Do not gate their collection on `isUltracode`; VIS-001 continues to apply.

**Consequences.** Keep legacy normalization separate from new-run validation and picker choices.
Teammates must not reintroduce these modes through defaults, presets, or new model support.
Tests cover rejected new-run inputs and unchanged historical normalization. Reintroducing
automatic harness orchestration requires a new product decision with explicit UI semantics.

## ADR-020 — Run-scoped conversational steering (2026-09-05)

**Status:** accepted.

**Decision.** Steering is an initially empty conversation in a collapsible right
sidebar at the run level. A separate, read-only Codex consult answers questions,
consolidates related feedback, and batches material clarification questions into
ordinary replies. Clear instructions queue without redundant confirmation;
questions and tentative ideas alone do not change requirements. Schema-validated
new directions must cite actual user messages, including the latest message.

Directions persist across rounds. Later directions supersede earlier conflicts;
undoing an included direction is another steer. Pending directions may be withdrawn.
At the first implementation dispatch, freeze the cumulative directions for that
logical round. Its critic and automatic retries receive the same immutable snapshot.
ADR-026 adds an explicit Resume boundary for pending directions.
Chat arriving after that boundary waits for the next implementation. No phase is
interrupted or injected with new chat. Chat never restarts a stopped/completed loop.
Historical implementations without a snapshot retain their original requirements.

**Storage and lifecycle.** Messages, directions, withdrawals, and requirement
snapshots are append-only events in the existing mirrored ledgers. Full event reads
are separate from truncated log projections. No schema migration is needed. Export
and import retain history, source IDs, snapshots, and consult attempts. Imported
history remains read-only until the existing run/folder trust flow grants execution.
Consults are excluded from phase scheduling, resume decisions, the rounds table,
and phase-attempt counts. Run-wide cost/token totals and the activity log still
include chat; table totals describe only its visible phase rows. The round attached
to a consult records when the conversation happened, not when steering was applied.
Each consult has
its own attempt, exact prompt/hash, raw streams, session ID, model, CLI version,
account/machine provenance, tokens, and equivalent API cost. Cancellation and quit
settlement supervise its own captured process group. Incomplete process ownership
quarantines chat; restart never automatically retries a conversation.

**V1 limits.** Uses the app's Codex profile at low effort, defaulting to gpt-5.6-sol; a Codex
connection is required even for Claude implementation runs. Conversations are bounded
at 250,000 prompt characters and 24,000 cumulative direction characters; reaching a
limit returns an explicit error rather than silently forgetting history. The frozen
reference pack is evidence, not something chat edits. A passed run does not gain an
automatic extra round. Supporting reference refreshes, larger conversations, or
in-flight phase injection requires a separate design.


## ADR-021 — Immutable attachments in run steering (2026-09-05)

**Status:** accepted.

**Decision.** Steering accepts files/images from the existing main-process picker
and validated drop bridge. The composer shows removable draft chips and image
previews; sent files remain on their message. Sending a file alone prompts for its
purpose rather than silently making it a requirement. The consult distinguishes
visual reference, a requested 3D sculpt, and direct use/replacement through normal
conversation. New directions cite both source messages and attachment IDs; the
main process verifies those relationships before accepting them.

Selection snapshots source bytes through the existing bounded attachment module.
Sending publishes immutable copies under `.gauntlet-gamesmith/steering/<loop-id>/`
with unique file IDs, original names, sizes, and SHA-256 hashes in mirrored message
events. The frozen Reference Pack is unchanged. File reads and previews are bound
to the selected run, verified workspace/directory identities, and recorded hashes.
Export/import preserves these files and their message references. Limits are ten
files per message, 20 MB per file, and 100 files/100 MB per run. Supported raster
images are supplied directly to the consult CLI; other files and earlier images
remain available at their recorded read-only workspace paths.

At implementation dispatch, the requirements snapshot includes only attachments
referenced by confirmed, non-withdrawn directions. The paired critic and retries
reuse the same snapshot. Verify the saved files at dispatch and completion; never
silently replace a missing or changed copy with today's original. Newly confirmed
asset requests join implementation's sculpting/integration work, with later
requests for the same target taking precedence. Direct replacements suppress
sculpting from the original cast. The first included round performs requested
asset work; later rounds retain the desired result without unconditionally
rebuilding it. No additional loop phase or consult table row is introduced.

## ADR-022 — Per-run steering model selection (2026-09-05)

**Status:** accepted.

**Decision.** The Steering composer offers the supported Codex models from the
shared model catalog. Selection is independent of implementation/critique models
and saved per run in mirrored `steering-model` events, including export/import.
Runs without a preference default to gpt-5.6-sol. Each consult captures its model
at admission for CLI dispatch, attempt provenance, and equivalent API cost.
Changing the selection during a reply applies to the next message. Selection
does not start an attempt, create a rounds-table row, or clear conversation history.
V1 remains on the app's Codex connection at low effort.



## ADR-026 — Explicit Resume includes pending steering (2026-09-06)

**Status:** accepted; refines ADR-020.

**Context.** Repeated implementation failures can keep an operator's directions
queued indefinitely when every retry inherits the first attempt's requirements.
The operator requested that saved steering reach implementation immediately.

**Decision.** Explicit Resume of a stopped or failed implementation includes
pending directions in its new attempt, without advancing the round number or
rewriting any historical prompt, snapshot, or result. Persist the cumulative
directions, attachment versions, and unfinished asset work before launch, and
record the inclusion in the steering conversation and run log. A retry with no
pending directions retains its previous requirements. Chat alone still does not
resume work or inject messages into a running process.

Automatic recovery retains the most recently frozen implementation snapshot.
Critique freezes the requirements of the successful implementation attempt it
judges, including when an explicit retry introduced steering in the same round.
Late messages remain queued; the original reference and evaluation criteria are
unchanged except where the operator explicitly steers them.

**Consequences.** Operators can stop, steer, and resume without waiting for a
whole round to succeed first. Historical attempts remain reproducible, and the
critic never evaluates against directions absent from its implementation.

## ADR-027 — Continuing implementation lead with integrated steering (2026-09-06)

**Status:** accepted.

**Decision.** New runs retain one implementation lead session across rounds, with
fresh independent research and critique sessions. Explicit Resume enables this
behavior for an existing run; historical attempts and automatic recovery of
unconverted runs keep their recorded behavior. Each implementation remains its
own supervised process, immutable prompt, requirement snapshot, accounting record,
and saved build. The app continues to own scheduling, process settlement, phase
gates, round/budget limits, and termination.

Before dispatch, persist the selected session, source attempt, continuation mode,
exact effective prompt, and Codex cumulative usage baseline. Only locally trusted
run history can authorize a private CLI session. Transferred runs recover from
portable memory in fresh sessions; folder trust does not adopt session IDs.
A CLI session lookup rejection before any observed agent work permits one fresh
recovery attempt with identical frozen requirements. Authentication, rate limits,
and failures after work retain their existing handling. Never search backwards
through unrelated or successively older sessions after a rejection. A CLI that
returns a different session ID is visibly treated as fresh, with fresh accounting.

Each implementation requests a bounded, attempt-bound notebook in its final reply:
plan, decisions, experiments, verification, and remaining work. Main validates it
and stores an append-only checkpoint in both ledgers. Missing or malformed notes
produce a visible warning and retain the attempt report and earlier notebook;
they never become a successful verification claim or erase raw events. Checkpoints
are saved at attempt completion, not continuously during work. The latest valid
notebook and latest report accompany the next implementation, including a resumed
session; they are untrusted working evidence subordinate to the current phase
protocol and frozen operator requirements. These events use the existing portable
schema, with bounded full reads separate from log projections.

Steering remains the separate read-only consult defined by ADR-020. It receives
the latest valid notebook and recent reports, explicitly speaks as the steering
assistant, and queues clear directions without redundant confirmation. ADR-026's
explicit Resume boundary still includes pending directions; automatic recovery
and critique inherit their implementation's exact snapshot. Newer requirements
explicitly supersede conflicting memories and prior conversation. Chat never
injects into a running phase or starts a stopped run.

The Run view shows the lead's current activity, whether its session continued or
was recovered, and a paginated notebook history for inspecting decisions before
steering. Attempts and full activity remain visible by round. This operator need
justifies a compact run-level notebook under VIS-001; there is no new dashboard.
Codex usage is cumulative for a resumed session: record the pre-launch baseline
and charge only its delta, preserving repeated raw completion events without
adding their usage twice. If no reliable baseline is available, use a fresh
session with memory and explain why. Claude workflow transcripts and summaries
are scoped to the current attempt so earlier workers are not charged again.

**Limits.** This is continuity across implementation turns, not an always-running
AI process or unlimited context. CLI compaction may still occur. Imported runs
use notebook recovery, and direct conversational turns with the implementation
lead remain a separate workflow change. The notebook does not alter critic inputs
or grant the lead authority to override an app stop condition.
