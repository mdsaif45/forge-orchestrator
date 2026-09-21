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

All execution artifacts are isolated by Run ID within the project data directory:

```
<dataDir>/artifacts/
  └── <runId>/
       ├── prompt_packet_<stepId>.json    (Exact context injected into model)
       ├── raw_output_<stepId>.log        (Unredacted/redacted process terminal log)
       ├── patch_<stepId>.diff            (Unified diff measured by GitService)
       └── tool_<toolCallId>_<name>.bin   (Large tool output spill cache >50KB)
```

---

## 3. Metadata Schema (SQLite `artifacts` Table)

Every artifact file created on disk must have a corresponding indexed record in SQLite:

```typescript
export interface ArtifactRecord {
  readonly id: string;           // ULID primary key
  readonly runId: string;        // Owning Run ULID
  readonly stepId: string;       // Owning Step ID
  readonly type: 'prompt_packet' | 'raw_output' | 'patch' | 'tool_result';
  readonly relativePath: string; // Relative to <dataDir>/artifacts/<runId>/
  readonly sizeBytes: number;    // Exact byte size
  readonly sha256: string;       // Hex-encoded SHA-256 digest
  readonly createdAt: string;    // ISO timestamp
}
```

---

## 4. Security & Containment Invariants

1. **Path Traversal Containment**: Any file operation must resolve the destination path and assert that `path.resolve(targetPath).startsWith(path.resolve(runDir))`. Any path attempting directory traversal (e.g. `../../etc/passwd` or `..\\secret.key`) throws `SecurityContainmentError` and aborts the write.
2. **SHA-256 Verification**: The SHA-256 digest is computed incrementally via streaming hash as bytes are written to disk. The computed digest must match the recorded database metadata.
3. **Atomic File Writes**: Files are written to temporary staging paths (`<path>.tmp.<pid>`) and moved into place via atomic `fs.renameSync` to prevent reading partially written artifacts.

---

## 5. Windowed Byte-Offset Reader

To prevent Node.js Out-Of-Memory (OOM) crashes when reading large terminal logs or compilation streams, `ArtifactService.readArtifactWindow()` implements windowed reading:

```typescript
export interface ReadWindowOptions {
  readonly offset: number; // 0-indexed byte offset
  readonly length: number; // Maximum number of bytes to read
}

export interface ReadWindowResult {
  readonly data: string;       // UTF-8 decoded content
  readonly bytesRead: number;  // Actual bytes returned
  readonly totalBytes: number; // Total size of artifact on disk
  readonly hasMore: boolean;   // true if totalBytes > offset + bytesRead
}
```

- If `offset >= totalBytes`, returns `{ data: '', bytesRead: 0, totalBytes, hasMore: false }`.
- Negative offsets or lengths throw `RangeError`.

---

## 6. Verification Evidence

- `src/main/artifacts/artifactService.test.ts`: Verifies path containment, SHA-256 calculation, binary vs text handling, atomic writes, and windowed chunk reading.
- `src/main/db/artifactStore.test.ts`: Verifies SQLite indexing and metadata retrieval.
