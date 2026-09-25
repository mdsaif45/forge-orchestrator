# CLI & IPC Interfaces

**Status:** IMPLEMENTED  
**Authority:** Normative Interface Architecture  
**Last Updated:** 2026-09-25  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Related Architecture:** [architecture-overview.md](architecture-overview.md), [execution-model.md](execution-model.md), [contracts/artifact-storage.md](contracts/artifact-storage.md)  
**Related Implementation:** `bin/forge.ts`, `src/main/cli.ts`, `src/shared/ipc.ts`, `src/main/ipc/router.ts`, `src/main/ipc/handlers.ts`  

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

# List and inspect runs (project-scoped by default)
forge runs [--status <sfc>] [--limit <n>] [--all] [--json]
forge runs inspect <runId> [--json]
forge runs events <runId> [--from <seq>] [--json]

# Inspect stored artifacts and stream byte windows
forge artifacts [list] <runId> [--json]
forge artifacts cat <artifactId> [--offset <n>] [--length <n>]
```

#### Strict Project Scoping for `forge runs`
`forge runs` is strictly project-scoped by default:
- Without `--all`, `forge runs` resolves the current repository against registered Forge projects. If no project matches, it exits with an explicit error and code `1`. It never silently broadens to an unconstrained global query.
- With `--all`, `forge runs` explicitly queries runs across all registered projects.
- `runId` arguments are validated at the CLI boundary via `runIdSchema.parse()` before querying storage.

#### Raw Byte Preservation for `forge artifacts`
- Storage holds raw bytes (`Buffer`) via `ArtifactService.readWindow()`.
- When outputting to an interactive terminal, `forge artifacts cat` safely displays readable text or provides piping hints.
- When piped (e.g. `forge artifacts cat <id> > output.bin`), raw binary bytes are written directly to stdout without UTF-8 corruption.

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

### Artifact Streaming Channels (`artifacts:*`)

The IPC router exposes windowed streaming for stored artifacts:
- `artifacts:listForRun`: Returns metadata views (`ArtifactMetadataView[]`) for all artifacts belonging to a run.
- `artifacts:getMetadata`: Returns metadata for a single artifact.
- `artifacts:readWindow`: Reads a window of bytes `[offsetBytes, offsetBytes + lengthBytes)`.

#### Binary Transfer Across ContextBridge
To prevent lossy UTF-8 conversion across Electron's `contextBridge`:
- The service layer (`ArtifactService.readWindow()`) returns raw `Buffer` and total file byte count.
- The IPC handler base64-encodes the byte window: `{ data: string, encoding: 'base64', totalBytes: number }`.
- The renderer decodes the base64 payload as needed for visualization, ensuring that arbitrary binary artifacts (e.g. SQLite snapshots, images, compiled binaries) are preserved with zero corruption.

### The Capability Checklist
Adding an IPC capability requires four coordinated steps:
1. Declare the channel, request schema, and response schema in `src/shared/ipc.ts`.
2. Implement the channel handler in `src/main/ipc/handlers.ts` (enforced by TypeScript exhaustive check).
3. Expose a named method in `src/preload/index.ts` (never exposing bare `invoke`).
4. Add the method signature to `ForgeApi` in `src/preload/api.ts`.

Verification: `npm run check:router` and `npm run smoke` statically and dynamically verify that every declared channel has a corresponding handler and preload binding.
