# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary of domain terms.
- **`docs/DECISIONS.md`**: this repo keeps all its ADRs (architecture decision records) in
  that single file rather than a `docs/adr/` folder. Read the entries that touch the area
  you're about to work in.
- **`docs/STANDARDS.md`**: the coding rules, each with a stable ID. Reviews cite them.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved. New durable decisions get appended to `docs/DECISIONS.md` (DOC-001).

## File structure

This is a single-context repo:

```
/
├── CONTEXT.md            ← domain glossary (created lazily by /domain-modeling)
├── docs/
│   ├── DECISIONS.md      ← all ADRs, appended in one file
│   └── STANDARDS.md      ← coding rules with stable IDs
└── apps/desktop/
```

If this ever grows into several genuinely separate domains, the multi-context layout is a
root `CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-002 (the rule against touching CLI credentials), but worth reopening because…_
