---
name: review-remediator
version: 0.1.0
description: >
  Use when verifying audit or review results and fixing confirmed issues.
  Triggers on "verify review results", "fix audit findings", "process review report",
  "remediate issues", "check review correctness", or when given any text-based review
  output to validate and fix. Handles code review, security audit, lint reports,
  and any plain-text or markdown review results. Reads the review text, checks
  referenced files to confirm issues, applies safe auto-fixes for small changes,
  and escalates large or risky changes for user confirmation.
license: MIT
category: engineering
tags: [code-review, audit, remediation, verification, fix]
recommended_skills: [git-commit, code-review-mastery]
platforms:
  - claude-code
  - gemini-cli
  - openai-codex
maintainers:
  - github: maddhruv
---

When this skill is activated, always start your first response with the 🔍 emoji.

# Review Remediator

Verifies the correctness of review or audit findings and fixes confirmed issues.
The user passes review results as plain text (markdown, bullet list, pasted log,
or any free-form text). The agent reads the text, identifies the issues mentioned,
cross-checks each against the actual source files, and applies targeted fixes.
Small fixes proceed automatically; large or risky changes require user confirmation.

This skill is agnostic to review type — it handles code reviews, security audits,
lint reports, accessibility checks, and any other text-based finding list.

---

## When to use this skill

This skill must ONLY be used when the user explicitly invokes or sends this skill. Do NOT proactively trigger this skill based on context or keyword matching.

---

## Core concepts

**Review text** is any plain-text or markdown content the user provides that
describes one or more issues. It may contain file paths, line numbers, severity
labels, code snippets, and suggestions — but none of these are required to be in
any strict format. The agent reads the text naturally and extracts what matters.

The **verification pipeline** has three stages:
1. **Read** — read the review text and identify each issue mentioned
2. **Verify** — open the referenced file(s) and confirm the issue exists
3. **Remediate** — apply the fix if verified; skip if the issue is a false positive

---

## Common tasks

### Read and understand the review text

Read the full text the user provides. Identify each distinct issue: what file is
mentioned, what the problem is, and what fix is suggested (if any). Treat the text
as free-form — do not require tables, headings, or rigid structure.

> **Gotcha:** Review text may reference files by partial path (`auth.ts` instead
> of `src/auth.ts`). Search the repo to resolve ambiguous paths before opening files.

### Verify an issue against source

Open the referenced file and read the relevant lines. Compare the actual code with
the issue description. If the code does not match the description, flag as a
**false positive** and skip it.

> **Gotcha:** Line numbers in review text are often stale (code changed since the
> review was written). If the referenced line looks wrong, check a few lines above
> and below. If the issue cannot be found nearby, flag as stale and skip.

### Apply a safe auto-fix

If the fix is small (roughly <= 5 lines changed) and low-risk (no logic deletion,
no auth/crypto/payment changes), apply it automatically and report what changed.

> **Gotcha:** Never auto-fix issues that:
> - Delete more than 10 lines of logic
> - Modify auth, crypto, payment, or secret-handling code without confirmation
> - Change public API signatures
> - Involve database schema or migration files

### Escalate large or risky fixes

If the fix is large or touches sensitive areas, present a plan and ask the user:

```markdown
**Issue verified:** Missing input validation in `src/auth.ts:42`
**Proposed fix:** Add Zod schema + rewrite the handler (~15 lines)
**Risk:** Medium — touches auth flow
**Shall I proceed?** (yes / no / show diff first)
```

> **Gotcha:** When in doubt, confirm. A 3-line change in a critical auth function
> is riskier than a 10-line refactor of a utility helper. Use judgment, not just
> line count.

### Generate a remediation summary

After processing all issues, output a concise summary:

```markdown
## Remediation Summary
| Issue | Status | Action |
|---|---|---|
| Unused import in src/utils.ts | Fixed | Removed `import lodash` |
| SQL injection in src/db.ts | Pending user | Proposed parameterized query |
| Missing type in src/api.ts | Skipped | False positive — type is inferred |
```

---

## Error handling

| Error | Cause | Resolution |
|---|---|---|
| `File not found` | Review references a moved/deleted file | Skip the issue; note it in the summary |
| `Line out of range` | Line number is stale | Check nearby lines; if still no match, flag as stale |
| `Ambiguous issue` | Description does not clearly map to code | Ask the user for clarification; do not guess |
| `Fix conflicts` | File changed since review was written | Re-read the file; if the issue is already gone, skip |
| `Permission denied` | Read-only or generated file | Report to user; do not attempt `chmod` or `sudo` |

---

## Memory & logging

Append each remediation session to `.agents/skills/review-remediator/log.jsonl`:

```json
{"date": "2025-05-14", "issues_total": 5, "verified": 4, "fixed": 3, "skipped": 1, "pending": 1}
```

This helps the user track how many findings are typically false positives and
which files recur as problem areas.
