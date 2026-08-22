# CLAUDE.md

Claude Code reads this file from the repo root. It is short on purpose; the
real context is in two files beside it.

1. **`HANDOFF.md`** first. What the system is, what is deployed, the data
   contracts, how to run and deploy, and what is open. Written 22 August 2026.
2. **`AGENTS.md`** second. The deeper file: house style, and the landmines in
   `web/app/index.html` that look like bugs and are load-bearing.

Three things that are true before you read either:

- **A GitHub push does not deploy.** Production changes only when someone runs
  `cd web && npm run deploy`. Commit, push, then deploy, in that order.
- **`web/` is production.** It has been serving real radio since early August.
- **`_qa/` stays out of git.** It is raw police radio with names in it.

The data is machine-transcribed and machine-located public safety radio. The
product says "Unverified, not for publication" in its own header. Anything that
makes an inferred value look confirmed is a correctness bug even when the code
is right.
