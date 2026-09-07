---
name: git-add-partial-failure
description: Use when a shell script batches multiple files into a single `git add A B C` and the following `git commit` unexpectedly reports "no changes added to commit" despite the files clearly being modified — `git add` aborts entirely if any pathspec in the list does not match a working-tree file, so nothing at all gets staged. The failure is silent when stderr is suppressed with `2>/dev/null`.
---

# `git add` Aborts Entirely On Any Missing Pathspec

`git add A B C` treats the file list atomically. If any of A/B/C does not exist as a pathspec (typo, stale expectation, wrong lockfile extension), the whole `git add` fails and **nothing gets staged** — not even the files that DO exist. If you're piping stderr to `/dev/null` and chaining with a bare newline (not `&&`), the shell keeps going and the next `git commit` finds an empty index. The commit reports "no changes added to commit" and lists the still-modified files, which reads like the modifications weren't detected.

## The specific bug

Ran in a bash loop iterating over multiple repos, adding + committing dep-pin changes:

```bash
for repo in ...; do
  cd "$repo"
  git status --short
  git add package.json bun.lock bun.lockb 2>/dev/null   # bun.lockb doesn't exist in modern bun
  git -c commit.gpgsign=false commit -m "..."
done
```

`bun.lockb` (legacy binary lockfile) does not exist post-migration to text `bun.lock`. Every iteration:
1. `git add` failed with `fatal: pathspec 'bun.lockb' did not match any files` (silenced by `2>/dev/null`).
2. Nothing was staged.
3. `git commit` reported `no changes added to commit` with the modified files listed.

Looked like a mysterious "changes not being detected" symptom. Real cause: silent partial-add failure.

## Fixes (any one is sufficient)

- **Drop `2>/dev/null` from `git add`.** The stderr messages are the diagnostic.
- **Add files individually, ignore per-file failures:**
  ```bash
  for f in package.json bun.lock bun.lockb; do
    git add "$f" 2>/dev/null || true
  done
  ```
  This preserves the "add whatever exists" behavior without atomic abort.
- **Use `git add --ignore-errors A B C`** (best-of-both — atomic-ish behavior but skips non-existent paths).
- **Use `git add -A` scoped to a directory** if you actually want "everything modified here": `git add -A .` in the target dir. Loses the file-list intent but is bulletproof.
- **Test each pathspec with `[ -f "$f" ]`** before including it in the `git add` list — verbose but explicit.

## Related failure mode

`git rm A B C` has the same behavior. If any pathspec doesn't match tracked files, the whole command fails. Same fixes apply.

## When to Use

- A `git commit` in a scripted loop reports "no changes added to commit" for files that clearly show as modified in `git status`.
- Writing a shell loop that batches `git add` across multiple files, especially with `2>/dev/null` or when file existence is uncertain (lockfile format transitions, optional dotfiles).
- Debugging why a chained `git add && git commit` produced an empty commit.

## Anti-pattern

Assuming `git add` is a for-each-file operation. It isn't — it's a single atomic operation over the pathspec list. Modeling it as for-each leads to silent staging losses.
