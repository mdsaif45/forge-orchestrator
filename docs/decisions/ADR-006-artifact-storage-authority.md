# ADR-006 — Artifact Storage Authority

**Status:** ACCEPTED  
**Authority:** Architectural Decision Record  
**Date:** 2026-09-28  
**Related Decisions:** [ADR-001](ADR-001-agents-runtimes-accounts.md), [ADR-004](README.md), [ADR-005](README.md)  
**Related Architecture:** [artifact-storage.md](../architecture/contracts/artifact-storage.md), [state-and-storage.md](../architecture/state-and-storage.md)  

---

## Context

Prior to this decision, artifact storage in Forge exhibited dual implementations and architectural debt:

1. **The Canonical Store (`ArtifactService` + SQLite `ArtifactStore`):** Introduced in milestone STATE-001 (`src/main/artifacts/artifactService.ts` and `src/main/db/artifactStore.ts`), this production subsystem stores raw artifact bytes on disk under `<dataDir>/artifacts/<runId>/<artifactId>-<safeName>` and indexes structured metadata (`ArtifactMetadata`) in SQLite. It provides windowed offset reading, streaming ingestion (AGENT-002), atomic rollback on database failure, and cryptographic SHA-256 verification.
2. **The Legacy In-Memory Prototype Store (`src/main/artifacts/artifactStore.ts`):** Left behind from an early visual workflow spike (PR #188), this file defined an in-memory `Map<string, WorkflowArtifact>`. It was never wired to persistent storage, never populated in production, and served only two vestigial prototype IPC channels: `artifact:list` and `artifact:get`.
3. **Ambiguous Terminology:** Early documentation casually referred to artifacts as "content-addressed". In reality, artifact files on disk are identified by generated UUIDs (`ArtifactId`), with SHA-256 hashes stored in SQLite for integrity verification. This is hash-verified storage, not content-addressable storage (CAS).

This split created architectural confusion: callers looking for "artifact storage" encountered two different classes named `ArtifactStore`, two divergent artifact schemas (`WorkflowArtifact` vs `ArtifactMetadata`), and two competing sets of IPC channels (`artifact:*` vs `artifacts:*`).

---

## Decision

Forge formally establishes a single, coherent artifact architecture and eliminates the legacy prototype residue.

### 1. Authority & Ownership Boundaries

- **`ArtifactService` is the Application-Facing Artifact Authority:**
  Located at `src/main/artifacts/artifactService.ts`. It is the sole entry point for creating, streaming, reading, windowing, and verifying artifacts. No execution coordinator, task runner, or IPC handler may bypass `ArtifactService` to touch disk artifact files directly.
- **SQLite `ArtifactStore` is the Metadata Persistence Authority:**
  Located at `src/main/db/artifactStore.ts`. It owns relational persistence and indexing of artifact metadata in SQLite. It is an internal dependency of `ArtifactService` and database query layers; it does not perform filesystem I/O.
- **Filesystem is the Raw-Byte Storage Authority:**
  All raw byte streams (terminal logs, prompt packets, git patches, binary tool spills) reside exclusively on the local filesystem under `<dataDir>/artifacts/<runId>/<artifactId>-<safeName>`. Large blobs are never stored directly in SQLite or held indefinitely in Node.js process memory.

### 2. Hash-Verified Artifact Integrity (Not Content-Addressed)

- **Storage Addressing:** Artifact disk files are addressed by **Run UUID and Artifact UUID**, formatted as `<runId>/<artifactId>-<sanitized-name>`. Artifact paths do NOT derive from content hashes. Therefore, artifact storage is explicitly **NOT content-addressed**.
- **Cryptographic Verification:** Every artifact records its byte length (`sizeBytes`) and cryptographic SHA-256 checksum (`sha256`) in SQLite at write time.
- **Verification Guarantee:** `ArtifactService.verifyArtifactIntegrity(id)` enforces Axiom A3 (*Physical evidence beats claims*) by recalculating the on-disk SHA-256 digest and asserting byte count against SQLite records. The canonical terminology for this model is **hash-verified artifact integrity**.

### 3. Removal of Legacy In-Memory `ArtifactStore`

- `src/main/artifacts/artifactStore.ts` is permanently removed.
- `src/main/artifacts/index.ts` exports only `ArtifactService` and its companion types (`WriteArtifactOptions`, `WriteArtifactStreamOptions`, `ReadWindowResult`).
- Any new artifact persistence needs must use SQLite `ArtifactStore` (`src/main/db/artifactStore.ts`) coordinated through `ArtifactService`.

### 4. Elimination of Obsolete Prototype IPC Channels

- The prototype channels `artifact:list` and `artifact:get` were coupled solely to the legacy in-memory store and are completely unused by the renderer and unit test suites.
- Rather than maintaining fabricated empty responses, `artifact:list` and `artifact:get` are cleanly removed from `IPC_CONTRACT`, `IPC_CHANNELS`, `src/main/ipc/handlers.ts`, and the preload bridge (`window.forge.artifact`).
- The canonical production IPC interface for artifacts is the `artifacts:*` namespace:
  - `artifacts:listForRun` (`{ runId } -> { artifacts }`)
  - `artifacts:getMetadata` (`{ artifactId } -> { artifact }`)
  - `artifacts:readWindow` (`{ artifactId, offsetBytes, lengthBytes } -> ArtifactWindowView`)
  Exposed to the renderer via `window.forge.artifacts`.

### 5. Atomic Rollback & Deletion Semantics

- **Atomic Creation:** When `ArtifactService` writes an artifact to disk, it immediately records the metadata in SQLite within the same operation. If SQLite metadata recording fails, `ArtifactService` catches the failure and unlinks the on-disk file to ensure no orphaned disk blobs exist.
- **Path Traversal Protection:** `ArtifactService.resolvePath()` verifies all candidate relative paths against the resolved base directory, throwing an error if a path escapes its containment boundary.

### 6. Architectural Independence

- This decision does NOT introduce `StepExecutor`.
- This decision does NOT modify or introduce M6 DAG / generic workflow execution models.
- Execution runtimes, task runners, and future workflow coordinators consume `ArtifactService` strictly as an injected application dependency.

---

## Consequences

- **Clarity:** There is exactly one `ArtifactStore` in Forge (`src/main/db/artifactStore.ts`, backed by SQLite) and exactly one application authority (`ArtifactService`).
- **Safety:** Elimination of the in-memory map ensures memory cannot leak unpersisted execution data across long-running desktop sessions.
- **Contract Precision:** IPC contracts declare only channels that are backed by durable storage and actively supported by the platform.
