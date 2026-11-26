# Forge UI Design System (`@forge/ui`)

**Define once, reuse across every screen.** All visual tokens, typography scales, spacing rules, hairline elevation surfaces, vector icons, and reusable UI primitives live in `packages/forge-ui`.

```
packages/forge-desktop/src/renderer/src/app/   <- feature screens & thread orchestration
                     │ import from '@forge/ui' (or '@renderer/ui' facade)
                     ▼
packages/forge-ui/src/primitives/ & icons/     <- reference semantic CSS variables only
                     │ var(--color-*), var(--text-*), var(--control-height-*), var(--elevation-*)
                     ▼
packages/forge-ui/src/styles/                  <- ONLY home of palette hex/oklch values, fonts, z-index & shadows
```

---

## Core Governance Rules

1. **Zero one-off hex colors or magic `z-index` in pages or primitives.** Always use semantic surface/intent tokens (`--color-canvas`, `--color-surface`, `--color-surface-raised`, `--color-surface-floating`, `--color-edge-*`, `--color-accent`, `--color-danger`, etc.).
2. **Surface elevation & hairline edges over heavy borders.** Cards, panels, toolbars, and floating menus rely on subtle `0.5px` ring shadows (`--elevation-button`, `--elevation-raised`, `--elevation-floating`) and `--color-edge-*` dividers rather than bright boxes.
3. **Standardized typography & control height rhythm.**
   - Use `.typography-ui-header`, `.typography-ui-section`, `.typography-ui-label`, `.typography-meta`, `.typography-micro`, `.typography-code`, `.typography-markdown`.
   - Align interactive controls to the fixed height ladder: `xs` (`24px` / `h-6`), `sm` (`28px` / `h-7`), `md` / `default` (`32px` / `h-8`), `lg` (`36px` / `h-9`). Header chrome controls align on `h-7` inside the `--header-height` (`40px`) bar.
4. **Unified vector iconography.** Render icons through `<Icon name="..." />` (`packages/forge-ui/src/icons/`), backed by `lucide-react`. Never add raw Unicode emoji (`📋`, `📥`, `🗑️`, `⚡`) or hand-rolled SVG duplicates in chrome or cards.
5. **Accessible by default.**
   - Every icon-only control must provide an accessible name (`aria-label`).
   - All focusable controls keep `--color-border-focus` focus-visible rings.
   - `prefers-reduced-motion` disables non-essential motion globally.
6. **Theme parity.** Only `styles/tokens.css` defines dark, `[data-theme='light']`, and `[data-theme='azure']` overrides. All three themes must pass computed checks via `npm run check:ui`.
