# Forge Native Agent Tool Suite Specification

This document tracks all 35 built-in tools and capabilities provided by the **Forge Native Agent**, categorized across core filesystem operations and 6 specialized functional domains.

---

## 1. Core Filesystem & System Tools (15 Tools)

- [x] **`read_file`**: Reads workspace file content with line range slicing (`start_line`, `end_line`), byte offset limits, and truncation safety.
- [x] **`write_to_file`**: Creates or overwrites files with workspace path sandboxing. (*Alias: `create_new_file`*)
- [x] **`replace_file_content`**: Performs contiguous single or multi-occurrence search-and-replace edits. (*Aliases: `edit_existing_file`, `single_find_and_replace`*)
- [x] **`list_dir`**: Lists directory contents, file sizes, and directory flags. (*Alias: `ls`*)
- [x] **`run_command`**: Executes terminal commands inside the workspace with timeout and output bounds. (*Alias: `run_terminal_command`*)
- [x] **`ask_question`**: Interactively prompts the user with questions and selectable choices in a modal dialog.
- [x] **`grep_search`**: Fast recursive regex or substring search across workspace files with line numbers and snippets.
- [x] **`file_glob_search`**: Recursive glob pattern search using Forge's audited `matchesGlob` domain engine.
- [x] **`view_diff`**: Inspects working changes (`git diff` or `git diff --staged`) with path filtering and truncation safeguards.
- [x] **`search_web`**: Lightweight live internet search via DuckDuckGo without external paid API keys.
- [x] **`fetch_url_content`**: HTTP GET content retriever converting web pages and documentation into clean, formatted markdown.
- [x] **`create_rule_block`**: Persists project and workspace behavioral rules into SQLite via `ProjectService.setRule` and `.forge/rules.md`.
- [x] **`request_rule`**: Retrieves active project rules from SQLite via `ProjectService.get` and `.forge/rules.md`.
- [x] **`read_skill`**: Reads specialized skill instructions from `.forge/skills/<name>/SKILL.md` or user global skill libraries.
- [x] **`read_currently_open_file`**: Directly retrieves the contents of the currently active file tab without requiring a path argument.

---

## 2. Advanced Functional Domains (20 Tools)

### Domain A: Task & Todo Checklist Tracking
- [x] **`todo_write`**: Updates the session task checklist (`todos: Array<{ id?: string, content: string, status: 'pending' | 'in_progress' | 'completed' }>`), persisting to `.forge/todos.json`.
- [x] **`task_create`**: Creates a tracked task item with subject, description, active continuous status form, and arbitrary metadata.
- [x] **`task_get`**: Retrieves full details, status, and metadata of a tracked task by `task_id`.
- [x] **`task_list`**: Lists tracked tasks filtered by status (`pending`, `in_progress`, `completed`, `all`).
- [x] **`task_update`**: Updates task status, subject, description, or metadata.
- [x] **`task_output`**: Retrieves stdout/stderr logs from a background task or subagent, with optional blocking wait (`block: boolean`, `timeout: number`).
- [x] **`task_stop`** (*Aliases: `kill_task`, `kill_shell`*): Terminates a running background task or process by `task_id`.

### Domain B: Planning Mode & Git Worktree Isolation
- [x] **`enter_plan_mode`**: Switches agent into read-only exploration mode; write tools return an advisory refusal directing the model to design the plan first.
- [x] **`exit_plan_mode`**: Exits plan mode, writes the design proposal to `.forge/plan.md`, and requests formal user approval before modifying files.
- [x] **`enter_worktree`**: Creates an isolated git worktree via `git worktree add` (under `.forge/worktrees/<name>`) and sets the active workspace context so edits don't dirty the user's primary repo.
- [x] **`exit_worktree`**: Switches workspace context back to primary repo root; keeps or cleans up (`git worktree remove`) the temporary worktree.

### Domain C: Code Intelligence & Jupyter Notebooks
- [x] **`notebook_edit`**: Safely modifies Jupyter Notebook (`.ipynb`) files cell by cell (`replace`, `insert`, `delete`), preserving notebook JSON structure and metadata.
- [x] **`lsp_query`** (*Alias: `lsp`*): Performs code intelligence operations:
  - `goToDefinition`: Locates symbol definition across files.
  - `findReferences`: Finds all references/usages across workspace.
  - `hover`: Provides type documentation/signatures.
  - `documentSymbol`: Lists functions/classes in a file.
  - `workspaceSymbol`: Searches symbols matching a query.

### Domain D: Subagents & Multi-Agent Collaboration
- [x] **`spawn_subagent`** (*Alias: `agent_task`*): Launches an isolated subagent run (`explore`, `plan`, `research`, `code`, `review`) with scoped tools in a separate context window, returning a consolidated summary report.
- [x] **`send_agent_message`** (*Alias: `send_message`*): Transmits direct messages to named agents or broadcasts (`"*"`) for multi-agent swarm collaboration.

### Domain E: MCP Resources & Dynamic Tool Discovery
- [x] **`list_mcp_resources`**: Lists available static and dynamic resources from configured MCP servers.
- [x] **`read_mcp_resource`**: Reads the contents of an MCP resource by server name and URI.
- [x] **`tool_search`**: Dynamically discovers and retrieves full parameter schemas for deferred tools on demand (`select:tool1,tool2` or keyword search), minimizing prompt token usage.

### Domain F: Scheduling & Automation Triggers
- [x] **`schedule_cron`** (*Aliases: `cron_create`, `cron_delete`, `cron_list`*): Manages scheduled tasks and recurring cron triggers (`create`, `delete`, `list`), with optional persistence to `.forge/scheduled_tasks.json`.
- [x] **`sleep_delay`** (*Alias: `sleep`*): Pauses execution for a specified duration (bounded 1-60 seconds) for proactive polling cycles.

---

## 3. Implementation Architecture

All tools are modularly organized:
```
src/main/providers/
├── tools.ts                      # Main entrypoint, re-exports, ToolContext, runTool router (35 tools total)
├── tools/                        # Domain-specific tool implementations
│   ├── taskTools.ts              # Domain A: todo_write, task_create, task_get, task_list, task_update, task_output, task_stop
│   ├── planTools.ts              # Domain B: enter_plan_mode, exit_plan_mode, enter_worktree, exit_worktree
│   ├── codeIntelTools.ts         # Domain C: notebook_edit, lsp_query
│   ├── subagentTools.ts          # Domain D: spawn_subagent, send_agent_message
│   ├── mcpTools.ts               # Domain E: list_mcp_resources, read_mcp_resource, tool_search
│   └── scheduleTools.ts          # Domain F: schedule_cron, sleep_delay
└── tools.test.ts                 # Comprehensive Vitest test suite for all tools (65 tests passing)
```
