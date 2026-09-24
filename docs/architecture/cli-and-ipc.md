# CLI & IPC Interfaces

**Status:** IMPLEMENTED  
**Authority:** Normative Interface Architecture  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [architecture-overview.md](architecture-overview.md), [execution-model.md](execution-model.md)  
**Related Implementation:** `bin/forge.ts`, `src/main/cli.ts`, `src/shared/ipc.ts`, `src/main/ipc/router.ts`  

---

## 1. Dual Interface Model

Forge provides two authoritative interfaces into the headless kernel:
1. **The Standalone CLI (`forge`)**: A scriptable command-line interface for terminal workflows, headless servers, and CI/CD pipelines.
2. **The Typed IPC Router (`ipcMain` / `preload`)**: A type-safe, validated inter-process communication bridge connecting the Electron Renderer UI to Main.

---

## 2. Standalone Forge CLI (`bin/forge.ts`, `src/main/cli.ts`)

The CLI provides headless execution without booting Electron or Chromium.

### Command Catalog

Implemented commands on `main` (`src/main/cli.ts`):

```bash
# Execute an autonomous engineering task
forge run "Implement user authentication with bcrypt" \
  --data-dir .forge \
  --model qwen2.5-coder:7b \
  --json

# Display repository status and Forge control plane state
forge status --cwd . --json

# Inspect or configure active AI model and provider
forge models list
forge models set ollama qwen2.5-coder:7b
```

Planned commands (future milestones):
```bash
# List recent runs and statuses (Planned)
forge runs --data-dir .forge

# Inspect stored artifacts for a run (Planned)
forge artifacts <run-id>
```

### Clean Exit Code Contract
The CLI adheres to a deterministic, POSIX-compliant exit code contract:
- **`0` (Success)**: Task completed, verified against tests, and passed independent review.
- **`1` (Failure)**: Verification failed (tests or build broke), or unhandled runtime error.
- **`2` (Halt)**: Execution halted due to policy violation (out-of-scope write) or iteration limit reached without convergence.

### NDJSON Event Streaming (`--json`)
When invoked with `--json`, the CLI suppresses raw terminal formatting and streams newline-delimited JSON (NDJSON) events directly to `stdout`. Each line conforms to the canonical `Event` schema, allowing parent orchestrators, IDE extensions, or CI logs to parse progress in real time.

---

## 3. Electron IPC Contract & Validation

Electron IPC connects the sandboxed Renderer process (React) to the Main process (Node.js).

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

### Why Failures Are Returned, Not Thrown
Electron's `contextBridge` serializes thrown exceptions structurally:
- If a custom error class (e.g. `ForgeIpcError`) is thrown, `contextBridge` strips custom properties (such as `.code` and `.details`) and resets the constructor name to generic `"Error"`.
- If a plain result envelope `{ ok: false, error: { code, message } }` is returned, **all properties survive intact**.
- Therefore, handlers return an `IpcResult<T>` envelope. `src/renderer/src/ipc.ts` unwraps the envelope and reconstructs the typed error on the renderer side, preserving stack traces at the calling UI component.

### The Capability Checklist
Adding an IPC capability requires four coordinated steps:
1. Declare the channel, request schema, and response schema in `src/shared/ipc.ts`.
2. Implement the channel handler in `src/main/ipc/handlers.ts` (enforced by TypeScript exhaustive check).
3. Expose a named method in `src/preload/index.ts` (never exposing bare `invoke`).
4. Add the method signature to `ForgeApi` in `src/preload/api.ts`.

Verification: `npm run check:router` and `npm run smoke` statically and dynamically verify that every declared channel has a corresponding handler and preload binding.
