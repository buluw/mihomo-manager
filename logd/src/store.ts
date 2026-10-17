import { DatabaseSync } from "node:sqlite";
import type { LogQuery, NewLogEntry, StoredLogEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class LogStore {
  private readonly db: DatabaseSync;
  private readonly insertStatement;

  constructor(path: string, defaultRetentionDays = 7) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS logs_timestamp_idx ON logs(timestamp);
      CREATE INDEX IF NOT EXISTS logs_level_id_idx ON logs(level, id);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('retentionDays', ?)")
      .run(String(defaultRetentionDays));
    this.insertStatement = this.db.prepare(
      "INSERT INTO logs(timestamp, level, message) VALUES(?, ?, ?)",
    );
  }

  insert(entries: NewLogEntry[]): StoredLogEntry[] {
    if (entries.length === 0) return [];
    const stored: StoredLogEntry[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        const result = this.insertStatement.run(entry.timestamp, entry.level, entry.message);
        stored.push({
          id: String(result.lastInsertRowid),
          ...entry,
          line: `level=${entry.level} ${entry.message}`,
        });
      }
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(query: LogQuery): StoredLogEntry[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.beforeId != null) {
      clauses.push("id < ?");
      parameters.push(query.beforeId);
    }
    if (query.level) {
      clauses.push("level = ?");
      parameters.push(query.level);
    }
    if (query.search) {
      clauses.push("instr(lower(message), lower(?)) > 0");
      parameters.push(query.search);
    }
    if (query.since != null) {
      clauses.push("timestamp >= ?");
      parameters.push(query.since);
    }
    if (query.until != null) {
      clauses.push("timestamp <= ?");
      parameters.push(query.until);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT id, timestamp, level, message FROM logs ${where} ORDER BY id DESC LIMIT ?`,
    ).all(...parameters, query.limit) as Array<{
      id: number;
      timestamp: number;
      level: string;
      message: string;
    }>;
    return rows.reverse().map((row) => ({
      id: String(row.id),
      timestamp: row.timestamp,
      level: row.level,
      message: row.message,
      line: `level=${row.level} ${row.message}`,
    }));
  }

  retentionDays() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='retentionDays'")
      .get() as { value: string } | undefined;
    return Number(row?.value || 7);
  }

  setRetentionDays(days: number) {
    this.db.prepare(
      "INSERT INTO settings(key, value) VALUES('retentionDays', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(String(days));
    return this.purge();
  }

  purge(now = Date.now()) {
    const cutoff = now - this.retentionDays() * DAY_MS;
    const result = this.db.prepare("DELETE FROM logs WHERE timestamp < ?").run(cutoff);
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    return Number(result.changes);
  }

  close() {
    this.db.close();
  }
}
