CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`last_used_at` text,
	`created_at` text NOT NULL
);
