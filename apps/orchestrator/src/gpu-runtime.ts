import { execFileSync } from 'node:child_process';

/**
 * Hardware is not a boolean. CUDA on an RTX 2060 Super still means only 8 GB
 * of VRAM, so the live pipeline must choose a conservative runtime profile.
 */
export type GpuRuntimeProfileId = 'CPU_COMPAT' | 'SAFE_8GB' | 'STANDARD_12GB' | 'ENHANCED_16GB';

export type GpuRuntimeProfile = {
  id: GpuRuntimeProfileId;
  gpuName?: string;
  vramMb: number;
  freeVramMb?: number;
  musetalkBatchSize: number;
  avatarMaxWidth: number;
  avatarMaxHeight: number;
  /** Future segments allowed to start while the current segment is playing. */
  prebufferSegments: number;
  /** GPT-SoVITS must relinquish CUDA memory before a MuseTalk render starts. */
  releaseVoiceGpuAfterSynthesis: boolean;
  description: string;
};

type NvidiaSmiSnapshot = { name?: string; totalMb: number; freeMb?: number };

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function queryNvidiaSmi(): NvidiaSmiSnapshot | undefined {
  try {
    const output = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], {
      encoding: 'utf8', windowsHide: true, timeout: 2_000,
    }).trim();
    const first = output.split(/\r?\n/, 1)[0];
    const [name, total, free] = first.split(',').map((value) => value.trim());
    const totalMb = parsePositiveInt(total);
    if (!totalMb) return undefined;
    return { name, totalMb, freeMb: parsePositiveInt(free) };
  } catch {
    return undefined;
  }
}

function profileFor(vramMb: number, gpuName?: string, freeVramMb?: number, requested?: string): GpuRuntimeProfile {
  const override = requested?.trim().toUpperCase();
  const id = override === 'CPU_COMPAT' || override === 'SAFE_8GB' || override === 'STANDARD_12GB' || override === 'ENHANCED_16GB'
    ? override as GpuRuntimeProfileId
    : vramMb <= 0 ? 'CPU_COMPAT'
      : vramMb <= 8_192 ? 'SAFE_8GB'
        : vramMb <= 12_288 ? 'STANDARD_12GB'
          : 'ENHANCED_16GB';
  if (id === 'CPU_COMPAT') return { id, gpuName, vramMb, freeVramMb, musetalkBatchSize: 1, avatarMaxWidth: 540, avatarMaxHeight: 960, prebufferSegments: 0, releaseVoiceGpuAfterSynthesis: false, description: 'CPU compatibility mode: functional but deliberately serialized.' };
  if (id === 'SAFE_8GB') return { id, gpuName, vramMb, freeVramMb, musetalkBatchSize: 1, avatarMaxWidth: 720, avatarMaxHeight: 1280, prebufferSegments: 0, releaseVoiceGpuAfterSynthesis: true, description: '8 GB stable mode: batch 1, no speculative lip-sync render and one GPU lane.' };
  if (id === 'STANDARD_12GB') return { id, gpuName, vramMb, freeVramMb, musetalkBatchSize: 2, avatarMaxWidth: 900, avatarMaxHeight: 1600, prebufferSegments: 1, releaseVoiceGpuAfterSynthesis: true, description: '12 GB standard mode: one buffered segment with a single GPU lane.' };
  return { id, gpuName, vramMb, freeVramMb, musetalkBatchSize: 4, avatarMaxWidth: 1080, avatarMaxHeight: 1920, prebufferSegments: 2, releaseVoiceGpuAfterSynthesis: true, description: '16 GB enhanced mode: more buffering, never parallel heavyweight inference.' };
}

export function resolveGpuRuntimeProfile(environment: NodeJS.ProcessEnv = process.env): GpuRuntimeProfile {
  const configuredVram = parsePositiveInt(environment.MEIHUA_GPU_VRAM_MB);
  const detected = configuredVram ? undefined : queryNvidiaSmi();
  return profileFor(
    configuredVram ?? detected?.totalMb ?? 0,
    environment.MEIHUA_GPU_NAME?.trim() || detected?.name,
    parsePositiveInt(environment.MEIHUA_GPU_FREE_MB) ?? detected?.freeMb,
    environment.MEIHUA_GPU_PROFILE,
  );
}

export function runtimeProfileEnvironment(profile: GpuRuntimeProfile): Record<string, string> {
  return {
    MEIHUA_GPU_PROFILE: profile.id,
    MEIHUA_GPU_VRAM_MB: String(profile.vramMb),
    ...(profile.gpuName ? { MEIHUA_GPU_NAME: profile.gpuName } : {}),
    ...(profile.freeVramMb ? { MEIHUA_GPU_FREE_MB: String(profile.freeVramMb) } : {}),
    MUSETALK_BATCH_SIZE: String(profile.musetalkBatchSize),
    MEIHUA_AVATAR_MAX_WIDTH: String(profile.avatarMaxWidth),
    MEIHUA_AVATAR_MAX_HEIGHT: String(profile.avatarMaxHeight),
    MEIHUA_DIGITAL_HUMAN_PREBUFFER_SEGMENTS: String(profile.prebufferSegments),
    MEIHUA_RELEASE_GPU_AFTER_TTS: profile.releaseVoiceGpuAfterSynthesis ? '1' : '0',
  };
}

/** FIFO lane shared by local voice synthesis, avatar preparation and lip sync. */
export class GpuTaskCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private current?: { kind: string; startedAt: number };

  async run<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.current = { kind, startedAt: Date.now() };
    try {
      return await operation();
    } finally {
      this.current = undefined;
      release();
    }
  }

  getState(): { kind?: string; startedAt?: number; queued: boolean } {
    return { kind: this.current?.kind, startedAt: this.current?.startedAt, queued: Boolean(this.current) };
  }
}
