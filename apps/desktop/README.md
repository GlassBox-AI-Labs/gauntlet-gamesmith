# Desktop harness login

The Electron desktop app drives the stock Claude Code and Codex login commands while keeping credentials entirely in each CLI's own store.

The current implementation covers CLI detection, login-status probing, an interactive PTY embedded in Electron, and a terminal-header indicator that resolves after a successful status probe. It does not read credential files.

Run the TypeScript development app from the repository root:

```sh
pnpm dev
```

Use Node 22 (`nvm use` will read the checked-in `.nvmrc`).

Useful commands:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start    # preview the production build
```

The desktop app uses Electron, React, TypeScript, electron-vite, Tailwind CSS, and shadcn/ui. Renderer components live under `src/renderer/src/components`; the typed preload API and shared harness contracts keep Node capabilities out of the renderer.

The app creates isolated CLI homes inside its user-data directory:

- `harnesses/claude`
- `harnesses/codex`

The CLIs own everything stored in those directories. The Electron app only starts their commands and reads their documented status output.
