import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import WebSocket from 'ws';
import type {
  AdapterHealth,
  AmplitudeFrame,
  AvatarRtcConnection,
  AvatarActionName,
  AvatarProviderAdapterState,
  AvatarStageMedia,
  GptSoVitsVoice,
  LipSyncPlan,
  LiveChatEvent,
  LiveGiftEvent,
  LiveLikeEvent,
  ProviderSettings,
  AvatarCloudProviderConfig,
  VoiceCloudProviderConfig,
  TikfinityDiagnostics,
  TtsResult,
  VoiceProfile,
  VTubeStudioConnectionState,
  VTubeStudioModelProfile,
  VisemeFrame,
} from '@meihua/core-types';

export interface LiveInputHandlers {
  onChat: (event: LiveChatEvent) => Promise<void>;
  onGift: (event: LiveGiftEvent) => Promise<void>;
  onLike: (event: LiveLikeEvent) => Promise<void>;
}

export interface LiveInputAdapter {
  readonly id: string;
  start(handlers: LiveInputHandlers): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;
  diagnostics?(): TikfinityDiagnostics;
}

export interface TtsAdapter {
  readonly id: string;
  synthesize(input: { readingId: string; text: string; voiceId: string; speed: number; locale: string; targetSeconds?: number; targetLocale?: string; targetCountry?: string; accentProfileId?: string; sourceLanguage?: string }): Promise<TtsResult>;
  health(): AdapterHealth;
}

export interface NativeAudioPlayer {
  play(input: {
    filePath: string;
    signal?: AbortSignal;
    onStarted?: (startedAt: number) => void;
  }): Promise<{ startedAt: number; endedAt: number }>;
}

/**
 * Plays a generated WAV through the interactive Windows user's default output
 * device. The child process is the playback clock: completion is reported only
 * after SoundPlayer.PlaySync() has actually returned.
 */
export class WindowsNativeAudioPlayer implements NativeAudioPlayer {
  async play(input: { filePath: string; signal?: AbortSignal; onStarted?: (startedAt: number) => void }): Promise<{ startedAt: number; endedAt: number }> {
    if (process.platform !== 'win32') throw new Error('Native Windows audio playback is only available on Windows.');
    if (input.signal?.aborted) throw Object.assign(new Error('Audio playback aborted.'), { name: 'AbortError' });
    const pathBase64 = Buffer.from(input.filePath, 'utf8').toString('base64');
    const script = [
      "$ErrorActionPreference='Stop'",
      `$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))`,
      '$player=[System.Media.SoundPlayer]::new($path)',
      "try { $player.Load(); [Console]::Out.WriteLine('MEIHUA_PLAY_STARTED'); [Console]::Out.Flush(); $player.PlaySync(); [Console]::Out.WriteLine('MEIHUA_PLAY_ENDED'); [Console]::Out.Flush() } finally { $player.Dispose() }",
    ].join(';');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let startedAt = 0;
      let endedMarker = false;
      let settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', abort);
        reject(error);
      };
      const inspect = () => {
        if (!startedAt && stdout.includes('MEIHUA_PLAY_STARTED')) {
          startedAt = Date.now();
          input.onStarted?.(startedAt);
        }
        if (stdout.includes('MEIHUA_PLAY_ENDED')) endedMarker = true;
      };
      const abort = () => {
        child.kill();
        finishError(Object.assign(new Error('Audio playback aborted.'), { name: 'AbortError' }));
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; inspect(); });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', finishError);
      child.once('exit', (code) => {
        inspect();
        if (settled) return;
        input.signal?.removeEventListener('abort', abort);
        if (code !== 0) return finishError(new Error(stderr.trim() || `Windows audio playback exited with code ${code}.`));
        if (!startedAt || !endedMarker) return finishError(new Error('Windows audio playback did not confirm a complete start/end cycle.'));
        settled = true;
        resolve({ startedAt, endedAt: Date.now() });
      });
      input.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

export type AvatarAction = AvatarActionName;

export interface AvatarAdapter {
  readonly id: string;
  perform(action: AvatarAction, input: { readingId?: string }): Promise<void>;
  health(): AdapterHealth;
}

function runPowerShell(encodedCommand: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { errorText += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errorText.trim() || `Windows TTS exited with code ${code}`)));
  });
}

type WaveInfo = { byteRate: number; sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number; dataSize: number };

function waveInfo(buffer: Buffer): WaveInfo | undefined {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let offset = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) return undefined;
    if (id === 'fmt ' && size >= 16) {
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      byteRate = buffer.readUInt32LE(start + 8);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    }
    if (id === 'data' && byteRate > 0) return { byteRate, sampleRate, channels, bitsPerSample, dataOffset: start, dataSize: size };
    offset = start + size + (size % 2);
  }
  return undefined;
}

export function wavDuration(buffer: Buffer): number {
  const info = waveInfo(buffer);
  return info ? Math.max(250, Math.round((info.dataSize / info.byteRate) * 1_000)) : 0;
}

/** SAPI visemes are grouped into five visible vowel shapes. Silence stays explicit. */
export function mapSapiViseme(viseme: number): VisemeFrame['vowel'] {
  if (!Number.isFinite(viseme) || viseme <= 0) return 'SILENCE';
  if (viseme <= 4) return 'A';
  if (viseme <= 8) return 'E';
  if (viseme <= 12) return 'I';
  if (viseme <= 16) return 'O';
  return 'U';
}

function sampleAt(buffer: Buffer, offset: number, bits: number): number {
  if (bits === 8) return (buffer.readUInt8(offset) - 128) / 128;
  if (bits === 16) return buffer.readInt16LE(offset) / 32768;
  if (bits === 24) return buffer.readIntLE(offset, 3) / 8_388_608;
  if (bits === 32) return buffer.readInt32LE(offset) / 2_147_483_648;
  return 0;
}

export function analyzeWavAmplitude(buffer: Buffer, frameIntervalMs = 20): AmplitudeFrame[] {
  const info = waveInfo(buffer);
  if (!info || !info.sampleRate || !info.channels || ![8, 16, 24, 32].includes(info.bitsPerSample)) return [];
  const bytesPerSample = info.bitsPerSample / 8;
  const bytesPerFrame = bytesPerSample * info.channels;
  const totalFrames = Math.floor(info.dataSize / bytesPerFrame);
  const samplesPerWindow = Math.max(1, Math.round(info.sampleRate * frameIntervalMs / 1_000));
  const raw: number[] = [];
  for (let start = 0; start < totalFrames; start += samplesPerWindow) {
    const end = Math.min(totalFrames, start + samplesPerWindow);
    let sum = 0;
    let count = 0;
    for (let frame = start; frame < end; frame++) {
      for (let channel = 0; channel < info.channels; channel++) {
        const value = sampleAt(buffer, info.dataOffset + frame * bytesPerFrame + channel * bytesPerSample, info.bitsPerSample);
        sum += value * value;
        count++;
      }
    }
    raw.push(count ? Math.sqrt(sum / count) : 0);
  }
  const peak = Math.max(0.02, ...raw);
  let smooth = 0;
  return raw.map((value, index) => {
    const normalized = Math.max(0, Math.min(1, (value / peak - 0.035) / 0.965));
    const coefficient = normalized > smooth ? 0.68 : 0.24;
    smooth += (normalized - smooth) * coefficient;
    return {
      offsetMs: index * frameIntervalMs,
      durationMs: frameIntervalMs,
      rms: Number(normalized.toFixed(4)),
      mouthOpen: Number(smooth.toFixed(4)),
    };
  });
}

type RawViseme = { viseme?: number; nextViseme?: number; audioPositionMs?: number; durationMs?: number; emphasis?: string };

export function buildLipSyncPlan(input: { wav: Buffer; visemes?: RawViseme[]; createdAt?: number }): LipSyncPlan {
  const totalDurationMs = wavDuration(input.wav);
  const amplitudes = analyzeWavAmplitude(input.wav);
  const visemes = (input.visemes ?? [])
    .filter((item) => Number.isFinite(item.viseme) && Number.isFinite(item.audioPositionMs))
    .map((item) => ({
      offsetMs: Math.max(0, Math.round(item.audioPositionMs ?? 0)),
      durationMs: Math.max(20, Math.round(item.durationMs ?? 80)),
      viseme: Math.max(0, Math.round(item.viseme ?? 0)),
      nextViseme: Number.isFinite(item.nextViseme) ? Math.max(0, Math.round(item.nextViseme!)) : undefined,
      vowel: mapSapiViseme(item.viseme ?? 0),
      emphasis: item.emphasis,
    }));
  return {
    version: 1,
    mode: visemes.length ? 'VISEME_AMPLITUDE' : amplitudes.length ? 'AMPLITUDE_ONLY' : 'NONE',
    frameIntervalMs: 20,
    totalDurationMs,
    visemes,
    amplitudes,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export class WindowsTtsAdapter implements TtsAdapter {
  readonly id = 'windows-tts';

  constructor(private readonly outputDirectory: string) {}

  async synthesize(input: { readingId: string; text: string; voiceId: string; speed: number; locale: string; targetSeconds?: number }): Promise<TtsResult> {
    await mkdir(this.outputDirectory, { recursive: true });
    const fileName = `${basename(input.readingId).replace(/[^a-zA-Z0-9_-]/g, '') || 'reading'}-${Date.now()}.wav`;
    const outputPath = join(this.outputDirectory, fileName);
    const textBase64 = Buffer.from(input.text, 'utf8').toString('base64');
    const pathBase64 = Buffer.from(outputPath, 'utf8').toString('base64');
    const voiceBase64 = Buffer.from(input.voiceId || '', 'utf8').toString('base64');
    // The operator-approved live cadence is deliberately slower than SAPI's
    // default. Duration tiers are achieved by changing narration length, not
    // by forcing the same paragraph through an unnaturally fast voice.
    const rate = windowsSapiRate(input.speed);
    const script = [
      'Add-Type -AssemblyName System.Speech',
      `$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${textBase64}'))`,
      `$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))`,
      `$voice=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${voiceBase64}'))`,
      '$s=[System.Speech.Synthesis.SpeechSynthesizer]::new()',
      `try { if (-not $voice) { throw 'WINDOWS_TTS_VOICE_REQUIRED' }; $installed=$s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -eq $voice }; if (-not $installed) { throw ('WINDOWS_TTS_VOICE_NOT_INSTALLED:' + $voice) }; $s.SelectVoice($voice); $s.Rate=${rate}; $s.SetOutputToWaveFile($path); $s.Speak($text) } finally { $s.Dispose() }`,
    ].join(';');
    await runPowerShell(Buffer.from(script, 'utf16le').toString('base64'));
    const durationMs = wavDuration(await readFile(outputPath));
    if (!durationMs) throw new Error('Generated WAV duration could not be determined');
    return { audioPath: `/api/audio/${encodeURIComponent(fileName)}`, durationMs, providerId: this.id };
  }

  health(): AdapterHealth {
    return { id: this.id, label: 'Windows 本地语音', status: process.platform === 'win32' ? 'READY' : 'NOT_CONFIGURED', message: process.platform === 'win32' ? '使用系统语音生成实际 WAV 音频' : '仅支持 Windows System.Speech', configured: process.platform === 'win32' };
  }
}

export function windowsSapiRate(speed: number): number {
  const multiplier = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return Math.max(-6, Math.min(4, Math.round((multiplier - 1) * 4) - 2));
}

export type OpenAICompatibleTtsOptions = {
  outputDirectory: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  instructions?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

function speechUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, '');
  if (!value) throw new Error('TTS_BASE_URL_REQUIRED');
  if (/\/audio\/speech$/i.test(value)) return value;
  return `${value}/audio/speech`;
}

/** OpenAI-compatible speech synthesis with a real WAV artifact. */
export class OpenAICompatibleTtsAdapter implements TtsAdapter {
  readonly id = 'openai-compatible-tts';
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAICompatibleTtsOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async synthesize(input: { readingId: string; text: string; voiceId: string; speed: number; locale: string; targetSeconds?: number }): Promise<TtsResult> {
    if (!this.options.apiKey.trim()) throw new Error('TTS_API_KEY_REQUIRED');
    if (!this.options.model.trim()) throw new Error('TTS_MODEL_REQUIRED');
    if (!input.voiceId.trim()) throw new Error('TTS_VOICE_REQUIRED');
    const response = await this.fetcher(speechUrl(this.options.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', accept: 'audio/wav' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 45_000),
      body: JSON.stringify({
        model: this.options.model,
        input: input.text,
        voice: input.voiceId,
        response_format: 'wav',
        speed: Math.max(0.25, Math.min(4, input.speed || 1)),
        ...(this.options.instructions?.trim() ? { instructions: this.options.instructions.trim() } : {}),
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`TTS_HTTP_${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    const durationMs = wavDuration(audio);
    if (!durationMs) throw new Error('TTS_RESPONSE_NOT_PLAYABLE_WAV');
    await mkdir(this.options.outputDirectory, { recursive: true });
    const fileName = `${basename(input.readingId).replace(/[^a-zA-Z0-9_-]/g, '') || 'reading'}-${Date.now()}-external.wav`;
    await writeFile(join(this.options.outputDirectory, fileName), audio);
    return { audioPath: `/api/audio/${encodeURIComponent(fileName)}`, durationMs, providerId: this.id };
  }

  health(): AdapterHealth {
    const configured = Boolean(this.options.baseUrl.trim() && this.options.model.trim() && this.options.apiKey.trim());
    return {
      id: this.id,
      label: 'OpenAI-compatible TTS',
      status: configured ? 'DEGRADED' : 'NOT_CONFIGURED',
      message: configured ? '配置已保存，需通过真实生成试听后才标记 READY' : '需要接口地址、模型、声音和 API Key',
      configured,
    };
  }
}

export type KokoroTtsAdapterOptions = {
  baseUrl: string;
  outputDirectory: string;
  defaultVoice?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

/**
 * Local Kokoro ONNX preset voices. The service writes the WAV into the
 * orchestrator's controlled audio directory so the existing Audio Bus and
 * playback path remain unchanged. This is a preset voice, not voice cloning.
 */
export class KokoroTtsAdapter implements TtsAdapter {
  readonly id = 'kokoro-tts';
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: KokoroTtsAdapterOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async synthesize(input: { readingId: string; text: string; voiceId: string; speed: number; locale: string; targetSeconds?: number; targetLocale?: string }): Promise<TtsResult> {
    const locale = (input.targetLocale ?? input.locale ?? '').trim().toLowerCase();
    if (locale && !['en', 'en-us', 'en-gb', 'en_us', 'en_gb'].includes(locale)) {
      throw new Error(`KOKORO_LANG_UNSUPPORTED:${input.targetLocale ?? input.locale}`);
    }
    const voice = input.voiceId.trim() || this.options.defaultVoice?.trim() || 'af_heart';
    if (!/^(af|bf)_[a-z][a-z0-9_]*$/i.test(voice)) throw new Error(`KOKORO_VOICE_UNSUPPORTED:${voice}`);
    if (!input.text.trim()) throw new Error('KOKORO_TEXT_REQUIRED');
    await mkdir(this.options.outputDirectory, { recursive: true });
    const fileName = `${basename(input.readingId).replace(/[^a-zA-Z0-9_-]/g, '') || 'reading'}-${Date.now()}-kokoro.wav`;
    const outputPath = join(this.options.outputDirectory, fileName);
    const baseUrl = this.options.baseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl) throw new Error('KOKORO_BASE_URL_REQUIRED');
    const response = await this.fetcher(`${baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      body: JSON.stringify({
        text: input.text,
        voice,
        speed: Math.max(0.5, Math.min(2, input.speed || 1)),
        locale: (input.targetLocale ?? input.locale ?? '').toLowerCase(),
        output_path: outputPath,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`KOKORO_HTTP_${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (result.error) throw new Error(`KOKORO_ERROR:${result.error}`);
    const audio = await readFile(outputPath).catch(() => Buffer.alloc(0));
    if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new Error('KOKORO_OUTPUT_NOT_WAV');
    const durationMs = wavDuration(audio);
    if (!durationMs) throw new Error('KOKORO_DURATION_UNKNOWN');
    return { audioPath: `/api/audio/${encodeURIComponent(fileName)}`, durationMs, providerId: this.id };
  }

  health(): AdapterHealth {
    const configured = Boolean(this.options.baseUrl.trim() && (this.options.defaultVoice ?? 'af_heart').trim());
    return {
      id: this.id,
      label: 'Kokoro 本地英文女声',
      status: configured ? 'DEGRADED' : 'NOT_CONFIGURED',
      configured,
      message: configured ? '本地神经英文预置音色；无需 API Key，需完成真实试听后用于正式播报' : '需要 Kokoro 本地服务地址和音色',
    };
  }
}

export type ElevenLabsOptions = {
  baseUrl: string;
  apiKey: string;
  fetcher?: typeof fetch;
};

export type ElevenLabsTtsOptions = ElevenLabsOptions & {
  outputDirectory: string;
  model: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speakerBoost?: boolean;
  timeoutMs?: number;
};

function elevenLabsOrigin(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, '');
  if (!value) throw new Error('ELEVENLABS_BASE_URL_REQUIRED');
  const parsed = new URL(value);
  return parsed.origin;
}

/** Wrap raw signed 16-bit mono PCM in a standard WAV container. */
export function pcm16MonoToWav(pcm: Buffer, sampleRate = 24_000): Buffer {
  if (!pcm.length || pcm.length % 2 !== 0) throw new Error('ELEVENLABS_PCM_INVALID');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

export class ElevenLabsVoiceClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ElevenLabsOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  private headers(): Record<string, string> {
    if (!this.options.apiKey.trim()) throw new Error('TTS_API_KEY_REQUIRED');
    return { 'xi-api-key': this.options.apiKey.trim() };
  }

  async listVoices(): Promise<VoiceProfile[]> {
    const response = await this.fetcher(`${elevenLabsOrigin(this.options.baseUrl)}/v2/voices?page_size=100`, {
      headers: { ...this.headers(), accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`ELEVENLABS_VOICES_HTTP_${response.status}: ${(await response.text()).slice(0, 500)}`);
    const payload = await response.json() as { voices?: Array<Record<string, unknown>> };
    return (payload.voices ?? []).flatMap((voice) => {
      const voiceId = typeof voice.voice_id === 'string' ? voice.voice_id : '';
      const name = typeof voice.name === 'string' ? voice.name : '';
      if (!voiceId || !name) return [];
      const verification = voice.fine_tuning && typeof voice.fine_tuning === 'object' ? voice.fine_tuning as Record<string, unknown> : undefined;
      return [{
        voiceId,
        provider: 'elevenlabs' as const,
        name,
        category: typeof voice.category === 'string' ? voice.category : undefined,
        description: typeof voice.description === 'string' ? voice.description : undefined,
        requiresVerification: verification?.verification_attempts_count === 0 && verification?.is_allowed_to_fine_tune === false,
        previewUrl: typeof voice.preview_url === 'string' ? voice.preview_url : undefined,
      }];
    });
  }

  async cloneVoice(input: { name: string; fileName: string; mimeType: string; audio: Buffer; authorizationConfirmed: boolean }): Promise<VoiceProfile> {
    if (!input.authorizationConfirmed) throw new Error('VOICE_AUTHORIZATION_REQUIRED');
    const body = new FormData();
    body.append('name', input.name.trim());
    body.append('remove_background_noise', 'true');
    body.append('files', new Blob([new Uint8Array(input.audio)], { type: input.mimeType || 'application/octet-stream' }), input.fileName);
    const response = await this.fetcher(`${elevenLabsOrigin(this.options.baseUrl)}/v1/voices/add`, {
      method: 'POST', headers: this.headers(), body, signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`ELEVENLABS_CLONE_HTTP_${response.status}: ${(await response.text()).slice(0, 500)}`);
    const payload = await response.json() as { voice_id?: string; requires_verification?: boolean };
    if (!payload.voice_id) throw new Error('ELEVENLABS_CLONE_VOICE_ID_MISSING');
    return {
      voiceId: payload.voice_id,
      provider: 'elevenlabs',
      name: input.name.trim(),
      category: 'cloned',
      requiresVerification: payload.requires_verification === true,
    };
  }
}

/** ElevenLabs multilingual synthesis using an actual cloned voice_id. */
export class ElevenLabsTtsAdapter implements TtsAdapter {
  readonly id = 'elevenlabs-tts';
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ElevenLabsTtsOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async synthesize(input: { readingId: string; text: string; voiceId: string; speed: number; locale: string; targetSeconds?: number }): Promise<TtsResult> {
    if (!this.options.apiKey.trim()) throw new Error('TTS_API_KEY_REQUIRED');
    if (!this.options.model.trim()) throw new Error('TTS_MODEL_REQUIRED');
    if (!input.voiceId.trim()) throw new Error('TTS_VOICE_REQUIRED');
    const url = `${elevenLabsOrigin(this.options.baseUrl)}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=pcm_24000`;
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.options.apiKey.trim(), 'content-type': 'application/json', accept: 'audio/pcm' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      body: JSON.stringify({
        text: input.text,
        model_id: this.options.model,
        voice_settings: {
          stability: Math.max(0, Math.min(1, this.options.stability ?? 0.5)),
          similarity_boost: Math.max(0, Math.min(1, this.options.similarityBoost ?? 0.75)),
          style: Math.max(0, Math.min(1, this.options.style ?? 0)),
          use_speaker_boost: this.options.speakerBoost !== false,
          speed: Math.max(0.7, Math.min(1.2, input.speed || 1)),
        },
      }),
    });
    if (!response.ok) throw new Error(`ELEVENLABS_TTS_HTTP_${response.status}: ${(await response.text()).slice(0, 500)}`);
    const wav = pcm16MonoToWav(Buffer.from(await response.arrayBuffer()), 24_000);
    const durationMs = wavDuration(wav);
    if (!durationMs) throw new Error('ELEVENLABS_TTS_RESPONSE_INVALID');
    await mkdir(this.options.outputDirectory, { recursive: true });
    const fileName = `${basename(input.readingId).replace(/[^a-zA-Z0-9_-]/g, '') || 'reading'}-${Date.now()}-elevenlabs.wav`;
    await writeFile(join(this.options.outputDirectory, fileName), wav);
    return { audioPath: `/api/audio/${encodeURIComponent(fileName)}`, durationMs, providerId: this.id };
  }

  health(): AdapterHealth {
    const configured = Boolean(this.options.baseUrl.trim() && this.options.model.trim() && this.options.apiKey.trim());
    return {
      id: this.id, label: 'ElevenLabs 声音克隆', configured,
      status: configured ? 'DEGRADED' : 'NOT_CONFIGURED',
      message: configured ? '已配置，须生成并试听真实克隆声音后才标记 READY' : '需要 ElevenLabs API Key、模型和真实 voiceId',
    };
  }
}

/** Timing-only emergency fallback used only when local/external synthesis fails. */
export class TimingFallbackTtsAdapter implements TtsAdapter {
  readonly id = 'timing-fallback-tts';
  async synthesize(input: { text: string; speed: number; targetSeconds?: number }): Promise<TtsResult> {
    const calculated = Math.round(([...input.text].length * 230) / Math.max(input.speed, 0.5));
    return { durationMs: Math.max(1_600, Math.min(120_000, input.targetSeconds ? input.targetSeconds * 1_000 : calculated)), providerId: this.id };
  }
  health(): AdapterHealth {
    return { id: this.id, label: '无声应急时序', status: 'DEGRADED', message: '仅在语音生成失败时维持流程，不输出音频', configured: true };
  }
}

export type GptSoVitsTtsAdapterOptions = {
  baseUrl: string;
  /** V2/V3 are GPT-SoVITS contracts; CHANYIN_QFTTS is ChanYin's local QFTTS contract. */
  apiVersion?: 'V2' | 'V3' | 'CHANYIN_QFTTS';
  /** Available local voice packs; voiceId selects one, first pack is the default. */
  voices: GptSoVitsVoice[];
  outputDirectory: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** On constrained GPUs, release GPT-SoVITS model memory before lip-sync. */
  releaseGpuAfterSynthesis?: boolean;
  /** Treat a missing managed release endpoint as a real runtime failure. */
  requireGpuRelease?: boolean;
};

/** Languages GPT-SoVITS can synthesize; anything else must route to another provider. */
export const gptSoVitsSupportedLocales = new Set(['zh-CN', 'zh', 'en', 'ja', 'ko', 'yue']);

/**
 * Local open-source voice cloning (GPT-SoVITS, MIT) via its api_v2 `/tts`
 * endpoint. The audio bytes come back in the response (media_type=wav), get
 * written into the orchestrator audio directory and duration-measured like
 * every other adapter. Unsupported locales throw GPTSOVITS_LANG_UNSUPPORTED so
 * the runtime voice chain can route them (ElevenLabs → Windows TTS).
 */
export class GptSoVitsTtsAdapter implements TtsAdapter {
  readonly id = 'gptsovits-tts';
  private readonly fetcher: typeof fetch;

  constructor(private options: GptSoVitsTtsAdapterOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  configure(baseUrl: string, voices: GptSoVitsVoice[], apiVersion: 'V2' | 'V3' | 'CHANYIN_QFTTS' = 'V3'): void {
    if (baseUrl.trim()) this.options.baseUrl = baseUrl;
    if (voices.length) this.options.voices = voices;
    this.options.apiVersion = apiVersion;
  }

  private resolveVoice(voiceId: string): GptSoVitsVoice {
    const requestedVoiceId = voiceId.trim();
    if (!requestedVoiceId) throw new Error('GPTSOVITS_VOICE_REQUIRED');
    const pack = this.options.voices.find((voice) => voice.id === requestedVoiceId);
    if (!pack) throw new Error(`GPTSOVITS_VOICE_NOT_FOUND:${requestedVoiceId}`);
    if (!pack.refAudioPath || !pack.refText.trim()) throw new Error('GPTSOVITS_VOICE_PACK_INCOMPLETE');
    return pack;
  }

  private static textLanguage(locale: string): string {
    const normalized = locale === 'zh-CN' ? 'zh-CN'
      : locale === 'yue-HK' ? 'yue'
        : locale.startsWith('en-') ? 'en'
          : locale.startsWith('ja-') ? 'ja'
            : locale.startsWith('ko-') ? 'ko'
              : locale;
    if (gptSoVitsSupportedLocales.has(normalized)) return normalized === 'zh-CN' ? 'zh' : normalized;
    throw new Error(`GPTSOVITS_LANG_UNSUPPORTED:${locale}`);
  }

  private async releaseGpuRuntime(): Promise<void> {
    if (!this.options.releaseGpuAfterSynthesis || this.options.apiVersion !== 'V3') return;
    let response: Response | undefined;
    try {
      response = await this.fetcher(`${this.options.baseUrl.replace(/\/+$/, '')}/runtime/release`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15_000), body: JSON.stringify({ reason: 'VOICE_SYNTHESIS_COMPLETE' }),
      });
    } catch (error) {
      if (this.options.requireGpuRelease) throw error;
      return;
    }
    if (!response.ok && this.options.requireGpuRelease) throw new Error(`GPTSOVITS_GPU_RELEASE_HTTP_${response.status}`);
  }

  async synthesize(input: { readingId: string; text: string; voiceId: string; speed: number; locale: string; targetSeconds?: number; targetLocale?: string }): Promise<TtsResult> {
    const textLanguage = GptSoVitsTtsAdapter.textLanguage(input.targetLocale ?? input.locale);
    const pack = this.resolveVoice(input.voiceId);
    if (!input.text.trim()) throw new Error('GPTSOVITS_TEXT_REQUIRED');
    await mkdir(this.options.outputDirectory, { recursive: true });
    const fileName = `${basename(input.readingId).replace(/[^a-zA-Z0-9_-]/g, '') || 'reading'}-${Date.now()}-gptsovits.wav`;
    const outputPath = join(this.options.outputDirectory, fileName);
    if (this.options.apiVersion === 'CHANYIN_QFTTS') {
      const response = await this.fetcher(`${this.options.baseUrl.replace(/\/+$/, '')}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 300_000),
        body: JSON.stringify({
          prompt_wav: pack.refAudioPath,
          prompt_text: pack.refText,
          target_text: input.text,
          output_path: outputPath,
          speed: Math.max(0.6, Math.min(1.6, input.speed || 1)),
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`CHANYIN_QFTTS_HTTP_${response.status}${detail ? `: ${detail}` : ''}`);
      }
      const result = await response.json().catch(() => ({})) as { error?: string; wav_seconds?: number };
      if (result.error) throw new Error(`CHANYIN_QFTTS_ERROR:${result.error}`);
      const audio = await readFile(outputPath).catch(() => Buffer.alloc(0));
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new Error('CHANYIN_QFTTS_OUTPUT_NOT_WAV');
      const durationMs = wavDuration(audio);
      if (!durationMs) throw new Error('CHANYIN_QFTTS_DURATION_UNKNOWN');
      return { audioPath: `/api/audio/${encodeURIComponent(fileName)}`, durationMs, providerId: 'chanyin-qftts-tts' };
    }
    if (this.options.apiVersion === 'V3') {
      const response = await this.fetcher(`${this.options.baseUrl.replace(/\/+$/, '')}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
        body: JSON.stringify({
          refer_wav_path: pack.refAudioPath,
          ref_text: pack.refText,
          ref_language: pack.refLanguage,
          text: input.text,
          text_language: textLanguage,
          output_path: outputPath,
          speed: Math.max(0.6, Math.min(1.6, input.speed || 1)),
          how_to_cut: '按标点符号切',
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`GPTSOVITS_V3_HTTP_${response.status}${detail ? `: ${detail}` : ''}`);
      }
      const audio = await readFile(outputPath).catch(() => Buffer.alloc(0));
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new Error('GPTSOVITS_V3_OUTPUT_NOT_WAV');
      const durationMs = wavDuration(audio);
      if (!durationMs) throw new Error('GPTSOVITS_DURATION_UNKNOWN');
      await this.releaseGpuRuntime();
      return { audioPath: `/api/audio/${encodeURIComponent(fileName)}`, durationMs, providerId: this.id };
    }
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/+$/, '')}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
      body: JSON.stringify({
        text: input.text,
        text_lang: textLanguage,
        ref_audio_path: pack.refAudioPath,
        prompt_text: pack.refText,
        prompt_lang: pack.refLanguage,
        speed_factor: Math.max(0.6, Math.min(1.6, input.speed || 1)),
        media_type: 'wav',
        streaming_mode: false,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`GPTSOVITS_HTTP_${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new Error('GPTSOVITS_RESPONSE_NOT_WAV');
    const durationMs = wavDuration(audio);
    if (!durationMs) throw new Error('GPTSOVITS_DURATION_UNKNOWN');
    await writeFile(outputPath, audio);
    return { audioPath: `/api/audio/${encodeURIComponent(fileName)}`, durationMs, providerId: this.id };
  }

  health(): AdapterHealth {
    const configured = Boolean(this.options.baseUrl.trim() && this.options.voices.length);
    return {
      id: this.id,
      label: 'GPT-SoVITS 本地声音克隆',
      status: configured ? 'DEGRADED' : 'NOT_CONFIGURED',
      configured,
      message: configured
        ? `已配置 ${this.options.voices.length} 个音色；需真实试音通过后才标记 READY`
        : '需要启动 GPT-SoVITS 服务并上传至少一个音色（参考音频+文字）',
    };
  }
}

/**
 * Two-stage voice chain: primary first, and on any primary failure the backup
 * synthesizes instead. providerId records which stage actually produced audio.
 */
export class FallbackTtsAdapter implements TtsAdapter {
  readonly id = 'fallback-tts';
  constructor(private readonly primary: TtsAdapter, private readonly fallback: TtsAdapter) {}
  async synthesize(input: { readingId: string; text: string; voiceId: string; speed: number; locale: string; targetSeconds?: number }): Promise<TtsResult> {
    try {
      return await this.primary.synthesize(input);
    } catch (primaryError) {
      try {
        const result = await this.fallback.synthesize(input);
        return { ...result, providerId: `${this.fallback.id ?? 'fallback'}<-${primaryError instanceof Error ? primaryError.message : 'primary_failed'}`.slice(0, 120) };
      } catch {
        throw primaryError;
      }
    }
  }
  health(): AdapterHealth {
    return this.primary.health();
  }
}

export class NoAvatarAdapter implements AvatarAdapter {
  readonly id = 'no-avatar';
  private lastAction: AvatarAction = 'IDLE';
  async perform(action: AvatarAction, _input: { readingId?: string }): Promise<void> { this.lastAction = action; }
  health(): AdapterHealth {
    return { id: this.id, label: '数字人未启用', status: 'READY', message: `Overlay 与音频独立运行 · 当前动作 ${this.lastAction}`, configured: true };
  }
}

/**
 * V2.2 provider-agnostic avatar contract. A concrete vendor adapter implements
 * connection, capability detection, session lifecycle, stage actions, media
 * output, disconnect and error fallback; the runtime and the stage only speak
 * through this interface, never to a specific vendor SDK.
 */
export interface AvatarProviderAdapter {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorLabel: string;
  connect(): Promise<AvatarProviderAdapterState>;
  detectCapabilities(): Promise<AvatarProviderAdapterState['capabilities']>;
  createSession(input?: { note?: string }): Promise<AvatarProviderAdapterState>;
  perform(action: AvatarAction, input: { readingId?: string }): Promise<void>;
  mediaOutput(): AvatarStageMedia;
  disconnect(): Promise<void>;
  getState(): AvatarProviderAdapterState;
  health(): AdapterHealth;
}

/**
 * Deterministic local simulation of the avatar provider contract. It exercises
 * the exact same lifecycle the runtime will use with a real vendor and reports
 * "适配层完成，供应商待接入" until a vendor is actually selected and verified.
 */
export class LocalMockAvatarProviderAdapter implements AvatarProviderAdapter {
  readonly id = 'avatar-provider';
  readonly vendorId = 'local-mock';
  readonly vendorLabel = '本地模拟适配器';
  private state: AvatarProviderAdapterState = {
    vendorId: this.vendorId,
    vendorLabel: this.vendorLabel,
    vendorSelected: false,
    status: 'NOT_CONFIGURED',
    connected: false,
    sessionActive: false,
    capabilities: {
      sessionLifecycle: true,
      stageActions: true,
      realtimeAudio: false,
      lipSync: false,
      greenScreenOutput: false,
      mediaStreamOutput: false,
    },
    media: { kind: 'STATIC' },
    lastAction: undefined,
    lastError: undefined,
    checkedAt: Date.now(),
  };
  private readonly actionLog: Array<{ action: AvatarAction; readingId?: string; at: number }> = [];

  async connect(): Promise<AvatarProviderAdapterState> {
    this.state = {
      ...this.state,
      status: 'READY',
      connected: true,
      sessionActive: false,
      lastError: undefined,
      checkedAt: Date.now(),
    };
    return this.getState();
  }

  async detectCapabilities(): Promise<AvatarProviderAdapterState['capabilities']> {
    this.state = { ...this.state, capabilities: this.state.capabilities, checkedAt: Date.now() };
    return { ...this.state.capabilities };
  }

  async createSession(input: { note?: string } = {}): Promise<AvatarProviderAdapterState> {
    if (!this.state.connected) throw new Error('AVATAR_PROVIDER_NOT_CONNECTED');
    this.state = {
      ...this.state,
      status: 'READY',
      sessionActive: true,
      sessionId: `avatar-mock-session-${Date.now()}`,
      lastError: undefined,
      checkedAt: Date.now(),
    };
    return this.getState();
  }

  async perform(action: AvatarAction, input: { readingId?: string } = {}): Promise<void> {
    if (!this.state.connected) throw new Error('AVATAR_PROVIDER_NOT_CONNECTED');
    this.actionLog.push({ action, readingId: input.readingId, at: Date.now() });
    this.state = { ...this.state, lastAction: action, checkedAt: Date.now() };
  }

  mediaOutput(): AvatarStageMedia {
    return { kind: 'STATIC' };
  }

  async disconnect(): Promise<void> {
    this.state = {
      ...this.state,
      status: 'NOT_CONFIGURED',
      connected: false,
      sessionActive: false,
      sessionId: undefined,
      checkedAt: Date.now(),
    };
  }

  getState(): AvatarProviderAdapterState {
    return structuredClone(this.state);
  }

  recentActions(): Array<{ action: AvatarAction; readingId?: string; at: number }> {
    return [...this.actionLog];
  }

  health(): AdapterHealth {
    return {
      id: this.id,
      label: '数字人供应商适配层',
      status: this.state.connected ? 'READY' : 'NOT_CONFIGURED',
      configured: true,
      message: this.state.connected
        ? '适配层完成 · 本地模拟已连接，可用于全链路联动测试；供应商待接入'
        : '适配层完成，供应商待接入；本地模拟可用于联动测试',
    };
  }
}

export type LocalVrmAvatarAdapterOptions = {
  profileId?: string;
  modelAssetId?: string;
  modelUrl?: string;
};

/** Lightweight browser-rendered VRM provider. Rendering and lip sync happen in
 * the shared stage; this backend adapter owns lifecycle and action state only. */
export class LocalVrmAvatarAdapter implements AvatarProviderAdapter {
  readonly id: string = 'local-vrm-avatar';
  readonly vendorId: string = 'local-vrm';
  readonly vendorLabel: string = '本地透明 VRM 数字人';
  private state: AvatarProviderAdapterState;

  constructor(private options: LocalVrmAvatarAdapterOptions = {}) {
    this.state = this.createState();
  }

  configure(options: LocalVrmAvatarAdapterOptions): void {
    this.options = { ...options };
    const configured = Boolean(options.modelUrl);
    this.state = { ...this.state, media: this.mediaOutput(), vendorSelected: configured, connected: configured, status: configured ? 'READY' : 'NOT_CONFIGURED', checkedAt: Date.now() };
  }

  private createState(): AvatarProviderAdapterState {
    return {
      vendorId: this.vendorId,
      vendorLabel: this.vendorLabel,
      vendorSelected: Boolean(this.options.modelUrl),
      status: this.options.modelUrl ? 'READY' : 'NOT_CONFIGURED',
      connected: Boolean(this.options.modelUrl),
      sessionActive: false,
      capabilities: {
        sessionLifecycle: true,
        stageActions: true,
        realtimeAudio: false,
        lipSync: true,
        greenScreenOutput: false,
        mediaStreamOutput: true,
      },
      media: this.mediaOutput(),
      checkedAt: Date.now(),
    };
  }

  async connect(): Promise<AvatarProviderAdapterState> {
    const configured = Boolean(this.options.modelUrl);
    this.state = { ...this.state, vendorSelected: configured, connected: configured, status: configured ? 'READY' : 'NOT_CONFIGURED', media: this.mediaOutput(), lastError: configured ? undefined : 'VRM_MODEL_NOT_SELECTED', checkedAt: Date.now() };
    return this.getState();
  }
  async detectCapabilities() { return { ...this.state.capabilities }; }
  async createSession(): Promise<AvatarProviderAdapterState> {
    if (!this.state.connected) throw new Error('VRM_MODEL_NOT_SELECTED');
    this.state = { ...this.state, sessionActive: true, sessionId: `vrm-${Date.now()}`, checkedAt: Date.now() };
    return this.getState();
  }
  async perform(action: AvatarAction, _input: { readingId?: string }): Promise<void> {
    if (!this.state.connected) throw new Error('VRM_MODEL_NOT_SELECTED');
    this.state = { ...this.state, lastAction: action, checkedAt: Date.now() };
  }
  mediaOutput(): AvatarStageMedia {
    if (!this.options.modelUrl) return { kind: 'STATIC' };
    return { kind: 'VRM', url: this.options.modelUrl, modelAssetId: this.options.modelAssetId, profileId: this.options.profileId, label: '透明 VRM', muted: true };
  }
  async disconnect(): Promise<void> { this.state = { ...this.state, connected: false, sessionActive: false, sessionId: undefined, checkedAt: Date.now() }; }
  getState(): AvatarProviderAdapterState { return structuredClone({ ...this.state, media: this.mediaOutput() }); }
  health(): AdapterHealth {
    const configured = Boolean(this.options.modelUrl);
    return { id: this.id, label: this.vendorLabel, status: configured ? 'READY' : 'NOT_CONFIGURED', configured, message: configured ? 'VRM 模型已就绪，浏览器保持静音并由统一音频总线播报' : '请选择已发布的 VRM 角色模型' };
  }
}

export type VoiceAccentTtsAdapterOptions = {
  baseUrl: string;
  voices: GptSoVitsVoice[];
  outputDirectory: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Local target-country voice engine. This adapter is intentionally separate
 * from GPT-SoVITS: a missing accent service is a hard failure, never a reason
 * to silently emit the original-language voice.
 */
export class VoiceAccentTtsAdapter implements TtsAdapter {
  readonly id = 'openvoice-accent-tts';
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: VoiceAccentTtsAdapterOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async synthesize(input: { readingId: string; text: string; voiceId: string; speed: number; locale: string; targetSeconds?: number; targetLocale?: string; targetCountry?: string; accentProfileId?: string; sourceLanguage?: string }): Promise<TtsResult> {
    const targetLocale = input.targetLocale ?? input.locale;
    if (!input.accentProfileId) throw new Error('VOICE_ACCENT_PROFILE_REQUIRED');
    if (!input.text.trim()) throw new Error('VOICE_ACCENT_TEXT_REQUIRED');
    const voice = this.options.voices.find((item) => item.id === input.voiceId);
    if (!voice?.refAudioPath) throw new Error('VOICE_REFERENCE_AUDIO_MISSING');
    await mkdir(this.options.outputDirectory, { recursive: true });
    const fileName = `${basename(input.readingId).replace(/[^a-zA-Z0-9_-]/g, '') || 'reading'}-${Date.now()}-accent.wav`;
    const outputPath = join(this.options.outputDirectory, fileName);
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl.replace(/\/+$/, '')}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
        body: JSON.stringify({
          reference_audio_path: voice.refAudioPath,
          reference_text: voice.refText,
          reference_language: voice.sourceLanguage ?? voice.refLanguage,
          voice_id: input.voiceId,
          text: input.text,
          source_language: input.sourceLanguage,
          target_locale: targetLocale,
          target_country: input.targetCountry,
          accent_profile_id: input.accentProfileId,
          speed: Math.max(0.6, Math.min(1.6, input.speed || 1)),
          output_path: outputPath,
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error('ACCENT_ENGINE_TIMEOUT');
      throw new Error(`ACCENT_ENGINE_NOT_READY:${error instanceof Error ? error.message : 'service unreachable'}`);
    }
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; output_path?: string; duration_ms?: number; target_locale?: string; engine?: string; elapsed_ms?: number; quality?: Record<string, string | number | boolean>; error?: string; detail?: string };
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error || payload.detail || `ACCENT_ENGINE_HTTP_${response.status}`);
    }
    if (payload.target_locale !== targetLocale) throw new Error('ACCENT_TARGET_LOCALE_MISMATCH');
    const audio = await readFile(outputPath).catch(() => Buffer.alloc(0));
    if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new Error('ACCENT_OUTPUT_NOT_WAV');
    const durationMs = wavDuration(audio);
    if (!durationMs) throw new Error('ACCENT_DURATION_UNKNOWN');
    return {
      audioPath: `/api/audio/${encodeURIComponent(fileName)}`,
      durationMs: payload.duration_ms || durationMs,
      providerId: this.id,
      targetLocale: targetLocale as TtsResult['targetLocale'],
      engineVersion: payload.engine || 'openvoice-v2',
      processingMs: payload.elapsed_ms,
      quality: payload.quality,
    };
  }

  health(): AdapterHealth {
    const configured = Boolean(this.options.baseUrl.trim());
    return {
      id: this.id,
      label: 'OpenVoice 本地目标口音',
      status: configured ? 'DEGRADED' : 'NOT_CONFIGURED',
      configured,
      message: configured ? '等待本地 CUDA 口音服务健康检查与试听验证' : '未配置本地目标口音服务',
    };
  }
}

export type CloudVoiceCloneAdapterOptions = {
  id: string;
  label: string;
  config: VoiceCloudProviderConfig;
  apiKey: string;
  outputDirectory: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

type CloudJson = Record<string, unknown>;

function cloudUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const suffix = path.trim();
  if (!base || !suffix) throw new Error('CLOUD_PROVIDER_ENDPOINT_REQUIRED');
  return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function cloudAuthHeaders(config: VoiceCloudProviderConfig | AvatarCloudProviderConfig, apiKey: string, appId?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json;charset=utf-8' };
  if (config.protocol === 'BAIDU_XILING') {
    const effectiveAppId = appId?.trim();
    if (!effectiveAppId) throw new Error('BAIDU_XILING_APP_ID_REQUIRED');
    if (!apiKey.trim()) throw new Error('BAIDU_XILING_APP_KEY_REQUIRED');
    const expireTime = new Date(Date.now() + 55 * 60_000).toISOString();
    const signature = createHmac('sha256', apiKey.trim()).update(effectiveAppId + expireTime).digest('hex');
    headers.authorization = `${effectiveAppId}/${signature}/${expireTime}`;
  } else if (config.protocol !== 'ALIYUN_AVATAR_OPENAPI' && apiKey.trim()) {
    headers.authorization = `Bearer ${apiKey.trim()}`;
    if (appId?.trim()) headers['x-app-id'] = appId.trim();
  }
  return headers;
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function flattenRpcFields(value: unknown, prefix: string, target: Record<string, string>): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) flattenRpcFields(child, prefix ? `${prefix}.${key}` : key, target);
    return;
  }
  target[prefix] = String(value);
}

function aliyunCredentials(config: AvatarCloudProviderConfig, apiKey: string): { accessKeyId: string; accessKeySecret: string } {
  try {
    const parsed = JSON.parse(apiKey) as { accessKeyId?: string; accessKeySecret?: string };
    if (parsed.accessKeyId?.trim() && parsed.accessKeySecret?.trim()) return { accessKeyId: parsed.accessKeyId.trim(), accessKeySecret: parsed.accessKeySecret.trim() };
  } catch { /* The environment may provide the two values separately. */ }
  const accessKeyId = config.accessKeyIdEnv ? process.env[config.accessKeyIdEnv]?.trim() : '';
  const accessKeySecret = config.accessKeySecretEnv ? process.env[config.accessKeySecretEnv]?.trim() : apiKey.trim();
  if (!accessKeyId || !accessKeySecret) throw new Error('ALIYUN_AVATAR_ACCESS_KEY_REQUIRED');
  return { accessKeyId, accessKeySecret };
}

function aliyunRpcUrl(baseUrl: string, path: string, config: AvatarCloudProviderConfig, apiKey: string, method: 'GET' | 'POST', fields: CloudJson = {}): string {
  const credentials = aliyunCredentials(config, apiKey);
  const parsed = new URL(cloudUrl(baseUrl, path));
  const params: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => { if (key !== 'Signature') params[key] = value; });
  const action = params.Action || 'StartInstance';
  params.Action = action;
  params.Version ||= '2022-01-30';
  params.Format ||= 'JSON';
  params.SignatureMethod = 'HMAC-SHA1';
  params.SignatureVersion = '1.0';
  params.SignatureNonce = randomUUID();
  params.Timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (config.region) params.RegionId ||= config.region;
  params.AccessKeyId = credentials.accessKeyId;
  flattenRpcFields(fields, '', params);
  const canonical = Object.keys(params).sort().map((key) => `${rfc3986(key)}=${rfc3986(params[key])}`).join('&');
  const stringToSign = `${method}&%2F&${rfc3986(canonical)}`;
  params.Signature = createHmac('sha1', `${credentials.accessKeySecret}&`).update(stringToSign).digest('base64');
  return `${parsed.origin}${parsed.pathname}?${Object.keys(params).sort().map((key) => `${rfc3986(key)}=${rfc3986(params[key])}`).join('&')}`;
}

function appendCloudQuery(path: string, query: Record<string, string | number | boolean | undefined>): string {
  const separator = path.includes('?') ? '&' : '?';
  const values = Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return values.length ? `${path}${separator}${values.join('&')}` : path;
}

function firstCloudString(payload: CloudJson, keys: string[]): string | undefined {
  const candidates: unknown[] = keys.flatMap((key) => {
    const direct = payload[key];
    const data = typeof payload.data === 'object' && payload.data ? (payload.data as CloudJson)[key] : undefined;
    const output = typeof payload.output === 'object' && payload.output ? (payload.output as CloudJson)[key] : undefined;
    const result = typeof payload.result === 'object' && payload.result ? (payload.result as CloudJson)[key] : undefined;
    const aliData = typeof payload.Data === 'object' && payload.Data ? (payload.Data as CloudJson)[key] : undefined;
    return [direct, data, output, result, aliData];
  });
  return candidates.find((item): item is string => typeof item === 'string' && item.trim().length > 0)?.trim();
}

function cloudLocaleLanguage(locale: string): string {
  if (locale === 'yue-HK') return 'Chinese,Yue';
  if (locale.startsWith('en-')) return 'English';
  if (locale.startsWith('ja-')) return 'Japanese';
  if (locale.startsWith('ko-')) return 'Korean';
  if (locale.startsWith('es-')) return 'Spanish';
  if (locale.startsWith('fr-')) return 'French';
  return 'Chinese';
}

function toBaiduPcm16Mono(wav: Buffer): Buffer {
  const info = waveInfo(wav);
  if (!info || info.bitsPerSample !== 16 || !info.channels || !info.sampleRate) throw new Error('BAIDU_AUDIO_FORMAT_UNSUPPORTED');
  const source = wav.subarray(info.dataOffset, info.dataOffset + info.dataSize);
  const sourceFrames = Math.floor(source.length / (info.channels * 2));
  const targetFrames = Math.max(1, Math.round(sourceFrames * 16_000 / info.sampleRate));
  const pcm = Buffer.alloc(targetFrames * 2);
  for (let target = 0; target < targetFrames; target += 1) {
    const sourcePosition = target * (sourceFrames - 1) / Math.max(1, targetFrames - 1);
    const left = Math.floor(sourcePosition);
    const right = Math.min(sourceFrames - 1, left + 1);
    const ratio = sourcePosition - left;
    let mixed = 0;
    for (let channel = 0; channel < info.channels; channel += 1) {
      const leftOffset = (left * info.channels + channel) * 2;
      const rightOffset = (right * info.channels + channel) * 2;
      mixed += source.readInt16LE(leftOffset) * (1 - ratio) + source.readInt16LE(rightOffset) * ratio;
    }
    mixed /= info.channels;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mixed))), target * 2);
  }
  return pcm;
}

function baiduWebSocketToken(appId: string, appKey: string): { signature: string; expireTime: string } {
  if (!appId.trim()) throw new Error('BAIDU_XILING_APP_ID_REQUIRED');
  if (!appKey.trim()) throw new Error('BAIDU_XILING_APP_KEY_REQUIRED');
  const expireTime = new Date(Date.now() + 55 * 60_000).toISOString();
  const signature = createHmac('sha256', appKey.trim()).update(appId.trim() + expireTime).digest('hex');
  return { signature, expireTime };
}

async function readCloudResponse(response: Response): Promise<{ payload?: CloudJson; bytes?: Buffer }> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('audio/') || contentType.includes('application/octet-stream') || contentType.includes('video/')) {
    return { bytes: Buffer.from(await response.arrayBuffer()) };
  }
  return { payload: await response.json().catch(() => ({})) as CloudJson };
}

function cloudAudioMimeType(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.m4a') return 'audio/mp4';
  return 'audio/wav';
}

function qwenPreferredName(name: string): string {
  const normalized = name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^[_-]+|[_-]+$/g, '');
  return (normalized || `meihua_${Date.now()}`).slice(0, 16);
}

function aliyunQwenBaseUrl(config: VoiceCloudProviderConfig): string {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const workspaceId = config.workspaceId?.trim();
  if (!workspaceId) return baseUrl;
  try {
    const parsed = new URL(baseUrl);
    if (/^dashscope(?:-intl)?\.aliyuncs\.com$/i.test(parsed.hostname)) {
      const region = config.region === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing';
      return `${parsed.protocol}//${workspaceId}.${region}.maas.aliyuncs.com`;
    }
  } catch { /* The regular cloudUrl validation will report an invalid URL. */ }
  return baseUrl;
}

function wavFromPcm16(pcm: Buffer, sampleRate = 24_000, channels = 1): Buffer {
  const safePcm = pcm.subarray(0, pcm.length - (pcm.length % 2));
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + safePcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(safePcm.length, 40);
  return Buffer.concat([header, safePcm]);
}

/** Collects audio chunks from both DashScope SSE shapes: OpenAI-compatible
 * delta.audio.data and the native Omni message.content[].audio.data shape. */
function collectQwenAudio(value: unknown, target: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectQwenAudio(item, target));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'audio') {
      if (typeof child === 'string' && child.trim()) target.push(child.trim());
      else if (child && typeof child === 'object') {
        const data = (child as CloudJson).data;
        if (typeof data === 'string' && data.trim()) target.push(data.trim());
      }
    }
    collectQwenAudio(child, target);
  }
}

function qwenAudioFromSse(body: string): Buffer | undefined {
  const chunks: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    try { collectQwenAudio(JSON.parse(data), chunks); } catch { /* Ignore keep-alive/non-JSON SSE lines. */ }
  }
  if (!chunks.length) return undefined;
  try {
    const audio = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
    return audio.toString('ascii', 0, 4) === 'RIFF' ? audio : wavFromPcm16(audio);
  } catch { return undefined; }
}

async function readQwenAudioResponse(response: Response): Promise<{ payload?: CloudJson; bytes?: Buffer }> {
  const body = await response.text();
  if (!response.ok) {
    let payload: CloudJson = {};
    try { payload = JSON.parse(body) as CloudJson; } catch { /* Preserve the HTTP error below. */ }
    return { payload };
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
    return { bytes: Buffer.from(body, 'binary') };
  }
  const streamed = qwenAudioFromSse(body);
  if (streamed) return { bytes: streamed };
  try {
    const payload = JSON.parse(body) as CloudJson;
    const chunks: string[] = [];
    collectQwenAudio(payload, chunks);
    if (chunks.length) {
      const audio = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
      return { payload, bytes: audio.toString('ascii', 0, 4) === 'RIFF' ? audio : wavFromPcm16(audio) };
    }
    return { payload };
  } catch { return { payload: {} }; }
}

/**
 * Common cloud voice contract. It deliberately does not fabricate a provider
 * voice id: the configured endpoint must return one, otherwise the job fails
 * and the profile stays unusable.
 */
export class CloudVoiceCloneAdapter implements TtsAdapter {
  readonly id: string;
  private readonly fetcher: typeof fetch;
  private readonly options: CloudVoiceCloneAdapterOptions;

  constructor(options: CloudVoiceCloneAdapterOptions) {
    this.options = options;
    this.id = options.id;
    this.fetcher = options.fetcher ?? fetch;
  }

  async clone(input: { name: string; audio: Buffer; fileName: string; referenceText?: string; sourceLanguage?: string; targetLocale?: string; targetCountry?: string }): Promise<{ providerCloneId: string; engineVersion?: string }> {
    if (!this.options.apiKey.trim()) throw new Error('CLOUD_VOICE_API_KEY_REQUIRED');
    if (!input.audio.length) throw new Error('VOICE_AUDIO_REQUIRED');
    const config = this.options.config;
    let response: Response;
    if (config.protocol === 'ALIYUN_QWEN_OMNI') {
      const targetModel = config.targetModel.trim();
      if (!['qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3.5-omni-plus', 'qwen3.5-omni-flash'].includes(targetModel)) {
        throw new Error(`ALIYUN_QWEN_TARGET_MODEL_UNSUPPORTED:${targetModel || 'empty'}`);
      }
      const audioMimeType = cloudAudioMimeType(input.fileName);
      const dataUri = `data:${audioMimeType};base64,${input.audio.toString('base64')}`;
      const enrollmentInput: CloudJson = {
        action: 'create',
        target_model: targetModel,
        preferred_name: qwenPreferredName(input.name),
        audio: { data: dataUri },
        ...(input.referenceText?.trim() ? { text: input.referenceText.trim().slice(0, 2_000) } : {}),
        ...(input.sourceLanguage?.trim() ? { language: input.sourceLanguage.trim().split('-')[0] } : {}),
      };
      response = await this.fetcher(cloudUrl(aliyunQwenBaseUrl(config), config.clonePath), {
        method: 'POST',
        headers: cloudAuthHeaders(config, this.options.apiKey, config.appId),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
        body: JSON.stringify({ model: 'qwen-voice-enrollment', input: enrollmentInput }),
      });
    } else if (config.protocol === 'ALIYUN_DASHSCOPE') {
      if (config.model === 'voice-enrollment' && !config.publicBaseUrl?.trim()) throw new Error('CLOUD_VOICE_PUBLIC_URL_REQUIRED');
      await mkdir(this.options.outputDirectory, { recursive: true });
      const extension = extname(basename(input.fileName)).toLowerCase() || '.wav';
      const sampleFileName = `voice-sample-${randomUUID()}${extension.replace(/[^a-z0-9.]/g, '')}`;
      await writeFile(join(this.options.outputDirectory, sampleFileName), input.audio);
      const sampleUrl = config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/+$/, '')}/api/public-audio/${encodeURIComponent(sampleFileName)}` : undefined;
      const isQwenEnrollment = config.model === 'qwen-voice-enrollment';
      const enrollmentInput: CloudJson = isQwenEnrollment
        ? { action: 'create', preferred_name: input.name, audio: `data:audio/wav;base64,${input.audio.toString('base64')}`, text: input.referenceText, language_hints: input.sourceLanguage ? [input.sourceLanguage] : undefined }
        : { action: 'create_voice', target_model: config.targetModel, prefix: `mh${randomUUID().replace(/-/g, '').slice(0, 12)}`, url: sampleUrl, language_hints: input.sourceLanguage ? [input.sourceLanguage] : undefined };
      response = await this.fetcher(cloudUrl(config.baseUrl, config.clonePath), {
        method: 'POST',
        headers: cloudAuthHeaders(config, this.options.apiKey, config.appId),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
        body: JSON.stringify({ model: config.model, input: enrollmentInput, ...(config.workspaceId ? { workspace: config.workspaceId } : {}) }),
      });
    } else if (config.protocol === 'BAIDU_XILING') {
      if (!config.appId?.trim()) throw new Error('BAIDU_XILING_APP_ID_REQUIRED');
      if (!input.referenceText?.trim()) throw new Error('VOICE_REFERENCE_TEXT_REQUIRED');
      if (input.targetLocale && input.targetLocale !== 'zh-CN') throw new Error(`VOICE_TARGET_UNSUPPORTED:baidu-xiling:${input.targetLocale}`);
      if (input.audio.length > 20 * 1024 * 1024) throw new Error('BAIDU_VOICE_SAMPLE_TOO_LARGE');
      const duration = wavDuration(input.audio);
      if (duration && duration < 30_000) throw new Error('BAIDU_VOICE_SAMPLE_TOO_SHORT');
      if (duration && duration > 5 * 60_000) throw new Error('BAIDU_VOICE_SAMPLE_TOO_LONG');
      const uploadUrl = cloudUrl(config.baseUrl, config.uploadPath || '/api/digitalhuman/open/v1/file/upload');
      const form = new FormData();
      form.append('file', new Blob([input.audio]), basename(input.fileName) || 'voice.wav');
      const uploadResponse = await this.fetcher(appendCloudQuery(uploadUrl, { providerType: config.uploadProviderType || 'OPEN_TTS_CLONE', sourceFileName: basename(input.fileName) || 'voice.wav' }), {
        method: 'POST', headers: (() => { const headers = cloudAuthHeaders(config, this.options.apiKey, config.appId); delete headers['content-type']; return headers; })(), signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000), body: form,
      });
      const uploadResult = await readCloudResponse(uploadResponse);
      if (!uploadResponse.ok) throw new Error(`${this.id.toUpperCase()}_VOICE_UPLOAD_HTTP_${uploadResponse.status}:${JSON.stringify(uploadResult.payload ?? {}).slice(0, 300)}`);
      const uploadAudioId = firstCloudString(uploadResult.payload ?? {}, ['fileId', 'file_id', 'uploadAudioId', 'upload_audio_id']);
      if (!uploadAudioId) throw new Error('BAIDU_VOICE_UPLOAD_ID_MISSING');
      response = await this.fetcher(cloudUrl(config.baseUrl, config.clonePath || '/api/digitalhuman/open/v1/tts/clone/v2'), {
        method: 'POST', headers: cloudAuthHeaders(config, this.options.apiKey, config.appId), signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
        body: JSON.stringify({ requestId: randomUUID(), name: input.name.slice(0, 50), uploadAudioId, exampleText: input.referenceText.slice(0, 100) }),
      });
    } else {
      response = await this.fetcher(cloudUrl(config.baseUrl, config.clonePath), {
        method: 'POST',
        headers: cloudAuthHeaders(config, this.options.apiKey, config.appId),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
        body: JSON.stringify({ model: config.model, target_model: config.targetModel, name: input.name, file_name: input.fileName, audio_base64: input.audio.toString('base64'), reference_text: input.referenceText, source_language: input.sourceLanguage, target_locale: input.targetLocale, target_country: input.targetCountry, ...(config.workspaceId ? { workspace_id: config.workspaceId } : {}) }),
      });
    }
    const result = await readCloudResponse(response);
    if (!response.ok) throw new Error(`${this.id.toUpperCase()}_VOICE_CLONE_HTTP_${response.status}:${JSON.stringify(result.payload ?? {}).slice(0, 300)}`);
    const providerCloneId = firstCloudString(result.payload ?? {}, ['voice_id', 'voiceId', 'voice', 'perId', 'per_id', 'clone_id', 'cloneId', 'task_id', 'taskId']);
    if (!providerCloneId) throw new Error(`${this.id.toUpperCase()}_VOICE_CLONE_ID_MISSING`);
    return { providerCloneId, engineVersion: firstCloudString(result.payload ?? {}, ['engine', 'version', 'model_version']) };
  }

  async synthesize(input: { readingId: string; text: string; voiceId: string; speed: number; locale: string; targetLocale?: string }): Promise<TtsResult> {
    if (!this.options.apiKey.trim()) throw new Error('CLOUD_VOICE_API_KEY_REQUIRED');
    if (!input.text.trim()) throw new Error('CLOUD_VOICE_TEXT_REQUIRED');
    if (!input.voiceId.trim()) throw new Error('CLOUD_VOICE_ID_REQUIRED');
    await mkdir(this.options.outputDirectory, { recursive: true });
    const fileName = `${basename(input.readingId).replace(/[^a-zA-Z0-9_-]/g, '') || 'reading'}-${Date.now()}-${this.id}.wav`;
    const targetLocale = input.targetLocale ?? input.locale;
    let response: Response;
    if (this.options.config.protocol === 'ALIYUN_QWEN_OMNI') {
      const targetModel = this.options.config.targetModel.trim();
      if (!['qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3.5-omni-plus', 'qwen3.5-omni-flash'].includes(targetModel)) {
        throw new Error(`ALIYUN_QWEN_TARGET_MODEL_UNSUPPORTED:${targetModel || 'empty'}`);
      }
      response = await this.fetcher(cloudUrl(aliyunQwenBaseUrl(this.options.config), this.options.config.synthesizePath), {
        method: 'POST',
        headers: { ...cloudAuthHeaders(this.options.config, this.options.apiKey, this.options.config.appId), accept: 'text/event-stream, application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: 'user', content: [{ text: input.text }] }],
          modalities: ['text', 'audio'],
          audio: { voice: input.voiceId, format: 'wav' },
          stream: true,
        }),
      });
    } else if (this.options.config.protocol === 'ALIYUN_DASHSCOPE') {
      response = await this.fetcher(cloudUrl(this.options.config.baseUrl, this.options.config.synthesizePath), {
        method: 'POST',
        headers: { ...cloudAuthHeaders(this.options.config, this.options.apiKey, this.options.config.appId), accept: 'audio/wav,application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        body: JSON.stringify({ model: this.options.config.targetModel, input: { text: input.text, voice: input.voiceId, language_hints: [cloudLocaleLanguage(targetLocale)] }, parameters: { format: 'wav', sample_rate: 16_000, rate: Math.max(0.25, Math.min(4, input.speed || 1)) } }),
      });
    } else if (this.options.config.protocol === 'BAIDU_XILING') {
      const speed = Math.max(0, Math.min(15, Math.round(5 * (input.speed || 1))));
      response = await this.fetcher(cloudUrl(this.options.config.baseUrl, this.options.config.synthesizePath), {
        method: 'POST', headers: cloudAuthHeaders(this.options.config, this.options.apiKey, this.options.config.appId), signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        body: JSON.stringify({ text: input.text, person: input.voiceId, model: this.options.config.targetModel || 'quality_v2', lan: cloudLocaleLanguage(targetLocale), speed, volume: 5, pitch: 5, outputFormat: 'wav', sampleRate: 16_000 }),
      });
    } else {
      response = await this.fetcher(cloudUrl(this.options.config.baseUrl, this.options.config.synthesizePath), {
        method: 'POST', headers: { ...cloudAuthHeaders(this.options.config, this.options.apiKey, this.options.config.appId), accept: 'audio/wav,application/json' }, signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        body: JSON.stringify({ model: this.options.config.targetModel || this.options.config.model, voice: input.voiceId, voice_id: input.voiceId, text: input.text, locale: targetLocale, target_locale: targetLocale, speed: Math.max(0.25, Math.min(4, input.speed || 1)) }),
      });
    }
    let result = this.options.config.protocol === 'ALIYUN_QWEN_OMNI'
      ? await readQwenAudioResponse(response)
      : await readCloudResponse(response);
    if (!response.ok) throw new Error(`${this.id.toUpperCase()}_TTS_HTTP_${response.status}:${JSON.stringify(result.payload ?? {}).slice(0, 300)}`);
    if (this.options.config.protocol === 'BAIDU_XILING' && !result.bytes) {
      const taskId = firstCloudString(result.payload ?? {}, ['taskId', 'task_id']);
      if (!taskId) throw new Error('BAIDU_TTS_TASK_ID_MISSING');
      const statusPath = this.options.config.synthesizeStatusPath || '/api/digitalhuman/open/v1/tts/text2audio/task';
      const deadline = Date.now() + (this.options.timeoutMs ?? 60_000);
      let statusPayload: CloudJson = result.payload ?? {};
      while (Date.now() < deadline) {
        const statusResponse = await this.fetcher(appendCloudQuery(cloudUrl(this.options.config.baseUrl, statusPath), { taskId }), { method: 'GET', headers: cloudAuthHeaders(this.options.config, this.options.apiKey, this.options.config.appId), signal: AbortSignal.timeout(Math.min(15_000, Math.max(1_000, deadline - Date.now()))) });
        const statusResult = await readCloudResponse(statusResponse);
        statusPayload = statusResult.payload ?? {};
        const status = (firstCloudString(statusPayload, ['status']) || '').toUpperCase();
        if (status === 'SUCCESS') { result = statusResult; break; }
        if (status === 'FAILED') throw new Error(`BAIDU_TTS_FAILED:${firstCloudString(statusPayload, ['failedMessage', 'message']) || 'provider task failed'}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!result.bytes) {
        const audioUrlFromStatus = firstCloudString(statusPayload, ['audioUrl', 'audio_url', 'url']);
        if (audioUrlFromStatus) result = { payload: { ...statusPayload, audio_url: audioUrlFromStatus } };
        else throw new Error('BAIDU_TTS_TIMEOUT');
      }
    }
    let audio = result.bytes;
    const payload = result.payload ?? {};
    const audioBase64 = firstCloudString(payload, ['audio_base64', 'audioBase64', 'wav_base64', 'wavBase64', 'audio']);
    if (!audio && audioBase64) {
      try { audio = Buffer.from(audioBase64, 'base64'); } catch { audio = undefined; }
    }
    const audioContainer = typeof payload.output === 'object' && payload.output
      ? (payload.output as CloudJson).audio
      : undefined;
    const audioUrl = firstCloudString(payload, ['audio_url', 'audioUrl', 'url', 'download_url'])
      ?? (audioContainer && typeof audioContainer === 'object' ? firstCloudString(audioContainer as CloudJson, ['audio_url', 'audioUrl', 'url', 'download_url']) : undefined);
    if (!audio && audioUrl) {
      const downloaded = await this.fetcher(audioUrl, { headers: cloudAuthHeaders(this.options.config, this.options.apiKey, this.options.config.appId), signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000) });
      if (downloaded.ok) audio = Buffer.from(await downloaded.arrayBuffer());
    }
    if (!audio || audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${this.id.toUpperCase()}_TTS_RESPONSE_NOT_WAV`);
    const durationMs = wavDuration(audio);
    if (!durationMs) throw new Error(`${this.id.toUpperCase()}_TTS_DURATION_UNKNOWN`);
    await writeFile(join(this.options.outputDirectory, fileName), audio);
    return { audioPath: `/api/audio/${encodeURIComponent(fileName)}`, durationMs, providerId: this.id, targetLocale: targetLocale as TtsResult['targetLocale'], engineVersion: firstCloudString(payload, ['engine', 'version', 'model_version']) };
  }

  async synthesizeTts(input: Parameters<CloudVoiceCloneAdapter['synthesize']>[0]): Promise<TtsResult> {
    return this.synthesize(input);
  }

  health(): AdapterHealth {
    const configured = Boolean(this.options.config.baseUrl.trim() && this.options.config.clonePath.trim() && this.options.config.synthesizePath.trim() && this.options.apiKey.trim());
    return { id: this.id, label: this.options.label, status: configured ? 'DEGRADED' : 'NOT_CONFIGURED', configured, message: configured ? '云端接口已配置，需完成真实克隆与 WAV 试听验证' : '需要云端地址、克隆路径、合成路径和 API 凭证' };
  }
}

export type CloudAvatarProviderAdapterOptions = {
  id: string;
  vendorId: string;
  vendorLabel: string;
  config: AvatarCloudProviderConfig;
  apiKey: string;
  outputDirectory?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

/**
 * HTTP stream adapter for Alibaba/Baidu cloud avatars. The provider endpoint
 * is responsible for actual realtime rendering and returns a playable stream
 * URL (or an RTC URL). The orchestrator never reports READY without that URL.
 */
export class CloudAvatarProviderAdapter implements AvatarProviderAdapter {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorLabel: string;
  private readonly options: CloudAvatarProviderAdapterOptions;
  private readonly fetcher: typeof fetch;
  private state: AvatarProviderAdapterState;

  constructor(options: CloudAvatarProviderAdapterOptions) {
    this.options = options;
    this.id = options.id;
    this.vendorId = options.vendorId;
    this.vendorLabel = options.vendorLabel;
    this.fetcher = options.fetcher ?? fetch;
    this.state = this.createState();
  }

  private createState(): AvatarProviderAdapterState {
    return { vendorId: this.vendorId, vendorLabel: this.vendorLabel, vendorSelected: Boolean(this.options.config.baseUrl), status: 'NOT_CONFIGURED', connected: false, sessionActive: false, capabilities: { sessionLifecycle: true, stageActions: false, realtimeAudio: false, lipSync: true, greenScreenOutput: false, mediaStreamOutput: true }, media: { kind: this.options.config.streamMode === 'RTC' ? 'WEBRTC' : 'VIDEO_URL', label: this.vendorLabel, muted: true }, checkedAt: Date.now() };
  }

  private async call(path: string, body?: CloudJson, method?: 'GET' | 'POST' | 'DELETE'): Promise<{ payload: CloudJson; response: Response }> {
    const requestMethod = method ?? (body ? 'POST' : 'GET');
    const aliyun = this.options.config.protocol === 'ALIYUN_AVATAR_OPENAPI';
    const response = await this.fetcher(aliyun ? aliyunRpcUrl(this.options.config.baseUrl, path, this.options.config, this.options.apiKey, requestMethod === 'DELETE' ? 'POST' : requestMethod, body) : cloudUrl(this.options.config.baseUrl, path), { method: requestMethod, headers: cloudAuthHeaders(this.options.config, this.options.apiKey, this.options.config.appId), signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000), body: aliyun ? undefined : body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => ({})) as CloudJson;
    return { payload, response };
  }

  async connect(): Promise<AvatarProviderAdapterState> {
    if (!this.options.apiKey.trim() || !this.options.config.baseUrl.trim()) {
      this.state = { ...this.createState(), vendorSelected: true, lastError: 'CLOUD_AVATAR_CREDENTIALS_REQUIRED', checkedAt: Date.now() };
      return this.getState();
    }
    try {
      const probePath = this.options.config.healthPath || (this.options.config.protocol === 'BAIDU_XILING' ? '/api/digitalhuman/open/v1/figure/lite2d/query?systemFigure=true&pageSize=1' : this.options.config.renderPath);
      const official = this.options.config.protocol === 'BAIDU_XILING' || this.options.config.protocol === 'ALIYUN_AVATAR_OPENAPI';
      const probe = await this.call(probePath, official ? undefined : { action: 'health_check', model: this.options.config.model });
      if (!probe.response.ok) throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_HTTP_${probe.response.status}`);
      this.state = { ...this.state, status: 'READY', connected: true, vendorSelected: true, lastError: undefined, checkedAt: Date.now() };
    } catch (error) {
      this.state = { ...this.createState(), vendorSelected: true, lastError: error instanceof Error ? error.message : 'CLOUD_AVATAR_UNREACHABLE', checkedAt: Date.now() };
    }
    return this.getState();
  }

  async detectCapabilities(): Promise<AvatarProviderAdapterState['capabilities']> { return { ...this.state.capabilities }; }

  async createSession(input: { note?: string } = {}): Promise<AvatarProviderAdapterState> {
    if (!this.state.connected) await this.connect();
    if (!this.state.connected) throw new Error(this.state.lastError ?? 'CLOUD_AVATAR_NOT_READY');
    this.state = { ...this.state, sessionActive: true, sessionId: `${this.vendorId}-${Date.now()}`, checkedAt: Date.now() };
    return this.getState();
  }

  async perform(action: AvatarAction, _input: { readingId?: string } = {}): Promise<void> {
    if (!this.state.connected) await this.connect();
    if (!this.state.connected) throw new Error(this.state.lastError ?? 'CLOUD_AVATAR_NOT_READY');
    this.state = { ...this.state, lastAction: action, checkedAt: Date.now() };
  }

  async clone(input: { name: string; videoPath: string; authorizationConfirmed: boolean }): Promise<{ cloudFigureId: string; streamUrl?: string; engineVersion?: string }> {
    if (!input.authorizationConfirmed) throw new Error('AVATAR_AUTHORIZATION_REQUIRED');
    if (!this.state.connected) await this.connect();
    if (!this.state.connected) throw new Error(this.state.lastError ?? 'CLOUD_AVATAR_NOT_READY');
    const video = await readFile(input.videoPath);
    let payload: CloudJson;
    let response: Response;
    if (this.options.config.protocol === 'BAIDU_XILING') {
      if (!this.options.config.appId?.trim()) throw new Error('BAIDU_XILING_APP_ID_REQUIRED');
      const form = new FormData();
      form.append('file', new Blob([video]), basename(input.videoPath) || 'avatar.mp4');
      const uploadResponse = await this.fetcher(appendCloudQuery(cloudUrl(this.options.config.baseUrl, this.options.config.uploadPath || '/api/digitalhuman/open/v1/file/upload'), { providerType: this.options.config.uploadProviderType || 'OPEN_CUSTOMIZATION_2D_GENERAL', sourceFileName: basename(input.videoPath) || 'avatar.mp4' }), {
        method: 'POST', headers: (() => { const headers = cloudAuthHeaders(this.options.config, this.options.apiKey, this.options.config.appId); delete headers['content-type']; return headers; })(), signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000), body: form,
      });
      const uploadResult = await readCloudResponse(uploadResponse);
      if (!uploadResponse.ok) throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_UPLOAD_HTTP_${uploadResponse.status}`);
      const templateVideoId = firstCloudString(uploadResult.payload ?? {}, ['fileId', 'file_id', 'templateVideoId', 'template_video_id']);
      if (!templateVideoId) throw new Error('BAIDU_AVATAR_UPLOAD_ID_MISSING');
      const trained = await this.call(this.options.config.clonePath || '/api/digitalhuman/open/v1/figure/lite2d/train', {
        name: input.name.slice(0, 20), customizeType: this.options.config.customizeType || 'LITE_2D_GENERAL', gender: this.options.config.gender || 'UNKNOWN', keepBackground: this.options.config.keepBackground === true, templateVideoId,
      });
      payload = trained.payload;
      response = trained.response;
    } else if (this.options.config.protocol === 'ALIYUN_AVATAR_OPENAPI') {
      if (!this.options.config.tenantId?.trim()) throw new Error('ALIYUN_AVATAR_TENANT_ID_REQUIRED');
      if (!this.options.config.publicBaseUrl?.trim()) throw new Error('CLOUD_AVATAR_PUBLIC_URL_REQUIRED');
      if (!this.options.config.portraitUrl?.trim()) throw new Error('ALIYUN_AVATAR_PORTRAIT_URL_REQUIRED');
      if (!this.options.outputDirectory) throw new Error('CLOUD_AVATAR_OUTPUT_DIRECTORY_REQUIRED');
      await mkdir(join(this.options.outputDirectory, 'cloud-assets'), { recursive: true });
      const fileName = `avatar-sample-${randomUUID()}${extname(basename(input.videoPath)).toLowerCase() || '.mp4'}`;
      await writeFile(join(this.options.outputDirectory, 'cloud-assets', fileName), video);
      const videoUrl = `${this.options.config.publicBaseUrl.replace(/\/+$/, '')}/api/public-media/${encodeURIComponent(fileName)}`;
      const trained = await this.call(this.options.config.clonePath || '/?Action=Create2dAvatar', {
        TenantId: this.options.config.tenantId,
        Name: input.name.slice(0, 50),
        Description: 'Meihua digital human avatar',
        Portrait: this.options.config.portraitUrl,
        Video: videoUrl,
        Transparent: false,
        Orientation: 1,
        Callback: false,
      });
      payload = trained.payload;
      response = trained.response;
    } else {
      const trained = await this.call(this.options.config.clonePath, { model: this.options.config.model, name: input.name, video_base64: video.toString('base64'), authorization_confirmed: true });
      payload = trained.payload;
      response = trained.response;
    }
    if (!response.ok) throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_CLONE_HTTP_${response.status}`);
     const cloudFigureId = firstCloudString(payload, ['figure_id', 'figureId', 'avatar_id', 'avatarId', 'clone_id', 'cloneId', 'task_id', 'taskId', 'Code', 'code']);
    if (!cloudFigureId) throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_CLONE_ID_MISSING`);
    return { cloudFigureId, streamUrl: firstCloudString(payload, ['stream_url', 'streamUrl', 'video_url', 'videoUrl', 'media_url', 'mediaUrl', 'rtc_url', 'rtcUrl']), engineVersion: firstCloudString(payload, ['engine', 'version', 'model_version']) };
  }

  /** Wait for official asynchronous avatar training to finish before the profile can become READY. */
  async waitForClone(figureId: string, timeoutMs = 15 * 60_000): Promise<{ engineVersion?: string }> {
    if (!this.options.config.statusPath) return {};
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const statusResponse = this.options.config.protocol === 'ALIYUN_AVATAR_OPENAPI'
        ? await this.call(this.options.config.statusPath, { Code: figureId }, 'GET')
        : await this.call(appendCloudQuery(this.options.config.statusPath, { figureId }), undefined, 'GET');
      if (!statusResponse.response.ok) throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_STATUS_HTTP_${statusResponse.response.status}`);
      const result = statusResponse.payload.result;
      const row = this.options.config.protocol === 'ALIYUN_AVATAR_OPENAPI' && statusResponse.payload.Data && typeof statusResponse.payload.Data === 'object'
        ? statusResponse.payload.Data
        : Array.isArray(result) ? result.find((item) => item && typeof item === 'object' && String((item as CloudJson).figureId ?? (item as CloudJson).figure_id) === figureId) : result && typeof result === 'object' && Array.isArray((result as CloudJson).result) ? ((result as CloudJson).result as unknown[]).find((item) => item && typeof item === 'object' && String((item as CloudJson).figureId ?? (item as CloudJson).figure_id) === figureId) : result;
      const rowObject = row && typeof row === 'object' ? row as CloudJson : statusResponse.payload;
      const status = this.options.config.protocol === 'ALIYUN_AVATAR_OPENAPI'
        ? String(rowObject.MakeStatus ?? rowObject.makeStatus ?? '').toUpperCase() === '3' ? 'SUCCESS' : String(rowObject.MakeStatus ?? rowObject.makeStatus ?? '').toUpperCase() === '2' ? 'FAILED' : 'GENERATING'
        : String(rowObject.status ?? '').toUpperCase();
      if (status === 'SUCCESS' || status === 'READY') return { engineVersion: firstCloudString(rowObject, ['version', 'model_version', 'engine']) };
      if (status === 'FAILED' || status === 'FAIL') throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_TRAIN_FAILED:${String(rowObject.MakeFailReason ?? rowObject.makeFailReason ?? rowObject.failedMessage ?? rowObject.failed_message ?? rowObject.reason ?? 'provider training failed')}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_TRAIN_TIMEOUT`);
  }

  async render(audioPath: string, readingId: string, avatarId: string, speechText?: string): Promise<{ jobId: string; streamUrl?: string; rtc?: AvatarRtcConnection; durationMs?: number }> {
    if (!this.state.connected) await this.connect();
    if (!this.state.connected) throw new Error(this.state.lastError ?? 'CLOUD_AVATAR_NOT_READY');
    const audio = await readFile(audioPath);
    let payload: CloudJson;
    let response: Response;
    let rtc: AvatarRtcConnection | undefined;
    if (this.options.config.protocol === 'BAIDU_XILING') {
      if (!this.options.config.appId?.trim()) throw new Error('BAIDU_XILING_APP_ID_REQUIRED');
      const roomName = `meihua-${readingId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36) || Date.now()}`;
      const outputMode = this.options.config.streamMode === 'RTC' ? 'BRTC' : 'RTMP';
      const opened = await this.call(this.options.config.renderPath || '/api/digitalhuman/open/v1/liveRooms', {
        liveRoom: roomName, resolution: { width: 1080, height: 1920 },
        elements: [{ type: 'DIGITAL_HUMAN', digitalhuman: { figureId: avatarId, location: { top: 0, left: 0, width: 1080, height: 1920 } } }],
        output: { mode: outputMode }, audioFormat: { sampleRate: 16_000, lan: 'Chinese', model: this.options.config.model || 'quality_v2' },
      });
      payload = opened.payload;
      response = opened.response;
      if (!response.ok) throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_RENDER_HTTP_${response.status}`);
      const room = (payload.result && typeof payload.result === 'object' ? payload.result as CloudJson : payload) as CloudJson;
      const output = room.output && typeof room.output === 'object' ? room.output as CloudJson : {};
      const rtmp = output.rtmp && typeof output.rtmp === 'object' ? output.rtmp as CloudJson : {};
      const brtc = output.brtc && typeof output.brtc === 'object' ? output.brtc as CloudJson : {};
      const streamUrl = (outputMode === 'RTMP' ? rtmp.pullUrl : brtc.previewBrowseUrl) as unknown;
      if (typeof streamUrl !== 'string' || !streamUrl.trim()) throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_STREAM_URL_MISSING`);
      await this.driveBaiduRoom(roomName, audio);
      this.state = { ...this.state, sessionActive: true, sessionId: roomName, checkedAt: Date.now() };
      return { jobId: String(room.sessionId ?? roomName), streamUrl, durationMs: wavDuration(audio) };
    } else if (this.options.config.protocol === 'ALIYUN_AVATAR_OPENAPI') {
      if (!this.options.config.tenantId?.trim()) throw new Error('ALIYUN_AVATAR_TENANT_ID_REQUIRED');
      if (!this.options.config.appId?.trim()) throw new Error('ALIYUN_AVATAR_APP_ID_REQUIRED');
      const sessionUserId = `meihua-${readingId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || Date.now()}`;
      const start = await this.call(this.options.config.renderPath || '/?Action=StartInstance', {
        TenantId: this.options.config.tenantId,
        App: { AppId: this.options.config.appId },
        User: { UserId: sessionUserId, UserName: 'Meihua Live' },
        BizId: readingId.slice(0, 64),
        Channel: { Type: this.options.config.streamMode === 'RTC' ? 'DingRTC' : 'RTMP' },
        ...(speechText?.trim() ? { TextRequest: { CommandType: 'START', SpeechText: speechText.trim().slice(0, 1000), Id: readingId.slice(0, 64), Interrupt: true } } : {}),
      });
      payload = start.payload;
      response = start.response;
      if (!response.ok) throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_RENDER_HTTP_${response.status}`);
      const data = payload.Data && typeof payload.Data === 'object' ? payload.Data as CloudJson : {};
      const channel = data.Channel && typeof data.Channel === 'object' ? data.Channel as CloudJson : {};
      const sessionId = firstCloudString(data, ['SessionId', 'sessionId']) ?? firstCloudString(payload, ['SessionId', 'sessionId']);
      const channelId = firstCloudString(channel, ['ChannelId', 'channelId']);
      const token = firstCloudString(channel, ['Token', 'token']);
      const userId = firstCloudString(channel, ['UserId', 'userId']);
      const appId = firstCloudString(channel, ['AppId', 'appId']) ?? this.options.config.appId;
      const gslbValue = channel.Gslb ?? channel.gslb;
      const gslb = Array.isArray(gslbValue) ? gslbValue.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
      if (sessionId && channelId && token && userId && appId) {
        const expired = channel.ExpiredTime ?? channel.expiredTime;
        rtc = { provider: 'aliyun-avatar', sessionId, channelId, token, userId, appId, userInfoInChannel: firstCloudString(channel, ['UserInfoInChannel', 'userInfoInChannel']), gslb, expiredTime: typeof expired === 'number' ? expired : undefined };
        this.state = { ...this.state, sessionActive: true, sessionId, media: { ...this.state.media, kind: 'WEBRTC', url: undefined, rtc, muted: true }, checkedAt: Date.now() };
      }
    } else {
      const rendered = await this.call(this.options.config.renderPath, { model: this.options.config.model, avatar_id: avatarId, reading_id: readingId, audio_base64: audio.toString('base64'), audio_path: audioPath, stream_mode: this.options.config.streamMode });
      payload = rendered.payload;
      response = rendered.response;
    }
    if (!response.ok) throw new Error(`${this.vendorId.toUpperCase()}_AVATAR_RENDER_HTTP_${response.status}`);
    const streamUrl = firstCloudString(payload, ['stream_url', 'streamUrl', 'video_url', 'videoUrl', 'media_url', 'mediaUrl', 'rtc_url', 'rtcUrl']);
    if (!streamUrl && !rtc) throw new Error(this.options.config.protocol === 'ALIYUN_AVATAR_OPENAPI' ? 'ALIYUN_AVATAR_RTC_PARAMS_REQUIRED' : `${this.vendorId.toUpperCase()}_AVATAR_STREAM_URL_MISSING`);
    const duration = payload.duration_ms ?? payload.durationMs;
    return { jobId: rtc?.sessionId ?? firstCloudString(payload, ['job_id', 'jobId', 'session_id', 'sessionId']) ?? `${this.vendorId}-${Date.now()}`, streamUrl, rtc, durationMs: typeof duration === 'number' ? duration : undefined };
  }

  private async driveBaiduRoom(roomName: string, wav: Buffer): Promise<void> {
    const { signature, expireTime } = baiduWebSocketToken(this.options.config.appId || '', this.options.apiKey);
    const wsPath = this.options.config.webSocketPath || '/live/2d/ws';
    const wsUrl = `${cloudUrl(this.options.config.baseUrl, wsPath).replace(/^http/i, 'ws')}?appId=${encodeURIComponent(this.options.config.appId || '')}&token=${encodeURIComponent(signature)}&expire=${encodeURIComponent(expireTime)}&liveRoom=${encodeURIComponent(roomName)}`;
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('BAIDU_AVATAR_WEBSOCKET_TIMEOUT')); }, this.options.timeoutMs ?? 60_000);
      socket.once('open', () => {
        const start = { id: 1, type: 'AUDIO_STREAM', body: JSON.stringify({ streamId: `stream-${Date.now()}`, event: 'START', sampleRate: 16_000 }) };
        socket.send(JSON.stringify(start));
      });
      socket.on('message', (data) => {
        let envelope: CloudJson;
        try { envelope = JSON.parse(data.toString()) as CloudJson; } catch { return; }
        const body = typeof envelope.body === 'string' ? (() => { try { return JSON.parse(envelope.body) as CloudJson; } catch { return {}; } })() : envelope.body && typeof envelope.body === 'object' ? envelope.body as CloudJson : {};
        if (String(envelope.type) === 'AUDIO_STREAM' && String(body.event).toUpperCase() === 'READY') {
          clearTimeout(timer);
          const pcm = toBaiduPcm16Mono(wav);
          for (let offset = 0; offset < pcm.length; offset += 256 * 1024) socket.send(pcm.subarray(offset, Math.min(offset + 256 * 1024, pcm.length)));
          socket.send(JSON.stringify({ id: 2, type: 'AUDIO_STREAM', body: JSON.stringify({ streamId: body.streamId || `stream-${Date.now()}`, event: 'COMPLETE' }) }));
          socket.close();
          resolve();
        } else if (Number(envelope.code) > 0 || String(body.event).toUpperCase() === 'ERROR') {
          clearTimeout(timer); socket.close(); reject(new Error(`BAIDU_AVATAR_WEBSOCKET_ERROR:${String(envelope.message || body.message || 'provider websocket error')}`));
        }
      });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }

  mediaOutput(): AvatarStageMedia { return { ...this.state.media, url: this.state.media.url, label: this.vendorLabel, muted: true }; }
  async disconnect(): Promise<void> { this.state = { ...this.state, connected: false, sessionActive: false, sessionId: undefined, checkedAt: Date.now() }; }
  getState(): AvatarProviderAdapterState { return structuredClone({ ...this.state, media: this.mediaOutput() }); }
  setMediaUrl(url?: string, rtc?: AvatarRtcConnection): void { this.state = { ...this.state, media: { ...this.state.media, url, rtc, muted: true, label: this.vendorLabel }, checkedAt: Date.now() }; }
  health(): AdapterHealth { const configured = Boolean(this.options.config.baseUrl.trim() && this.options.config.renderPath.trim() && this.options.apiKey.trim()); return { id: this.id, label: this.vendorLabel, status: this.state.connected ? 'READY' : configured ? 'DEGRADED' : 'NOT_CONFIGURED', configured, message: this.state.connected ? '云端实时数字人已连接' : configured ? '云端接口已配置，等待真实连接测试' : '需要云端地址、实时渲染路径和 API 凭证' }; }
}

export type BaiduCloudAvatarAdapterOptions = { profileId?: string; videoUrl?: string; chromaColor?: string };

/** Manual cloud fallback. It never switches automatically during a reading. */
export class BaiduCloudAvatarAdapter extends LocalVrmAvatarAdapter {
  override readonly id = 'baidu-cloud-avatar';
  override readonly vendorId = 'baidu-cloud';
  override readonly vendorLabel = '百度云数字人（手动备用）';
  constructor(private cloudOptions: BaiduCloudAvatarAdapterOptions = {}) { super({ profileId: cloudOptions.profileId, modelUrl: cloudOptions.videoUrl }); }
  configureCloud(options: BaiduCloudAvatarAdapterOptions): void { this.cloudOptions = { ...options }; super.configure({ profileId: options.profileId, modelUrl: options.videoUrl }); }
  override mediaOutput(): AvatarStageMedia {
    const options = this.cloudOptions ?? {};
    return { kind: 'VIDEO_URL', url: options.videoUrl, profileId: options.profileId, chromaColor: options.chromaColor, label: '百度云数字人（手动备用）', muted: true };
  }
}

export type MuseTalkAvatarAdapterOptions = {
  /** Base URL of the local MuseTalk rendering service (services/musetalk-service). */
  baseUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  preparationTimeoutMs?: number;
};

/**
 * Local real-time lip-sync provider backed by an open-source MuseTalk rendering
 * service (MIT). The service prepares reusable avatar caches and renders silent
 * lip-sync clips through /avatars/prep and /renders. CUDA is used automatically
 * when available; the same contract remains executable on CPU.
 */
export class MuseTalkAvatarAdapter implements AvatarProviderAdapter {
  readonly id = 'musetalk-avatar';
  readonly vendorId = 'musetalk-local';
  readonly vendorLabel = 'MuseTalk 本地实时口型';
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly preparationTimeoutMs: number;
  private state: AvatarProviderAdapterState;
  private lastAction?: AvatarActionName;
  private activeMediaUrl?: string;

  constructor(private options: MuseTalkAvatarAdapterOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.preparationTimeoutMs = options.preparationTimeoutMs ?? 2 * 60 * 60_000;
    this.state = this.initialState();
  }

  configure(baseUrl: string): void {
    if (baseUrl.trim() && baseUrl !== this.options.baseUrl) this.options.baseUrl = baseUrl;
  }

  private initialState(): AvatarProviderAdapterState {
    return {
      vendorId: this.vendorId,
      vendorLabel: this.vendorLabel,
      vendorSelected: false,
      status: 'NOT_CONFIGURED',
      connected: false,
      sessionActive: false,
      capabilities: {
        sessionLifecycle: false,
        stageActions: false,
        realtimeAudio: false,
        lipSync: true,
        greenScreenOutput: true,
        mediaStreamOutput: false,
      },
      media: { kind: 'STATIC' },
      lastError: undefined,
      checkedAt: Date.now(),
    };
  }

  private url(path: string): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private async call(path: string, body?: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    const response = await this.fetcher(this.url(path), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`Musetalk_HTTP_${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async connect(): Promise<AvatarProviderAdapterState> {
    try {
      const health = await this.call('/health');
      if (health.status !== 'ok' || health.ready === false) {
        const missing = Array.isArray(health.missing) ? health.missing.join(', ') : String(health.detail ?? 'models or CUDA not ready');
        throw new Error(`MUSETALK_NOT_READY: ${missing}`);
      }
      this.state = {
        ...this.state,
        status: 'READY',
        connected: true,
        vendorSelected: true,
        lastError: undefined,
        checkedAt: Date.now(),
        media: this.activeMediaUrl
          ? { kind: 'VIDEO_URL', url: this.activeMediaUrl, label: String(health.avatar ?? 'musetalk'), muted: true }
          : { kind: 'STATIC' },
      };
    } catch (error) {
      this.state = {
        ...this.initialState(),
        status: 'NOT_CONFIGURED',
        vendorSelected: true,
        lastError: error instanceof Error ? error.message : 'MuseTalk service unreachable',
        checkedAt: Date.now(),
      };
    }
    return this.getState();
  }

  async detectCapabilities(): Promise<AvatarProviderAdapterState['capabilities']> {
    return { ...this.state.capabilities };
  }

  async prepareAvatar(avatarId: string, videoPath: string): Promise<void> {
    await this.ensureConnected();
    const created = await this.call('/avatars/prep', { avatar_id: avatarId, video_path: videoPath }, this.timeoutMs);
    if (created.prepared === true || created.status === 'READY') return;
    const jobId = typeof created.job_id === 'string' ? created.job_id : '';
    if (!jobId) throw new Error('MUSETALK_AVATAR_PREP_NO_JOB');
    const deadline = Date.now() + this.preparationTimeoutMs;
    let result = created;
    while (!['READY', 'FAILED', 'CANCELED'].includes(String(result.status))) {
      if (Date.now() >= deadline) throw new Error('MUSETALK_AVATAR_PREP_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 750));
      result = await this.call(`/avatars/prep/${encodeURIComponent(jobId)}`, undefined, this.timeoutMs);
    }
    if (result.status !== 'READY' || result.prepared !== true) throw new Error(`MUSETALK_AVATAR_PREP_FAILED:${String(result.failure_reason ?? '')}`);
  }

  async createSession(input: { note?: string } = {}): Promise<AvatarProviderAdapterState> {
    this.state = {
      ...this.state,
      status: 'READY',
      connected: true,
      sessionActive: true,
      sessionId: `musetalk-${Date.now()}`,
      checkedAt: Date.now(),
    };
    return this.getState();
  }

  /** Lazy connect: the rendering service may come up at any time. */
  private async ensureConnected(): Promise<void> {
    if (!this.state.connected) await this.connect();
    if (!this.state.connected) throw new Error('AVATAR_PROVIDER_NOT_CONNECTED');
  }

  async perform(action: AvatarAction, input: { readingId?: string } = {}): Promise<void> {
    await this.ensureConnected();
    this.lastAction = action;
    this.state = { ...this.state, lastAction: action, checkedAt: Date.now() };
  }

  /** Render a lip-synced video for the synthesized narration (segment mode). */
  async render(audioPath: string, readingId: string, avatarId = 'default'): Promise<{ jobId: string; videoPath: string; durationMs: number }> {
    await this.ensureConnected();
    const created = await this.call('/renders', { avatar_id: avatarId, audio_path: audioPath, reading_id: readingId });
    const jobId = typeof created.job_id === 'string' ? created.job_id : '';
    if (!jobId) throw new Error('MUSETALK_RENDER_NO_JOB');
    const deadline = Date.now() + 30 * 60_000;
    let result = created;
    while (!['READY', 'FAILED', 'CANCELED'].includes(String(result.status))) {
      if (Date.now() >= deadline) throw new Error('MUSETALK_RENDER_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await this.call(`/renders/${encodeURIComponent(jobId)}`);
    }
    if (result.status !== 'READY') throw new Error(`MUSETALK_RENDER_${String(result.status)}:${String(result.failure_reason ?? '')}`);
    const videoPath = typeof result.video_path === 'string' ? result.video_path : '';
    if (!videoPath) throw new Error('MUSEALK_RENDER_NO_VIDEO');
    return { jobId, videoPath, durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : 0 };
  }

  /** Select the orchestrator-managed media URL consumed by the shared stage. */
  async speak(managedMediaUrl: string): Promise<void> {
    await this.ensureConnected();
    this.activeMediaUrl = managedMediaUrl;
    this.lastAction = 'SPEAKING_NEUTRAL';
    this.state = { ...this.state, lastAction: 'SPEAKING_NEUTRAL', media: { kind: 'VIDEO_URL', url: managedMediaUrl, label: this.vendorLabel, muted: true }, checkedAt: Date.now() };
  }

  mediaOutput(): AvatarStageMedia {
    if (!this.state.connected || !this.activeMediaUrl) return { kind: 'STATIC' };
    return { kind: 'VIDEO_URL', url: this.activeMediaUrl, label: this.vendorLabel, muted: true };
  }

  async disconnect(): Promise<void> {
    this.activeMediaUrl = undefined;
    this.state = { ...this.initialState(), vendorSelected: true, checkedAt: Date.now() };
  }

  getState(): AvatarProviderAdapterState {
    return structuredClone(this.state);
  }

  getLastAction(): AvatarActionName | undefined {
    return this.lastAction;
  }

  health(): AdapterHealth {
    const configured = Boolean(this.options.baseUrl.trim());
    return {
      id: this.id,
      label: 'MuseTalk 本地实时口型',
      status: this.state.connected ? 'READY' : 'NOT_CONFIGURED',
      configured,
      message: this.state.connected
        ? '渲染服务已连接 · 静音口型视频由统一舞台播放，声音只走唯一音频总线'
        : this.state.lastError
          ? `渲染服务未连接：${this.state.lastError}`
          : 'MuseTalk 服务尚未启动',
    };
  }
}

export const vtubeRequiredParameters = [] as const;

export const vtubeHotkeys: Record<AvatarAction, string> = {
  IDLE: 'MEIHUA_IDLE',
  QUESTION_RECEIVED: 'MEIHUA_QUESTION',
  CASTING: 'MEIHUA_CASTING',
  THINKING: 'MEIHUA_THINKING',
  SPEAKING_NEUTRAL: 'MEIHUA_SPEAKING',
  SPEAKING_EMPHASIS: 'MEIHUA_EMPHASIS',
  THANK_GIFT: 'MEIHUA_GIFT',
  FINISH: 'MEIHUA_FINISH',
  ERROR_RECOVER: 'MEIHUA_ERROR',
};

type VTubeResponse = { requestID?: string; messageType?: string; data?: Record<string, unknown> };
type PendingRequest = { resolve: (value: VTubeResponse) => void; reject: (reason: Error) => void; timeout: NodeJS.Timeout };

/**
 * A deliberately small VTube Studio public API client.  It owns no token storage:
 * the runtime supplies an encrypted token and persists any newly granted token.
 */
export class VTubeStudioAdapter implements AvatarAdapter {
  readonly id = 'vtube-studio';
  private socket?: WebSocket;
  private token?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private desired = false;
  private pending = new Map<string, PendingRequest>();
  private readonly hotkeyIds = new Map<string, string>();
  private state: VTubeStudioConnectionState;

  constructor(private url: string, token?: string, private readonly onToken?: (token: string) => Promise<void> | void) {
    this.token = token;
    this.state = { status: token ? 'DISCONNECTED' : 'AUTH_REQUIRED', url, connected: false, authenticated: false, reconnectAttempts: 0 };
  }

  configure(url: string, token?: string): void {
    const changed = url !== this.url;
    this.url = url;
    this.token = token ?? this.token;
    this.state = { ...this.state, url, status: this.token ? 'DISCONNECTED' : 'AUTH_REQUIRED' };
    if (changed && this.desired) { void this.disconnect(false).then(() => this.connect()); }
  }

  getState(): VTubeStudioConnectionState { return structuredClone(this.state); }

  async connect(): Promise<VTubeStudioConnectionState> {
    this.desired = true;
    try {
      await this.openSocket();
      const apiState = await this.request('APIStateRequest');
      if (apiState.data?.active !== true) throw new Error('VTube Studio Plugin API is not active');
      if (!this.token) {
        this.state = { ...this.state, status: 'AUTH_REQUIRED', connected: true, authenticated: false };
        return this.getState();
      }
      const auth = await this.request('AuthenticationRequest', {
        pluginName: 'Meihua Live Control', pluginDeveloper: 'Meihua Live', authenticationToken: this.token,
      });
      if (auth.data?.authenticated !== true) {
        this.token = undefined;
        this.state = { ...this.state, status: 'AUTH_REQUIRED', connected: true, authenticated: false, lastError: 'VTube Studio authorization is required' };
        return this.getState();
      }
      await this.refreshModel();
    } catch (error) {
      this.state = { ...this.state, status: 'DISCONNECTED', connected: false, authenticated: false, lastError: error instanceof Error ? error.message : 'Unable to connect to VTube Studio' };
      this.scheduleReconnect();
    }
    return this.getState();
  }

  async authorize(): Promise<VTubeStudioConnectionState> {
    this.desired = true;
    try {
      await this.openSocket();
      const apiState = await this.request('APIStateRequest');
      if (apiState.data?.active !== true) throw new Error('VTube Studio Plugin API is not active');
      const token = await this.request('AuthenticationTokenRequest', { pluginName: 'Meihua Live Control', pluginDeveloper: 'Meihua Live' });
      const authenticationToken = typeof token.data?.authenticationToken === 'string' ? token.data.authenticationToken : undefined;
      if (!authenticationToken) throw new Error('Authorization was denied or no token was returned');
      this.token = authenticationToken;
      await this.onToken?.(authenticationToken);
      return await this.connect();
    } catch (error) {
      this.state = { ...this.state, status: 'AUTH_REQUIRED', connected: Boolean(this.socket), authenticated: false, lastError: error instanceof Error ? error.message : 'VTube Studio authorization failed' };
      return this.getState();
    }
  }

  async disconnect(clearToken = false): Promise<void> {
    this.desired = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (clearToken) this.token = undefined;
    const socket = this.socket;
    this.socket = undefined;
    for (const [id, pending] of this.pending) { clearTimeout(pending.timeout); pending.reject(new Error('VTube Studio disconnected')); this.pending.delete(id); }
    if (socket && socket.readyState === WebSocket.OPEN) await new Promise<void>((resolve) => { socket.once('close', resolve); socket.close(); setTimeout(resolve, 300); });
    this.state = { ...this.state, status: clearToken ? 'AUTH_REQUIRED' : 'DISCONNECTED', connected: false, authenticated: false };
  }

  async perform(action: AvatarAction, _input: { readingId?: string }): Promise<void> {
    if (!this.state.connected || !this.state.authenticated) throw new Error('VTube Studio is not authenticated');
    const hotkey = vtubeHotkeys[action];
    if (this.state.model?.missingHotkeys.includes(hotkey)) throw new Error(`Required VTube Studio hotkey is missing: ${hotkey}`);
    const hotkeyID = this.hotkeyIds.get(hotkey);
    if (!hotkeyID) throw new Error(`Required VTube Studio hotkey is not mapped: ${hotkey}`);
    await this.request('HotkeyTriggerRequest', { hotkeyID });
  }

  async injectLipSync(frame: { mouthOpen: number; vowel?: VisemeFrame['vowel'] }): Promise<void> {
    if (!this.state.connected || !this.state.authenticated || this.state.status === 'MODEL_MISSING') return;
    const value = Math.max(0, Math.min(1, frame.mouthOpen));
    const vowels: Array<VisemeFrame['vowel']> = ['A', 'I', 'U', 'E', 'O'];
    const parameterValues = [
      { id: 'MouthOpen', value },
      ...vowels.map((vowel) => ({ id: `Voice${vowel}`, value: frame.vowel === vowel ? Math.max(value, .35) : 0 })),
      { id: 'VoiceSilence', value: frame.vowel === 'SILENCE' || value < .04 ? 1 : 0 },
    ];
    await this.request('InjectParameterDataRequest', { faceFound: true, mode: 'set', parameterValues });
  }

  async resetLipSync(): Promise<void> {
    await this.injectLipSync({ mouthOpen: 0, vowel: 'SILENCE' });
  }

  async testMouth(durationMs = 1_200): Promise<{ ok: boolean; state: VTubeStudioConnectionState; reason?: string }> {
    try {
      await this.injectLipSync({ mouthOpen: .85, vowel: 'A' });
      await new Promise((resolve) => setTimeout(resolve, Math.max(200, Math.min(durationMs, 3_000))));
      await this.resetLipSync();
      return { ok: true, state: this.getState() };
    } catch (error) { return { ok: false, state: this.getState(), reason: error instanceof Error ? error.message : 'Mouth test failed' }; }
  }

  async testActions(): Promise<{ action: AvatarAction; ok: boolean; reason?: string }[]> {
    const results: Array<{ action: AvatarAction; ok: boolean; reason?: string }> = [];
    for (const action of Object.keys(vtubeHotkeys) as AvatarAction[]) {
      try { await this.perform(action, {}); results.push({ action, ok: true }); }
      catch (error) { results.push({ action, ok: false, reason: error instanceof Error ? error.message : 'Action test failed' }); }
    }
    return results;
  }

  health(): AdapterHealth {
    const state = this.state;
    return {
      id: this.id,
      label: 'VTube Studio 2D 数字人',
      status: state.status,
      configured: state.status === 'READY',
      message: state.status === 'READY'
        ? `已连接模型 ${state.model?.modelName ?? ''}`.trim()
        : state.lastError ?? (state.status === 'AUTH_REQUIRED' ? '请在中控点击“连接并授权”' : '等待 VTube Studio 连接和模型检查'),
    };
  }

  private async refreshModel(): Promise<void> {
    const current = await this.request('CurrentModelRequest');
    const modelLoaded = current.data?.modelLoaded === true;
    const modelName = typeof current.data?.modelName === 'string' ? current.data.modelName : undefined;
    const modelId = typeof current.data?.modelID === 'string' ? current.data.modelID : undefined;
    let hotkeys: Array<{ name: string; id: string }> = [];
    this.hotkeyIds.clear();
    try {
      const response = await this.request('HotkeysInCurrentModelRequest');
      const raw = Array.isArray(response.data?.availableHotkeys) ? response.data?.availableHotkeys as Array<Record<string, unknown>> : [];
      hotkeys = raw.flatMap((item) => {
        const name = typeof item.name === 'string' ? item.name : undefined;
        const id = typeof item.hotkeyID === 'string' ? item.hotkeyID : undefined;
        return name && id ? [{ name, id }] : [];
      });
      for (const hotkey of hotkeys) this.hotkeyIds.set(hotkey.name, hotkey.id);
    } catch { /* Model API may reject this until a model is loaded. */ }
    const requiredHotkeys = Object.values(vtubeHotkeys);
    const profile: VTubeStudioModelProfile = {
      modelLoaded,
      modelId,
      modelName,
      requiredParameters: [...vtubeRequiredParameters],
      // These are VTube Studio standard input parameters. A model mapping still gets a visual test in the wizard.
      missingParameters: modelLoaded ? [] : [...vtubeRequiredParameters],
      requiredHotkeys,
      missingHotkeys: modelLoaded ? requiredHotkeys.filter((item) => !hotkeys.some((value) => value.name.toLocaleLowerCase() === item.toLocaleLowerCase())) : requiredHotkeys,
      checkedAt: Date.now(),
    };
    const status = !modelLoaded ? 'MODEL_MISSING' : profile.missingParameters.length ? 'PARAMETER_MISSING' : profile.missingHotkeys.length ? 'DEGRADED' : 'READY';
    this.state = { ...this.state, status, connected: true, authenticated: true, model: profile, reconnectAttempts: 0, lastConnectedAt: Date.now(), lastError: undefined };
  }

  private async openSocket(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.state = { ...this.state, status: 'CONNECTING', url: this.url };
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timeout = setTimeout(() => { socket.close(); reject(new Error('VTube Studio connection timed out')); }, 5_000);
      this.socket = socket;
      socket.once('open', () => { clearTimeout(timeout); resolve(); });
      socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
      socket.on('message', (raw) => this.onMessage(raw.toString()));
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined;
        if (this.desired) {
          this.state = { ...this.state, status: this.token ? 'DISCONNECTED' : 'AUTH_REQUIRED', connected: false, authenticated: false };
          this.scheduleReconnect();
        }
      });
    });
  }

  private onMessage(raw: string): void {
    let response: VTubeResponse;
    try { response = JSON.parse(raw) as VTubeResponse; } catch { return; }
    const id = response.requestID;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (response.messageType === 'APIError') pending.reject(new Error(typeof response.data?.message === 'string' ? response.data.message : 'VTube Studio API error'));
    else pending.resolve(response);
  }

  private request(messageType: string, data: Record<string, unknown> = {}): Promise<VTubeResponse> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('VTube Studio WebSocket is not connected'));
    const requestID = `meihua-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    return new Promise<VTubeResponse>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(requestID); reject(new Error(`${messageType} timed out`)); }, 4_000);
      this.pending.set(requestID, { resolve, reject, timeout });
      socket.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID, messageType, data }), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestID);
        if (pending) { this.pending.delete(requestID); clearTimeout(pending.timeout); pending.reject(error); }
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.desired || this.reconnectTimer) return;
    const reconnectAttempts = this.state.reconnectAttempts + 1;
    const delay = Math.min(30_000, 750 * 2 ** Math.min(reconnectAttempts, 5)) + Math.floor(Math.random() * 300);
    this.state = { ...this.state, reconnectAttempts };
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect(); }, delay);
  }
}

export class LocalLiveInputAdapter implements LiveInputAdapter {
  readonly id = 'local-live-input';
  private handlers?: LiveInputHandlers;
  async start(handlers: LiveInputHandlers): Promise<void> { this.handlers = handlers; }
  async stop(): Promise<void> { this.handlers = undefined; }
  async emit(event: LiveChatEvent): Promise<void> { await this.handlers?.onChat(event); }
  async emitGift(event: LiveGiftEvent): Promise<void> { await this.handlers?.onGift(event); }
  async emitLike(event: LiveLikeEvent): Promise<void> { await this.handlers?.onLike(event); }
  health(): AdapterHealth {
    return { id: this.id, label: '本地输入', status: 'READY', message: '后台手工输入与测试事件入口可用', configured: true };
  }
}

type TikfinityEnvelope = {
  event?: unknown;
  eventName?: unknown;
  type?: unknown;
  name?: unknown;
  data?: unknown;
  payload?: unknown;
  [key: string]: unknown;
};

function textField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberField(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = textField(value);
    if (result) return result;
  }
  return undefined;
}

function userFields(data: Record<string, unknown>) {
  const user = [data.user, data.userInfo, data.author, data.sender, data.from]
    .map(objectField)
    .find((candidate) => candidate) ?? {};
  return {
    userId: firstText(user.userId, user.uid, user.id, data.userId, data.uid),
    username: firstText(user.uniqueId, user.username, user.userName, user.handle, data.uniqueId, data.username, data.userName, user.nickname, data.nickname, user.displayName, data.displayName) ?? 'anonymous',
    displayName: firstText(user.nickname, user.displayName, user.name, data.nickname, data.displayName),
  };
}

function eventData(envelope: TikfinityEnvelope): Record<string, unknown> {
  let data = objectField(envelope.data) ?? objectField(envelope.payload) ?? envelope;
  // TikFinity versions and bridge scripts have used both { data: {...} }
  // and { payload: { data: {...} } }. Unwrap a few layers without losing
  // fields that were placed beside the wrapper.
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = objectField(data.data) ?? objectField(data.payload) ?? objectField(data.eventData);
    if (!nested || nested === data) break;
    const outer = { ...data };
    delete outer.data;
    delete outer.payload;
    delete outer.eventData;
    data = { ...outer, ...nested };
  }
  return data;
}

function canonicalEventName(value: unknown): string {
  return textField(value)?.toLocaleLowerCase().replace(/[\s_.-]/g, '') ?? 'unknown';
}

function eventKind(eventName: string, data: Record<string, unknown>): 'chat' | 'gift' | 'like' | undefined {
  if (['chat', 'chatmessage', 'comment', 'commentmessage', 'newcomment', 'message', 'text'].includes(eventName) || eventName.includes('chat') || eventName.includes('comment')) return 'chat';
  if (['gift', 'giftreceived', 'giftmessage', 'donation', 'tip'].includes(eventName) || eventName.includes('gift') || eventName.includes('donation')) return 'gift';
  if (['like', 'likes', 'likereceived', 'likeevent'].includes(eventName) || eventName.includes('like')) return 'like';
  // Some webhook bridges omit the event field and only send a typed payload.
  if (firstText(data.comment, data.commentText, data.chatMessage, data.message, data.text, data.content)) return 'chat';
  if (objectField(data.giftDetails) || objectField(data.gift) || firstText(data.giftName, data.giftId)) return 'gift';
  if (data.likeCount != null || data.totalLikeCount != null || data.like_count != null) return 'like';
  return undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item !== 'function' && item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function deterministicFallbackEventId(eventName: string, data: Record<string, unknown>): string {
  return `${eventName}-fallback-${createHash('sha256').update(stableJson(data)).digest('hex').slice(0, 24)}`;
}

/** Normalizer for TikFinity/TikTok-Live-Connector plus common bridge payload aliases. */
export function normalizeTikfinityEnvelope(envelope: TikfinityEnvelope, receivedAt = Date.now()):
  | { kind: 'chat'; event: LiveChatEvent }
  | { kind: 'gift-preview' }
  | { kind: 'gift'; event: LiveGiftEvent }
  | { kind: 'like'; event: LiveLikeEvent }
  | { kind: 'other'; eventName: string } {
  const rawEventName = firstText(envelope.event, envelope.eventName, envelope.type, envelope.name);
  const eventName = canonicalEventName(rawEventName);
  const data = eventData(envelope);
  const kind = eventKind(eventName, data);
  const user = userFields(data);
  const eventId = firstText(data.msgId, data.messageId, data.eventId, data.event_id, data.id) ?? deterministicFallbackEventId(eventName === 'unknown' ? kind ?? 'event' : eventName, data);
  if (kind === 'chat') {
    return { kind: 'chat', event: { source: 'tikfinity', eventId, ...user, message: firstText(data.comment, data.commentText, data.chatMessage, data.message, data.text, data.content, data.msg) ?? '', timestamp: receivedAt, raw: data } };
  }
  if (kind === 'gift') {
    const details = objectField(data.giftDetails) ?? objectField(data.gift) ?? objectField(data.giftInfo) ?? {};
    const giftType = numberField(details.giftType ?? details.type ?? data.giftType ?? data.type);
    const repeatEnd = booleanField(data.repeatEnd ?? details.repeatEnd ?? data.repeat_end);
    if (giftType === 1 && repeatEnd !== true) return { kind: 'gift-preview' };
    return { kind: 'gift', event: {
      source: 'tikfinity', eventId, ...user,
      giftId: firstText(data.giftId, data.gift_id, details.giftId, details.id),
      giftName: firstText(details.giftName, details.name, details.title, data.giftName, data.gift_name, data.name, data.title) ?? 'Unknown gift',
      repeatCount: Math.max(1, numberField(data.repeatCount ?? data.repeat ?? data.quantity ?? details.repeatCount, 1)),
      giftType: giftType || undefined,
      repeatEnd,
      diamondCount: numberField(details.diamondCount ?? data.diamondCount ?? data.diamonds ?? data.coinCount) || undefined,
      timestamp: receivedAt, raw: data,
    } };
  }
  if (kind === 'like') {
    return { kind: 'like', event: {
      source: 'tikfinity', eventId, ...user,
      likeCount: Math.max(0, numberField(data.likeCount ?? data.like_count ?? data.count ?? data.likes ?? data.repeatCount)), totalLikeCount: numberField(data.totalLikeCount ?? data.total_like_count ?? data.totalLikes) || undefined,
      timestamp: receivedAt, raw: data,
    } };
  }
  return { kind: 'other', eventName: rawEventName?.trim() || eventName };
}

export class TikfinityLiveInputAdapter implements LiveInputAdapter {
  readonly id = 'tikfinity';
  private socket?: WebSocket;
  private handlers?: LiveInputHandlers;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private pongDeadline?: NodeJS.Timeout;
  private messageChain: Promise<void> = Promise.resolve();
  private stopping = false;
  private state: TikfinityDiagnostics;

  constructor(private url: string) {
    this.state = { status: 'DISCONNECTED', connected: false, verified: false, url, reconnectAttempts: 0, events: { chat: 0, gift: 0, like: 0, follow: 0, share: 0, unknown: 0 }, recentSamples: [] };
  }

  restoreRecentVerification(lastEventAt: number): void {
    if (!Number.isFinite(lastEventAt) || lastEventAt <= 0) return;
    this.state = { ...this.state, verified: true, lastEventAt, status: this.state.connected ? 'READY' : this.state.status };
  }

  configure(url: string): void {
    if (url === this.url) return;
    this.url = url;
    this.state.url = url;
    void this.restart();
  }

  async start(handlers: LiveInputHandlers): Promise<void> { this.handlers = handlers; this.stopping = false; this.connect(); }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    this.socket?.close(); this.socket = undefined;
  }
  private async restart(): Promise<void> { await this.stop(); if (this.handlers) { this.stopping = false; this.connect(); } }

  private connect(): void {
    if (this.stopping || !this.handlers) return;
    try {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.on('open', () => {
        this.state = { ...this.state, status: this.state.verified ? 'READY' : 'DEGRADED', connected: true, lastConnectedAt: Date.now(), reconnectAttempts: 0, lastError: undefined };
      });
      socket.on('message', (buffer) => {
        this.messageChain = this.messageChain.then(() => this.handleMessage(buffer.toString())).catch((error: unknown) => {
          this.state = { ...this.state, status: 'DEGRADED', lastError: error instanceof Error ? error.message : 'TikFinity event handler failed' };
        });
      });
      socket.on('pong', () => { if (this.pongDeadline) clearTimeout(this.pongDeadline); this.pongDeadline = undefined; });
      this.pingTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.ping();
        if (this.pongDeadline) clearTimeout(this.pongDeadline);
        this.pongDeadline = setTimeout(() => socket.terminate(), 8_000);
      }, 15_000);
      socket.on('error', (error) => { this.state = { ...this.state, status: 'ERROR', lastError: error.message }; });
      socket.on('close', () => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.pongDeadline) clearTimeout(this.pongDeadline);
        this.pingTimer = undefined; this.pongDeadline = undefined;
        this.state = { ...this.state, status: 'DISCONNECTED', connected: false };
        this.scheduleReconnect();
      });
    } catch (error) {
      this.state = { ...this.state, status: 'ERROR', connected: false, lastError: error instanceof Error ? error.message : 'Unable to create WebSocket' };
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const attempt = this.state.reconnectAttempts + 1;
    this.state.reconnectAttempts = attempt;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)));
  }

  private async handleMessage(raw: string): Promise<void> {
    let envelope: TikfinityEnvelope;
    try { envelope = JSON.parse(raw) as TikfinityEnvelope; }
    catch { this.state = { ...this.state, lastError: 'Received invalid JSON', status: 'DEGRADED' }; return; }
    const receivedAt = Date.now();
    const normalized = normalizeTikfinityEnvelope(envelope, receivedAt);
    const eventName = normalized.kind === 'other' ? normalized.eventName : normalized.kind === 'gift-preview' ? 'gift' : normalized.kind;
    const bucket = eventName === 'chat' || eventName === 'gift' || eventName === 'like' || eventName === 'follow' || eventName === 'share' ? eventName : 'unknown';
    const data = eventData(envelope);
    const validEvent = (normalized.kind === 'chat' && normalized.event.message.trim().length > 0)
      || normalized.kind === 'gift'
      || (normalized.kind === 'like' && normalized.event.likeCount > 0);
    const sample = normalized.kind === 'chat'
      ? { event: eventName, receivedAt, fields: Object.keys(data).slice(0, 20), username: normalized.event.username, message: normalized.event.message.slice(0, 180) }
      : normalized.kind === 'gift'
        ? { event: eventName, receivedAt, fields: Object.keys(data).slice(0, 20), username: normalized.event.username, giftName: normalized.event.giftName, repeatCount: normalized.event.repeatCount }
        : normalized.kind === 'like'
          ? { event: eventName, receivedAt, fields: Object.keys(data).slice(0, 20), username: normalized.event.username, likeCount: normalized.event.likeCount }
          : { event: eventName, receivedAt, fields: Object.keys(data).slice(0, 20) };
    this.state = {
      // Room/user/status messages continue to arrive after a real event.  They
      // are useful diagnostics, but must not downgrade an already verified
      // live input back to DEGRADED in the operator console.
      ...this.state, status: validEvent || this.state.verified ? 'READY' : 'DEGRADED', connected: true, verified: this.state.verified || validEvent, lastEventAt: receivedAt,
      events: { ...this.state.events, [bucket]: this.state.events[bucket] + 1 },
      recentSamples: [sample, ...this.state.recentSamples].slice(0, 10),
    };
    if (normalized.kind === 'chat' && normalized.event.message) await this.handlers?.onChat(normalized.event);
    if (normalized.kind === 'gift') await this.handlers?.onGift(normalized.event);
    if (normalized.kind === 'like' && normalized.event.likeCount > 0) await this.handlers?.onLike(normalized.event);
  }

  diagnostics(): TikfinityDiagnostics { return structuredClone(this.state); }
  health(): AdapterHealth {
    const message = !this.state.connected ? `未连接 ${this.url}` : this.state.verified ? '已连接，且已收到符合契约的真实事件' : 'WebSocket 已连接，等待 chat/gift/like 事件验证字段';
    return { id: this.id, label: 'TikFinity Desktop', status: this.state.status, message, configured: this.state.verified };
  }
}

function unconfigured(id: string, label: string, message: string): AdapterHealth {
  return { id, label, status: 'NOT_CONFIGURED', message, configured: false };
}

type HealthReportingAdapter = { id: string; health(): AdapterHealth };

export function providerHealth(settings: ProviderSettings, local: { tts: TtsAdapter; avatar: HealthReportingAdapter; input: LiveInputAdapter; tikfinity?: LiveInputAdapter }): AdapterHealth[] {
  return [
    settings.liveInput.adapter === 'local' ? local.input.health() : local.tikfinity?.health() ?? unconfigured('tikfinity', 'TikFinity Desktop', `需要连接 ${settings.liveInput.url}`),
    settings.llm.adapter === 'rule-based' ? { id: 'rule-based-composer', label: '本地规则引擎', status: 'READY', message: '审核与口播均为离线、结构化、可复现流程', configured: true } : unconfigured('openai-compatible', 'OpenAI-compatible LLM', `需要配置 ${settings.llm.apiKeyEnv}、模型及 JSON Schema 调用`),
    settings.tts.adapter === 'windows' ? local.tts.health() : unconfigured('external-tts', 'External TTS', `需要配置 ${settings.tts.apiKeyEnv}、voiceId 和音频路由`),
    settings.avatar.adapter === 'none' || settings.avatar.adapter === 'vtube-studio' || settings.avatar.adapter === 'mock'
      ? local.avatar.health()
      : unconfigured(settings.avatar.adapter, 'Warudo', `需要连接 ${settings.avatar.url}、完成授权并映射动作`),
  ];
}

export const integrationChecklists = {
  tikfinity: ['确认 Desktop 已运行', '确认 WebSocket 地址', '采样真实 chat/gift payload', '实现并测试 Event Normalizer', '验证断线重连与事件幂等'],
  llm: ['配置环境变量 API Key', '设置 model/baseUrl', '启用 JSON Schema 验证', '执行超时、重试和错误回退测试'],
  tts: ['配置环境变量 API Key', '选择 voiceId', '校验输出音频实际时长', '完成虚拟音频线路回声测试'],
  avatar: ['完成本地授权', '映射每个 AvatarAction', '验证 CASTING/SPEAKING/FINISH', '验证断线恢复'],
} as const;
