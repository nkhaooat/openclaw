import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { logWarn } from "../logger.js";
import { requireNodeSqlite } from "../memory-host-sdk/host/sqlite.js";

type DatabaseSync = import("node:sqlite").DatabaseSync;

let dbInstance: DatabaseSync | null = null;
let schemaInitialized = false;

const MAX_KEYS_PER_SESSION = 100;
const MAX_VALUE_SIZE_BYTES = 10 * 1024; // 10KB

function getDbPath(): string {
  const dir = path.join(resolveStateDir(), "scratch");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "scratch.db");
}

function getDb(): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const dbPath = getDbPath();
  dbInstance = new DatabaseSync(dbPath);
  dbInstance.exec("PRAGMA journal_mode=WAL;");
  dbInstance.exec("PRAGMA busy_timeout=5000;");
  return dbInstance;
}

function ensureSchema(): void {
  if (schemaInitialized) {
    return;
  }
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_scratch (
      session_key TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      expires_at INTEGER,
      PRIMARY KEY (session_key, key)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scratch_session
    ON session_scratch(session_key);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scratch_expires
    ON session_scratch(expires_at)
    WHERE expires_at IS NOT NULL;
  `);
  schemaInitialized = true;
}

export class ScratchStore {
  private db: DatabaseSync;

  constructor() {
    ensureSchema();
    this.db = getDb();
  }

  get(sessionKey: string, key: string): string | null {
    this.cleanupExpired();
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(
      "SELECT value FROM session_scratch WHERE session_key = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
    );
    const row = stmt.get(sessionKey, key, now) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(sessionKey: string, key: string, value: string, ttlSeconds?: number): void {
    const now = Math.floor(Date.now() / 1000);

    // Enforce max keys per session
    const countStmt = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM session_scratch WHERE session_key = ?",
    );
    const countRow = countStmt.get(sessionKey) as { cnt: number } | undefined;
    const currentCount = countRow?.cnt ?? 0;

    // Check if key already exists (update, not insert)
    const existsStmt = this.db.prepare(
      "SELECT 1 FROM session_scratch WHERE session_key = ? AND key = ?",
    );
    const exists = existsStmt.get(sessionKey, key);

    if (!exists && currentCount >= MAX_KEYS_PER_SESSION) {
      throw new Error(
        `Scratch store limit reached: ${MAX_KEYS_PER_SESSION} keys per session. Delete unused keys first.`,
      );
    }

    // Enforce max value size
    const byteLength = Buffer.byteLength(value, "utf8");
    if (byteLength > MAX_VALUE_SIZE_BYTES) {
      throw new Error(`Value too large: ${byteLength} bytes (max ${MAX_VALUE_SIZE_BYTES}).`);
    }

    const expiresAt = ttlSeconds && ttlSeconds > 0 ? now + ttlSeconds : null;

    const stmt = this.db.prepare(`
      INSERT INTO session_scratch (session_key, key, value, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_key, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `);
    stmt.run(sessionKey, key, value, now, expiresAt);
  }

  delete(sessionKey: string, key: string): boolean {
    const stmt = this.db.prepare("DELETE FROM session_scratch WHERE session_key = ? AND key = ?");
    const result = stmt.run(sessionKey, key);
    return (result.changes ?? 0) > 0;
  }

  list(sessionKey: string, prefix?: string): string[] {
    this.cleanupExpired();
    const now = Math.floor(Date.now() / 1000);
    let stmt;
    let rows;

    if (prefix) {
      stmt = this.db.prepare(
        "SELECT key FROM session_scratch WHERE session_key = ? AND key LIKE ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key",
      );
      rows = stmt.all(sessionKey, `${prefix}%`, now) as Array<{ key: string }>;
    } else {
      stmt = this.db.prepare(
        "SELECT key FROM session_scratch WHERE session_key = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key",
      );
      rows = stmt.all(sessionKey, now) as Array<{ key: string }>;
    }

    return rows.map((r) => r.key);
  }

  clear(sessionKey: string): number {
    const stmt = this.db.prepare("DELETE FROM session_scratch WHERE session_key = ?");
    const result = stmt.run(sessionKey);
    return result.changes ?? 0;
  }

  /**
   * Delete all entries for sessions that no longer exist.
   * Called periodically or on session deletion.
   */
  deleteSession(sessionKey: string): number {
    return this.clear(sessionKey);
  }

  /**
   * Remove expired entries. Called automatically on get/list operations.
   */
  private cleanupExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    try {
      const stmt = this.db.prepare(
        "DELETE FROM session_scratch WHERE expires_at IS NOT NULL AND expires_at <= ?",
      );
      stmt.run(now);
    } catch {
      // Ignore cleanup errors — non-critical
    }
  }
}

let storeInstance: ScratchStore | null = null;

export function getScratchStore(): ScratchStore | null {
  try {
    if (!storeInstance) {
      storeInstance = new ScratchStore();
    }
    return storeInstance;
  } catch (err) {
    logWarn("scratch-store", "Failed to initialize scratch store", err);
    return null;
  }
}
