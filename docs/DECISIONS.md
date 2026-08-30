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
