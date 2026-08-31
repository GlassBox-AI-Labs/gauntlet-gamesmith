---
name: ship
description: Safely ship the current Gauntlet Loop workspace directly to origin/main. Use when the user invokes /ship or $ship, asks to ship or land local changes, or wants the guided test-sync-conflict-resolution-push workflow for this repository.
---

# Ship

Guide the user through integrating the current workspace with the latest remote `main`, validating it, and pushing it directly to `origin/main`. Treat invocation as authorization for the final non-force push. Give a concise update at each checkpoint and pause only for an ambiguous conflict, unexpected files, a failing gate that cannot be safely fixed, or an authentication/protected-branch error.

## Guardrails

- Preserve all user changes. Never reset, discard, overwrite, or automatically stash them.
- Never use force push, rebase published commits, amend existing commits, or check out another branch.
- Fetch and merge `origin/main`; do not use `git pull`. A Conductor workspace is a worktree whose local `main` may be checked out elsewhere or stale.
- Push only with `git push origin HEAD:main` after every gate passes.
- Do not stage secrets, `.context`, generated output, or unrelated files. Ask before including files whose intent is unclear.
- Resolve conflicts by understanding both sides. Never accept all of `ours` or `theirs` across the merge.
- Do not bypass hooks or weaken tests to make the ship pass.

## Workflow

### 1. Inspect and fetch

1. Confirm the repository root, current branch, `origin` URL, and target branch.
2. Run `git status --short --branch`, inspect staged, unstaged, and untracked changes, and run `git diff --check`.
3. Fetch without changing the working tree: `git fetch origin main`.
4. Review `git log --oneline origin/main..HEAD`, `git diff origin/main...HEAD`, and all uncommitted changes. Summarize exactly what will ship.
5. Stop if HEAD is detached, `origin/main` is missing, the remote is unexpected, conflict operations are already in progress, or suspicious/unrelated files need a user decision.

### 2. Commit the local work

1. If there are uncommitted intended changes, run the most focused relevant test first when practical.
2. Stage intended paths explicitly. Do not use a blanket stage until every untracked file has been inspected.
3. Create a normal commit with a concise message derived from the change. Do not alter Git identity or global configuration.
4. If there are no uncommitted changes, continue with the existing local commits. If there are neither changes nor local commits, still sync and validate, then report that there is nothing new to push.

### 3. Integrate latest main

1. Check whether `origin/main` is already an ancestor of `HEAD` with `git merge-base --is-ancestor origin/main HEAD`.
2. If not, run `git merge --no-edit origin/main`.
3. If conflicts occur:
   - List them with `git diff --name-only --diff-filter=U`.
   - Inspect the merge base, workspace side, and incoming `origin/main` side as needed. During this merge, `ours` is the workspace and `theirs` is `origin/main`.
   - Resolve each file manually so both changes' intent survives, remove every conflict marker, run focused tests, stage resolved paths, and finish the merge commit.
   - If the correct product behavior is genuinely ambiguous, leave the merge in progress and ask one focused question that explains the competing behaviors.
4. Report the merge result and any conflict decisions.

### 4. Run the project gates

Use the repository's pinned Node version and pnpm. If dependencies are unavailable, run `pnpm install --frozen-lockfile` and ensure it does not change the lockfile.

Run all three gates from the repository root:

```sh
pnpm test
pnpm typecheck
pnpm build
```

Diagnose failures, make minimal fixes, rerun the affected command, then rerun all three gates. Commit any fixes in a new commit. Do not proceed with a failing gate unless the user explicitly accepts the identified failure.

### 5. Close the race and push

1. Run `git status --short --branch` and `git diff --check`; require a clean working tree.
2. Fetch `origin/main` again. If it moved and is not an ancestor of `HEAD`, merge it as above and rerun all three project gates.
3. Record the candidate shipped SHA with `git rev-parse HEAD`. Show the user the commit range, gate results, and exact destination, then run `git push origin HEAD:main`. Invocation already authorizes this push; do not ask for redundant confirmation.
4. On a non-fast-forward rejection, fetch, integrate the new `origin/main`, rerun all gates, and retry. Never force push.
5. On an auth or protected-branch rejection, stop and report the exact blocker. Do not silently switch to a merge-request workflow.

### 6. Verify

1. Run `git fetch origin main`.
2. Verify the recorded shipped SHA is contained in `origin/main` with `git merge-base --is-ancestor <shipped-sha> origin/main`, and verify the working tree is clean. Exact tip equality is ideal but not required if another commit landed immediately afterward.
3. Report the shipped commit SHA, the successful gates, whether conflicts were resolved, and the verified `origin/main` state. Mention if `origin/main` advanced again after the push.
