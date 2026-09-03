import { describe, expect, it } from 'vitest';
import type { TtsAdapter } from './index.js';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderSettings, TtsResult } from '@meihua/core-types';
import { CloudAvatarProviderAdapter, CloudVoiceCloneAdapter, ElevenLabsTtsAdapter, ElevenLabsVoiceClient, KokoroTtsAdapter, MuseTalkAvatarAdapter, OpenAICompatibleTtsAdapter, TimingFallbackTtsAdapter, WindowsNativeAudioPlayer, WindowsTtsAdapter, analyzeWavAmplitude, buildLipSyncPlan, mapSapiViseme, normalizeTikfinityEnvelope, pcm16MonoToWav, providerHealth, windowsSapiRate } from './index.js';

function pcmWav(samples: number[], sampleRate = 16_000): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

describe('offline adapters', () => {
  it('maps the Windows voice multiplier around the approved slow live cadence', () => {
    expect(windowsSapiRate(1)).toBe(-2);
    expect(windowsSapiRate(.75)).toBe(-3);
    expect(windowsSapiRate(1.25)).toBe(-1);
    expect(windowsSapiRate(0)).toBe(-2);
    expect(windowsSapiRate(10)).toBe(4);
  });

  it('returns a usable emergency timing duration', async () => {
    const result = await new TimingFallbackTtsAdapter().synthesize({ text: '这是一段口播。', speed: 1 });
    expect(result.durationMs).toBeGreaterThanOrEqual(1600);
  });

  it('persists a real WAV returned by an OpenAI-compatible speech endpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meihua-external-tts-'));
    const wav = pcmWav(Array(16_000).fill(2_000));
    let body: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(new Uint8Array(wav), { status: 200, headers: { 'content-type': 'audio/wav' } });
    };
    try {
      const result = await new OpenAICompatibleTtsAdapter({ outputDirectory: directory, baseUrl: 'https://example.test/v1', model: 'voice-model', apiKey: 'secret-key', instructions: 'Calm', fetcher }).synthesize({ readingId: 'external-test', text: 'Hello', voiceId: 'alloy', speed: 1.15, locale: 'en' });
      expect(body).toMatchObject({ model: 'voice-model', voice: 'alloy', speed: 1.15, response_format: 'wav', instructions: 'Calm' });
      expect(result.durationMs).toBeGreaterThan(900);
      expect((await stat(join(directory, decodeURIComponent(result.audioPath!.split('/').pop()!)))).size).toBe(wav.length);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('creates and lists a real ElevenLabs voice id without persisting the sample', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/voices/add')) return Response.json({ voice_id: 'voice-cloned-1', requires_verification: false });
      return Response.json({ voices: [{ voice_id: 'voice-cloned-1', name: 'Authorized host', category: 'cloned', preview_url: 'https://example.test/preview.mp3' }] });
    };
    const client = new ElevenLabsVoiceClient({ baseUrl: 'https://api.elevenlabs.io/v1', apiKey: 'xi-key', fetcher });
    const cloned = await client.cloneVoice({ name: 'Authorized host', fileName: 'sample.wav', mimeType: 'audio/wav', audio: pcmWav(Array(2_000).fill(1_000)), authorizationConfirmed: true });
    const voices = await client.listVoices();
    expect(cloned).toMatchObject({ voiceId: 'voice-cloned-1', provider: 'elevenlabs' });
    expect(voices[0]).toMatchObject({ voiceId: 'voice-cloned-1', name: 'Authorized host' });
    expect(calls[0]?.url).toBe('https://api.elevenlabs.io/v1/voices/add');
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
    expect(calls[1]?.url).toContain('/v2/voices?page_size=100');
  });

  it('wraps ElevenLabs multilingual PCM as a playable WAV', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meihua-elevenlabs-'));
    const pcm = Buffer.alloc(24_000 * 2, 4);
    let body: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      expect(String(url)).toContain('/v1/text-to-speech/voice-123?output_format=pcm_24000');
      body = JSON.parse(String(init?.body));
      return new Response(new Uint8Array(pcm), { status: 200, headers: { 'content-type': 'audio/pcm' } });
    };
    try {
      const adapter = new ElevenLabsTtsAdapter({ outputDirectory: directory, baseUrl: 'https://api.elevenlabs.io/v1', model: 'eleven_multilingual_v2', apiKey: 'xi-key', stability: .4, similarityBoost: .8, style: .2, speakerBoost: true, fetcher });
      const result = await adapter.synthesize({ readingId: 'clone-test', text: 'Bonjour le monde', voiceId: 'voice-123', speed: 1.1, locale: 'fr' });
      expect(body).toMatchObject({ model_id: 'eleven_multilingual_v2', voice_settings: { stability: .4, similarity_boost: .8, style: .2, use_speaker_boost: true, speed: 1.1 } });
      expect(result.durationMs).toBeGreaterThan(900);
      expect((await stat(join(directory, decodeURIComponent(result.audioPath!.split('/').pop()!)))).size).toBe(pcm.length + 44);
      expect(pcm16MonoToWav(Buffer.alloc(48_000), 24_000).subarray(0, 4).toString()).toBe('RIFF');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not claim an unconfigured provider is connected', () => {
    const local = { health: () => ({ id: 'm', label: 'm', status: 'READY' as const, message: '', configured: true }) };
    const health = providerHealth({
      liveInput: { adapter: 'tikfinity', url: 'ws://localhost:21213/' },
      llm: { adapter: 'rule-based', baseUrl: '', model: '', apiKeyEnv: '' },
      tts: { adapter: 'windows', baseUrl: '', model: '', voiceId: '', speed: 1, instructions: '', apiKeyEnv: '', reuseLlmKey: true, stability: .5, similarityBoost: .75, style: 0, speakerBoost: true, gptsovits: { baseUrl: 'http://127.0.0.1:9880', voices: [] }, kokoro: { baseUrl: 'http://127.0.0.1:9890', defaultVoice: 'af_heart' } },
      avatar: { adapter: 'none', url: '' },
    }, { input: local as never, tts: local as never, avatar: local as never });
    expect(health[0]).toMatchObject({ status: 'NOT_CONFIGURED', configured: false });
  });

  it('normalizes chat, gift and like fields from the TikFinity contract', () => {
    const chat = normalizeTikfinityEnvelope({ event: 'chat', data: { msgId: 'c1', comment: 'reading: my work?', user: { uniqueId: 'viewer', userId: '42', nickname: 'Viewer' } } }, 1000);
    expect(chat).toMatchObject({ kind: 'chat', event: { eventId: 'c1', username: 'viewer', userId: '42', message: 'reading: my work?' } });
    const gift = normalizeTikfinityEnvelope({ event: 'gift', data: { msgId: 'g1', giftId: 5655, repeatCount: 3, repeatEnd: true, giftDetails: { giftName: 'Rose', giftType: 1 }, user: { uniqueId: 'viewer' } } }, 1001);
    expect(gift).toMatchObject({ kind: 'gift', event: { eventId: 'g1', giftId: '5655', giftName: 'Rose', repeatCount: 3, giftType: 1, repeatEnd: true } });
    const like = normalizeTikfinityEnvelope({ event: 'like', data: { msgId: 'l1', likeCount: 12, totalLikeCount: 900, user: { uniqueId: 'viewer' } } }, 1002);
    expect(like).toMatchObject({ kind: 'like', event: { likeCount: 12, totalLikeCount: 900 } });
  });

  it('accepts common TikFinity bridge aliases and nested payload wrappers', () => {
    const chat = normalizeTikfinityEnvelope({
      type: 'chatMessage',
      payload: { data: { messageId: 42, message: '今年适合换工作吗？', userInfo: { userName: 'bridge-viewer', uid: 7, displayName: 'Bridge Viewer' } } },
    }, 2000);
    expect(chat).toMatchObject({ kind: 'chat', event: { eventId: '42', username: 'bridge-viewer', userId: '7', message: '今年适合换工作吗？' } });

    const gift = normalizeTikfinityEnvelope({
      eventName: 'giftReceived',
      data: { event_id: 'gift-42', gift: { id: 5655, name: 'Rose', type: 1, repeatEnd: 'true' }, repeat: 2, userInfo: { username: 'gifter' } },
    }, 2001);
    expect(gift).toMatchObject({ kind: 'gift', event: { eventId: 'gift-42', giftId: '5655', giftName: 'Rose', repeatCount: 2, giftType: 1, repeatEnd: true } });

    const like = normalizeTikfinityEnvelope({ type: 'likeEvent', data: { id: 'like-42', count: 9, totalLikes: 99, author: { username: 'liker' } } }, 2002);
    expect(like).toMatchObject({ kind: 'like', event: { eventId: 'like-42', username: 'liker', likeCount: 9, totalLikeCount: 99 } });
  });

  it('uses a deterministic fallback id when TikFinity omits msgId/id', () => {
    const payload = { event: 'gift', data: { giftId: 5655, repeatCount: 1, repeatEnd: true, giftDetails: { giftName: 'Rose', giftType: 1 }, user: { uniqueId: 'viewer' } } };
    const first = normalizeTikfinityEnvelope(payload, 1_000);
    const replay = normalizeTikfinityEnvelope(payload, 9_000);
    expect(first).toMatchObject({ kind: 'gift', event: { eventId: expect.stringMatching(/^gift-fallback-/) } });
    expect(replay).toMatchObject({ kind: 'gift', event: { eventId: (first as { event: { eventId: string } }).event.eventId } });
  });

  it('does not grant a streakable gift before repeatEnd=true', () => {
    expect(normalizeTikfinityEnvelope({ event: 'gift', data: { repeatCount: 2, repeatEnd: false, giftDetails: { giftName: 'Rose', giftType: 1 } } })).toEqual({ kind: 'gift-preview' });
  });

  it('maps SAPI visemes and derives a 20ms smoothed amplitude plan from PCM WAV', () => {
    expect(mapSapiViseme(0)).toBe('SILENCE');
    expect(mapSapiViseme(2)).toBe('A');
    expect(mapSapiViseme(7)).toBe('E');
    expect(mapSapiViseme(10)).toBe('I');
    expect(mapSapiViseme(14)).toBe('O');
    expect(mapSapiViseme(19)).toBe('U');
    const wav = pcmWav([...Array(320).fill(0), ...Array(320).fill(18_000)]);
    const amplitudes = analyzeWavAmplitude(wav);
    expect(amplitudes).toHaveLength(2);
    expect(amplitudes[0].mouthOpen).toBe(0);
    expect(amplitudes[1].mouthOpen).toBeGreaterThan(.3);
    const plan = buildLipSyncPlan({ wav, visemes: [{ viseme: 2, audioPositionMs: 20, durationMs: 80 }] });
    expect(plan).toMatchObject({ mode: 'VISEME_AMPLITUDE', frameIntervalMs: 20, visemes: [{ vowel: 'A' }] });
  });

  it.skipIf(process.platform !== 'win32')('generates a real playable WAV with Windows System.Speech', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meihua-tts-'));
    try {
      const result = await new WindowsTtsAdapter(directory).synthesize({ readingId: 'tts-check', text: '本地语音链路已经生成真实音频。', voiceId: 'Microsoft Huihui Desktop', speed: 1, locale: 'zh-CN', targetSeconds: 5 });
      expect(result.audioPath).toMatch(/^\/api\/audio\/.+\.wav$/);
      expect(result.durationMs).toBeGreaterThan(1_000);
      expect(result.lipSyncPlan).toBeUndefined();
      const file = decodeURIComponent(result.audioPath!.split('/').pop()!);
      expect((await stat(join(directory, file))).size).toBeGreaterThan(1_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(process.platform !== 'win32')('plays a WAV through the native Windows output process and confirms start/end', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meihua-native-audio-'));
    try {
      const filePath = join(directory, 'silent-smoke.wav');
      await writeFile(filePath, pcmWav(Array(1_600).fill(0)));
      let callbackStartedAt = 0;
      const result = await new WindowsNativeAudioPlayer().play({ filePath, onStarted: (value) => { callbackStartedAt = value; } });
      expect(callbackStartedAt).toBeGreaterThan(0);
      expect(result.startedAt).toBe(callbackStartedAt);
      expect(result.endedAt).toBeGreaterThanOrEqual(result.startedAt);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('avatar provider adapter layer', () => {
  it('keeps local VRM static until configured and exposes a muted transparent model afterwards', async () => {
    const { LocalVrmAvatarAdapter } = await import('./index.js');
    const provider = new LocalVrmAvatarAdapter();
    expect(provider.mediaOutput()).toEqual({ kind: 'STATIC' });
    expect(provider.health().status).toBe('NOT_CONFIGURED');
    provider.configure({ profileId: 'mei', modelAssetId: 'asset-vrm', modelUrl: '/api/media-assets/asset-vrm/content' });
    expect((await provider.connect()).status).toBe('READY');
    await provider.createSession();
    await provider.perform('SPEAKING_NEUTRAL', { readingId: 'reading-1' });
    expect(provider.mediaOutput()).toMatchObject({ kind: 'VRM', profileId: 'mei', modelAssetId: 'asset-vrm', muted: true });
    expect(provider.getState().lastAction).toBe('SPEAKING_NEUTRAL');
  });

  it('routes the selected English preset to the local Kokoro service without an API key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meihua-kokoro-tts-'));
    const wav = pcmWav(Array(24_000).fill(1_500), 24_000);
    let body: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      body = requestBody;
      await writeFile(String(requestBody.output_path), wav);
      return Response.json({ ok: true, voice: requestBody.voice, target_locale: 'en-US' });
    };
    try {
      const result = await new KokoroTtsAdapter({ baseUrl: 'http://127.0.0.1:9890', outputDirectory: directory, defaultVoice: 'af_heart', fetcher }).synthesize({ readingId: 'kokoro-test', text: 'Hello from the local preset voice.', voiceId: 'af_heart', speed: 1, locale: 'en', targetLocale: 'en-US' });
      expect(body).toMatchObject({ voice: 'af_heart', speed: 1, locale: 'en-us' });
      expect(result.providerId).toBe('kokoro-tts');
      expect(result.durationMs).toBeGreaterThan(900);
      expect((await stat(join(directory, decodeURIComponent(result.audioPath!.split('/').pop()!)))).size).toBe(wav.length);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('fails instead of silently using the Windows default voice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meihua-windows-missing-'));
    try {
      await expect(new WindowsTtsAdapter(directory).synthesize({
        readingId: 'missing-voice', text: 'This must not use the default voice.',
        voiceId: 'Definitely Missing Voice', speed: 1, locale: 'en-US', targetSeconds: 5,
      })).rejects.toThrow('WINDOWS_TTS_VOICE_NOT_INSTALLED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('runs the mock provider lifecycle: connect, capabilities, session, stage actions, media output, disconnect', async () => {
    const { LocalMockAvatarProviderAdapter } = await import('./index.js');
    const provider = new LocalMockAvatarProviderAdapter();
    expect(provider.id).toBe('avatar-provider');
    expect(provider.vendorId).toBe('local-mock');

    const disconnected = provider.getState();
    expect(disconnected.status).toBe('NOT_CONFIGURED');
    expect(disconnected.connected).toBe(false);
    expect(disconnected.vendorSelected).toBe(false);
    expect(disconnected.media).toEqual({ kind: 'STATIC' });
    expect(provider.health().message).toContain('适配层完成');
    expect(provider.health().message).toContain('供应商待接入');

    const connected = await provider.connect();
    expect(connected.status).toBe('READY');
    expect(connected.connected).toBe(true);

    const capabilities = await provider.detectCapabilities();
    expect(capabilities.sessionLifecycle).toBe(true);
    expect(capabilities.stageActions).toBe(true);
    expect(capabilities.realtimeAudio).toBe(false);
    expect(capabilities.lipSync).toBe(false);
    expect(capabilities.greenScreenOutput).toBe(false);
    expect(capabilities.mediaStreamOutput).toBe(false);

    const session = await provider.createSession({ note: 'linkage-test' });
    expect(session.sessionActive).toBe(true);
    expect(session.sessionId).toMatch(/^avatar-mock-session-/);

    await provider.perform('CASTING', { readingId: 'r-1' });
    await provider.perform('SPEAKING_NEUTRAL', { readingId: 'r-1' });
    const state = provider.getState();
    expect(state.lastAction).toBe('SPEAKING_NEUTRAL');
    expect(provider.recentActions().map((item) => item.action)).toEqual(['CASTING', 'SPEAKING_NEUTRAL']);

    expect(provider.mediaOutput()).toEqual({ kind: 'STATIC' });

    await provider.disconnect();
    const afterDisconnect = provider.getState();
    expect(afterDisconnect.connected).toBe(false);
    expect(afterDisconnect.sessionActive).toBe(false);
  });

  it('fails stage actions after disconnect (error fallback contract)', async () => {
    const { LocalMockAvatarProviderAdapter } = await import('./index.js');
    const provider = new LocalMockAvatarProviderAdapter();
    await expect(provider.perform('IDLE', { readingId: 'r-2' })).rejects.toThrow('AVATAR_PROVIDER_NOT_CONNECTED');
    await provider.connect();
    await expect(provider.perform('IDLE', { readingId: 'r-2' })).resolves.toBeUndefined();
  });

  it('exposes a provider health row compatible with the integration panel', async () => {
    const { LocalMockAvatarProviderAdapter, providerHealth } = await import('./index.js');
    const provider = new LocalMockAvatarProviderAdapter();
    const settings = {
      liveInput: { adapter: 'local' as const, url: '' },
      llm: { adapter: 'rule-based' as const, baseUrl: '', model: '', apiKeyEnv: '' },
      tts: { adapter: 'windows' as const, baseUrl: '', model: '', voiceId: '', speed: 1, instructions: '', apiKeyEnv: '', reuseLlmKey: true, stability: .5, similarityBoost: .75, style: 0, speakerBoost: true, gptsovits: { baseUrl: 'http://127.0.0.1:9880', voices: [] }, kokoro: { baseUrl: 'http://127.0.0.1:9890', defaultVoice: 'af_heart' } },
      avatar: { adapter: 'mock' as const, url: '' },
    } satisfies ProviderSettings;
    const rows = providerHealth(settings, {
      input: {
        id: 'local', start: async () => undefined, stop: async () => undefined,
        health: () => ({ id: 'local', label: 'x', status: 'READY' as const, message: '', configured: true }),
      },
      tts: {
        id: 'win',
        synthesize: async () => ({ durationMs: 1_000, providerId: 'win' }),
        health: () => ({ id: 'win', label: 'y', status: 'READY' as const, message: '', configured: true }),
      },
      avatar: provider,
    });
    expect(rows[3]).toMatchObject({ id: 'avatar-provider', label: '数字人供应商适配层' });
  });
});

describe('MuseTalk avatar provider (managed lip-sync media)', () => {
  it('does not report connected when the HTTP wrapper is up but models or CUDA are missing', async () => {
    const adapter = new MuseTalkAvatarAdapter({
      baseUrl: 'http://127.0.0.1:9898',
      fetcher: async () => new Response(JSON.stringify({ status: 'degraded', ready: false, missing: ['models/sd-vae/config.json'], cuda_ready: false }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const state = await adapter.connect();
    expect(state.connected).toBe(false);
    expect(state.lastError).toContain('MUSETALK_NOT_READY');
  });
  const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  function createAdapter(fetcher: typeof fetch) {
    return new MuseTalkAvatarAdapter({ baseUrl: 'http://127.0.0.1:9898', fetcher });
  }

  it('connects, renders a segment and exposes only the orchestrator-managed media URL', async () => {
    const calls: string[] = [];
    const adapter = createAdapter(async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/renders')) return okResponse({ job_id: 'job-1', status: 'QUEUED' });
      if (String(url).endsWith('/renders/job-1')) return okResponse({ job_id: 'job-1', status: 'READY', video_path: 'E:/muse/results/render.mp4', duration_ms: 4200 });
      return okResponse({ status: 'ok', avatar: 'default' });
    });
    const state = await adapter.connect();
    expect(calls[0]).toContain('/health');
    expect(state.status).toBe('READY');
    expect(state.connected).toBe(true);
    expect(state.capabilities.lipSync).toBe(true);
    expect(state.capabilities.realtimeAudio).toBe(false);
    expect(state.media).toEqual({ kind: 'STATIC' });
    expect(state.capabilities.mediaStreamOutput).toBe(false);

    const session = await adapter.createSession({ note: 'live' });
    expect(session.sessionActive).toBe(true);
    await adapter.perform('CASTING', { readingId: 'r-1' });
    // Segment mode: render the narration first, play when the audio clock starts.
    const rendered = await adapter.render('E:/audio/reading.wav', 'r-1');
    expect(rendered.videoPath).toBe('E:/muse/results/render.mp4');
    expect(rendered.durationMs).toBe(4200);
    await adapter.speak('http://127.0.0.1:3210/api/media-assets/rendered-1/content');
    expect(adapter.getLastAction()).toBe('SPEAKING_NEUTRAL');
    expect(adapter.mediaOutput()).toMatchObject({ kind: 'VIDEO_URL', url: 'http://127.0.0.1:3210/api/media-assets/rendered-1/content' });
    expect(calls.some((call) => call.endsWith('/renders'))).toBe(true);
    expect(calls.some((call) => call.endsWith('/renders/job-1'))).toBe(true);
    expect(calls.some((call) => call.endsWith('/play'))).toBe(false);

    await adapter.disconnect();
    expect(adapter.getState().connected).toBe(false);
    // Disconnected media output falls back so the stage never embeds a dead stream.
    expect(adapter.mediaOutput()).toEqual({ kind: 'STATIC' });
  });

  it('stays NOT_CONFIGURED with the failure reason when the service is unreachable', async () => {
    const adapter = createAdapter(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const state = await adapter.connect();
    expect(state.status).toBe('NOT_CONFIGURED');
    expect(state.connected).toBe(false);
    expect(state.lastError).toContain('ECONNREFUSED');
    expect(adapter.mediaOutput()).toEqual({ kind: 'STATIC' });
    await expect(adapter.perform('IDLE', {})).rejects.toThrow('AVATAR_PROVIDER_NOT_CONNECTED');
    expect(adapter.health().message).toContain('渲染服务未连接');
    expect(adapter.health().message).not.toContain('NVIDIA GPU');
  });
});

describe('GPT-SoVITS local voice cloning adapter', () => {
  function pcmWav16k(samples: number[]): Buffer {
    const pcm = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
    return wav;
  }

  const voices = [{
    id: 'mei-voice', name: '美式女声', refAudioPath: 'E:/voices/mei.wav',
    refText: 'This is the reference line.', refLanguage: 'en' as const, createdAt: 1,
  }];

  it('synthesizes through api_v2 /tts and writes a measured WAV', async () => {
    const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const outputDirectory = mkdtempSync(require('node:path').join(tmpdir(), 'gptsovits-'));
    let requestBody: Record<string, unknown> | undefined;
    const wav = pcmWav16k(Array.from({ length: 3200 }, (_, index) => Math.sin(index / 8) * 8000));
    const fetcher: typeof fetch = async (url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } });
    };
    const { GptSoVitsTtsAdapter } = await import('./index.js');
    const adapter = new GptSoVitsTtsAdapter({ baseUrl: 'http://127.0.0.1:9880', voices, outputDirectory, fetcher });
    const result = await adapter.synthesize({ readingId: 'gpt-test', text: 'Should I take one careful step?', voiceId: 'mei-voice', speed: 1, locale: 'en' });
    expect(result.audioPath).toMatch(/\/api\/audio\/.*\.wav$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(190);
    expect(result.providerId).toBe('gptsovits-tts');
    expect(requestBody).toMatchObject({
      text_lang: 'en', prompt_lang: 'en', prompt_text: 'This is the reference line.',
      ref_audio_path: 'E:/voices/mei.wav', media_type: 'wav', streaming_mode: false,
    });
    expect(adapter.health().configured).toBe(true);
  });

  it('uses the installed V3 root contract and reads its generated WAV', async () => {
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const outputDirectory = mkdtempSync(require('node:path').join(tmpdir(), 'gptsovits-v3-'));
    const wav = pcmWav16k(Array.from({ length: 3200 }, (_, index) => Math.sin(index / 8) * 8000));
    let calledUrl = '';
    let requestBody: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      calledUrl = String(url);
      const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBody = parsedBody;
      writeFileSync(String(parsedBody.output_path), wav);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { GptSoVitsTtsAdapter } = await import('./index.js');
    const adapter = new GptSoVitsTtsAdapter({ baseUrl: 'http://127.0.0.1:9881', apiVersion: 'V3', voices, outputDirectory, fetcher });
    const result = await adapter.synthesize({ readingId: 'v3-test', text: 'Direct V3 voice test.', voiceId: 'mei-voice', speed: 1, locale: 'en' });
    expect(calledUrl).toBe('http://127.0.0.1:9881/');
    expect(requestBody).toMatchObject({ refer_wav_path: 'E:/voices/mei.wav', ref_language: 'en', text_language: 'en', how_to_cut: '按标点符号切' });
    expect(result.durationMs).toBeGreaterThanOrEqual(190);
    expect(result.audioPath).toMatch(/\/api\/audio\/.*\.wav$/);
  });

  it('uses the ChanYin QFTTS root contract and reads its generated WAV', async () => {
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const outputDirectory = mkdtempSync(require('node:path').join(tmpdir(), 'chanyin-qftts-'));
    const wav = pcmWav16k(Array.from({ length: 3200 }, (_, index) => Math.sin(index / 8) * 8000));
    let calledUrl = '';
    let requestBody: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      calledUrl = String(url);
      const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBody = parsedBody;
      writeFileSync(String(parsedBody.output_path), wav);
      return Response.json({ wav_seconds: 0.2, rtf: 0.1 });
    };
    const { GptSoVitsTtsAdapter } = await import('./index.js');
    const adapter = new GptSoVitsTtsAdapter({ baseUrl: 'http://127.0.0.1:9885', apiVersion: 'CHANYIN_QFTTS', voices, outputDirectory, fetcher });
    const result = await adapter.synthesize({ readingId: 'chanyin-test', text: 'This is a ChanYin voice test.', voiceId: 'mei-voice', speed: 1, locale: 'en-US', targetLocale: 'en-US' });
    expect(calledUrl).toBe('http://127.0.0.1:9885/');
    expect(requestBody).toMatchObject({ prompt_wav: 'E:/voices/mei.wav', prompt_text: 'This is the reference line.', target_text: 'This is a ChanYin voice test.', speed: 1 });
    expect(result.providerId).toBe('chanyin-qftts-tts');
    expect(result.durationMs).toBeGreaterThanOrEqual(190);
  });

  it('never falls back to the first local voice when the selected id is missing', async () => {
    const { GptSoVitsTtsAdapter } = await import('./index.js');
    let called = false;
    const adapter = new GptSoVitsTtsAdapter({
      baseUrl: 'http://127.0.0.1:9881', apiVersion: 'V3', voices, outputDirectory: '.',
      fetcher: async () => { called = true; return new Response('', { status: 500 }); },
    });
    await expect(adapter.synthesize({
      readingId: 'missing-local-voice', text: 'This selected voice must be used.',
      voiceId: 'wrong-voice-id', speed: 1, locale: 'en-US', targetLocale: 'en-US',
    })).rejects.toThrow('GPTSOVITS_VOICE_NOT_FOUND:wrong-voice-id');
    expect(called).toBe(false);
  });

  it('keeps target locale separate from the reference language for country-accent synthesis', async () => {
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const outputDirectory = mkdtempSync(require('node:path').join(tmpdir(), 'accent-'));
    const wav = pcmWav16k(Array.from({ length: 3200 }, (_, index) => Math.sin(index / 8) * 8000));
    let requestBody: Record<string, unknown> | undefined;
    const { VoiceAccentTtsAdapter } = await import('./index.js');
    const adapter = new VoiceAccentTtsAdapter({
      baseUrl: 'http://127.0.0.1:9899', voices, outputDirectory,
      fetcher: async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requestBody = parsed;
        writeFileSync(String(parsed.output_path), wav);
        return new Response(JSON.stringify({ ok: true, target_locale: 'en-US' }), { status: 200 });
      },
    });
    const result = await adapter.synthesize({
      readingId: 'accent-test', text: 'This is an American English preview.', voiceId: 'mei-voice', speed: 1,
      locale: 'zh-CN', targetLocale: 'en-US', targetCountry: 'US', accentProfileId: 'en-us', sourceLanguage: 'en',
    });
    expect(requestBody).toMatchObject({ reference_language: 'en', target_locale: 'en-US', target_country: 'US', accent_profile_id: 'en-us' });
    expect(result.providerId).toBe('openvoice-accent-tts');
    expect(result.durationMs).toBeGreaterThanOrEqual(190);
  });

  it('rejects unsupported locales without calling the service', async () => {
    const { GptSoVitsTtsAdapter } = await import('./index.js');
    let called = 0;
    const adapter = new GptSoVitsTtsAdapter({ baseUrl: 'http://127.0.0.1:9880', voices, outputDirectory: '.', fetcher: async () => { called++; return new Response('x', { status: 200 }); } });
    await expect(adapter.synthesize({ readingId: 'es', text: 'Hola', voiceId: 'mei-voice', speed: 1, locale: 'es' }))
      .rejects.toThrow('GPTSOVITS_LANG_UNSUPPORTED:es');
    expect(called).toBe(0);
  });

  it('surfaces service errors with the HTTP status', async () => {
    const { GptSoVitsTtsAdapter } = await import('./index.js');
    const adapter = new GptSoVitsTtsAdapter({
      baseUrl: 'http://127.0.0.1:9880', voices, outputDirectory: '.',
      fetcher: async () => new Response('bad ref audio', { status: 400 }),
    });
    await expect(adapter.synthesize({ readingId: 'x', text: 'Hi', voiceId: 'mei-voice', speed: 1, locale: 'en' }))
      .rejects.toThrow('GPTSOVITS_HTTP_400');
  });

  it('falls back to the backup adapter when the primary fails', async () => {
    const { FallbackTtsAdapter, TimingFallbackTtsAdapter } = await import('./index.js');
    const failing: TtsAdapter = {
      id: 'failing', health: () => ({ id: 'failing', label: '', status: 'ERROR' as const, message: '', configured: true }),
      synthesize: async () => { throw new Error('GPTSOVITS_HTTP_500'); },
    };
    const chain = new FallbackTtsAdapter(failing, new TimingFallbackTtsAdapter());
    const result = await chain.synthesize({ readingId: 'x', text: 'Hola', voiceId: 'v', speed: 1, locale: 'es', targetSeconds: 5 });
    expect(result.providerId).toContain('timing-fallback-tts');
    expect(result.providerId).toContain('GPTSOVITS_HTTP_500');
  });
});

describe('Alibaba and Baidu cloud provider adapters', () => {
  it('sends Alibaba CosyVoice enrollment and synthesis in the official nested contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliyun-voice-'));
    const wav = pcmWav([1000, 1000, 1000, 1000]);
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      const value = String(url);
      if (value.includes('SpeechSynthesizer')) {
        calls.push({ url: value, body: JSON.parse(String(init?.body)) });
        return Response.json({ output: { audio: { url: 'https://cdn.example.test/voice.wav' } } });
      }
      if (value === 'https://cdn.example.test/voice.wav') return new Response(new Uint8Array(wav), { headers: { 'content-type': 'audio/wav' } });
      calls.push({ url: value, body: JSON.parse(String(init?.body)) });
      return Response.json({ output: { voice_id: 'cosy-voice-1' } });
    };
    try {
      const adapter = new CloudVoiceCloneAdapter({
        id: 'aliyun-voice', label: 'Alibaba CosyVoice', apiKey: 'dash-key', outputDirectory: directory, fetcher,
        config: { baseUrl: 'https://dashscope.aliyuncs.com', clonePath: '/api/v1/services/audio/tts/customization', synthesizePath: '/api/v1/services/audio/tts/SpeechSynthesizer', protocol: 'ALIYUN_DASHSCOPE', publicBaseUrl: 'https://live.example.test', model: 'voice-enrollment', targetModel: 'cosyvoice-v3.5-plus', region: 'cn-beijing', apiKeyEnv: 'DASHSCOPE_API_KEY' },
      });
      const cloned = await adapter.clone({ name: 'Mei', audio: wav, fileName: 'sample.wav', sourceLanguage: 'zh', targetLocale: 'en-US' });
      const spoken = await adapter.synthesize({ readingId: 'aliyun-reading', text: 'Hello from the cloud.', voiceId: cloned.providerCloneId, speed: 1, locale: 'en-US', targetLocale: 'en-US' });
      expect(cloned.providerCloneId).toBe('cosy-voice-1');
      expect(calls[0]?.body).toMatchObject({ model: 'voice-enrollment', input: { action: 'create_voice', target_model: 'cosyvoice-v3.5-plus' } });
      expect(String((calls[0]?.body?.input as Record<string, unknown>).url)).toContain('/api/public-audio/');
      expect(calls[1]?.body).toMatchObject({ model: 'cosyvoice-v3.5-plus', input: { text: 'Hello from the cloud.', voice: 'cosy-voice-1', language_hints: ['English'] } });
      expect(spoken.durationMs).toBeGreaterThanOrEqual(250);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('uses the Alibaba Qwen Omni voice template for both enrollment and copy reading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliyun-qwen-voice-'));
    const wav = pcmWav([1000, 1000, 1000, 1000], 24_000);
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      const value = String(url);
      if (value.includes('/chat/completions')) {
        calls.push({ url: value, body: JSON.parse(String(init?.body)) });
        const first = pcm.subarray(0, 4).toString('base64');
        const second = pcm.subarray(4).toString('base64');
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: first } } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { audio: { data: second } } }] })}\n\ndata: [DONE]\n`, { headers: { 'content-type': 'text/event-stream' } });
      }
      calls.push({ url: value, body: JSON.parse(String(init?.body)) });
      return Response.json({ output: { voice: 'qwen-voice-mei' } });
    };
    try {
      const adapter = new CloudVoiceCloneAdapter({
        id: 'aliyun-qwen-voice', label: 'Alibaba Qwen Omni', apiKey: 'dash-key', outputDirectory: directory, fetcher,
        config: { baseUrl: 'https://dashscope.aliyuncs.com', clonePath: '/api/v1/services/audio/tts/customization', synthesizePath: '/compatible-mode/v1/chat/completions', protocol: 'ALIYUN_QWEN_OMNI', model: 'qwen-voice-enrollment', targetModel: 'qwen3.5-omni-plus', region: 'cn-beijing', apiKeyEnv: 'DASHSCOPE_API_KEY', workspaceId: 'ws-test' },
      });
      const cloned = await adapter.clone({ name: '我的中文声音', audio: wav, fileName: 'sample.wav', referenceText: '这是用于克隆的中文样音。', sourceLanguage: 'zh-CN', targetLocale: 'en-US' });
      const spoken = await adapter.synthesize({ readingId: 'qwen-reading', text: 'Hello from the cloned voice.', voiceId: cloned.providerCloneId, speed: 1, locale: 'en-US', targetLocale: 'en-US' });
      expect(cloned.providerCloneId).toBe('qwen-voice-mei');
      expect(calls[0]?.url).toContain('ws-test.cn-beijing.maas.aliyuncs.com');
      expect(calls[0]?.body).toMatchObject({ model: 'qwen-voice-enrollment', input: { action: 'create', target_model: 'qwen3.5-omni-plus', preferred_name: '我的中文声音', audio: { data: expect.stringMatching(/^data:audio\/wav;base64,/) } } });
      expect(calls[1]?.body).toMatchObject({ model: 'qwen3.5-omni-plus', modalities: ['text', 'audio'], audio: { voice: 'qwen-voice-mei', format: 'wav' }, stream: true });
      expect(spoken.durationMs).toBeGreaterThanOrEqual(250);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('uploads a Chinese sample and polls Baidu Xiling synthesis without changing the target fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'baidu-voice-'));
    const wav = pcmWav(new Array(480_000).fill(1000));
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      const value = String(url);
      calls.push({ url: value, body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined });
      if (value.includes('/file/upload')) return Response.json({ result: { fileId: 'upload-audio-1' } });
      if (value.includes('/tts/clone/v2')) return Response.json({ result: { perId: 'baidu-person-1' } });
      if (value.includes('/tts/text2audio/submit')) return Response.json({ result: { taskId: 'tts-task-1' } });
      if (value.includes('/tts/text2audio/task')) return Response.json({ result: { taskId: 'tts-task-1', status: 'SUCCESS', audioUrl: 'https://cdn.example.test/baidu.wav' } });
      return new Response(new Uint8Array(pcmWav([2000, 2000, 2000, 2000])), { headers: { 'content-type': 'audio/wav' } });
    };
    try {
      const adapter = new CloudVoiceCloneAdapter({
        id: 'baidu-voice', label: 'Baidu Xiling', apiKey: 'baidu-key', outputDirectory: directory, fetcher,
        config: { baseUrl: 'https://open.xiling.baidu.com', clonePath: '/api/digitalhuman/open/v1/tts/clone/v2', synthesizePath: '/api/digitalhuman/open/v1/tts/text2audio/submit', synthesizeStatusPath: '/api/digitalhuman/open/v1/tts/text2audio/task', uploadPath: '/api/digitalhuman/open/v1/file/upload', uploadProviderType: 'OPEN_TTS_CLONE', protocol: 'BAIDU_XILING', model: 'quality_v2', targetModel: 'quality_v2', region: 'cn', apiKeyEnv: 'BAIDU_XILING_APP_KEY', appId: 'baidu-app' },
      });
      const cloned = await adapter.clone({ name: 'Mei', audio: wav, fileName: 'sample.wav', referenceText: '这是一段用于克隆的中文样音。', sourceLanguage: 'zh', targetLocale: 'zh-CN' });
      const spoken = await adapter.synthesize({ readingId: 'baidu-reading', text: '这是百度试听。', voiceId: cloned.providerCloneId, speed: 1, locale: 'zh-CN', targetLocale: 'zh-CN' });
      expect(cloned.providerCloneId).toBe('baidu-person-1');
      expect(String(calls[0]?.url)).toContain('providerType=OPEN_TTS_CLONE');
      expect(calls[1]?.body).toMatchObject({ requestId: expect.any(String), uploadAudioId: 'upload-audio-1', exampleText: '这是一段用于克隆的中文样音。' });
      expect(calls[2]?.body).toMatchObject({ person: 'baidu-person-1', lan: 'Chinese', outputFormat: 'wav', sampleRate: 16000 });
      expect(spoken.durationMs).toBeGreaterThanOrEqual(250);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('submits Baidu Xiling avatar training and waits for READY', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'baidu-avatar-'));
    const videoPath = join(directory, 'avatar.mp4');
    await writeFile(videoPath, Buffer.from('video')); 
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      const value = String(url);
      calls.push({ url: value, method: init?.method, body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined });
      if (value.includes('lite2d/query') && value.includes('systemFigure')) return Response.json({ result: [] });
      if (value.includes('/file/upload')) return Response.json({ result: { fileId: 'video-1' } });
      if (value.includes('/lite2d/train')) return Response.json({ result: { figureId: 'figure-1' } });
      if (value.includes('/lite2d/query')) return Response.json({ result: { status: 'SUCCESS' } });
      return Response.json({});
    };
    try {
      const adapter = new CloudAvatarProviderAdapter({
        id: 'baidu-avatar', vendorId: 'baidu-cloud', vendorLabel: 'Baidu Xiling', apiKey: 'baidu-key', outputDirectory: directory, fetcher,
        config: { baseUrl: 'https://open.xiling.baidu.com', clonePath: '/api/digitalhuman/open/v1/figure/lite2d/train', renderPath: '/api/digitalhuman/open/v1/liveRooms', statusPath: '/api/digitalhuman/open/v1/figure/lite2d/query', healthPath: '/api/digitalhuman/open/v1/figure/lite2d/query?systemFigure=true&pageSize=1', uploadPath: '/api/digitalhuman/open/v1/file/upload', uploadProviderType: 'OPEN_CUSTOMIZATION_2D_GENERAL', customizeType: 'LITE_2D_GENERAL', gender: 'UNKNOWN', protocol: 'BAIDU_XILING', model: 'quality_v2', region: 'cn', apiKeyEnv: 'BAIDU_XILING_APP_KEY', appId: 'baidu-app', streamMode: 'HTTP_STREAM' },
      });
      const cloned = await adapter.clone({ name: 'Mei', videoPath, authorizationConfirmed: true });
      const training = await adapter.waitForClone(cloned.cloudFigureId, 1_000);
      expect(cloned.cloudFigureId).toBe('figure-1');
      expect(training).toEqual({});
      expect(calls.some((call) => call.url.includes('/lite2d/train'))).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('returns Alibaba DingRTC credentials instead of pretending they are an HTTP video URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliyun-avatar-'));
    const audioPath = join(directory, 'speech.wav');
    await writeFile(audioPath, pcmWav([1000, 1000, 1000, 1000]));
    const calls: Array<{ url: string }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      const value = String(url);
      if (value.includes('QueryAvatarList')) return Response.json({ Success: true, Data: {} });
      calls.push({ url: value });
      return Response.json({ Success: true, Data: { SessionId: 'aliyun-session-1', Channel: { ChannelId: 'channel-1', Token: 'rtc-token', UserId: 'user-1', AppId: 'rtc-app', Gslb: ['https://rgslb.rtc.aliyuncs.com'], ExpiredTime: 1_900_000_000_000 } } });
    };
    try {
      const adapter = new CloudAvatarProviderAdapter({
        id: 'aliyun-avatar', vendorId: 'aliyun-cloud', vendorLabel: 'Alibaba Avatar', apiKey: JSON.stringify({ accessKeyId: 'ak-id', accessKeySecret: 'ak-secret' }), outputDirectory: directory, fetcher,
        config: { baseUrl: 'https://avatar.cn-zhangjiakou.aliyuncs.com', clonePath: '/?Action=Create2dAvatar', renderPath: '/?Action=StartInstance', healthPath: '/?Action=QueryAvatarList', protocol: 'ALIYUN_AVATAR_OPENAPI', model: 'StartInstance', region: 'cn-zhangjiakou', apiKeyEnv: 'ALIYUN_ACCESS_KEY_SECRET', tenantId: 'tenant-1', appId: 'app-1', streamMode: 'RTC' },
      });
      const rendered = await adapter.render(audioPath, 'reading-1', 'figure-1', '这是同一条播报内容。');
      expect(rendered.streamUrl).toBeUndefined();
      expect(rendered.rtc).toMatchObject({ provider: 'aliyun-avatar', sessionId: 'aliyun-session-1', channelId: 'channel-1', token: 'rtc-token', appId: 'rtc-app' });
      expect(calls.find((call) => call.url.includes('StartInstance'))?.url).toContain('Signature=');
      const startUrl = calls.find((call) => call.url.includes('StartInstance'))?.url ?? '';
      expect(startUrl).toContain('TenantId=tenant-1');
      expect(startUrl).toContain('App.AppId=app-1');
      expect(startUrl).toContain('Channel.Type=DingRTC');
      expect(startUrl).toContain('TextRequest.SpeechText=');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
