# Session Scratch Space — Feature Design

## Problem

Subagents and main sessions have no persistent scratch space that survives across turns without eating context tokens. Current options:

- **Files on disk** — works, but clutters workspace, requires explicit paths
- **Memory tools** — designed for long-term curated facts, not temporary working state
- **Context variables** — lost between turns, eat tokens

We need a lightweight key-value store per session for:

- Temporary working state ("currently editing file X")
- Partial results from multi-turn tasks
- Coordination data between parent and subagents
- Short-lived caches that shouldn't persist forever

## Solution

**New tool: `scratch`** — persistent key-value store scoped to session.

### Operations

```typescript
// Set a value
scratch.set({ key: "current_file", value: "/path/to/file.ts" });
scratch.set({ key: "draft_response", value: "..." });

// Get a value
scratch.get({ key: "current_file" }); // → "/path/to/file.ts"

// Delete a value
scratch.delete({ key: "draft_response" });

// List all keys (optionally with prefix filter)
scratch.list(); // → ["current_file", "draft_response", ...]
scratch.list({ prefix: "draft_" }); // → ["draft_response"]

// Clear all (optional, dangerous)
scratch.clear(); // confirm required
```

### Storage Backend

**SQLite table** (co-located with session state):

```sql
CREATE TABLE session_scratch (
  session_key TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ttl_seconds INTEGER,  -- optional expiry
  PRIMARY KEY (session_key, key)
);

CREATE INDEX idx_scratch_session ON session_scratch(session_key);
CREATE INDEX idx_scratch_ttl ON session_scratch(ttl_seconds) WHERE ttl_seconds IS NOT NULL;
```

### Lifecycle

- **Created:** First `scratch.set()` call for a session
- **Persisted:** Survives session restarts, gateway restarts
- **Expired:** Entries with `ttl_seconds` auto-deleted on access or periodic cleanup
- **Deleted:** When session is deleted, or via `scratch.clear()`

### API Location

```typescript
// src/sessions/scratch-store.ts
export class ScratchStore {
  constructor(private db: Database);

  async get(sessionKey: string, key: string): Promise<string | null>;
  async set(sessionKey: string, key: string, value: string, ttlSeconds?: number): Promise<void>;
  async delete(sessionKey: string, key: string): Promise<void>;
  async list(sessionKey: string, prefix?: string): Promise<string[]>;
  async clear(sessionKey: string): Promise<void>;
  async cleanupExpired(): Promise<number>; // periodic cleanup
}
```

### Tool Definition

```typescript
// src/agents/pi-tools.ts
const scratchTool: ToolDefinition = {
  name: "scratch",
  description:
    "Persistent key-value store for temporary session state. Use for working state, partial results, and cross-turn coordination. Values persist across session restarts but are scoped to your session.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["get", "set", "delete", "list", "clear"] },
      key: { type: "string" },
      value: { type: "string" },
      ttlSeconds: { type: "number" },
      prefix: { type: "string" },
    },
    required: ["op"],
  },
  // Permissions: available to main session and subagents
  // No elevated permissions needed
};
```

### Config Options

```json5
{
  agents: {
    defaults: {
      scratch: {
        enabled: true, // default: true
        maxKeysPerSession: 50, // default: 50
        maxValueSizeBytes: 10000, // default: 10KB per value
        defaultTtlSeconds: 86400, // default: 24h (0 = no expiry)
        cleanupIntervalHours: 6, // periodic expired-entry cleanup
      },
    },
  },
}
```

### Usage Patterns

**1. Working state across turns:**

```
Turn 1: "I'm starting to refactor the auth module"
→ scratch.set("current_task", "refactor auth module")
→ scratch.set("files_touched", '["auth.ts", "session.ts"]')

Turn 2: "Continue where I left off"
→ scratch.get("current_task") → "refactor auth module"
→ scratch.get("files_touched") → [...]
```

**2. Parent-subagent coordination:**

```
Parent spawns subagent:
→ scratch.set("subagent_7442_task", "research API endpoints")

Subagent completes:
→ scratch.set("subagent_7442_result", '{"endpoints": [...]}')

Parent checks:
→ scratch.get("subagent_7442_result")
```

**3. Temporary cache:**

```
"Cache this API response for 1 hour"
→ scratch.set("api_cache_users", jsonData, ttlSeconds: 3600)
```

### Migration Plan

**Phase 1: Core implementation (2-3 days)**

1. Create `src/sessions/scratch-store.ts` — CRUD + cleanup
2. Add SQLite migration — create table, indexes
3. Add tool definition in `src/agents/pi-tools.ts`
4. Wire tool into agent tool registry
5. Add config schema + defaults
6. Write tests (unit + integration)

**Phase 2: Integration (1 day)**

1. Add to subagent tool allowlist (already done in our fork)
2. Update docs — tools reference, session guide
3. Add example usage to AGENTS.md or skills

**Phase 3: Optional enhancements**

1. Compression for large values (>1KB)
2. Version history (keep last N values per key)
3. Export/import for session migration

### Files to Modify

| File                                      | Change                              |
| ----------------------------------------- | ----------------------------------- |
| `src/sessions/scratch-store.ts`           | **New file** — store implementation |
| `src/sessions/session-db.ts`              | Add table migration                 |
| `src/agents/pi-tools.ts`                  | Add scratch tool definition         |
| `src/agents/tools-effective-inventory.ts` | Include scratch in inventory        |
| `src/config/schema.base.generated.ts`     | Add scratch config keys             |
| `src/config/types.agent-defaults.ts`      | Add ScratchConfig type              |
| `src/agents/pi-tools.policy.ts`           | Ensure subagents have access        |
| `docs/tools/scratch.md`                   | **New file** — user docs            |

### Testing Checklist

- [ ] `scratch.set()` + `scratch.get()` round-trip
- [ ] `scratch.delete()` removes key
- [ ] `scratch.list()` returns keys, respects prefix filter
- [ ] TTL expiry works (mock time)
- [ ] Cleanup job deletes expired entries
- [ ] Session isolation (can't access other session's scratch)
- [ ] Subagent can read/write scratch in parent session
- [ ] Max keys limit enforced
- [ ] Max value size enforced
- [ ] Survives gateway restart
- [ ] Deleted on session deletion

---

_Design draft — ready for implementation_
