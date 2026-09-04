import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  AppEvent,
  BlockedUser,
  DashboardMetrics,
  DigitalHumanJob,
  DirectorCue,
  GiftEntitlement,
  LiveSession,
  MediaAsset,
  LipSyncPlan,
  LiveEventInboxItem,
  QualificationGrant,
  Reading,
  ReadingStatus,
  SceneProfileVersion,
  SessionEngagementRankingEntry,
  SessionGiftRankingEntry,
} from '@meihua/core-types';

type ReadingRow = {
  id: string;
  session_id: string | null;
  source_event_id: string | null;
  source: Reading['source'];
  username: string;
  user_id: string | null;
  raw_question: string;
  normalized_question: string | null;
  category: Reading['category'] | null;
  moderation_decision: Reading['moderationDecision'] | null;
  moderation_reason: string | null;
  status: ReadingStatus;
  priority: Reading['priority'];
  gift_json: string | null;
  qualification_json: string | null;
  speech_target_seconds: number | null;
  voice_snapshot_json: string | null;
  meihua_json: string | null;
  answer_json: string | null;
  tts_audio_path: string | null;
  tts_duration_ms: number | null;
  speech_plan_json: string | null;
  lip_sync_plan_json: string | null;
  pipeline_json: string | null;
  digital_human_json: string | null;
  presentation_json: string | null;
  created_at: number;
  expires_at: number | null;
  selected_at: number | null;
  completed_at: number | null;
  error_code: string | null;
  error_message: string | null;
};

type GiftEntitlementRow = {
  id: string;
  source_event_id: string;
  user_key: string;
  username: string;
  rule_id: string;
  gift_id: string | null;
  gift_name: string;
  repeat_count: number;
  priority: GiftEntitlement['priority'];
  speech_target_seconds: number;
  status: GiftEntitlement['status'];
  reading_id: string | null;
  created_at: number;
  applied_at: number | null;
  expires_at: number;
};

type QualificationGrantRow = {
  id: string;
  source_event_id: string;
  session_id: string | null;
  user_key: string;
  username: string;
  kind: QualificationGrant['kind'];
  rule_id: string;
  label: string;
  priority: QualificationGrant['priority'];
  speech_target_seconds: number;
  status: QualificationGrant['status'];
  reading_id: string | null;
  created_at: number;
  applied_at: number | null;
  expires_at: number;
};

type AppEventRow = {
  id: number | bigint;
  reading_id: string | null;
  type: string;
  payload_json: string | null;
  created_at: number | bigint;
};

type DigitalHumanJobRow = {
  id: string;
  kind: DigitalHumanJob['kind'];
  profile_id: string;
  status: DigitalHumanJob['status'];
  stage: string;
  progress: number;
  dedupe_key: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
};

type BlockedUserRow = {
  user_key: string;
  username: string | null;
  reason: string | null;
  created_at: number | bigint;
};

type LiveEventInboxRow = {
  id: number | bigint;
  source: string;
  event_id: string;
  kind: LiveEventInboxItem['kind'];
  payload_json: string;
  status: LiveEventInboxItem['status'];
  received_at: number | bigint;
  processed_at: number | bigint | null;
  error: string | null;
};

const inFlightStates: ReadingStatus[] = [
  'SELECTED',
  'CASTING',
  'INTERPRETING',
  'COMPOSING_SPEECH',
  'SYNTHESIZING',
  'SPEAKING',
  'RETRYING',
];

export class SqlitePersistence {
  private readonly db: DatabaseSync;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    if (filePath !== ':memory:' && existsSync(filePath) && !existsSync(`${filePath}.pre-v2.bak`)) {
      copyFileSync(filePath, `${filePath}.pre-v2.bak`);
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  migrate(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS readings (
        id TEXT PRIMARY KEY,
        source_event_id TEXT,
        source TEXT NOT NULL,
        username TEXT NOT NULL,
        user_id TEXT,
        raw_question TEXT NOT NULL,
        normalized_question TEXT,
        category TEXT,
        moderation_decision TEXT,
        moderation_reason TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        gift_json TEXT,
        qualification_json TEXT,
        speech_target_seconds INTEGER,
        voice_snapshot_json TEXT,
        meihua_json TEXT,
        answer_json TEXT,
        tts_audio_path TEXT,
        tts_duration_ms INTEGER,
        lip_sync_plan_json TEXT,
        pipeline_json TEXT,
        digital_human_json TEXT,
        presentation_json TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        selected_at INTEGER,
        completed_at INTEGER,
        error_code TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_readings_status_created ON readings(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_readings_status_completed ON readings(status, completed_at);
      CREATE INDEX IF NOT EXISTS idx_readings_source_event ON readings(source, source_event_id);
      CREATE TABLE IF NOT EXISTS blocked_users (
        user_key TEXT PRIMARY KEY,
        username TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reading_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_events_created ON app_events(created_at DESC);
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gift_entitlements (
        id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        username TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        gift_id TEXT,
        gift_name TEXT NOT NULL,
        repeat_count INTEGER NOT NULL,
        priority TEXT NOT NULL,
        speech_target_seconds INTEGER NOT NULL,
        status TEXT NOT NULL,
        reading_id TEXT,
        created_at INTEGER NOT NULL,
        applied_at INTEGER,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gift_entitlements_user_status ON gift_entitlements(user_key, status, expires_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gift_entitlements_created ON gift_entitlements(created_at DESC);
      CREATE TABLE IF NOT EXISTS qualification_grants (
        id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL,
        session_id TEXT,
        user_key TEXT NOT NULL,
        username TEXT NOT NULL,
        kind TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        label TEXT NOT NULL,
        priority TEXT NOT NULL,
        speech_target_seconds INTEGER NOT NULL,
        status TEXT NOT NULL,
        reading_id TEXT,
        created_at INTEGER NOT NULL,
        applied_at INTEGER,
        expires_at INTEGER NOT NULL,
        UNIQUE(source_event_id, kind, rule_id)
      );
      CREATE INDEX IF NOT EXISTS idx_qualification_grants_pending ON qualification_grants(user_key, status, expires_at DESC);
      CREATE INDEX IF NOT EXISTS idx_qualification_grants_created ON qualification_grants(created_at DESC);
      CREATE TABLE IF NOT EXISTS live_sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'REHEARSAL',
        profile_version_id TEXT NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_heartbeat_at INTEGER NOT NULL,
        operator_note TEXT,
        end_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_live_sessions_status_started ON live_sessions(status, started_at DESC);
      CREATE TABLE IF NOT EXISTS scene_profile_versions (
        version_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        published_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_profile_version_number ON scene_profile_versions(profile_id, version);
      CREATE INDEX IF NOT EXISTS idx_scene_profile_status ON scene_profile_versions(profile_id, status, version DESC);
      CREATE TABLE IF NOT EXISTS director_cues (
        cue_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reading_id TEXT,
        sequence INTEGER NOT NULL,
        stage TEXT NOT NULL,
        track TEXT NOT NULL,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_director_cues_session_sequence ON director_cues(session_id, sequence DESC);
      CREATE TABLE IF NOT EXISTS session_user_stats (
        session_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        username TEXT NOT NULL,
        like_count INTEGER NOT NULL DEFAULT 0,
        valid_comment_count INTEGER NOT NULL DEFAULT 0,
        engagement_points INTEGER NOT NULL DEFAULT 0,
        reached_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, user_key)
      );
      CREATE INDEX IF NOT EXISTS idx_session_user_ranking ON session_user_stats(session_id, engagement_points DESC, reached_at ASC);
      CREATE TABLE IF NOT EXISTS session_gift_stats (
        session_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        username TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0,
        gift_count INTEGER NOT NULL DEFAULT 0,
        reached_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, user_key)
      );
      CREATE INDEX IF NOT EXISTS idx_session_gift_ranking ON session_gift_stats(session_id, points DESC, reached_at ASC);
      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        storage_key TEXT,
        width INTEGER,
        height INTEGER,
        duration_ms INTEGER,
        transparency TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'UPLOADED',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS live_event_dedup (
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(source, event_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_live_event_dedup_created ON live_event_dedup(created_at DESC);
      CREATE TABLE IF NOT EXISTS live_event_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        received_at INTEGER NOT NULL,
        processed_at INTEGER,
        error TEXT,
        UNIQUE(source, event_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_live_event_inbox_status ON live_event_inbox(status, id);
      CREATE TABLE IF NOT EXISTS sync_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sync_metrics_created ON sync_metrics(created_at DESC);
      CREATE TABLE IF NOT EXISTS maintenance_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS digital_human_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_digital_human_jobs_profile ON digital_human_jobs(profile_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_digital_human_jobs_dedupe ON digital_human_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'PROCESSING');
    `);
      this.ensureColumn('readings', 'session_id', 'TEXT');
      this.ensureColumn('readings', 'gift_json', 'TEXT');
      this.ensureColumn('readings', 'speech_target_seconds', 'INTEGER');
      this.ensureColumn('readings', 'voice_snapshot_json', 'TEXT');
      this.ensureColumn('readings', 'qualification_json', 'TEXT');
      this.ensureColumn('readings', 'expires_at', 'INTEGER');
      this.ensureColumn('readings', 'speech_plan_json', 'TEXT');
      this.ensureColumn('readings', 'lip_sync_plan_json', 'TEXT');
      this.ensureColumn('readings', 'pipeline_json', 'TEXT');
      this.ensureColumn('readings', 'digital_human_json', 'TEXT');
      this.ensureColumn('readings', 'presentation_json', 'TEXT');
      this.ensureColumn('live_sessions', 'mode', "TEXT NOT NULL DEFAULT 'REHEARSAL'");
      this.ensureColumn('media_assets', 'origin', "TEXT NOT NULL DEFAULT 'UPLOADED'");
      this.ensureColumn('media_assets', 'storage_key', 'TEXT');
      this.db.exec('PRAGMA user_version = 6; COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveReading(reading: Reading): void {
    this.db.prepare(`
      INSERT INTO readings (
        id, session_id, source_event_id, source, username, user_id, raw_question, normalized_question,
        category, moderation_decision, moderation_reason, status, priority, gift_json, qualification_json, speech_target_seconds, voice_snapshot_json, meihua_json,
        answer_json, tts_audio_path, tts_duration_ms, speech_plan_json, lip_sync_plan_json, pipeline_json, digital_human_json, presentation_json, created_at, expires_at, selected_at, completed_at,
        error_code, error_message
      ) VALUES (
        @id, @session_id, @source_event_id, @source, @username, @user_id, @raw_question, @normalized_question,
        @category, @moderation_decision, @moderation_reason, @status, @priority, @gift_json, @qualification_json, @speech_target_seconds, @voice_snapshot_json, @meihua_json,
        @answer_json, @tts_audio_path, @tts_duration_ms, @speech_plan_json, @lip_sync_plan_json, @pipeline_json, @digital_human_json, @presentation_json, @created_at, @expires_at, @selected_at, @completed_at,
        @error_code, @error_message
      ) ON CONFLICT(id) DO UPDATE SET
        normalized_question=excluded.normalized_question,
        session_id=excluded.session_id,
        category=excluded.category,
        moderation_decision=excluded.moderation_decision,
        moderation_reason=excluded.moderation_reason,
        status=excluded.status,
        priority=excluded.priority,
        gift_json=excluded.gift_json,
        qualification_json=excluded.qualification_json,
        speech_target_seconds=excluded.speech_target_seconds,
        voice_snapshot_json=excluded.voice_snapshot_json,
        meihua_json=excluded.meihua_json,
        answer_json=excluded.answer_json,
        tts_audio_path=excluded.tts_audio_path,
        tts_duration_ms=excluded.tts_duration_ms,
        speech_plan_json=excluded.speech_plan_json,
        lip_sync_plan_json=excluded.lip_sync_plan_json,
        pipeline_json=excluded.pipeline_json,
        digital_human_json=excluded.digital_human_json,
        presentation_json=excluded.presentation_json,
        expires_at=excluded.expires_at,
        selected_at=excluded.selected_at,
        completed_at=excluded.completed_at,
        error_code=excluded.error_code,
        error_message=excluded.error_message
    `).run({
      id: reading.id,
      session_id: reading.sessionId ?? null,
      source_event_id: reading.sourceEventId ?? null,
      source: reading.source,
      username: reading.username,
      user_id: reading.userId ?? null,
      raw_question: reading.rawQuestion,
      normalized_question: reading.normalizedQuestion ?? null,
      category: reading.category ?? null,
      moderation_decision: reading.moderationDecision ?? null,
      moderation_reason: reading.moderationReason ?? null,
      status: reading.status,
      priority: reading.priority,
      gift_json: reading.gift ? JSON.stringify(reading.gift) : null,
      qualification_json: reading.qualification ? JSON.stringify(reading.qualification) : null,
      speech_target_seconds: reading.speechTargetSeconds ?? null,
      voice_snapshot_json: reading.voiceSnapshot ? JSON.stringify(reading.voiceSnapshot) : null,
      meihua_json: reading.meihua ? JSON.stringify(reading.meihua) : null,
      answer_json: reading.answer ? JSON.stringify(reading.answer) : null,
      tts_audio_path: reading.tts?.audioPath ?? null,
      tts_duration_ms: reading.tts?.durationMs ?? null,
      speech_plan_json: reading.speechPlan ? JSON.stringify(reading.speechPlan) : null,
      lip_sync_plan_json: reading.lipSyncPlan ?? reading.tts?.lipSyncPlan ? JSON.stringify(reading.lipSyncPlan ?? reading.tts?.lipSyncPlan) : null,
      pipeline_json: reading.pipeline ? JSON.stringify(reading.pipeline) : null,
      digital_human_json: reading.digitalHumanSnapshot ? JSON.stringify(reading.digitalHumanSnapshot) : null,
      presentation_json: reading.presentationSnapshot ? JSON.stringify(reading.presentationSnapshot) : null,
      created_at: reading.createdAt,
      expires_at: reading.expiresAt ?? null,
      selected_at: reading.selectedAt ?? null,
      completed_at: reading.completedAt ?? null,
      error_code: reading.errorCode ?? null,
      error_message: reading.errorMessage ?? null,
    });
  }

  getReading(id: string): Reading | undefined {
    const row = this.db.prepare('SELECT * FROM readings WHERE id = ?').get(id) as ReadingRow | undefined;
    return row ? this.toReading(row) : undefined;
  }

  getReadingBySourceEventId(source: Reading['source'], sourceEventId: string): Reading | undefined {
    const row = this.db.prepare('SELECT * FROM readings WHERE source = ? AND source_event_id = ? ORDER BY created_at ASC LIMIT 1').get(source, sourceEventId) as ReadingRow | undefined;
    return row ? this.toReading(row) : undefined;
  }

  listQueued(): Reading[] {
    return (this.db.prepare("SELECT * FROM readings WHERE status = 'QUEUED' ORDER BY created_at ASC").all() as ReadingRow[])
      .map((row) => this.toReading(row));
  }

  listRecent(limit = 200): Reading[] {
    return (this.db.prepare('SELECT * FROM readings ORDER BY created_at DESC LIMIT ?').all(limit) as ReadingRow[])
      .map((row) => this.toReading(row));
  }

  listReadings(options: { limit?: number; status?: ReadingStatus } = {}): Reading[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = options.status
      ? this.db.prepare('SELECT * FROM readings WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(options.status, limit)
      : this.db.prepare('SELECT * FROM readings ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as ReadingRow[]).map((row) => this.toReading(row));
  }

  listReadingsForSession(sessionId: string, limit = 10_000): Reading[] {
    const safeLimit = Math.min(Math.max(limit, 1), 50_000);
    return (this.db.prepare(`
      SELECT * FROM readings WHERE session_id = ? ORDER BY created_at ASC LIMIT ?
    `).all(sessionId, safeLimit) as ReadingRow[]).map((row) => this.toReading(row));
  }

  recoverInFlightReadings(): number {
    const placeholders = inFlightStates.map(() => '?').join(', ');
    return Number(this.db.prepare(`
      UPDATE readings
      SET status = 'ABORTED', completed_at = ?, error_code = 'PROCESS_RESTART', error_message = 'Process restarted during an active reading.'
      WHERE status IN (${placeholders})
    `).run(Date.now(), ...inFlightStates).changes);
  }

  /**
   * The legacy recovery method records an in-flight item as ABORTED so it
   * remains auditable.  The director can then explicitly put that item back
   * into the durable queue before the next session resumes.
   */
  requeueRestartedReadings(): number {
    return Number(this.db.prepare(`
      UPDATE readings
      SET status = 'QUEUED', selected_at = NULL, completed_at = NULL,
          error_code = 'PROCESS_RESTART_RECOVERED',
          error_message = 'Recovered after process restart and returned to the queue.'
      WHERE status = 'ABORTED' AND error_code = 'PROCESS_RESTART'
    `).run().changes);
  }

  recordEvent(type: string, payload: unknown, readingId?: string): void {
    this.db.prepare('INSERT INTO app_events (reading_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(readingId ?? null, type, JSON.stringify(payload), Date.now());
  }

  saveDigitalHumanJob(job: DigitalHumanJob): void {
    this.db.prepare(`
      INSERT INTO digital_human_jobs (
        id, kind, profile_id, status, stage, progress, dedupe_key, error_code, error_message,
        created_at, updated_at, started_at, finished_at
      ) VALUES (@id, @kind, @profile_id, @status, @stage, @progress, @dedupe_key, @error_code, @error_message,
        @created_at, @updated_at, @started_at, @finished_at)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, stage=excluded.stage, progress=excluded.progress,
        dedupe_key=excluded.dedupe_key, error_code=excluded.error_code, error_message=excluded.error_message,
        updated_at=excluded.updated_at, started_at=excluded.started_at, finished_at=excluded.finished_at
    `).run({
      id: job.id, kind: job.kind, profile_id: job.profileId, status: job.status, stage: job.stage,
      progress: job.progress, dedupe_key: job.dedupeKey ?? null, error_code: job.errorCode ?? null,
      error_message: job.errorMessage ?? null, created_at: job.createdAt, updated_at: job.updatedAt,
      started_at: job.startedAt ?? null, finished_at: job.finishedAt ?? null,
    });
  }

  getDigitalHumanJob(id: string): DigitalHumanJob | undefined {
    const row = this.db.prepare('SELECT * FROM digital_human_jobs WHERE id = ?').get(id) as DigitalHumanJobRow | undefined;
    return row ? this.toDigitalHumanJob(row) : undefined;
  }

  listDigitalHumanJobs(options: { profileId?: string; limit?: number } = {}): DigitalHumanJob[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = options.profileId
      ? this.db.prepare('SELECT * FROM digital_human_jobs WHERE profile_id = ? ORDER BY updated_at DESC LIMIT ?').all(options.profileId, limit)
      : this.db.prepare('SELECT * FROM digital_human_jobs ORDER BY updated_at DESC LIMIT ?').all(limit);
    return (rows as DigitalHumanJobRow[]).map((row) => this.toDigitalHumanJob(row));
  }

  findActiveDigitalHumanJob(dedupeKey: string): DigitalHumanJob | undefined {
    const row = this.db.prepare("SELECT * FROM digital_human_jobs WHERE dedupe_key = ? AND status IN ('QUEUED', 'PROCESSING') ORDER BY created_at DESC LIMIT 1").get(dedupeKey) as DigitalHumanJobRow | undefined;
    return row ? this.toDigitalHumanJob(row) : undefined;
  }

  recoverDigitalHumanJobs(): number {
    return Number(this.db.prepare("UPDATE digital_human_jobs SET status = 'QUEUED', stage = 'RECOVERED_AFTER_RESTART', updated_at = ?, error_code = NULL, error_message = NULL WHERE status = 'PROCESSING'").run(Date.now()).changes);
  }

  private toDigitalHumanJob(row: DigitalHumanJobRow): DigitalHumanJob {
    return {
      id: row.id, kind: row.kind, profileId: row.profile_id, status: row.status, stage: row.stage,
      progress: Number(row.progress), dedupeKey: row.dedupe_key ?? undefined, errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      startedAt: row.started_at === null ? undefined : Number(row.started_at), finishedAt: row.finished_at === null ? undefined : Number(row.finished_at),
    };
  }

  claimLiveEvent(source: string, eventId: string, kind: string, createdAt = Date.now()): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO live_event_dedup (source, event_id, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(source, eventId, kind, createdAt);
    return Number(result.changes) > 0;
  }

  /**
   * Durable intake before the live worker sees a TikFinity event. The unique key
   * is deliberately separate from live_event_dedup: after a crash, a pending
   * inbox record must be replayed rather than silently dropped.
   */
  enqueueLiveEvent(input: Omit<LiveEventInboxItem, 'id' | 'status' | 'receivedAt' | 'processedAt' | 'error'> & { receivedAt?: number }): LiveEventInboxItem | undefined {
    const receivedAt = input.receivedAt ?? Date.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO live_event_inbox (source, event_id, kind, payload_json, status, received_at)
      VALUES (?, ?, ?, ?, 'PENDING', ?)
    `).run(input.source, input.eventId, input.kind, JSON.stringify(input.payload), receivedAt);
    if (Number(result.changes) === 0) return undefined;
    const row = this.db.prepare('SELECT * FROM live_event_inbox WHERE id = ?').get(Number(result.lastInsertRowid)) as LiveEventInboxRow;
    return this.toLiveEventInboxItem(row);
  }

  claimNextLiveEvent(): LiveEventInboxItem | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT * FROM live_event_inbox
        WHERE status IN ('PENDING', 'PROCESSING')
        ORDER BY id ASC LIMIT 1
      `).get() as LiveEventInboxRow | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return undefined;
      }
      this.db.prepare("UPDATE live_event_inbox SET status = 'PROCESSING', error = NULL WHERE id = ?").run(row.id);
      this.db.exec('COMMIT');
      return { ...this.toLiveEventInboxItem(row), status: 'PROCESSING' };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completeLiveEvent(id: number, error?: string): void {
    this.db.prepare(`
      UPDATE live_event_inbox
      SET status = ?, processed_at = ?, error = ?
      WHERE id = ?
    `).run(error ? 'FAILED' : 'DONE', Date.now(), error ?? null, id);
  }

  listLiveEventInbox(status?: LiveEventInboxItem['status'], limit = 100): LiveEventInboxItem[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM live_event_inbox WHERE status = ? ORDER BY id ASC LIMIT ?').all(status, Math.min(Math.max(limit, 1), 500))
      : this.db.prepare('SELECT * FROM live_event_inbox ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500));
    return (rows as LiveEventInboxRow[]).map((row) => this.toLiveEventInboxItem(row));
  }

  listLiveEventInboxByRange(from: number, to: number, limit = 50_000): LiveEventInboxItem[] {
    const safeLimit = Math.min(Math.max(limit, 1), 50_000);
    const rows = this.db.prepare(`
      SELECT * FROM live_event_inbox
      WHERE received_at >= ? AND received_at <= ? AND status = 'DONE'
      ORDER BY id ASC LIMIT ?
    `).all(from, to, safeLimit) as LiveEventInboxRow[];
    return rows.map((row) => this.toLiveEventInboxItem(row));
  }

  replaceSessionDerivedStats(input: {
    sessionId: string;
    engagement: Array<{ userKey: string; username: string; likeCount: number; validCommentCount: number; points: number; reachedAt: number }>;
    gifts: Array<{ userKey: string; username: string; points: number; giftCount: number; reachedAt: number }>;
  }): void {
    const now = Date.now();
    const engagementInsert = this.db.prepare(`
      INSERT INTO session_user_stats (
        session_id, user_key, username, like_count, valid_comment_count, engagement_points, reached_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const giftInsert = this.db.prepare(`
      INSERT INTO session_gift_stats (
        session_id, user_key, username, points, gift_count, reached_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM session_user_stats WHERE session_id = ?').run(input.sessionId);
      this.db.prepare('DELETE FROM session_gift_stats WHERE session_id = ?').run(input.sessionId);
      for (const item of input.engagement) {
        engagementInsert.run(
          input.sessionId, item.userKey, item.username, item.likeCount,
          item.validCommentCount, item.points, item.reachedAt, now,
        );
      }
      for (const item of input.gifts) {
        giftInsert.run(
          input.sessionId, item.userKey, item.username, item.points,
          item.giftCount, item.reachedAt, now,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction was not opened */ }
      throw error;
    }
  }

  recordSyncMetric(type: string, payload: unknown, sessionId?: string): void {
    this.db.prepare('INSERT INTO sync_metrics (session_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId ?? null, type, JSON.stringify(payload), Date.now());
  }

  listTerminalAudioPathsBefore(cutoff: number): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT tts_audio_path AS path FROM readings
      WHERE tts_audio_path IS NOT NULL AND completed_at IS NOT NULL AND completed_at < ?
        AND status IN ('COMPLETED', 'FAILED', 'FAILED_TIMEOUT', 'ABORTED', 'SKIPPED')
    `).all(cutoff) as Array<{ path: string }>).map((row) => row.path);
  }

  runMaintenanceRecord(kind: string, result: unknown): void {
    this.db.prepare('INSERT INTO maintenance_runs (kind, result_json, created_at) VALUES (?, ?, ?)')
      .run(kind, JSON.stringify(result), Date.now());
  }

  pruneOperationalData(input: { rawEventBefore: number; auditBefore: number }): { inbox: number; audit: number } {
    const inbox = Number(this.db.prepare(`
      DELETE FROM live_event_inbox WHERE received_at < ? AND status IN ('DONE', 'FAILED')
    `).run(input.rawEventBefore).changes);
    const audit = Number(this.db.prepare('DELETE FROM app_events WHERE created_at < ?').run(input.auditBefore).changes);
    return { inbox, audit };
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  integrityCheck(): string {
    const row = this.db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
    return String(row?.integrity_check ?? Object.values(row ?? {})[0] ?? 'unknown');
  }

  createDailyBackup(directory: string, timestamp = Date.now()): string | undefined {
    if (this.filePath === ':memory:') return undefined;
    mkdirSync(directory, { recursive: true });
    this.checkpoint();
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const target = join(directory, `${basename(this.filePath)}.${date}.bak`);
    if (!existsSync(target)) copyFileSync(this.filePath, target);
    return target;
  }

  listEvents(limit = 200): AppEvent[] {
    return (this.db.prepare('SELECT * FROM app_events ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)) as AppEventRow[])
      .map((row) => ({
        id: Number(row.id),
        readingId: row.reading_id ?? undefined,
        type: row.type,
        payload: row.payload_json ? JSON.parse(row.payload_json) : {},
        createdAt: Number(row.created_at),
      }));
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as { value_json?: string } | undefined;
    if (!row?.value_json) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }

  blockUser(input: { userKey: string; username: string; reason: string }): void {
    this.db.prepare(`
      INSERT INTO blocked_users (user_key, username, reason, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_key) DO UPDATE SET username = excluded.username, reason = excluded.reason, created_at = excluded.created_at
    `).run(input.userKey, input.username, input.reason, Date.now());
  }

  unblockUser(userKey: string): boolean {
    return Number(this.db.prepare('DELETE FROM blocked_users WHERE user_key = ?').run(userKey).changes) > 0;
  }

  isBlocked(userKey: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM blocked_users WHERE user_key = ?').get(userKey));
  }

  listBlockedUsers(limit = 200): BlockedUser[] {
    return (this.db.prepare('SELECT * FROM blocked_users ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)) as BlockedUserRow[])
      .map((row) => ({
        userKey: row.user_key,
        username: row.username ?? row.user_key,
        reason: row.reason ?? '',
        createdAt: Number(row.created_at),
      }));
  }

  hasCompletedSince(userKey: string, since: number): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM readings
      WHERE lower(COALESCE(user_id, username)) = ? AND status = 'COMPLETED' AND completed_at >= ?
      LIMIT 1
    `).get(userKey, since));
  }

  saveGiftEntitlement(entitlement: GiftEntitlement): void {
    this.db.prepare(`
      INSERT INTO gift_entitlements (
        id, source_event_id, user_key, username, rule_id, gift_id, gift_name, repeat_count,
        priority, speech_target_seconds, status, reading_id, created_at, applied_at, expires_at
      ) VALUES (
        @id, @source_event_id, @user_key, @username, @rule_id, @gift_id, @gift_name, @repeat_count,
        @priority, @speech_target_seconds, @status, @reading_id, @created_at, @applied_at, @expires_at
      ) ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        reading_id=excluded.reading_id,
        applied_at=excluded.applied_at,
        expires_at=excluded.expires_at
    `).run({
      id: entitlement.id,
      source_event_id: entitlement.sourceEventId,
      user_key: entitlement.userKey,
      username: entitlement.username,
      rule_id: entitlement.ruleId,
      gift_id: entitlement.giftId ?? null,
      gift_name: entitlement.giftName,
      repeat_count: entitlement.repeatCount,
      priority: entitlement.priority,
      speech_target_seconds: entitlement.speechTargetSeconds,
      status: entitlement.status,
      reading_id: entitlement.readingId ?? null,
      created_at: entitlement.createdAt,
      applied_at: entitlement.appliedAt ?? null,
      expires_at: entitlement.expiresAt,
    });
  }

  findBestPendingGiftEntitlement(userKey: string, now = Date.now()): GiftEntitlement | undefined {
    const row = this.db.prepare(`
      SELECT * FROM gift_entitlements
      WHERE user_key = ? AND status = 'PENDING' AND expires_at > ?
      ORDER BY CASE priority WHEN 'MANUAL' THEN 3 WHEN 'HIGH' THEN 2 ELSE 1 END DESC,
        speech_target_seconds DESC, created_at ASC
      LIMIT 1
    `).get(userKey, now) as GiftEntitlementRow | undefined;
    return row ? this.toGiftEntitlement(row) : undefined;
  }

  getGiftEntitlementBySourceEventId(sourceEventId: string): GiftEntitlement | undefined {
    const row = this.db.prepare('SELECT * FROM gift_entitlements WHERE source_event_id = ? ORDER BY created_at ASC LIMIT 1').get(sourceEventId) as GiftEntitlementRow | undefined;
    return row ? this.toGiftEntitlement(row) : undefined;
  }

  markGiftEntitlementApplied(id: string, readingId: string, appliedAt = Date.now()): void {
    this.db.prepare(`
      UPDATE gift_entitlements SET status = 'APPLIED', reading_id = ?, applied_at = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(readingId, appliedAt, id);
  }

  expireGiftEntitlements(now = Date.now()): number {
    return Number(this.db.prepare(`
      UPDATE gift_entitlements SET status = 'EXPIRED'
      WHERE status = 'PENDING' AND expires_at <= ?
    `).run(now).changes);
  }

  listGiftEntitlements(options: number | { limit?: number; from?: number; to?: number } = 100): GiftEntitlement[] {
    const normalized = typeof options === 'number' ? { limit: options } : options;
    const limit = Math.min(Math.max(normalized.limit ?? 100, 1), 500);
    const conditions: string[] = [];
    const parameters: number[] = [];
    if (Number.isFinite(normalized.from)) { conditions.push('created_at >= ?'); parameters.push(normalized.from!); }
    if (Number.isFinite(normalized.to)) { conditions.push('created_at < ?'); parameters.push(normalized.to!); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM gift_entitlements ${where} ORDER BY created_at DESC LIMIT ?`).all(...parameters, limit) as GiftEntitlementRow[])
      .map((row) => this.toGiftEntitlement(row));
  }

  saveQualificationGrant(grant: QualificationGrant): void {
    this.db.prepare(`
      INSERT INTO qualification_grants (
        id, source_event_id, session_id, user_key, username, kind, rule_id, label,
        priority, speech_target_seconds, status, reading_id, created_at, applied_at, expires_at
      ) VALUES (
        @id, @source_event_id, @session_id, @user_key, @username, @kind, @rule_id, @label,
        @priority, @speech_target_seconds, @status, @reading_id, @created_at, @applied_at, @expires_at
      ) ON CONFLICT(source_event_id, kind, rule_id) DO NOTHING
    `).run({
      id: grant.id,
      source_event_id: grant.sourceEventId,
      session_id: grant.sessionId ?? null,
      user_key: grant.userKey,
      username: grant.username,
      kind: grant.kind,
      rule_id: grant.ruleId,
      label: grant.label,
      priority: grant.priority,
      speech_target_seconds: grant.speechTargetSeconds,
      status: grant.status,
      reading_id: grant.readingId ?? null,
      created_at: grant.createdAt,
      applied_at: grant.appliedAt ?? null,
      expires_at: grant.expiresAt,
    });
  }

  findBestPendingQualificationGrant(userKey: string, now = Date.now()): QualificationGrant | undefined {
    const row = this.db.prepare(`
      SELECT * FROM qualification_grants
      WHERE user_key = ? AND status = 'PENDING' AND expires_at > ?
      ORDER BY CASE priority WHEN 'MANUAL' THEN 3 WHEN 'HIGH' THEN 2 ELSE 1 END DESC,
        speech_target_seconds DESC, created_at ASC
      LIMIT 1
    `).get(userKey, now) as QualificationGrantRow | undefined;
    return row ? this.toQualificationGrant(row) : undefined;
  }

  getLatestQualificationGrant(userKey: string, kind: QualificationGrant['kind'], ruleId: string, sessionId?: string): QualificationGrant | undefined {
    const row = this.db.prepare(`
      SELECT * FROM qualification_grants
      WHERE user_key = ? AND kind = ? AND rule_id = ?
        AND (? IS NULL OR session_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(userKey, kind, ruleId, sessionId ?? null, sessionId ?? null) as QualificationGrantRow | undefined;
    return row ? this.toQualificationGrant(row) : undefined;
  }

  markQualificationGrantApplied(id: string, readingId: string, appliedAt = Date.now()): void {
    this.db.prepare(`
      UPDATE qualification_grants SET status = 'APPLIED', reading_id = ?, applied_at = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(readingId, appliedAt, id);
  }

  expireQualificationGrants(now = Date.now()): number {
    return Number(this.db.prepare(`
      UPDATE qualification_grants SET status = 'EXPIRED'
      WHERE status = 'PENDING' AND expires_at <= ?
    `).run(now).changes);
  }

  /**
   * Apply a shortened operator timeout to grants that were created under an
   * older policy. Extending the setting never lengthens an already-issued
   * entitlement; shortening it takes effect immediately and consistently.
   */
  alignPendingQualificationExpiry(expireMinutes: number, now = Date.now()): number {
    const durationMs = Math.max(1, Math.round(expireMinutes)) * 60_000;
    this.db.prepare(`
      UPDATE gift_entitlements
      SET expires_at = MIN(expires_at, created_at + ?)
      WHERE status = 'PENDING'
    `).run(durationMs);
    this.db.prepare(`
      UPDATE qualification_grants
      SET expires_at = MIN(expires_at, created_at + ?)
      WHERE status = 'PENDING'
    `).run(durationMs);
    return this.expireGiftEntitlements(now) + this.expireQualificationGrants(now);
  }

  listQualificationGrants(limit = 100, status?: QualificationGrant['status']): QualificationGrant[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = status
      ? this.db.prepare('SELECT * FROM qualification_grants WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, safeLimit)
      : this.db.prepare('SELECT * FROM qualification_grants ORDER BY created_at DESC LIMIT ?').all(safeLimit);
    return (rows as QualificationGrantRow[]).map((row) => this.toQualificationGrant(row));
  }

  getSessionUserLikeCount(sessionId: string, userKey: string): number {
    const row = this.db.prepare('SELECT like_count FROM session_user_stats WHERE session_id = ? AND user_key = ?').get(sessionId, userKey) as { like_count: number | bigint } | undefined;
    return row ? Number(row.like_count) : 0;
  }

  getDashboardMetrics(since = Date.now() - 30 * 60 * 1000): DashboardMetrics {
    const count = (status: ReadingStatus) => Number((this.db.prepare('SELECT count(*) AS value FROM readings WHERE status = ? AND created_at >= ?').get(status, since) as { value: number | bigint }).value);
    const wait = this.db.prepare(`
      SELECT AVG(selected_at - created_at) AS value FROM readings
      WHERE status = 'COMPLETED' AND selected_at IS NOT NULL AND completed_at >= ?
    `).get(since) as { value: number | bigint | null };
    const speaking = this.db.prepare(`
      SELECT AVG(completed_at - selected_at) AS value FROM readings
      WHERE status = 'COMPLETED' AND selected_at IS NOT NULL AND completed_at >= ?
    `).get(since) as { value: number | bigint | null };
    return {
      completedLast30Minutes: count('COMPLETED'),
      failedLast30Minutes: count('FAILED') + count('FAILED_TIMEOUT') + count('SKIPPED'),
      averageQueueWaitMs: wait.value === null ? 0 : Number(wait.value),
      averageSpeakingMs: speaking.value === null ? 0 : Number(speaking.value),
    };
  }

  saveLiveSession(session: LiveSession): void {
    this.db.prepare(`
      INSERT INTO live_sessions (
        session_id, mode, status, profile_version_id, started_at, ended_at, last_heartbeat_at, operator_note, end_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        mode=excluded.mode,
        status=excluded.status,
        profile_version_id=excluded.profile_version_id,
        started_at=excluded.started_at,
        ended_at=excluded.ended_at,
        last_heartbeat_at=excluded.last_heartbeat_at,
        operator_note=excluded.operator_note,
        end_reason=excluded.end_reason
    `).run(
      session.sessionId,
      session.mode,
      session.status,
      session.profileVersionId,
      session.startedAt ?? null,
      session.endedAt ?? null,
      session.lastHeartbeatAt,
      session.operatorNote ?? null,
      session.endReason ?? null,
    );
  }

  getLiveSession(sessionId: string): LiveSession | undefined {
    const row = this.db.prepare('SELECT * FROM live_sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.toLiveSession(row) : undefined;
  }

  getOpenLiveSession(): LiveSession | undefined {
    const row = this.db.prepare(`
      SELECT * FROM live_sessions
      WHERE status IN ('PREPARING', 'LIVE', 'PAUSED', 'ENDING', 'RECOVERING')
      ORDER BY COALESCE(started_at, last_heartbeat_at) DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    return row ? this.toLiveSession(row) : undefined;
  }

  listLiveSessions(limit = 50): LiveSession[] {
    return (this.db.prepare('SELECT * FROM live_sessions ORDER BY COALESCE(started_at, last_heartbeat_at) DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>).map((row) => this.toLiveSession(row));
  }

  saveDirectorCue(cue: DirectorCue): void {
    this.db.prepare(`
      INSERT INTO director_cues (
        cue_id, session_id, reading_id, sequence, stage, track, starts_at, ends_at, revision, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cue_id) DO UPDATE SET
        starts_at=excluded.starts_at,
        ends_at=excluded.ends_at,
        revision=excluded.revision,
        payload_json=excluded.payload_json
    `).run(
      cue.cueId,
      cue.sessionId,
      cue.readingId ?? null,
      cue.sequence,
      cue.stage,
      cue.track,
      cue.startsAt,
      cue.endsAt ?? null,
      cue.revision,
      JSON.stringify(cue.payload),
      cue.createdAt,
    );
  }

  getLastDirectorSequence(sessionId: string): number {
    const row = this.db.prepare('SELECT MAX(sequence) AS value FROM director_cues WHERE session_id = ?').get(sessionId) as { value: number | bigint | null };
    return row.value === null ? 0 : Number(row.value);
  }

  listDirectorCues(sessionId: string, limit = 200): DirectorCue[] {
    return (this.db.prepare('SELECT * FROM director_cues WHERE session_id = ? ORDER BY sequence DESC LIMIT ?')
      .all(sessionId, Math.min(Math.max(limit, 1), 1_000)) as Array<Record<string, unknown>>)
      .map((row) => this.toDirectorCue(row));
  }

  getActiveDirectorCue(sessionId: string, track: DirectorCue['track'] = 'MAIN'): DirectorCue | undefined {
    const row = this.db.prepare(`
      SELECT * FROM director_cues
      WHERE session_id = ? AND track = ? AND ends_at IS NULL
      ORDER BY sequence DESC LIMIT 1
    `).get(sessionId, track) as Record<string, unknown> | undefined;
    return row ? this.toDirectorCue(row) : undefined;
  }

  saveSceneProfileVersion(value: SceneProfileVersion): void {
    this.db.prepare(`
      INSERT INTO scene_profile_versions (
        version_id, profile_id, version, status, profile_json, created_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(version_id) DO UPDATE SET
        status=excluded.status,
        profile_json=excluded.profile_json,
        published_at=excluded.published_at
    `).run(value.versionId, value.profileId, value.version, value.status, JSON.stringify(value.profile), value.createdAt, value.publishedAt ?? null);
  }

  getSceneProfileVersion(versionId: string): SceneProfileVersion | undefined {
    const row = this.db.prepare('SELECT * FROM scene_profile_versions WHERE version_id = ?').get(versionId) as Record<string, unknown> | undefined;
    return row ? this.toSceneProfileVersion(row) : undefined;
  }

  getLatestSceneProfileVersion(profileId: string, status?: SceneProfileVersion['status']): SceneProfileVersion | undefined {
    const row = status
      ? this.db.prepare('SELECT * FROM scene_profile_versions WHERE profile_id = ? AND status = ? ORDER BY version DESC LIMIT 1').get(profileId, status)
      : this.db.prepare('SELECT * FROM scene_profile_versions WHERE profile_id = ? ORDER BY version DESC LIMIT 1').get(profileId);
    return row ? this.toSceneProfileVersion(row as Record<string, unknown>) : undefined;
  }

  listSceneProfileVersions(profileId: string, limit = 100): SceneProfileVersion[] {
    return (this.db.prepare('SELECT * FROM scene_profile_versions WHERE profile_id = ? ORDER BY version DESC LIMIT ?')
      .all(profileId, Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>)
      .map((row) => this.toSceneProfileVersion(row));
  }

  archivePublishedSceneProfiles(profileId: string): void {
    this.db.prepare("UPDATE scene_profile_versions SET status = 'ARCHIVED' WHERE profile_id = ? AND status = 'PUBLISHED'").run(profileId);
  }

  /** Publish the scene and create its next editable draft as one SQLite transaction. */
  publishSceneProfile(input: {
    published: SceneProfileVersion;
    nextDraft: SceneProfileVersion;
    session?: LiveSession;
  }): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.archivePublishedSceneProfiles(input.published.profileId);
      this.saveSceneProfileVersion(input.published);
      if (input.session) this.saveLiveSession(input.session);
      this.saveSceneProfileVersion(input.nextDraft);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction was not opened */ }
      throw error;
    }
  }

  addSessionGiftStats(input: { sessionId: string; userKey: string; username: string; points: number; giftCount: number; at?: number }): void {
    const at = input.at ?? Date.now();
    this.db.prepare(`
      INSERT INTO session_gift_stats (session_id, user_key, username, points, gift_count, reached_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, user_key) DO UPDATE SET
        username=excluded.username,
        points=session_gift_stats.points + excluded.points,
        gift_count=session_gift_stats.gift_count + excluded.gift_count,
        reached_at=excluded.reached_at,
        updated_at=excluded.updated_at
    `).run(input.sessionId, input.userKey, input.username, input.points, input.giftCount, at, at);
  }

  setSessionEngagementStats(input: { sessionId: string; userKey: string; username: string; likeCount: number; validCommentCount: number; points: number; at?: number }): void {
    const at = input.at ?? Date.now();
    this.db.prepare(`
      INSERT INTO session_user_stats (
        session_id, user_key, username, like_count, valid_comment_count, engagement_points, reached_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, user_key) DO UPDATE SET
        username=excluded.username,
        like_count=excluded.like_count,
        valid_comment_count=excluded.valid_comment_count,
        engagement_points=excluded.engagement_points,
        reached_at=CASE WHEN session_user_stats.engagement_points = excluded.engagement_points THEN session_user_stats.reached_at ELSE excluded.reached_at END,
        updated_at=excluded.updated_at
    `).run(input.sessionId, input.userKey, input.username, input.likeCount, input.validCommentCount, input.points, at, at);
  }

  addSessionEngagementStats(input: { sessionId: string; userKey: string; username: string; likeDelta?: number; validCommentDelta?: number; likeUnit: number; likePoints: number; commentPoints: number; at?: number }): void {
    const at = input.at ?? Date.now();
    const likeDelta = Math.max(0, Math.round(input.likeDelta ?? 0));
    const commentDelta = Math.max(0, Math.round(input.validCommentDelta ?? 0));
    this.db.prepare(`
      INSERT INTO session_user_stats (
        session_id, user_key, username, like_count, valid_comment_count, engagement_points, reached_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, (CAST(? / ? AS INTEGER) * ?) + (? * ?), ?, ?)
      ON CONFLICT(session_id, user_key) DO UPDATE SET
        username=excluded.username,
        like_count=session_user_stats.like_count + ?,
        valid_comment_count=session_user_stats.valid_comment_count + ?,
        engagement_points=(CAST((session_user_stats.like_count + ?) / ? AS INTEGER) * ?) + ((session_user_stats.valid_comment_count + ?) * ?),
        reached_at=CASE
          WHEN session_user_stats.engagement_points = ((CAST((session_user_stats.like_count + ?) / ? AS INTEGER) * ?) + ((session_user_stats.valid_comment_count + ?) * ?))
          THEN session_user_stats.reached_at ELSE ? END,
        updated_at=?
    `).run(
      input.sessionId, input.userKey, input.username, likeDelta, commentDelta,
      likeDelta, input.likeUnit, input.likePoints, commentDelta, input.commentPoints, at, at,
      likeDelta, commentDelta,
      likeDelta, input.likeUnit, input.likePoints, commentDelta, input.commentPoints,
      likeDelta, input.likeUnit, input.likePoints, commentDelta, input.commentPoints, at, at,
    );
  }

  getSessionGiftRanking(sessionId: string, limit = 20): SessionGiftRankingEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM session_gift_stats WHERE session_id = ? AND points > 0
      ORDER BY points DESC, reached_at ASC LIMIT ?
    `).all(sessionId, Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
    return rows.map((row, index) => ({
      sessionId,
      userKey: String(row.user_key),
      username: String(row.username),
      points: Number(row.points),
      giftCount: Number(row.gift_count),
      reachedAt: Number(row.reached_at),
      rank: index + 1,
    }));
  }

  getSessionEngagementRanking(sessionId: string, limit = 20): SessionEngagementRankingEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM session_user_stats WHERE session_id = ? AND engagement_points > 0
      ORDER BY engagement_points DESC, reached_at ASC LIMIT ?
    `).all(sessionId, Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
    return rows.map((row, index) => ({
      sessionId,
      userKey: String(row.user_key),
      username: String(row.username),
      points: Number(row.engagement_points),
      likeCount: Number(row.like_count),
      validCommentCount: Number(row.valid_comment_count),
      reachedAt: Number(row.reached_at),
      rank: index + 1,
    }));
  }

  saveMediaAsset(asset: MediaAsset): void {
    this.db.prepare(`
      INSERT INTO media_assets (
        id, kind, file_name, mime_type, content_hash, size_bytes, storage_path, storage_key,
        width, height, duration_ms, transparency, origin, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, file_name=excluded.file_name, mime_type=excluded.mime_type, content_hash=excluded.content_hash,
        size_bytes=excluded.size_bytes, storage_path=excluded.storage_path, storage_key=excluded.storage_key,
        width=excluded.width, height=excluded.height, duration_ms=excluded.duration_ms,
        transparency=excluded.transparency, origin=excluded.origin, created_at=excluded.created_at
    `).run(
      asset.id, asset.kind, asset.fileName, asset.mimeType, asset.contentHash, asset.sizeBytes, asset.storagePath ?? '', asset.storageKey ?? null,
      asset.width ?? null, asset.height ?? null, asset.durationMs ?? null, asset.transparency, asset.origin, asset.createdAt,
    );
  }

  getMediaAsset(id: string): MediaAsset | undefined {
    const row = this.db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toMediaAsset(row) : undefined;
  }

  getMediaAssetByHash(contentHash: string): MediaAsset | undefined {
    const row = this.db.prepare('SELECT * FROM media_assets WHERE content_hash = ?').get(contentHash) as Record<string, unknown> | undefined;
    return row ? this.toMediaAsset(row) : undefined;
  }

  listMediaAssets(): MediaAsset[] {
    return (this.db.prepare('SELECT * FROM media_assets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>)
      .map((row) => this.toMediaAsset(row));
  }

  deleteMediaAsset(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM media_assets WHERE id = ?').run(id).changes) > 0;
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private toReading(row: ReadingRow): Reading {
    return {
      id: row.id,
      sessionId: row.session_id ?? undefined,
      sourceEventId: row.source_event_id ?? undefined,
      source: row.source,
      username: row.username,
      userId: row.user_id ?? undefined,
      rawQuestion: row.raw_question,
      normalizedQuestion: row.normalized_question ?? undefined,
      category: row.category ?? undefined,
      moderationDecision: row.moderation_decision ?? undefined,
      moderationReason: row.moderation_reason ?? undefined,
      status: row.status,
      priority: row.priority,
      gift: row.gift_json ? JSON.parse(row.gift_json) : undefined,
      qualification: row.qualification_json ? JSON.parse(row.qualification_json) : undefined,
      speechTargetSeconds: row.speech_target_seconds ?? undefined,
      voiceSnapshot: row.voice_snapshot_json ? JSON.parse(row.voice_snapshot_json) : undefined,
      meihua: row.meihua_json ? JSON.parse(row.meihua_json) : undefined,
      answer: row.answer_json ? JSON.parse(row.answer_json) : undefined,
      pipeline: row.pipeline_json ? JSON.parse(row.pipeline_json) : undefined,
      digitalHumanSnapshot: row.digital_human_json ? JSON.parse(row.digital_human_json) : undefined,
      presentationSnapshot: row.presentation_json ? JSON.parse(row.presentation_json) : undefined,
      tts: row.tts_duration_ms ? {
        audioPath: row.tts_audio_path ?? undefined,
        durationMs: row.tts_duration_ms,
        lipSyncPlan: row.lip_sync_plan_json ? JSON.parse(row.lip_sync_plan_json) : undefined,
        analysisVersion: row.lip_sync_plan_json ? 'sapi-viseme-rms-v1' : undefined,
      } : undefined,
      speechPlan: row.speech_plan_json ? JSON.parse(row.speech_plan_json) : undefined,
      lipSyncPlan: row.lip_sync_plan_json ? JSON.parse(row.lip_sync_plan_json) as LipSyncPlan : undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
      selectedAt: row.selected_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
    };
  }

  private toGiftEntitlement(row: GiftEntitlementRow): GiftEntitlement {
    return {
      id: row.id,
      sourceEventId: row.source_event_id,
      userKey: row.user_key,
      username: row.username,
      ruleId: row.rule_id,
      giftId: row.gift_id ?? undefined,
      giftName: row.gift_name,
      repeatCount: Number(row.repeat_count),
      priority: row.priority,
      speechTargetSeconds: Number(row.speech_target_seconds),
      receivedAt: Number(row.created_at),
      status: row.status,
      readingId: row.reading_id ?? undefined,
      createdAt: Number(row.created_at),
      appliedAt: row.applied_at ?? undefined,
      expiresAt: Number(row.expires_at),
    };
  }

  private toQualificationGrant(row: QualificationGrantRow): QualificationGrant {
    return {
      id: row.id,
      sourceEventId: row.source_event_id,
      sessionId: row.session_id ?? undefined,
      userKey: row.user_key,
      username: row.username,
      kind: row.kind,
      ruleId: row.rule_id,
      label: row.label,
      priority: row.priority,
      speechTargetSeconds: Number(row.speech_target_seconds),
      status: row.status,
      readingId: row.reading_id ?? undefined,
      createdAt: Number(row.created_at),
      appliedAt: row.applied_at ?? undefined,
      expiresAt: Number(row.expires_at),
    };
  }

  private toLiveSession(row: Record<string, unknown>): LiveSession {
    return {
      sessionId: String(row.session_id),
      mode: String(row.mode ?? 'REHEARSAL') as LiveSession['mode'],
      status: String(row.status) as LiveSession['status'],
      profileVersionId: String(row.profile_version_id),
      startedAt: row.started_at === null ? undefined : Number(row.started_at),
      endedAt: row.ended_at === null ? undefined : Number(row.ended_at),
      lastHeartbeatAt: Number(row.last_heartbeat_at),
      operatorNote: row.operator_note === null ? undefined : String(row.operator_note),
      endReason: row.end_reason === null ? undefined : String(row.end_reason),
    };
  }

  private toLiveEventInboxItem(row: LiveEventInboxRow): LiveEventInboxItem {
    return {
      id: Number(row.id),
      source: row.source as LiveEventInboxItem['source'],
      eventId: row.event_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as LiveEventInboxItem['payload'],
      status: row.status,
      receivedAt: Number(row.received_at),
      processedAt: row.processed_at === null ? undefined : Number(row.processed_at),
      error: row.error ?? undefined,
    };
  }

  private toDirectorCue(row: Record<string, unknown>): DirectorCue {
    return {
      cueId: String(row.cue_id),
      sessionId: String(row.session_id),
      readingId: row.reading_id === null ? undefined : String(row.reading_id),
      sequence: Number(row.sequence),
      stage: String(row.stage) as DirectorCue['stage'],
      track: String(row.track) as DirectorCue['track'],
      startsAt: Number(row.starts_at),
      endsAt: row.ends_at === null ? undefined : Number(row.ends_at),
      revision: Number(row.revision),
      payload: row.payload_json ? JSON.parse(String(row.payload_json)) : {},
      createdAt: Number(row.created_at),
    };
  }

  private toSceneProfileVersion(row: Record<string, unknown>): SceneProfileVersion {
    return {
      versionId: String(row.version_id),
      profileId: String(row.profile_id),
      version: Number(row.version),
      status: String(row.status) as SceneProfileVersion['status'],
      profile: JSON.parse(String(row.profile_json)),
      createdAt: Number(row.created_at),
      publishedAt: row.published_at === null ? undefined : Number(row.published_at),
    };
  }

  private toMediaAsset(row: Record<string, unknown>): MediaAsset {
    return {
      id: String(row.id),
      kind: String(row.kind) as MediaAsset['kind'],
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      contentHash: String(row.content_hash),
      sizeBytes: Number(row.size_bytes),
      storagePath: String(row.storage_path),
      storageKey: row.storage_key === null || row.storage_key === undefined ? undefined : String(row.storage_key),
      width: row.width === null ? undefined : Number(row.width),
      height: row.height === null ? undefined : Number(row.height),
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      transparency: String(row.transparency) as MediaAsset['transparency'],
      origin: (row.origin === 'SYSTEM' ? 'SYSTEM' : 'UPLOADED'),
      createdAt: Number(row.created_at),
    };
  }
}
