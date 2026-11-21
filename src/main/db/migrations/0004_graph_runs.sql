CREATE TABLE `graph_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`operation` text NOT NULL,
	`state_snapshot` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`graph_run_id`) REFERENCES `graph_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_checkpoints_run` ON `graph_checkpoints` (`graph_run_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `graph_node_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`role` text,
	`runtime_id` text,
	`context_ref` text,
	`change_set_id` text,
	`evidence_id` text,
	`started_at` text,
	`finished_at` text,
	`error` text,
	FOREIGN KEY (`graph_run_id`) REFERENCES `graph_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_node_runs_graph_node` ON `graph_node_runs` (`graph_run_id`,`node_id`);--> statement-breakpoint
CREATE INDEX `graph_node_runs_status` ON `graph_node_runs` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `graph_node_runs_attempt_unique` ON `graph_node_runs` (`graph_run_id`,`node_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `graph_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`template_id` text NOT NULL,
	`status` text NOT NULL,
	`iteration` integer DEFAULT 1 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`halt_reason` text,
	`error` text,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_runs_workflow` ON `graph_runs` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `graph_runs_status` ON `graph_runs` (`status`);