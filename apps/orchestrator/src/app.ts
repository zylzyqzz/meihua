import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createLogger } from '@meihua/logger';
import { normalizeTikfinityEnvelope } from '@meihua/adapters';
import type { AppSettingsPatch, AvatarActionName, AvatarProfile, DigitalHumanPreset, LiveChatEvent, LiveGiftEvent, LiveLikeEvent, LiveSessionMode, MediaAssetKind, PreviewSession, SceneProfile } from '@meihua/core-types';
import { LiveRuntime } from './runtime.js';

type ManualQuestionBody = { username?: string; question?: string };
type IntakeBody = { accepting?: boolean };
type BlockUserBody = { userKey?: string; username?: string; reason?: string };
type MockGiftBody = { username?: string; userId?: string; giftId?: string; giftName?: string; repeatCount?: number };
type MockChatBody = { username?: string; userId?: string; question?: string };
type MockLikeBody = { username?: string; userId?: string; likeCount?: number; totalLikeCount?: number };
type ProviderSecretBody = { apiKey?: string };
type VoiceCloneBody = { name?: string; fileName?: string; mimeType?: string; base64?: string; authorizationConfirmed?: boolean };
type VoicePackBody = { name?: string; fileName?: string; mimeType?: string; base64?: string; refText?: string; refLanguage?: string; targetLocale?: string; targetCountry?: string; accentProfileId?: string; cloneMode?: 'COUNTRY_ACCENT' | 'TIMBRE_ONLY' };
type ProviderTestBody = { text?: string };

export async function createApp(runtime: LiveRuntime, options: { production?: boolean; controlToken?: string } = {}): Promise<FastifyInstance> {
  const logger = createLogger('orchestrator');
  logger.info('Creating local orchestrator API routes');
  const app = Fastify({ logger: false, bodyLimit: 120 * 1024 * 1024 });
  await app.register(cors, {
    origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(websocket);
  await app.register(multipart, { limits: { files: 1, fileSize: 120 * 1024 * 1024, fields: 20 } });

  if (options.production && !options.controlToken) throw new Error('PRODUCTION_CONTROL_TOKEN_REQUIRED');
  if (options.controlToken) {
    const allowedOrigin = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/;
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && !allowedOrigin.test(origin)) return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
      if (request.method === 'OPTIONS') return;
      // WebSocket 升级请求不带令牌也没关系：overlay/preview 本来就是公开的浏览器源地址
      if (typeof request.headers.upgrade === 'string' && request.headers.upgrade.toLowerCase() === 'websocket') return;
      // Cloud vendors must fetch the one-time randomized source asset during
      // enrollment. These routes never expose a listing and only accept a
      // strict filename, so the local control token is not sent to vendors.
      if (request.url.startsWith('/api/public-audio/') || request.url.startsWith('/api/public-media/')) return;
      const headerToken = request.headers['x-meihua-token'];
      const queryToken = (request.query as { token?: string } | undefined)?.token;
      const supplied = typeof headerToken === 'string' ? headerToken : queryToken;
      if (supplied !== options.controlToken) return reply.code(401).send({ error: 'LOCAL_CONTROL_AUTH_REQUIRED' });
    });
  }

  app.get('/api/health', async () => {
    await runtime.refreshProviderReadiness();
    return runtime.getHealth();
  });
  app.get('/api/preflight', async (request) => {
    const { mode } = request.query as { mode?: LiveSessionMode };
    await runtime.refreshProviderReadiness();
    return runtime.getPreflight(mode === 'LIVE' ? 'LIVE' : 'REHEARSAL');
  });
  app.get('/api/state', async () => runtime.getOverlayState());
  app.get('/api/queue', async () => runtime.getQueue());
  app.get('/api/queue/overview', async () => runtime.getQueueOverview());
  app.get('/api/settings', async () => runtime.getPublicSettings());
  app.get('/api/presentation', async () => runtime.getPresentationSettings());
  app.get('/api/presentation/videos', async () => runtime.listPresentationVideos());
  app.get('/api/presentation/preflight', async () => runtime.getPresentationPreflight());
  app.put<{ Body: AppSettingsPatch['presentation'] }>('/api/presentation/settings', async (request, reply) => {
    try { return runtime.updatePresentationSettings(request.body ?? {}); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'PRESENTATION_SETTINGS_INVALID' }); }
  });
  app.post('/api/presentation/videos', async (request, reply) => {
    try {
      if (request.isMultipart()) {
        const part = await request.file();
        if (!part) return reply.code(400).send({ error: 'video file is required' });
        const fields = part.fields as Record<string, { value?: unknown }>;
        const bytes = await part.toBuffer();
        const asset = runtime.uploadMediaAsset({ kind: 'BACKGROUND_VIDEO', fileName: part.filename, mimeType: part.mimetype, base64: bytes.toString('base64') });
        const profile = runtime.createVideoPresentationProfile({
          name: String(fields.name?.value ?? '').trim() || undefined,
          assetId: asset.id,
          playback: String(fields.playback?.value ?? '') === 'ONCE' ? 'ONCE' : 'LOOP',
          fit: String(fields.fit?.value ?? '') === 'CONTAIN' ? 'CONTAIN' : 'COVER',
        });
        return reply.code(201).send({ profile, asset });
      }
      const body = (request.body ?? {}) as { name?: string; assetId?: string; playback?: 'LOOP' | 'ONCE'; fit?: 'COVER' | 'CONTAIN' };
      if (!body.assetId?.trim()) return reply.code(400).send({ error: 'assetId is required' });
      return reply.code(201).send({ profile: runtime.createVideoPresentationProfile({ ...body, assetId: body.assetId.trim() }) });
    } catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'PRESENTATION_VIDEO_PROFILE_CREATE_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/presentation/videos/:id/validate', async (request, reply) => {
    try { return runtime.validateVideoPresentationProfile(request.params.id); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'PRESENTATION_VIDEO_VALIDATE_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/presentation/videos/:id/activate', async (request, reply) => {
    try { return runtime.activateVideoPresentationProfile(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'PRESENTATION_VIDEO_ACTIVATE_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/presentation/videos/:id/disable', async (request, reply) => {
    try { return runtime.disableVideoPresentationProfile(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'PRESENTATION_VIDEO_DISABLE_FAILED' }); }
  });
  app.get('/api/providers/secrets/status', async () => runtime.getProviderSecretStatus());
  app.put<{ Params: { kind: string }; Body: ProviderSecretBody }>('/api/providers/secrets/:kind', async (request, reply) => {
    const { kind } = request.params;
    const allowedKinds = ['llm', 'tts', 'voiceClone', 'avatarClone', 'voiceCloneAliyun', 'voiceCloneBaidu', 'avatarCloneAliyun', 'avatarCloneBaidu'] as const;
    if (!allowedKinds.includes(kind as typeof allowedKinds[number])) return reply.code(404).send({ error: 'UNKNOWN_PROVIDER_SECRET' });
    if (!request.body?.apiKey?.trim()) return reply.code(400).send({ error: 'apiKey is required' });
    try { return runtime.setProviderSecret(kind as typeof allowedKinds[number], request.body.apiKey); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'SECRET_SAVE_FAILED' }); }
  });
  app.delete<{ Params: { kind: string } }>('/api/providers/secrets/:kind', async (request, reply) => {
    const { kind } = request.params;
    const allowedKinds = ['llm', 'tts', 'voiceClone', 'avatarClone', 'voiceCloneAliyun', 'voiceCloneBaidu', 'avatarCloneAliyun', 'avatarCloneBaidu'] as const;
    if (!allowedKinds.includes(kind as typeof allowedKinds[number])) return reply.code(404).send({ error: 'UNKNOWN_PROVIDER_SECRET' });
    return runtime.clearProviderSecret(kind as typeof allowedKinds[number]);
  });
  app.post<{ Params: { kind: string }; Body: ProviderTestBody }>('/api/providers/:kind/test', async (request, reply) => {
    const { kind } = request.params;
    if (kind !== 'llm' && kind !== 'tts') return reply.code(404).send({ error: 'UNKNOWN_PROVIDER' });
    try { return await runtime.testProvider(kind, request.body?.text); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'PROVIDER_TEST_FAILED' }); }
  });
  app.get('/api/tts/voices', async () => runtime.listGptSoVitsVoices());
  app.post<{ Body: VoicePackBody }>('/api/tts/voices', async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim() || !body.fileName?.trim() || !body.base64) return reply.code(400).send({ error: 'name, fileName and base64 audio are required' });
    const refLanguage = body.refLanguage === 'auto' ? 'auto' as const : body.refLanguage === 'en' || body.refLanguage === 'ja' || body.refLanguage === 'ko' || body.refLanguage === 'yue' ? body.refLanguage : 'zh';
    try {
      return reply.code(202).send(runtime.queueVoiceClone({
        name: body.name, fileName: body.fileName, mimeType: body.mimeType ?? '',
        base64: body.base64, refText: body.refText ?? '', refLanguage,
        targetLocale: body.targetLocale as Parameters<LiveRuntime['queueVoiceClone']>[0]['targetLocale'],
        targetCountry: body.targetCountry, accentProfileId: body.accentProfileId, cloneMode: body.cloneMode,
      }));
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : 'VOICE_PACK_SAVE_FAILED' });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/tts/voices/:id', async (request, reply) => {
    return (await runtime.removeGptSoVitsVoice(request.params.id)) ? { ok: true } : reply.code(404).send({ error: 'VOICE_PACK_NOT_FOUND' });
  });
  app.post<{ Params: { id: string }; Body: { text?: string } }>('/api/tts/voices/:id/test', async (request, reply) => {
    try {
      return await runtime.testGptSoVitsVoice(request.params.id, request.body?.text);
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : 'VOICE_TEST_FAILED' });
    }
  });
  app.get('/api/voices', async (_request, reply) => {
    try { return await runtime.listVoiceProfiles(); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'VOICE_LIST_FAILED' }); }
  });
  app.post<{ Body: VoiceCloneBody }>('/api/voices/clone', async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim() || !body.fileName?.trim() || !body.base64) return reply.code(400).send({ error: 'name, fileName and audio are required' });
    try {
      const voice = await runtime.cloneVoice({
        name: body.name,
        fileName: body.fileName,
        mimeType: body.mimeType ?? '',
        audio: Buffer.from(body.base64, 'base64'),
        authorizationConfirmed: body.authorizationConfirmed === true,
      });
      return reply.code(201).send(voice);
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : 'VOICE_CLONE_FAILED' });
    }
  });
  app.get('/api/providers/tikfinity/status', async () => runtime.getHealth().tikfinity);
  app.get('/api/live-events/recent', async (request) => {
    const { limit } = request.query as { limit?: string };
    return runtime.getRecentTikfinityEvents(limit ? Number(limit) : undefined);
  });
  app.get('/api/live-events/gift-catalog', async () => runtime.getCapturedGiftCatalog());
  if (!options.production) {
    app.post<{ Body: { event?: unknown; data?: unknown } }>('/api/providers/tikfinity/validate-event', async (request) => {
      const normalized = normalizeTikfinityEnvelope(request.body ?? {});
      if (normalized.kind === 'chat') return { normalized, result: await runtime.ingestTikfinityChat(normalized.event) };
      if (normalized.kind === 'gift') return { normalized, result: await runtime.ingestGift(normalized.event) };
      if (normalized.kind === 'like') return { normalized, result: await runtime.ingestLike(normalized.event) };
      return { normalized };
    });
  }
  app.put<{ Body: AppSettingsPatch }>('/api/settings', async (request) => runtime.updateSettings(request.body ?? {}));
  app.post('/api/settings/reset', async () => runtime.resetSettings());
  app.get('/api/readings', async (request) => {
    const { limit } = request.query as { limit?: string };
    return runtime.getReadings(limit ? Number(limit) : undefined);
  });
  app.get('/api/logs', async (request) => {
    const { limit } = request.query as { limit?: string };
    return runtime.getEvents(limit ? Number(limit) : undefined);
  });
  app.get('/api/gifts/entitlements', async (request) => {
    const { limit, from, to } = request.query as { limit?: string; from?: string; to?: string };
    return runtime.getGiftEntitlements({
      limit: limit ? Number(limit) : undefined,
      from: from ? Number(from) : undefined,
      to: to ? Number(to) : undefined,
    });
  });
  app.get('/api/qualifications/pending', async () => runtime.getPendingQualifications());
  app.get('/api/audio/:fileName', async (request, reply) => {
    const { fileName } = request.params as { fileName: string };
    const filePath = runtime.getAudioFilePath(fileName);
    if (!filePath || !existsSync(filePath)) return reply.code(404).send({ error: 'AUDIO_NOT_FOUND' });
    return reply.type('audio/wav').header('cache-control', 'private, max-age=3600').send(createReadStream(filePath));
  });
  app.get('/api/public-audio/:fileName', async (request, reply) => {
    const filePath = runtime.getPublicAudioFilePath((request.params as { fileName: string }).fileName);
    if (!filePath || !existsSync(filePath)) return reply.code(404).send({ error: 'PUBLIC_AUDIO_NOT_FOUND' });
    return reply.type('audio/wav').header('cache-control', 'public, max-age=900').send(createReadStream(filePath));
  });
  app.get('/api/public-media/:fileName', async (request, reply) => {
    const filePath = runtime.getPublicMediaFilePath((request.params as { fileName: string }).fileName);
    if (!filePath || !existsSync(filePath)) return reply.code(404).send({ error: 'PUBLIC_MEDIA_NOT_FOUND' });
    return reply.type('video/mp4').header('cache-control', 'public, max-age=900').send(createReadStream(filePath));
  });
  app.get('/api/blocked-users', async () => runtime.getBlockedUsers());
  app.get('/api/readings/:readingId', async (request, reply) => {
    const { readingId } = request.params as { readingId: string };
    const reading = runtime.getReading(readingId);
    return reading ?? reply.code(404).send({ error: 'READING_NOT_FOUND' });
  });

  app.post<{ Body: ManualQuestionBody }>('/api/queue/manual', async (request, reply) => {
    const username = request.body?.username?.trim();
    const question = request.body?.question?.trim();
    if (!username || !question) return reply.code(400).send({ error: 'username and question are required' });
    const event: LiveChatEvent = {
      source: 'manual',
      eventId: `manual-${Date.now()}`,
      username,
      message: question,
      timestamp: Date.now(),
      raw: { manual: true },
    };
    const reading = await runtime.ingest(event, 'MANUAL');
    return reply.code(reading.status === 'REJECTED' ? 422 : 201).send(reading);
  });

  if (!options.production) app.post('/api/mock/seed', async () => {
    await runtime.seedMockQuestions();
    return { ok: true };
  });
  if (!options.production) app.post<{ Body: MockChatBody }>('/api/mock/chat', async (request, reply) => {
    const username = request.body?.username?.trim();
    const question = request.body?.question?.trim();
    if (!username || !question) return reply.code(400).send({ error: 'username and question are required' });
    const reading = await runtime.ingest({
      source: 'mock', eventId: `mock-chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: request.body?.userId?.trim() || undefined,
      username, message: question, timestamp: Date.now(), raw: { mock: true },
    });
    return reply.code(reading.status === 'REJECTED' ? 422 : 201).send(reading);
  });
  if (!options.production) app.post('/api/mock/linkage', async () => {
    const wasProcessing = runtime.getHealth().autoProcessing;
    runtime.pause();
    const settings = runtime.getSettings();
    const rule = settings.gifts.rules.find((item) => item.enabled) ?? settings.gifts.rules[0];
    if (!rule) throw new Error('NO_ENABLED_GIFT_RULE');
    const stamp = Date.now();
    const username = `LinkageTest${String(stamp).slice(-5)}`;
    const userId = `linkage-${stamp}`;
    const gift = await runtime.ingestGift({
      source: 'mock', eventId: `linkage-gift-${stamp}`, userId, username,
      giftId: rule.giftId, giftName: rule.giftName, repeatCount: Math.max(1, rule.minRepeatCount), timestamp: stamp, raw: { linkageSimulation: true },
    });
    const afterGift = runtime.getQueueOverview().find((item) => item.username === username);
    const reading = await runtime.ingest({
      source: 'mock', eventId: `linkage-chat-${stamp}`, userId, username,
      message: 'Should I take one careful step forward with this plan?', timestamp: stamp + 1, raw: { linkageSimulation: true },
    });
    const afterQuestion = runtime.getQueueOverview().find((item) => item.username === username);
    const resumeResult = wasProcessing ? runtime.resume() : { ok: true as const };
    return { ok: gift.accepted && afterGift?.status === 'WAITING_QUESTION' && afterQuestion?.status === 'QUEUED', username, gift, afterGift, readingId: reading.id, afterQuestion, resumeResult };
  });
  if (!options.production) app.post<{ Body: MockGiftBody }>('/api/gifts/mock', async (request, reply) => {
    const username = request.body?.username?.trim();
    const giftName = request.body?.giftName?.trim();
    if (!username || !giftName) return reply.code(400).send({ error: 'username and giftName are required' });
    const event: LiveGiftEvent = {
      source: 'mock',
      eventId: `mock-gift-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: request.body?.userId?.trim() || undefined,
      username,
      giftId: request.body?.giftId?.trim() || undefined,
      giftName,
      repeatCount: Number(request.body?.repeatCount) || 1,
      timestamp: Date.now(),
      raw: { mock: true },
    };
    return runtime.ingestGift(event);
  });
  if (!options.production) app.post<{ Body: MockLikeBody }>('/api/mock/like', async (request, reply) => {
    const username = request.body?.username?.trim();
    const likeCount = Number(request.body?.likeCount);
    if (!username || !Number.isFinite(likeCount) || likeCount <= 0) return reply.code(400).send({ error: 'username and positive likeCount are required' });
    const event: LiveLikeEvent = {
      source: 'mock', eventId: `mock-like-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: request.body?.userId?.trim() || undefined, username, likeCount,
      totalLikeCount: Number(request.body?.totalLikeCount) || undefined, timestamp: Date.now(), raw: { mock: true },
    };
    return runtime.ingestLike(event);
  });
  /** Operator-only test gift (works in all modes, token required). */
  app.post<{ Body: { username?: string; giftName?: string; repeatCount?: number } }>('/api/test/gift', async (request, reply) => {
    const body = request.body ?? {};
    const username = body.username?.trim() || 'TestViewer';
    const giftName = body.giftName?.trim() || 'Rose';
    const repeatCount = Number(body.repeatCount) || 1;
    const event: LiveGiftEvent = {
      source: 'mock', eventId: `test-gift-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      username, giftName, repeatCount, timestamp: Date.now(), raw: { adminTest: true },
    };
    return runtime.ingestGift(event);
  });

  app.post<{ Body: IntakeBody }>('/api/live/intake', async (request, reply) => {
    if (typeof request.body?.accepting !== 'boolean') return reply.code(400).send({ error: 'accepting must be boolean' });
    runtime.setAcceptingQuestions(request.body.accepting);
    return { ok: true, accepting: request.body.accepting };
  });
  app.post('/api/queue/:readingId/promote', async (request, reply) => {
    const { readingId } = request.params as { readingId: string };
    return runtime.promote(readingId) ? { ok: true } : reply.code(404).send({ error: 'QUEUE_ITEM_NOT_FOUND' });
  });
  app.delete('/api/queue/:readingId', async (request, reply) => {
    const { readingId } = request.params as { readingId: string };
    return runtime.removeQueued(readingId) ? { ok: true } : reply.code(404).send({ error: 'QUEUE_ITEM_NOT_FOUND' });
  });
  app.post('/api/queue/clear', async () => ({ cleared: runtime.clearQueue() }));
  app.get('/api/operations/recalculate/preview', async () => runtime.getOperationalDataRecalculationPreview());
  app.post('/api/operations/recalculate', async (_request, reply) => {
    const report = runtime.recalculateOperationalData();
    return report.canApply ? report : reply.code(409).send(report);
  });
  app.post<{ Body: BlockUserBody }>('/api/blocked-users', async (request, reply) => {
    const userKey = request.body?.userKey?.trim();
    if (!userKey) return reply.code(400).send({ error: 'userKey is required' });
    runtime.blockUser({ userKey, username: request.body?.username ?? userKey, reason: request.body?.reason ?? 'blocked_by_admin' });
    return { ok: true };
  });
  app.delete('/api/blocked-users/:userKey', async (request, reply) => {
    const { userKey } = request.params as { userKey: string };
    return runtime.unblockUser(userKey) ? { ok: true } : reply.code(404).send({ error: 'BLOCKED_USER_NOT_FOUND' });
  });
  app.post('/api/live/pause', async () => { runtime.pause(); return { ok: true }; });
  app.post('/api/live/resume', async (_request, reply) => {
    const result = runtime.resume();
    return result.ok ? result : reply.code(409).send(result);
  });
  app.post('/api/live/skip-current', async () => ({ ok: runtime.skipCurrent() }));
  app.post('/api/live/retry-current', async () => ({ ok: runtime.retryCurrent() }));
  app.post('/api/live/force-idle', async () => { runtime.forceIdle(); return { ok: true }; });

  app.post<{ Body: { operatorNote?: string; mode?: LiveSessionMode } }>('/api/sessions/start', async (request, reply) => {
    const mode = request.body?.mode;
    if (mode !== 'LIVE' && mode !== 'REHEARSAL') return reply.code(400).send({ error: 'mode must be LIVE or REHEARSAL' });
    await runtime.refreshProviderReadiness(true);
    const result = runtime.startSession({ operatorNote: request.body?.operatorNote, mode });
    return result.ok ? result : reply.code(409).send(result);
  });
  app.post('/api/sessions/:id/pause', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (runtime.getCurrentSession()?.sessionId !== id) return reply.code(404).send({ error: 'SESSION_NOT_CURRENT' });
    const result = runtime.pauseSession();
    return result.ok ? result : reply.code(409).send(result);
  });
  app.post('/api/sessions/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (runtime.getCurrentSession()?.sessionId !== id) return reply.code(404).send({ error: 'SESSION_NOT_CURRENT' });
    const result = runtime.resumeSession();
    return result.ok ? result : reply.code(409).send(result);
  });
  app.post<{ Body: { operatorNote?: string } }>('/api/sessions/:id/end', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (runtime.getCurrentSession()?.sessionId !== id) return reply.code(404).send({ error: 'SESSION_NOT_CURRENT' });
    const result = runtime.endSession(request.body ?? {});
    return result.ok ? result : reply.code(409).send(result);
  });
  app.post<{ Body: { reason?: string } }>('/api/sessions/:id/abort', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (runtime.getCurrentSession()?.sessionId !== id) return reply.code(404).send({ error: 'SESSION_NOT_CURRENT' });
    const result = runtime.abortSession(request.body ?? {});
    return result.ok ? result : reply.code(409).send(result);
  });
  app.get('/api/sessions/current', async () => runtime.getCurrentSession() ?? null);
  app.get('/api/sessions/:id/report', async (request, reply) => {
    const { id } = request.params as { id: string };
    return runtime.getSessionReport(id) ?? reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
  });

  app.get('/api/director/state', async () => runtime.getDirectorState());
  app.get('/api/director/cues', async (request) => {
    const { limit } = request.query as { limit?: string };
    return runtime.getDirectorCues(limit ? Number(limit) : 200);
  });
  app.post('/api/director/force-idle', async () => { runtime.forceIdle(); return { ok: true }; });
  app.post('/api/director/skip-current', async () => ({ ok: runtime.skipCurrent() }));
  app.post('/api/director/retry-current', async () => ({ ok: runtime.retryCurrent() }));

  app.get('/api/scene-profile/draft', async () => runtime.getSceneDraft());
  app.put<{ Body: SceneProfile }>('/api/scene-profile/draft', async (request, reply) => {
    try { return runtime.updateSceneDraft(request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'INVALID_SCENE_PROFILE' }); }
  });
  app.post('/api/voice-profiles', async (request, reply) => {
    if (!request.isMultipart()) return reply.code(415).send({ error: 'multipart/form-data is required' });
    try {
      const part = await request.file();
      if (!part) return reply.code(400).send({ error: 'reference audio is required' });
      const fields = part.fields as Record<string, { value?: unknown }>;
      const name = String(fields.name?.value ?? '').trim() || basename(part.filename, extname(part.filename)).trim() || '新声音';
      const sourceLanguageValue = String(fields.sourceLanguage?.value ?? fields.language?.value ?? 'zh');
      const refLanguage = sourceLanguageValue === 'auto' ? 'auto' as const : ['en', 'ja', 'ko', 'yue'].includes(sourceLanguageValue) ? sourceLanguageValue as 'en' | 'ja' | 'ko' | 'yue' : 'zh';
      const targetLocaleValue = String(fields.targetLocale?.value ?? '');
      const targetCountry = String(fields.targetCountry?.value ?? '').trim();
      const countryLocale: Record<string, 'zh-CN' | 'yue-HK' | 'en-US' | 'en-GB' | 'ja-JP' | 'ko-KR'> = { CN: 'zh-CN', HK: 'yue-HK', US: 'en-US', GB: 'en-GB', JP: 'ja-JP', KR: 'ko-KR' };
      const targetLocale = (['zh-CN', 'yue-HK', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR'] as string[]).includes(targetLocaleValue)
        ? targetLocaleValue as 'zh-CN' | 'yue-HK' | 'en-US' | 'en-GB' | 'ja-JP' | 'ko-KR' | 'es-ES' | 'fr-FR'
        : countryLocale[targetCountry] ?? (refLanguage === 'en' ? 'en-US' : refLanguage === 'ja' ? 'ja-JP' : refLanguage === 'ko' ? 'ko-KR' : refLanguage === 'yue' ? 'yue-HK' : 'zh-CN');
      const cloneMode = String(fields.cloneMode?.value ?? 'COUNTRY_ACCENT') === 'TIMBRE_ONLY' ? 'TIMBRE_ONLY' as const : 'COUNTRY_ACCENT' as const;
      // The operator only chooses a language and uploads a sample. The runtime
      // transcribes the normalized WAV with the bundled offline Whisper model.
      const refText = String(fields.referenceText?.value ?? '').trim();
      const bytes = await part.toBuffer();
      const queued = runtime.queueVoiceClone({ name, fileName: part.filename, mimeType: part.mimetype, base64: bytes.toString('base64'), refText, refLanguage, targetLocale, targetCountry, accentProfileId: String(fields.accentProfileId?.value ?? '').trim() || undefined, cloneMode });
      return reply.code(202).send(queued);
    } catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'VOICE_PROFILE_CREATE_FAILED' }); }
  });
  app.post<{ Params: { id: string }; Body: { text?: string } }>('/api/voice-profiles/:id/test', async (request, reply) => {
    try { return await runtime.testGptSoVitsVoice(request.params.id, request.body?.text); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'VOICE_TEST_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/voice-profiles/:id/approve', async (request, reply) => {
    try { return runtime.approveVoiceProfile(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'VOICE_APPROVAL_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/voice-profiles/:id/activate', async (request, reply) => {
    try { return runtime.activateVoiceProfile(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'VOICE_ACTIVATION_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/voice-profiles/:id/disable', async (request, reply) => {
    try { return runtime.disableVoiceProfile(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'VOICE_DISABLE_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/voice-profiles/:id/retry', async (request, reply) => {
    try { return reply.code(202).send(runtime.retryVoiceProfile(request.params.id)); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'VOICE_RETRY_FAILED' }); }
  });
  app.post('/api/readings/:readingId/retry', async (request, reply) => {
    const { readingId } = request.params as { readingId: string };
    return runtime.retryReading(readingId) ? { ok: true } : reply.code(409).send({ error: 'READING_NOT_RETRYABLE_OR_PIPELINE_BUSY' });
  });
  app.put<{ Body: SceneProfile }>('/api/scene-profile/live', async (request, reply) => {
    try {
      runtime.updateSceneDraft(request.body);
      return runtime.publishSceneDraft();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'INVALID_SCENE_PROFILE' });
    }
  });
  app.post<{ Body: { profile?: SceneProfile; expectedVersion?: number } }>('/api/scene-profile/publish', async (request, reply) => {
    let result;
    try { result = runtime.publishSceneDraft(request.body ?? {}); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'INVALID_SCENE_PROFILE' }); }
    return result.ok ? result : reply.code(409).send(result);
  });
  app.get('/api/scene-profile/versions', async () => runtime.getSceneVersions());
  app.post('/api/scene-profile/versions/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = runtime.restoreSceneVersion(id);
    return result.ok ? result : reply.code(404).send(result);
  });
  app.get('/api/media-assets', async () => runtime.listMediaAssets());
  app.post('/api/media-assets/:id/normalize-video', async (request, reply) => {
    try { return runtime.normalizeVideoAsset((request.params as { id: string }).id); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'VIDEO_NORMALIZE_FAILED' }); }
  });
  app.post<{ Body: { kind?: MediaAssetKind; fileName?: string; mimeType?: string; base64?: string } }>('/api/media-assets', async (request, reply) => {
    const { kind, fileName, mimeType, base64 } = request.body ?? {};
    if (!kind || !fileName || !mimeType || !base64) return reply.code(400).send({ error: 'kind, fileName, mimeType and base64 are required' });
    try { return reply.code(201).send(runtime.uploadMediaAsset({ kind, fileName, mimeType, base64 })); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'MEDIA_UPLOAD_FAILED' }); }
  });
  app.get<{ Params: { id: string } }>('/api/media-assets/:id/thumbnail', async (request, reply) => {
    const thumbnail = await runtime.getMediaAssetThumbnail(request.params.id);
    if (thumbnail) {
      return reply
        .type('image/webp')
        .header('cache-control', 'private, max-age=86400')
        .send(createReadStream(thumbnail.path));
    }

    const content = runtime.getMediaAssetContent(request.params.id);
    if (!content) {
      return reply.code(404).send({ error: 'MEDIA_ASSET_NOT_FOUND' });
    }

    return reply
      .type(content.asset.mimeType)
      .header('cache-control', 'private, max-age=86400')
      .send(createReadStream(content.path));
  });

  app.get('/api/media-assets/:id/content', async (request, reply) => {
    const { id } = request.params as { id: string };
    const value = runtime.getMediaAssetContent(id);
    if (!value) return reply.code(404).send({ error: 'MEDIA_ASSET_NOT_FOUND' });
    const size = statSync(value.path).size;
    const range = request.headers.range;
    reply
      .type(value.asset.mimeType)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=86400');
    if (!range) {
      return reply.header('content-length', size).send(createReadStream(value.path));
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      return reply.code(416).header('content-range', `bytes */${size}`).send();
    }
    const requestedStart = match[1] ? Number(match[1]) : undefined;
    const requestedEnd = match[2] ? Number(match[2]) : undefined;
    const suffixLength = requestedStart === undefined ? requestedEnd : undefined;
    const start = suffixLength === undefined ? (requestedStart ?? 0) : Math.max(0, size - suffixLength);
    const end = suffixLength === undefined ? Math.min(requestedEnd ?? size - 1, size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
      return reply.code(416).header('content-range', `bytes */${size}`).send();
    }
    return reply
      .code(206)
      .header('content-range', `bytes ${start}-${end}/${size}`)
      .header('content-length', end - start + 1)
      .send(createReadStream(value.path, { start, end }));
  });
  app.get('/api/avatar/vtube/status', async () => runtime.getVTubeStatus());
  app.post('/api/avatar/vtube/connect', async () => runtime.connectVTube());
  app.post('/api/avatar/vtube/authorize', async () => runtime.authorizeVTube());
  app.post('/api/avatar/vtube/disconnect', async () => runtime.disconnectVTube());
  app.get('/api/avatar/vtube/model', async () => runtime.getVTubeStatus().model ?? null);
  app.post('/api/avatar/vtube/test-mouth', async () => runtime.testVTubeMouth());
  app.post('/api/avatar/vtube/test-actions', async () => runtime.testVTubeActions());
  app.get('/api/avatar/provider/state', async () => runtime.getAvatarProviderState());
  app.get('/api/digital-human/status', async () => runtime.probeDigitalHumanServices());
  app.get('/api/digital-human/profiles', async () => runtime.listDigitalHumanProfiles());
  app.post('/api/digital-human/launch-check', async () => runtime.getDigitalHumanLaunchStatus());
  app.post<{ Params: { id: string } }>('/api/digital-human/voices/:id/approve', async (request, reply) => {
    try { return runtime.approveVoiceProfile(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'VOICE_APPROVAL_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/digital-human/voices/:id/activate', async (request, reply) => {
    try { return runtime.activateVoiceProfile(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'VOICE_ACTIVATION_FAILED' }); }
  });
  app.post('/api/digital-human/avatars', async (request, reply) => {
    try {
      if (request.isMultipart()) {
        const part = await request.file();
        if (!part) return reply.code(400).send({ error: 'video file is required' });
        const fields = part.fields as Record<string, { value?: unknown }>;
        const name = String(fields.name?.value ?? '').trim() || basename(part.filename, extname(part.filename)).trim() || '新数字人';
        const authorizationConfirmed = true;
        const bytes = await part.toBuffer();
        const asset = runtime.uploadMediaAsset({ kind: 'AVATAR_VIDEO', fileName: part.filename, mimeType: part.mimetype, base64: bytes.toString('base64') });
        const requestedProvider = String(fields.provider?.value ?? 'LOCAL_VIDEO');
        const provider = requestedProvider === 'ALIYUN_CLOUD' || requestedProvider === 'BAIDU_CLOUD' ? requestedProvider : 'LOCAL_VIDEO';
        const created = runtime.createAvatarProfile({ name, provider, sourceAssetId: asset.id, authorizationConfirmed });
        const job = runtime.queueAvatarPreparation(created.id);
        return reply.code(202).send({ profile: runtime.getAvatarProfile(created.id), job });
      }
      const body = (request.body ?? {}) as { name?: string; provider?: AvatarProfile['provider']; modelAssetId?: string; sourceAssetId?: string; cloudFigureId?: string; cloudVideoUrl?: string; chromaColor?: string; authorizationConfirmed?: boolean; developmentOnly?: boolean };
      if (!body.name?.trim() || !body.provider || !['LOCAL_VIDEO', 'LOCAL_VRM', 'BAIDU_CLOUD', 'ALIYUN_CLOUD'].includes(body.provider)) return reply.code(400).send({ error: 'name and provider are required' });
      return reply.code(201).send(runtime.createAvatarProfile(body as Parameters<LiveRuntime['createAvatarProfile']>[0]));
    } catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'AVATAR_PROFILE_CREATE_FAILED' }); }
  });
  app.get<{ Params: { id: string } }>('/api/digital-human/avatars/:id/status', async (request, reply) => {
    try { return runtime.getAvatarProfile(request.params.id); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : 'AVATAR_PROFILE_NOT_FOUND' }); }
  });
  app.post<{ Params: { id: string } }>('/api/digital-human/avatars/:id/prepare', async (request, reply) => {
    try { return reply.code(202).send({ profile: runtime.getAvatarProfile(request.params.id), job: runtime.queueAvatarPreparation(request.params.id) }); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'AVATAR_PREP_FAILED' }); }
  });
  app.put<{ Params: { id: string }; Body: { bindings?: AvatarProfile['actionBindings'] } }>('/api/digital-human/avatars/:id/actions', async (request, reply) => {
    try { return runtime.updateAvatarActions(request.params.id, request.body?.bindings ?? {}); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'AVATAR_ACTIONS_SAVE_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/digital-human/avatars/:id/test', async (request, reply) => {
    try { return await runtime.testAvatarProfile(request.params.id); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'AVATAR_TEST_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/digital-human/avatars/:id/activate', async (request, reply) => {
    try { return runtime.activateAvatarProfile(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'AVATAR_ACTIVATION_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/digital-human/avatars/:id/disable', async (request, reply) => {
    try { return runtime.disableAvatarProfile(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'AVATAR_DISABLE_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/digital-human/avatars/:id/retry', async (request, reply) => {
    try { return reply.code(202).send({ profile: runtime.getAvatarProfile(request.params.id), job: runtime.retryAvatarPreparation(request.params.id) }); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'AVATAR_RETRY_FAILED' }); }
  });
  app.get<{ Params: { id: string } }>('/api/digital-human/jobs/:id', async (request, reply) => {
    try { return runtime.getDigitalHumanJob(request.params.id); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : 'DIGITAL_HUMAN_JOB_NOT_FOUND' }); }
  });
  app.post<{ Params: { id: string } }>('/api/digital-human/jobs/:id/cancel', async (request, reply) => {
    try { return runtime.cancelDigitalHumanJob(request.params.id); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : 'DIGITAL_HUMAN_JOB_NOT_FOUND' }); }
  });
  app.get<{ Querystring: { profileId?: string } }>('/api/digital-human/jobs', async (request) => runtime.listDigitalHumanJobs(request.query.profileId));
  app.post<{ Body: { avatarProfileId?: string; voiceProfileId?: string } }>('/api/digital-human/selection', async (request, reply) => {
    const avatarProfileId = request.body?.avatarProfileId?.trim();
    const voiceProfileId = request.body?.voiceProfileId?.trim();
    if (!avatarProfileId || !voiceProfileId) return reply.code(400).send({ error: 'avatarProfileId and voiceProfileId are required' });
    try { return runtime.selectDigitalHuman({ avatarProfileId, voiceProfileId }); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'DIGITAL_HUMAN_SELECTION_FAILED' }); }
  });
  app.get('/api/digital-human/render-jobs', async () => runtime.listAvatarRenderJobs());
  app.get('/api/digital-human/presets', async () => runtime.listDigitalHumanPresets());
  app.post<{ Body: Partial<DigitalHumanPreset> & { name: string } }>('/api/digital-human/presets', async (request, reply) => {
    try { return reply.code(201).send(runtime.saveDigitalHumanPreset(request.body)); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'PRESET_SAVE_FAILED' }); }
  });
  app.post<{ Params: { id: string } }>('/api/digital-human/presets/:id/activate', async (request, reply) => {
    try { return runtime.activateDigitalHumanPreset(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'PRESET_ACTIVATION_FAILED' }); }
  });
  app.get('/api/digital-human/broadcast', async () => runtime.listDigitalHumanBroadcast());
  app.post<{ Body: { renderJobId?: string } }>('/api/digital-human/media-ready', async (request, reply) => {
    const renderJobId = request.body?.renderJobId?.trim();
    if (!renderJobId) return reply.code(400).send({ error: 'RENDER_JOB_ID_REQUIRED' });
    runtime.recordAvatarMediaReady(renderJobId);
    return { ok: true };
  });
  app.post<{ Body: { text?: string; action?: AvatarActionName } }>('/api/digital-human/broadcast/manual', async (request, reply) => {
    try { return reply.code(201).send(runtime.enqueueManualBroadcast(request.body?.text ?? '', request.body?.action)); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'BROADCAST_QUEUE_FAILED' }); }
  });
  for (const action of ['pause', 'resume', 'skip', 'replay', 'stop'] as const) {
    app.post(`/api/digital-human/broadcast/:id/${action}`, async (request, reply) => {
      try { return runtime.controlDigitalHumanBroadcast((request.params as { id: string }).id, action); }
      catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : 'BROADCAST_CONTROL_FAILED' }); }
    });
  }
  app.put<{ Body: Partial<AppSettingsPatch['audioBus']> }>('/api/digital-human/audio-bus', async (request) => runtime.updateAudioBus(request.body ?? {}));
  app.post<{ Body: Partial<AppSettingsPatch['audioBus']> }>('/api/digital-human/save-and-enable', async (request) => runtime.saveAndEnableDigitalHuman(request.body ?? {}));
  app.post<{ Body: { avatarId?: string; videoPath?: string } }>('/api/avatar/musetalk/prep', async (request, reply) => {
    const avatarId = request.body?.avatarId?.trim() || 'default';
    const videoPath = request.body?.videoPath?.trim();
    if (!videoPath) return reply.code(400).send({ error: 'videoPath is required' });
    return runtime.prepMuseTalkAvatar(avatarId, videoPath);
  });
  app.post<{ Body: { avatarId?: string } }>('/api/avatar/musetalk/test', async (request, reply) => {
    return runtime.testMuseTalkAvatar(request.body?.avatarId?.trim() || 'default');
  });
  if (!options.production) app.post('/api/avatar/provider/mock/linkage', async () => runtime.runAvatarProviderMockLinkage());
  app.post<{ Body: { sourceInstanceId?: string } }>('/api/audio/sources/register', async (request, reply) => {
    const sourceInstanceId = request.body?.sourceInstanceId?.trim();
    if (!sourceInstanceId) return reply.code(400).send({ error: 'sourceInstanceId is required' });
    return runtime.registerAudioSource(sourceInstanceId);
  });
  app.post<{ Params: { id: string }; Body: { leaseId?: string } }>('/api/audio/sources/:id/heartbeat', async (request, reply) => {
    const result = runtime.heartbeatAudioSource(request.params.id, request.body?.leaseId ?? '');
    return result.ok ? result : reply.code(409).send(result);
  });
  app.delete<{ Params: { id: string }; Querystring: { leaseId?: string } }>('/api/audio/sources/:id', async (request) => runtime.releaseAudioSource(request.params.id, request.query.leaseId));
  app.get('/api/sync/metrics', async () => runtime.getSyncMetrics());
  app.get('/api/obs/sources/health', async () => runtime.getObsSourceHealth());
  app.post('/api/maintenance/run', async () => runtime.runMaintenance());
  app.post<{ Body: { event?: 'PLAY_STARTED' | 'PLAY_ENDED' | 'PLAY_FAILED' | 'PLAY_PAUSED'; sourceInstanceId?: string; leaseId?: string; readingId?: string; cueId?: string; positionMs?: number; message?: string } }>('/api/audio/playback-events', async (request, reply) => {
    const { event, ...details } = request.body ?? {};
    if (!event || !['PLAY_STARTED', 'PLAY_ENDED', 'PLAY_FAILED', 'PLAY_PAUSED'].includes(event)) return reply.code(400).send({ error: 'INVALID_AUDIO_EVENT' });
    if (!details.sourceInstanceId || !details.leaseId) return reply.code(400).send({ error: 'sourceInstanceId and leaseId are required' });
    const result = runtime.recordAudioPlaybackEvent({
      event,
      sourceInstanceId: details.sourceInstanceId,
      leaseId: details.leaseId,
      readingId: details.readingId,
      cueId: details.cueId,
      positionMs: details.positionMs,
      message: details.message,
    });
    return result.ok ? result : reply.code(409).send(result);
  });
  app.delete('/api/media-assets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = runtime.deleteMediaAsset(id);
    return result.ok ? result : reply.code(409).send(result);
  });

  app.post<{ Body: { scenario?: PreviewSession['scenario'] } }>('/api/preview-sessions', async (request, reply) => reply.code(201).send(runtime.createPreviewSession(request.body ?? {})));
  app.put<{ Body: { scenario?: PreviewSession['scenario']; profile?: SceneProfile } }>('/api/preview-sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return runtime.updatePreviewSession(id, request.body ?? {}) ?? reply.code(404).send({ error: 'PREVIEW_SESSION_NOT_FOUND' });
  });
  app.delete('/api/preview-sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return runtime.deletePreviewSession(id) ? { ok: true } : reply.code(404).send({ error: 'PREVIEW_SESSION_NOT_FOUND' });
  });
  app.get('/api/preview-sessions/:id/snapshot', async (request, reply) => {
    const { id } = request.params as { id: string };
    return runtime.getPreviewSnapshot(id) ?? reply.code(404).send({ error: 'PREVIEW_SESSION_NOT_FOUND' });
  });
  app.get('/api/sessions/:id/rankings/gifts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const report = runtime.getSessionReport(id);
    return report ? report.giftRanking : reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
  });
  app.get('/api/sessions/:id/rankings/engagement', async (request, reply) => {
    const { id } = request.params as { id: string };
    const report = runtime.getSessionReport(id);
    return report ? report.engagementRanking : reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
  });
  app.post('/api/replay/:readingId', async (request, reply) => {
    const { readingId } = request.params as { readingId: string };
    const result = await runtime.replayReading(readingId);
    return result.ok ? result : reply.code(409).send(result);
  });
  app.post('/api/replay/stop', async () => ({ ok: runtime.stopReplay() }));

  app.get('/ws/overlay', { websocket: true }, (socket) => runtime.attachOverlay(socket));
  app.get('/ws/admin', { websocket: true }, (socket) => runtime.attachAdmin(socket));
  app.get('/ws/preview/:id', { websocket: true }, (socket, request) => {
    const { id } = request.params as { id: string };
    if (!runtime.attachPreview(socket, id)) socket.close(1008, 'Preview session not found');
  });
  return app;
}
