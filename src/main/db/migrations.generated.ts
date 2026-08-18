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
	PRIMARY KEY(\`project_id\`, \`seq\`),
	FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
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
]
