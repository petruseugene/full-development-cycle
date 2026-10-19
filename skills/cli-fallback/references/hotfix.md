# Hotfix recipe — branch from release tag + cherry-pick forward

This recipe is invoked by the orchestrator when the user picks the **hotfix**
flow (see `${CLAUDE_PLUGIN_ROOT}/skills/playbook/references/lifecycle.md` §1c). It is the bugfix loop with two deltas:

1. The branch is cut from the **latest release tag**, not `main`.
2. After merge into the release line, the merge commit is **cherry-picked
   forward to `main`** so the next release does not regress the fix.

## Step 1 — Find the latest release tag

```sh
# Returns e.g. "v1.4.2" (GitHub releases, sorted by created_at desc).
LATEST_TAG=$(gh release view --json tagName --jq '.tagName')

# Fallback if gh releases are not used (pure git tag, semver-sorted):
# LATEST_TAG=$(git tag --sort=-v:refname | head -n1)
```

Sanity-check the value before using it (must be non-empty and match a
real tag):

```sh
git rev-parse --verify "refs/tags/${LATEST_TAG}" >/dev/null
```

## Step 2 — Cut the hotfix branch from the tag

```sh
git fetch --tags origin
git switch --create "hotfix/<slug>" "refs/tags/${LATEST_TAG}"
```

Push with upstream when you are ready:

```sh
git push --set-upstream origin "hotfix/<slug>"
```

## Step 3 — Open the PR against the release line

Open the PR against the release branch (or the tag's branch) — **not**
against `main`. If the project does not maintain a long-lived release
branch, open against the tag itself by creating a short-lived release
branch from the tag and merging into that:

```sh
gh pr create --base "release/<minor-line>" --head "hotfix/<slug>" \
  --title "fix: <subject>" --body-file pr-body.md
```

## Step 4 — After merge, cherry-pick forward to `main`

```sh
# Get the merge commit SHA from the merged PR.
MERGE_SHA=$(gh pr view <pr-number> --json mergeCommit --jq '.mergeCommit.oid')

git switch main
git pull --ff-only origin main
git switch --create "chore/cherry-pick-${MERGE_SHA:0:7}-to-main"
git cherry-pick -x "${MERGE_SHA}"
```

`-x` records the original SHA in the cherry-pick commit message for
traceability.

Push and open the forward-port PR:

```sh
git push --set-upstream origin "chore/cherry-pick-${MERGE_SHA:0:7}-to-main"
gh pr create --base main \
  --title "chore: forward-port hotfix ${MERGE_SHA:0:7} to main" \
  --body "Forward-port of merged hotfix PR #<pr-number>."
```

## Step 5 — Conflict escalation

If `git cherry-pick` reports conflicts, **do not auto-resolve**. The
release line has diverged from `main` and resolution requires human
judgement.

```sh
# Abort and surface the conflict to the user.
git cherry-pick --abort
```

Then return a `BLOCKED` report with:

- the failing paths (output of `git status --porcelain` before the abort),
- the source merge SHA and target branch,
- a one-line recommendation that the user resolve manually with
  `git cherry-pick -x <sha>` followed by `git cherry-pick --continue`.

The orchestrator escalates to the user with this report; it does not
retry on its own.

## Safety reminders

- Never `--force` push a hotfix branch once it has been pushed.
- Never skip hooks (`--no-verify`) on either the hotfix commit or the
  forward-port commit.
- Delete the local hotfix branch only after both the release-line PR
  **and** the forward-port PR are merged.
