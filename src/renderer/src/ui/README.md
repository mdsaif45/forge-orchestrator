# Design system

**Define once, reuse everywhere.** Adding a colour, a spacing value, or a control
means changing this directory — never a one-off value in a feature screen.

```
tokens.css      colour · type · radius · shadow · motion · z-index  (+ light theme)
cn.ts           class merge helper (clsx + tailwind-merge)
theme.ts        data-theme switching, persisted
primitives/     the controls
index.ts        the single import surface
```

## The layering rule

```
pages / features
      |  import from '@renderer/ui'
      v
   primitives          <- reference tokens only
      |  var(--color-*), var(--text-*), var(--radius-*)
      v
   tokens.css          <- the only place a literal colour appears
```

Consequences:

- a page must not write a hex colour, a font stack, or a raw `z-index`
- a primitive must not write a hex colour either — it references a token
- a page needing a control that does not exist adds a primitive; it does not
  style a bare element

## Naming

Tokens are **semantic**, not descriptive:

```
--color-surface-raised     survives a palette change
--color-gray-800           does not
```

Variants describe **intent**, not appearance: a caller asks for `danger`, never
for red.

## Themes

`tokens.css` defines dark as the base and light as a `[data-theme='light']`
override. Only tokens are redefined, so no primitive knows a theme exists.

## Accessibility, structurally

Built into the primitives rather than left to each caller:

- `Field` generates `htmlFor` / `id` / `aria-describedby`, so a labelled control
  is the default and an unlabelled one is the effort
- `IconButton` requires a `label`, since an icon-only control has no visible name
- `StatusDot` accepts a `label`, so colour is never the only signal
- `Dialog` and `Drawer` use the native `<dialog>` element for focus containment
  and Escape handling
- `Tabs` implements arrow-key navigation for the ARIA tabs pattern
- a visible focus ring is part of every interactive variant
- `prefers-reduced-motion` is honoured globally in `styles.css`

## Verification

`npm run check:ui` asserts the system as the browser resolves it — computed
styles, not CSS text. Reading the emitted stylesheet is unreliable: Tailwind
minifies and escapes selectors, so a literal search reports false negatives.

The kitchen sink (`src/renderer/src/dev/KitchenSink.tsx`) renders every primitive
in every variant, and is the fastest way to check both themes at once.
