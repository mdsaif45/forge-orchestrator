# Contract: Artifact Storage & Windowed Reading

**Status:** FROZEN  
**Authority:** Canonical Storage Contract  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [state-and-storage.md](../state-and-storage.md)  
**Related Implementation:** `src/main/artifacts/artifactService.ts`, `src/main/db/artifactStore.ts`  

---

## 1. Purpose

This contract defines the on-disk storage structure, boundary security containment, integrity guarantees, and byte-offset reading protocol for execution artifacts managed by `ArtifactService`.

---

## 2. Directory Layout

All execution artifacts are isolated by Run ID within the project data directory under `<dataDir>/artifacts/<runId>/`:

```
<dataDir>/artifacts/
  └── <runId>/
       ├── <artifactId>-prompt-packet.json    (Exact context injected into model)
       ├── <artifactId>-stdout.log            (Process terminal log)
       ├── <artifactId>-diff.patch            (Unified diff measured by GitService)
       └── <artifactId>-tool_result.bin       (Tool output spill cache)
```

File names follow `<artifactId>-<sanitized-name>`, where the name is sanitized to `[a-zA-Z0-9._-]` (defaulting to `artifact.bin` if empty).

---

## 3. Metadata Schema (SQLite `artifacts` Table)

Every artifact file created on disk must have a corresponding indexed record in SQLite (`src/shared/domain/artifact.ts`, `src/main/db/schema.ts`):

```typescript
export interface ArtifactMetadata {
  readonly id: ArtifactId;           // UUID string
  readonly runId: RunId;             // Owning Run UUID
  readonly stepId: StepId | null;    // Optional owning Step UUID
  readonly kind: ArtifactKind;       // 'stdout' | 'stderr' | 'tool-input' | 'tool-output' | 'diff' | 'prompt-packet' | 'agent-raw' | 'custom'
  readonly name: string;             // Human-readable / file name
  readonly mimeType: string;         // MIME type
  readonly sizeBytes: number;        // Exact byte size
  readonly sha256: string;           // Hex-encoded SHA-256 digest
  readonly relativePath: string;     // Relative path: <runId>/<artifactId>-<safeName>
  readonly createdAt: string;        // ISO-8601 timestamp
}
```

---

## 4. Security & Containment Invariants

1. **Path Traversal Containment**: `ArtifactService.resolvePath()` resolves every candidate path against `baseDir` and asserts that the relative diff does not escape (`startsWith('..')` or absolute). Any traversal attempt throws `Error: Path traversal detected: artifact path escapes base directory: ...`.
2. **SHA-256 Integrity Verification**: The SHA-256 hex digest is computed synchronously from the content buffer at write time and stored alongside the file metadata in SQLite.
3. **Atomic File & DB Recording**: If database metadata recording fails after writing the physical file, `ArtifactService` unlinks the created file in a catch block to prevent orphaned artifacts.

---

## 5. Windowed Byte-Offset Reader

To prevent Node.js Out-Of-Memory (OOM) crashes when reading large terminal logs or compilation streams, `ArtifactService.readWindow()` implements windowed reading:

```typescript
export interface ReadWindowResult {
  readonly data: Buffer;
  readonly totalBytes: number;
}
```

- Signature: `async readWindow(id: ArtifactId, offsetBytes = 0, lengthBytes = 64 * 1024): Promise<ReadWindowResult>`
- If `offsetBytes >= totalBytes || lengthBytes <= 0`, returns `{ data: Buffer.alloc(0), totalBytes }`.
- File reads use `node:fs/promises` file handles with positional `handle.read(buffer, 0, toRead, offsetBytes)`.

---

## 6. Verification Evidence

- `src/main/artifacts/artifactService.test.ts`: Verifies path containment, SHA-256 calculation, binary vs text handling, write rollback, and windowed chunk reading (7 tests on `main`).
- `src/main/db/artifactStore.test.ts`: Verifies SQLite indexing and metadata retrieval.

---

## 7. Amendment History

| Amendment | Type | Date | Reason & Evidence |
| :--- | :--- | :--- | :--- |
| **AMD-ART-001** | CORRECTION | 2026-09-22 | Corrected metadata schema from `ArtifactRecord` (with `type`) to canonical `ArtifactMetadata` (with `kind: ArtifactKind` matching `src/shared/domain/artifact.ts`). Updated directory layout and relativePath format to `<runId>/<artifactId>-<safeName>`. |
| **AMD-ART-002** | CORRECTION | 2026-09-22 | Corrected `readWindow` signature to positional `(id, offsetBytes, lengthBytes)` returning `ReadWindowResult { data: Buffer, totalBytes: number }` matching `src/main/artifacts/artifactService.ts` lines 170-191. |
