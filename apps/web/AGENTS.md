# Catalog conventions

Follow repository AGENTS.md and docs/STANDARDS.md. These conventions mirror the
Othram application architecture used for this feature:

- Web UI is exclusively public browsing/play. Only sign-in and desktop connection
  approval are browser utilities; release management belongs in Electron.
- Server Components read `@gauntlet/data` directly. Never fetch our own API routes.
- Browser forms use Server Actions with validated inputs and typed expected errors.
  Electron uses thin, individually named Route Handlers. Validate every body and
  authenticate mutations server-side; never trust client ownership or readiness.
- Domain operations live in `packages/data`, accept typed injected clients, and
  contain no Next.js/Electron imports. Use RPCs for multi-table transactions.
- Supabase server session, public anon, and privileged admin clients are separate.
  Validate identities with getUser. Privileged keys remain server-only.
- Database changes use idempotent migrations in `packages/db/supabase/migrations`.
  Regenerate schema.sql and types/supabase.ts; do not hand-edit generated types.
- Reuse `@gauntlet/ui` primitives and theme tokens. Shared UI imports no app internals,
  filesystem APIs, or framework-specific components. Avoid duplicate primitives,
  raw palette values, or renderer-to-web imports.
- Use static imports, feature-focused components, accessible labels, explicit
  loading/error/empty states, and stable data-testid values for user journeys.
- Report unexpected errors with sanitized context. Do not silently swallow them
  or log credentials, request bodies, signed upload URLs, or preview capabilities.
