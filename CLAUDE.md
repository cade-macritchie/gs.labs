# Working agreements

- After finishing a discrete piece of work (a feature, fix, or other logical unit of change), commit it and push to `origin/main` without asking for confirmation first. Still follow the existing git safety rules (no `--force`, no `--no-verify`, no amending published commits, review `git status`/`git diff` before staging, don't commit files that look like secrets).
- Don't commit mid-task on every individual file edit — group each logical task into one commit.
- One-off deliverables (CSVs, reports, exported files, etc. that aren't part of the tracked codebase) go in `local-files/`, not the temp scratchpad directory. Use the existing subfolder for the relevant project/event if one exists, otherwise `local-files/Other/`.
