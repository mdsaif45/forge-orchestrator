# ADR-009: Centralized `@forge/ui` Design System & Thread-Native Orchestration UI

**Status:** IMPLEMENTED  
**Date:** 2026-11-26  
**Milestone:** M17 (`#490`, `#491`–`#497`)  
**Supersedes:** Ad-hoc page-scoped UI styling and isolated `/questions` and `/decisions` top-level sidebar destinations  

---

## Context

Prior to M17, `@forge/desktop` carried inline page styles, one-off SVG icon helpers, raw `<select>` controls, and raw hex classes scattered across routes. In addition, architectural workflow interactions (`Questions` and `Decisions`) lived in separate top-level sidebar views (`/questions` and `/decisions`), forcing developers to leave active planning and coding threads whenever an agent paused for clarification (`AWAITING_USER`) or proposed an architectural lock (`Axiom A4`).

## Decision

1. **Centralized `@forge/ui` Workspace Package (`packages/forge-ui`)**
   - Extract the canonical design tokens (`tokens.css`: dark default and `[data-theme="light"]`, semantic surface ramp, typography classes, elevation tokens, z-index scale), `@base-ui/react` accessible primitives (`Button`, `IconButton`, `Input`, `Textarea`, `Field`, `Select`, `Checkbox`, `Switch`, `RadioGroup`, `DropdownMenu`, `ContextMenu`, `Collapsible`, `List`/`ListRow`, `Tabs`, `Toolbar`/`ActionToolbar`, `Panel`/`SplitPane`, `Dialog`, `Drawer`, `ConfirmDialog`, `Popover`, `Tooltip`, `AlertBanner`, `Toast`), and semantic `lucide-react` `<Icon />` registry (`FORGE_ICON_REGISTRY`) into `packages/forge-ui`.
   - `@forge/desktop` imports exclusively through the `@renderer/ui` facade (`packages/forge-desktop/src/renderer/src/ui/index.ts`), enforcing `check:cycles` DAG hygiene and zero one-off hex colors or ad-hoc SVGs outside `@forge/ui`.

2. **Streamlined Navigation Chrome (`StatusStrip` & `Sidebar`)**
   - Consolidate project switching, `+ New project`, and `Project settings` into a single `40px` header `DropdownMenu` inside `StatusStrip`.
   - Remove standalone `Questions` and `Decisions` entries from primary sidebar navigation while preserving `#/questions` and `#/decisions` legacy redirects to `/workflows`.

3. **Continuous Thread-Native Workflow & Inline Gates (`ThreadContainer`)**
   - Render discovery, planning, multi-agent stage handoffs, tool call timelines, visible reasoning blocks, and live PTY/model output streams in one chronological thread (`threadProjection.ts`, `ThreadContainer.tsx`).
   - Surface agent questions (`AWAITING_USER`), architectural decision lock cards (`Axiom A4`), and `PLAN_READY` / `AWAITING_APPROVAL` gates inline at the exact chronological point where the workflow pauses, retaining backend SQLite persistence unchanged.

4. **Global Top-Right Execution Context Drawer (`RightOverviewPanel`, `DrawerPlanView`, `DrawerGitView`)**
   - Lift the right-hand execution drawer into `Shell.tsx` with a global header toggle (`panel-right`) and unread badge dot.
   - Surface generated `planning.md` / planner blueprints (`DrawerPlanView`), workflow subagents & artifacts (`RightOverviewPanel`), working tree diffs, diff editing, commit message synthesis, and git stage/commit controls (`DrawerGitView` backed by `changeSetService.ts`, leaving read-only `gitService.ts` intact per Axiom A3).

## Consequences

- **Positive:** One centralized UI package with full dark/light token fidelity; single-thread human-in-the-loop control without context switching; read-only verification boundaries preserved (`gitService.ts`).
- **Verification:** Enforced by `@forge/ui` unit tests, `RightOverviewPanel.test.tsx`, `ThreadContainer.test.tsx`, `StatusStrip.test.tsx`, `scripts/ui-check.cjs`, `scripts/smoke.cjs`, and Playwright E2E tests (`e2e/app.spec.ts`).
