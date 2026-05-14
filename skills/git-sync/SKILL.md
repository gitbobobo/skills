---
name: git-sync
description: >
  Use when syncing git remotes, pulling changes, pushing local commits,
  resolving merge conflicts, or keeping local and remote branches consistent.
  Triggers on "sync", "pull", "push", "fetch", "remote", "merge conflict",
  "rebase", "fast-forward", or requests to align local with remote.
  Handles diverged histories, conflict resolution, and safe push workflows.
license: MIT
version: 0.1.0
category: devtools
tags: [git, sync, push, pull, remote, conflict-resolution]
recommended_skills:
  - git-commit
platforms:
  - claude-code
  - gemini-cli
  - openai-codex
maintainers: []
hooks:
  - type: PreToolUse
    matcher: Bash
    hook: |
      if echo "$TOOL_INPUT" | grep -qE "git push.*--force\b|git push.*-f\b"; then
        echo "BLOCK: Force push detected. Use --force-with-lease only after user confirmation, or prefer rebase/merge."
        exit 1
      fi
---

When this skill is activated, always start your first response with the 🔄 emoji.

# Git Sync

Synchronize local branches with their remotes safely. The goal is a consistent
state where local and remote match, achieved through inspection, integration,
and verification — never by discarding commits.

---

## When to use this skill

Trigger this skill when the user:
- Says "sync", "pull", "push", "fetch", or "remote"
- Mentions "merge conflict", "diverged", or "behind remote"
- Asks to align local with remote or vice versa
- Wants to update their branch with remote changes
- Requests to resolve conflicts after a pull or merge

Do NOT trigger this skill for:
- Committing local changes (use git-commit)
- Branching, rebasing for history rewriting, or cherry-picking
- General Git configuration or SSH key setup

---

## Key principles

1. **Inspect before act** — Always run `git fetch` and compare branches with
   `git log --graph --oneline --decorate --all` before merging or rebasing.
   Know what changed on both sides.

2. **Never discard commits** — `git reset --hard`, force-push, or blindly
   accepting "ours"/"theirs" destroys work. If diverged, understand the
   commit timeline and intent before choosing a resolution strategy.

3. **Resolve with context** — When conflicts occur, read the conflicting
   regions and the commit messages on both sides. The correct resolution
   often combines both changes, not just picking one.

4. **Verify consistency** — After sync, confirm local and remote point to the
   same commit: `git log --oneline -1` locally should match the remote HEAD.

---

## Common tasks

### Inspect remote status

Fetch silently, then visualize branch relationships:

```bash
git fetch
git log --graph --oneline --decorate --all -20
```

> Gotcha: `git pull` without inspection hides what changed on remote. Always
> fetch first and review the delta.

### Pull remote changes safely

For clean fast-forwards or simple merges:

```bash
git pull --ff-only
```

If the branch has local commits and you want a linear history:

```bash
git pull --rebase
```

> Gotcha: `--rebase` rewrites local commit hashes. If those commits were
> already pushed to remote, rebasing will require force-push. Prefer merge
> for shared branches.

### Resolve merge conflicts

When `git pull` or `git merge` stops with conflicts:

```bash
# See which files are in conflict
git status --porcelain

# See conflict markers in a file
grep -n "<<<<<<<" <file>

# After editing and removing markers
git add <file>
git commit -m "merge: integrate remote changes"
```

> Gotcha: Do not resolve by always choosing "ours" or "theirs". Read the
> commit messages with `git log --merge` to understand the intent of both
> sides before editing.

### Push local commits to remote

After confirming the local branch is ahead of remote:

```bash
git push origin <branch>
```

If remote has diverged, integrate first (pull/merge), then push:

```bash
git pull
git push origin <branch>
```

> Gotcha: Never `git push --force` on shared branches. If force-push is
> absolutely necessary, use `--force-with-lease` and confirm with the user
> first.

### Verify sync complete

Confirm local and remote are at the same commit:

```bash
git log --oneline -1
git log --oneline -1 origin/<branch>
```

Both should show the same hash. If not, the sync is incomplete.

---

## Anti-patterns / common mistakes

| Mistake | Why it's wrong | What to do instead |
|---|---|---|
| `git reset --hard` to fix diverge | Destroys local commits permanently | Rebase or merge after understanding the timeline |
| Always picking "ours" in conflict | May silently drop remote bug fixes | Read both sides, merge intent, test the result |
| `git push --force` on shared branches | Overwrites others' work, breaks CI | Use `--force-with-lease` only after confirmation |
| Pulling without fetching first | Misses visibility into what changed | `git fetch` + inspect before `git pull` |
| Ignoring conflict markers | Commits broken code with `<<<<<<<` | Resolve every conflict, then `git add` and commit |

---

## References

No additional reference files needed. This skill is self-contained.
