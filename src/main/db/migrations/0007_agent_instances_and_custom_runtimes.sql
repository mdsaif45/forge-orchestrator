CREATE TABLE `agent_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`provider` text NOT NULL,
	`account_id` text,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_instances_project` ON `agent_instances` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instances_project_name` ON `agent_instances` (`project_id`,`name`);
--> statement-breakpoint
CREATE TABLE `custom_runtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`args_template` text,
	`capabilities` text NOT NULL,
	`permission_mode` text NOT NULL,
	`instruction_filenames` text NOT NULL,
	`env` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_runtimes_slug_unique` ON `custom_runtimes` (`slug`);
