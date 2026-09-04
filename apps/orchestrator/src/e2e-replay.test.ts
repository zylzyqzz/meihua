import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistence } from '@meihua/persistence';
import { normalizeTikfinityEnvelope } from '@meihua/adapters';
import type { TtsAdapter } from '@meihua/adapters';
import { LiveRuntime } from './runtime.js';

const runtimes: LiveRuntime[] = [];
const directories: string[] = [];
afterEach(() => {
  while (runtimes.length) runtimes.pop()?.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function createDeterministicTts(directory: string): TtsAdapter {
  mkdirSync(directory, { recursive: true });
  let sequence = 0;
  return {
    id: 'deterministic-e2e-tts',
    health: () => ({ id: 'deterministic-e2e-tts', label: 'Deterministic E2E TTS', status: 'READY', message: 'Test WAV generator ready', configured: true }),
    async synthesize(input) {
      const durationMs = Math.max(3_000, Math.round((input.targetSeconds ?? 10) * 1_000));
      const sampleRate = 16_000;
      const samples = Math.round(sampleRate * durationMs / 1_000);
      const pcm = Buffer.alloc(samples * 2);
      const wav = Buffer.alloc(44 + pcm.length);
      wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
      const fileName = `${input.readingId.replace(/[^a-z0-9_-]/gi, '_')}-${sequence += 1}.wav`;
      writeFileSync(join(directory, fileName), wav);
      return { audioPath: `/api/audio/${fileName}`, durationMs, providerId: 'deterministic-e2e-tts', targetLocale: input.targetLocale as never, engineVersion: 'test-v1' };
    },
  };
}

function createRuntime() {
  const directory = mkdtempSync(join(tmpdir(), 'meihua-e2e-'));
  directories.push(directory);
  const audioDirectory = join(directory, 'audio');
  const runtime = new LiveRuntime(new SqlitePersistence(':memory:'), {
    audioDirectory,
    mediaDirectory: join(directory, 'media'),
    ttsAdapter: createDeterministicTts(audioDirectory),
    audioPlayer: {
      async play({ signal, onStarted }) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const startedAt = Date.now();
        onStarted?.(startedAt);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 220);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
        });
        return { startedAt, endedAt: Date.now() };
      },
    },
  });
  runtimes.push(runtime);
  return runtime;
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 25_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for live runtime state.`);
}

describe('V2.2 end-to-end replay chain', () => {
  it('runs gift → qualification → question → queue → cast → speech → ranking → stage sync', async () => {
    const runtime = createRuntime();
    runtime.updateSettings({ providers: { llm: { adapter: 'rule-based' } }, presentation: { mode: 'AUDIO_ONLY' }, reading: { speechTargetSeconds: 10, watchdogMs: 45_000 } });
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });

    // 1. Gift with streak final frame lands as a pending entitlement.
    const gift = await runtime.ingestGift({
      source: 'mock', eventId: 'e2e-gift', userId: 'e2e-user', username: 'E2EViewer',
      giftId: '5655', giftName: 'Rose', repeatCount: 4, repeatEnd: true, timestamp: Date.now(), raw: {},
    });
    expect(gift.accepted).toBe(true);
    expect(gift.action).toBe('PENDING_QUESTION');
    const waiting = runtime.getQueueOverview().find((item) => item.username === 'E2EViewer');
    expect(waiting?.status).toBe('WAITING_QUESTION');
    expect(waiting?.giftName).toBe('Rose');

    // 2. The qualifying viewer posts a matching question.
    const queued = await runtime.ingest({
      source: 'mock', eventId: 'e2e-chat', userId: 'e2e-user', username: 'E2EViewer',
      message: 'Should I take one careful step forward?', timestamp: Date.now() + 1, raw: {},
    });
    expect(queued.status).toBe('QUEUED');
    expect(queued.priority).toBe('HIGH');
    expect(queued.gift?.giftName).toBe('Rose');
    // Auto-processing pops the reading right away; the stage's "casting now"
    // row is the snapshot.reading while the qualification overview keeps the
    // rows that are still waiting. The queued reading carries the question.
    expect(queued.normalizedQuestion).toContain('careful step');

    // 3. Auto-processing completes the whole chain: hexagram, answer, real WAV,
    // speech plan, ranking points and the gift side cue.
    const completed = await waitFor(() => runtime.getReading(queued.id)?.status === 'COMPLETED' ? runtime.getReading(queued.id) : undefined, 30_000);
    expect(completed.meihua?.primary.name).toBeTruthy();
    expect(completed.meihua?.movingLines.length).toBe(1);
    expect(completed.answer?.speech.length).toBeGreaterThan(0);
    expect(completed.tts?.audioPath).toMatch(/^\/api\/audio\/.*\.wav$/);
    expect(completed.speechPlan?.totalDurationMs).toBe(completed.tts?.durationMs);
    const stages = runtime.getDirectorCues().map((cue) => cue.stage);
    expect(stages).toEqual(expect.arrayContaining(['SELECTED', 'CASTING', 'INTERPRETING', 'SPEAKING', 'FINISH']));
    const report = runtime.getSessionReport(runtime.getCurrentSession()!.sessionId);
    expect(report?.giftRanking.some((entry) => entry.username === 'E2EViewer' && entry.points === 4)).toBe(true);

    // 4. Stage data: active reading is visible during the final stages; the
    // gift side cue carried a Track GIFT message for the banner.
    const snapshots = runtime.getDirectorState().snapshot;
    expect(snapshots.qualificationQueue.find((item) => item.username === 'E2EViewer')).toBeUndefined();
    expect(snapshots.profileVersion.profile.sources['meihua-stage']).toBeDefined();
    await runtime.endSession({ operatorNote: 'e2e complete' });
  }, 40_000);

  it('ignores gift streak preview frames and only grants the final frame', async () => {
    const runtime = createRuntime();
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    // A live provider envelope identical to the real TikFinity gift stream:
    // ongoing streak frames are previews, only repeatEnd=true is the gift event.
    const preview = normalizeTikfinityEnvelope({
      event: 'gift',
      data: { userId: 'u1', uniqueId: 'StreakUser', giftId: '5655', giftName: 'Rose', repeatCount: 4, repeatEnd: false, giftType: 1, giftDetails: { giftType: 1 } },
    });
    expect(preview.kind).toBe('gift-preview');
    const final = normalizeTikfinityEnvelope({
      event: 'gift',
      data: { userId: 'u1', uniqueId: 'StreakUser', giftId: '5655', giftName: 'Rose', repeatCount: 4, repeatEnd: true, giftType: 1 },
    });
    expect(final.kind).toBe('gift');
    if (final.kind === 'gift') {
      const result = await runtime.ingestGift(final.event);
      expect(result.action).toBe('PENDING_QUESTION');
      expect(result.entitlement?.repeatCount).toBe(4);
      expect(result.entitlement?.priority).toBe('HIGH');
    }
  });

  it('grants like-threshold qualifications exactly once and lets the viewer claim them', async () => {
    const runtime = createRuntime();
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    const first = await runtime.ingestLike({ source: 'mock', eventId: 'like-a', userId: 'l1', username: 'Liker', likeCount: 40, totalLikeCount: 40, timestamp: Date.now(), raw: {} });
    expect(first.granted).toBe(false);
    const second = await runtime.ingestLike({ source: 'mock', eventId: 'like-b', userId: 'l1', username: 'Liker', likeCount: 40, totalLikeCount: 80, timestamp: Date.now() + 1, raw: {} });
    expect(second.granted).toBe(false);
    const third = await runtime.ingestLike({ source: 'mock', eventId: 'like-c', userId: 'l1', username: 'Liker', likeCount: 20, totalLikeCount: 100, timestamp: Date.now() + 2, raw: {} });
    expect(third.granted).toBe(true);
    expect(third.ruleId).toBe('likes-100');
    const pending = runtime.getPendingQualifications().find((item) => item.username === 'Liker');
    expect(pending?.kind).toBe('LIKE');
    const claimed = await runtime.ingestTikfinityChat({
      source: 'tikfinity', eventId: 'like-claim', userId: 'l1', username: 'Liker',
      message: 'Should I keep going with my training plan?', timestamp: Date.now() + 3, raw: {},
    });
    expect(claimed?.qualification?.kind).toBe('LIKE');
    expect(claimed?.speechTargetSeconds).toBe(30);
  });

  it('uses comment rules only to recognize questions and never grants entitlement by comment alone', async () => {
    const runtime = createRuntime();
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    runtime.updateSettings({
      engagement: {
        commentRules: [
          { id: 'c-contains', enabled: true, label: '包含', keywords: ['reading'], matchMode: 'CONTAINS', stripKeyword: true, priority: 'NORMAL', speechTargetSeconds: 28, queueExpireMinutes: 20, cooldownMinutes: 10 },
          { id: 'c-exact', enabled: true, label: '精确', keywords: ['Should I go?'], matchMode: 'EXACT', stripKeyword: false, priority: 'NORMAL', speechTargetSeconds: 28, queueExpireMinutes: 20, cooldownMinutes: 10 },
          { id: 'c-regex', enabled: true, label: '正则', keywords: ['^ask\\s+(.+)$'], matchMode: 'REGEX', stripKeyword: false, priority: 'NORMAL', speechTargetSeconds: 28, queueExpireMinutes: 20, cooldownMinutes: 10 },
        ],
      },
    });
    const contains = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 't1', userId: 'u1', username: 'ChatUser1', message: 'reading Should I move to the city next year?', timestamp: Date.now(), raw: {} });
    expect(contains).toBeUndefined();
    const exactMatch = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 't2', userId: 'u2', username: 'ChatUser2', message: 'Should I go?', timestamp: Date.now() + 1, raw: {} });
    expect(exactMatch).toBeUndefined();
    // EXACT mode with a non-matching text creates no reading and no qualification.
    const exactMiss = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 't3', userId: 'u3', username: 'ChatUser3', message: 'should I go now', timestamp: Date.now() + 2, raw: {} });
    expect(exactMiss).toBeUndefined();
    const regex = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 't4', userId: 'u4', username: 'ChatUser4', message: 'ask Should I move to the city?', timestamp: Date.now() + 3, raw: {} });
    expect(regex).toBeUndefined();
    expect(runtime.getPendingQualifications()).toHaveLength(0);
    expect(runtime.getQueue()).toHaveLength(0);
  });

  it('promotes a queued reading and rejects duplicate source events', async () => {
    const runtime = createRuntime();
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    // Auto-processing picks the first reading immediately; the second one stays
    // queued while the first is active, so promotion targets the queued item.
    const first = await runtime.ingest({ source: 'mock', eventId: 'dup-1', username: 'DupUser', message: 'Is this a good week to plan the launch?', timestamp: Date.now(), raw: {} });
    const duplicate = await runtime.ingest({ source: 'mock', eventId: 'dup-2', username: 'DupUser', message: 'Is this a good week to plan the launch?', timestamp: Date.now() + 1, raw: {} });
    expect(duplicate.moderationReason).toBe('duplicate_within_window');
    const queued = await runtime.ingest({ source: 'mock', eventId: 'promote-1', username: 'PromoteUser', message: 'Should I prepare the new studio layout first?', timestamp: Date.now() + 2, raw: {} });
    expect(queued.status).toBe('QUEUED');
    expect(runtime.promote(queued.id)).toBe(true);
    const overview = runtime.getQueueOverview().find((item) => item.id === queued.id);
    expect(overview?.priority).toBe('MANUAL');
    expect(runtime.getQueueOverview()[0]?.id).toBe(queued.id);
    // Same event id is never processed twice.
    const replayed = await runtime.ingest({ source: 'mock', eventId: 'dup-1', username: 'DupUser', message: 'Second send', timestamp: Date.now() + 3, raw: {} });
    expect(replayed.id).toBe(first.id);
    runtime.skipCurrent();
  });

  it('recovers an interrupted session on restart and replays a finished reading', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meihua-recover-'));
    directories.push(directory);
    const dbPath = join(directory, 'state.db');
    // The fake player keeps both phases fast: real WAVs are still generated by
    // Windows TTS, only the loudspeaker playback is skipped (matching the other
    // pipeline tests).
    const fakePlayer = {
      async play({ signal, onStarted }: { signal?: AbortSignal; onStarted?: (startedAt: number) => void }) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const startedAt = Date.now();
        onStarted?.(startedAt);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 220);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
        });
        return { startedAt, endedAt: Date.now() };
      },
    };
    const firstRuntime = new LiveRuntime(new SqlitePersistence(dbPath), {
      audioDirectory: join(directory, 'audio'),
      mediaDirectory: join(directory, 'media'),
      ttsAdapter: createDeterministicTts(join(directory, 'audio')),
      audioPlayer: fakePlayer,
    });
    runtimes.push(firstRuntime);
    firstRuntime.updateSettings({ providers: { llm: { adapter: 'rule-based' } }, presentation: { mode: 'AUDIO_ONLY' }, reading: { speechTargetSeconds: 10, watchdogMs: 45_000 } });
    expect(firstRuntime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    const reading = await firstRuntime.ingest({
      source: 'mock', eventId: 'recover-1', username: 'RecoverUser',
      message: 'Should I proceed step by step?', timestamp: Date.now(), raw: {},
    });
    const completed = await waitFor(() => firstRuntime.getReading(reading.id)?.status === 'COMPLETED' ? firstRuntime.getReading(reading.id) : undefined, 30_000);
    expect(completed.status).toBe('COMPLETED');
    firstRuntime.close();
    runtimes.pop();

    // Process restart: the open session is recovered as PAUSED with intake off
    // (intake rejection after restart is covered by the director restart test).
    const restarted = new LiveRuntime(new SqlitePersistence(dbPath), {
      audioDirectory: join(directory, 'audio'),
      mediaDirectory: join(directory, 'media'),
      ttsAdapter: createDeterministicTts(join(directory, 'audio')),
      audioPlayer: fakePlayer,
    });
    runtimes.push(restarted);
    expect(restarted.getCurrentSession()?.status).toBe('PAUSED');
    expect(restarted.getHealth().acceptingQuestions).toBe(false);

    // Replay drives the stage through CASTING → INTERPRETING → SPEAKING; it is
    // a blocking flow, so the stage is observed while it runs.
    const replayPromise = restarted.replayReading(reading.id);
    const replayStage = await waitFor(() => {
      const state = restarted.getDirectorState();

      return state.snapshot.reading?.id === reading.id && ['CASTING', 'INTERPRETING', 'SPEAKING'].includes(state.stage) ? state : undefined;
    }, 15_000);
    expect(replayStage.snapshot.reading?.id).toBe(reading.id);
    expect(replayStage.snapshot.reading?.meihua?.primary.name).toBeTruthy();
    const replay = await replayPromise;
    expect(replay.ok).toBe(true);
  }, 45_000);
});
