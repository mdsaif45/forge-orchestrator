# Implementation & Engineering Log

**Status:** IMPLEMENTED  
**Authority:** Physical Implementation Truth  
**Last Updated:** 2026-09-22  
**Baseline:** `main` @ `1dfb444`  

---

## 1. Merged Pull Requests (Reverse Chronological)

### PR #203: `feat(state): implement STATE-001 durable run, step, artifact, and event store`
- **Merged:** 2026-09-12T16:00:17Z
- **Commit:** `1dfb444`
- **Author:** `mdsaif45`
- **Changes:** 15 files changed, +1,842 lines / -12 lines
- **Summary:**
  - Implemented SQLite schema migrations via Drizzle ORM (`runs`, `steps`, `artifacts`, `events`).
  - Built `RunStore`, `EventStore`, `ArtifactStore`, and filesystem `ArtifactService`.
  - Hardened path traversal boundary containment on artifact directories.
  - Implemented rollback on metadata failure and authoritative event logging.
- **Tests:** +17 tests (1,108 → 1,125 passing).

### PR #198: `feat(core): Vertical Slice #1 — Headless Forge Core, Native Agent Runtime & CLI (CORE-001, AGENT-001, CLI-001, EVIDENCE-001)`
- **Merged:** 2026-09-12T07:11:13Z
- **Commit:** `26ac6e3`
- **Author:** `mdsaif45`
- **Changes:** 24 files changed, +3,150 lines / -42 lines
- **Summary:**
  - Decoupled `createForgeCore` from Electron Main.
  - Implemented standalone CLI entrypoint (`bin/forge.ts`, `bin/forge.js`, `src/main/cli.ts`) with `--json` streaming and exit codes (0/1/2).
  - Built in-process native agent task loop in `src/main/core/taskRunner.ts`.
  - Implemented physical git diff reconciliation against declared task `allowedPaths`.
- **Issues Closed:** #199, #200, #201, #202.

### PR #196: `feat(ask): refine user message bubble padding and hover action toolbar`
- **Merged:** 2026-09-10T12:24:33Z
- **Commit:** `8b91a21`
- **Summary:** UI polishing for user message boxes in desktop Ask mode.

### PR #189: `feat(runtimes): incorporate 3rd-party CLI agent providers and agents settings`
- **Merged:** 2026-09-09T14:45:38Z
- **Summary:** Added settings UI and provider catalog for external CLI agents.

### PR #188: `feat(workflows): modular lego-piece visual workflow platform, native agent, and byo-cli integration`
- **Merged:** 2026-09-09T13:49:02Z
- **Summary:** Initial modular workflow visual models and ConPTY terminal hosting foundation.

### PR #187: `fix: Stop electron-builder publishing its own drafts, and bound the screen poll in ticks`
- **Merged:** 2026-09-09T03:15:46Z
- **Summary:** Fixed duplicate GitHub release draft creation in packaging pipeline.

### PR #186: `chore(release): bump to 0.3.0-alpha.1`
- **Merged:** 2026-09-09T02:59:30Z
- **Summary:** Version bump and release preparation.

---

## 2. Active Unmerged PRs Under Review

### PR #204: `feat: Vertical Slice #2 - Observability & Criteria Integrity (CLI-004 + ARTIFACT-001 + CRIT-001)`
- **Branch:** `feat/slice-2-observability-criteria`
- **Status:** OPEN, mergeable; all three CI jobs green (checked 2026-09-22).
- **Size:** 17 files, +1,099 / −130.
- **Files touched (on the branch, not on `main`):** `src/shared/domain/criterion.ts` (new) and `criterion.test.ts`,
  `completion.ts`, `evidence.ts`, `src/main/cli.ts`, `taskRunner.ts`, `runStore.ts`,
  the IPC surface (`src/shared/ipc.ts`, `src/main/ipc/handlers.ts`, `src/preload/`),
  and `docs/FORGE-MASTER-TODO.md`.

> The branch title names `CLI-004` (terminal TUI), but the diff contains no TUI and no
> Ink dependency. The substance of the change is the criterion evaluator and its IPC
> exposure. Earlier revisions of this log described a "React Ink Terminal TUI" being
> delivered here; that was not measured and is not in the diff. The discrepancy between
> the branch title and its contents is left recorded rather than silently reconciled —
> see [Q-IL-01](#3-open-questions).

Test counts for this branch were not re-measured as part of this documentation pass.


---

## 3. Open questions

- **Q-IL-01:** PR #204's title advertises `CLI-004` (an interactive terminal TUI), but
  its diff delivers the criterion evaluator instead. Either the title or the task
  mapping is wrong. This needs the author's answer before the roadmap status for
  `CLI-004` can be trusted.
