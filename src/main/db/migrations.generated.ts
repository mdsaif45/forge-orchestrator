/**
 * GENERATED FILE — do not edit.
 *
 * Produced by `npm run db:generate` from src/main/db/migrations/*.sql.
 * Inlined so a packaged app never reads migration files from disk.
 */
import type { Migration } from './migrate'

export const MIGRATIONS: readonly Migration[] = [
  {
    tag: '0000_initial',
    sql: `CREATE TABLE \`agent_bindings\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text NOT NULL,
	\`role\` text NOT NULL,
	\`runtime_id\` text NOT NULL,
	\`account_id\` text,
	\`capabilities\` text NOT NULL,
	\`permissions\` text NOT NULL,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`agent_bindings_project_role\` ON \`agent_bindings\` (\`project_id\`,\`role\`);--> statement-breakpoint
CREATE TABLE \`change_sets\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text NOT NULL,
	\`base_sha\` text NOT NULL,
	\`head_sha\` text,
	\`files\` text NOT NULL,
	\`patch\` text NOT NULL,
	\`author_actor\` text NOT NULL,
	\`step_id\` text NOT NULL,
	\`task_id\` text NOT NULL,
	\`corrects_change_set_id\` text,
	\`review_verdict\` text,
	\`discrepancies\` text NOT NULL,
	\`captured_at\` text NOT NULL,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`change_sets_task\` ON \`change_sets\` (\`task_id\`,\`captured_at\`);--> statement-breakpoint
CREATE TABLE \`decisions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text NOT NULL,
	\`statement\` text NOT NULL,
	\`rationale\` text NOT NULL,
	\`status\` text NOT NULL,
	\`proposed_by\` text NOT NULL,
	\`proposed_at\` text NOT NULL,
	\`locked_at\` text,
	\`locked_by\` text,
	\`superseded_by\` text,
	\`origin_question_id\` text,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`decisions_project_status\` ON \`decisions\` (\`project_id\`,\`status\`);--> statement-breakpoint
CREATE TABLE \`events\` (
	\`project_id\` text NOT NULL,
	\`seq\` integer NOT NULL,
	\`id\` text NOT NULL,
	\`type\` text NOT NULL,
	\`payload\` text NOT NULL,
	\`actor\` text NOT NULL,
	\`reason\` text,
	\`occurred_at\` text NOT NULL,
	PRIMARY KEY(\`project_id\`, \`seq\`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`events_id_unique\` ON \`events\` (\`id\`);--> statement-breakpoint
CREATE INDEX \`events_project_type\` ON \`events\` (\`project_id\`,\`type\`);--> statement-breakpoint
CREATE TABLE \`open_questions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text NOT NULL,
	\`question\` text NOT NULL,
	\`why_undetermined\` text NOT NULL,
	\`evidence\` text NOT NULL,
	\`options\` text NOT NULL,
	\`recommendation\` text,
	\`asked_by\` text NOT NULL,
	\`asked_at\` text NOT NULL,
	\`answer\` text,
	\`answered_at\` text,
	\`answered_by\` text,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`open_questions_unanswered\` ON \`open_questions\` (\`answered_at\`,\`asked_at\`);--> statement-breakpoint
CREATE TABLE \`projects\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`name\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`repositories\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text NOT NULL,
	\`absolute_path\` text NOT NULL,
	\`default_branch\` text NOT NULL,
	\`build_command\` text,
	\`test_command\` text,
	\`tech\` text NOT NULL,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`repositories_project_id_unique\` ON \`repositories\` (\`project_id\`);--> statement-breakpoint
CREATE TABLE \`rules\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text,
	\`scope\` text NOT NULL,
	\`key\` text NOT NULL,
	\`statement\` text NOT NULL,
	\`source\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`rules_scope_key\` ON \`rules\` (\`project_id\`,\`scope\`,\`key\`);--> statement-breakpoint
CREATE TABLE \`tasks\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text NOT NULL,
	\`objective\` text NOT NULL,
	\`constraints\` text NOT NULL,
	\`completion_criteria\` text NOT NULL,
	\`scope\` text NOT NULL,
	\`locked_decision_ids\` text NOT NULL,
	\`corrects_task_id\` text,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE \`workflow_steps\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`workflow_id\` text NOT NULL,
	\`step_index\` integer NOT NULL,
	\`role\` text NOT NULL,
	\`runtime_id\` text,
	\`state\` text NOT NULL,
	\`context_ref\` text,
	\`report_status\` text,
	\`verdict\` text,
	\`change_set_id\` text,
	\`started_at\` text,
	\`finished_at\` text,
	FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflows\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`workflow_steps_order\` ON \`workflow_steps\` (\`workflow_id\`,\`step_index\`);--> statement-breakpoint
CREATE TABLE \`workflows\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text NOT NULL,
	\`task_id\` text NOT NULL,
	\`template_id\` text NOT NULL,
	\`state\` text NOT NULL,
	\`iteration\` integer NOT NULL,
	\`limits\` text NOT NULL,
	\`checkpoint\` text,
	\`resume_state\` text,
	\`blocked_by_question_id\` text,
	\`halt_reason\` text,
	\`started_at\` text NOT NULL,
	\`finished_at\` text,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`workflows_project_state\` ON \`workflows\` (\`project_id\`,\`state\`);`,
  },
  {
    tag: '0001_wonderful_raider',
    sql: `CREATE TABLE \`evidence_artifacts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text NOT NULL,
	\`workflow_id\` text NOT NULL,
	\`step_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`command\` text NOT NULL,
	\`cwd\` text NOT NULL,
	\`outcome\` text NOT NULL,
	\`exit_code\` integer,
	\`duration_ms\` integer NOT NULL,
	\`stdout\` text NOT NULL,
	\`stderr\` text NOT NULL,
	\`truncated\` integer NOT NULL,
	\`counts\` text,
	\`failure\` text,
	\`recorded_at\` text NOT NULL,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`evidence_artifacts_step\` ON \`evidence_artifacts\` (\`step_id\`,\`recorded_at\`);`,
  },
  {
    tag: '0002_accounts',
    sql: `CREATE TABLE \`accounts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`provider\` text NOT NULL,
	\`label\` text NOT NULL,
	\`status\` text NOT NULL,
	\`last_used_at\` text,
	\`created_at\` text NOT NULL
);
`,
  },
  {
    tag: '0003_durable_state',
    sql: `CREATE TABLE \`runs\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`project_id\` text NOT NULL,
	\`task_id\` text NOT NULL,
	\`type\` text NOT NULL,
	\`status\` text NOT NULL,
	\`started_at\` text NOT NULL,
	\`finished_at\` text,
	\`exit_code\` integer,
	\`summary\` text,
	\`error\` text,
	\`metadata\` text NOT NULL,
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`runs_project\` ON \`runs\` (\`project_id\`,\`started_at\`);--> statement-breakpoint
CREATE INDEX \`runs_task\` ON \`runs\` (\`task_id\`);--> statement-breakpoint
CREATE TABLE \`run_steps\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`run_id\` text NOT NULL,
	\`step_index\` integer NOT NULL,
	\`role\` text NOT NULL,
	\`runtime_id\` text,
	\`status\` text NOT NULL,
	\`started_at\` text NOT NULL,
	\`finished_at\` text,
	\`summary\` text,
	\`change_set_id\` text,
	\`evidence_id\` text,
	FOREIGN KEY (\`run_id\`) REFERENCES \`runs\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`run_steps_run\` ON \`run_steps\` (\`run_id\`);--> statement-breakpoint
CREATE UNIQUE INDEX \`run_steps_order\` ON \`run_steps\` (\`run_id\`,\`step_index\`);--> statement-breakpoint
CREATE TABLE \`artifacts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`run_id\` text NOT NULL,
	\`step_id\` text,
	\`kind\` text NOT NULL,
	\`name\` text NOT NULL,
	\`mime_type\` text NOT NULL,
	\`size_bytes\` integer NOT NULL,
	\`sha256\` text NOT NULL,
	\`relative_path\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`run_id\`) REFERENCES \`runs\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`artifacts_run\` ON \`artifacts\` (\`run_id\`,\`created_at\`);--> statement-breakpoint
CREATE INDEX \`artifacts_step\` ON \`artifacts\` (\`step_id\`);--> statement-breakpoint
CREATE TABLE \`run_events\` (
	\`id\` text NOT NULL,
	\`run_id\` text NOT NULL,
	\`seq\` integer NOT NULL,
	\`step_id\` text,
	\`type\` text NOT NULL,
	\`payload\` text NOT NULL,
	\`occurred_at\` text NOT NULL,
	PRIMARY KEY(\`run_id\`, \`seq\`),
	FOREIGN KEY (\`run_id\`) REFERENCES \`runs\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`run_events_id_unique\` ON \`run_events\` (\`id\`);--> statement-breakpoint
CREATE INDEX \`run_events_run_type\` ON \`run_events\` (\`run_id\`,\`type\`);
`,
  },
  {
    tag: '0004_graph_runs',
    sql: `CREATE TABLE \`graph_checkpoints\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`graph_run_id\` text NOT NULL,
	\`node_id\` text NOT NULL,
	\`operation\` text NOT NULL,
	\`state_snapshot\` text NOT NULL,
	\`occurred_at\` text NOT NULL,
	FOREIGN KEY (\`graph_run_id\`) REFERENCES \`graph_runs\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`graph_checkpoints_run\` ON \`graph_checkpoints\` (\`graph_run_id\`,\`occurred_at\`);--> statement-breakpoint
CREATE TABLE \`graph_node_runs\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`graph_run_id\` text NOT NULL,
	\`node_id\` text NOT NULL,
	\`attempt\` integer DEFAULT 1 NOT NULL,
	\`status\` text NOT NULL,
	\`role\` text,
	\`runtime_id\` text,
	\`context_ref\` text,
	\`change_set_id\` text,
	\`evidence_id\` text,
	\`started_at\` text,
	\`finished_at\` text,
	\`error\` text,
	FOREIGN KEY (\`graph_run_id\`) REFERENCES \`graph_runs\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`graph_node_runs_graph_node\` ON \`graph_node_runs\` (\`graph_run_id\`,\`node_id\`);--> statement-breakpoint
CREATE INDEX \`graph_node_runs_status\` ON \`graph_node_runs\` (\`status\`);--> statement-breakpoint
CREATE UNIQUE INDEX \`graph_node_runs_attempt_unique\` ON \`graph_node_runs\` (\`graph_run_id\`,\`node_id\`,\`attempt\`);--> statement-breakpoint
CREATE TABLE \`graph_runs\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`workflow_id\` text NOT NULL,
	\`template_id\` text NOT NULL,
	\`status\` text NOT NULL,
	\`iteration\` integer DEFAULT 1 NOT NULL,
	\`started_at\` text NOT NULL,
	\`finished_at\` text,
	\`halt_reason\` text,
	\`error\` text,
	FOREIGN KEY (\`workflow_id\`) REFERENCES \`workflows\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX \`graph_runs_workflow\` ON \`graph_runs\` (\`workflow_id\`);--> statement-breakpoint
CREATE INDEX \`graph_runs_status\` ON \`graph_runs\` (\`status\`);`,
  },
  {
    tag: '0005_loop_persistence',
    sql: `ALTER TABLE \`graph_node_runs\` ADD COLUMN \`iteration\` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX \`graph_node_runs_node_iter_attempt_unique\` ON \`graph_node_runs\` (\`graph_run_id\`,\`node_id\`,\`attempt\`,\`iteration\`);
--> statement-breakpoint
CREATE TABLE \`graph_transitions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`graph_run_id\` text NOT NULL,
	\`source_node_id\` text NOT NULL,
	\`source_attempt\` integer NOT NULL,
	\`target_node_id\` text NOT NULL,
	\`target_attempt\` integer NOT NULL,
	\`from_iteration\` integer NOT NULL,
	\`to_iteration\` integer NOT NULL,
	\`checkpoint_id\` text,
	\`occurred_at\` text NOT NULL,
	CHECK (\`to_iteration\` = \`from_iteration\` + 1),
	FOREIGN KEY (\`graph_run_id\`) REFERENCES \`graph_runs\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`checkpoint_id\`) REFERENCES \`graph_checkpoints\`(\`id\`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (\`graph_run_id\`,\`target_node_id\`,\`target_attempt\`,\`to_iteration\`) REFERENCES \`graph_node_runs\`(\`graph_run_id\`,\`node_id\`,\`attempt\`,\`iteration\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`graph_run_id\`,\`source_node_id\`,\`source_attempt\`,\`from_iteration\`) REFERENCES \`graph_node_runs\`(\`graph_run_id\`,\`node_id\`,\`attempt\`,\`iteration\`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`graph_transitions_source_attempt_unique\` ON \`graph_transitions\` (\`graph_run_id\`,\`source_node_id\`,\`source_attempt\`);
--> statement-breakpoint
CREATE UNIQUE INDEX \`graph_transitions_target_iter_unique\` ON \`graph_transitions\` (\`graph_run_id\`,\`to_iteration\`,\`target_node_id\`);
--> statement-breakpoint
CREATE INDEX \`graph_transitions_run\` ON \`graph_transitions\` (\`graph_run_id\`,\`occurred_at\`);
`,
  },
]
