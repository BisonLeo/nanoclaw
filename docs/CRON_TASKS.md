# Cron and scheduled task lifecycle

This document explains how scheduled tasks are created and executed in NanoClaw.

## 1) Task creation flow

1. Inside the containerized MCP server, the `schedule_task` tool validates input (`cron`, `interval`, or `once`) and writes a JSON file into `/workspace/ipc/tasks`. The tool supports optional cross-group targeting for main group only. (`container/agent-runner/src/ipc-mcp-stdio.ts`)
2. On the host, `startIpcWatcher()` polls `data/ipc/<group>/tasks` every `IPC_POLL_INTERVAL` and calls `processTaskIpc(...)`. (`src/ipc.ts`)
3. `processTaskIpc` authorizes by source group:
   - main group can schedule for any registered target group
   - non-main groups can only schedule for themselves
4. The host computes `next_run`:
   - `cron`: parsed with `CronExpressionParser.parse(..., { tz: TIMEZONE })`
   - `interval`: now + milliseconds
   - `once`: parsed timestamp
5. The task is persisted in SQLite via `createTask(...)` into `scheduled_tasks`.

## 2) Storage model

Scheduled tasks are stored in `scheduled_tasks` with:

- `id`
- `group_folder`, `chat_jid`
- `prompt`
- `schedule_type`, `schedule_value`
- `context_mode` (`group` or `isolated`)
- `next_run`, `last_run`, `last_result`
- `status` (`active`, `paused`, `completed`)
- `created_at`

Execution history is stored in `task_run_logs`.

## 3) Scheduler execution loop

1. `startSchedulerLoop(...)` runs continuously and polls due tasks every `SCHEDULER_POLL_INTERVAL` (default 60s). (`src/task-scheduler.ts`, `src/config.ts`)
2. It queries DB with `getDueTasks()` (`status='active' AND next_run <= now`). (`src/db.ts`)
3. Each due task is re-fetched (`getTaskById`) before enqueueing to avoid running paused/cancelled tasks.
4. Execution is delegated through `GroupQueue.enqueueTask(...)`, then `runTask(...)` launches the container agent.
5. During run:
   - tasks snapshot is refreshed for tool visibility
   - optional session reuse occurs when `context_mode === 'group'`
   - output is forwarded to the target chat via `sendMessage`
   - run result/error is logged in `task_run_logs`
6. Post-run scheduling:
   - `cron`: compute next occurrence in configured timezone
   - `interval`: `Date.now() + ms`
   - `once`: no next run
7. `updateTaskAfterRun(...)` updates `next_run`, `last_run`, `last_result`; tasks with no `next_run` are marked `completed`.

## 4) Pause/resume/cancel flow

- `pause_task`, `resume_task`, and `cancel_task` are written as IPC task files by MCP.
- Host-side `processTaskIpc(...)` authorizes ownership (or main override), then updates or deletes DB records.

## 5) Timezone behavior

- Cron next-run calculation uses `TIMEZONE` from `process.env.TZ` or system timezone.
- The `schedule_task` tool description instructs users to provide local times.

## 6) Safety/edge handling

- Invalid schedules are rejected both in MCP tool validation and again in host IPC processing (defense-in-depth).
- If a stored task has an invalid legacy `group_folder`, scheduler pauses it to prevent retry churn.

## 7) Failure/recovery test playbook

Use this checklist to verify "cron is not missed", recovery behavior, and failure logging.

### A. Baseline: scheduler loop and due-task pickup

1. Start the app and verify scheduler startup log appears (`Scheduler loop started`).
2. Insert or create a task with `next_run` in the near future.
3. Confirm at/after due time that log shows `Found due tasks` and task execution begins.

Expected: task is discovered by `getDueTasks()` (`next_run <= now`) and enqueued.

### B. "Cron not missed" catch-up semantics (process pause/downtime)

This system polls DB and runs any task whose `next_run` is already in the past. To test:

1. Schedule a cron task (for example every minute).
2. Stop the app long enough to miss one or more scheduled boundaries.
3. Start the app again.
4. Check logs for immediate due-task detection and DB fields for updated `last_run` and a new `next_run`.

Expected: missed wall-clock boundary does not disappear silently; the overdue row is still due and runs on next scheduler cycle.

### C. Queue pressure/concurrency recovery

1. Create multiple due tasks across groups.
2. Optionally lower `MAX_CONCURRENT_CONTAINERS` to `1`.
3. Observe that tasks are queued via `GroupQueue` and drain as slots free up.

Expected: tasks are not dropped; queued tasks execute in later drain cycles.

### D. Early failure + log persistence

Use deterministic failure paths already covered by code:

1. Create a due task with invalid `group_folder` (or run the unit test).
2. Verify task is paused and `task_run_logs` contains an `error` entry.

Expected: retry churn is prevented (`status=paused`) and failure is persisted for diagnosis.

### E. Agent/runtime exception path

1. Force task execution failure (for example, break container/runtime config in a test environment).
2. Verify `Task failed` log appears and `task_run_logs` has `status='error'` with error text.

Expected: uncaught runtime errors are captured by scheduler `try/catch`, logged, and persisted to `task_run_logs`.

### F. Suggested verification commands

Run targeted automated checks:

```bash
npm test -- src/task-scheduler.test.ts src/ipc-auth.test.ts
```

Inspect DB after manual scenarios:

```bash
sqlite3 store/messages.db "SELECT id,schedule_type,schedule_value,status,next_run,last_run,last_result FROM scheduled_tasks ORDER BY created_at DESC LIMIT 20;"
sqlite3 store/messages.db "SELECT task_id,run_at,status,substr(error,1,120) FROM task_run_logs ORDER BY run_at DESC LIMIT 20;"
```

### G. Optional automated regression (recommended)

Add/maintain scheduler-focused tests for recovery semantics:

- Due-task pickup after restart when `next_run` is in the past
- Task run logging on thrown exceptions (`task_run_logs.status = error`)
- Cron reschedule correctness across timezone boundaries

These are best implemented in `src/task-scheduler.test.ts` with fake timers and test DB setup to make missed-run/catch-up behavior deterministic.

