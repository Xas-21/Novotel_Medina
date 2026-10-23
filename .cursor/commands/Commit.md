---
description: Commit the current work and push it to GitHub main
---

Commit the current work and push it to GitHub `main`.

1. Check `git status`, `git diff`, and recent `git log` so the message matches this repo. Confirm the branch is `main` and it tracks `origin/main`. If the branch is not `main`, stop and say so. Do not merge, rebase, or switch branches.
2. Stage only the files that belong to the work. Leave out secrets (`.env`, credentials), caches (`graphify-out/`, `.pytest_cache/`, `__pycache__/`), and unrelated untracked files such as `.agents/` and `skills-lock.json` unless the user explicitly asked to include them.
3. Write a one or two sentence commit message in the style of recent commits. Say why the change exists.
4. Do not change git config. Do not use `--no-verify`, `--amend`, or a force push. On PowerShell, pass the message with a here-string, not a bash heredoc.
5. If commit fails because the author identity is missing, reuse the name and email from `git log -1` for that commit only, through environment variables. Do not write them into git config.
6. If there is nothing to commit, say so and do not push.
7. Push with `git push origin main`. Then report the commit hash and that it is on GitHub `main`. Remind the user that the live site updates only after the server pulls `main` and rebuilds.
