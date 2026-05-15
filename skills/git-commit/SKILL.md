---
name: git-commit
description: >
  Use when the user wants to commit changes, stage files, save work to git,
  or clean up the working directory. Triggers on "commit", "提交", "save changes",
  "stage files", "git commit", or requests to prepare changes for version control.
  Handles selective staging, .gitignore updates, and keeping the workspace clean.
license: MIT
version: 0.1.0
category: devtools
tags: [git, commit, version-control, workflow, staging]
recommended_skills: []
platforms:
  - claude-code
  - gemini-cli
  - openai-codex
maintainers: []
---

When the user specifies or sends this skill, assume they want to commit by default.
When this skill is activated, always start your first response with the 📝 emoji.

# Git Commit

A disciplined local commit workflow. Ensures every commit is auditable,
relevant, and leaves the working directory in a clean state.

---

## When to use this skill

This skill must ONLY be used when the user explicitly invokes or sends this skill. Do NOT proactively trigger this skill based on context or keyword matching.

---

## Key principles

1. **Inspect before act** — Always run `git status --porcelain` first. Never
   assume what changed. Porcelain output is machine-readable and stable.

2. **Auditable granularity** — One commit per logical change. A commit should
   tell a story a reviewer can follow. Mixing unrelated changes in one commit
   makes bisect, revert, and cherry-pick painful.

3. **Clean workspace** — After committing, the working directory should be
   empty of uncommitted changes. Untracked files should either be committed,
   ignored, or intentionally left with a clear reason.

4. **Sensible ignores** — Generated files, secrets, and local environment
   artifacts belong in `.gitignore`, not in the repository.

5. **Self-directed decisions** — Do not ask the user; make decisions independently. Judge staging scope, commit splits, and message content based on the working directory state, project conventions, and best practices. Do not pause to ask the user.

---

## Common tasks

### Inspect working directory

Run `git status --porcelain` to get a stable, parseable view of changes.

```bash
git status --porcelain
```

Interpret the two-letter codes:
- ` M` / `M ` — modified (unstaged / staged)
- `??` — untracked
- `A ` — added to index
- `D ` / ` D` — deleted (staged / unstaged)
- `R ` — renamed

> Gotcha: `--porcelain` suppresses color and branch info. Use plain
> `git status` if the user wants a human-friendly summary.

### Stage and commit selectively

Stage files by logical unit, then commit with a clear message.

```bash
# Stage a specific logical group
git add src/auth/login.ts src/auth/login.test.ts

# Commit with a descriptive message
git commit -m "feat(auth): add passwordless login with OTP"
```

> Gotcha: Avoid `git add .` unless the user explicitly confirms. It stages
> everything indiscriminately, including files that may not belong in this
> commit.

### Commit message style

Before writing a commit message, check the project's existing style:

```bash
git log --oneline -n 10
```

- **If the repo has prior commits**, follow the established convention (e.g.,
  Conventional Commits, Gitmoji, or simple present-tense sentences).
- **If the repo has no history** (new repo, initial commit, or no prior commits),
  **default to Conventional Commits**:

  ```
  <type>(<scope>): <description>
  ```

  Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.
  Example: `feat(auth): add passwordless login with OTP`

### Update .gitignore for untracked files

When untracked files (`??`) should not be committed:

```bash
# Add patterns to .gitignore
echo ".env.local" >> .gitignore
echo "*.log" >> .gitignore
echo "dist/" >> .gitignore

# Stage the updated .gitignore
git add .gitignore
git commit -m "chore: ignore local env files and build output"
```

> Gotcha: Never commit files containing secrets (`.env`, API keys, tokens)
> or large generated artifacts (build output, lock files from other package
> managers). If unsure, ask the user before adding to `.gitignore`.

### Verify workspace is clean

After committing, confirm nothing is left behind:

```bash
git status --porcelain
```

If output is empty, the workspace is clean. If not, address remaining changes
or explain why they are intentionally left uncommitted.

---

## Anti-patterns / common mistakes

| Mistake | Why it's wrong | What to do instead |
|---|---|---|
| `git add .` by default | Stages unrelated, generated, or sensitive files | Stage files explicitly by logical unit |
| Vague commit messages | "update" or "fix" tells reviewers nothing | Use conventional commits or descriptive sentences |
| Committing secrets | `.env`, tokens, or keys in history are hard to remove | Add to `.gitignore` before they are tracked |
| Leaving untracked clutter | Working directory noise hides real changes | Commit, ignore, or delete untracked files |
| Giant single commits | Hard to review, revert, or cherry-pick | Split into focused, logical commits |

---

## References

No additional reference files needed. This skill is self-contained.
