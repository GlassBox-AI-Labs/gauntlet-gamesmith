# Plan — Adding Grok Build as a third harness

Goal: Grok Build (`grok`, v1.0.13) becomes a harness the app can use for any of
the four roles — orchestrator, subagent, research, critic — alongside Claude
Code and Codex.

Everything here was verified by running the real CLI against a live
subscription account on 2026-09-02, not read from documentation — roughly a
dollar of test runs. All four open decisions are closed (section 5) and all
seven original unknowns are resolved (section 8); the three that remain are
listed at the end.

---

## 1. The headline: Grok speaks Claude Code's stream format

`--output-format streaming-messages-json` is documented as "NDJSON in the
Anthropic Messages API wire format". It is more than that. It is Claude Code's
own `stream-json` format, event for event and field for field:

```json
{"type":"system","subtype":"init","session_id":"…","apiKeySource":"oauth",
 "model":"grok-4.6","cwd":"…","permissionMode":"bypassPermissions","tools":[…]}

{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"grok-4.6",
 "content":[{"type":"thinking",…},{"type":"tool_use",…}],"stop_reason":"tool_use",
 "usage":{"input_tokens":129,"output_tokens":47,
          "cache_read_input_tokens":…,"cache_creation_input_tokens":0}},
 "parent_tool_use_id":null,"session_id":"…","uuid":"…"}

{"type":"user","message":{"role":"user","content":[{"type":"tool_result",…}]}}

{"type":"result","subtype":"success","is_error":false,"duration_ms":91948,
 "num_turns":3,"result":"DONE","total_cost_usd":0.053092,
 "usage":{…},"modelUsage":{"grok-4.6":{"inputTokens":17446,"outputTokens":132,
 "cacheReadInputTokens":34816,"costUSD":0.053092,"contextWindow":500000}}}
```

Those are the exact field names `readClaudeStream()` already reads, the
`parent_tool_use_id` the implement parser already uses for nesting, and the
`total_cost_usd` / `modelUsage[].costUSD` pair that `report.ts` already relies
on.

**This is the fact that shapes the whole plan.** Grok Build is not a third
bespoke parser the way OpenCode would be. It is mostly the Claude reader,
pointed at a different binary.

The compatibility is deliberate and goes further than the stream:

| Flag | Note |
|---|---|
| `--permission-mode` | `default, acceptEdits, auto, dontAsk, bypassPermissions, plan` — Claude Code's exact set |
| `--allow` / `--deny` | compat aliases `--allowedTools`, `--disallowedTools` |
| `--system-prompt-override` | compat alias `--system-prompt` |
| `--include-partial-messages` | same flag name and meaning |
| `-p`, `-r/--resume`, `-c/--continue` | same shapes |
| `grok import` | "Import sessions from Claude Code" |

Agent definitions are also the same shape: a `.md` file with YAML frontmatter,
discovered from `.grok/agents/` (project) or `~/.grok/agents/` (user). So
`implementerAgentMd()` largely ports rather than being rewritten.

---

## 2. Command-line mapping

| What the app needs | Claude Code | Codex | Grok Build |
|---|---|---|---|
| Non-interactive run | `-p` | `exec` | `-p` / `--single` |
| Machine-readable output | `--output-format stream-json` | `--json` | `--output-format streaming-messages-json` |
| Skip permission prompts | `--dangerously-skip-permissions` | `-s workspace-write` | `--always-approve` (or `--permission-mode bypassPermissions`) |
| Choose the model | `--model` | `-m` | `-m` |
| Reasoning effort | `--effort` | `-c model_reasoning_effort=` | `--reasoning-effort` (alias `--effort`) |
| Resume | `--resume <id>` | `exec resume <id>` | `-r/--resume`, `-c/--continue` |
| Per-app isolated login | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `GROK_HOME` |
| Cap the run | (idle timer) | (idle timer) | `--max-turns` |
| Turn off fan-out | n/a | n/a | `--no-subagents` |

`GROK_HOME` isolation was tested: pointing it at an empty directory produced a
completely fresh home with its own `config.toml`, `agent_id`, and `sessions`
tree, exactly the way `CLAUDE_CONFIG_DIR` behaves.

**Models and efforts are both queryable.** `grok models` lists two — `grok-4.6`
(default) and `grok-4.5`. There is no picker-size problem here; this is the
opposite of OpenCode's 384.

Efforts come from flag validation, and are **per model**:

```
$ grok -p "hi" --reasoning-effort bogus-xyz
--effort/--reasoning-effort: unknown effort level 'bogus-xyz';
use one of: xhigh, high, medium, low
```

Note what is missing: **`max` is not accepted for grok-4.6.** The app's shared
`AGENT_EFFORTS` list is `low, medium, high, xhigh, max`, so handing Grok the
shared list would offer an effort the CLI rejects. The bundled docs list a wider
space (`none, minimal, low, medium, high, xhigh, max`, plus per-model ids like
`deep`), which confirms the accepted set varies by model — the probe is the only
reliable source.

---

## 3. Accounting — and two traps that will bite

### Run totals are exact and free

Verified against xAI's published grok-4.6 rates ($2 input / $0.50 cached input /
$6 output per million, under 200k prompt tokens):

```
17446 × $2/M  +  34816 × $0.50/M  +  132 × $6/M  =  $0.053092
```

which is exactly the `total_cost_usd` the CLI reported. So **Grok needs no entry
in the app's price table.** It prices itself, correctly.

This also establishes the convention: in the `result` event, `input_tokens`
**excludes** the cached share, matching Claude Code.

### Subagent work is forwarded inline and already counted

A subagent test confirmed the delegated worker's messages appear in the parent
stream, and its tokens are inside the run totals. The arithmetic is exact — two
parent messages (inputs 8511 + 343, cache reads 128 + 8576, outputs 201 + 88)
sum precisely to the child session's own record.

**Trap 1: worker rows must split the run total, not add to it.** This is the
reverse of Codex and OpenCode, where worker spend was *missing* from the parent
and had to be added from a side channel. Reusing that instinct here silently
doubles every delegated run's cost.

### Attribution needs a disk join

`parent_tool_use_id` is **null on every event**, including the forwarded
subagent messages. This is the one place Grok's stream diverges from Claude
Code's in a way that matters: the app can see the work but cannot tell who did
it.

The identity lives on disk instead:

```
~/.grok/sessions/<url-encoded-cwd>/<parent-id>/subagents/<child-id>/meta.json
```

```json
{"subagent_id":"…","parent_session_id":"…","child_session_id":"…",
 "subagent_type":"general-purpose","description":"Create sub-out.txt MANGO",
 "status":"completed","started_at":"…","completed_at":"…","duration_ms":10565,
 "tool_calls":2,"turns":1,"effective_model_id":"grok-4.6"}
```

The child also gets a full sibling session directory whose `updates.jsonl`
carries a `turn_completed` event with exact usage and cost.

**Trap 2: the two surfaces use opposite token conventions.** In the child's
`updates.jsonl`, `inputTokens` **includes** the cached share — the opposite of
the `result` event. Verified:

```
(17558 − 8704) × $2/M + 8704 × $0.50/M + 289 × $6/M = $0.023794
                                    = costUsdTicks 237940000 ÷ 1e10
```

So `costUsdTicks ÷ 1e10 = USD`, and a reader of `updates.jsonl` must subtract
`cachedReadTokens` from `inputTokens` first — exactly the correction
`codexTokens()` already makes for Codex. Mixing the two conventions without
noticing overstates cost several-fold.

---

## 4. Grok inherits Claude Code's configuration — and this is a blocker

Verified with `grok inspect` run inside a workspace directory:

```
Project Instructions (1)
└ /Users/everscending/.claude/Claude.md (global) [claude]
Permissions
└ Source: /Users/everscending/.claude/settings.json (settings)
Skills (78)   Agents (3)   MCP Servers (2: railway, linear-server)
```

The bundled documentation states this plainly: *"Grok automatically discovers
configuration from Claude Code directories alongside native `.grok/` paths. No
extra setup is needed."* It picks up skills, agents, plugins, installed-plugin
manifests, marketplaces, MCP servers (`~/.claude.json`, `.mcp.json`), project
rules (`CLAUDE.md`), and permissions (`.claude/settings.json`). There are
matching discovery paths for Cursor and Codex.

Two problems for this app:

1. **Experiment contamination.** Claude Code rounds are isolated by
   `CLAUDE_CONFIG_DIR`. Grok rounds would inherit the operator's personal
   skills, rules, and permissions, which are uncontrolled variables in an
   experiment built for controlled comparison.
2. **Blast radius.** The app spawns with `--always-approve`. A Grok round would
   therefore have live, auto-approved MCP connections to whatever the operator
   has configured — Railway and Linear on this machine.

**`GROK_HOME` does not prevent it,** and neither do the eighteen
`GROK_{CLAUDE,CURSOR,CODEX}_{SKILLS,RULES,AGENTS,MCPS,HOOKS,SESSIONS}_ENABLED`
variables. Setting all of them, in both `0` and `false` forms, left skills at
58, agents at 3, MCP servers at 2, and permissions still sourced from
`~/.claude/settings.json`. Only the `CLAUDE.md` rules opt-out visibly took
effect (the entry gained a `[disabled]` marker). The likely remaining route is
`~/.claude/plugins/`, which has no blanket switch — only a per-plugin
`[plugins] disabled = [...]` list.

**The mitigation that works, tested:**

```
HOME=<throwaway dir>  GROK_HOME=<the app's isolated grok home>
```

Result: project instructions 0, permissions none, MCP servers 0, skills down to
22 built-ins, and the login still works (`grok inspect` reports the real
version, so it read the true grok home).

**Caveat:** `HOME` is load-bearing for git, and rounds record revisions. The
throwaway home needs a symlinked `.gitconfig` — or the app points `HOME` at a
prepared directory containing only that. Treat this as part of the spawn plan,
not an afterthought.

There is an upside in the same mechanism: Grok reads `.claude/agents/` as
subagent definitions, and the app already writes
`.claude/agents/implementer.md`. Project-scoped delegation may need no porting
at all — but only if the `HOME` override is scoped so that *project* `.claude/`
discovery survives while *user* `~/.claude/` discovery does not. Verify that
split before relying on it.

---

## 5. Decisions — all closed

| # | Decision | Outcome |
|---|---|---|
| A | Authentication | **Subscription, same as Claude and Codex.** `subscriptionEnv()` strips `XAI_API_KEY`; `harnessSpec('grok')` drives `grok login`. Record an ADR for the policy posture. |
| B | Harness/model split | **Do it now.** Roles store harness and model as a pair. `harnessFor()` survives only as a migration fallback inside `normalizeModels()`. |
| C | Sequencing | **Split and the Grok critic land together**, in one branch. The refactor needs a third harness to prove it; the critic is the smallest one. |
| D | Pre-implementation testing | **All seven unknowns resolved first.** Results in section 8. |
| E | Sandbox profile | **`--sandbox workspace`** — reads anywhere, writes only to the workspace, `/tmp` and `~/.grok`, network allowed. Matches the posture Codex rounds already run under, and bounds an autonomous loop to the directory it is building in. |

Decisions C and E compose: put the throwaway `HOME` directory (section 4)
**under `/tmp`**, which the `workspace` profile already permits writing to.
Everything the app needs to write — the run transcripts in
`<workspace>/.gauntlet-loop/`, the delegated-child stream files, and Grok's own
session tree — then falls inside an allowed path with no extra rules.

Watch for one failure mode: a build step that writes outside the workspace
(a global package cache, a tool that writes to the real home) will fail under
`workspace` in a way it would not under Claude Code's unrestricted rounds. That
is a difference in the experiment's conditions, so record it as a control
variable rather than quietly widening the profile when something breaks.

On decision B, the migration risk is smaller than first stated. There is exactly
one read path — `ledger.ts:242`, `normalizeModels(JSON.parse(row.models_json))`
— and the function already does this precise fallback for the critic:

```ts
criticHarness: raw.criticHarness ?? harnessFor(criticModel),
```

Three more fields get the same treatment. Finished runs are unaffected: costs,
tokens, verdicts and events live in the `runs` and `events` tables, and
`runs.harness` is its own stored column. The only path where a bad migration
does execution damage rather than cosmetic damage is `resumeLoop()`
(`loop-runner.ts:413`, `:440`, `:450`), which reads the harness to decide which
binary to spawn. Cover it with a test.

---

## 6. File-by-file change map

**Shared**

- `shared/harness.ts` — add `'grok'` to `harnessKinds`.
- `shared/models.ts` — the split (decision B): `ModelChoice` gains `harness`;
  `LoopModels` gains a harness per role; `resolveModels()` validates against the
  per-harness lists; `normalizeModels()` keeps `harnessFor()` as the fallback for
  old rows. Add `grok-4.6` and `grok-4.5`. Replace the shared `AGENT_EFFORTS`
  constant at its call sites with a per-harness lookup — **grok-4.6 rejects
  `max`**, so the shared list would offer an effort the CLI refuses.

**Main process**

- `main/harness-plans.ts` — add `grokArgs()`. The critique plan has no `-o`
  equivalent, so the verdict comes from the `result` event's `result` field.
- `main/harness-env.ts` — set `GROK_HOME`; add `XAI_API_KEY` to the strip list in
  `subscriptionEnv()`; **add the `HOME` override and its prepared directory**
  (section 4).
- `main/loop-runner.ts` — reuse the Claude implement parser. Two changes: the
  subagent-spawn tool is `spawn_subagent`, not `Agent`/`Task`; and the result
  event carries an `errors: []` array Claude Code does not have. Cancel uses
  SIGTERM and reconstructs totals from the streamed `assistant` events, because
  no `result` event arrives (section 8).
- `main/child-agents.ts` — widen the `<slug>.<harness>.jsonl` pattern to accept
  `grok`. **`readClaudeStream()` needs no changes** — Grok's field names match.
- `main/grok-usage.ts` — new, phase 3. Walks
  `sessions/<url-encoded-cwd>/<id>/subagents/` for per-worker rows. Must subtract
  `cachedReadTokens` from `inputTokens` and divide `costUsdTicks` by 1e10
  (section 3, trap 2).
- `main/delegation.ts` — add `grokChildCommand()`; add the Grok rows to the
  orchestrator/worker matrix; check whether `.claude/agents/implementer.md` is
  picked up as-is before porting it.
- `main/pricing.ts` — no new entries. Grok reports its own cost correctly.
- `main/ledger.ts` — `harness` is already `TEXT`; no migration. Two casts to
  `'claude' | 'codex'` become the shared type.
- `main/index.ts` — `harnessSpec()` gains a Grok entry (`grok models` doubles as
  a login probe: it prints "You are not authenticated." when signed out).

**Renderer**

- `views/AgentsView.tsx` — drive tabs from `harnessKinds`.
- `views/RunView.tsx` — model dropdowns become harness+model pairs; effort options
  come from the per-harness lookup. Only two new models, so no combobox needed.

---

## 7. Order of work

Work happens in the main clone. `/ship` creates the branch and pull request when
a phase is ready to land, so each phase below is one shippable change set.

1. **Split + Grok critic, together.** The refactor with its first consumer.
   Proves the reused parser, the spawn plan, and `total_cost_usd` reaching the
   ledger. Include the `resumeLoop()` migration test.
2. **Orchestrator and subagent, flat attribution.** Delegation rules,
   `--agents` model pinning, the `spawn_subagent` tool-name change. Worker
   spend is already correct in the run total; the agents view shows one combined
   row.
3. **Research, and per-worker attribution.** *(Done.)* Research reuses the
   delegated-child mechanism unchanged. `grok-usage.ts` joins
   `sessions/<url-encoded cwd>/<parent>/subagents/<child>/meta.json` to the
   child's own `updates.jsonl`, giving each worker its label, pinned model,
   status, tool count, token split and cost.

   Two things this phase had to get right:

   - **The rows split the run total, not add to it** (trap 1). A worker's share
     is subtracted from the orchestrator's row, so the two still sum to what the
     run spent, and `perModel` is left alone because the CLI's own `modelUsage`
     already covers the whole tree.
   - **Workers are listed once.** Grok's `spawn_subagent` call would otherwise
     seed an empty row from the stream alongside the real one from disk, so the
     spawn registry is skipped for grok orchestrators.

   Confirmed against a real run: the reader found the delegated worker, its
   pinned `grok-4.5`, `status: completed`, 2 tool calls, and $0.012264 — a figure
   that does *not* match grok-4.6's list prices, since grok-4.5 is priced
   differently. Another reason to take Grok's own cost rather than keep a table.
4. **OpenCode**, which is now much cheaper — the split is already paid for.

---

## 8. The seven unknowns — resolved

Tested against grok 1.0.13 on a live subscription account, roughly a dollar of
runs.

| # | Question | Answer |
|---|---|---|
| 1 | What does a failed run emit? | `{"subtype":"error_during_execution","is_error":true,"total_cost_usd":0.0,"errors":["…"]}`. **Real exit code is 1.** The `errors` array is new relative to Claude Code's format. |
| 2 | Is `--always-approve` enough for a real build? | Yes. Default sandbox profile is **`off`** — unrestricted — matching Claude Code's posture. Runs of 40 and 28 tool calls completed with no permission stalls. `--sandbox workspace` (write to CWD + `/tmp`, network allowed) is the Codex-equivalent if you want tighter. `~/.ssh`, `~/.aws`, `~/.gnupg` are protected under every profile. |
| 3 | Does resume work? | Yes. `--resume <id>` preserved context across processes (recalled a secret word from the prior run), **kept the same `session_id`**, exit 0. |
| 4 | Kill semantics? | **SIGTERM**: exit 143, no `result` event, work genuinely stops. **SIGINT: ignored** — sent at 45s, the run continued to completion at 104s and emitted a normal success result. There is no signal that yields a clean early result, unlike Claude Code. |
| 5 | Nested subagents? | One level records cleanly in `subagents/<child>/meta.json`. **Two levels were not observed** despite explicit instruction — the child made 28 tool calls and did the work itself. Whether Grok caps depth or the model declined is unresolved. One level is all the app's delegation model uses. |
| 6 | Is it slow? | No. 41 turns in 104s ≈ 2.5s per turn. The 92s first run was cold start, not representative. |
| 7 | Is `grok-build` a real model id? | **No** — `"unknown model id"`. Only `grok-4.6` and `grok-4.5`. The bundled docs' subagent examples are stale. |

### The three residuals — two resolved

**The `HOME` override scopes correctly.** Tested with a project-scoped
`.claude/agents/probe-agent.md` in the workspace:

| | Normal `HOME` | `HOME` overridden |
|---|---|---|
| Agents | 4 (3 builtin + `probe-agent` **project**) | 4 (3 builtin + `probe-agent` **project**) |
| Plugins | 3 | **0** |

Project-level `.claude/` discovery survives while user-level `~/.claude`
contamination is eliminated. So the app's existing
`.claude/agents/implementer.md` **is picked up by Grok for free** —
`implementerAgentMd()` needs no porting for the project-scoped case.

**`--max-turns` is the graceful-stop substitute.** When it trips it emits a
complete, costed result — unlike SIGTERM, which emits nothing:

```json
{"type":"result","subtype":"error_max_turns","is_error":true,
 "stop_reason":"cancelled","num_turns":3,"total_cost_usd":0.00837964,
 "usage":{…},"modelUsage":{…}}
```

Exit code 1, stderr `Error: max turns reached`. The `error_max_turns` subtype is
the same string Claude Code uses. Prefer a turn cap over a signal wherever the
app needs a bounded stop it can still cost.

**Still open:** whether nested subagent depth is capped by Grok or was a model
choice (#5). One level is all the app's delegation model uses, so this is not on
the critical path.

### One more finding: the reported model id drifts

Across six captured runs, the `system/init` event always reported the requested
`grok-4.6`, but the `modelUsage` key was `grok-4.6` on the two earliest runs and
`grok-4.6-build` on the four later ones — same flags, same account, same day.

```
msgs.jsonl      init_model=grok-4.6   modelUsage_key=grok-4.6
kill-INT.jsonl  init_model=grok-4.6   modelUsage_key=grok-4.6-build
```

**The key in `modelUsage` cannot be assumed to equal the model you asked for.**
`report.ts` builds its per-model breakdown from `modelUsage`, and
`RunMetrics.perModel` keys on model name, so an id that changes mid-session
would split one model across two rows and render a label
`AGENT_MODEL_CHOICES` does not know. Key the rollup on the reported id, label it
from the requested one. Cost is unaffected — Grok self-reports it.
