Always read `@progress.txt` in full before starting the task.

We shared the plan and all the tasks so you know the context of the overall project and how your scoped task fits into it. However, you should only focus on the scoped task.

If you discover general findings relevant to future tasks, append them to `@progress.txt`. Only include findings that apply broadly, not task-specific details.

After completing the task, append any new findings to `@progress.txt` that match these criteria:
* Suggested skills from .claude/skills/ that are found related to the problem space (e.g. "I found that X is useful for Y")
* Patterns discovered (e.g. "this codebase uses X for Y")
* Gotchas encountered (e.g. "don't forget to update Z when changing W")  
* Useful component or module locations (e.g. "auth logic lives in X")
* Do not add task-specific details or anything that won't apply to future tasks
* Do not duplicate existing entries — read what's there before appending

After completing a task, commit all changes:
* Stage all modified and new files with `git add -A`
* Commit with a short descriptive message summarizing what was done
* Fix any linting or formatting issues that arise from pre-commit hooks
* Do not include Claude attribution in the commit message
