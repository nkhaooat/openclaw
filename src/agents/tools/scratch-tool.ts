import { Type } from "typebox";
import { getScratchStore } from "../../sessions/scratch-store.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import type { AnyAgentTool } from "./common.js";

const SCRATCH_ACTIONS = ["get", "set", "delete", "list", "clear"] as const;
type ScratchAction = (typeof SCRATCH_ACTIONS)[number];

const ScratchToolSchema = Type.Object({
  op: Type.Union(SCRATCH_ACTIONS.map((a) => Type.Literal(a))),
  key: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  value: Type.Optional(Type.String()),
  ttlSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  prefix: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

export const SCRATCH_TOOL_DISPLAY_SUMMARY =
  "Persistent key-value store for temporary session state.";

export function createScratchTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  const sessionKey = opts?.agentSessionKey ?? "unknown";

  return {
    name: "scratch",
    label: "Scratch",
    description: [
      "Persistent key-value store scoped to your session for temporary working state.",
      "",
      "Operations:",
      "- get: Retrieve a value by key",
      "- set: Store a key-value pair (optionally with TTL in seconds)",
      "- delete: Remove a key",
      "- list: List all keys (optionally filtered by prefix)",
      "- clear: Remove all keys for this session",
      "",
      "Values persist across session restarts but are scoped to your session.",
      "Use for working state, partial results, cross-turn coordination, and short-lived caches.",
    ].join("\n"),
    parameters: ScratchToolSchema,
    displaySummary: SCRATCH_TOOL_DISPLAY_SUMMARY,
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const op = readStringParam(p, "op") as ScratchAction;
      const store = getScratchStore();
      if (!store) {
        return jsonResult({ error: "Scratch store not available" });
      }

      switch (op) {
        case "get": {
          const key = readStringParam(p, "key", { required: true });
          const value = store.get(sessionKey, key);
          if (value === null) {
            return jsonResult({ found: false, key });
          }
          return jsonResult({ found: true, key, value });
        }

        case "set": {
          const key = readStringParam(p, "key", { required: true });
          const value = readStringParam(p, "value", { required: true });
          const ttlSeconds =
            typeof (params as Record<string, unknown>).ttlSeconds === "number"
              ? ((params as Record<string, unknown>).ttlSeconds as number)
              : undefined;
          store.set(sessionKey, key, value, ttlSeconds);
          return jsonResult({ ok: true, key, ttlSeconds: ttlSeconds ?? null });
        }

        case "delete": {
          const key = readStringParam(p, "key", { required: true });
          const deleted = store.delete(sessionKey, key);
          return jsonResult({ ok: true, key, deleted });
        }

        case "list": {
          const prefix = readStringParam(p, "prefix");
          const keys = store.list(sessionKey, prefix || undefined);
          return jsonResult({ keys, count: keys.length });
        }

        case "clear": {
          const count = store.clear(sessionKey);
          return jsonResult({ ok: true, cleared: count });
        }

        default:
          throw new ToolInputError(`Unknown scratch operation: ${op}`);
      }
    },
  };
}
