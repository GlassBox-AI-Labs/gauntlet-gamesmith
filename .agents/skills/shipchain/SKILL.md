---
name: shipchain
description: Ship the current Gauntlet Gamesmith workspace as a stacked feature branch and pull request, branching off whatever branch is checked out and staying on the new branch afterwards so further work builds on top of it. Use when the user invokes /shipchain or $shipchain, asks to ship a stacked or chained branch, or wants to keep shipping successive PRs without returning to main.
---

# Shipchain

Guide the user through committing the current workspace onto a new feature branch **stacked on the branch that is currently checked out**, validating it against the latest remote `main`, pushing that branch to `origin`, and opening a pull request. Treat invocation as authorization for the branch push and PR creation. Give a concise update at each checkpoint and pause only for an ambiguous conflict, unexpected files, a failing gate that cannot be safely fixed, or an authentication/permission error.

This is `/ship` with two deliberate differences:

1. **The new branch is always cut from the branch that is currently checked out**, never from the base branch. If that parent is itself an unmerged feature branch, this PR is stacked on it.
2. **The new branch stays checked out and is never deleted.** The workspace ends on it, so the next `/shipchain` stacks on top of this one.

## Guardrails

- Never commit to or push the base branch. All work lands on a new feature branch and reaches `main` only through the pull request.
- Preserve all user changes. Never reset, discard, overwrite, or automatically stash them.
- Never use force push, rebase published commits, or amend existing commits.
- Fetch and merge `origin/main`; do not use `git pull`. A Conductor workspace is a worktree whose local `main` may be checked out elsewhere or stale.
- Do not stage secrets, `.context`, generated output, or unrelated files. Ask before including files whose intent is unclear.
- Resolve conflicts by understanding both sides. Never accept all of `ours` or `theirs` across the merge.
- Do not bypass hooks or weaken tests to make the ship pass.
- Never delete the branch this run creates, and never switch away from it at the end.

## Workflow

### 1. Inspect and fetch

1. Confirm the repository root, current branch, `origin` URL, and base branch. Record the current branch as the **parent branch** — the new branch is cut from it and the PR may target it.
2. Run `git status --short --branch`, inspect staged, unstaged, and untracked changes, and run `git diff --check`.
3. Fetch without changing the working tree: `git fetch origin main`. If the parent branch is not the base branch, also fetch it: `git fetch origin <parent> || true` (it may not exist on `origin` yet).
4. Review `git log --oneline origin/main..HEAD`, `git diff origin/main...HEAD`, and all uncommitted changes. Summarize exactly what will ship, and say plainly which commits are inherited from the parent branch versus new in this one.
5. Stop if HEAD is detached, `origin/main` is missing, the remote is unexpected, conflict operations are already in progress, or suspicious/unrelated files need a user decision.

### 2. Create the stacked feature branch

1. Pick a short descriptive branch name derived from the change, kebab-case, prefixed by type (`feat/`, `fix/`, `chore/`, `docs/`). If that name already exists locally or on `origin`, add a short numeric suffix.
2. Create and switch to it with `git switch -c <branch>`, which cuts it from the parent branch at its current tip. Uncommitted changes carry over.
3. Always create the new branch, even when the parent is already a feature branch — stacking is the point of this skill. This step is required before any commit.

### 3. Commit the local work

1. If there are uncommitted intended changes, run the most focused relevant test first when practical.
2. Stage every intended modified and new file explicitly by path. Inspect each untracked file before staging it; skip anything covered by the guardrails above.
3. Create a normal commit with a concise message derived from the change. Do not alter Git identity or global configuration.
4. If there are no uncommitted changes, continue with the existing local commits. If there is nothing new relative to the parent branch, stop and report that there is nothing to ship.

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

### 6. Choose the PR base

- If the parent branch is the base branch (`main` unless the user named another), the PR base is the base branch.
- If the parent branch is a feature branch that exists on `origin` and still has an open pull request, set the PR base to the parent branch so this PR shows only the new work. Say so in one line, and note that GitHub retargets it to `main` when the parent merges.
- If the parent branch is a feature branch with no branch on `origin` and no open PR, fall back to the base branch and tell the user the PR will contain the parent's commits too.
- Honor an explicit base named by the user over all of the above.

Determine the parent's PR state with `gh pr list --head <parent> --state open --json number,url`.

### 7. Push the branch and open the PR

1. Run `git status --short --branch` and `git diff --check`; require a clean working tree.
2. Fetch `origin/main` again. If it moved and is not an ancestor of `HEAD`, merge it as above and rerun all three project gates.
3. Record the candidate SHA with `git rev-parse HEAD`. Show the user the commit range, gate results, branch name, parent branch, and chosen PR base, then push with `git push -u origin <branch>`. Invocation already authorizes this push; do not ask for redundant confirmation.
4. Open the pull request with `gh pr create --base <chosen base> --head <branch>`, a title derived from the change, and a body covering what changed, why, and the gate results. When the base is a parent feature branch, state in the body that this PR is stacked on that branch. If `gh` is unavailable or unauthenticated, stop and report the branch is pushed and the PR still needs creating, with the compare URL.
5. On a non-fast-forward rejection, fetch, integrate the new `origin/main`, rerun all gates, and retry. Never force push.
6. On an auth or permission rejection, stop and report the exact blocker.

### 8. Verify and stay on the branch

1. Run `git fetch origin <branch>` and confirm the recorded SHA is the tip of `origin/<branch>`.
2. Confirm the pull request exists with `gh pr view --json number,url,state,baseRefName`.
3. Confirm with `git status --short --branch` that the workspace is still on the new branch.
4. Report the branch name, parent branch, pushed SHA, PR number and URL, the PR base, the successful gates, and whether conflicts were resolved. Do not merge the PR unless the user asks.

**Do not clean up.** The new branch stays checked out and stays on disk so the next round of work stacks on it. Never switch back to the parent branch, and never run `git branch -d` or `git branch -D` on it.
