# Berth development workflow

Use installed skills only when their documented purpose directly matches the task.
Implement only the requested issue and respect SPEC.md, repository boundaries and
its acceptance criteria. GitHub issues are the task tracker; tasks/plan.md is the
ordered index. Preserve existing work; never use destructive Git operations to
work around unexpected state.

## Prepare

- Inspect status and ensure existing changes are safe to preserve. Switch to main
  and pull with `git pull --ff-only` before starting new work.
- Read only relevant instructions, issue requirements and affected files.
- Reuse an existing requested issue; otherwise create a dedicated GitHub issue
  with requirements, scope and acceptance criteria, using the agreed plan title.
  Attach the appropriate milestone. Use `gh` and Git, not printed drafts.
- Create `feature/issue-<number>` or `fix/issue-<number>`.

## Implement and verify

- Make the smallest coherent change. Avoid unrelated refactoring and unnecessary
  abstractions. Run focused tests, lint and type checks; broaden only for
  cross-cutting changes or unresolved risks. Fix implementation failures before
  committing. Do not repeat unchanged checks or repository exploration.
- Keep credentials out of source, logs and Git. Verify cloud behavior only within
  the authorized issue scope; mock tests are not live acceptance evidence.

## Deliver

- Review the final diff and stage only issue-related files.
- Commit as `[#<number>] <concise summary>` and push the branch.
- Create a PR titled `[#<number>] <PR title>` with `Closes #<number>`, summary,
  verification results and known limitations.
- Return the PR URL and concise verification status, then stop. Do not merge,
  poll CI proactively, or continue editing after delivery.

## Explicitly requested PR feedback

Reuse the existing branch and issue. Inspect only relevant feedback/code, make
corrections, verify, commit with the issue prefix and push. Add a PR comment
explaining the issue and resolution, return the existing PR URL, and stop.
