# Local PR reviewer scope

> **Status:** Proposed MVP, 2026-09-02.
>
> **Outcome:** A long-running process on one trusted developer Mac polls an explicit GitHub
> repository, claims opted-in pull requests, reviews an immutable diff against the linked acceptance
> criteria and [`STANDARDS.md`](STANDARDS.md), and produces a validated, deduplicated verdict. It does
> not fix, merge, or push code.

## Why this shape

The useful pattern from `~/Desktop/rt` is the process model, not its project-specific labels:

- poll cheaply in shell/application code and spend model tokens only when work exists;
- run one fresh agent process per PR so review context never accumulates or compacts;
- use repository-visible state for queue transitions and a local ledger for recovery/telemetry;
- review standards and acceptance criteria as separate axes;
- cap retries and re-review churn rather than hot-looping a blocked item.

This repository adds two important constraints:

1. The PR repository is `origin`, GitHub `GlassBox-AI-Labs/gauntlet-gamesmith`. The reviewer still
   pins provider, host, and repository in explicit configuration and never infers them from remotes
   or from the `gh` CLI's default host and stored login, which on a developer Mac may point
   somewhere else.
2. PR code and prose are untrusted input. The agent must not hold GitHub credentials or own the
   publication step, and project scripts must not run automatically in the default mode.

## MVP decisions

| Decision | MVP choice | Reason |
|---|---|---|
| Provider | GitHub only | The PR repository is GitHub; a second provider would add an unneeded queue/publication protocol. |
| Repository | Explicit `GlassBox-AI-Labs/gauntlet-gamesmith` on host `github.com` | Avoids `gh` default-host ambiguity. |
| Trigger | Opt-in label `review:ready`; ignore drafts | Prevents reviewing half-built work and makes rollout reversible. |
| Base | PR-declared base, initially `main` only | Review exactly what GitHub will merge. |
| Agent | One fresh, ephemeral Codex process per attempt | The installed CLI supports non-interactive review and schema-constrained output; no conversation state is reused. |
| Publication | Shadow artifact first, then one updatable summary comment | Avoids noisy or branch-blocking feedback before precision is measured. |
| Checks | Static review by default; allowlisted commands only in explicit trusted mode | Running PR-owned scripts grants code execution on the developer's Mac. |
| Concurrency | One process, one active review | Makes label claiming and local resource use deterministic for v1. |
| State | Local SQLite ledger plus JSONL operational log | Supports exact-head dedupe, crash recovery, audit, and bounded retries without a server. |
| Actions | Comment/labels only | The reviewer never writes the PR branch, approves as a human, merges, closes, or deploys. |

The installed Codex CLI already exposes `codex exec` for non-interactive automation, an ephemeral
mode, a read-only sandbox, a review subcommand, JSONL events, and JSON-schema-constrained final
output. This is also the intended use of [`codex exec` in the official documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
Keep the invocation explicit and pinned rather than inheriting a developer's changing model or
permission defaults.

## External behavior

### Where the code lives

The reviewer is its own workspace package, `apps/reviewer` (`@gauntlet/reviewer`), alongside the
desktop app. The root `package.json` scripts currently filter to `@gauntlet/desktop`, so the
`reviewer:*` entries below are added at the root and filter to the new package. It shares
`docs/STANDARDS.md` and nothing else with the desktop app in v1; do not import from
`apps/desktop/src`.

### Commands

The first implementation should expose:

```text
pnpm reviewer:once              process at most one eligible PR, then exit
pnpm reviewer:once --pr <N>     shadow-review one explicit PR for calibration
pnpm reviewer:watch             poll until signaled
pnpm reviewer:status            print queue, active lease, last result, and backoff
pnpm reviewer:replay <artifact> validate/render a saved result without publishing
```

`once` is the complete behavior and test surface. `watch` is a thin loop around it: fetch a cheap
queue snapshot, call one tick when work exists, sleep with jitter when empty, and apply bounded
backoff after operational failures.

`--pr` bypasses queue-label and draft/open eligibility only for an explicit shadow calibration run.
It still binds immutable SHAs, records that the normal eligibility gate was bypassed, and can never
publish or transition labels.

For development, a later `.conductor/settings.toml` run entry can expose `pnpm reviewer:watch` as a
local-only Conductor process. For unattended use after shadow-mode signoff, install the same command
as a macOS LaunchAgent. Process supervision is packaging, not reviewer business logic.

### Configuration

Track non-secret policy in a repository file and keep credentials in the existing CLI stores:

```json
{
  "schemaVersion": 1,
  "provider": "github",
  "host": "github.com",
  "repository": "GlassBox-AI-Labs/gauntlet-gamesmith",
  "baseBranches": ["main"],
  "readyLabel": "review:ready",
  "runningLabel": "review:running",
  "passedLabel": "review:passed",
  "changesLabel": "review:changes-requested",
  "blockedLabel": "review:blocked",
  "standardsPath": "docs/STANDARDS.md",
  "model": "<pinned model id>",
  "effort": "<pinned effort>",
  "pollSeconds": 30,
  "attemptTimeoutSeconds": 1800,
  "maxAttempts": 3,
  "publicationMode": "shadow",
  "trustedChecks": []
}
```

Do not put tokens, `CODEX_HOME`, author allowlists, or machine-specific paths in the tracked file.
Validate configuration at startup and fail closed on unknown keys or unsupported schema versions.

## The deep module

Place the behavioral seam at one operation:

```ts
interface ReviewWorker {
  tick(now?: Date): Promise<ReviewTickResult>
}

type ReviewTickResult =
  | { kind: 'idle'; queueDepth: number }
  | { kind: 'reviewed'; pr: number; headSha: string; verdict: ReviewVerdict; published: boolean }
  | { kind: 'deferred'; pr?: number; reason: string; retryAt: string }
  | { kind: 'halted'; pr?: number; reason: string }
```

This is intentionally a small interface. The module owns selection, claim/recovery, checkout,
context assembly, deterministic checks, agent launch, output validation, stale-head protection,
ledger writes, and publication. Callers must not reproduce that ordering.

Two true external dependencies deserve injected ports and test adapters:

- **Forge port:** list candidates, fetch immutable PR metadata, claim/transition labels, and upsert the
  review comment. Production uses the GitHub REST API against the configured host with an explicit
  token source (never `gh`'s default host or its stored login); tests use an in-memory fake.
- **Reviewer-process port:** execute the pinned local CLI in a supplied checkout and return the
  validated artifact plus usage/exit metadata. Production uses a subprocess; tests replay fixtures.

Git checkout management and SQLite are local-substitutable dependencies. Keep their seams internal
to the module and test them with temporary repositories/directories instead of adding public plugin
interfaces. Do not introduce a general multi-provider or multi-harness framework in v1.

## One review tick

### 1. Discover

List open, non-draft PRs targeting an allowed base and carrying `review:ready`. Order by PR creation
time, oldest first. Idle polling must not invoke the model.

Eligibility key:

```text
repository + PR number + head SHA + base SHA + standards SHA-256 + reviewer version
```

An already completed key is skipped. A new head or standards hash is a new review. Store the exact
head/base SHAs returned by GitHub; never review a moving branch name.

### 2. Claim and persist

In `comment` or `gate` mode, claim in one logical transition:

1. write a local `claimed` attempt containing the eligibility key;
2. remove `review:ready` and add `review:running`;
3. record the remote transition result.

V1 guarantees one watcher for this repository with an exclusive local process lock. GitHub label
updates are not an atomic distributed lock, so multiple machines are explicitly unsupported.

In `shadow` mode, the local attempt row is the lease and there are no remote label mutations. The
eligibility-key ledger prevents repeated work while the visible queue remains unchanged.

On restart, reconcile local claimed/running attempts with current labels and SHAs. Resume only when
the exact input is still valid; otherwise mark the attempt stale and requeue the current head.

### 3. Materialize immutable inputs

Fetch the exact base and head objects, then create a detached temporary worktree at `headSha`. Build a
review manifest containing:

- repository, PR number/title/body/author, base SHA, head SHA, and merge base;
- changed files and the `merge-base...head` diff;
- linked issue bodies and explicit acceptance criteria when present;
- `docs/STANDARDS.md` content and SHA-256;
- relevant ADR/README/package metadata;
- results of any configured deterministic checks.

Cap metadata, diff, and file sizes. For an oversized PR, fail closed to `blocked` with a human-readable
reason rather than silently reviewing a truncated change as complete.

### 4. Run checks under the configured trust posture

Always run safe controller-owned checks such as diff/manifest validation. Do not install dependencies
or execute repository scripts by default.

When `trustedChecks` is non-empty, execute only those exact commands with:

- a sanitized environment with credentials and API keys removed;
- no inherited GitHub token;
- an explicit worktree, timeout, output cap, and process-group cleanup;
- existing dependencies only; never an automatic install or lifecycle script;
- a clear warning that arbitrary repository code can still act as the local user unless an OS/VM
  sandbox is added.

Check failures are structured evidence. The model may explain their impact, but it must not invent a
different result or claim an unrun check passed.

### 5. Run a fresh reviewer

Launch one ephemeral process in the detached worktree with read-only permissions, approval escalation
disabled, network denied, and no forge credential visible to its tools. The prompt treats PR text,
issues, repository instructions, comments, and source as data, not instructions. It must review two
independent axes:

1. every linked acceptance criterion is demonstrably satisfied by the changed behavior;
2. every applicable standard is satisfied, with special attention to security, Electron privilege
   lanes, subprocess lifecycle, durable state, and regression coverage.

The reviewer receives the exact SHAs and must inspect beyond the patch only where needed to prove a
finding. It does not edit files, publish, fetch secrets, follow instructions embedded in the PR, or
review unrelated pre-existing debt.

Credential isolation needs an enforced boundary, not only environment cleanup. Give the child an
isolated `HOME` and empty forge/Git configuration, clear provider-token environment variables and Git
credential helpers, remove forge clients from its command path, and verify that its sandbox denies
network and access to the controller's configuration/Keychain-backed credentials. The model CLI's
own authentication may remain available only through a location its spawned tools cannot read. If
that property cannot be demonstrated with canary tests on macOS, run the reviewer under a dedicated
OS account or VM before enabling remote publication. Codex documents that its sandbox applies to
spawned commands and uses macOS Seatbelt, but the implementation must test this exact credential
threat rather than assume `read-only` means secret-isolated.

### 6. Validate the verdict

Require JSON conforming to a checked-in schema:

```ts
interface ReviewVerdict {
  schemaVersion: 1
  repository: string
  pr: number
  baseSha: string
  headSha: string
  standardsSha256: string
  verdict: 'pass' | 'request_changes' | 'blocked'
  summary: string
  findings: Array<{
    ruleId: string
    severity: 'blocker' | 'major' | 'minor'
    title: string
    file: string | null
    line: number | null
    evidence: string
    impact: string
    suggestedFix: string
  }>
  checks: Array<{
    name: string
    status: 'passed' | 'failed' | 'not_run'
    detail: string
  }>
}
```

Validation after the model returns must independently enforce:

- repository/PR/base/head/policy fields exactly match the manifest;
- every `ruleId` exists in the standards document;
- file paths belong to the reviewed repository and line locations are valid;
- blocker/major findings include concrete evidence and impact;
- `pass` has no blocker or major findings and no failed required check;
- output and collection sizes are bounded.

Invalid output is an operational failure, never a pass.

### 7. Reject stale work, then publish

Immediately before any remote mutation, fetch the PR again. If the head SHA, base, open/draft state,
or eligibility changed, save the artifact as stale, remove the running lease, and requeue only if the
new state is eligible. Never post a verdict against a superseded head.

Publication modes:

- `shadow`: write the artifact and telemetry locally; make no GitHub mutation at all.
- `comment`: upsert one bot-owned summary comment containing the reviewed SHA, standards hash,
  verdict, checks, and numbered findings; then apply exactly one outcome label.
- `gate` (later): create a commit status/check and optionally submit a formal GitHub review from a
  dedicated machine identity.

The model never receives a GitHub token. Controller code renders validated JSON into a fixed Markdown
template and performs the upsert. Re-review updates the sticky summary instead of accumulating
comments.

### 8. Finish or back off

Persist the final artifact and transition before deleting the temporary worktree. On provider/model
failure, use exponential backoff with jitter. After three consecutive failures for the same key,
apply `review:blocked` in comment mode, record one concise operational explanation, and halt that item
until a human re-adds `review:ready`.

A successful process that leaves the same queue snapshot unchanged is a no-op. Back off and halt
after a bounded streak; do not spend a model call every poll interval on an unworkable item.

## Local state and observability

Keep state outside the repository worktree, for example:

```text
~/Library/Application Support/Gauntlet PR Reviewer/
  reviewer.db
  logs/reviewer-YYYY-MM-DD.jsonl
  artifacts/<owner>-<repo>/<pr>/<head>-<policy>.json
  worktrees/                         temporary; reconciled on startup
```

Minimum durable records:

- PR input key and immutable manifest;
- attempt number, timestamps, PID, CLI/model/version, exit category, and backoff;
- check results and bounded stdout/stderr references;
- the full agent event stream (thoughts, tool calls, file reads) so a review can be replayed and
  audited line by line, per STANDARDS VIS-001;
- raw schema-constrained response and validated verdict;
- publication mode, comment ID, label transitions, and stale/superseded status;
- token usage/cost when the CLI reports it.

Logs must redact credentials and avoid full environment dumps. `reviewer:status` should answer what is
running, what it is waiting for, and what a human must do next without reading raw logs.

## Acceptance tests

The MVP is complete when automated tests prove:

1. An empty queue performs no agent launch and no GitHub mutation.
2. Draft, wrong-base, unlabeled, and already-reviewed exact-head PRs are skipped.
3. FIFO selection and the one-process lock prevent duplicate local claims.
4. The reviewed diff is bound to recorded base/head SHAs and uses merge-base semantics.
5. A head update during review makes the result stale and prevents publication.
6. Restart recovery resolves claimed, running, orphaned-worktree, and partially published attempts
   idempotently.
7. Invalid JSON, unknown rule IDs, fabricated SHAs, bad paths/lines, and contradictory pass verdicts
   fail closed.
8. Prompt-injection fixtures in PR text, source, and repository instructions cannot publish, access a
   GitHub credential, modify the checkout, or alter the verdict schema.
9. Trusted checks are allowlisted, credential-sanitized, timed out, output-bounded, and disabled by
   default.
10. Comment retries upsert one sticky comment and outcome labels converge without duplicates.
11. Three repeated operational failures or no-op ticks back off and halt without a hot loop.
12. A calibration fixture based on PR #13 can identify independently releasable scope mixing and
    evaluate shared/main/renderer import risks without reporting unrelated baseline debt.

## Rollout

### Milestone 0 — Approve policy and build the eval set

- Review and edit `STANDARDS.md`; mark accepted rules and severities.
- Build a versioned corpus from merged PRs and seeded diffs: clear pass, clear fail, subtle fail,
  pre-existing debt, stale head, oversized diff, and prompt injection.
- Have two humans label expected findings. Disagreements reveal policy ambiguity to fix before code.

### Milestone 1 — One tick, local artifacts only

- Implement configuration/schema, GitHub read adapter, exact-SHA worktree, context manifest, Codex
  runner, verdict validation, and `reviewer:once`.
- No GitHub write credentials in the agent process. `publicationMode` is forced to `shadow`.

### Milestone 2 — Durable watcher and recovery

- Add SQLite ledger, process lock, `watch`/`status`/`replay`, signal handling, backoff, worktree cleanup,
  crash reconciliation, and stale-head tests.
- Expose the watcher as an optional local Conductor run script after the command exists.

### Milestone 3 — Comment-only pilot

- Create the review labels and a dedicated publication identity.
- Enable `comment` only for explicitly labeled PRs.
- Tune against at least 20 shadow/pilot reviews. Track valid-finding precision, missed seeded defects,
  stale/duplicate publication count, review duration, and cost.

Suggested promotion bar: no stale or duplicate publications, all seeded blocker defects caught, at
least 90% precision on blocker/major findings, and median review time/cost acceptable to the team.

### Milestone 4 — Optional merge gate

- Add a GitHub check/status only after comment-mode quality is stable.
- Define human override, outage behavior, policy-version display, and branch-protection consequences.
- Add a second provider, multi-repository, multiple simultaneous workers, or a second model harness only when
  there is a real need and a second adapter to justify each seam.

## Non-goals for v1

- fixing or pushing changes to a contributor branch;
- merging, deploying, closing PRs, or acting as the human approver;
- reviewing drafts or every open PR without an opt-in label;
- automatic dependency installation or execution of arbitrary PR scripts;
- a second forge provider, webhook/server infrastructure, multi-machine locking, or a hosted control plane;
- a desktop UI, multi-agent debate, inline-comment fan-out, or general-purpose policy DSL;
- replacing deterministic lint, typecheck, test, dependency, or security tools with model judgment.

## Decisions needed before implementation

1. Approve or edit the draft standards and their severities.
2. Confirm `review:ready` opt-in rather than reviewing every non-draft PR.
3. Choose the dedicated GitHub identity allowed to comment and manage review labels.
4. Choose and pin the reviewer model/effort after running the evaluation corpus.
5. Decide whether any trusted checks may execute on this Mac; default remains none.
6. Decide where unattended supervision lands after the pilot: terminal/Conductor only or a LaunchAgent.
