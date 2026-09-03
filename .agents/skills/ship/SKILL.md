---
name: ship
description: Safely ship the current Gauntlet Gamesmith workspace as a feature branch and pull request into the base branch. Use when the user invokes /ship or $ship, asks to ship or land local changes, or wants the guided test-sync-conflict-resolution-branch-PR workflow for this repository.
---

# Ship

Guide the user through committing the current workspace onto a new feature branch, validating it against the latest remote `main`, pushing that branch to `origin`, and opening a pull request into the base branch (`main` unless the user names another). Treat invocation as authorization for the branch push and PR creation. Give a concise update at each checkpoint and pause only for an ambiguous conflict, unexpected files, a failing gate that cannot be safely fixed, or an authentication/permission error.

## Guardrails

- Never commit to or push the base branch. All work lands on a new feature branch and reaches `main` only through the pull request.
- Preserve all user changes. Never reset, discard, overwrite, or automatically stash them.
- Never use force push, rebase published commits, or amend existing commits.
- Fetch and merge `origin/main`; do not use `git pull`. A Conductor workspace is a worktree whose local `main` may be checked out elsewhere or stale.
- Do not stage secrets, `.context`, generated output, or unrelated files. Ask before including files whose intent is unclear.
- Resolve conflicts by understanding both sides. Never accept all of `ours` or `theirs` across the merge.
- Do not bypass hooks or weaken tests to make the ship pass.

## Workflow

### 1. Inspect and fetch

1. Confirm the repository root, current branch, `origin` URL, and base branch.
2. Run `git status --short --branch`, inspect staged, unstaged, and untracked changes, and run `git diff --check`.
3. Fetch without changing the working tree: `git fetch origin main`.
4. Review `git log --oneline origin/main..HEAD`, `git diff origin/main...HEAD`, and all uncommitted changes. Summarize exactly what will ship.
5. Stop if HEAD is detached, `origin/main` is missing, the remote is unexpected, conflict operations are already in progress, or suspicious/unrelated files need a user decision.

### 2. Create the feature branch

1. Pick a short descriptive branch name derived from the change, kebab-case, prefixed by type (`feat/`, `fix/`, `chore/`, `docs/`). If that name already exists locally or on `origin`, add a short numeric suffix.
2. Create and switch to it with `git switch -c <branch>`. Uncommitted changes carry over. If the current branch is already a non-base feature branch that suits this work, keep it and say so.
3. Never do this step on the base branch itself — if HEAD is on `main`, the new branch is required before any commit.

### 3. Commit the local work

1. If there are uncommitted intended changes, run the most focused relevant test first when practical.
2. Stage every intended modified and new file explicitly by path. Inspect each untracked file before staging it; skip anything covered by the guardrails above.
3. Create a normal commit with a concise message derived from the change. Do not alter Git identity or global configuration.
4. If there are no uncommitted changes, continue with the existing local commits. If there are neither changes nor local commits ahead of `origin/main`, stop and report that there is nothing to ship.

### 4. Integrate latest main

1. Check whether `origin/main` is already an ancestor of `HEAD` with `git merge-base --is-ancestor origin/main HEAD`.
2. If not, run `git merge --no-edit origin/main`.
3. If conflicts occur:
   - List them with `git diff --name-only --diff-filter=U`.
   - Inspect the merge base, workspace side, and incoming `origin/main` side as needed. During this merge, `ours` is the workspace and `theirs` is `origin/main`.
   - Resolve each file manually so both changes' intent survives, remove every conflict marker, run focused tests, stage resolved paths, and finish the merge commit.
   - If the correct product behavior is genuinely ambiguous, leave the merge in progress and ask one focused question that explains the competing behaviors.
4. Report the merge result and any conflict decisions.

### 5. Run the project gates

Use the repository's pinned Node version and pnpm. If dependencies are unavailable, run `pnpm install --frozen-lockfile` and ensure it does not change the lockfile.

Run all three gates from the repository root:

```sh
pnpm test
pnpm typecheck
pnpm build
```

Diagnose failures, make minimal fixes, rerun the affected command, then rerun all three gates. Commit any fixes in a new commit. Do not proceed with a failing gate unless the user explicitly accepts the identified failure.

### 6. Push the branch and open the PR

1. Run `git status --short --branch` and `git diff --check`; require a clean working tree.
2. Fetch `origin/main` again. If it moved and is not an ancestor of `HEAD`, merge it as above and rerun all three project gates.
3. Record the candidate SHA with `git rev-parse HEAD`. Show the user the commit range, gate results, branch name, and base branch, then push with `git push -u origin <branch>`. Invocation already authorizes this push; do not ask for redundant confirmation.
4. Open the pull request with `gh pr create --base main --head <branch>`, a title derived from the change, and a body covering what changed, why, and the gate results. If `gh` is unavailable or unauthenticated, stop and report the branch is pushed and the PR still needs creating, with the compare URL.
5. On a non-fast-forward rejection, fetch, integrate the new `origin/main`, rerun all gates, and retry. Never force push.
6. On an auth or permission rejection, stop and report the exact blocker.

### 7. Verify

1. Run `git fetch origin <branch>` and confirm the recorded SHA is the tip of `origin/<branch>`.
2. Confirm the pull request exists with `gh pr view --json number,url,state,baseRefName`.
3. Report the branch name, pushed SHA, PR number and URL, the successful gates, and whether conflicts were resolved. Do not merge the PR unless the user asks.

### 8. Clean up the local branch

Only after step 7 confirms the branch is on `origin` and the PR exists:

1. Switch back to the branch the workspace started on with `git switch <original-branch>`.
2. Delete the local feature branch with `git branch -d <branch>`. The safe delete succeeds because the branch is fully merged into its pushed upstream.
3. Never use `git branch -D`. If the safe delete refuses, leave the branch in place and report why. The remote branch and the PR always stay.
