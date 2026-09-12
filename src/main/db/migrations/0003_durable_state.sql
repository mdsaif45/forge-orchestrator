CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`exit_code` integer,
	`summary` text,
	`error` text,
	`metadata` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_project` ON `runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_task` ON `runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`role` text NOT NULL,
	`runtime_id` text,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`summary` text,
	`change_set_id` text,
	`evidence_id` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_steps_run` ON `run_steps` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_steps_order` ON `run_steps` (`run_id`,`step_index`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`relative_path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_run` ON `artifacts` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `artifacts_step` ON `artifacts` (`step_id`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`step_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_id_unique` ON `run_events` (`id`);--> statement-breakpoint
CREATE INDEX `run_events_run_type` ON `run_events` (`run_id`,`type`);
