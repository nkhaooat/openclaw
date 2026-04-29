# Heartbeat System Architecture Review

## Overview

The heartbeat system is **9,630 lines** across 22+ files. The core runner (`heartbeat-runner.ts`) alone is **1,595 lines**. It's the most complex subsystem in OpenClaw.

## Architecture Flow

```
Timer / Wake Event
       │
       ▼
startHeartbeatRunner.run()          ← scheduler loop (heartbeat-runner.ts:1316)
       │
       ▼
runHeartbeatOnce()                  ← single heartbeat execution (heartbeat-runner.ts:727)
       │
       ├─ Checks: enabled? active hours? queue busy?
       │
       ▼
resolveHeartbeatPreflight()         ← "should we run?" decision (heartbeat-runner.ts:551)
       │
       ├─ Peek pending system events (cron, exec completions)
       ├─ Read HEARTBEAT.md for tasks
       ├─ Check if tasks are due
       ├─ Skip reasons: empty-heartbeat-file, no-tasks-due, quiet-hours, requests-in-flight
       │
       ▼
resolveHeartbeatRunPrompt()         ← build the prompt (heartbeat-runner.ts:660)
       │
       ├─ Inject exec/cron event context
       ├─ Inject HEARTBEAT.md content
       ├─ Add task due-checking instructions
       │
       ▼
Agent Turn (full LLM call)         ← the expensive part
       │
       ├─ Sends prompt through normal agent loop
       ├─ Can use isolated session (empty transcript) to save tokens
       ├─ Response checked for HEARTBEAT_TOKEN
       │
       ▼
Delivery / Ack                      ← send result to channel or suppress
```

## Key Components

### 1. Scheduling (heartbeat-schedule.ts, heartbeat-runner.ts)

- Timer-based with `setTimeout` + `unref()`
- Phase-staggered per agent (avoids all agents firing at once)
- Wake events can trigger immediate runs (bypassing timer)
- Coalesce window prevents rapid re-fires

### 2. Preflight (heartbeat-runner.ts:551)

- **This is where Peek would hook in**
- Peeks system event queue (cron results, exec completions)
- Reads HEARTBEAT.md for task definitions
- Checks task due-times against `heartbeatTaskState`
- Returns skip reasons: `empty-heartbeat-file`, `no-tasks-due`, `quiet-hours`, `requests-in-flight`

### 3. Prompt Building (heartbeat-runner.ts:660)

- Merges: heartbeat prompt template + HEARTBEAT.md content + pending events
- For exec/cron events: injects event context as user message
- For task-based: adds "check if these tasks are due" instructions

### 4. Execution (heartbeat-runner.ts:727)

- Full agent turn through the normal conversation pipeline
- Optional isolated session (`isolatedSession: true`) — fresh transcript each run
- Session lane check — skips if main session is busy

### 5. Delivery (heartbeat-visibility.ts, heartbeat-runner.ts)

- Channel-aware: can send to Telegram, Discord, or suppress
- Visibility rules: `showOk`, `showAlerts`, `useIndicator`
- Typing indicators during heartbeat runs
- ACK max chars limit for short responses

### 6. Wake System (heartbeat-wake.ts, 355 lines)

- `requestHeartbeatNow()` — trigger immediate heartbeat
- Wake handler registration — single handler at a time
- Retry logic for requests-in-flight (1s default)
- Event types: interval, exec-completion, cron-event, wake

## Why "Peek" Is Hard

The heartbeat system doesn't have a separate "check" vs "execute" phase. The preflight (`resolveHeartbeatPreflight`) does peek at events and tasks, but it's deeply intertwined with:

1. **Session management** — loads session store, resolves delivery target
2. **Channel plugins** — needs channel for visibility rules
3. **Agent turn pipeline** — the actual "do work" part goes through the full agent loop
4. **Event consumption** — system events are drained after the run

A "peek" endpoint would need to:

- Run preflight (cheap — just reads session store + HEARTBEAT.md)
- Return the skip/due status WITHOUT entering the agent loop
- But: the agent loop is where the actual useful work happens (checking email, calendar, etc.)

**The real problem:** The heartbeat's value isn't in the preflight — it's in the agent turn that actually checks things. A peek that just says "2 tasks are due, 1 cron event pending" doesn't save much because the expensive part is the LLM call that processes those events.

## Possible Simpler Approaches

### Option A: Scratch-Based Heartbeat Cache

- During heartbeat, write results to `scratch` store:
  ```
  scratch.set("heartbeat:last_email_check", { count: 3, ts: "..." })
  scratch.set("heartbeat:last_calendar", { events: [...], ts: "..." })
  ```
- Next heartbeat can read scratch first and skip checks if recent
- No code changes to heartbeat system — just better HEARTBEAT.md instructions

### Option B: Configurable Isolated Heartbeat Model

- Use a cheaper/faster model for heartbeat runs
- Already supported: `heartbeat.model` config option
- Reduces cost without architectural changes

### Option C: Conditional Heartbeat Prompts

- HEARTBEAT.md can include conditional logic:
  ```
  - Check email only if scratch.get("last_email_ts") < now - 30min
  - Check calendar only if scratch.get("last_cal_ts") < now - 2h
  - Check weather only if scratch.get("last_weather_ts") < now - 4h
  ```
- Agent reads scratch first, skips checks that aren't due
- Reduces token waste within the agent turn itself

### Option D: True Peek API (Complex)

- New function: `peekHeartbeatStatus()` — runs preflight only, returns JSON
- New gateway endpoint: `GET /api/heartbeat/peek`
- Agent can call it before deciding to run full heartbeat
- Requires: extracting preflight from runner, adding HTTP route, adding tool
- **Estimated: 2-3 days, high risk of breaking existing behavior**

## Recommendation

**Option A + C** (scratch-based caching + conditional prompts) gives 80% of the benefit with 0 code changes to the heartbeat system. The agent already has scratch access; we just need to write smarter HEARTBEAT.md instructions.

**Option D** (true peek API) is only worth it if we need external systems to query heartbeat status (e.g., a dashboard widget). For our use case (reducing heartbeat cost), it's over-engineering.

## Existing Optimizations Already In Place

1. **Isolated sessions** — heartbeat can run with empty transcript (`isolatedSession: true`)
2. **Model override** — `heartbeat.model` config for cheaper model
3. **ACK max chars** — limits response size
4. **Active hours** — skip during quiet hours
5. **Queue checks** — skip if session is busy
6. **Task scheduling** — only run tasks when due (interval-based)
7. **Event filtering** — only inject relevant system events
8. **Preflight skip** — skip if HEARTBEAT.md is empty or no tasks due

---

_Created: 2026-04-29_
