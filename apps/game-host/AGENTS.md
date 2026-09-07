# Hosted game origin

Follow the repository instructions and `apps/web/AGENTS.md`. This Next.js project
serves validated game files only, on a separate origin from the catalog. It has
no publisher API, account UI, cookies, or renderer imports. Shared serving and
access policies live in `@gauntlet/data/api/game-server`; keep local and hosted
behavior consistent. Never cache responses past an access check or log preview URLs.
