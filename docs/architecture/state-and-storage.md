# State, Persistence & Dual-Tier Storage

**Status:** IMPLEMENTED  
**Authority:** Normative Storage Architecture  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [architecture-overview.md](architecture-overview.md), [execution-model.md](execution-model.md)  
**Related Contracts:** [artifact-storage.md](contracts/artifact-storage.md)  
**Related Implementation:** `src/main/db/`, `src/main/artifacts/artifactService.ts`  

---

## 1. Dual-Tier Storage Architecture

Forge implements a strict dual-tier persistence model:
1. **Relational / Indexed Metadata (SQLite)**: Structured relational records queried with low latency and transactional guarantees.
2. **Content-Addressed Blobs (Filesystem)**: Large, streaming, or unbounded text and binary artifacts stored on disk.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          PERSISTENCE LAYER                             │
│                                                                        │
│   ┌───────────────────────────┐      ┌─────────────────────────────┐   │
│   │ SQLite Database           │      │ Filesystem Directory        │   │
│   │ (forge.db / better-sqlite)│      │ (.forge/artifacts/<runId>/) │   │
│   │                           │      │                             │   │
│   │  • Run metadata           │      │  • Raw stdout/stderr logs   │   │
│   │  • Step status & timings  │      │  • Tool output caches       │   │
│   │  • Append-only event log  │      │  • Prompt packet JSON       │   │
│   │  • Artifact index records │      │  • Unified git patches      │   │
│   └─────────────┬─────────────┘      └──────────────┬──────────────┘   │
└─────────────────┼───────────────────────────────────┼──────────────────┘
                  │                                   │
                  ▼                                   ▼
         Drizzle ORM Repositories            ArtifactService
         (RunStore, EventStore)              (SHA-256 & Windowed Reader)
```

---

## 2. Relational Stores (SQLite via `better-sqlite3`)

SQLite provides atomic, embedded, zero-configuration persistence stored in `<dataDir>/forge.db` (or `--data-dir` for headless execution). Schemas are managed with `drizzle-orm`.

### 1. `RunStore` (`src/main/db/runStore.ts`)
Tracks high-level run execution records and individual steps:
- **`runs` Table**:
  - `id`: ULID primary key.
  - `task_id`: Logical task reference.
  - `status`: `pending` | `running` | `completed` | `failed` | `halted` | `cancelled`.
  - `created_at`, `updated_at`, `completed_at`.
  - `metadata`: Serialized execution configuration and tags.
- **`steps` Table**:
  - `id`: Unique step identifier (`<runId>-<stepIndex>`).
  - `run_id`: Foreign key to `runs.id`.
  - `role`: Assigned agent role (`planner`, `builder`, `reviewer`).
  - `runtime_id`: Associated `IAgentRuntime` identifier.
  - `status`: Step lifecycle status.
  - `verdict`: Computed verification result (`pass`, `fail`, `halt`).

### 2. `EventStore` (`src/main/db/eventStore.ts`)
An append-only, immutable event ledger representing every domain mutation (Axiom A1):
- **`events` Table**:
  - `id`: Primary key.
  - `run_id`: Association to active run.
  - `seq`: Monotonically increasing sequence number per run.
  - `type`: Structured domain event (e.g. `step.started`, `diff.measured`).
  - `payload`: JSON payload of the event data.
  - `actor`: System, agent, or user identifier.
  - `timestamp`: High-resolution ISO timestamp.

---

## 3. Filesystem Blob Storage (`ArtifactService`)

Large text streams and binary blobs are stored on disk at `.forge/artifacts/<runId>/`. Storing blobs directly in SQLite would degrade database query performance and inflate WAL logs.

### Artifact Metadata & Security Guarantees
Each artifact file is indexed in SQLite (`artifacts` table) with:
- `id`: Unique artifact ULID.
- `run_id`: Owning run ID.
- `step_id`: Owning step ID.
- `type`: `prompt_packet` | `raw_output` | `patch` | `tool_result`.
- `path`: Relative path within `.forge/artifacts/<runId>/`.
- `size_bytes`: Exact byte length.
- `sha256`: SHA-256 checksum computed during write.

### Boundary Containment & Path Traversal Defense
`ArtifactService` enforces strict path containment. Any target path is resolved against `.forge/artifacts/<runId>/` and verified with boundary containment checks (`path.relative(baseDir, targetPath)`). Any attempt to write outside the run directory via `../` or absolute paths immediately throws a security violation.

### Windowed Byte-Offset Reading
For massive stdout transcripts (often exceeding 10–50 MB during long test runs or compile loops), loading the entire file into memory crashes V8. `ArtifactService.readArtifactWindow()` provides streaming, windowed reading:
```typescript
interface WindowOptions {
  offset: number;
  length: number;
}
```
The reader seeks directly to the byte offset, reads the requested chunk, and returns it with total file length metadata.

---

## 4. Crash Recovery & Write-Ahead Invariants

To ensure resilience against process crashes, power failures, or unexpected process termination:
1. **Write-Ahead Events**: Domain events describing a transition are committed to SQLite **before** triggering external side effects (spawning child processes or writing files).
2. **Atomic Artifact Writes**: Files are written to temporary files before atomic rename, ensuring partially written files never pollute the artifact directory.
3. **Replay on Boot**: Upon starting, Forge checks for runs left in `running` status and marks them as `halted` due to unhandled interruption, logging an explanatory crash event.
