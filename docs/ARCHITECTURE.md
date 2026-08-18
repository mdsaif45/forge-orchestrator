# Architecture

How Forge is put together, and why. This describes the code as it stands; where
something is planned but not built, the issue is named.

## Processes

```
┌─────────────────────── MAIN (Node) ────────────────────────┐
│ owns: project truth · git · child processes · persistence  │
│                                                            │
│  src/main/index.ts        window, lifecycle, single instance│
│  src/main/security.ts     CSP · permissions · navigation    │
│  src/main/ipc/register.ts binds the router to ipcMain      │
│  src/main/ipc/router.ts   validation, no electron import   │
│  src/main/ipc/handlers.ts one handler per channel          │
└────────────────────────────┬───────────────────────────────┘
                             │  contextBridge, one channel per capability
┌────────────────────────────┴───────────────────────────────┐
│ PRELOAD  src/preload/index.ts                              │
│ named methods only · no channel argument reaches renderer  │
└────────────────────────────┬───────────────────────────────┘
                             │  window.forge.<domain>.<method>()
┌────────────────────────────┴───────────────────────────────┐
│ RENDERER (React)  no Node · no Electron · sandboxed        │
│                                                            │
│  src/renderer/src/app/    shell, routing, nav, UI store    │
│  src/renderer/src/ui/     tokens + primitives              │
│  src/renderer/src/ipc.ts  unwraps result envelopes         │
└────────────────────────────────────────────────────────────┘

           src/shared/   compiled into all three
                         pure data and pure functions only
```

`src/shared` may not import `electron`, `node:*`, `react`, or `react-dom` — it is
compiled into every target. Enforced by ESLint, not convention.

## The IPC contract

One declaration produces the channel list, the validation, and the types.

```
src/shared/ipc.ts
      │
      ├──> IPC_CHANNELS      what register.ts binds
      ├──> request schema     parsed in main before the handler runs
      ├──> response schema    parsed in main before crossing back
      └──> IpcChannel union   a typo is a compile error
```

A call, end to end:

```
renderer   forge.app.getInfo()
              │
preload    ipcRenderer.invoke('app:getInfo', {})
              │                 ↑ the only place a channel name is written
main       router: in contract? ──no──> UNKNOWN_CHANNEL
              │ yes
           parse request ──invalid──> INVALID_REQUEST   (handler never runs)
              │ valid
           handler ──throws──> HANDLER_FAILED
              │ returns
           parse response ──invalid──> INVALID_RESPONSE (never reaches renderer)
              │ valid
           { ok: true, value }
              │
renderer   unwrap() ──> value, or throws ForgeIpcError
```

### Why failures are returned, not thrown

`contextBridge` serializes errors **structurally**. Measured behaviour:

```
throw Error + own property   →  property stripped, name reset to "Error"
throw plain object           →  survives
return a result envelope     →  survives          ← what Forge does
```

So a thrown `ForgeIpcError` subclass loses its `code`. Preload returns an
`IpcResult`; `src/renderer/src/ipc.ts` turns it back into a real error, which also
puts the stack at the calling component rather than inside preload.

### Adding a capability

```
1. declare the channel in src/shared/ipc.ts    (request + response schema)
2. implement it in src/main/ipc/handlers.ts    (exhaustive map — compile error if missing)
3. expose a named method in src/preload/       (never a channel argument)
4. add the method to ForgeApi in src/preload/api.ts
```

## Security posture

App-wide guards, distinct from the per-agent permission model in #37.

```
contextIsolation  on      nodeIntegration  off     sandbox  on
webviewTag        off     CSP              every response
permissions       all denied (camera, geolocation, notifications, …)
navigation        locked to the app origin; external links → OS browser
single instance   two orchestrators would contend over one db and one worktree
```

Production CSP allows no inline styles and no remote origins. The development
policy adds the Vite origin and `'unsafe-inline'`, which HMR requires.

**What Forge cannot enforce**, stated plainly: agent CLIs run as child processes
with the user's own OS privileges. Forge controls what it invokes, which paths it
declares writable, and what enters an agent's context — it is a guardrail, not a
sandbox. See #37.

## Renderer state

```
main (SQLite, event log)          renderer (zustand)
────────────────────────          ──────────────────
project · task · decision         sidebar collapsed
workflow · changeset              panel sizes
question · event                  view preferences
        ↑                                 ↑
   the truth (A1)              UI-only, meaningless elsewhere
```

Domain state must not be mirrored into the renderer store: a persisted copy would
diverge from the database *and* survive restarts, which is a second truth.

## Design system

```
pages ──> primitives ──> tokens
```

A page imports from `@renderer/ui` and never styles what a primitive covers. A
primitive references tokens and never writes a literal colour. `ui/tokens.css` is
the only place a hex value appears. Both boundaries are lint-enforced. See
`src/renderer/src/ui/README.md`.

## Verification layers

Each layer answers a question the others cannot.

```
npm run test          logic and primitives            node + jsdom
npm run check:router  boundary rules                  plain node, no electron
npm run smoke         isolation · CSP · bridge        real electron
npm run check:ui      computed styles · themes        real electron
npm run test:e2e      the app's own startup path      real electron, playwright
```

Assertions target observable behaviour, not source text. An early version of
`check:ui` grepped the built CSS and reported zero utilities while the browser was
resolving them correctly — Tailwind minifies and escapes selectors, so a literal
search produces false negatives.

## Build

```
electron-vite ──┬──> out/main/index.js        app entry
                ├──> out/main/router.js       so check:router runs in plain node
                ├──> out/main/security.js     so smoke asserts the real CSP
                ├──> out/preload/index.cjs    cjs: a sandboxed preload cannot be ESM
                └──> out/renderer/            html + assets
```

Two traps worth remembering:

- a sandboxed preload **cannot** be an ES module — it is emitted as `.cjs`, and
  `main` must load that exact extension
- `electron@43` ships **no postinstall of its own**, so this project declares one.
  `npm rebuild electron` does not fetch the binary; only `npm install` / `npm ci`
  do

## Not yet built

| Area | Issue |
|------|-------|
| domain model, SQLite, event log | #14 #15 #16 |
| git service | #17 |
| agent runtimes, `IAgentRuntime` | #21 → #26 |
| workflow engine, context engine | #27 → #32 |
| evidence, policy engine | #33 → #37 |
| questions, decision lock, diff UI | #38 → #42 |
