ALTER TABLE `graph_node_runs` ADD COLUMN `iteration` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_node_runs_node_iter_attempt_unique` ON `graph_node_runs` (`graph_run_id`,`node_id`,`attempt`,`iteration`);
--> statement-breakpoint
CREATE TABLE `graph_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_run_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`source_attempt` integer NOT NULL,
	`target_node_id` text NOT NULL,
	`target_attempt` integer NOT NULL,
	`from_iteration` integer NOT NULL,
	`to_iteration` integer NOT NULL,
	`checkpoint_id` text,
	`occurred_at` text NOT NULL,
	CHECK (`to_iteration` = `from_iteration` + 1),
	FOREIGN KEY (`graph_run_id`) REFERENCES `graph_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `graph_checkpoints`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`graph_run_id`,`target_node_id`,`target_attempt`,`to_iteration`) REFERENCES `graph_node_runs`(`graph_run_id`,`node_id`,`attempt`,`iteration`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`graph_run_id`,`source_node_id`,`source_attempt`,`from_iteration`) REFERENCES `graph_node_runs`(`graph_run_id`,`node_id`,`attempt`,`iteration`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_transitions_source_attempt_unique` ON `graph_transitions` (`graph_run_id`,`source_node_id`,`source_attempt`);
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_transitions_target_iter_unique` ON `graph_transitions` (`graph_run_id`,`to_iteration`,`target_node_id`);
--> statement-breakpoint
CREATE INDEX `graph_transitions_run` ON `graph_transitions` (`graph_run_id`,`occurred_at`);
