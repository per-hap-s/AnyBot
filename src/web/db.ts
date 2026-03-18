import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { getDataDir } from "../runtime-paths.js";

export type ChatSession = {
  id: string;
  title: string;
  sessionId: string | null;
  source: string;
  chatId: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string; metadata?: string | null }>;
  createdAt: number;
  updatedAt: number;
};

export type SessionSummary = {
  id: string;
  title: string;
  source: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type RecoverableChannelSession = {
  source: string;
  chatId: string;
  sessionId: string;
  updatedAt: number;
};

export type TelegramMessageRef = {
  chatId: string;
  messageId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

export type MemoryEntry = {
  id: string;
  scope: string;
  sourceType: string;
  sourceRef: string | null;
  text: string;
  textHash: string;
  confidence: number;
  durability: "ephemeral" | "medium" | "long_term_candidate";
  status: "active" | "superseded" | "rejected";
  embeddingStatus: "pending" | "ready" | "failed";
  embeddingModel: string | null;
  embeddingJson: string | null;
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt: number | null;
};

export type MemoryJob = {
  id: string;
  kind: string;
  dedupeKey: string;
  payloadJson: string;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  lastError: string | null;
  runAfter: number;
  createdAt: number;
  updatedAt: number;
};

export type CanonicalMemory = {
  id: string;
  scope: string;
  text: string;
  textHash: string;
  confidence: number;
  status: "active" | "superseded" | "rejected";
  embeddingStatus: "pending" | "ready" | "failed";
  embeddingModel: string | null;
  embeddingJson: string | null;
  sourceJson: string | null;
  createdAt: number;
  updatedAt: number;
  lastPromotedAt: number | null;
};

const dataDir = getDataDir();
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "chat.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '新对话',
    session_id TEXT,
    source     TEXT NOT NULL DEFAULT 'web',
    chat_id    TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

  CREATE TABLE IF NOT EXISTS telegram_message_refs (
    chat_id     TEXT NOT NULL,
    message_id  INTEGER NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_telegram_message_refs_chat_created
  ON telegram_message_refs(chat_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS memory_entries (
    id                TEXT PRIMARY KEY,
    scope             TEXT NOT NULL,
    source_type       TEXT NOT NULL,
    source_ref        TEXT,
    text              TEXT NOT NULL,
    text_hash         TEXT NOT NULL,
    confidence        REAL NOT NULL DEFAULT 0,
    durability        TEXT NOT NULL DEFAULT 'medium',
    status            TEXT NOT NULL DEFAULT 'active',
    embedding_status  TEXT NOT NULL DEFAULT 'pending',
    embedding_model   TEXT,
    embedding_json    TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    last_confirmed_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entries_scope_hash
  ON memory_entries(scope, text_hash);

  CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_status_created
  ON memory_entries(scope, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS canonical_memories (
    id               TEXT PRIMARY KEY,
    scope            TEXT NOT NULL,
    text             TEXT NOT NULL,
    text_hash        TEXT NOT NULL,
    confidence       REAL NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active',
    embedding_status TEXT NOT NULL DEFAULT 'pending',
    embedding_model  TEXT,
    embedding_json   TEXT,
    source_json      TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    last_promoted_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_memories_scope_hash
  ON canonical_memories(scope, text_hash);

  CREATE INDEX IF NOT EXISTS idx_canonical_memories_scope_status_updated
  ON canonical_memories(scope, status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS memory_jobs (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    dedupe_key   TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    run_after    INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_jobs_dedupe
  ON memory_jobs(kind, dedupe_key);

  CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_run_after
  ON memory_jobs(status, run_after);
`);

try {
  db.exec(`ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'web'`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN chat_id TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE messages ADD COLUMN metadata TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE canonical_memories ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending'`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE canonical_memories ADD COLUMN embedding_model TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE canonical_memories ADD COLUMN embedding_json TEXT`);
} catch (_) {}

db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_source_chat ON sessions(source, chat_id)`);;

const stmts = {
  listSessions: db.prepare(`
    SELECT s.id, s.title, s.source, s.created_at AS createdAt, s.updated_at AS updatedAt,
           COUNT(m.id) AS messageCount
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
  `),

  getSession: db.prepare(`
    SELECT id, title, session_id AS sessionId, source, chat_id AS chatId,
           created_at AS createdAt, updated_at AS updatedAt
    FROM sessions WHERE id = ?
  `),

  getMessages: db.prepare(`
    SELECT role, content, metadata FROM messages
    WHERE session_id = ? ORDER BY id ASC
  `),

  insertSession: db.prepare(`
    INSERT INTO sessions (id, title, session_id, source, chat_id, created_at, updated_at)
    VALUES (@id, @title, @sessionId, @source, @chatId, @createdAt, @updatedAt)
  `),

  updateSession: db.prepare(`
    UPDATE sessions SET title = @title, session_id = @sessionId, updated_at = @updatedAt
    WHERE id = @id
  `),

  deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),

  insertMessage: db.prepare(`
    INSERT INTO messages (session_id, role, content, metadata) VALUES (?, ?, ?, ?)
  `),

  findBySourceChat: db.prepare(`
    SELECT id, title, session_id AS sessionId, source, chat_id AS chatId,
           created_at AS createdAt, updated_at AS updatedAt
    FROM sessions WHERE source = ? AND chat_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `),

  detachChatId: db.prepare(`
    UPDATE sessions SET chat_id = NULL WHERE source = ? AND chat_id = ?
  `),

  listRecoverableChannelSessions: db.prepare(`
    SELECT
      s.source,
      s.chat_id AS chatId,
      s.session_id AS sessionId,
      s.updated_at AS updatedAt
    FROM sessions s
    WHERE s.source != 'web'
      AND s.chat_id IS NOT NULL
      AND s.chat_id != ''
      AND s.session_id IS NOT NULL
      AND s.session_id != ''
      AND s.id = (
        SELECT s2.id
        FROM sessions s2
        WHERE s2.source = s.source
          AND s2.chat_id = s.chat_id
          AND s2.session_id IS NOT NULL
          AND s2.session_id != ''
        ORDER BY s2.updated_at DESC, s2.id DESC
        LIMIT 1
      )
    ORDER BY s.updated_at DESC
  `),

  detachAllChannelSessions: db.prepare(`
    UPDATE sessions SET chat_id = NULL WHERE source != 'web' AND chat_id IS NOT NULL
  `),

  upsertTelegramMessageRef: db.prepare(`
    INSERT INTO telegram_message_refs (chat_id, message_id, role, content, created_at)
    VALUES (@chatId, @messageId, @role, @content, @createdAt)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      role = excluded.role,
      content = excluded.content,
      created_at = excluded.created_at
  `),

  findTelegramMessageRef: db.prepare(`
    SELECT
      chat_id AS chatId,
      message_id AS messageId,
      role,
      content,
      created_at AS createdAt
    FROM telegram_message_refs
    WHERE chat_id = ? AND message_id = ?
    LIMIT 1
  `),

  upsertMemoryEntry: db.prepare(`
    INSERT INTO memory_entries (
      id, scope, source_type, source_ref, text, text_hash, confidence,
      durability, status, embedding_status, embedding_model, embedding_json,
      created_at, updated_at, last_confirmed_at
    ) VALUES (
      @id, @scope, @sourceType, @sourceRef, @text, @textHash, @confidence,
      @durability, @status, @embeddingStatus, @embeddingModel, @embeddingJson,
      @createdAt, @updatedAt, @lastConfirmedAt
    )
    ON CONFLICT(scope, text_hash) DO UPDATE SET
      source_type = excluded.source_type,
      source_ref = excluded.source_ref,
      text = excluded.text,
      confidence = MAX(memory_entries.confidence, excluded.confidence),
      durability = excluded.durability,
      status = excluded.status,
      embedding_status = excluded.embedding_status,
      embedding_model = excluded.embedding_model,
      embedding_json = excluded.embedding_json,
      updated_at = excluded.updated_at,
      last_confirmed_at = COALESCE(excluded.last_confirmed_at, memory_entries.last_confirmed_at)
  `),

  listMemoryEntriesByScope: db.prepare(`
    SELECT
      id,
      scope,
      source_type AS sourceType,
      source_ref AS sourceRef,
      text,
      text_hash AS textHash,
      confidence,
      durability,
      status,
      embedding_status AS embeddingStatus,
      embedding_model AS embeddingModel,
      embedding_json AS embeddingJson,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_confirmed_at AS lastConfirmedAt
    FROM memory_entries
    WHERE scope = ?
    ORDER BY updated_at DESC
  `),

  listActiveMemoryEntries: db.prepare(`
    SELECT
      id,
      scope,
      source_type AS sourceType,
      source_ref AS sourceRef,
      text,
      text_hash AS textHash,
      confidence,
      durability,
      status,
      embedding_status AS embeddingStatus,
      embedding_model AS embeddingModel,
      embedding_json AS embeddingJson,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_confirmed_at AS lastConfirmedAt
    FROM memory_entries
    WHERE status = 'active'
    ORDER BY updated_at DESC
  `),

  listCanonicalMemoriesByScope: db.prepare(`
    SELECT
      id,
      scope,
      text,
      text_hash AS textHash,
      confidence,
      status,
      embedding_status AS embeddingStatus,
      embedding_model AS embeddingModel,
      embedding_json AS embeddingJson,
      source_json AS sourceJson,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_promoted_at AS lastPromotedAt
    FROM canonical_memories
    WHERE scope = ?
    ORDER BY updated_at DESC
  `),

  getCanonicalMemoryByScopeHash: db.prepare(`
    SELECT
      id,
      scope,
      text,
      text_hash AS textHash,
      confidence,
      status,
      embedding_status AS embeddingStatus,
      embedding_model AS embeddingModel,
      embedding_json AS embeddingJson,
      source_json AS sourceJson,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_promoted_at AS lastPromotedAt
    FROM canonical_memories
    WHERE scope = ? AND text_hash = ?
    LIMIT 1
  `),

  getCanonicalMemoryById: db.prepare(`
    SELECT
      id,
      scope,
      text,
      text_hash AS textHash,
      confidence,
      status,
      embedding_status AS embeddingStatus,
      embedding_model AS embeddingModel,
      embedding_json AS embeddingJson,
      source_json AS sourceJson,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_promoted_at AS lastPromotedAt
    FROM canonical_memories
    WHERE id = ?
    LIMIT 1
  `),

  upsertCanonicalMemory: db.prepare(`
    INSERT INTO canonical_memories (
      id, scope, text, text_hash, confidence, status,
      embedding_status, embedding_model, embedding_json, source_json,
      created_at, updated_at, last_promoted_at
    ) VALUES (
      @id, @scope, @text, @textHash, @confidence, @status,
      @embeddingStatus, @embeddingModel, @embeddingJson, @sourceJson,
      @createdAt, @updatedAt, @lastPromotedAt
    )
    ON CONFLICT(scope, text_hash) DO UPDATE SET
      text = excluded.text,
      confidence = excluded.confidence,
      status = excluded.status,
      embedding_status = excluded.embedding_status,
      embedding_model = excluded.embedding_model,
      embedding_json = excluded.embedding_json,
      source_json = excluded.source_json,
      updated_at = excluded.updated_at,
      last_promoted_at = excluded.last_promoted_at
  `),

  updateCanonicalMemoryStatus: db.prepare(`
    UPDATE canonical_memories
    SET
      status = @status,
      updated_at = @updatedAt,
      last_promoted_at = @lastPromotedAt
    WHERE id = @id
  `),

  updateCanonicalMemoryEmbedding: db.prepare(`
    UPDATE canonical_memories
    SET
      embedding_status = @embeddingStatus,
      embedding_model = @embeddingModel,
      embedding_json = @embeddingJson,
      updated_at = @updatedAt
    WHERE id = @id
  `),

  getMemoryEntryById: db.prepare(`
    SELECT
      id,
      scope,
      source_type AS sourceType,
      source_ref AS sourceRef,
      text,
      text_hash AS textHash,
      confidence,
      durability,
      status,
      embedding_status AS embeddingStatus,
      embedding_model AS embeddingModel,
      embedding_json AS embeddingJson,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_confirmed_at AS lastConfirmedAt
    FROM memory_entries
    WHERE id = ?
    LIMIT 1
  `),

  getMemoryEntryByScopeHash: db.prepare(`
    SELECT
      id,
      scope,
      source_type AS sourceType,
      source_ref AS sourceRef,
      text,
      text_hash AS textHash,
      confidence,
      durability,
      status,
      embedding_status AS embeddingStatus,
      embedding_model AS embeddingModel,
      embedding_json AS embeddingJson,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_confirmed_at AS lastConfirmedAt
    FROM memory_entries
    WHERE scope = ? AND text_hash = ?
    LIMIT 1
  `),

  insertMemoryJob: db.prepare(`
    INSERT INTO memory_jobs (
      id, kind, dedupe_key, payload_json, status, attempts, last_error,
      run_after, created_at, updated_at
    ) VALUES (
      @id, @kind, @dedupeKey, @payloadJson, @status, @attempts, @lastError,
      @runAfter, @createdAt, @updatedAt
    )
    ON CONFLICT(kind, dedupe_key) DO NOTHING
  `),

  listDueMemoryJobs: db.prepare(`
    SELECT
      id,
      kind,
      dedupe_key AS dedupeKey,
      payload_json AS payloadJson,
      status,
      attempts,
      last_error AS lastError,
      run_after AS runAfter,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM memory_jobs
    WHERE status = 'pending' AND run_after <= ?
    ORDER BY run_after ASC, created_at ASC
    LIMIT ?
  `),

  updateMemoryJobStatus: db.prepare(`
    UPDATE memory_jobs
    SET
      status = @status,
      attempts = @attempts,
      last_error = @lastError,
      run_after = @runAfter,
      updated_at = @updatedAt
    WHERE id = @id
  `),

  claimMemoryJobRunning: db.prepare(`
    UPDATE memory_jobs
    SET
      status = 'running',
      attempts = @attempts,
      last_error = NULL,
      updated_at = @updatedAt
    WHERE id = @id
      AND status = 'pending'
  `),

  resetRunningMemoryJobs: db.prepare(`
    UPDATE memory_jobs
    SET
      status = 'pending',
      run_after = @runAfter,
      updated_at = @updatedAt
    WHERE status = 'running'
  `),

  updateMemoryEntryStatus: db.prepare(`
    UPDATE memory_entries
    SET
      status = @status,
      updated_at = @updatedAt,
      last_confirmed_at = @lastConfirmedAt
    WHERE id = @id
  `),
};

export function listSessions(): SessionSummary[] {
  return stmts.listSessions.all() as SessionSummary[];
}

export function getSession(id: string): ChatSession | null {
  const row = stmts.getSession.get(id) as
    | {
        id: string;
        title: string;
        sessionId: string | null;
        source: string;
        chatId: string | null;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;
  if (!row) return null;

  const messages = stmts.getMessages.all(id) as Array<{
    role: "user" | "assistant";
    content: string;
    metadata: string | null;
  }>;

  return { ...row, messages };
}

export function createSession(session: ChatSession): void {
  stmts.insertSession.run({
    id: session.id,
    title: session.title,
    sessionId: session.sessionId,
    source: session.source || "web",
    chatId: session.chatId || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
}

export function findSessionBySourceChat(
  source: string,
  chatId: string,
): ChatSession | null {
  const row = stmts.findBySourceChat.get(source, chatId) as
    | {
        id: string;
        title: string;
        sessionId: string | null;
        source: string;
        chatId: string | null;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;
  if (!row) return null;
  const messages = stmts.getMessages.all(row.id) as Array<{
    role: "user" | "assistant";
    content: string;
    metadata: string | null;
  }>;
  return { ...row, messages };
}

export function updateSession(session: {
  id: string;
  title: string;
  sessionId: string | null;
  updatedAt: number;
}): void {
  stmts.updateSession.run({
    id: session.id,
    title: session.title,
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
  });
}

export function deleteSession(id: string): void {
  stmts.deleteSession.run(id);
}

export function addMessage(sessionId: string, role: "user" | "assistant", content: string, metadata?: string | null): void {
  stmts.insertMessage.run(sessionId, role, content, metadata || null);
}

export function detachChatId(source: string, chatId: string): void {
  stmts.detachChatId.run(source, chatId);
}

export function listRecoverableChannelSessions(): RecoverableChannelSession[] {
  return stmts.listRecoverableChannelSessions.all() as RecoverableChannelSession[];
}

export function detachAllChannelSessions(): void {
  stmts.detachAllChannelSessions.run();
}

export function closeDb(): void {
  db.close();
}

export function saveTelegramMessageRef(ref: TelegramMessageRef): void {
  stmts.upsertTelegramMessageRef.run({
    chatId: ref.chatId,
    messageId: ref.messageId,
    role: ref.role,
    content: ref.content,
    createdAt: ref.createdAt,
  });
}

export function findTelegramMessageRef(
  chatId: string,
  messageId: number,
): TelegramMessageRef | null {
  const row = stmts.findTelegramMessageRef.get(chatId, messageId) as TelegramMessageRef | undefined;
  return row || null;
}

export function upsertMemoryEntry(entry: MemoryEntry): void {
  stmts.upsertMemoryEntry.run(entry);
}

export function listMemoryEntriesByScope(scope: string): MemoryEntry[] {
  return stmts.listMemoryEntriesByScope.all(scope) as MemoryEntry[];
}

export function listActiveMemoryEntries(): MemoryEntry[] {
  return stmts.listActiveMemoryEntries.all() as MemoryEntry[];
}

export function getMemoryEntryById(id: string): MemoryEntry | null {
  const row = stmts.getMemoryEntryById.get(id) as MemoryEntry | undefined;
  return row || null;
}

export function listCanonicalMemoriesByScope(scope: string): CanonicalMemory[] {
  return stmts.listCanonicalMemoriesByScope.all(scope) as CanonicalMemory[];
}

export function getCanonicalMemoryByScopeHash(scope: string, textHash: string): CanonicalMemory | null {
  const row = stmts.getCanonicalMemoryByScopeHash.get(scope, textHash) as CanonicalMemory | undefined;
  return row || null;
}

export function getCanonicalMemoryById(id: string): CanonicalMemory | null {
  const row = stmts.getCanonicalMemoryById.get(id) as CanonicalMemory | undefined;
  return row || null;
}

export function upsertCanonicalMemory(memory: CanonicalMemory): void {
  stmts.upsertCanonicalMemory.run(memory);
}

export function updateCanonicalMemoryStatus(memory: {
  id: string;
  status: CanonicalMemory["status"];
  updatedAt: number;
  lastPromotedAt: number | null;
}): void {
  stmts.updateCanonicalMemoryStatus.run(memory);
}

export function updateCanonicalMemoryEmbedding(memory: {
  id: string;
  embeddingStatus: CanonicalMemory["embeddingStatus"];
  embeddingModel: string | null;
  embeddingJson: string | null;
  updatedAt: number;
}): void {
  stmts.updateCanonicalMemoryEmbedding.run(memory);
}

export function getMemoryEntryByScopeHash(scope: string, textHash: string): MemoryEntry | null {
  const row = stmts.getMemoryEntryByScopeHash.get(scope, textHash) as MemoryEntry | undefined;
  return row || null;
}

export function enqueueMemoryJob(job: MemoryJob): boolean {
  const result = stmts.insertMemoryJob.run(job) as Database.RunResult;
  return result.changes > 0;
}

export function listDueMemoryJobs(now: number, limit: number): MemoryJob[] {
  return stmts.listDueMemoryJobs.all(now, limit) as MemoryJob[];
}

export function updateMemoryJobStatus(job: {
  id: string;
  status: MemoryJob["status"];
  attempts: number;
  lastError: string | null;
  runAfter: number;
  updatedAt: number;
}): void {
  stmts.updateMemoryJobStatus.run(job);
}

export function claimMemoryJobRunning(job: {
  id: string;
  attempts: number;
  updatedAt: number;
}): boolean {
  const result = stmts.claimMemoryJobRunning.run(job) as Database.RunResult;
  return result.changes > 0;
}

export function resetRunningMemoryJobs(now: number): number {
  const result = stmts.resetRunningMemoryJobs.run({
    runAfter: now,
    updatedAt: now,
  }) as Database.RunResult;
  return result.changes;
}

export function updateMemoryEntryStatus(entry: {
  id: string;
  status: MemoryEntry["status"];
  updatedAt: number;
  lastConfirmedAt: number | null;
}): void {
  stmts.updateMemoryEntryStatus.run(entry);
}
