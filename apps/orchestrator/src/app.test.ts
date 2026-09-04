import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistence } from '@meihua/persistence';
import { createApp } from './app.js';
import { LiveRuntime } from './runtime.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

describe('orchestrator HTTP API', () => {
  it('requires the production control token and omits mock mutation routes', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime, { production: true, controlToken: 'test-production-token' });
    cleanups.push(async () => { await app.close(); runtime.close(); });

    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-meihua-token': 'test-production-token' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/director/force-idle', headers: { origin: 'https://attacker.example', 'x-meihua-token': 'test-production-token' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/mock/linkage', headers: { 'x-meihua-token': 'test-production-token' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/providers/tikfinity/validate-event', headers: { 'x-meihua-token': 'test-production-token' }, payload: {} })).statusCode).toBe(404);
  });

  it('runs chat, gift, queue and module state through real routes', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });

    const chat = await app.inject({ method: 'POST', url: '/api/mock/chat', payload: { username: 'APIViewer', question: '现在适合推进这个计划吗？' } });
    expect(chat.statusCode).toBe(201);
    const reading = chat.json();
    const gift = await app.inject({ method: 'POST', url: '/api/gifts/mock', payload: { username: 'APIViewer', giftId: '5655', giftName: 'Rose', repeatCount: 4 } });
    expect(gift.json()).toMatchObject({ action: 'APPLIED_TO_QUEUE', readingId: reading.id });
    const queue = await app.inject({ method: 'GET', url: '/api/queue' });
    expect(queue.json()[0]).toMatchObject({ readingId: reading.id, priority: 'HIGH', speechTargetSeconds: 30 });
    const state = await app.inject({ method: 'GET', url: '/api/state' });
    expect(state.json().giftAlert).toMatchObject({ username: 'APIViewer', giftName: 'Rose', action: 'APPLIED_TO_QUEUE' });
  });

  it('validates malformed operator input without mutating the queue', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    expect((await app.inject({ method: 'POST', url: '/api/mock/chat', payload: { username: '', question: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/gifts/mock', payload: { username: 'Viewer' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/queue' })).json()).toEqual([]);
  });

  it('previews unified recalculation and blocks execution when no durable live session exists', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });

    const preview = await app.inject({ method: 'GET', url: '/api/operations/recalculate/preview' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ canApply: false, applied: false, blockingReason: '没有可用于重新计算的直播场次。' });
    const apply = await app.inject({ method: 'POST', url: '/api/operations/recalculate' });
    expect(apply.statusCode).toBe(409);
    expect(apply.json()).toMatchObject({ canApply: false, applied: false });
  });

  it('simulates gift, pending question and official queue as one observable linkage', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    const response = await app.inject({ method: 'POST', url: '/api/mock/linkage' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, afterGift: { status: 'WAITING_QUESTION' }, afterQuestion: { status: 'QUEUED', position: 1 } });
    const overview = await app.inject({ method: 'GET', url: '/api/queue/overview' });
    expect(overview.json()).toEqual([expect.objectContaining({ status: 'QUEUED', question: 'Should I take one careful step forward with this plan?' })]);
  });

  it('exposes actually captured gift identity and coin metadata for the gift picker', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    await app.inject({ method: 'POST', url: '/api/sessions/start', payload: { mode: 'REHEARSAL' } });
    const internals = runtime as unknown as { enqueueTikfinityEvent: (kind: 'gift', event: Parameters<LiveRuntime['ingestGift']>[0]) => Promise<void> };
    await internals.enqueueTikfinityEvent('gift', {
      source: 'tikfinity', eventId: 'catalog-gift-1', userId: 'catalog-user', username: 'CatalogViewer',
      giftId: '5655', giftName: 'Rose', repeatCount: 2, repeatEnd: true, diamondCount: 1,
      timestamp: Date.now(), raw: { test: true },
    });
    const catalog = await app.inject({ method: 'GET', url: '/api/live-events/gift-catalog' });
    expect(catalog.json()).toEqual([expect.objectContaining({ giftId: '5655', giftName: 'Rose', coinValue: 1, count: 2 })]);
  });

  it('captures TikFinity room activity while idle without granting eligibility or queueing it later', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    const internals = runtime as unknown as {
      enqueueTikfinityEvent: (kind: 'chat' | 'gift' | 'like', event: Parameters<LiveRuntime['ingestLike']>[0] | Parameters<LiveRuntime['ingestGift']>[0] | Parameters<LiveRuntime['ingestTikfinityChat']>[0]) => Promise<void>;
    };

    await internals.enqueueTikfinityEvent('like', {
      source: 'tikfinity', eventId: 'idle-like-1', userId: 'idle-user', username: 'IdleViewer',
      likeCount: 100, timestamp: Date.now(), raw: { test: true },
    });

    const recent = await app.inject({ method: 'GET', url: '/api/live-events/recent?limit=5' });
    expect(recent.json()).toEqual([expect.objectContaining({ kind: 'like', username: 'IdleViewer', likeCount: 100, status: 'DONE' })]);
    expect(runtime.getPendingQualifications()).toHaveLength(0);
    expect(runtime.getQueue()).toHaveLength(0);

    runtime.startSession({ mode: 'REHEARSAL' });
    expect(runtime.getPendingQualifications()).toHaveLength(0);
    expect(runtime.getQueue()).toHaveLength(0);
  });

  it('allows the browser Admin to persist settings across localhost ports', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/settings', headers: { origin: 'http://127.0.0.1:5200', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toContain('PUT');
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: { overlay: { contentLanguage: 'es', effects: { animationStyle: 'energetic', particles: false }, modules: { current: { titleText: 'PREGUNTA ACTUAL', brightness: 1.2, glowIntensity: .8 } } } } });
    expect(saved.json().overlay).toMatchObject({ contentLanguage: 'es', effects: { animationStyle: 'energetic', particles: false }, modules: { current: { titleText: 'PREGUNTA ACTUAL', brightness: 1.2, glowIntensity: .8 } } });
  });

  it('exposes presentation mode settings and refuses unvalidated video assets', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    expect((await app.inject({ method: 'GET', url: '/api/presentation' })).json()).toMatchObject({ mode: 'VIDEO_ONCE', fallbackPolicy: 'VIDEO', profiles: [] });
    expect((await app.inject({ method: 'PUT', url: '/api/presentation/settings', payload: { mode: 'AUDIO_ONLY' } })).json()).toMatchObject({ mode: 'AUDIO_ONLY' });
    expect((await app.inject({ method: 'GET', url: '/api/presentation/preflight' })).json()).toMatchObject({ mode: 'AUDIO_ONLY', ready: true });
    const invalid = await app.inject({ method: 'POST', url: '/api/presentation/videos', payload: { name: 'Missing video', assetId: 'missing-asset' } });
    expect(invalid.statusCode).toBe(422);
  });

  it('exposes DeepSeek production defaults alongside Alibaba voice cloning and digital-human configuration', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    const initial = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(initial.json().providers).toMatchObject({
      llm: { adapter: 'openai-compatible', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
      tts: { voiceCloneApi: { provider: 'aliyun', model: 'qwen-voice-enrollment', targetModel: 'qwen3.5-omni-plus' } },
      avatar: { cloneApi: { provider: 'aliyun', model: 'StartInstance', baseUrl: 'https://avatar.cn-zhangjiakou.aliyuncs.com' } },
    });
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: { reading: { speechTargetSeconds: 30 }, providers: {
      tts: { voiceCloneApi: { provider: 'aliyun', model: 'voice-enrollment', targetModel: 'cosyvoice-v3-flash', baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization', region: 'cn-beijing' } },
      avatar: { cloneApi: { provider: 'aliyun', model: 'StartInstance', baseUrl: 'https://avatar.cn-zhangjiakou.aliyuncs.com', region: 'cn-zhangjiakou', tenantId: 'tenant-test', appId: 'app-test', instanceId: 'instance-test' } },
    } } });
    expect(saved.json().providers.tts.voiceCloneApi).toMatchObject({ provider: 'aliyun', targetModel: 'cosyvoice-v3-flash' });
    expect(saved.json().providers.avatar.cloneApi).toMatchObject({ provider: 'aliyun', tenantId: 'tenant-test', instanceId: 'instance-test' });
    expect(saved.json().reading.speechTargetSeconds).toBe(30);
    expect((await app.inject({ method: 'PUT', url: '/api/providers/secrets/voiceClone', payload: { apiKey: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/providers/secrets/avatarClone', payload: { apiKey: '' } })).statusCode).toBe(400);
  });

  it('exposes secret status without ever returning plaintext and rejects an empty key', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    const status = await app.inject({ method: 'GET', url: '/api/providers/secrets/status' });
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(status.json())).not.toContain('apiKey');
    expect((await app.inject({ method: 'PUT', url: '/api/providers/secrets/llm', payload: { apiKey: '' } })).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { providers: { llm: { adapter: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'test' } } } });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ llm: 'NOT_CONFIGURED' });
  });

  it('pins provider secret slots and rejects unsafe provider targets', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: { providers: {
      llm: { adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:9000/v1', model: 'unsafe', apiKeyEnv: 'PATH' },
      tts: { adapter: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'voice', apiKeyEnv: 'HOME', reuseLlmKey: true },
    } } });
    expect(saved.json().providers.llm).toMatchObject({ baseUrl: '', apiKeyEnv: 'LLM_API_KEY' });
    expect(saved.json().providers.tts).toMatchObject({ baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'TTS_API_KEY', reuseLlmKey: false });
  });

  it('refuses voice cloning without explicit ownership authorization', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    runtime.updateSettings({ providers: { tts: { adapter: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1', model: 'eleven_multilingual_v2', reuseLlmKey: false } } });
    const wavHeader = Buffer.from('RIFF0000WAVEfmt ', 'ascii').toString('base64');
    const response = await app.inject({ method: 'POST', url: '/api/voices/clone', payload: { name: 'Unauthorized voice', fileName: 'sample.wav', mimeType: 'audio/wav', base64: wavHeader, authorizationConfirmed: false } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'VOICE_AUTHORIZATION_REQUIRED' });
  });

  it('exposes the V2 session, scene, preview, director and ranking contracts', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    const blockedStart = await app.inject({ method: 'POST', url: '/api/sessions/start', payload: {} });
    expect(blockedStart.statusCode).toBe(400);
    const start = await app.inject({ method: 'POST', url: '/api/sessions/start', payload: { mode: 'REHEARSAL' } });
    expect(start.statusCode).toBe(200);
    const session = start.json().session;
    expect((await app.inject({ method: 'GET', url: '/api/director/state' })).json()).toMatchObject({ session: { sessionId: session.sessionId }, stage: 'IDLE', snapshot: { protocolVersion: 2 } });
    const preview = await app.inject({ method: 'POST', url: '/api/preview-sessions', payload: { scenario: 'SPEAKING' } });
    expect(preview.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/api/preview-sessions/${preview.json().previewSessionId}/snapshot` })).json()).toMatchObject({ protocolVersion: 2, stage: 'SPEAKING' });
    const audioSource = await app.inject({ method: 'POST', url: '/api/audio/sources/register', payload: { sourceInstanceId: 'test-audio' } });
    expect((await app.inject({ method: 'POST', url: '/api/audio/playback-events', payload: { event: 'PLAY_STARTED', sourceInstanceId: 'test-audio', leaseId: audioSource.json().leaseId, positionMs: 250 } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'POST', url: '/api/audio/playback-events', payload: { event: 'INVALID' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${session.sessionId}/rankings/gifts` })).json()).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${session.sessionId}/end`, payload: {} })).json()).toMatchObject({ ok: true, session: { status: 'ENDED' } });
  });

  it('reports unconnected enabled OBS browser sources as a formal-live blocking condition', async () => {
    const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
    const app = await createApp(runtime);
    cleanups.push(async () => { await app.close(); runtime.close(); });
    const sources = await app.inject({ method: 'GET', url: '/api/obs/sources/health' });
    expect(sources.statusCode).toBe(200);
    expect(sources.json()).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: 'subtitles', enabled: true })]));
    expect(sources.json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: 'audio' })]));
    const preflight = await app.inject({ method: 'GET', url: '/api/preflight?mode=LIVE' });
    expect(preflight.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'obs-sources', status: 'FAIL' })]));
  });
});
