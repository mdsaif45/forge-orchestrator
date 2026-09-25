# State, Persistence & Dual-Tier Storage

**Status:** IMPLEMENTED
**Authority:** Normative storage architecture
**Last Updated:** 2026-09-25
**Baseline:** `main` @ `5987501` (PR #204 merged)
**Related Architecture:** [architecture-overview.md](architecture-overview.md), [execution-model.md](execution-model.md)
**Related Contracts:** [artifact-storage.md](contracts/artifact-storage.md)
**Related Implementation:** `src/main/db/`, `src/main/artifacts/artifactService.ts`
**Related Roadmap:** [roadmap.md](../roadmap/roadmap.md)

Field names, enum members and paths on this page are transcribed from
`src/main/db/schema.ts` and `src/shared/domain/`. Where the code and this page
disagree, the code is correct and this page is a defect.

---

## 1. Dual-tier model

```
                        ┌──────────────────────────────┐
   structured, queried  │ SQLite   <dataDir>/forge.db  │  runs · run_steps
   transactional        │ better-sqlite3 + drizzle-orm │  artifacts · run_events
                        └──────────────┬───────────────┘
                                       │  metadata + sha256 only
                                       ▼
                        ┌──────────────────────────────┐
   large, streamed      │ Filesystem                   │  raw stdout/stderr
   opaque bytes         │ <dataDir>/artifacts/<run-id>/│  patches · prompt packets
                        └──────────────────────────────┘
```

Blobs stay out of SQLite: unbounded rows inflate the WAL and slow every query that
never needed the bytes. Metadata stays out of the filesystem: it must be queryable and
transactional.

---

## 2. Data directory

`createForgeCore` resolves the data directory in this order
(`src/main/core/forgeCore.ts`):

1. the explicit `dataDir` option (CLI `--data-dir`),
2. an environment override,
3. the system application directory — `%APPDATA%\forge` on Windows, `~/.forge` on
   POSIX.

It then creates, under that root:

```
<dataDir>/
  forge.db        SQLite database
  artifacts/      artifact blobs, one directory per run
  logs/           process logs
  packets/        prompt packets
  worktrees/      per-run git worktrees
  accounts/       per-account isolated homes
  hooks/          provider hook scripts
  processes.json  orphan-process tracker
```

---

## 3. Relational tables

Conventions, set once in `schema.ts` and applied to every table: ids are the domain's
**UUID** strings used directly as primary keys (no surrogate integers); timestamps are
ISO-8601 text, because SQLite has no date type and ISO-8601 sorts correctly as text;
booleans are integers; structured values are JSON text with Zod remaining the authority
on their shape.

### `runs`

| Column | Notes |
| :--- | :--- |
| `id` | UUID primary key |
| `project_id` | → `projects.id`, cascade delete |
| `task_id` | logical task reference |
| `type` | `direct-task` \| `workflow` |
| `status` | `running` \| `completed` \| `failed` \| `halted` |
| `started_at`, `finished_at` | ISO-8601 text; `finished_at` nullable |
| `exit_code` | integer, nullable |
| `summary`, `error` | nullable text |
| `metadata` | JSON (model, provider, options) |

Indexed on `(project_id, started_at)` and on `task_id`.

### `run_steps`

| Column | Notes |
| :--- | :--- |
| `id` | UUID primary key |
| `run_id` | → `runs.id`, cascade delete |
| `step_index` | integer; unique per run — ordering is a database constraint |
| `role` | agent role for the step |
| `runtime_id` | nullable |
| `status` | same enum as `runs.status` |
| `started_at`, `finished_at` | ISO-8601 text |
| `summary` | nullable |
| `change_set_id`, `evidence_id` | links to the change set and evidence for the step |

### `artifacts`

Metadata only; the bytes live on disk.

| Column | Notes |
| :--- | :--- |
| `id` | UUID primary key |
| `run_id` | → `runs.id`, cascade delete |
| `step_id` | nullable |
| `kind` | `stdout` \| `stderr` \| `tool-input` \| `tool-output` \| `diff` \| `prompt-packet` \| `agent-raw` \| `custom` |
| `name`, `mime_type` | as supplied at write time |
| `size_bytes` | exact byte length |
| `sha256` | computed during the write |
| `relative_path` | path beneath the artifacts root |
| `created_at` | ISO-8601 text |

### `run_events`

The append-only ledger.

| Column | Notes |
| :--- | :--- |
| `id` | UUID, unique |
| `run_id` | → `runs.id`, cascade delete |
| `seq` | positive integer, monotonic per run |
| `step_id` | nullable |
| `type` | free-form string, validated as non-empty |
| `payload` | JSON |
| `occurred_at` | ISO-8601 text |

The primary key is the composite `(run_id, seq)`, which makes gaps and duplicate
sequence numbers impossible to insert rather than merely discouraged.

`type` is deliberately an open string, not an enum. Types emitted on `main` today:
`run.started`, `run.finished`, `step.started`, `tool.call`, `verification`,
`discrepancy`.

> Earlier revisions of this page described ULID keys, a six-member run status enum, an
> `events` table with `actor` and `timestamp` columns, and `<runId>-<stepIndex>` step
> ids. None of those match the schema. Note also that a separate legacy `events` table
> does exist alongside `run_events`; this page documents `run_events`, which is the
> run-scoped ledger.

---

## 4. Artifact storage

`ArtifactService` (`src/main/artifacts/artifactService.ts`) owns the filesystem tier.

Layout:

```
<dataDir>/artifacts/<run-id>/<artifact-id>-<sanitized-name>
```

Names are sanitised to `[a-zA-Z0-9._-]`, falling back to `artifact.bin` when nothing
survives, so a hostile or accidental filename cannot shape the path.

### Containment

`resolvePath()` resolves every candidate against the base directory and rejects it
unless it stays inside. A `../` sequence or an absolute path throws rather than
escaping the run directory.

### Public surface

```typescript
writeArtifact(options: WriteArtifactOptions): Promise<ArtifactMetadata>
readArtifact(id: ArtifactId): Promise<Buffer>
readArtifactText(id: ArtifactId, encoding?: BufferEncoding): Promise<string>
readWindow(...): Promise<ReadWindowResult>   // { data, totalBytes }
getMetadata(id: ArtifactId): ArtifactMetadata | null
listArtifacts(runId: RunId): readonly ArtifactMetadata[]
listForStep(stepId: StepId): readonly ArtifactMetadata[]
resolvePath(relativePathOrMetadata: string | ArtifactMetadata): string
```

`readWindow` seeks to a byte offset and returns the requested slice plus the total
length, so a multi-megabyte transcript can be paged without loading it into memory.
The method is `readWindow`, not `readArtifactWindow`.

### Known limitation

`writeArtifact` buffers its payload in memory. A streaming ingestion path
(`writeArtifactStream`) for high-throughput tool spills is **not implemented** — it is
noted in the source as future work under `AGENT-002`. It is tracked as PLANNED in
[current-state.md](../project/current-state.md), not described here as if it existed.

---

## 5. Consistency expectations

What the code demonstrates today:

- **Sequence integrity.** The composite primary key on `(run_id, seq)` makes the event
  ledger's ordering a storage invariant.
- **Metadata rollback.** When the metadata insert fails after the blob is written, the
  blob is removed, so the index never points at a file it cannot describe and no
  orphaned file is left behind (hardened in PR #203).
- **Checksums.** SHA-256 is computed on write and stored beside the size, so later
  reads can be checked against what was recorded.
- **Cascade deletes.** Removing a run removes its steps, artifacts and events by
  foreign key, not by application code that might be skipped.

### Not established

Crash recovery — replaying interrupted runs, or sweeping runs left in `running` after
an unclean shutdown — is **UNKNOWN**. No implementation was found for it on `main`, and
an earlier revision of this page asserted a "replay on boot" behaviour that does not
exist. Ordering guarantees between event writes and external side effects are likewise
not verified by a test today.

---

## 6. Open questions

- **Q-ST-01:** Is there an intended retention or garbage-collection policy for
  `<dataDir>/artifacts/`? Nothing prunes it today.
- **Q-ST-02:** Should crash recovery mark orphaned `running` runs as `halted` on boot?
  Desirable, but undecided and unimplemented — needs an ADR before it is documented as
  architecture.
- **Q-ST-03:** The legacy `events` table and the newer `run_events` table coexist.
  Whether `events` is to be migrated or retired is undetermined.
