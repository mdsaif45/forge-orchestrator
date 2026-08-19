CREATE TABLE `evidence_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`step_id` text NOT NULL,
	`kind` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`outcome` text NOT NULL,
	`exit_code` integer,
	`duration_ms` integer NOT NULL,
	`stdout` text NOT NULL,
	`stderr` text NOT NULL,
	`truncated` integer NOT NULL,
	`counts` text,
	`failure` text,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evidence_artifacts_step` ON `evidence_artifacts` (`step_id`,`recorded_at`);