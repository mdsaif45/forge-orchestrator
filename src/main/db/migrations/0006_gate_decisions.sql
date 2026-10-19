ALTER TABLE `decisions` ADD `workflow_id` text REFERENCES workflows(id);
--> statement-breakpoint
ALTER TABLE `decisions` ADD `graph_run_id` text REFERENCES graph_runs(id);
--> statement-breakpoint
ALTER TABLE `decisions` ADD `node_id` text;
--> statement-breakpoint
ALTER TABLE `decisions` ADD `gate_verdict` text;
--> statement-breakpoint
CREATE INDEX `decisions_gate_scope` ON `decisions` (`graph_run_id`,`node_id`);
