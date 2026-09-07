# Catalog conventions

Follow repository AGENTS.md and docs/STANDARDS.md. These conventions mirror the
Othram application architecture used for this feature:

- Web UI is exclusively public browsing/play, with no account UI or auth cookies.
  Email/password sign-in and release management belong in Electron.
- Server Components read `@gauntlet/data` directly. Never fetch our own API routes.
- There are no browser account forms or Server Actions. Electron uses thin,
  individually named Route Handlers with typed expected errors. Validate every body and
  authenticate mutations server-side; never trust client ownership or readiness.
- Domain operations live in `packages/data`, accept typed injected clients, and
  contain no Next.js/Electron imports. Use RPCs for multi-table transactions.
- Supabase public anon and privileged admin clients are separate and stateless.
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
