import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistence } from '@meihua/persistence';
import type { SceneProfile, SceneProfileVersion } from '@meihua/core-types';
import { formatHexagramDisplayName } from '@meihua/answer-composer';
import type { TtsAdapter } from '@meihua/adapters';
import { LiveRuntime, defaultSettings } from './runtime.js';
import { buildSpeechPlan, createDefaultSceneProfile, migrateSceneComposition } from './v2.js';

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
    id: 'deterministic-test-tts',
    health: () => ({ id: 'deterministic-test-tts', label: 'Deterministic test TTS', status: 'READY', message: 'Test WAV generator ready', configured: true }),
    async synthesize(input) {
      const durationMs = Math.max(3_000, Math.round((input.targetSeconds ?? 10) * 1_000));
      const sampleRate = 16_000;
      const sampleCount = Math.round(sampleRate * durationMs / 1_000);
      const pcm = Buffer.alloc(sampleCount * 2);
      const wav = Buffer.alloc(44 + pcm.length);
      wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
      const fileName = `${input.readingId.replace(/[^a-z0-9_-]/gi, '_')}-${sequence += 1}.wav`;
      writeFileSync(join(directory, fileName), wav);
      return { audioPath: `/api/audio/${fileName}`, durationMs, providerId: 'deterministic-test-tts', targetLocale: input.targetLocale as never, engineVersion: 'test-v1' };
    },
  };
}

function createRuntime(options: { realTts?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'meihua-v2-'));
  directories.push(directory);
  const audioDirectory = join(directory, 'audio');
  const runtime = new LiveRuntime(new SqlitePersistence(':memory:'), {
    audioDirectory,
    mediaDirectory: join(directory, 'media'),
    ttsAdapter: options.realTts ? undefined : createDeterministicTts(audioDirectory),
    audioPlayer: {
      async play({ signal, onStarted }) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const startedAt = Date.now();
        onStarted?.(startedAt);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
        });
        return { startedAt, endedAt: Date.now() };
      },
    },
  });
  runtimes.push(runtime);
  return runtime;
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for live runtime state.`);
}

describe('V2 director and synchronized plan', () => {
  it('defaults to prerecorded video presentation and exposes an audio-only escape hatch', () => {
    const runtime = createRuntime();
    expect(runtime.getSettings().presentation).toMatchObject({ mode: 'VIDEO_ONCE', fallbackPolicy: 'VIDEO', profiles: [] });
    expect(runtime.getPresentationPreflight().ready).toBe(false);
    runtime.updatePresentationSettings({ mode: 'AUDIO_ONLY' });
    expect(runtime.getPresentationPreflight()).toMatchObject({ mode: 'AUDIO_ONLY', ready: true });
  });

  it('creates one authoritative layer per business module and migrates legacy elements', () => {
    const profile = createDefaultSceneProfile(defaultSettings);
    expect(profile.composition?.width).toBe(1080);
    expect(new Set(profile.composition!.layers.map((layer) => layer.zIndex)).size).toBe(profile.composition!.layers.length);
    const moduleIds = profile.composition!.layers.filter((layer) => layer.kind === 'MODULE').map((layer) => layer.moduleId);
    expect(new Set(moduleIds).size).toBe(moduleIds.length);
    const legacy = { ...profile, composition: undefined, elements: [{ id: 'old-text', kind: 'text' as const, text: '双击右侧属性面板编辑文字', x: 10, y: 20, width: 300, height: 80 }] };
    expect(migrateSceneComposition(legacy).composition?.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'old-text', kind: 'TEXT', visible: false, name: '示例文字 1' }),
    ]));
  });

  it('defaults formal business sources to borderless chroma while preserving native transparent audio', () => {
    const runtime = createRuntime();
    const profile = createDefaultSceneProfile(runtime.getSettings());
    expect(profile.sources.hexagram).toMatchObject({ backgroundMode: 'CHROMA', borderless: true, chromaColor: '#00ff00' });
    expect(profile.sources.queue).toMatchObject({ backgroundMode: 'CHROMA', borderless: true });
    expect(profile.sources.audio).toMatchObject({ backgroundMode: 'TRANSPARENT', borderless: true });
    expect(profile.sources.background).toMatchObject({ backgroundMode: 'SOLID', borderless: false });
  });

  it('creates a locked session, persists ordered cues, and ends it normally', () => {
    const runtime = createRuntime();
    const start = runtime.startSession({ mode: 'REHEARSAL' });
    expect(start).toMatchObject({ ok: true, session: { status: 'LIVE' } });
    expect(runtime.getDirectorCues()).toHaveLength(1);
    expect(runtime.getDirectorCues()[0]).toMatchObject({ sequence: 1, stage: 'IDLE', track: 'MAIN' });
    expect(runtime.pauseSession()).toMatchObject({ ok: true, session: { status: 'PAUSED' } });
    expect(runtime.resumeSession()).toMatchObject({ ok: true, session: { status: 'LIVE' } });
    const sequences = runtime.getDirectorCues().map((cue) => cue.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(runtime.endSession()).toMatchObject({ ok: true, session: { status: 'ENDED' } });
    expect(runtime.getSessionReport(start.session!.sessionId)?.session.endReason).toBe('NORMAL_END');
  });

  it('keeps the draft isolated until an atomic publish switches the active session profile', () => {
    const runtime = createRuntime();
    const before = runtime.getSceneDraft();
    runtime.updateSceneDraft({ ...before.profile, name: '下一场草稿' });
    expect(runtime.publishSceneDraft()).toMatchObject({ ok: true });
    const session = runtime.startSession({ mode: 'REHEARSAL' });
    expect(session.ok).toBe(true);
    runtime.updateSceneDraft({ ...runtime.getSceneDraft().profile, name: '直播中编辑的下一场' });
    expect(runtime.publishSceneDraft()).toMatchObject({ ok: true });
    expect(runtime.getBroadcastSnapshotV2().profileVersion.profile.name).toBe('直播中编辑的下一场');
    expect(runtime.getBroadcastSnapshotV2().profileVersion.versionId).not.toBe(session.session!.profileVersionId);
  });

  it('scores gifts, likes and valid comments once per source event within the session', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    const gift = { source: 'tikfinity' as const, eventId: 'gift-v2-1', userId: 'u1', username: 'GiftUser', giftId: '5655', giftName: 'Rose', repeatCount: 4, repeatEnd: true, timestamp: Date.now(), raw: {} };
    await runtime.ingestGift(gift); await runtime.ingestGift(gift);
    const like = { source: 'tikfinity' as const, eventId: 'like-v2-1', userId: 'u2', username: 'LikeUser', likeCount: 20, timestamp: Date.now(), raw: {} };
    await runtime.ingestLike(like); await runtime.ingestLike(like);
    await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'comment-v2-1', userId: 'u2', username: 'LikeUser', message: 'reading: Should I keep moving forward?', timestamp: Date.now(), raw: {} });
    const snapshot = runtime.getBroadcastSnapshotV2();
    expect(snapshot.giftRanking[0]).toMatchObject({ username: 'GiftUser', points: 4, giftCount: 4 });
    expect(snapshot.engagementRanking[0]).toMatchObject({ username: 'LikeUser', points: 2, likeCount: 20, validCommentCount: 0 });
  });

  it('updates an isolated preview session without changing the formal profile', () => {
    const runtime = createRuntime();
    const formalName = runtime.getBroadcastSnapshotV2().profileVersion.profile.name;
    const preview = runtime.createPreviewSession({ scenario: 'SPEAKING' });
    runtime.updatePreviewSession(preview.previewSessionId, { profile: { ...preview.profile, name: '临时实时预览' }, scenario: 'GIFT' });
    expect(runtime.getPreviewSnapshot(preview.previewSessionId)).toMatchObject({ stage: 'QUALIFIED', profileVersion: { profile: { name: '临时实时预览' } } });
    expect(runtime.getBroadcastSnapshotV2().profileVersion.profile.name).toBe(formalName);
    const idle = runtime.createPreviewSession({ scenario: 'IDLE' });
    expect(runtime.getPreviewSnapshot(idle.previewSessionId)).toMatchObject({ stage: 'IDLE', reading: undefined, speechPlan: undefined });
  });

  it('validates media and deduplicates by content hash', () => {
    const runtime = createRuntime();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lRHF2wAAAABJRU5ErkJggg==';
    const first = runtime.uploadMediaAsset({ kind: 'AVATAR_IMAGE', fileName: 'avatar.png', mimeType: 'image/png', base64: png });
    const duplicate = runtime.uploadMediaAsset({ kind: 'AVATAR_IMAGE', fileName: 'copy.png', mimeType: 'image/png', base64: png });
    expect(duplicate.id).toBe(first.id);
    expect(first).toMatchObject({ width: 1, height: 1, transparency: 'PRESENT' });
    expect(() => runtime.uploadMediaAsset({ kind: 'AVATAR_IMAGE', fileName: 'fake.png', mimeType: 'image/png', base64: Buffer.from('not png').toString('base64') })).toThrow('MEDIA_FILE_SIGNATURE_INVALID');
  });

  it('rejects duplicate business modules and reports referenced asset usages', () => {
    const persistence = new SqlitePersistence(':memory:');
    const runtime = new LiveRuntime(persistence);
    runtimes.push(runtime);
    const draft = structuredClone(runtime.getSceneDraft().profile);
    const module = draft.composition!.layers.find((layer) => layer.kind === 'MODULE')!;
    draft.composition!.layers.push({ ...module, id: 'duplicate-module' });
    expect(() => runtime.updateSceneDraft(draft)).toThrow('SCENE_MODULE_DUPLICATE_OR_INVALID');

    const valid = structuredClone(runtime.getSceneDraft().profile);
    persistence.saveMediaAsset({ id: 'asset-used', kind: 'OVERLAY_IMAGE', origin: 'UPLOADED', fileName: 'used.png', mimeType: 'image/png', contentHash: 'hash-used', sizeBytes: 1, storagePath: 'missing.png', storageKey: 'missing.png', transparency: 'PRESENT', createdAt: Date.now() });
    valid.composition!.layers.push({ id: 'asset-layer', kind: 'ASSET', name: '被引用素材', assetId: 'asset-used', fit: 'CONTAIN', transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 }, visible: true, locked: false, opacity: 1, zIndex: 100 });
    runtime.updateSceneDraft(valid);
    expect(runtime.deleteMediaAsset('asset-used')).toMatchObject({ ok: false, usages: expect.arrayContaining([expect.stringContaining('被引用素材')]) });
  });

  it('allocates the exact WAV duration with a 900ms segment minimum', () => {
    const plan = buildSpeechPlan('reading-1', { opening: 'Hello, your reading is ready.', speech: 'The first point is steady progress. The key is one practical step. Review the result before expanding.', keywords: ['practical step'], closing: 'Use this as personal reflection.', estimatedSeconds: 12 }, 12_000);
    expect(plan.segments.reduce((sum, item) => sum + item.durationMs, 0)).toBe(12_000);
    expect(plan.segments.every((item) => item.durationMs >= 900)).toBe(true);
    expect(plan.segments.some((item) => item.avatarAction === 'SPEAKING_EMPHASIS')).toBe(true);
    expect(new Set(plan.segments.map((item) => item.hexagramFocus))).toEqual(new Set(['PRIMARY', 'MUTUAL', 'CHANGED']));
  });

  it('recovers an unended session as paused after a process restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'meihua-recovery-'));
    directories.push(directory);
    const databasePath = join(directory, 'live.db');
    const first = new LiveRuntime(new SqlitePersistence(databasePath), { mediaDirectory: join(directory, 'media-a') });
    const started = first.startSession({ mode: 'REHEARSAL' });
    expect(started.ok).toBe(true);
    first.close();
    const second = new LiveRuntime(new SqlitePersistence(databasePath), { mediaDirectory: join(directory, 'media-b') });
    runtimes.push(second);
    expect(second.getCurrentSession()).toMatchObject({ sessionId: started.session!.sessionId, status: 'PAUSED', endReason: 'PROCESS_RESTART_RECOVERY' });
    expect(second.getHealth()).toMatchObject({ acceptingQuestions: false, autoProcessing: false, currentStage: 'PAUSED' });
  });

  it('re-anchors the speaking cue when the real audio source starts', () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    const internals = runtime as unknown as { startDirectorCue: (stage: 'SPEAKING', readingId: undefined, payload: Record<string, unknown>) => { cueId: string; startsAt: number } };
    const cue = internals.startDirectorCue('SPEAKING', undefined, { awaitingAudioStart: true, avatarAction: 'SPEAKING_NEUTRAL' });
    const before = cue.startsAt;
    const lease = runtime.registerAudioSource('vitest-audio-source');
    expect(runtime.recordAudioPlaybackEvent({ event: 'PLAY_STARTED', sourceInstanceId: lease.sourceInstanceId, leaseId: lease.leaseId, cueId: cue.cueId, positionMs: 240 })).toEqual({ ok: true });
    const updated = runtime.getDirectorState().activeCue!;
    expect(updated.revision).toBeGreaterThan(1);
    expect(updated.payload).toMatchObject({ awaitingAudioStart: false, audioClockSource: 'LEGACY_BROWSER_SOURCE' });
    expect(updated.startsAt).toBeLessThanOrEqual(before);
  });

  it('allows only one formal audio source lease and rejects forged playback events', () => {
    const runtime = createRuntime();
    const primary = runtime.registerAudioSource('audio-primary');
    const duplicate = runtime.registerAudioSource('audio-duplicate');
    expect(primary.active).toBe(true);
    expect(duplicate.active).toBe(false);
    expect(runtime.recordAudioPlaybackEvent({ event: 'PLAY_STARTED', sourceInstanceId: 'audio-primary', leaseId: 'forged' })).toEqual({ ok: false, reason: 'AUDIO_LEASE_NOT_HELD' });
    expect(runtime.getSyncMetrics()).toMatchObject({ activeLease: { sourceInstanceId: 'audio-primary' } });
  });

  it('blocks live until the selected presentation is ready', () => {
    const runtime = createRuntime();
    const result = runtime.startSession({ mode: 'LIVE' });
    expect(result.ok).toBe(false);
    const failures = result.preflight.checks.filter((check) => check.status === 'FAIL').map((check) => check.id);
    expect(failures).toEqual(expect.arrayContaining(['presentation']));
    expect(failures).not.toEqual(expect.arrayContaining(['native-audio']));
    expect(runtime.getCurrentSession()).toBeUndefined();
  });

  it('blocks formal live while persisted mock work remains in the queue', async () => {
    const runtime = createRuntime();
    runtime.pause();
    await runtime.ingest({
      source: 'mock', eventId: 'persisted-mock-reading', userId: 'mock-user', username: 'MockUser',
      message: 'Should this simulated question enter a formal live session?', timestamp: Date.now(), raw: {},
    });
    expect(runtime.getQueueOverview()).toEqual(expect.arrayContaining([expect.objectContaining({ eventSource: 'MOCK' })]));
    expect(runtime.getPreflight('LIVE').checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'data-provenance', status: 'FAIL' }),
    ]));
    expect(runtime.getPreflight('REHEARSAL').checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'data-provenance', status: 'PASS' }),
    ]));
  });

  it('keeps the simplified like qualification label synchronized with its threshold', () => {
    const runtime = createRuntime();
    const current = runtime.getSettings().engagement.likeRules[0];
    const updated = runtime.updateSettings({ engagement: { likeRules: [{ ...current, threshold: 80, label: 'stale 100-like copy' }] } });
    expect(updated.engagement.likeRules[0]).toMatchObject({ threshold: 80, label: '累计点赞 80 次' });
  });

  it('ships comprehensive multilingual question recognition and one entitlement timeout', () => {
    const runtime = createRuntime();
    const defaults = runtime.getSettings();
    expect(defaults.engagement.commentRules[0]?.keywords.length).toBeGreaterThan(100);
    expect(defaults.engagement.commentRules[0]?.keywords).toEqual(expect.arrayContaining([
      '什么时候发财', 'when will', 'est-ce que', '転職', '이직', 'quando', 'стоит ли',
    ]));
    const updated = runtime.updateSettings({ queue: { expireMinutes: 24 } });
    expect(updated.gifts.entitlementExpireMinutes).toBe(24);
    expect(updated.engagement.likeRules.every((rule) => rule.grantExpireMinutes === 24)).toBe(true);
    expect(updated.engagement.commentRules.every((rule) => rule.queueExpireMinutes === 24)).toBe(true);
  });

  it('drives a measured WAV through the native backend playback contract', async () => {
    const runtime = createRuntime();
    runtime.updateSettings({
      providers: { llm: { adapter: 'rule-based' } },
      presentation: { mode: 'AUDIO_ONLY' },
    });
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    runtime.updateSettings({ reading: { speechTargetSeconds: 14, watchdogMs: 45_000 } });
    const reading = await runtime.ingest({
      source: 'mock', eventId: 'sync-integration-reading', userId: 'sync-viewer', username: 'SyncViewer',
      message: 'Should I move steadily forward with this plan?', timestamp: Date.now(), raw: {},
    });
    const cue = await waitFor(() => {
      const current = runtime.getDirectorState().activeCue;
      return current?.stage === 'SPEAKING' && current.payload.audioClockSource === 'NATIVE_WINDOWS' ? current : undefined;
    }, 30_000).catch((error: Error) => {
      const current = runtime.getReading(reading.id);
      throw new Error(`${error.message} Reading state: ${current?.status}; ${current?.errorCode ?? ''}; ${current?.errorMessage ?? ''}`);
    });
    const prepared = runtime.getReading(reading.id)!;
    expect(prepared.tts?.audioPath).toMatch(/^\/api\/audio\/.*\.wav$/);
    // Verify a real, bounded WAV and let every visual timeline follow its
    // measured duration. Individual engine integration is covered separately.
    expect(prepared.tts?.durationMs).toBeGreaterThanOrEqual(3_000);
    expect(prepared.tts?.durationMs).toBeLessThanOrEqual(18_000);
    expect(prepared.speechPlan?.totalDurationMs).toBe(prepared.tts?.durationMs);
    expect(prepared.speechPlan?.segments.length).toBeGreaterThan(0);
    expect(prepared.lipSyncPlan).toMatchObject({ version: 1, mode: 'AMPLITUDE_ONLY', frameIntervalMs: 20 });
    expect(prepared.speechPlan?.lipSyncPlan).toEqual(prepared.lipSyncPlan);
    expect(cue.payload).toMatchObject({ awaitingAudioStart: false, audioClockSource: 'NATIVE_WINDOWS' });

    const completed = await waitFor(() => runtime.getReading(reading.id)?.status === 'COMPLETED' ? runtime.getReading(reading.id) : undefined);
    expect(completed.status).toBe('COMPLETED');
    const stages = runtime.getDirectorCues().map((item) => item.stage);
    expect(stages).toEqual(expect.arrayContaining(['SELECTED', 'CASTING', 'INTERPRETING', 'COMPOSING', 'SYNTHESIZING', 'SPEAKING', 'FINISH']));
  }, 45_000);
});

describe('V2.2 official integrated stage', () => {
  it('defaults meihua-stage to a fixed 1080×1920 solid full-screen composition', () => {
    const runtime = createRuntime();
    const profile = createDefaultSceneProfile(runtime.getSettings());
    expect(profile.sources['meihua-stage']).toMatchObject({
      sourceId: 'meihua-stage',
      enabled: true,
      width: 1080,
      height: 1920,
      backgroundMode: 'SOLID',
      borderless: false,
      backgroundOpacity: 1,
      maxItems: 6,
      idleBehavior: 'KEEP_LAST',
    });
    expect(Object.keys(profile.sources)).toContain('meihua-stage');
  }, 30_000);

  it('injects the stage source into an older persisted scene profile without dropping existing sources', () => {
    const directory = mkdtempSync(join(tmpdir(), 'meihua-migrate-'));
    directories.push(directory);
    const dbPath = join(directory, 'state.db');
    const legacyPersistence = new SqlitePersistence(dbPath);
    const legacyProfile = createDefaultSceneProfile(defaultSettings);
    const { 'meihua-stage': _removed, ...legacySources } = legacyProfile.sources;
    const legacyVersion: SceneProfileVersion = {
      versionId: 'legacy-published', profileId: 'main', version: 5, status: 'PUBLISHED' as const,
      profile: { ...legacyProfile, sources: legacySources as SceneProfile['sources'] }, createdAt: Date.now(), publishedAt: Date.now(),
    };
    legacyPersistence.saveSceneProfileVersion(legacyVersion);
    legacyPersistence.close();

    const runtime = new LiveRuntime(new SqlitePersistence(dbPath), {
      audioDirectory: join(directory, 'audio'),
      mediaDirectory: join(directory, 'media'),
    });
    runtimes.push(runtime);
    const snapshot = runtime.getBroadcastSnapshotV2();
    expect(snapshot.profileVersion.profile.sources['meihua-stage']).toMatchObject({
      sourceId: 'meihua-stage', width: 1080, height: 1920, backgroundMode: 'SOLID', borderless: false, enabled: true,
    });
    expect(snapshot.profileVersion.profile.sources.hexagram).toBeDefined();
    expect(snapshot.profileVersion.profile.sources['full-preview']).toBeDefined();
    const stored = runtime.getSceneVersions().find((version) => version.versionId === 'legacy-published');
    expect(stored?.profile.sources['meihua-stage']).toBeDefined();
  });

  it('keeps the stage cue-driven: snapshots expose the active cue, side gift cues and the reading for the stage renderer', async () => {
    const runtime = createRuntime();
    runtime.updateSettings({ providers: { llm: { adapter: 'rule-based' } }, presentation: { mode: 'AUDIO_ONLY' } });
    const started = runtime.startSession({ mode: 'REHEARSAL' });
    expect(started.ok).toBe(true);
    await runtime.ingestGift({
      source: 'mock', eventId: 'stage-gift', userId: 'stage-user', username: 'StageViewer',
      giftId: '5655', giftName: 'Rose', repeatCount: 4, repeatEnd: true, timestamp: Date.now(), raw: {},
    });
    const waiting = runtime.getQueueOverview().find((item) => item.username === 'StageViewer');
    expect(waiting?.status).toBe('WAITING_QUESTION');
    const queued = await runtime.ingest({
      source: 'mock', eventId: 'stage-chat', userId: 'stage-user', username: 'StageViewer',
      message: 'Should I take one careful step forward?', timestamp: Date.now() + 1, raw: {},
    });
    expect(queued.status).toBe('QUEUED');
    // Auto-processing pops the reading immediately, so the stage's "casting
    // now" row comes from snapshot.reading while the queue row statuses come
    // from the qualification overview. Wait until the cast has been produced.
    const snapshot = await waitFor(() => {
      const current = runtime.getBroadcastSnapshotV2();
      return current.reading?.meihua && current.activeCue ? current : undefined;
    }, 20_000);
    expect(snapshot.reading).toMatchObject({ username: 'StageViewer', priority: 'HIGH' });
    expect(snapshot.reading?.gift).toMatchObject({ giftName: 'Rose' });
    expect(snapshot.activeCue?.track).toBe('MAIN');
    expect(['INTERPRETING', 'COMPOSING', 'SYNTHESIZING', 'SPEAKING']).toContain(snapshot.activeCue?.stage);
    // The GIFT side cue keeps its own track so the stage gift banner is
    // fully cue-driven and expires when the runtime closes the cue.
    expect(snapshot.sideCues.some((cue) => cue.track === 'GIFT' && cue.payload.username === 'StageViewer' && cue.payload.giftName === 'Rose')).toBe(true);
    expect(snapshot.qualificationQueue.find((item) => item.username === 'StageViewer')).toBeUndefined();
    runtime.skipCurrent();
  }, 30_000);
});

describe('V2.2 avatar provider adapter layer', () => {
  it('reports local VRM as not configured until an approved model is selected', async () => {
    const runtime = createRuntime();
    runtime.updateSettings({ providers: { avatar: { adapter: 'local-vrm' } } });
    const health = runtime.getHealth();
    const avatarRow = health.providers.find((item) => item.id === 'local-vrm-avatar');
    expect(avatarRow?.label).toBe('本地透明 VRM 数字人');
    expect(avatarRow?.status).toBe('NOT_CONFIGURED');
    expect(health.avatarProvider?.vendorSelected).toBe(false);
    expect(health.avatarProvider?.media).toEqual({ kind: 'STATIC' });
    // The mock provider never fabricates a media stream, so the integrated
    // stage keeps using the staged action assets.
    const snapshot = runtime.getBroadcastSnapshotV2();
    expect(snapshot.avatarStageMedia).toBeUndefined();
    expect(snapshot.avatarRuntime).toBe('NONE');
  });

  it('runs the full mock provider linkage: capabilities, session, every stage action, media output', async () => {
    const runtime = createRuntime();
    const report = await runtime.runAvatarProviderMockLinkage();
    expect(report.ok).toBe(true);
    expect(report.actions).toHaveLength(9);
    expect(report.actions.every((item) => item.ok)).toBe(true);
    expect(report.state.vendorSelected).toBe(false);
    expect(report.media).toEqual({ kind: 'STATIC' });
    // The state is captured while the mock session was still alive.
    expect(report.state.sessionActive).toBe(true);
    expect(report.state.sessionId).toMatch(/^avatar-mock-session-/);
  });

  it('routes stage actions through the provider during the live pipeline', async () => {
    const runtime = createRuntime();
    // The production default is a prerecorded video and this unit test has no
    // media profile. Keep the presentation layer explicit so the test focuses
    // on provider stage actions rather than failing preflight.
    runtime.updateSettings({ providers: { avatar: { adapter: 'mock' }, llm: { adapter: 'rule-based' }, tts: { adapter: 'windows', voiceId: 'Microsoft Zira Desktop' } }, presentation: { mode: 'AUDIO_ONLY' }, reading: { speechTargetSeconds: 10 } });
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    const reading = await runtime.ingest({
      source: 'mock', eventId: 'provider-pipeline', username: 'ProviderViewer',
      message: 'Should I take one careful step forward?', timestamp: Date.now(), raw: {},
    });
    await waitFor(() => {
      const current = runtime.getReading(reading.id);
      if (current && ['FAILED', 'FAILED_TIMEOUT', 'ABORTED', 'SKIPPED'].includes(current.status)) {
        throw new Error(`Live provider pipeline failed: ${current.status} ${current.errorCode ?? ''} ${current.errorMessage ?? ''}`);
      }
      return current?.status === 'COMPLETED' ? current : undefined;
    }, 40_000);
    const provider = runtime.getHealth().avatarProvider;
    expect(['CASTING', 'THINKING', 'SPEAKING_NEUTRAL', 'FINISH']).toContain(provider?.lastAction);
    runtime.skipCurrent();
  }, 45_000);
});

describe('V2.2 Meihua engine selection and duration calibration', () => {
  it('defaults to the canonical mingyu engine and allows rollback to legacy', async () => {
    const runtime = createRuntime();
    expect(runtime.getSettings().meihua.engine).toBe('MINGYU_CORE');
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    const canonical = await runtime.ingest({
      source: 'mock', eventId: 'engine-canonical', username: 'EngineViewer',
      message: 'Should I take one careful step forward?', timestamp: Date.now(), raw: {},
    });
    // The cast happens inside the live pipeline; wait until the reading holds one.
    const cast = await waitFor(() => {
      const current = runtime.getReading(canonical.id);
      return current?.meihua ? current.meihua : undefined;
    }, 40_000);
    // The live pipeline uses the viewer, question, and source event as the
    // deterministic three-number input, so different questions can differ
    // while retries of the same event remain stable.
    expect(cast.engineVersion).toBe('meihua-v2.2-mingyu-core-number-policy');
    expect(cast.provenance?.method).toBe('NUMBER');
    expect(cast.provenance?.inputs).toMatchObject({ numbers: expect.any(Array) });
    expect(cast.provenance?.source).toBeTruthy();
    expect(cast.primary.number).toBeGreaterThanOrEqual(1);
    expect(cast.primary.number).toBeLessThanOrEqual(64);
    runtime.skipCurrent();

    runtime.updateSettings({ meihua: { engine: 'LEGACY_V2_1' } });
    const rollback = await runtime.ingest({
      source: 'mock', eventId: 'engine-legacy', username: 'RollbackViewer',
      message: 'Should I steady my pace this month?', timestamp: Date.now() + 1, raw: {},
    });
    const legacyCast = await waitFor(() => {
      const current = runtime.getReading(rollback.id);
      return current?.meihua ? current.meihua : undefined;
    }, 40_000);
    expect(legacyCast.engineVersion).toBe('meihua-traditional-time-number-v2.1');
    expect(legacyCast.provenance?.inputs?.numbers).toEqual(expect.any(Array));
    runtime.skipCurrent();
  }, 55_000);

  it('measures real WAV duration and reports the calibration result for tiered speech', async () => {
    const runtime = createRuntime();
    runtime.updateSettings({
      providers: { llm: { adapter: 'rule-based' }, tts: { adapter: 'windows', voiceId: 'Microsoft Zira Desktop' } },
      presentation: { mode: 'AUDIO_ONLY' },
      reading: { speechTargetSeconds: 20, watchdogMs: 90_000 },
    });
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    const reading = await runtime.ingest({
      source: 'mock', eventId: 'tier-20s', username: 'TierViewer',
      message: 'Should I move forward with my current plan?', timestamp: Date.now(), raw: {},
    });
    const completed = await waitFor(() => runtime.getReading(reading.id)?.status === 'COMPLETED' ? runtime.getReading(reading.id) : undefined, 60_000);
    // A real WAV was synthesized and the plan duration equals its measured length.
    expect(completed.tts?.audioPath).toMatch(/^\/api\/audio\/.*\.wav$/);
    expect(completed.tts?.durationMs).toBeGreaterThanOrEqual(900);
    expect(completed.meihua?.provenance?.method).toBe('NUMBER');
    expect(completed.meihua?.provenance?.inputs?.numbers).toEqual(expect.any(Array));
    expect(completed.speechPlan?.totalDurationMs).toBe(completed.tts?.durationMs);
    expect(completed.speechPlan?.segments.length).toBeGreaterThan(0);
    for (const segment of completed.speechPlan!.segments) expect(segment.durationMs).toBeGreaterThanOrEqual(900);
    // The interpretation is traceable to a canonical cast for the UI.
    expect(completed.answer?.speech).toContain(completed.meihua!.changed ? formatHexagramDisplayName(completed.meihua!.changed.number!, completed.meihua!.changed.name, 'en') : '');
    runtime.abortSession({ reason: 'test' });
  }, 70_000);
});

describe('V2.3 MuseTalk local avatar provider', () => {
  it('routes the avatar layer to the MuseTalk adapter when selected', async () => {
    const runtime = createRuntime();
    runtime.updateSettings({ providers: { avatar: { adapter: 'musetalk', url: 'http://127.0.0.1:9898' } } });
    const health = runtime.getHealth();
    const row = health.providers.find((item) => item.id === 'musetalk-avatar');
    expect(row?.label).toBe('MuseTalk 本地实时口型');
    // No rendering service is attached to this isolated test instance. CPU and
    // CUDA are both valid runtime modes; only service reachability matters.
    expect(row?.status).toBe('NOT_CONFIGURED');
    expect(row?.message).toContain('服务尚未启动');
    expect(health.avatarProvider?.vendorId).toBe('musetalk-local');
    // Until the service answers /health the stage keeps using staged assets.
    expect(runtime.getBroadcastSnapshotV2().avatarStageMedia).toBeUndefined();
    // Settings round-trip keeps the selection.
    expect(runtime.getSettings().providers.avatar.adapter).toBe('musetalk');
  });
});

describe('V2.3 GPT-SoVITS voice packs', () => {
  function tinyWav(): Buffer {
    const samples = 16_000 * 12;
    const pcm = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index++) pcm.writeInt16LE(Math.round(Math.sin(index / 6) * 9000), index * 2);
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
    return wav;
  }

  it('adds, lists and removes voice packs with settings persistence', async () => {
    const runtime = createRuntime();
    const pack = await runtime.addGptSoVitsVoice({
      name: '美式女声', fileName: 'mei.wav', mimeType: 'audio/wav',
      base64: tinyWav().toString('base64'), refText: 'This is the reference line.', refLanguage: 'en',
    });
    expect(pack.id).toContain('美式女声');
    expect(pack.refLanguage).toBe('en');
    const listed = runtime.listGptSoVitsVoices();
    expect(listed.voices).toHaveLength(1);
    expect(listed.baseUrl).toBe('http://127.0.0.1:9881');
    expect(runtime.getSettings().providers.tts.gptsovits.voices[0]?.name).toBe('美式女声');
    expect(runtime.listDigitalHumanProfiles().voices[0]).toMatchObject({ status: 'NEEDS_REVIEW', lastError: 'VOICE_REAL_TEST_REQUIRED' });
    expect(runtime.listDigitalHumanProfiles().voices[0]?.previewUrl).toBeUndefined();
    // Health reflects the configured voice count until a real audition passes.
    runtime.updateSettings({ providers: { tts: { adapter: 'gptsovits' } } });
    const health = runtime.getHealth();
    expect(health.providers.find((item) => item.id === 'gptsovits-tts')?.status).toBe('DEGRADED');
    expect(await runtime.removeGptSoVitsVoice(pack.id)).toBe(true);
    expect(runtime.listGptSoVitsVoices().voices).toHaveLength(0);
  });

  it('rejects invalid samples and unknown packs', async () => {
    const runtime = createRuntime();
    await expect(runtime.addGptSoVitsVoice({
      name: 'bad', fileName: 'x.wav', mimeType: 'audio/wav',
      base64: Buffer.from('not a wav').toString('base64'), refText: 'x', refLanguage: 'zh',
    })).rejects.toThrow('VOICE_SAMPLE_FORMAT_INVALID');
    await expect(runtime.removeGptSoVitsVoice('nope')).resolves.toBe(false);
    await expect(runtime.testGptSoVitsVoice('nope')).rejects.toThrow('VOICE_PACK_NOT_FOUND');
  });
});

describe('V2.3 MuseTalk pipeline hook', () => {
  it('renders the narration and exposes managed stage media without virtual-camera playback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meihua-musetalk-'));
    directories.push(directory);
    const calls: string[] = [];
    const urls: string[] = [];
    const renderedPath = join(directory, 'render.mp4');
    writeFileSync(renderedPath, Buffer.from('managed-musetalk-video'));
    const museTalkFetcher: typeof fetch = async (url, init) => {
      const requestUrl = String(url);
      const path = new URL(requestUrl).pathname;
      urls.push(requestUrl);
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      const body = path === '/renders'
        ? { job_id: 'render-job-1', status: 'QUEUED' }
        : path === '/renders/render-job-1'
          ? { job_id: 'render-job-1', status: 'READY', video_path: renderedPath, duration_ms: 3000 }
          : { status: 'ok', avatar: 'default' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'), {
      audioDirectory: join(directory, 'audio'),
      mediaDirectory: join(directory, 'media'),
      museTalkFetcher,
      audioPlayer: {
        async play({ signal, onStarted }) {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          const startedAt = Date.now();
          onStarted?.(startedAt);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 200);
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
          });
          return { startedAt, endedAt: Date.now() };
        },
      },
    });
    runtimes.push(runtime);
    runtime.updateSettings({
      // Use a URL different from the constructor default. Direct segmented
      // rendering must follow the saved setting, not the stale startup URL.
      providers: { llm: { adapter: 'rule-based' }, tts: { adapter: 'windows', voiceId: 'Microsoft Zira Desktop', activeVoiceProfileId: 'segmented-test-voice', voiceProfiles: [{ id: 'segmented-test-voice', voiceId: 'Microsoft Zira Desktop', provider: 'legacy', name: 'Segmented test voice', language: 'en', status: 'READY' }] }, avatar: { adapter: 'musetalk', url: 'http://127.0.0.1:9911', activeProfileId: 'segmented-video-avatar', profiles: [{
        id: 'segmented-video-avatar', name: 'Segmented test avatar', provider: 'LOCAL_VIDEO', status: 'READY',
        sourceAssetId: 'test-source', preparedAvatarId: 'default', maxTextureSize: 2048, renderFps: 30,
        createdAt: Date.now(), updatedAt: Date.now(), version: 1, authorizationConfirmed: true,
      }] } },
      reading: { speechTargetSeconds: 10, watchdogMs: 45_000 },
      presentation: { mode: 'DIGITAL_HUMAN' },
    });
    expect(runtime.startSession({ mode: 'REHEARSAL' })).toMatchObject({ ok: true });
    const reading = await runtime.ingest({
      source: 'mock', eventId: 'muse-hook', username: 'MuseViewer',
      message: 'Should I take one careful step forward?', timestamp: Date.now(), raw: {},
    });
    const completed = await waitFor(() => runtime.getReading(reading.id)?.status === 'COMPLETED' ? runtime.getReading(reading.id) : undefined, 60_000);
    expect(completed.status).toBe('COMPLETED');
    // The ready local-video profile uses per-sentence prebuffering; every
    // segment is rendered independently and the next one starts in parallel.
    expect(calls.filter((call) => call === 'POST /renders').length).toBeGreaterThan(1);
    expect(urls.filter((url) => new URL(url).pathname === '/renders').every((url) => new URL(url).origin === 'http://127.0.0.1:9911')).toBe(true);
    expect(calls.some((call) => call === 'GET /renders/render-job-1')).toBe(true);
    expect(calls.some((call) => call.includes('/play'))).toBe(false);
    expect(runtime.getBroadcastSnapshotV2().avatarStageMedia).toMatchObject({ kind: 'VIDEO_URL', muted: true });
    expect(runtime.listDigitalHumanBroadcast()[0]).toMatchObject({ source: 'READING', status: 'FINISHED' });
    expect(runtime.listAvatarRenderJobs().every((job) => job.status === 'FINISHED')).toBe(true);
    expect(calls.some((call) => call.includes('/health'))).toBe(true);
    runtime.skipCurrent();
  }, 40_000);
});
