import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

/**
 * The SQLite schema, mirroring `src/shared/domain`.
 *
 * Conventions, chosen once so every table reads the same way:
 *
 *   - ids are the domain's UUID strings, used directly as primary keys. No
 *     surrogate integers: the domain already has stable identity, and a second one
 *     would need reconciling.
 *   - timestamps are ISO-8601 text, matching `timestampSchema`. SQLite has no date
 *     type, and text sorts correctly for ISO-8601.
 *   - booleans are integers, since SQLite has no boolean.
 *   - structured values (permissions, params, patches) are JSON text. Zod remains
 *     the authority on their shape; the database stores them opaquely.
 *
 * Row shapes are not exported as the app's types — `src/shared/domain` owns those.
 * These tables are the storage representation, and the repositories in `#15` parse
 * rows back through the domain schemas so a malformed row fails loudly.
 */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' })
    // One repository per project for the MVP; multi-repo is not in scope.
    .unique(),
  absolutePath: text('absolute_path').notNull(),
  defaultBranch: text('default_branch').notNull(),
  buildCommand: text('build_command'),
  testCommand: text('test_command'),
  /** JSON array of technology tags. */
  tech: text('tech').notNull(),
})

export const rules = sqliteTable(
  'rules',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    statement: text('statement').notNull(),
    source: text('source').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    // One value per key per scope, so resolution is deterministic rather than
    // dependent on insertion order.
    unique('rules_scope_key').on(table.projectId, table.scope, table.key),
  ],
)

export const agentBindings = sqliteTable(
  'agent_bindings',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    runtimeId: text('runtime_id').notNull(),
    accountId: text('account_id'),
    /** JSON array of capabilities the runtime declared. */
    capabilities: text('capabilities').notNull(),
    /** JSON object matching `permissionsSchema`. */
    permissions: text('permissions').notNull(),
  },
  (table) => [unique('agent_bindings_project_role').on(table.projectId, table.role)],
)

export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    statement: text('statement').notNull(),
    rationale: text('rationale').notNull(),
    status: text('status').notNull(),
    proposedBy: text('proposed_by').notNull(),
    proposedAt: text('proposed_at').notNull(),
    lockedAt: text('locked_at'),
    lockedBy: text('locked_by'),
    supersededBy: text('superseded_by'),
    originQuestionId: text('origin_question_id'),
  },
  (table) => [index('decisions_project_status').on(table.projectId, table.status)],
)

export const openQuestions = sqliteTable(
  'open_questions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    whyUndetermined: text('why_undetermined').notNull(),
    /** JSON array of `evidenceRefSchema`. Never empty (axiom A2). */
    evidence: text('evidence').notNull(),
    options: text('options').notNull(),
    recommendation: text('recommendation'),
    askedBy: text('asked_by').notNull(),
    askedAt: text('asked_at').notNull(),
    answer: text('answer'),
    answeredAt: text('answered_at'),
    answeredBy: text('answered_by'),
  },
  (table) => [
    // The question queue reads unanswered-first, across projects.
    index('open_questions_unanswered').on(table.answeredAt, table.askedAt),
  ],
)

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  objective: text('objective').notNull(),
  /** JSON arrays / objects matching the domain schemas. */
  constraints: text('constraints').notNull(),
  completionCriteria: text('completion_criteria').notNull(),
  scope: text('scope').notNull(),
  lockedDecisionIds: text('locked_decision_ids').notNull(),
  correctsTaskId: text('corrects_task_id'),
  createdAt: text('created_at').notNull(),
})

export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    templateId: text('template_id').notNull(),
    state: text('state').notNull(),
    iteration: integer('iteration').notNull(),
    /** JSON matching `workflowLimitsSchema`. */
    limits: text('limits').notNull(),
    /** JSON matching `workflowCheckpointSchema`, or null. */
    checkpoint: text('checkpoint'),
    resumeState: text('resume_state'),
    blockedByQuestionId: text('blocked_by_question_id'),
    haltReason: text('halt_reason'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (table) => [
    // Startup looks for interrupted workflows to offer a resume (#28).
    index('workflows_project_state').on(table.projectId, table.state),
  ],
)

export const workflowSteps = sqliteTable(
  'workflow_steps',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    index: integer('step_index').notNull(),
    role: text('role').notNull(),
    runtimeId: text('runtime_id'),
    state: text('state').notNull(),
    contextRef: text('context_ref'),
    reportStatus: text('report_status'),
    verdict: text('verdict'),
    changeSetId: text('change_set_id'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (table) => [unique('workflow_steps_order').on(table.workflowId, table.index)],
)

export const changeSets = sqliteTable(
  'change_sets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    baseSha: text('base_sha').notNull(),
    headSha: text('head_sha'),
    /** JSON array of `changedFileSchema`. */
    files: text('files').notNull(),
    patch: text('patch').notNull(),
    authorActor: text('author_actor').notNull(),
    stepId: text('step_id').notNull(),
    taskId: text('task_id').notNull(),
    correctsChangeSetId: text('corrects_change_set_id'),
    reviewVerdict: text('review_verdict'),
    /** JSON array of `discrepancySchema`. */
    discrepancies: text('discrepancies').notNull(),
    capturedAt: text('captured_at').notNull(),
  },
  (table) => [index('change_sets_task').on(table.taskId, table.capturedAt)],
)

/**
 * What Forge observed when it ran a command itself (axiom A3).
 *
 * The raw `stdout` and `stderr` are stored rather than a parsed summary: a parser
 * that mis-reads a runner's format would otherwise destroy the only record of what
 * happened, and the output is already capped at capture time.
 *
 * `exit_code` is nullable because a run that was killed — timed out, cancelled, or
 * killed for flooding its output — never reported one. Null is not a pass; the
 * verdict is computed by `evidencePassed`, never stored, so nothing can write a
 * verdict that disagrees with the evidence beside it.
 */
export const evidenceArtifacts = sqliteTable(
  'evidence_artifacts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull(),
    stepId: text('step_id').notNull(),
    kind: text('kind').notNull(),
    command: text('command').notNull(),
    cwd: text('cwd').notNull(),
    outcome: text('outcome').notNull(),
    exitCode: integer('exit_code'),
    durationMs: integer('duration_ms').notNull(),
    stdout: text('stdout').notNull(),
    stderr: text('stderr').notNull(),
    truncated: integer('truncated').notNull(),
    /** JSON `testCountsSchema`, or null when nothing could be parsed. */
    counts: text('counts'),
    failure: text('failure'),
    recordedAt: text('recorded_at').notNull(),
  },
  (table) => [index('evidence_artifacts_step').on(table.stepId, table.recordedAt)],
)

/**
 * The append-only event log.
 *
 * `(project_id, seq)` is the primary key, which makes ordering total within a
 * project and makes a duplicate sequence number impossible at the storage layer
 * rather than only in application code.
 *
 * Deliberately no foreign key to `projects`: the log is the source of truth that
 * `projects` (and every other projected table) is derived FROM, not a dependent
 * of it. A `project.created` event is written before any projected row exists —
 * an FK here would make that ordering impossible, and `onDelete: 'cascade'` would
 * mean deleting a project's projection also destroyed its own audit trail, which
 * inverts what an append-only log is for.
 */
export const events = sqliteTable(
  'events',
  {
    projectId: text('project_id').notNull(),
    seq: integer('seq').notNull(),
    id: text('id').notNull().unique(),
    type: text('type').notNull(),
    /** JSON, validated per event type at the command layer (#16). */
    payload: text('payload').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    occurredAt: text('occurred_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.seq] }),
    index('events_project_type').on(table.projectId, table.type),
  ],
)

/**
 * `schema_meta` is deliberately absent from this schema.
 *
 * It tracks which migrations have been applied, so it must exist *before* the
 * first migration runs. Declaring it here would put it inside migration 0000,
 * where it would collide with the runner's own bootstrap. It is created by
 * `runMigrations` instead — see `migrate.ts`.
 */
