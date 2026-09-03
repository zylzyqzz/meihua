import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { AppSettings, AppSettingsPatch } from '@meihua/core-types';
import { SqlitePersistence } from '@meihua/persistence';
import { createApp } from './app.js';
import { resolveProjectRoot } from './project-root.js';
import { LiveRuntime } from './runtime.js';
import { closeStaticServer, startStaticServer } from './static-server.js';

type FileConfig = AppSettingsPatch & { server?: { host?: string; port?: number } };

// The Windows launcher starts this process in the project root. An explicit
// override keeps packaged/portable deployments deterministic without relying
// on TypeScript source paths at runtime.
const projectRoot = resolveProjectRoot();
const dataDirectory = resolve(projectRoot, 'data');
const audioDirectory = resolve(dataDirectory, 'audio');
const mediaDirectory = resolve(dataDirectory, 'media');
mkdirSync(audioDirectory, { recursive: true });
mkdirSync(mediaDirectory, { recursive: true });

function readConfig(path: string): FileConfig {
  if (!existsSync(path)) return {};
  const value = parse(readFileSync(path, 'utf8')) as unknown;
  return value && typeof value === 'object' ? value as FileConfig : {};
}

function mergeConfig(base: FileConfig, override: FileConfig): FileConfig {
  return {
    ...base, ...override,
    server: { ...base.server, ...override.server },
    queue: { ...base.queue, ...override.queue }, moderation: { ...base.moderation, ...override.moderation },
    reading: { ...base.reading, ...override.reading }, gifts: { ...base.gifts, ...override.gifts, rules: override.gifts?.rules ?? base.gifts?.rules },
    overlay: { ...base.overlay, ...override.overlay },
    presentation: { ...base.presentation, ...override.presentation, profiles: override.presentation?.profiles ?? base.presentation?.profiles },
    providers: {
      ...base.providers, ...override.providers,
      liveInput: { ...base.providers?.liveInput, ...override.providers?.liveInput } as AppSettings['providers']['liveInput'],
      llm: { ...base.providers?.llm, ...override.providers?.llm } as AppSettings['providers']['llm'],
      tts: { ...base.providers?.tts, ...override.providers?.tts } as AppSettings['providers']['tts'],
      avatar: { ...base.providers?.avatar, ...override.providers?.avatar } as AppSettings['providers']['avatar'],
    },
  };
}

const fileConfig = mergeConfig(readConfig(resolve(projectRoot, 'config/default.yaml')), readConfig(resolve(projectRoot, 'config/local.yaml')));
fileConfig.providers ??= {};
fileConfig.providers.llm ??= {};
fileConfig.providers.tts ??= {};
if (process.env.LLM_BASE_URL) fileConfig.providers.llm.baseUrl = process.env.LLM_BASE_URL;
if (process.env.LLM_MODEL) fileConfig.providers.llm.model = process.env.LLM_MODEL;
if (process.env.TTS_VOICE_ID) fileConfig.providers.tts.voiceId = process.env.TTS_VOICE_ID;

const port = Number(process.env.PORT ?? fileConfig.server?.port ?? 3210);
const host = process.env.HOST ?? fileConfig.server?.host ?? '127.0.0.1';
const persistence = new SqlitePersistence(resolve(dataDirectory, 'meihua-live.db'));
const runtime = new LiveRuntime(persistence, { audioDirectory, mediaDirectory, systemAssetDirectory: resolve(dataDirectory, 'lux3d'), initialSettings: fileConfig });

async function main(): Promise<void> {
  const production = process.env.MEIHUA_PRODUCTION === '1';
  const controlTokenPath = resolve(dataDirectory, 'runtime-control-token');
  const savedControlToken = production && existsSync(controlTokenPath)
    ? readFileSync(controlTokenPath, 'utf8').trim()
    : '';
  const controlToken = production
    ? (savedControlToken.length >= 32 ? savedControlToken : randomBytes(32).toString('base64url'))
    : undefined;
  const app = await createApp(runtime, { production, controlToken });
  let overlayServer: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  let adminServer: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  app.addHook('onClose', async () => runtime.close());
  await app.listen({ port, host });
  // Only publish the token after the API has won the port. A losing concurrent
  // launcher must never overwrite the token used by the healthy process.
  if (controlToken) writeFileSync(controlTokenPath, controlToken, { encoding: 'utf8', mode: 0o600 });
  if (production) {
    overlayServer = await startStaticServer({ directory: resolve(projectRoot, 'apps/overlay/dist'), port: Number(process.env.OVERLAY_PORT ?? 5173), host, controlToken });
    adminServer = await startStaticServer({ directory: resolve(projectRoot, 'apps/admin/dist'), port: Number(process.env.ADMIN_PORT ?? 5200), host, controlToken });
  }
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await closeStaticServer(overlayServer);
    await closeStaticServer(adminServer);
    await app.close();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

void main().catch((error) => {
  console.error(error);
  runtime.close();
  process.exitCode = 1;
});
