import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { getDataDir } from "../runtime-paths.js";
import {
  compareMemoryCategory,
  inferMemoryCategoryFromText,
  isMemoryCategory,
} from "../memory/category.js";
import type { MemoryCategory } from "../memory/types.js";

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

export type TelegramTaskStatus =
  | "decision_pending"
  | "queued"
  | "running"
  | "waiting_next_attempt"
  | "completed"
  | "failed"
  | "cancelled";

export type TelegramTaskPhase =
  | "merge_window"
  | "starting"
  | "early_running"
  | "stable_running";

export type TelegramTaskInputKind = "text" | "photo" | "document";

export type TelegramAttemptStatus =
  | "pending"
  | "running"
  | "superseded"
  | "completed"
  | "failed"
  | "cancelled";

export type TelegramTask = {
  id: string;
  chatId: string;
  status: TelegramTaskStatus;
  queueOrder: number;
  currentRevision: number;
  activeAttemptId: string | null;
  providerSessionId: string | null;
  latestStatusMessageId: number | null;
  latestResultMessageId: number | null;
  decisionStatus: "pending" | "resolved" | null;
  decisionDeadlineAt: number | null;
  currentPhase: TelegramTaskPhase;
  cancelRequestedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type TelegramTaskInput = {
  id: string;
  taskId: string;
  revision: number;
  sequence: number;
  kind: TelegramTaskInputKind;
  telegramMessageId: number;
  text: string | null;
  attachmentJson: string | null;
  createdAt: number;
};

export type TelegramAttempt = {
  id: string;
  taskId: string;
  revision: number;
  status: TelegramAttemptStatus;
  inputSnapshotJson: string;
  providerSessionIdBefore: string | null;
  providerSessionIdAfter: string | null;
  hasLongStep: boolean;
  lastEventAt: number | null;
  timeoutKind: "idle" | "max_runtime" | null;
  resultText: string | null;
  errorText: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type TelegramPollState = {
  channel: string;
  lastUpdateId: number;
  updatedAt: number;
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
  category: MemoryCategory;
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
  category: MemoryCategory;
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

  CREATE TABLE IF NOT EXISTS telegram_tasks (
    id                       TEXT PRIMARY KEY,
    chat_id                  TEXT NOT NULL,
    status                   TEXT NOT NULL,
    queue_order              INTEGER NOT NULL DEFAULT 0,
    current_revision         INTEGER NOT NULL DEFAULT 1,
    active_attempt_id        TEXT,
    provider_session_id      TEXT,
    latest_status_message_id INTEGER,
    latest_result_message_id INTEGER,
    decision_status          TEXT,
    decision_deadline_at     INTEGER,
    current_phase            TEXT NOT NULL DEFAULT 'merge_window',
    cancel_requested_at      INTEGER,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_telegram_tasks_chat_status_order
  ON telegram_tasks(chat_id, status, queue_order, created_at);

  CREATE TABLE IF NOT EXISTS telegram_task_inputs (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL REFERENCES telegram_tasks(id) ON DELETE CASCADE,
    revision            INTEGER NOT NULL,
    sequence            INTEGER NOT NULL,
    kind                TEXT NOT NULL,
    telegram_message_id INTEGER NOT NULL,
    text                TEXT,
    attachment_json     TEXT,
    created_at          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_telegram_task_inputs_task_revision_sequence
  ON telegram_task_inputs(task_id, revision, sequence);

  CREATE TABLE IF NOT EXISTS telegram_attempts (
    id                         TEXT PRIMARY KEY,
    task_id                    TEXT NOT NULL REFERENCES telegram_tasks(id) ON DELETE CASCADE,
    revision                   INTEGER NOT NULL,
    status                     TEXT NOT NULL,
    input_snapshot_json        TEXT NOT NULL,
    provider_session_id_before TEXT,
    provider_session_id_after  TEXT,
    has_long_step              INTEGER NOT NULL DEFAULT 0,
    last_event_at              INTEGER,
    timeout_kind               TEXT,
    result_text                TEXT,
    error_text                 TEXT,
    started_at                 INTEGER,
    finished_at                INTEGER,
    created_at                 INTEGER NOT NULL,
    updated_at                 INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_telegram_attempts_task_status_revision
  ON telegram_attempts(task_id, status, revision, created_at);

  CREATE TABLE IF NOT EXISTS telegram_poll_state (
    channel        TEXT PRIMARY KEY,
    last_update_id INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_entries (
    id                TEXT PRIMARY KEY,
    scope             TEXT NOT NULL,
    source_type       TEXT NOT NULL,
    source_ref        TEXT,
    text              TEXT NOT NULL,
    text_hash         TEXT NOT NULL,
    confidence        REAL NOT NULL DEFAULT 0,
    durability        TEXT NOT NULL DEFAULT 'medium',
    category          TEXT NOT NULL DEFAULT 'workflow',
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
    category         TEXT NOT NULL DEFAULT 'workflow',
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
try {
  db.exec(`ALTER TABLE memory_entries ADD COLUMN category TEXT NOT NULL DEFAULT 'workflow'`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE canonical_memories ADD COLUMN category TEXT NOT NULL DEFAULT 'workflow'`);
} catch (_) {}

db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_source_chat ON sessions(source, chat_id)`);;
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_category_status
  ON memory_entries(scope, category, status, updated_at DESC)
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_canonical_memories_scope_category_status
  ON canonical_memories(scope, category, status, updated_at DESC)
`);

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

  insertTelegramTask: db.prepare(`
    INSERT INTO telegram_tasks (
      id, chat_id, status, queue_order, current_revision, active_attempt_id,
      provider_session_id, latest_status_message_id, latest_result_message_id,
      decision_status, decision_deadline_at, current_phase, cancel_requested_at,
      created_at, updated_at
    ) VALUES (
      @id, @chatId, @status, @queueOrder, @currentRevision, @activeAttemptId,
      @providerSessionId, @latestStatusMessageId, @latestResultMessageId,
      @decisionStatus, @decisionDeadlineAt, @currentPhase, @cancelRequestedAt,
      @createdAt, @updatedAt
    )
  `),

  updateTelegramTask: db.prepare(`
    UPDATE telegram_tasks
    SET
      status = @status,
      queue_order = @queueOrder,
      current_revision = @currentRevision,
      active_attempt_id = @activeAttemptId,
      provider_session_id = @providerSessionId,
      latest_status_message_id = @latestStatusMessageId,
      latest_result_message_id = @latestResultMessageId,
      decision_status = @decisionStatus,
      decision_deadline_at = @decisionDeadlineAt,
      current_phase = @currentPhase,
      cancel_requested_at = @cancelRequestedAt,
      updated_at = @updatedAt
    WHERE id = @id
  `),

  getTelegramTaskById: db.prepare(`
    SELECT
      id,
      chat_id AS chatId,
      status,
      queue_order AS queueOrder,
      current_revision AS currentRevision,
      active_attempt_id AS activeAttemptId,
      provider_session_id AS providerSessionId,
      latest_status_message_id AS latestStatusMessageId,
      latest_result_message_id AS latestResultMessageId,
      decision_status AS decisionStatus,
      decision_deadline_at AS decisionDeadlineAt,
      current_phase AS currentPhase,
      cancel_requested_at AS cancelRequestedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_tasks
    WHERE id = ?
    LIMIT 1
  `),

  listTelegramTasksByChat: db.prepare(`
    SELECT
      id,
      chat_id AS chatId,
      status,
      queue_order AS queueOrder,
      current_revision AS currentRevision,
      active_attempt_id AS activeAttemptId,
      provider_session_id AS providerSessionId,
      latest_status_message_id AS latestStatusMessageId,
      latest_result_message_id AS latestResultMessageId,
      decision_status AS decisionStatus,
      decision_deadline_at AS decisionDeadlineAt,
      current_phase AS currentPhase,
      cancel_requested_at AS cancelRequestedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_tasks
    WHERE chat_id = ?
    ORDER BY queue_order ASC, created_at ASC
  `),

  listActiveTelegramTasksByChat: db.prepare(`
    SELECT
      id,
      chat_id AS chatId,
      status,
      queue_order AS queueOrder,
      current_revision AS currentRevision,
      active_attempt_id AS activeAttemptId,
      provider_session_id AS providerSessionId,
      latest_status_message_id AS latestStatusMessageId,
      latest_result_message_id AS latestResultMessageId,
      decision_status AS decisionStatus,
      decision_deadline_at AS decisionDeadlineAt,
      current_phase AS currentPhase,
      cancel_requested_at AS cancelRequestedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_tasks
    WHERE chat_id = ?
      AND status IN ('decision_pending', 'queued', 'running', 'waiting_next_attempt')
    ORDER BY
      CASE status
        WHEN 'running' THEN 0
        WHEN 'waiting_next_attempt' THEN 1
        WHEN 'queued' THEN 2
        ELSE 3
      END,
      queue_order ASC,
      created_at ASC
  `),

  listRecoverableTelegramTasks: db.prepare(`
    SELECT
      id,
      chat_id AS chatId,
      status,
      queue_order AS queueOrder,
      current_revision AS currentRevision,
      active_attempt_id AS activeAttemptId,
      provider_session_id AS providerSessionId,
      latest_status_message_id AS latestStatusMessageId,
      latest_result_message_id AS latestResultMessageId,
      decision_status AS decisionStatus,
      decision_deadline_at AS decisionDeadlineAt,
      current_phase AS currentPhase,
      cancel_requested_at AS cancelRequestedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_tasks
    WHERE status IN ('decision_pending', 'queued', 'running', 'waiting_next_attempt')
    ORDER BY chat_id ASC, queue_order ASC, created_at ASC
  `),

  getTelegramPendingDecisionByChat: db.prepare(`
    SELECT
      id,
      chat_id AS chatId,
      status,
      queue_order AS queueOrder,
      current_revision AS currentRevision,
      active_attempt_id AS activeAttemptId,
      provider_session_id AS providerSessionId,
      latest_status_message_id AS latestStatusMessageId,
      latest_result_message_id AS latestResultMessageId,
      decision_status AS decisionStatus,
      decision_deadline_at AS decisionDeadlineAt,
      current_phase AS currentPhase,
      cancel_requested_at AS cancelRequestedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_tasks
    WHERE chat_id = ?
      AND status = 'decision_pending'
    ORDER BY created_at DESC
    LIMIT 1
  `),

  getTelegramCurrentTaskByChat: db.prepare(`
    SELECT
      id,
      chat_id AS chatId,
      status,
      queue_order AS queueOrder,
      current_revision AS currentRevision,
      active_attempt_id AS activeAttemptId,
      provider_session_id AS providerSessionId,
      latest_status_message_id AS latestStatusMessageId,
      latest_result_message_id AS latestResultMessageId,
      decision_status AS decisionStatus,
      decision_deadline_at AS decisionDeadlineAt,
      current_phase AS currentPhase,
      cancel_requested_at AS cancelRequestedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_tasks
    WHERE chat_id = ?
      AND status IN ('queued', 'running', 'waiting_next_attempt')
    ORDER BY
      CASE status
        WHEN 'running' THEN 0
        WHEN 'waiting_next_attempt' THEN 1
        ELSE 2
      END,
      queue_order ASC,
      created_at ASC
    LIMIT 1
  `),

  listRunnableTelegramTasks: db.prepare(`
    SELECT
      id,
      chat_id AS chatId,
      status,
      queue_order AS queueOrder,
      current_revision AS currentRevision,
      active_attempt_id AS activeAttemptId,
      provider_session_id AS providerSessionId,
      latest_status_message_id AS latestStatusMessageId,
      latest_result_message_id AS latestResultMessageId,
      decision_status AS decisionStatus,
      decision_deadline_at AS decisionDeadlineAt,
      current_phase AS currentPhase,
      cancel_requested_at AS cancelRequestedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_tasks
    WHERE status IN ('queued', 'waiting_next_attempt')
    ORDER BY queue_order ASC, created_at ASC
  `),

  cancelTelegramTasksByChat: db.prepare(`
    UPDATE telegram_tasks
    SET
      status = 'cancelled',
      cancel_requested_at = COALESCE(cancel_requested_at, @updatedAt),
      updated_at = @updatedAt
    WHERE chat_id = @chatId
      AND status IN ('decision_pending', 'queued', 'running', 'waiting_next_attempt')
  `),

  getNextTelegramQueueOrder: db.prepare(`
    SELECT COALESCE(MAX(queue_order), 0) AS maxOrder
    FROM telegram_tasks
    WHERE chat_id = ?
  `),

  insertTelegramTaskInput: db.prepare(`
    INSERT INTO telegram_task_inputs (
      id, task_id, revision, sequence, kind, telegram_message_id,
      text, attachment_json, created_at
    ) VALUES (
      @id, @taskId, @revision, @sequence, @kind, @telegramMessageId,
      @text, @attachmentJson, @createdAt
    )
  `),

  getNextTelegramTaskInputSequence: db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) AS maxSequence
    FROM telegram_task_inputs
    WHERE task_id = ?
  `),

  listTelegramTaskInputs: db.prepare(`
    SELECT
      id,
      task_id AS taskId,
      revision,
      sequence,
      kind,
      telegram_message_id AS telegramMessageId,
      text,
      attachment_json AS attachmentJson,
      created_at AS createdAt
    FROM telegram_task_inputs
    WHERE task_id = ?
    ORDER BY sequence ASC
  `),

  listTelegramTaskInputsUpToRevision: db.prepare(`
    SELECT
      id,
      task_id AS taskId,
      revision,
      sequence,
      kind,
      telegram_message_id AS telegramMessageId,
      text,
      attachment_json AS attachmentJson,
      created_at AS createdAt
    FROM telegram_task_inputs
    WHERE task_id = ?
      AND revision <= ?
    ORDER BY sequence ASC
  `),

  insertTelegramAttempt: db.prepare(`
    INSERT INTO telegram_attempts (
      id, task_id, revision, status, input_snapshot_json,
      provider_session_id_before, provider_session_id_after, has_long_step,
      last_event_at, timeout_kind, result_text, error_text,
      started_at, finished_at, created_at, updated_at
    ) VALUES (
      @id, @taskId, @revision, @status, @inputSnapshotJson,
      @providerSessionIdBefore, @providerSessionIdAfter, @hasLongStep,
      @lastEventAt, @timeoutKind, @resultText, @errorText,
      @startedAt, @finishedAt, @createdAt, @updatedAt
    )
  `),

  updateTelegramAttempt: db.prepare(`
    UPDATE telegram_attempts
    SET
      status = @status,
      input_snapshot_json = @inputSnapshotJson,
      provider_session_id_before = @providerSessionIdBefore,
      provider_session_id_after = @providerSessionIdAfter,
      has_long_step = @hasLongStep,
      last_event_at = @lastEventAt,
      timeout_kind = @timeoutKind,
      result_text = @resultText,
      error_text = @errorText,
      started_at = @startedAt,
      finished_at = @finishedAt,
      updated_at = @updatedAt
    WHERE id = @id
  `),

  getTelegramAttemptById: db.prepare(`
    SELECT
      id,
      task_id AS taskId,
      revision,
      status,
      input_snapshot_json AS inputSnapshotJson,
      provider_session_id_before AS providerSessionIdBefore,
      provider_session_id_after AS providerSessionIdAfter,
      has_long_step AS hasLongStep,
      last_event_at AS lastEventAt,
      timeout_kind AS timeoutKind,
      result_text AS resultText,
      error_text AS errorText,
      started_at AS startedAt,
      finished_at AS finishedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_attempts
    WHERE id = ?
    LIMIT 1
  `),

  listTelegramAttemptsByTask: db.prepare(`
    SELECT
      id,
      task_id AS taskId,
      revision,
      status,
      input_snapshot_json AS inputSnapshotJson,
      provider_session_id_before AS providerSessionIdBefore,
      provider_session_id_after AS providerSessionIdAfter,
      has_long_step AS hasLongStep,
      last_event_at AS lastEventAt,
      timeout_kind AS timeoutKind,
      result_text AS resultText,
      error_text AS errorText,
      started_at AS startedAt,
      finished_at AS finishedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_attempts
    WHERE task_id = ?
    ORDER BY created_at ASC
  `),

  getLatestTelegramAttemptByTask: db.prepare(`
    SELECT
      id,
      task_id AS taskId,
      revision,
      status,
      input_snapshot_json AS inputSnapshotJson,
      provider_session_id_before AS providerSessionIdBefore,
      provider_session_id_after AS providerSessionIdAfter,
      has_long_step AS hasLongStep,
      last_event_at AS lastEventAt,
      timeout_kind AS timeoutKind,
      result_text AS resultText,
      error_text AS errorText,
      started_at AS startedAt,
      finished_at AS finishedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM telegram_attempts
    WHERE task_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `),

  resetRecoverableTelegramAttempts: db.prepare(`
    UPDATE telegram_attempts
    SET
      status = CASE
        WHEN revision < (
          SELECT current_revision
          FROM telegram_tasks
          WHERE telegram_tasks.id = telegram_attempts.task_id
        ) THEN 'superseded'
        ELSE 'pending'
      END,
      finished_at = NULL,
      updated_at = @updatedAt
    WHERE status = 'running'
  `),

  upsertTelegramPollState: db.prepare(`
    INSERT INTO telegram_poll_state (channel, last_update_id, updated_at)
    VALUES (@channel, @lastUpdateId, @updatedAt)
    ON CONFLICT(channel) DO UPDATE SET
      last_update_id = excluded.last_update_id,
      updated_at = excluded.updated_at
  `),

  getTelegramPollState: db.prepare(`
    SELECT
      channel,
      last_update_id AS lastUpdateId,
      updated_at AS updatedAt
    FROM telegram_poll_state
    WHERE channel = ?
    LIMIT 1
  `),

  upsertMemoryEntry: db.prepare(`
    INSERT INTO memory_entries (
      id, scope, source_type, source_ref, text, text_hash, confidence,
      durability, category, status, embedding_status, embedding_model, embedding_json,
      created_at, updated_at, last_confirmed_at
    ) VALUES (
      @id, @scope, @sourceType, @sourceRef, @text, @textHash, @confidence,
      @durability, @category, @status, @embeddingStatus, @embeddingModel, @embeddingJson,
      @createdAt, @updatedAt, @lastConfirmedAt
    )
    ON CONFLICT(scope, text_hash) DO UPDATE SET
      source_type = excluded.source_type,
      source_ref = excluded.source_ref,
      text = excluded.text,
      confidence = MAX(memory_entries.confidence, excluded.confidence),
      durability = excluded.durability,
      category = excluded.category,
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
      category,
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
      category,
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

  listLegacyMemoryEntriesForCategoryBackfill: db.prepare(`
    SELECT
      id,
      scope,
      source_type AS sourceType,
      source_ref AS sourceRef,
      text,
      text_hash AS textHash,
      confidence,
      durability,
      category,
      status,
      embedding_status AS embeddingStatus,
      embedding_model AS embeddingModel,
      embedding_json AS embeddingJson,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_confirmed_at AS lastConfirmedAt
    FROM memory_entries
    WHERE category = 'workflow'
  `),

  listCanonicalMemoriesByScope: db.prepare(`
    SELECT
      id,
      scope,
      text,
      text_hash AS textHash,
      confidence,
      category,
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

  listLegacyCanonicalMemoriesForCategoryBackfill: db.prepare(`
    SELECT
      id,
      scope,
      text,
      text_hash AS textHash,
      confidence,
      category,
      status,
      embedding_status AS embeddingStatus,
      embedding_model AS embeddingModel,
      embedding_json AS embeddingJson,
      source_json AS sourceJson,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_promoted_at AS lastPromotedAt
    FROM canonical_memories
    WHERE category = 'workflow'
  `),

  getCanonicalMemoryByScopeHash: db.prepare(`
    SELECT
      id,
      scope,
      text,
      text_hash AS textHash,
      confidence,
      category,
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
      category,
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
      id, scope, text, text_hash, confidence, category, status,
      embedding_status, embedding_model, embedding_json, source_json,
      created_at, updated_at, last_promoted_at
    ) VALUES (
      @id, @scope, @text, @textHash, @confidence, @category, @status,
      @embeddingStatus, @embeddingModel, @embeddingJson, @sourceJson,
      @createdAt, @updatedAt, @lastPromotedAt
    )
    ON CONFLICT(scope, text_hash) DO UPDATE SET
      text = excluded.text,
      confidence = excluded.confidence,
      category = excluded.category,
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
      category,
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
      category,
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

  updateMemoryEntryCategory: db.prepare(`
    UPDATE memory_entries
    SET
      category = @category,
      updated_at = @updatedAt
    WHERE id = @id
  `),

  updateCanonicalMemoryCategory: db.prepare(`
    UPDATE canonical_memories
    SET
      category = @category,
      updated_at = @updatedAt
    WHERE id = @id
  `),
};

function resolveCategoryFromSourceJson(
  sourceJson: string | null,
): MemoryCategory | null {
  if (!sourceJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(sourceJson) as { sourceCategories?: unknown[] };
    const categories = (parsed.sourceCategories || [])
      .filter(isMemoryCategory);
    if (categories.length === 0) {
      return null;
    }

    const counts = new Map<MemoryCategory, number>();
    for (const category of categories) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }

    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || compareMemoryCategory(left[0], right[0]))[0]?.[0] || null;
  } catch {
    return null;
  }
}

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

export function createTelegramTask(task: TelegramTask): void {
  stmts.insertTelegramTask.run(task);
}

export function updateTelegramTask(task: TelegramTask): void {
  stmts.updateTelegramTask.run(task);
}

export function getTelegramTaskById(id: string): TelegramTask | null {
  const row = stmts.getTelegramTaskById.get(id) as TelegramTask | undefined;
  return row || null;
}

export function listTelegramTasksByChat(chatId: string): TelegramTask[] {
  return stmts.listTelegramTasksByChat.all(chatId) as TelegramTask[];
}

export function listActiveTelegramTasksByChat(chatId: string): TelegramTask[] {
  return stmts.listActiveTelegramTasksByChat.all(chatId) as TelegramTask[];
}

export function listRecoverableTelegramTasks(): TelegramTask[] {
  return stmts.listRecoverableTelegramTasks.all() as TelegramTask[];
}

export function getTelegramPendingDecisionByChat(chatId: string): TelegramTask | null {
  const row = stmts.getTelegramPendingDecisionByChat.get(chatId) as TelegramTask | undefined;
  return row || null;
}

export function getTelegramCurrentTaskByChat(chatId: string): TelegramTask | null {
  const row = stmts.getTelegramCurrentTaskByChat.get(chatId) as TelegramTask | undefined;
  return row || null;
}

export function listRunnableTelegramTasks(): TelegramTask[] {
  return stmts.listRunnableTelegramTasks.all() as TelegramTask[];
}

export function cancelTelegramTasksByChat(chatId: string, updatedAt: number): void {
  stmts.cancelTelegramTasksByChat.run({ chatId, updatedAt });
}

export function getNextTelegramQueueOrder(chatId: string): number {
  const row = stmts.getNextTelegramQueueOrder.get(chatId) as { maxOrder?: number } | undefined;
  return (row?.maxOrder || 0) + 1;
}

export function createTelegramTaskInput(input: TelegramTaskInput): void {
  stmts.insertTelegramTaskInput.run(input);
}

export function getNextTelegramTaskInputSequence(taskId: string): number {
  const row = stmts.getNextTelegramTaskInputSequence.get(taskId) as { maxSequence?: number } | undefined;
  return (row?.maxSequence || 0) + 1;
}

export function listTelegramTaskInputs(taskId: string): TelegramTaskInput[] {
  return stmts.listTelegramTaskInputs.all(taskId) as TelegramTaskInput[];
}

export function listTelegramTaskInputsUpToRevision(taskId: string, revision: number): TelegramTaskInput[] {
  return stmts.listTelegramTaskInputsUpToRevision.all(taskId, revision) as TelegramTaskInput[];
}

export function createTelegramAttempt(attempt: TelegramAttempt): void {
  stmts.insertTelegramAttempt.run({
    ...attempt,
    hasLongStep: attempt.hasLongStep ? 1 : 0,
  });
}

export function updateTelegramAttempt(attempt: TelegramAttempt): void {
  stmts.updateTelegramAttempt.run({
    ...attempt,
    hasLongStep: attempt.hasLongStep ? 1 : 0,
  });
}

export function getTelegramAttemptById(id: string): TelegramAttempt | null {
  const row = stmts.getTelegramAttemptById.get(id) as
    | (Omit<TelegramAttempt, "hasLongStep"> & { hasLongStep: number })
    | undefined;
  return row
    ? {
        ...row,
        hasLongStep: Boolean(row.hasLongStep),
      }
    : null;
}

export function listTelegramAttemptsByTask(taskId: string): TelegramAttempt[] {
  return (stmts.listTelegramAttemptsByTask.all(taskId) as Array<
    Omit<TelegramAttempt, "hasLongStep"> & { hasLongStep: number }
  >).map((row) => ({
    ...row,
    hasLongStep: Boolean(row.hasLongStep),
  }));
}

export function getLatestTelegramAttemptByTask(taskId: string): TelegramAttempt | null {
  const row = stmts.getLatestTelegramAttemptByTask.get(taskId) as
    | (Omit<TelegramAttempt, "hasLongStep"> & { hasLongStep: number })
    | undefined;
  return row
    ? {
        ...row,
        hasLongStep: Boolean(row.hasLongStep),
      }
    : null;
}

export function resetRecoverableTelegramAttempts(now: number): void {
  stmts.resetRecoverableTelegramAttempts.run({ updatedAt: now });
}

export function saveTelegramPollState(state: TelegramPollState): void {
  stmts.upsertTelegramPollState.run(state);
}

export function getTelegramPollState(channel: string): TelegramPollState | null {
  const row = stmts.getTelegramPollState.get(channel) as TelegramPollState | undefined;
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

export function backfillLegacyMemoryCategories(): {
  memoryEntryUpdates: number;
  canonicalMemoryUpdates: number;
} {
  const now = Date.now();
  let memoryEntryUpdates = 0;
  let canonicalMemoryUpdates = 0;

  for (const entry of stmts.listLegacyMemoryEntriesForCategoryBackfill.all() as MemoryEntry[]) {
    const inferred = inferMemoryCategoryFromText(entry.text);
    if (inferred === "workflow") {
      continue;
    }

    stmts.updateMemoryEntryCategory.run({
      id: entry.id,
      category: inferred,
      updatedAt: now,
    });
    memoryEntryUpdates += 1;
  }

  for (const entry of stmts.listLegacyCanonicalMemoriesForCategoryBackfill.all() as CanonicalMemory[]) {
    const inferred = resolveCategoryFromSourceJson(entry.sourceJson) || inferMemoryCategoryFromText(entry.text);
    if (inferred === "workflow") {
      continue;
    }

    stmts.updateCanonicalMemoryCategory.run({
      id: entry.id,
      category: inferred,
      updatedAt: now,
    });
    canonicalMemoryUpdates += 1;
  }

  return {
    memoryEntryUpdates,
    canonicalMemoryUpdates,
  };
}
