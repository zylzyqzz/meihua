import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { WebSocket } from 'ws';
import { BaiduCloudAvatarAdapter, CloudAvatarProviderAdapter, CloudVoiceCloneAdapter, ElevenLabsTtsAdapter, ElevenLabsVoiceClient, GptSoVitsTtsAdapter, KokoroTtsAdapter, LocalLiveInputAdapter, LocalMockAvatarProviderAdapter, LocalVrmAvatarAdapter, MuseTalkAvatarAdapter, OpenAICompatibleTtsAdapter, TikfinityLiveInputAdapter, VTubeStudioAdapter, VoiceAccentTtsAdapter, WindowsNativeAudioPlayer, WindowsTtsAdapter, buildLipSyncPlan, providerHealth, type AvatarAction, type AvatarProviderAdapter, type NativeAudioPlayer, type TtsAdapter } from '@meihua/adapters';
import { assertAnswerLengthTarget, assertNoGenericAnswerContent, assertValidAnswerContent, countSpeechUnits, OpenAICompatibleAnswerComposer, RuleBasedAnswerComposer, withAnswerLengthMetrics, type AnswerComposer } from '@meihua/answer-composer';
import type {
  AppSettings,
  AppSettingsPatch,
  AdapterHealth,
  AvatarRtcConnection,
  AvatarProviderAdapterState,
  AvatarRuntimeStatus,
  AvatarStageMedia,
  BlockedUser,
  GptSoVitsRefLanguage,
  GptSoVitsVoice,
  BroadcastSnapshotV2,
  DirectorCue,
  DirectorMessageV2,
  DirectorStage,
  LiveChatEvent,
  LiveGiftEvent,
  LiveLikeEvent,
  GiftEntitlement,
  GiftRule,
  LikeRule,
  CommentRule,
  OverlayMessage,
  OverlayState,
  OperationalDataRecalculationReport,
  Reading,
  RuntimeHealth,
  LiveSession,
  LiveSessionMode,
  AudioSourceLease,
  SyncMetrics,
  VTubeStudioConnectionState,
  LiveEventInboxItem,
  MediaAsset,
  MediaAssetKind,
  PreviewSession,
  QueueOverviewEntry,
  ProviderSecretStatus,
  VoiceProfile,
  VoiceClone,
  VoiceAccentProfile,
  VoiceCloneMode,
  VoiceTargetLocale,
  ReadingPipelinePhase,
  ReadingPipelineSnapshot,
  ReadingPipelineArtifacts,
  AvatarProfile,
  AvatarActionBinding,
  AvatarRenderJob,
  DigitalHumanJob,
  DigitalHumanOutputSnapshot,
  DigitalHumanPreset,
  DigitalHumanBroadcastItem,
  QualificationGrant,
  SceneProfile,
  SceneProfileVersion,
  SceneModuleId,
  PresentationMode,
  PresentationSettings,
  PresentationSnapshot,
  VoiceSelectionSnapshot,
  VideoPresentationProfile,
} from '@meihua/core-types';
import { DeterministicMeihuaEngine, MingyuMeihuaEngine, questionSums, type MeihuaEngine } from '@meihua/meihua-engine';
import { moderateQuestion } from '@meihua/moderation';
import { SqlitePersistence } from '@meihua/persistence';
import { ReadingQueue, type QueueItem } from '@meihua/queue';
import { isProcessing, isTerminal, transitionReading } from '@meihua/state-machine';
import { buildSpeechPlan, createDefaultSceneProfile, createDefaultStickerSourceConfig, createDefaultStageSourceConfig, migrateSceneComposition, sceneModuleIds } from './v2.js';
import { deleteDpapiSecret, readDpapiSecret, writeDpapiSecret } from './secrets.js';
import { GpuTaskCoordinator, resolveGpuRuntimeProfile, type GpuRuntimeProfile } from './gpu-runtime.js';

const deferredMuseTalkPreparation = 'MUSETALK_GPU_PREPARATION_PENDING';
const maxPipelineAttempts = 3;

const pipelinePhaseLabels: Record<ReadingPipelinePhase, string> = {
  QUEUED: '排队中',
  SELECTED: '已叫号',
  CASTING: '起卦中',
  INTERPRETING: '推演中',
  HEXAGRAM_READY: '卦象已生成',
  COMPOSING: '生成卦辞话术',
  SCRIPT_READY: '话术已生成',
  SYNTHESIZING: '克隆声音生成中',
  VOICE_READY: '声音已就绪',
  RENDERING: '数字人渲染中',
  SPEAKING: '统一播报中',
  FINISH: '本轮完成',
  FAILED: '等待重试',
};

const pipelinePhaseProgress: Record<ReadingPipelinePhase, number> = {
  QUEUED: 0, SELECTED: 8, CASTING: 18, INTERPRETING: 30, HEXAGRAM_READY: 38,
  COMPOSING: 46, SCRIPT_READY: 55, SYNTHESIZING: 66, VOICE_READY: 76,
  RENDERING: 86, SPEAKING: 94, FINISH: 100, FAILED: 0,
};

// These are intentionally broad because the live room contains both direct
// commands ("测算", "reading") and natural questions ("今年适合换工作吗？").
// Matching is still followed by moderation, length checks and queue dedupe.
const defaultCommentKeywords = [
  '测算', '测一卦', '算一卦', '起卦', '占卜', '解卦', '问卦', '梅花易数', '看卦', '卦象', '卦辞', '帮我算', '帮我测', '请测', '想测', '想问', '问一下',
  '适合吗', '可以吗', '能不能', '可不可以', '行不行', '该不该', '要不要', '会不会', '能否', '是否', '如何', '怎么办', '怎么样', '怎样', '什么时候', '何时', '多久', '为什么', '结果如何', '发展如何', '有机会吗', '能成功吗', '值得吗', '选哪个', '哪一个', '？', '?',
  '换工作', '找工作', '事业发展', '适合创业', '生意如何', '合作顺利吗', '项目能成吗', '什么时候发财', '财运如何', '收入会增加吗', '投资适合吗', '买房合适吗', '卖房顺利吗', '搬家合适吗', '出行顺利吗', '旅行合适吗', '考试能过吗', '学业如何', '能留学吗', '感情如何', '会复合吗', '桃花如何', '婚姻如何', '家庭关系',
  'reading', 'fortune reading', 'divination', 'hexagram', 'meihua', 'cast for me', 'calculate for me', 'read me', 'give me a reading', 'please read', 'should i', 'can i', 'could i', 'will i', 'would it', 'is it', 'are we', 'do i', 'does this', 'what will', 'when will', 'where should', 'why is', 'how will', 'how can', 'which one', 'career', 'new job', 'change jobs', 'business', 'money', 'finance', 'income', 'investment', 'love', 'relationship', 'marriage', 'reconcile', 'study', 'exam', 'school', 'move house', 'travel', 'project', 'decision',
  "what's", "when's", "where's", "why's", "how's", "i'd like to know", 'i wonder', 'do you think', 'please tell me', 'any chance',
  'lectura', 'adivinación', 'léeme', 'hazme una lectura', 'quisiera saber', 'me gustaría saber', 'será que', 'debería', 'puedo', 'podré', 'cuándo', 'cómo', 'trabajo', 'dinero', 'amor', 'relación',
  'lecture', 'divination', 'fais-moi une lecture', 'je voudrais savoir', "j'aimerais savoir", 'vais-je', 'dois-je', 'puis-je', 'est-ce que', "qu'est-ce", 'quand', 'comment', 'travail', 'argent', 'amour', 'relation',
  'deutung', 'wahrsagung', 'deute für mich', 'sollte ich', 'kann ich', 'werde ich', 'habe ich', 'wann', 'wie', 'arbeit', 'geld', 'liebe', 'beziehung',
  '占って', '占ってください', '占い', '易占', '見てください', 'どうすれば', 'どうしたら', 'どうなる', 'できますか', 'でしょうか', 'いつ', 'かな', '仕事', '転職', 'お金', '恋愛', '結婚',
  '점쳐', '점쳐 주세요', '운세 봐주세요', '운세', '괘', '어떻게', '할까요', '가능할까요', '언제', '무엇', '어느', '직업', '이직', '돈', '연애', '결혼',
  'leitura', 'adivinhação', 'faça uma leitura', 'gostaria de saber', 'será que', 'devo', 'posso', 'poderei', 'quando', 'como', 'trabalho', 'dinheiro', 'amor', 'relacionamento',
  'гадание', 'предсказание', 'погадайте мне', 'можно ли', 'стоит ли', 'смогу ли', 'когда', 'как', 'почему', 'работа', 'деньги', 'любовь', 'отношения',
];

function canonicalRecognitionText(value: string, foldLatinAccents = false): string {
  const normalized = value.normalize('NFKC').replace(/[‘’‛`´]/g, "'").trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return foldLatinAccents ? normalized.normalize('NFD').replace(/\p{M}/gu, '') : normalized;
}

function containsRecognitionKeyword(source: string, keyword: string): boolean {
  const latinLike = /\p{Script=Latin}/u.test(keyword);
  const normalizedSource = canonicalRecognitionText(source, latinLike);
  const normalizedKeyword = canonicalRecognitionText(keyword, latinLike);
  if (!normalizedKeyword) return false;
  // Latin/Cyrillic words need token boundaries: `career` must not match part
  // of another word. CJK keywords intentionally keep substring semantics.
  if (/^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}' -]+$/u.test(normalizedKeyword)) {
    const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(normalizedSource);
  }
  return normalizedSource.includes(normalizedKeyword);
}

export const defaultSettings: AppSettings = {
  queue: {
    maxVisible: 4,
    maxTotal: 100,
    sameUserCooldownMinutes: 10,
    expireMinutes: 20,
    dedupeWindowSeconds: 10,
  },
  // A production reading starts from a real question.  Greetings, emoji,
  // compliments, and arbitrary chat must never consume the formal queue.
  moderation: { minChars: 4, maxChars: 280, treatAnyCommentAsQuestion: false, llmTimeoutMs: 12_000 },
  reading: { speechTargetSeconds: 30, watchdogMs: 300_000, externalRetryCount: 2 },
  meihua: { engine: 'MINGYU_CORE' },
  gifts: {
    enabled: true,
    entitlementExpireMinutes: 30,
    rules: [
      { id: 'rose-four-reading', enabled: true, giftId: '5655', giftName: 'Rose', minRepeatCount: 4, priority: 'HIGH', speechTargetSeconds: 30, leaderboardPoints: 1, requireStreakEnd: true },
    ],
  },
  engagement: {
    enabled: true,
    likeUnit: 10,
    likePoints: 1,
    commentPoints: 5,
    obsRankingLimit: 5,
    adminRankingLimit: 20,
    likeRules: [{ id: 'likes-100', enabled: true, label: '100 Likes', threshold: 100, priority: 'NORMAL', speechTargetSeconds: 30, grantExpireMinutes: 30, cooldownMinutes: 30 }],
    // Keywords can grant a viewer the right to ask next. A formal reading is
    // still created only after question moderation accepts a clear question.
    commentRules: [{ id: 'comment-reading', enabled: true, label: '多语言问题识别', keywords: defaultCommentKeywords, matchMode: 'CONTAINS', stripKeyword: false, priority: 'NORMAL', speechTargetSeconds: 30, queueExpireMinutes: 20, cooldownMinutes: 10 }],
  },
  overlay: {
    disclaimer: 'Traditional cultural entertainment only. Not professional advice.',
    contentLanguage: 'en',
    effects: { accentColor: '#e9b86e', backgroundOpacity: 0.82, glowIntensity: 0.65, animationStyle: 'smooth', particles: true },
    modules: {
      status: { enabled: true, width: 900, height: 120, fontScale: 1, backgroundOpacity: 0.82, maxItems: 1, idleBehavior: 'PREVIEW', titleText: 'LIVE STATUS', idleText: 'Waiting for the next viewer', showTitle: false, textColor: '#fff5d6', backgroundColor: '#0d0d11', brightness: 1, glowIntensity: .65, animationStyle: 'smooth' },
      current: { enabled: true, width: 900, height: 220, fontScale: 1, backgroundOpacity: 0.82, maxItems: 1, idleBehavior: 'HIDE', titleText: 'CURRENT QUESTION', idleText: 'Waiting for a question', showTitle: true, textColor: '#fff5d6', backgroundColor: '#0d0d11', brightness: 1, glowIntensity: .65, animationStyle: 'smooth' },
      hexagram: { enabled: true, width: 1040, height: 560, fontScale: 1, backgroundOpacity: 0.82, maxItems: 3, idleBehavior: 'PREVIEW', titleText: 'MEIHUA CAST', idleText: 'Waiting to cast', showTitle: false, textColor: '#fff5d6', backgroundColor: '#0d0d11', brightness: 1, glowIntensity: .65, animationStyle: 'smooth' },
      keywords: { enabled: true, width: 760, height: 100, fontScale: 1, backgroundOpacity: 0.82, maxItems: 5, idleBehavior: 'HIDE', titleText: 'KEY INSIGHTS', idleText: 'Insights will appear here', showTitle: false, textColor: '#fff5d6', backgroundColor: '#0d0d11', brightness: 1, glowIntensity: .65, animationStyle: 'smooth' },
      gift: { enabled: true, width: 760, height: 180, fontScale: 1, backgroundOpacity: 0.82, maxItems: 1, idleBehavior: 'PREVIEW', titleText: 'GIFT PRIORITY', idleText: 'Gift priority saved', showTitle: true, textColor: '#fff5d6', backgroundColor: '#321e0f', brightness: 1, glowIntensity: .8, animationStyle: 'energetic' },
      queue: { enabled: true, width: 520, height: 500, fontScale: 1, backgroundOpacity: 0.82, maxItems: 6, idleBehavior: 'PREVIEW', titleText: 'WAITING LIST', idleText: 'You could be next', showTitle: true, textColor: '#fff5d6', backgroundColor: '#0d0d11', brightness: 1, glowIntensity: .65, animationStyle: 'smooth' },
      subtitles: { enabled: true, width: 900, height: 180, fontScale: 1, backgroundOpacity: 0.82, maxItems: 1, idleBehavior: 'HIDE', titleText: '', idleText: '', showTitle: false, textColor: '#ffffff', backgroundColor: '#07080a', brightness: 1, glowIntensity: 0, animationStyle: 'minimal' },
      disclaimer: { enabled: true, width: 900, height: 60, fontScale: 1, backgroundOpacity: 0.68, maxItems: 1, idleBehavior: 'PREVIEW', titleText: '', idleText: 'Traditional cultural entertainment only. Not professional advice.', showTitle: false, textColor: '#d8cec0', backgroundColor: '#07080a', brightness: 1, glowIntensity: .2, animationStyle: 'minimal' },
      audio: { enabled: false, width: 160, height: 80, fontScale: 1, backgroundOpacity: 0, maxItems: 1, idleBehavior: 'HIDE', titleText: '', idleText: '', showTitle: false, textColor: '#fff5d6', backgroundColor: '#0d0d11', brightness: 1, glowIntensity: 0, animationStyle: 'minimal' },
    },
  },
  providers: {
    liveInput: { adapter: 'tikfinity', url: 'ws://127.0.0.1:21213/' },
    llm: { adapter: 'openai-compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    tts: {
      adapter: 'kokoro', baseUrl: 'http://127.0.0.1:9890', model: 'kokoro-v1.0.onnx',
      voiceId: 'af_heart', speed: 1, instructions: 'Warm, calm and measured. Speak naturally with clear pauses.',
      apiKeyEnv: 'TTS_API_KEY', reuseLlmKey: true,
      stability: 0.5, similarityBoost: 0.75, style: 0, speakerBoost: true,
      gptsovits: { baseUrl: 'http://127.0.0.1:9881', apiVersion: 'V3', voices: [] },
      kokoro: { baseUrl: 'http://127.0.0.1:9890', defaultVoice: 'af_heart' },
      accent: {
        baseUrl: 'http://127.0.0.1:9899',
        profiles: [
          { id: 'zh-cn-standard', country: 'CN', label: '中国普通话', locale: 'zh-CN', engine: 'openvoice-v2', enabled: true },
          { id: 'yue-hk', country: 'HK', label: '中国粤语', locale: 'yue-HK', engine: 'openvoice-v2', enabled: true },
          { id: 'en-us', country: 'US', label: '美国英语', locale: 'en-US', engine: 'openvoice-v2', enabled: true },
          { id: 'en-gb', country: 'GB', label: '英国英语', locale: 'en-GB', engine: 'openvoice-v2', enabled: true },
          { id: 'ja-jp', country: 'JP', label: '日本日语', locale: 'ja-JP', engine: 'openvoice-v2', enabled: true },
          { id: 'ko-kr', country: 'KR', label: '韩国韩语', locale: 'ko-KR', engine: 'openvoice-v2', enabled: true },
        ],
      },
      voiceCloneApi: {
        provider: 'aliyun',
        baseUrl: 'https://dashscope.aliyuncs.com',
        model: 'qwen-voice-enrollment',
        targetModel: 'qwen3.5-omni-plus',
        region: 'cn-beijing',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        aliyun: {
          baseUrl: 'https://dashscope.aliyuncs.com',
          clonePath: '/api/v1/services/audio/tts/customization', synthesizePath: '/compatible-mode/v1/chat/completions', synthesizeStatusPath: '', protocol: 'ALIYUN_QWEN_OMNI', publicBaseUrl: '', model: 'qwen-voice-enrollment', targetModel: 'qwen3.5-omni-plus',
          region: 'cn-beijing', apiKeyEnv: 'DASHSCOPE_API_KEY', workspaceId: '',
        },
        baidu: {
          baseUrl: 'https://open.xiling.baidu.com',
          clonePath: '/api/digitalhuman/open/v1/tts/clone/v2', synthesizePath: '/api/digitalhuman/open/v1/tts/text2audio/submit', synthesizeStatusPath: '/api/digitalhuman/open/v1/tts/text2audio/task', protocol: 'BAIDU_XILING', uploadPath: '/api/digitalhuman/open/v1/file/upload', uploadProviderType: 'OPEN_TTS_CLONE', model: 'quality_v2', targetModel: 'quality_v2',
          region: 'cn', apiKeyEnv: 'BAIDU_XILING_APP_KEY', accessTokenEnv: 'BAIDU_XILING_APP_KEY', appId: '',
        },
      },
      activeVoiceProfileId: undefined,
      voiceClones: [],
      voiceProfiles: [],
      baidu: { baseUrl: 'https://open.xiling.baidu.com', appId: '', accessTokenConfigured: false },
    },
    avatar: {
      // Video presentation is the production default.  VRM remains an
      // explicit development option and can never become a hidden fallback.
      adapter: 'none', url: 'http://127.0.0.1:3210', activeProfileId: undefined, profiles: [],
      cloneApi: {
        provider: 'aliyun',
        baseUrl: 'https://avatar.cn-zhangjiakou.aliyuncs.com',
        model: 'StartInstance',
        region: 'cn-zhangjiakou',
        apiKeyEnv: 'ALIYUN_ACCESS_KEY_SECRET',
        tenantId: '',
        appId: '',
        instanceId: '',
        projectId: '',
        aliyun: {
          baseUrl: 'https://avatar.cn-zhangjiakou.aliyuncs.com',
          clonePath: '/?Action=Create2dAvatar', renderPath: '/?Action=StartInstance', statusPath: '/?Action=QueryAvatar', healthPath: '/?Action=QueryAvatarList', model: 'StartInstance', protocol: 'ALIYUN_AVATAR_OPENAPI', publicBaseUrl: '', portraitUrl: '', region: 'cn-zhangjiakou',
          apiKeyEnv: 'ALIYUN_ACCESS_KEY_SECRET', accessKeyIdEnv: 'ALIYUN_ACCESS_KEY_ID', accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET',
          tenantId: '', appId: '', instanceId: '', projectId: '', streamMode: 'RTC',
        },
        baidu: {
          baseUrl: 'https://open.xiling.baidu.com',
          clonePath: '/api/digitalhuman/open/v1/figure/lite2d/train', renderPath: '/api/digitalhuman/open/v1/liveRooms', statusPath: '/api/digitalhuman/open/v1/figure/lite2d/query', healthPath: '/api/digitalhuman/open/v1/figure/lite2d/query?systemFigure=true&pageSize=1', protocol: 'BAIDU_XILING', uploadPath: '/api/digitalhuman/open/v1/file/upload', uploadProviderType: 'OPEN_CUSTOMIZATION_2D_GENERAL', customizeType: 'LITE_2D_GENERAL', gender: 'UNKNOWN', keepBackground: false, webSocketPath: '/live/2d/ws', model: 'quality_v2', region: 'cn',
          apiKeyEnv: 'BAIDU_XILING_APP_KEY', appId: '', streamMode: 'HTTP_STREAM',
        },
      },
      baidu: { baseUrl: 'https://open.xiling.baidu.com', appId: '', accessTokenConfigured: false },
    },
  },
  audioBus: {
    enabled: true,
    outputDeviceName: 'CABLE Input (VB-Audio Virtual Cable)',
    requireExactDevice: true,
    muteBrowserAudio: true,
    sampleRate: 48_000,
  },
  presentation: {
    mode: 'VIDEO_ONCE',
    profiles: [],
    fallbackPolicy: 'VIDEO',
  },
};

type ActiveReading = {
  readingId: string;
  controller: AbortController;
  abortReason?: 'SKIP' | 'TIMEOUT' | 'AUDIO_FAILED';
};

type ReplayState = {
  reading: Reading;
  stage: 'CASTING' | 'INTERPRETING' | 'SPEAKING' | 'FINISH';
  controller: AbortController;
};

type IngestOptions = {
  bypassUserLimits?: boolean;
  qualification?: NonNullable<Reading['qualification']>;
  queueExpireMinutes?: number;
  speechTargetSeconds?: number;
  /** Preserve the viewer's exact comment when a qualified keyword is expanded into a clear question. */
  rawQuestion?: string;
};

export type GiftIngestResult = {
  accepted: boolean;
  action: 'IGNORED' | 'PENDING_QUESTION' | 'APPLIED_TO_QUEUE';
  reason?: string;
  entitlement?: GiftEntitlement;
  readingId?: string;
};

class PipelineAbortedError extends Error {
  constructor() {
    super('Pipeline aborted');
    this.name = 'PipelineAbortedError';
  }
}

class AudioPlaybackError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AudioPlaybackError';
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new PipelineAbortedError());
    }, { once: true });
  });
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(numberValue)));
}

function clampFloat(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(maximum, Math.max(minimum, numberValue));
}

function asText(value: unknown, fallback: string, maximum = 240): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : fallback;
}

function sanitizeExternalProviderUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blockedIpv4 = /^(?:127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
    const blockedIpv6 = host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
    if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.local') || blockedIpv4.test(host) || blockedIpv6) return '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function providerOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return ''; }
}

const priorityWeight: Record<Reading['priority'], number> = { NORMAL: 1, HIGH: 2, MANUAL: 3 };

function strongestPriority(left: Reading['priority'], right: Reading['priority']): Reading['priority'] {
  return priorityWeight[left] >= priorityWeight[right] ? left : right;
}

function normalizeGiftRules(value: unknown): GiftRule[] {
  if (!Array.isArray(value)) return defaultSettings.gifts.rules;
  const rules = value.slice(0, 200).flatMap<GiftRule>((rule, index) => {
    if (!rule || typeof rule !== 'object') return [];
    const candidate = rule as Partial<GiftRule>;
    const giftName = typeof candidate.giftName === 'string' ? candidate.giftName.trim().slice(0, 80) : '';
    if (!giftName) return [];
    return [{
      id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim().slice(0, 80) : `gift-rule-${index + 1}`,
      enabled: candidate.enabled !== false,
      giftId: typeof candidate.giftId === 'string' && candidate.giftId.trim() ? candidate.giftId.trim().slice(0, 80) : undefined,
      giftName,
      minRepeatCount: clamp(candidate.minRepeatCount, 1, 1, 9_999),
      priority: candidate.priority === 'MANUAL' || candidate.priority === 'HIGH' ? candidate.priority : 'NORMAL' as const,
      speechTargetSeconds: clamp(candidate.speechTargetSeconds, defaultSettings.reading.speechTargetSeconds, 10, 120),
      leaderboardPoints: clamp(candidate.leaderboardPoints, 1, 0, 1_000_000),
      requireStreakEnd: candidate.requireStreakEnd === true ? true : false,
    }];
  });
  return rules;
}

function normalizeLikeRules(value: unknown): LikeRule[] {
  if (!Array.isArray(value)) return defaultSettings.engagement.likeRules;
  return value.slice(0, 20).flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const rule = raw as Partial<LikeRule>;
    const threshold = clamp(rule.threshold, 100, 1, 100_000);
    return [{
      id: asText(rule.id, `like-rule-${index + 1}`, 80), enabled: rule.enabled !== false,
      // The simplified control only exposes the threshold. Keep the visible
      // qualification copy deterministic so it cannot display an old count.
      label: `累计点赞 ${threshold} 次`,
      threshold,
      priority: rule.priority === 'HIGH' || rule.priority === 'MANUAL' ? rule.priority : 'NORMAL' as const,
      speechTargetSeconds: clamp(rule.speechTargetSeconds, defaultSettings.reading.speechTargetSeconds, 10, 120),
      grantExpireMinutes: clamp(rule.grantExpireMinutes, 30, 1, 720), cooldownMinutes: clamp(rule.cooldownMinutes, 30, 0, 1_440),
    }];
  });
}

function normalizeCommentRules(value: unknown): CommentRule[] {
  if (!Array.isArray(value) || value.length === 0) return defaultSettings.engagement.commentRules;
  // Migrate the old four-keyword default in-place. This matters for an
  // existing SQLite installation: changing defaultSettings alone would leave
  // the old restrictive rule persisted forever.
  const first = value[0] && typeof value[0] === 'object' ? value[0] as Partial<CommentRule> : undefined;
  const storedKeywords = Array.isArray(first?.keywords) ? first.keywords.map((item) => String(item).trim().toLocaleLowerCase()).filter(Boolean) : [];
  const legacyKeywords = ['reading', 'fortune', '测算', '占卜'].sort();
  const looksLikeTestRule = value.length === 1 && storedKeywords.length === 1 && storedKeywords[0] === 'a'
    && (first?.id === 'any-comment' || first?.label === '任意评论');
  // Broad interrogation words and a bare question mark were temporarily used
  // as automatic queue triggers. They match ordinary chat and must be
  // replaced during migration with recognition-only question vocabulary.
  const hasUnsafeBroadKeyword = storedKeywords.length <= 25 && storedKeywords.some((keyword) => [
    'a', '?', '？', 'what', 'when', 'where', 'why', 'how', 'should i', 'can i',
    'will i', 'is it', 'question', 'job', 'work', 'money', 'love', 'career',
  ].includes(keyword));
  if ((value.length === 1 && storedKeywords.length === legacyKeywords.length && [...storedKeywords].sort().join('|') === legacyKeywords.join('|')) || looksLikeTestRule || hasUnsafeBroadKeyword) {
    return defaultSettings.engagement.commentRules;
  }
  return value.slice(0, 30).flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const rule = raw as Partial<CommentRule>;
    const keywords = Array.isArray(rule.keywords) ? [...new Set(rule.keywords.map((item) => String(item).trim()).filter(Boolean))] : [];
    // 空白设置：关键词留空 = 匹配任何评论（保留规则而不是丢弃）
    if (!keywords.length) {
      return [{
        id: asText(rule.id, `comment-rule-${index + 1}`, 80), enabled: rule.enabled !== false,
        label: asText(rule.label, '任意评论', 80), keywords: [],
        matchMode: 'CONTAINS' as const, stripKeyword: false,
        priority: rule.priority === 'HIGH' || rule.priority === 'MANUAL' ? rule.priority : 'NORMAL' as const,
        speechTargetSeconds: clamp(rule.speechTargetSeconds, defaultSettings.reading.speechTargetSeconds, 10, 120),
        queueExpireMinutes: clamp(rule.queueExpireMinutes, defaultSettings.queue.expireMinutes, 1, 180),
        cooldownMinutes: clamp(rule.cooldownMinutes, 0, 0, 1_440),
      }];
    }
    return [{
      id: asText(rule.id, `comment-rule-${index + 1}`, 80), enabled: rule.enabled !== false,
      label: asText(rule.label, '评论关键词排队', 80), keywords,
      matchMode: rule.matchMode === 'EXACT' || rule.matchMode === 'REGEX' ? rule.matchMode : 'CONTAINS' as const,
      stripKeyword: rule.stripKeyword !== false,
      priority: rule.priority === 'HIGH' || rule.priority === 'MANUAL' ? rule.priority : 'NORMAL' as const,
      speechTargetSeconds: clamp(rule.speechTargetSeconds, defaultSettings.reading.speechTargetSeconds, 10, 120),
      queueExpireMinutes: clamp(rule.queueExpireMinutes, defaultSettings.queue.expireMinutes, 1, 180),
      cooldownMinutes: clamp(rule.cooldownMinutes, defaultSettings.queue.sameUserCooldownMinutes, 0, 1_440),
    }];
  });
}

/** Local service URL: loopback/LAN addresses are allowed (unlike external providers). */
function normalizeLocalServiceUrl(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function normalizeGptSoVits(input: unknown): AppSettings['providers']['tts']['gptsovits'] {
  const raw = (input ?? {}) as Partial<AppSettings['providers']['tts']['gptsovits']>;
  const apiVersion = raw.apiVersion === 'V2' ? 'V2' : raw.apiVersion === 'CHANYIN_QFTTS' ? 'CHANYIN_QFTTS' : 'V3';
  const normalizedBaseUrl = normalizeLocalServiceUrl(raw.baseUrl, defaultSettings.providers.tts.gptsovits.baseUrl);
  const baseUrl = apiVersion === 'V3' && normalizedBaseUrl === 'http://127.0.0.1:9880'
    ? defaultSettings.providers.tts.gptsovits.baseUrl
    : normalizedBaseUrl;
  const voices = Array.isArray(raw.voices) ? raw.voices.slice(0, 50).flatMap<GptSoVitsVoice>((voice, index) => {
    if (!voice || typeof voice !== 'object') return [];
    const candidate = voice as Partial<GptSoVitsVoice>;
    const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim().slice(0, 64) : '';
    const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim().slice(0, 80) : '';
    const refAudioPath = typeof candidate.refAudioPath === 'string' && candidate.refAudioPath.trim() ? candidate.refAudioPath.trim() : '';
    if (!id || !name || !refAudioPath) return [];
    const refLanguage: GptSoVitsRefLanguage = candidate.refLanguage === 'en' || candidate.refLanguage === 'ja' || candidate.refLanguage === 'ko' || candidate.refLanguage === 'yue' ? candidate.refLanguage : 'zh';
    return [{
      id, name, refAudioPath,
      refText: typeof candidate.refText === 'string' ? candidate.refText.trim().slice(0, 400) : '',
      refLanguage,
      sourceLanguage: candidate.sourceLanguage === 'en' || candidate.sourceLanguage === 'ja' || candidate.sourceLanguage === 'ko' || candidate.sourceLanguage === 'yue' ? candidate.sourceLanguage : refLanguage,
      targetLocale: normalizeVoiceTargetLocale(candidate.targetLocale, refLanguage === 'zh' ? 'zh-CN' : refLanguage === 'en' ? 'en-US' : refLanguage === 'ja' ? 'ja-JP' : refLanguage === 'ko' ? 'ko-KR' : 'yue-HK'),
      targetCountry: typeof candidate.targetCountry === 'string' ? candidate.targetCountry.trim().slice(0, 40) : undefined,
      accentProfileId: typeof candidate.accentProfileId === 'string' ? candidate.accentProfileId.trim().slice(0, 80) : undefined,
      cloneMode: candidate.cloneMode === 'COUNTRY_ACCENT' ? 'COUNTRY_ACCENT' : 'TIMBRE_ONLY',
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    }];
  }) : [];
  return {
    baseUrl,
    apiVersion,
    voices,
  };
}

const supportedVoiceTargetLocales: VoiceTargetLocale[] = ['zh-CN', 'yue-HK', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR'];

function normalizeVoiceTargetLocale(value: unknown, fallback: VoiceTargetLocale = 'zh-CN'): VoiceTargetLocale {
  return supportedVoiceTargetLocales.includes(String(value) as VoiceTargetLocale) ? String(value) as VoiceTargetLocale : fallback;
}

function localeToContentLanguage(locale: VoiceTargetLocale): AppSettings['overlay']['contentLanguage'] {
  if (locale === 'zh-CN' || locale === 'yue-HK') return 'zh-CN';
  if (locale.startsWith('en-')) return 'en';
  if (locale.startsWith('ja-')) return 'ja';
  if (locale.startsWith('ko-')) return 'ko';
  if (locale.startsWith('es-')) return 'es';
  if (locale.startsWith('fr-')) return 'fr';
  return 'en';
}

function contentLanguageToVoiceLocale(language: AppSettings['overlay']['contentLanguage']): VoiceTargetLocale {
  if (language === 'en') return 'en-US';
  if (language === 'ja') return 'ja-JP';
  if (language === 'ko') return 'ko-KR';
  if (language === 'es') return 'es-ES';
  if (language === 'fr') return 'fr-FR';
  return 'zh-CN';
}

const supportedProfileLanguages = new Set(['en', 'zh-CN', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru', 'yue', 'ar']);

function normalizeVoiceClones(value: unknown): VoiceClone[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Partial<VoiceClone>;
    const id = asText(raw.id, '', 80);
    const name = asText(raw.name, '', 80);
    if (!id || !name) return [];
    const provider = raw.provider === 'BAIDU_LITE' || raw.provider === 'BAIDU_XILING' || raw.provider === 'ALIYUN_COSYVOICE' || raw.provider === 'LEGACY' ? raw.provider : 'GPT_SOVITS_V3';
    const sourceLanguage: GptSoVitsRefLanguage = raw.sourceLanguage === 'en' || raw.sourceLanguage === 'ja' || raw.sourceLanguage === 'ko' || raw.sourceLanguage === 'yue' ? raw.sourceLanguage : 'zh';
    const allowedStatuses = new Set(['PROCESSING', 'NEEDS_REVIEW', 'READY', 'DISABLED', 'FAILED', 'DRAFT', 'VALIDATING', 'REJECTED']);
    const status = allowedStatuses.has(String(raw.status)) ? raw.status! : 'DRAFT';
    return [{
      id, name, provider,
      referenceFileName: asText(raw.referenceFileName, '', 160),
      referenceText: typeof raw.referenceText === 'string' ? raw.referenceText.trim().slice(0, 500) : '',
      sourceLanguage, authorizationConfirmed: raw.authorizationConfirmed === true,
      providerCloneId: typeof raw.providerCloneId === 'string' ? raw.providerCloneId.trim().slice(0, 160) : undefined,
      status, createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
      updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
      lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 500) : undefined,
    }];
  });
}

function normalizeVoiceProfiles(value: unknown, voices: GptSoVitsVoice[]): VoiceProfile[] {
  const source = Array.isArray(value) ? value : voices.map((voice) => ({
    id: voice.id, voiceId: voice.id, provider: 'gptsovits-v3', name: voice.name,
    language: localeToContentLanguage(voice.targetLocale ?? (voice.refLanguage === 'zh' ? 'zh-CN' : voice.refLanguage as VoiceTargetLocale)),
    sourceLanguage: voice.sourceLanguage ?? voice.refLanguage, targetLocale: voice.targetLocale, targetCountry: voice.targetCountry,
    accentProfileId: voice.accentProfileId, cloneMode: voice.cloneMode ?? 'TIMBRE_ONLY', status: 'DRAFT', createdAt: voice.createdAt, updatedAt: voice.createdAt,
  }));
  return source.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Partial<VoiceProfile>;
    const voiceId = asText(raw.voiceId, '', 160);
    const name = asText(raw.name, '', 80);
    if (!voiceId || !name) return [];
    const provider: VoiceProfile['provider'] = raw.provider === 'baidu-lite' || raw.provider === 'baidu-xiling' || raw.provider === 'aliyun-cosyvoice' || raw.provider === 'elevenlabs' || raw.provider === 'openai-custom' || raw.provider === 'legacy' ? raw.provider : 'gptsovits-v3';
    const language = supportedProfileLanguages.has(String(raw.language)) ? raw.language : 'zh-CN';
    const allowedStatuses = new Set(['PROCESSING', 'NEEDS_REVIEW', 'READY', 'DISABLED', 'FAILED', 'DRAFT', 'VALIDATING', 'REJECTED']);
    const status = allowedStatuses.has(String(raw.status)) ? raw.status! : 'DRAFT';
    return [{ ...raw, id: asText(raw.id, voiceId, 80), voiceId, name, provider, language, status,
      sourceLanguage: raw.sourceLanguage === 'en' || raw.sourceLanguage === 'ja' || raw.sourceLanguage === 'ko' || raw.sourceLanguage === 'yue' ? raw.sourceLanguage : undefined,
      targetLocale: normalizeVoiceTargetLocale(raw.targetLocale, language === 'zh-CN' ? 'zh-CN' : language === 'en' ? 'en-US' : language === 'ja' ? 'ja-JP' : language === 'ko' ? 'ko-KR' : 'zh-CN'),
      targetCountry: typeof raw.targetCountry === 'string' ? raw.targetCountry.trim().slice(0, 40) : undefined,
      accentProfileId: typeof raw.accentProfileId === 'string' ? raw.accentProfileId.trim().slice(0, 80) : undefined,
      cloneMode: raw.cloneMode === 'COUNTRY_ACCENT' ? 'COUNTRY_ACCENT' : 'TIMBRE_ONLY',
      speed: clampFloat(raw.speed, 1, 0.6, 1.6), testText: typeof raw.testText === 'string' ? raw.testText.trim().slice(0, 300) : undefined,
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(), updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
    } as VoiceProfile];
  });
}

function normalizeAvatarProfiles(value: unknown): AvatarProfile[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Partial<AvatarProfile>;
    const id = asText(raw.id, '', 80);
    const name = asText(raw.name, '', 80);
    if (!id || !name) return [];
    const provider = raw.provider === 'BAIDU_CLOUD' ? 'BAIDU_CLOUD' : raw.provider === 'ALIYUN_CLOUD' ? 'ALIYUN_CLOUD' : raw.provider === 'LOCAL_VIDEO' ? 'LOCAL_VIDEO' : 'LOCAL_VRM';
    const allowedStatuses = new Set(['UPLOADED', 'VALIDATING', 'PREPARING', 'NEEDS_REVIEW', 'READY', 'DISABLED', 'FAILED']);
    const legacyStatus = String(raw.status);
    const status = allowedStatuses.has(legacyStatus) ? raw.status! : legacyStatus === 'DRAFT' ? 'UPLOADED' : legacyStatus === 'REJECTED' ? 'FAILED' : 'UPLOADED';
    return [{ id, name, provider, status,
      sourceAssetId: typeof raw.sourceAssetId === 'string' ? raw.sourceAssetId.slice(0, 100) : undefined,
      preparedAvatarId: typeof raw.preparedAvatarId === 'string' ? raw.preparedAvatarId.slice(0, 100) : undefined,
      modelAssetId: typeof raw.modelAssetId === 'string' ? raw.modelAssetId.slice(0, 100) : undefined,
      previewAssetId: typeof raw.previewAssetId === 'string' ? raw.previewAssetId.slice(0, 100) : undefined,
      cloudFigureId: typeof raw.cloudFigureId === 'string' ? raw.cloudFigureId.slice(0, 160) : undefined,
      cloudVideoUrl: typeof raw.cloudVideoUrl === 'string' ? raw.cloudVideoUrl.slice(0, 1000) : undefined,
      maxTextureSize: raw.maxTextureSize === 1024 ? 1024 : 2048, renderFps: 30,
      chromaColor: typeof raw.chromaColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.chromaColor) ? raw.chromaColor : '#00ff00',
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(), updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
      lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 500) : undefined,
      version: clamp(raw.version, 1, 1, 10_000), developmentOnly: raw.developmentOnly === true,
      authorizationConfirmed: raw.authorizationConfirmed === true,
      actionBindings: raw.actionBindings,
    }];
  });
}

type VoiceCloudConfig = NonNullable<NonNullable<AppSettings['providers']['tts']['voiceCloneApi']>['aliyun']>;
type AvatarCloudConfig = NonNullable<NonNullable<AppSettings['providers']['avatar']['cloneApi']>['aliyun']>;

function normalizeVoiceCloudConfig(value: unknown, fallback: VoiceCloudConfig): VoiceCloudConfig {
  const raw = value && typeof value === 'object' ? value as Partial<VoiceCloudConfig> : {};
  // The first bundle shipped the Alibaba defaults as the legacy CosyVoice
  // enrollment contract. Migrate only that exact untouched default; an
  // explicitly customized legacy endpoint remains available for compatibility.
  const legacyAlibabaDefault = raw.protocol === 'ALIYUN_DASHSCOPE'
    && raw.model === 'voice-enrollment'
    && raw.targetModel === 'cosyvoice-v3.5-plus'
    && raw.clonePath === '/api/v1/services/audio/tts/customization'
    && raw.synthesizePath === '/api/v1/services/audio/tts/SpeechSynthesizer'
    && !String(raw.publicBaseUrl ?? '').trim()
    && !String(raw.workspaceId ?? '').trim();
  const source: Partial<VoiceCloudConfig> = legacyAlibabaDefault
    ? { ...raw, ...fallback, baseUrl: raw.baseUrl || fallback.baseUrl, apiKeyEnv: raw.apiKeyEnv || fallback.apiKeyEnv }
    : raw;
  return {
    baseUrl: sanitizeExternalProviderUrl(source.baseUrl) || fallback.baseUrl,
    clonePath: asText(source.clonePath, fallback.clonePath, 200),
    synthesizePath: asText(source.synthesizePath, fallback.synthesizePath, 200),
    synthesizeStatusPath: typeof source.synthesizeStatusPath === 'string' ? source.synthesizeStatusPath.trim().slice(0, 200) : fallback.synthesizeStatusPath,
    protocol: source.protocol === 'ALIYUN_DASHSCOPE' || source.protocol === 'ALIYUN_QWEN_OMNI' || source.protocol === 'BAIDU_XILING' ? source.protocol : fallback.protocol ?? 'GENERIC_JSON',
    publicBaseUrl: typeof source.publicBaseUrl === 'string' ? sanitizeExternalProviderUrl(source.publicBaseUrl) : fallback.publicBaseUrl,
    uploadPath: typeof source.uploadPath === 'string' ? source.uploadPath.trim().slice(0, 200) : fallback.uploadPath,
    uploadProviderType: typeof source.uploadProviderType === 'string' ? source.uploadProviderType.trim().slice(0, 100) : fallback.uploadProviderType,
    model: asText(source.model, fallback.model, 120),
    targetModel: asText(source.targetModel, fallback.targetModel, 120),
    region: asText(source.region, fallback.region, 80),
    apiKeyEnv: asText(source.apiKeyEnv, fallback.apiKeyEnv, 120),
    appId: typeof source.appId === 'string' ? source.appId.trim().slice(0, 160) : fallback.appId,
    workspaceId: typeof source.workspaceId === 'string' ? source.workspaceId.trim().slice(0, 160) : fallback.workspaceId,
    accessTokenEnv: typeof source.accessTokenEnv === 'string' ? source.accessTokenEnv.trim().slice(0, 120) : fallback.accessTokenEnv,
  };
}

function normalizeAvatarCloudConfig(value: unknown, fallback: AvatarCloudConfig): AvatarCloudConfig {
  const raw = value && typeof value === 'object' ? value as Partial<AvatarCloudConfig> : {};
  return {
    baseUrl: sanitizeExternalProviderUrl(raw.baseUrl) || fallback.baseUrl,
    clonePath: asText(raw.clonePath, fallback.clonePath, 200),
    renderPath: asText(raw.renderPath, fallback.renderPath, 200),
    statusPath: typeof raw.statusPath === 'string' ? raw.statusPath.trim().slice(0, 200) : fallback.statusPath,
    healthPath: typeof raw.healthPath === 'string' ? raw.healthPath.trim().slice(0, 200) : fallback.healthPath,
    protocol: raw.protocol === 'ALIYUN_AVATAR_OPENAPI' || raw.protocol === 'BAIDU_XILING' ? raw.protocol : fallback.protocol ?? 'GENERIC_JSON',
    publicBaseUrl: typeof raw.publicBaseUrl === 'string' ? sanitizeExternalProviderUrl(raw.publicBaseUrl) : fallback.publicBaseUrl,
    portraitUrl: typeof raw.portraitUrl === 'string' ? raw.portraitUrl.trim().slice(0, 1_000) : fallback.portraitUrl,
    uploadPath: typeof raw.uploadPath === 'string' ? raw.uploadPath.trim().slice(0, 200) : fallback.uploadPath,
    uploadProviderType: typeof raw.uploadProviderType === 'string' ? raw.uploadProviderType.trim().slice(0, 100) : fallback.uploadProviderType,
    customizeType: raw.customizeType === 'LITE_2D_PERSONAL' ? 'LITE_2D_PERSONAL' : fallback.customizeType ?? 'LITE_2D_GENERAL',
    gender: raw.gender === 'MALE' || raw.gender === 'FEMALE' ? raw.gender : fallback.gender ?? 'UNKNOWN',
    keepBackground: raw.keepBackground === true,
    webSocketPath: typeof raw.webSocketPath === 'string' ? raw.webSocketPath.trim().slice(0, 200) : fallback.webSocketPath,
    model: asText(raw.model, fallback.model, 120),
    region: asText(raw.region, fallback.region, 80),
    apiKeyEnv: asText(raw.apiKeyEnv, fallback.apiKeyEnv, 120),
    accessKeyIdEnv: typeof raw.accessKeyIdEnv === 'string' ? raw.accessKeyIdEnv.trim().slice(0, 120) : fallback.accessKeyIdEnv,
    accessKeySecretEnv: typeof raw.accessKeySecretEnv === 'string' ? raw.accessKeySecretEnv.trim().slice(0, 120) : fallback.accessKeySecretEnv,
    appId: typeof raw.appId === 'string' ? raw.appId.trim().slice(0, 160) : fallback.appId,
    tenantId: typeof raw.tenantId === 'string' ? raw.tenantId.trim().slice(0, 160) : fallback.tenantId,
    instanceId: typeof raw.instanceId === 'string' ? raw.instanceId.trim().slice(0, 160) : fallback.instanceId,
    projectId: typeof raw.projectId === 'string' ? raw.projectId.trim().slice(0, 160) : fallback.projectId,
    streamMode: raw.streamMode === 'RTC' ? 'RTC' : 'HTTP_STREAM',
  };
}

const digitalHumanActions: AvatarAction[] = ['IDLE', 'QUESTION_RECEIVED', 'CASTING', 'THINKING', 'SPEAKING_NEUTRAL', 'SPEAKING_EMPHASIS', 'THANK_GIFT', 'FINISH', 'ERROR_RECOVER'];

function defaultAvatarActionBindings(): Partial<Record<AvatarAction, AvatarActionBinding>> {
  return Object.fromEntries(digitalHumanActions.map((action) => [action, {
    action, playback: action === 'IDLE' || action === 'THINKING' ? 'LOOP' : 'ONCE', minDurationMs: 800,
    transitionInMs: 180, transitionOutMs: 180,
    fallbackAction: action === 'IDLE' ? 'IDLE' : action === 'SPEAKING_EMPHASIS' ? 'SPEAKING_NEUTRAL' : 'IDLE',
  }])) as Partial<Record<AvatarAction, AvatarActionBinding>>;
}

function createDefaultDigitalHumanPreset(): DigitalHumanPreset {
  const now = Date.now();
  return { id: randomUUID(), name: '默认直播方案', language: 'en', speed: 1, emotion: 'CALM', lipStrength: 1,
    mouthCloseThreshold: 0.08, audioVideoOffsetMs: 0, status: 'ACTIVE', version: 1, createdAt: now, updatedAt: now, publishedAt: now };
}

interface PreparedDigitalHumanSegment {
  cacheKey: string;
  text: string;
  audioFilePath: string;
  audioPublicPath?: string;
  durationMs: number;
  outputAssetId?: string;
  mediaUrl?: string;
  mediaKind?: 'VIDEO_URL' | 'WEBRTC';
  rtc?: AvatarRtcConnection;
}

export function splitDigitalHumanSentences(text: string, maxCharacters = 220): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^。！？.!?]+[。！？.!?]?/gu)?.map((part) => part.trim()).filter(Boolean) ?? [normalized];
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxCharacters) chunks.push(sentence);
    else for (let offset = 0; offset < sentence.length; offset += maxCharacters) chunks.push(sentence.slice(offset, offset + maxCharacters));
  }
  const result: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const current = chunks[index];
    const next = chunks[index + 1];
    if (current.length < 18 && next && current.length + next.length + 1 <= maxCharacters) {
      result.push(`${current} ${next}`);
      index += 1;
    } else if (current.length < 18 && result.length && result[result.length - 1].length + current.length + 1 <= maxCharacters) {
      result[result.length - 1] = `${result[result.length - 1]} ${current}`;
    } else result.push(current);
  }
  return result;
}

function normalizeSettings(input: AppSettingsPatch): AppSettings {
  const queue: Partial<AppSettings['queue']> = input.queue ?? {};
  const moderation: Partial<AppSettings['moderation']> = input.moderation ?? {};
  const reading: Partial<AppSettings['reading']> = input.reading ?? {};
  const meihua: Partial<AppSettings['meihua']> = input.meihua ?? {};
  const gifts: Partial<AppSettings['gifts']> = input.gifts ?? {};
  const engagement: Partial<AppSettings['engagement']> = input.engagement ?? {};
  const overlay = input.overlay ?? {};
  const effects = overlay.effects ?? {};
  const providers = input.providers ?? {};
  const liveInput: Partial<AppSettings['providers']['liveInput']> = providers.liveInput ?? {};
  const llm: Partial<AppSettings['providers']['llm']> = providers.llm ?? {};
  const tts: Partial<AppSettings['providers']['tts']> = providers.tts ?? {};
  const avatar: Partial<AppSettings['providers']['avatar']> = providers.avatar ?? {};
  const gptsovits = normalizeGptSoVits(tts.gptsovits);
  const accentInput = tts.accent ?? defaultSettings.providers.tts.accent!;
  const voiceCloneApi = tts.voiceCloneApi ?? defaultSettings.providers.tts.voiceCloneApi!;
  const avatarCloneApi = avatar.cloneApi ?? defaultSettings.providers.avatar.cloneApi!;
  const voiceAliyun = normalizeVoiceCloudConfig(voiceCloneApi.aliyun ?? voiceCloneApi, defaultSettings.providers.tts.voiceCloneApi!.aliyun!);
  const voiceBaidu = normalizeVoiceCloudConfig(voiceCloneApi.baidu, defaultSettings.providers.tts.voiceCloneApi!.baidu!);
  const avatarAliyun = normalizeAvatarCloudConfig(avatarCloneApi.aliyun ?? avatarCloneApi, defaultSettings.providers.avatar.cloneApi!.aliyun!);
  const avatarBaidu = normalizeAvatarCloudConfig(avatarCloneApi.baidu, defaultSettings.providers.avatar.cloneApi!.baidu!);
  // Migrate the untouched pre-cloud default to Alibaba Cloud. Explicit custom
  // rule-based settings remain untouched.
  const legacyBlankLlm = llm.adapter === 'rule-based' && !String(llm.baseUrl ?? '').trim() && !String(llm.model ?? '').trim();
  const accentProfiles = Array.isArray(accentInput.profiles) ? accentInput.profiles.slice(0, 50).flatMap<VoiceAccentProfile>((profile) => {
    if (!profile || typeof profile !== 'object') return [];
    const candidate = profile as Partial<VoiceAccentProfile>;
    const locale = normalizeVoiceTargetLocale(candidate.locale);
    const id = asText(candidate.id, '', 80);
    if (!id || !asText(candidate.label, '', 80)) return [];
    return [{ id, country: asText(candidate.country, 'UN', 40), label: asText(candidate.label, id, 80), locale,
      engine: 'openvoice-v2' as const, enabled: candidate.enabled !== false }];
  }) : defaultSettings.providers.tts.accent!.profiles;
  const voiceProfiles = normalizeVoiceProfiles(tts.voiceProfiles, gptsovits.voices);
  const avatarProfiles = normalizeAvatarProfiles(avatar.profiles);
  const audioBus = input.audioBus ?? {};
  const presentationInput = input.presentation ?? {};
  const presentationProfiles = Array.isArray(presentationInput.profiles)
    ? presentationInput.profiles.slice(0, 20).flatMap<VideoPresentationProfile>((profile) => {
      if (!profile || typeof profile !== 'object') return [];
      const candidate = profile as Partial<VideoPresentationProfile>;
      const id = asText(candidate.id, '', 100);
      const assetId = asText(candidate.assetId, '', 100);
      if (!id || !assetId) return [];
      const status: VideoPresentationProfile['status'] = candidate.status === 'READY' || candidate.status === 'DISABLED' || candidate.status === 'FAILED' || candidate.status === 'VALIDATING' ? candidate.status : 'UPLOADED';
      const playback = candidate.playback === 'ONCE' ? 'ONCE' : 'LOOP';
      const fit = candidate.fit === 'CONTAIN' ? 'CONTAIN' : 'COVER';
      const durationMs = Number(candidate.durationMs);
      return [{
        id,
        name: asText(candidate.name, '预录视频', 80),
        assetId,
        status,
        playback,
        fit,
        durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : undefined,
        lastError: typeof candidate.lastError === 'string' ? candidate.lastError.slice(0, 500) : undefined,
        createdAt: Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(candidate.updatedAt)) ? Number(candidate.updatedAt) : Date.now(),
      }];
    })
    : [];
  const validPresentationProfileIds = new Set(presentationProfiles.map((profile) => profile.id));
  const presentationMode: PresentationMode = presentationInput.mode === 'VIDEO_LOOP' || presentationInput.mode === 'DIGITAL_HUMAN' || presentationInput.mode === 'AUDIO_ONLY' ? presentationInput.mode : 'VIDEO_ONCE';
  const presentation: PresentationSettings = {
    mode: presentationMode,
    profiles: presentationProfiles,
    activeVideoProfileId: typeof presentationInput.activeVideoProfileId === 'string' && validPresentationProfileIds.has(presentationInput.activeVideoProfileId) ? presentationInput.activeVideoProfileId : undefined,
    fallbackVideoProfileId: typeof presentationInput.fallbackVideoProfileId === 'string' && validPresentationProfileIds.has(presentationInput.fallbackVideoProfileId) ? presentationInput.fallbackVideoProfileId : undefined,
    fallbackPolicy: presentationInput.fallbackPolicy === 'STRICT' || presentationInput.fallbackPolicy === 'AUDIO_ONLY' ? presentationInput.fallbackPolicy : 'VIDEO',
  };
  return {
    queue: {
      maxVisible: clamp(queue.maxVisible, defaultSettings.queue.maxVisible, 1, 12),
      maxTotal: clamp(queue.maxTotal, defaultSettings.queue.maxTotal, 1, 100),
      sameUserCooldownMinutes: clamp(queue.sameUserCooldownMinutes, defaultSettings.queue.sameUserCooldownMinutes, 0, 1_440),
      expireMinutes: clamp(queue.expireMinutes, defaultSettings.queue.expireMinutes, 1, 180),
      dedupeWindowSeconds: clamp(queue.dedupeWindowSeconds, defaultSettings.queue.dedupeWindowSeconds, 1, 120),
    },
    moderation: {
      // Retire the experimental any-comment intake switch. Persisted values
      // are intentionally migrated to false so production cannot regress.
      treatAnyCommentAsQuestion: false,
      minChars: clamp(moderation.minChars, defaultSettings.moderation.minChars, 1, 40),
      maxChars: clamp(moderation.maxChars, defaultSettings.moderation.maxChars, 20, 500),
      llmTimeoutMs: clamp(moderation.llmTimeoutMs, defaultSettings.moderation.llmTimeoutMs, 250, 20_000),
    },
    reading: {
      speechTargetSeconds: clamp(reading.speechTargetSeconds, defaultSettings.reading.speechTargetSeconds, 10, 90),
      watchdogMs: clamp(reading.watchdogMs, defaultSettings.reading.watchdogMs, 5_000, 180_000),
      externalRetryCount: clamp(reading.externalRetryCount, defaultSettings.reading.externalRetryCount, 0, 3),
    },
    meihua: {
      engine: meihua.engine === 'LEGACY_V2_1' ? 'LEGACY_V2_1' : 'MINGYU_CORE',
    },
    gifts: {
      enabled: gifts.enabled !== false,
      entitlementExpireMinutes: clamp(gifts.entitlementExpireMinutes, defaultSettings.gifts.entitlementExpireMinutes, 1, 720),
      rules: normalizeGiftRules(gifts.rules),
    },
    engagement: {
      enabled: engagement.enabled !== false,
      likeRules: normalizeLikeRules(engagement.likeRules),
      commentRules: normalizeCommentRules(engagement.commentRules),
      likeUnit: clamp(engagement.likeUnit, defaultSettings.engagement.likeUnit, 1, 100_000),
      likePoints: clamp(engagement.likePoints, defaultSettings.engagement.likePoints, 0, 100_000),
      commentPoints: clamp(engagement.commentPoints, defaultSettings.engagement.commentPoints, 0, 100_000),
      obsRankingLimit: clamp(engagement.obsRankingLimit, defaultSettings.engagement.obsRankingLimit, 1, 20),
      adminRankingLimit: clamp(engagement.adminRankingLimit, defaultSettings.engagement.adminRankingLimit, 1, 100),
    },
    overlay: {
      disclaimer: asText(overlay.disclaimer, defaultSettings.overlay.disclaimer, 160),
      contentLanguage: ['en', 'zh-CN', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru'].includes(String(overlay.contentLanguage))
        ? overlay.contentLanguage as AppSettings['overlay']['contentLanguage']
        : defaultSettings.overlay.contentLanguage,
      effects: {
        accentColor: typeof effects.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(effects.accentColor) ? effects.accentColor : defaultSettings.overlay.effects.accentColor,
        backgroundOpacity: clampFloat(effects.backgroundOpacity, defaultSettings.overlay.effects.backgroundOpacity, 0, 1),
        glowIntensity: clampFloat(effects.glowIntensity, defaultSettings.overlay.effects.glowIntensity, 0, 1),
        animationStyle: effects.animationStyle === 'energetic' || effects.animationStyle === 'minimal' ? effects.animationStyle : 'smooth',
        particles: effects.particles !== false,
      },
      modules: Object.fromEntries(Object.entries(defaultSettings.overlay.modules).map(([id, defaults]) => {
        const modulePatch = input.overlay?.modules?.[id as keyof AppSettings['overlay']['modules']] ?? {};
        return [id, {
          enabled: id === 'audio' ? false : typeof modulePatch.enabled === 'boolean' ? modulePatch.enabled : defaults.enabled,
          width: clamp(modulePatch.width, defaults.width, 160, 1920), height: clamp(modulePatch.height, defaults.height, 60, 1080),
          fontScale: clampFloat(modulePatch.fontScale, defaults.fontScale, 0.6, 2),
          backgroundOpacity: clampFloat(modulePatch.backgroundOpacity, defaults.backgroundOpacity, 0, 1),
          maxItems: clamp(modulePatch.maxItems, defaults.maxItems, 1, 12),
          idleBehavior: modulePatch.idleBehavior === 'HIDE' || modulePatch.idleBehavior === 'KEEP_LAST' || modulePatch.idleBehavior === 'PREVIEW' ? modulePatch.idleBehavior : defaults.idleBehavior,
          accentColor: typeof modulePatch.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(modulePatch.accentColor) ? modulePatch.accentColor : undefined,
          titleText: typeof modulePatch.titleText === 'string' ? modulePatch.titleText.trim().slice(0, 80) : defaults.titleText,
          idleText: typeof modulePatch.idleText === 'string' ? modulePatch.idleText.trim().slice(0, 200) : defaults.idleText,
          showTitle: typeof modulePatch.showTitle === 'boolean' ? modulePatch.showTitle : defaults.showTitle,
          textColor: typeof modulePatch.textColor === 'string' && /^#[0-9a-f]{6}$/i.test(modulePatch.textColor) ? modulePatch.textColor : defaults.textColor,
          backgroundColor: typeof modulePatch.backgroundColor === 'string' && /^#[0-9a-f]{6}$/i.test(modulePatch.backgroundColor) ? modulePatch.backgroundColor : defaults.backgroundColor,
          brightness: clampFloat(modulePatch.brightness, defaults.brightness, .4, 2),
          glowIntensity: clampFloat(modulePatch.glowIntensity, defaults.glowIntensity, 0, 1),
          animationStyle: modulePatch.animationStyle === 'energetic' || modulePatch.animationStyle === 'minimal' ? modulePatch.animationStyle : 'smooth',
        }];
      })) as AppSettings['overlay']['modules'],
    },
    providers: {
      liveInput: {
        adapter: liveInput.adapter === 'tikfinity' ? 'tikfinity' : 'local',
        url: asText(liveInput.url, defaultSettings.providers.liveInput.url),
      },
      llm: {
        adapter: legacyBlankLlm || llm.adapter === 'openai-compatible' ? 'openai-compatible' : 'rule-based',
        baseUrl: legacyBlankLlm ? defaultSettings.providers.llm.baseUrl : sanitizeExternalProviderUrl(llm.baseUrl),
        model: legacyBlankLlm ? defaultSettings.providers.llm.model : typeof llm.model === 'string' ? llm.model.trim() : defaultSettings.providers.llm.model,
        apiKeyEnv: 'LLM_API_KEY',
      },
      tts: {
        adapter: tts.adapter === 'elevenlabs' ? 'elevenlabs' : tts.adapter === 'external' || tts.adapter === 'openai-compatible' ? 'openai-compatible' : tts.adapter === 'gptsovits' ? 'gptsovits' : tts.adapter === 'kokoro' ? 'kokoro' : 'windows',
        baseUrl: sanitizeExternalProviderUrl(tts.baseUrl),
        model: typeof tts.model === 'string' ? tts.model.trim() : defaultSettings.providers.tts.model,
        voiceId: asText(tts.voiceId, defaultSettings.providers.tts.voiceId, 100),
        speed: clampFloat(tts.speed, defaultSettings.providers.tts.speed, 0.25, 4),
        instructions: typeof tts.instructions === 'string' ? tts.instructions.trim().slice(0, 500) : defaultSettings.providers.tts.instructions,
        apiKeyEnv: 'TTS_API_KEY',
        reuseLlmKey: tts.reuseLlmKey !== false && providerOrigin(sanitizeExternalProviderUrl(tts.baseUrl)) !== '' && providerOrigin(sanitizeExternalProviderUrl(tts.baseUrl)) === providerOrigin(sanitizeExternalProviderUrl(llm.baseUrl)),
        stability: clampFloat(tts.stability, defaultSettings.providers.tts.stability, 0, 1),
        similarityBoost: clampFloat(tts.similarityBoost, defaultSettings.providers.tts.similarityBoost, 0, 1),
        style: clampFloat(tts.style, defaultSettings.providers.tts.style, 0, 1),
        speakerBoost: tts.speakerBoost !== false,
        gptsovits,
        kokoro: {
          baseUrl: normalizeLocalServiceUrl(tts.kokoro?.baseUrl, defaultSettings.providers.tts.kokoro.baseUrl),
          defaultVoice: asText(tts.kokoro?.defaultVoice, defaultSettings.providers.tts.kokoro.defaultVoice, 80),
        },
        accent: { baseUrl: normalizeLocalServiceUrl(accentInput.baseUrl, defaultSettings.providers.tts.accent!.baseUrl), profiles: accentProfiles },
        voiceCloneApi: {
          provider: voiceCloneApi.provider === 'local-openvoice' || voiceCloneApi.provider === 'baidu' ? voiceCloneApi.provider : 'aliyun',
          baseUrl: voiceCloneApi.provider === 'local-openvoice' ? normalizeLocalServiceUrl(voiceCloneApi.baseUrl, defaultSettings.providers.tts.accent!.baseUrl) : voiceCloneApi.provider === 'baidu' ? voiceBaidu.baseUrl : voiceAliyun.baseUrl,
          model: voiceCloneApi.provider === 'baidu' ? voiceBaidu.model : voiceAliyun.model,
          targetModel: voiceCloneApi.provider === 'baidu' ? voiceBaidu.targetModel : voiceAliyun.targetModel,
          region: voiceCloneApi.provider === 'aliyun' && voiceCloneApi.region === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing',
          apiKeyEnv: voiceCloneApi.provider === 'baidu' ? voiceBaidu.apiKeyEnv : voiceAliyun.apiKeyEnv,
          workspaceId: voiceCloneApi.provider === 'baidu' ? voiceBaidu.workspaceId : voiceAliyun.workspaceId,
          aliyun: voiceAliyun,
          baidu: voiceBaidu,
        },
        activeVoiceProfileId: voiceProfiles.some((profile) => profile.id === tts.activeVoiceProfileId) ? tts.activeVoiceProfileId : undefined,
        voiceClones: normalizeVoiceClones(tts.voiceClones),
        voiceProfiles,
        baidu: {
          baseUrl: sanitizeExternalProviderUrl(tts.baidu?.baseUrl) || defaultSettings.providers.tts.baidu!.baseUrl,
          appId: typeof tts.baidu?.appId === 'string' ? tts.baidu.appId.trim().slice(0, 160) : '',
          accessTokenConfigured: tts.baidu?.accessTokenConfigured === true,
        },
      },
      avatar: {
        adapter: avatar.adapter === 'vtube-studio' || avatar.adapter === 'warudo' || avatar.adapter === 'mock' || avatar.adapter === 'musetalk' || avatar.adapter === 'local-vrm' || avatar.adapter === 'baidu-cloud' || avatar.adapter === 'aliyun-cloud' ? avatar.adapter : 'none',
        // ws:// 只对 VTube 合法；其余适配器一律落回 MuseTalk HTTP 地址
        url: normalizeLocalServiceUrl(avatar.url, avatar.adapter === 'vtube-studio' ? 'ws://127.0.0.1:8001' : 'http://127.0.0.1:9898'),
        cloneApi: {
          provider: avatarCloneApi.provider === 'local-musetalk' || avatarCloneApi.provider === 'baidu' ? avatarCloneApi.provider : 'aliyun',
          baseUrl: avatarCloneApi.provider === 'local-musetalk' ? normalizeLocalServiceUrl(avatarCloneApi.baseUrl, defaultSettings.providers.avatar.url) : avatarCloneApi.provider === 'baidu' ? avatarBaidu.baseUrl : avatarAliyun.baseUrl,
          model: avatarCloneApi.provider === 'baidu' ? avatarBaidu.model : avatarAliyun.model,
          region: avatarCloneApi.provider === 'baidu' ? 'cn-beijing' : 'cn-zhangjiakou',
          apiKeyEnv: avatarCloneApi.provider === 'baidu' ? avatarBaidu.apiKeyEnv : avatarAliyun.apiKeyEnv,
          tenantId: avatarCloneApi.provider === 'baidu' ? avatarBaidu.tenantId : avatarAliyun.tenantId,
          appId: avatarCloneApi.provider === 'baidu' ? avatarBaidu.appId : avatarAliyun.appId,
          instanceId: avatarCloneApi.provider === 'baidu' ? avatarBaidu.instanceId : avatarAliyun.instanceId,
          projectId: avatarCloneApi.provider === 'baidu' ? avatarBaidu.projectId : avatarAliyun.projectId,
          aliyun: avatarAliyun,
          baidu: avatarBaidu,
        },
        activeProfileId: avatarProfiles.some((profile) => profile.id === avatar.activeProfileId) ? avatar.activeProfileId : undefined,
        profiles: avatarProfiles,
        baidu: {
          baseUrl: sanitizeExternalProviderUrl(avatar.baidu?.baseUrl) || defaultSettings.providers.avatar.baidu!.baseUrl,
          appId: typeof avatar.baidu?.appId === 'string' ? avatar.baidu.appId.trim().slice(0, 160) : '',
          accessTokenConfigured: avatar.baidu?.accessTokenConfigured === true,
        },
      },
    },
    audioBus: {
      enabled: audioBus.enabled !== false,
      outputDeviceName: asText(audioBus.outputDeviceName, defaultSettings.audioBus.outputDeviceName, 180),
      requireExactDevice: audioBus.requireExactDevice !== false,
      muteBrowserAudio: true,
      sampleRate: audioBus.sampleRate === 24_000 ? 24_000 : 48_000,
    },
    presentation,
  };
}

function isSupportedVoiceSample(buffer: Buffer, mimeType: string, fileName: string): boolean {
  const mime = mimeType.toLowerCase();
  const extension = extname(fileName).toLowerCase();
  const declared = [
    'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/flac',
    'audio/aac', 'audio/mp4', 'video/mp4', 'audio/webm', 'video/webm',
  ].includes(mime) || ['.wav', '.mp3', '.ogg', '.flac', '.aac', '.m4a', '.mp4', '.webm'].includes(extension);
  if (!declared || buffer.length < 12) return false;
  const ascii = buffer.toString('ascii', 0, Math.min(buffer.length, 16));
  return (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE')
    || ascii.startsWith('ID3')
    || (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)
    || ascii.startsWith('OggS')
    || ascii.startsWith('fLaC')
    || buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    || ascii.slice(4, 8) === 'ftyp';
}

function isMp4VoiceSample(mimeType: string, fileName: string): boolean {
  return mimeType.toLowerCase() === 'video/mp4' || mimeType.toLowerCase() === 'audio/mp4' || extname(fileName).toLowerCase() === '.mp4';
}

function bundledFfmpegPath(): string | undefined {
  const candidates = [
    process.env.MEIHUA_FFMPEG_PATH,
    join(process.cwd(), 'tools', 'ffmpeg', 'ffmpeg.exe'),
    join(process.cwd(), '..', '..', 'tools', 'ffmpeg', 'ffmpeg.exe'),
    join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    join(process.cwd(), 'node_modules', '.pnpm', 'ffmpeg-static@5.2.0_supports-color@7.1.0', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  ].filter((value): value is string => Boolean(value));
  // Launchers historically export MEIHUA_FFMPEG_PATH as the directory so
  // Python/MuseTalk can put it on PATH.  Node's spawnSync, however, requires
  // the executable itself.  Treat both forms as valid and never return a
  // directory to a caller that will execute it.
  for (const candidate of candidates) {
    try {
      const executable = statSync(candidate).isDirectory()
        ? join(candidate, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
        : candidate;
      if (existsSync(executable) && statSync(executable).isFile()) return executable;
    } catch {
      // A stale configured location simply falls through to the bundled copy.
    }
  }
  return undefined;
}

function resolveGptSoVitsRoot(): string | undefined {
  const candidates = [
    process.env.GPT_SOVITS_HOME,
    join(process.cwd(), 'gptsovits'),
    join(process.cwd(), '..', 'gptsovits'),
    join(process.cwd(), '..', 'V3音色包'),
    join(process.cwd(), '..', '..', 'V3音色包'),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((root) => existsSync(join(root, 'runtime', 'python.exe')));
}

function transcribeVoiceReference(audioPath: string, language: GptSoVitsVoice['refLanguage'] | 'auto'): { text: string; language: GptSoVitsVoice['refLanguage'] } {
  const gptRoot = resolveGptSoVitsRoot();
  const ffmpeg = bundledFfmpegPath();
  const script = [
    join(process.cwd(), 'services', 'voice-asr', 'transcribe.py'),
    join(process.cwd(), '..', '..', 'services', 'voice-asr', 'transcribe.py'),
  ].find((candidate) => existsSync(candidate));
  const python = gptRoot ? join(gptRoot, 'runtime', 'python.exe') : '';
  const model = gptRoot ? join(gptRoot, 'tools', 'asr', 'models', 'openai-whisper', 'tiny.pt') : '';
  if (!gptRoot || !script || !existsSync(python) || !existsSync(model) || !ffmpeg) {
    throw new Error('VOICE_ASR_NOT_INSTALLED: 离线语音识别组件不完整，请重新安装一体包');
  }
  const result = spawnSync(python, [script, '--audio', audioPath, '--model', model, '--language', language], {
    encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PATH: `${dirname(ffmpeg)};${process.env.PATH ?? ''}`,
    },
  });
  const payloadLine = String(result.stdout ?? '').trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
  let payload: { ok?: boolean; text?: string; language?: string; error?: string } = {};
  try { payload = payloadLine ? JSON.parse(payloadLine) as typeof payload : {}; } catch { /* handled below */ }
  const text = payload.text?.replace(/\s+/g, ' ').trim() ?? '';
  if (result.error || result.status !== 0 || payload.ok !== true || text.length < 2) {
    const detail = payload.error || result.error?.message || String(result.stderr ?? '').trim().slice(-300) || '未识别到清晰人声';
    throw new Error(`VOICE_ASR_FAILED: ${detail}`);
  }
  const detected = payload.language === 'en' || payload.language === 'ja' || payload.language === 'ko' || payload.language === 'yue' ? payload.language : 'zh';
  return { text: text.slice(0, 400), language: detected };
}

function wavDurationMs(value: Buffer): number | undefined {
  if (value.length < 44 || value.toString('ascii', 0, 4) !== 'RIFF' || value.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let bytesPerSecond = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= value.length;) {
    const id = value.toString('ascii', offset, offset + 4);
    const size = value.readUInt32LE(offset + 4);
    const content = offset + 8;
    if (content + size > value.length) break;
    if (id === 'fmt ' && size >= 16) bytesPerSecond = value.readUInt32LE(content + 8);
    if (id === 'data') { dataSize = size; break; }
    offset = content + size + (size % 2);
  }
  return bytesPerSecond > 0 && dataSize > 0 ? Math.round((dataSize / bytesPerSecond) * 1_000) : undefined;
}

function retimeLocalWav(filePath: string, targetMs: number): number | undefined {
  const ffmpeg = bundledFfmpegPath();
  if (!ffmpeg || !existsSync(filePath)) return undefined;
  const actualMs = wavDurationMs(readFileSync(filePath));
  if (!actualMs || targetMs <= 0) return undefined;
  const tempo = actualMs / targetMs;
  if (tempo < 0.5 || tempo > 2) return undefined;
  const temporaryPath = `${filePath}.retime.wav`;
  const result = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', filePath,
    '-filter:a', `atempo=${tempo.toFixed(6)}`, '-c:a', 'pcm_s16le', temporaryPath,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.error || result.status !== 0 || !existsSync(temporaryPath)) {
    try { unlinkSync(temporaryPath); } catch { /* best effort */ }
    return undefined;
  }
  copyFileSync(temporaryPath, filePath);
  unlinkSync(temporaryPath);
  return wavDurationMs(readFileSync(filePath));
}

function validateVrmModel(path: string): { version: '0.x' | '1.x'; hasBlink: boolean; hasMouth: boolean } {
  const value = readFileSync(path);
  if (value.length < 20 || value.toString('ascii', 0, 4) !== 'glTF' || value.readUInt32LE(4) !== 2) {
    throw new Error('VRM_INVALID_GLB: 文件不是有效的 VRM/GLB 2.0 模型');
  }
  let json: Record<string, unknown> | undefined;
  for (let offset = 12; offset + 8 <= value.length;) {
    const length = value.readUInt32LE(offset);
    const type = value.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > value.length) break;
    if (type === 0x4e4f534a) {
      json = JSON.parse(value.toString('utf8', offset + 8, end).replace(/\0+$/g, '').trim()) as Record<string, unknown>;
      break;
    }
    offset = end;
  }
  if (!json) throw new Error('VRM_INVALID_GLB: 模型缺少 glTF JSON 数据');
  const extensions = (json.extensions ?? {}) as Record<string, any>;
  const vrm1 = extensions.VRMC_vrm as Record<string, any> | undefined;
  const vrm0 = extensions.VRM as Record<string, any> | undefined;
  if (!vrm1 && !vrm0) throw new Error('VRM_EXTENSION_MISSING: 普通 GLB 不能作为数字人，请上传 .vrm 角色模型');
  const humanBones = vrm1?.humanoid?.humanBones ?? vrm0?.humanoid?.humanBones;
  if (!humanBones || (Array.isArray(humanBones) ? humanBones.length === 0 : Object.keys(humanBones).length === 0)) {
    throw new Error('VRM_HUMANOID_MISSING: 模型缺少人体骨骼');
  }
  const preset1 = vrm1?.expressions?.preset ?? {};
  const groups0 = Array.isArray(vrm0?.blendShapeMaster?.blendShapeGroups) ? vrm0.blendShapeMaster.blendShapeGroups : [];
  const names0 = new Set(groups0.flatMap((item: any) => [item?.presetName, item?.name]).filter(Boolean).map((item: unknown) => String(item).toLowerCase()));
  const hasBlink = Boolean(preset1.blink || preset1.blinkLeft || preset1.blinkRight || names0.has('blink'));
  const hasMouth = Boolean(preset1.aa || preset1.ih || preset1.ou || names0.has('a') || names0.has('aa'));
  if (!hasBlink) throw new Error('VRM_BLINK_MISSING: 模型缺少眨眼表情');
  if (!hasMouth) throw new Error('VRM_MOUTH_MISSING: 模型缺少嘴型表情（aa/A）');
  return { version: vrm1 ? '1.x' : '0.x', hasBlink, hasMouth };
}

function viewerKey(event: Pick<LiveChatEvent, 'userId' | 'username'>): string {
  return (event.userId ?? event.username).trim().toLocaleLowerCase();
}

function queueKey(username: string, question: string): string {
  return `${username.trim().toLocaleLowerCase()}|${question.trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`;
}

type StatusKey = 'idle' | 'queued' | 'paused' | 'selected' | 'casting' | 'interpreting' | 'composing' | 'synthesizing' | 'speaking' | 'finish' | 'replay' | 'processing';
const statusCopy: Record<AppSettings['overlay']['contentLanguage'], Record<StatusKey, string>> = {
  en:{idle:'100 likes or 4 Roses unlock a reading. Then ask one clear question.',queued:'Waiting for the next viewer',paused:'Questions are temporarily paused',selected:'Preparing the reading',casting:'Casting the hexagram',interpreting:'Hexagram formed · Interpreting',composing:'Preparing the narration',synthesizing:'Generating the voice',speaking:'Live reading in progress',finish:'Reading complete',replay:'Replaying this reading',processing:'Processing'},
  'zh-CN':{idle:'把一个清晰的问题发在评论区',queued:'正在等待下一位观众',paused:'暂时停止收题',selected:'正在准备解读',casting:'正在起卦',interpreting:'卦象已成 · 正在推演',composing:'正在整理口播',synthesizing:'正在准备语音',speaking:'正在解读',finish:'本轮完成',replay:'正在回放本轮解读',processing:'处理中'},
  es:{idle:'Escribe una pregunta clara en el chat',queued:'Esperando al siguiente espectador',paused:'Las preguntas están en pausa',selected:'Preparando la lectura',casting:'Formando el hexagrama',interpreting:'Hexagrama formado · Interpretando',composing:'Preparando la narración',synthesizing:'Generando la voz',speaking:'Lectura en directo',finish:'Lectura terminada',replay:'Repitiendo esta lectura',processing:'Procesando'},
  fr:{idle:'Posez une question claire dans le chat',queued:'En attente du prochain spectateur',paused:'Les questions sont en pause',selected:'Préparation du tirage',casting:'Création de l’hexagramme',interpreting:'Hexagramme formé · Interprétation',composing:'Préparation de la narration',synthesizing:'Génération de la voix',speaking:'Lecture en direct',finish:'Lecture terminée',replay:'Relecture en cours',processing:'Traitement'},
  de:{idle:'Stelle eine klare Frage im Chat',queued:'Warten auf den nächsten Zuschauer',paused:'Fragen sind vorübergehend pausiert',selected:'Deutung wird vorbereitet',casting:'Hexagramm wird gebildet',interpreting:'Hexagramm gebildet · Deutung läuft',composing:'Sprechtext wird vorbereitet',synthesizing:'Stimme wird erzeugt',speaking:'Live-Deutung läuft',finish:'Deutung abgeschlossen',replay:'Deutung wird wiederholt',processing:'Verarbeitung'},
  ja:{idle:'チャットに明確な質問を一つ送ってください',queued:'次の視聴者を待っています',paused:'質問受付を一時停止しています',selected:'リーディングを準備中',casting:'卦を立てています',interpreting:'卦が完成 · 解釈中',composing:'ナレーションを準備中',synthesizing:'音声を生成中',speaking:'ライブリーディング中',finish:'リーディング完了',replay:'リーディングを再生中',processing:'処理中'},
  ko:{idle:'채팅에 명확한 질문 하나를 남겨주세요',queued:'다음 시청자를 기다리는 중',paused:'질문 접수가 일시 중지되었습니다',selected:'리딩 준비 중',casting:'괘를 구성하는 중',interpreting:'괘 완성 · 해석 중',composing:'내레이션 준비 중',synthesizing:'음성 생성 중',speaking:'라이브 리딩 진행 중',finish:'리딩 완료',replay:'리딩 다시 재생 중',processing:'처리 중'},
  pt:{idle:'Envie uma pergunta clara no chat',queued:'Aguardando o próximo espectador',paused:'As perguntas estão pausadas',selected:'Preparando a leitura',casting:'Formando o hexagrama',interpreting:'Hexagrama formado · Interpretando',composing:'Preparando a narração',synthesizing:'Gerando a voz',speaking:'Leitura ao vivo',finish:'Leitura concluída',replay:'Reproduzindo esta leitura',processing:'Processando'},
  ru:{idle:'Задайте один ясный вопрос в чате',queued:'Ожидание следующего зрителя',paused:'Приём вопросов временно остановлен',selected:'Подготовка чтения',casting:'Построение гексаграммы',interpreting:'Гексаграмма построена · Толкование',composing:'Подготовка текста',synthesizing:'Создание голоса',speaking:'Идёт чтение в прямом эфире',finish:'Чтение завершено',replay:'Повтор чтения',processing:'Обработка'},
};

export class LiveRuntime {
  private readonly queue = new ReadingQueue();
  private readonly readings = new Map<string, Reading>();
  private readonly overlayClients = new Set<WebSocket>();
  private readonly adminClients = new Set<WebSocket>();
  private readonly overlaySocketSources = new Map<WebSocket, { sourceId: string; connectedAt: number }>();
  private meihuaEngine: MeihuaEngine;
  private readonly localAnswerComposer = new RuleBasedAnswerComposer();
  private readonly liveInput = new LocalLiveInputAdapter();
  private readonly tikfinity: TikfinityLiveInputAdapter;
  private readonly windowsTts: WindowsTtsAdapter;
  private readonly ttsAdapterOverride?: TtsAdapter;
  private readonly audioPlayer: NativeAudioPlayer;
  private readonly mockAvatarProvider: AvatarProviderAdapter = new LocalMockAvatarProviderAdapter();
  private readonly localVrmAvatarProvider = new LocalVrmAvatarAdapter();
  private readonly baiduCloudAvatarProvider = new BaiduCloudAvatarAdapter();
  private aliyunCloudAvatarProvider?: CloudAvatarProviderAdapter;
  private baiduRealtimeAvatarProvider?: CloudAvatarProviderAdapter;
  private readonly museTalkAvatarProvider: MuseTalkAvatarAdapter;
  private readonly vtube: VTubeStudioAdapter;
  private readonly audioDirectory: string;
  private readonly voicesDirectory: string;
  private readonly mediaDirectory: string;
  private readonly thumbnailJobs = new Map<string, Promise<string | undefined>>();
  private readonly vtubeTokenPath: string;
  private readonly llmSecretPath: string;
  private readonly ttsSecretPath: string;
  private readonly voiceCloneSecretPath: string;
  private readonly avatarCloneSecretPath: string;
  private readonly voiceCloneAliyunSecretPath: string;
  private readonly voiceCloneBaiduSecretPath: string;
  private readonly avatarCloneAliyunSecretPath: string;
  private readonly avatarCloneBaiduSecretPath: string;
  private readonly providerVerification = new Map<'llm' | 'tts', { fingerprint: string; verifiedAt: number }>();
  private readonly serviceFetcher: typeof fetch;
  private kokoroServiceHealth = { ready: false, checkedAt: 0, detail: '尚未检查本地 Kokoro 服务' };
  private providerReadinessProbe?: Promise<void>;
  private readonly startedAt = Date.now();
  private readonly recentQuestionKeys = new Map<string, number>();
  private readonly likeTotals = new Map<string, number>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly maintenanceTimer: NodeJS.Timeout;
  private settings: AppSettings;
  private readonly initialSettings: AppSettings;
  private active?: ActiveReading;
  private replay?: ReplayState;
  private retryAfterAbort?: { event: LiveChatEvent; original: Reading };
  private autoProcessing = false;
  private acceptingQuestions = true;
  private giftAlert?: NonNullable<OverlayState['giftAlert']>;
  private giftAlertTimer?: NodeJS.Timeout;
  private currentSession?: LiveSession;
  private activeCue?: DirectorCue;
  private readonly sideCues = new Map<string, DirectorCue>();
  private readonly sideCueTimers = new Map<string, NodeJS.Timeout>();
  private readonly pipelineRetryTimers = new Map<string, NodeJS.Timeout>();
  /** Queue entries being prepared while the current reading is speaking. */
  private readonly preprocessingReadings = new Set<string>();
  private directorSequence = 0;
  private publishedProfileVersion: SceneProfileVersion;
  private draftProfileVersion: SceneProfileVersion;
  private readonly previewSessions = new Map<string, PreviewSession>();
  private readonly previewClients = new Map<string, Set<WebSocket>>();
  private previewBroadcastTimer?: NodeJS.Timeout;
  private digitalHumanPresets: DigitalHumanPreset[] = [];
  private readonly avatarRenderJobs = new Map<string, AvatarRenderJob>();
  private readonly digitalHumanJobRunners = new Map<string, Promise<void>>();
  private readonly digitalHumanSegmentCache = new Map<string, PreparedDigitalHumanSegment>();
  private readonly digitalHumanBroadcast = new Map<string, DigitalHumanBroadcastItem>();
  private digitalHumanServiceHealth = { accent: false, musetalk: false };
  private processingDigitalHumanBroadcast = false;
  private activeDigitalHumanBroadcast?: { id: string; controller: AbortController };
  private activeAvatarMedia?: AvatarStageMedia;
  private activePresentationMedia?: AvatarStageMedia;
  private readonly avatarMediaReadyWaiters = new Map<string, { resolve: () => void; timer: NodeJS.Timeout }>();
  private readonly audioStartWaiters = new Map<string, { resolve: (startsAt: number) => void; reject: (error: Error) => void }>();
  private readonly audioEndWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly audioEndedBeforeWait = new Set<string>();
  private activeAudioLease?: AudioSourceLease;
  private readonly audioSourceHeartbeats = new Map<string, number>();
  /** Voice and lip-sync models must never compete for an 8 GB GPU. */
  private readonly gpuRuntimeProfile: GpuRuntimeProfile = resolveGpuRuntimeProfile();
  private readonly gpuTaskCoordinator = new GpuTaskCoordinator();
  private syncMetrics: SyncMetrics = { activeAudioSources: 0 };
  private processingInbox = false;
  private rankingBroadcastTimer?: NodeJS.Timeout;
  /**
   * TikFinity can emit likes/heartbeats in bursts.  A full overlay snapshot
   * is relatively expensive, so do not broadcast one for every inbox row.
   * The admin console also polls the inbox, while queue mutations publish
   * their own immediate queue snapshot.
   */
  private liveInboxSnapshotTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly persistence: SqlitePersistence, options: { audioDirectory?: string; voicesDirectory?: string; mediaDirectory?: string; systemAssetDirectory?: string; initialSettings?: AppSettingsPatch; audioPlayer?: NativeAudioPlayer; museTalkFetcher?: typeof fetch; serviceFetcher?: typeof fetch; ttsAdapter?: TtsAdapter } = {}) {
    this.audioDirectory = options.audioDirectory ?? join(process.cwd(), 'data', 'audio');
    this.voicesDirectory = options.voicesDirectory ?? join(this.audioDirectory, '..', 'voices');
    this.mediaDirectory = options.mediaDirectory ?? join(process.cwd(), 'data', 'media');
    this.vtubeTokenPath = join(process.cwd(), 'data', 'secrets', 'vtube-studio.dpapi');
    this.llmSecretPath = join(process.cwd(), 'data', 'secrets', 'llm-api-key.dpapi');
    this.ttsSecretPath = join(process.cwd(), 'data', 'secrets', 'tts-api-key.dpapi');
    this.voiceCloneSecretPath = join(process.cwd(), 'data', 'secrets', 'voice-clone-api-key.dpapi');
    this.avatarCloneSecretPath = join(process.cwd(), 'data', 'secrets', 'avatar-clone-api-key.dpapi');
    this.voiceCloneAliyunSecretPath = join(process.cwd(), 'data', 'secrets', 'voice-clone-aliyun-api-key.dpapi');
    this.voiceCloneBaiduSecretPath = join(process.cwd(), 'data', 'secrets', 'voice-clone-baidu-api-key.dpapi');
    this.avatarCloneAliyunSecretPath = join(process.cwd(), 'data', 'secrets', 'avatar-clone-aliyun-credentials.dpapi');
    this.avatarCloneBaiduSecretPath = join(process.cwd(), 'data', 'secrets', 'avatar-clone-baidu-api-key.dpapi');
    mkdirSync(this.mediaDirectory, { recursive: true });
    if (options.systemAssetDirectory) this.seedSystemAssets(options.systemAssetDirectory);
    this.reconcileMediaAssets();
    this.windowsTts = new WindowsTtsAdapter(this.audioDirectory);
    this.ttsAdapterOverride = options.ttsAdapter;
    this.serviceFetcher = options.serviceFetcher ?? fetch;
    this.audioPlayer = options.audioPlayer ?? new WindowsNativeAudioPlayer();
    this.museTalkAvatarProvider = new MuseTalkAvatarAdapter({ baseUrl: defaultSettings.providers.avatar.url, fetcher: options.museTalkFetcher });
    this.initialSettings = normalizeSettings(options.initialSettings ?? defaultSettings);
    this.settings = normalizeSettings(this.persistence.getSetting('settings', this.initialSettings));
    this.applyProductionDefaultsOnce();
    this.applyQueuePolicyV2Once();
    this.applyQuestionRecognitionPolicyV3Once();
    this.applyQuestionRecognitionPolicyV4Once();
    this.persistence.alignPendingQualificationExpiry(this.settings.queue.expireMinutes);
    this.seedDevelopmentDigitalHumanProfiles();
    this.seedDefaultPresentationProfile();
    this.digitalHumanPresets = this.persistence.getSetting<DigitalHumanPreset[]>('digital-human-presets', []);
    if (!this.digitalHumanPresets.length) {
      const preset = createDefaultDigitalHumanPreset();
      preset.avatarProfileId = this.settings.providers.avatar.profiles?.find((profile) => profile.developmentOnly)?.id ?? this.settings.providers.avatar.activeProfileId;
      preset.voiceProfileId = this.settings.providers.tts.voiceProfiles?.find((profile) => profile.name === 'Meihua Development Voice')?.id ?? this.settings.providers.tts.activeVoiceProfileId;
      this.digitalHumanPresets = [preset];
      this.persistence.setSetting('digital-human-presets', this.digitalHumanPresets);
    }
    this.meihuaEngine = this.settings.meihua.engine === 'LEGACY_V2_1' ? new DeterministicMeihuaEngine() : new MingyuMeihuaEngine();
    const versions = this.persistence.listSceneProfileVersions('main');
    const published = versions.find((item) => item.status === 'PUBLISHED');
    if (published) {
      this.publishedProfileVersion = published;
    } else {
      this.publishedProfileVersion = {
        versionId: randomUUID(), profileId: 'main', version: 1, status: 'PUBLISHED',
        profile: createDefaultSceneProfile(this.settings), createdAt: Date.now(), publishedAt: Date.now(),
      };
      this.persistence.saveSceneProfileVersion(this.publishedProfileVersion);
    }
    const draft = versions.find((item) => item.status === 'DRAFT');
    this.draftProfileVersion = draft ?? {
      versionId: randomUUID(), profileId: 'main',
      version: Math.max(this.publishedProfileVersion.version + 1, ...versions.map((item) => item.version + 1), 2),
      status: 'DRAFT', profile: structuredClone(this.publishedProfileVersion.profile), createdAt: Date.now(),
    };
    for (const version of [this.publishedProfileVersion, this.draftProfileVersion]) {
      const subtitles = version.profile.sources.subtitles;
      const audio = version.profile.sources.audio;
      if (audio.enabled) {
        const migrated = {
          ...version,
          profile: {
            ...version.profile,
            sources: {
              ...version.profile.sources,
              subtitles,
              audio: { ...audio, enabled: false },
            },
          },
        };
        if (version.status === 'PUBLISHED') this.publishedProfileVersion = migrated;
        else this.draftProfileVersion = migrated;
        this.persistence.saveSceneProfileVersion(migrated);
      }
    }
    // V7: 自定义贴纸源注入（幂等）
    for (const version of [this.publishedProfileVersion, this.draftProfileVersion]) {
      if (version.profile.sources['sticker']) continue;
      const migrated = {
        ...version,
        profile: {
          ...version.profile,
          sources: {
            ...version.profile.sources,
            sticker: createDefaultStickerSourceConfig(),
          },
        },
      };
      if (version.status === 'PUBLISHED') this.publishedProfileVersion = migrated;
      else this.draftProfileVersion = migrated;
      this.persistence.saveSceneProfileVersion(migrated);
    }
    // V8: one authoritative composition drives both the editor and the OBS stage.
    for (const version of [this.publishedProfileVersion, this.draftProfileVersion]) {
      const migratedProfile = this.removeMissingAssetReferences(migrateSceneComposition(version.profile));
      if (migratedProfile === version.profile) continue;
      const migrated = { ...version, profile: migratedProfile };
      if (version.status === 'PUBLISHED') this.publishedProfileVersion = migrated;
      else this.draftProfileVersion = migrated;
      this.persistence.saveSceneProfileVersion(migrated);
    }
    if (!draft) this.persistence.saveSceneProfileVersion(this.draftProfileVersion);
    // V2.2: persisted scene profiles created before meihua-stage existed get the
    // official stage source injected; the migration is additive and idempotent.
    for (const version of [this.publishedProfileVersion, this.draftProfileVersion]) {
      if (version.profile.sources['meihua-stage']) continue;
      const migrated = {
        ...version,
        profile: {
          ...version.profile,
          sources: {
            ...version.profile.sources,
            'meihua-stage': createDefaultStageSourceConfig(this.settings),
          },
        },
      };
      if (version.status === 'PUBLISHED') this.publishedProfileVersion = migrated;
      else this.draftProfileVersion = migrated;
      this.persistence.saveSceneProfileVersion(migrated);
    }
    // Production scene V2: restore the caption layer and rename the ambiguous
    // avatar layer to its real role. It hosts either the one-shot presentation
    // video or an explicitly enabled digital human.
    if (!this.persistence.getSetting<boolean>('production-scene-v2', false)) {
      for (const version of [this.publishedProfileVersion, this.draftProfileVersion]) {
        const profile = structuredClone(version.profile);
        profile.sources.subtitles = { ...profile.sources.subtitles, enabled: true, idleBehavior: 'HIDE', showTitle: false };
        if (profile.composition) {
          profile.composition.layers = profile.composition.layers.map((layer) => layer.kind === 'MODULE' && layer.moduleId === 'subtitles'
            ? { ...layer, visible: true, name: '动态口播字幕' }
            : layer.kind === 'MODULE' && layer.moduleId === 'avatar'
              ? { ...layer, name: '播报画面（视频 / 数字人）' }
              : layer);
        }
        const migrated = { ...version, profile };
        if (version.status === 'PUBLISHED') this.publishedProfileVersion = migrated;
        else this.draftProfileVersion = migrated;
        this.persistence.saveSceneProfileVersion(migrated);
      }
      this.persistence.setSetting('production-scene-v2', true);
    }
    // Production scene V3: expose only the viewer, question, and hexagram name
    // as context. The generated reading remains private to the admin monitor.
    if (!this.persistence.getSetting<boolean>('production-scene-v3', false)) {
      for (const version of [this.publishedProfileVersion, this.draftProfileVersion]) {
        const profile = structuredClone(version.profile);
        profile.sources['current-viewer'] = { ...profile.sources['current-viewer'], enabled: true };
        if (profile.composition) {
          profile.composition.layers = profile.composition.layers.map((layer) => layer.kind === 'MODULE' && layer.moduleId === 'current-viewer'
            ? { ...layer, visible: true, name: '当前用户 · 问题 · 卦名' }
            : layer);
        }
        const migrated = { ...version, profile };
        if (version.status === 'PUBLISHED') this.publishedProfileVersion = migrated;
        else this.draftProfileVersion = migrated;
        this.persistence.saveSceneProfileVersion(migrated);
      }
      this.persistence.setSetting('production-scene-v3', true);
    }
    // Production scene V4: the presentation layer owns the full video/person
    // frame. Legacy decoration bindings could scale a sticker over the host.
    if (!this.persistence.getSetting<boolean>('production-scene-v4', false)) {
      for (const version of [this.publishedProfileVersion, this.draftProfileVersion]) {
        const profile = structuredClone(version.profile);
        profile.sources.avatar = { ...profile.sources.avatar, decorationAssetId: undefined };
        const migrated = { ...version, profile };
        if (version.status === 'PUBLISHED') this.publishedProfileVersion = migrated;
        else this.draftProfileVersion = migrated;
        this.persistence.saveSceneProfileVersion(migrated);
      }
      this.persistence.setSetting('production-scene-v4', true);
    }
    const openSession = this.persistence.getOpenLiveSession();
    if (openSession) {
      this.currentSession = { ...openSession, status: 'RECOVERING', lastHeartbeatAt: Date.now(), endReason: 'PROCESS_RESTART_RECOVERY' };
      this.persistence.saveLiveSession(this.currentSession);
      this.directorSequence = this.persistence.getLastDirectorSequence(openSession.sessionId);
      const danglingCue = this.persistence.getActiveDirectorCue(openSession.sessionId);
      if (danglingCue) this.persistence.saveDirectorCue({ ...danglingCue, endsAt: Date.now(), revision: danglingCue.revision + 1 });
      this.currentSession = { ...this.currentSession, status: 'PAUSED', lastHeartbeatAt: Date.now() };
      this.persistence.saveLiveSession(this.currentSession);
      this.acceptingQuestions = false;
    }
    this.tikfinity = new TikfinityLiveInputAdapter(this.settings.providers.liveInput.url);
    this.vtube = new VTubeStudioAdapter(
      this.settings.providers.avatar.url,
      readDpapiSecret(this.vtubeTokenPath),
      (token) => writeDpapiSecret(this.vtubeTokenPath, token),
    );
    void this.mockAvatarProvider.connect();
    this.persistence.setSetting('settings', this.settings);
    const recovered = this.persistence.recoverInFlightReadings();
    const requeued = this.persistence.requeueRestartedReadings();
    if (recovered > 0 || requeued > 0) this.persistence.recordEvent('PROCESS_RECOVERY', { recovered, requeued });

    for (const reading of this.persistence.listQueued()) {
      const restored = reading.pipeline && reading.pipeline.phase !== 'QUEUED'
        ? { ...reading, pipeline: this.createPipelineSnapshot(reading.id, 'QUEUED', reading.pipeline.attempt) }
        : reading.pipeline ? reading : { ...reading, pipeline: this.createPipelineSnapshot(reading.id, 'QUEUED') };
      this.readings.set(restored.id, restored);
      if (restored !== reading) this.persistence.saveReading(restored);
      this.queue.enqueue({ readingId: restored.id, username: restored.username, priority: restored.priority, queuedAt: restored.createdAt, expiresAt: restored.expiresAt });
    }
    this.expireQueued();
    void this.liveInput.start({
      onChat: async (event) => { await this.ingest(event); },
      onGift: async (event) => { await this.ingestGift(event); },
      onLike: async (event) => { await this.ingestLike(event); },
    });
    // Keep the diagnostics socket connected before the operator presses Start.
    // TikFinity events are always captured for the interaction monitor and gift
    // catalog. Events received outside a LIVE session are completed without
    // accounting, qualification or queue side effects.
    if (this.settings.providers.liveInput.adapter === 'tikfinity') this.startTikfinityInput();
    void this.processLiveInbox();
    this.persistence.recoverDigitalHumanJobs();
    queueMicrotask(() => this.resumeDigitalHumanJobs());
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      if (this.currentSession && !['ENDED'].includes(this.currentSession.status)) {
        this.currentSession = { ...this.currentSession, lastHeartbeatAt: now };
        this.persistence.saveLiveSession(this.currentSession);
      }
      this.broadcast({ type: 'HEARTBEAT', ts: now });
      this.broadcastV2('HEARTBEAT', { serverTime: now });
      this.sweepAudioLease(now);
    }, 15_000);
    // Integrity checks and a 200+ MB backup are synchronous in node:sqlite.
    // Running them in the constructor delayed all HTTP/static listeners and
    // looked like a frozen workbench. Maintenance now runs only on the daily
    // timer and never interrupts an active or recoverable live session.
    this.maintenanceTimer = setInterval(() => {
      if (!this.currentSession || this.currentSession.status === 'ENDED') this.runMaintenance();
      else this.persistence.runMaintenanceRecord('DAILY_RETENTION_SKIPPED_LIVE', { sessionId: this.currentSession.sessionId, status: this.currentSession.status });
    }, 24 * 60 * 60 * 1_000);
  }

  close(): void {
    this.closing = true;
    this.autoProcessing = false;
    this.active?.controller.abort();
    this.replay?.controller.abort();
    clearInterval(this.heartbeat);
    clearInterval(this.maintenanceTimer);
    if (this.giftAlertTimer) clearTimeout(this.giftAlertTimer);
    if (this.liveInboxSnapshotTimer) clearTimeout(this.liveInboxSnapshotTimer);
    if (this.rankingBroadcastTimer) clearTimeout(this.rankingBroadcastTimer);
    if (this.previewBroadcastTimer) clearTimeout(this.previewBroadcastTimer);
    for (const timer of this.sideCueTimers.values()) clearTimeout(timer);
    for (const timer of this.pipelineRetryTimers.values()) clearTimeout(timer);
    this.sideCueTimers.clear();
    this.pipelineRetryTimers.clear();
    this.sideCues.clear();
    this.audioEndedBeforeWait.clear();
    void this.liveInput.stop();
    void this.tikfinity.stop();
    void this.vtube.disconnect();
    void this.avatarProvider.disconnect();
    try {
      this.persistence.checkpoint();
      this.persistence.integrityCheck();
    } finally {
      this.persistence.close();
    }
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  /**
   * One-time migration from the fragmented test-era defaults. It deliberately
   * preserves credentials, uploaded media, cloned voices, and every later
   * operator choice; only the first production recovery boot receives the
   * safe, verified default chain.
   */
  private applyProductionDefaultsOnce(): void {
    if (this.persistence.getSetting<boolean>('production-policy-v1', false)) return;
    this.settings = normalizeSettings({
      ...this.settings,
      moderation: { ...this.settings.moderation, minChars: 4, maxChars: 280, treatAnyCommentAsQuestion: false, llmTimeoutMs: 12_000 },
      reading: { ...this.settings.reading, speechTargetSeconds: 30, watchdogMs: Math.max(this.settings.reading.watchdogMs, 300_000), externalRetryCount: Math.max(this.settings.reading.externalRetryCount, 2) },
      providers: {
        ...this.settings.providers,
        tts: {
          ...this.settings.providers.tts,
          adapter: 'kokoro', baseUrl: 'http://127.0.0.1:9890', model: 'kokoro-v1.0.onnx', voiceId: 'af_heart',
          activeVoiceProfileId: undefined, reuseLlmKey: false,
          kokoro: { ...this.settings.providers.tts.kokoro, baseUrl: 'http://127.0.0.1:9890', defaultVoice: 'af_heart' },
        },
        avatar: { ...this.settings.providers.avatar, adapter: 'none', activeProfileId: undefined },
      },
      presentation: { ...this.settings.presentation, mode: 'VIDEO_ONCE', fallbackPolicy: 'VIDEO' },
    });
    this.persistence.setSetting('settings', this.settings);
    this.persistence.setSetting('production-policy-v1', true);
    this.persistence.recordEvent('PRODUCTION_DEFAULTS_APPLIED', {
      language: this.settings.overlay.contentLanguage,
      tts: this.settings.providers.tts.voiceId,
      presentation: this.settings.presentation.mode,
    });
  }

  /** One-time production policy migration requested for the live qualification flow. */
  private applyQueuePolicyV2Once(): void {
    if (this.persistence.getSetting<boolean>('production-policy-v2', false)) return;
    this.settings = normalizeSettings({
      ...this.settings,
      queue: { ...this.settings.queue, maxVisible: 4, maxTotal: 100 },
      reading: { ...this.settings.reading, speechTargetSeconds: 30 },
      gifts: {
        ...this.settings.gifts,
        enabled: true,
        rules: [{
          id: 'rose-four-reading', enabled: true, giftId: '5655', giftName: 'Rose',
          minRepeatCount: 4, priority: 'HIGH', speechTargetSeconds: 30,
          leaderboardPoints: 1, requireStreakEnd: true,
        }],
      },
      engagement: {
        ...this.settings.engagement,
        enabled: true,
        likeRules: [{
          id: 'likes-100', enabled: true, label: '100 Likes', threshold: 100,
          priority: 'NORMAL', speechTargetSeconds: 30,
          grantExpireMinutes: 30, cooldownMinutes: 30,
        }],
      },
    });
    this.persistence.setSetting('settings', this.settings);
    this.persistence.setSetting('production-policy-v2', true);
    this.persistence.recordEvent('QUEUE_POLICY_V2_APPLIED', {
      maxVisible: 4, maxTotal: 100, likeThreshold: 100,
      giftId: '5655', giftName: 'Rose', giftRepeatCount: 4,
      speechTargetSeconds: 30,
    });
  }

  /** Expand the old 18-item recognition list and align every entitlement TTL. */
  private applyQuestionRecognitionPolicyV3Once(): void {
    if (this.persistence.getSetting<boolean>('production-policy-v3', false)) return;
    const currentRule = this.settings.engagement.commentRules[0];
    const waitingMinutes = this.settings.queue.expireMinutes;
    this.settings = normalizeSettings({
      ...this.settings,
      gifts: { ...this.settings.gifts, entitlementExpireMinutes: waitingMinutes },
      engagement: {
        ...this.settings.engagement,
        likeRules: this.settings.engagement.likeRules.map((rule) => ({ ...rule, grantExpireMinutes: waitingMinutes })),
        commentRules: [{
          ...(currentRule ?? defaultSettings.engagement.commentRules[0]),
          id: currentRule?.id ?? 'comment-reading',
          label: '多语言问题识别',
          enabled: true,
          keywords: defaultCommentKeywords,
          matchMode: 'CONTAINS',
          // The list also contains semantic terms such as "plan" and "work".
          // Removing the matched term corrupts the viewer's actual question.
          stripKeyword: false,
          queueExpireMinutes: waitingMinutes,
          speechTargetSeconds: this.settings.reading.speechTargetSeconds,
        }],
      },
    });
    this.persistence.setSetting('settings', this.settings);
    this.persistence.setSetting('production-policy-v3', true);
    this.persistence.recordEvent('QUESTION_RECOGNITION_POLICY_V3_APPLIED', {
      keywordCount: defaultCommentKeywords.length,
      languages: ['zh-CN', 'en', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru'],
      entitlementExpireMinutes: waitingMinutes,
    });
  }

  private applyQuestionRecognitionPolicyV4Once(): void {
    if (this.persistence.getSetting<boolean>('production-policy-v4', false)) return;
    const rules = this.settings.engagement.commentRules.map((rule, index) => index === 0 ? {
      ...rule,
      label: '多语言问题识别',
      keywords: [...new Map([...rule.keywords, ...defaultCommentKeywords].map((keyword) => [canonicalRecognitionText(keyword, /\p{Script=Latin}/u.test(keyword)), keyword])).values()],
      stripKeyword: false,
    } : rule);
    this.settings = normalizeSettings({
      ...this.settings,
      moderation: { ...this.settings.moderation, treatAnyCommentAsQuestion: false },
      engagement: { ...this.settings.engagement, commentRules: rules.length ? rules : defaultSettings.engagement.commentRules },
    });
    this.persistence.setSetting('settings', this.settings);
    this.persistence.setSetting('production-policy-v4', true);
    this.persistence.recordEvent('QUESTION_RECOGNITION_POLICY_V4_APPLIED', {
      keywordCount: this.settings.engagement.commentRules[0]?.keywords.length ?? 0,
      languages: ['zh-CN', 'en', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru'],
      unicodeNormalization: 'NFKC',
      latinWordBoundaries: true,
    });
  }

  /** Exposed to the desktop diagnostics so operators see the selected safe profile. */
  getGpuRuntimeProfile(): GpuRuntimeProfile & { queue: ReturnType<GpuTaskCoordinator['getState']> } {
    return { ...this.gpuRuntimeProfile, queue: this.gpuTaskCoordinator.getState() };
  }

  private async runGpuTask<T>(kind: 'VOICE_SYNTHESIS' | 'VOICE_TEST' | 'AVATAR_PREP' | 'AVATAR_RENDER', operation: () => Promise<T>): Promise<T> {
    return this.gpuTaskCoordinator.run(kind, operation);
  }

  getPublicSettings(): AppSettings {
    const value = structuredClone(this.settings);
    value.providers.tts.gptsovits.voices = value.providers.tts.gptsovits.voices.map((voice) => ({ ...voice, refAudioPath: '' }));
    return value;
  }

  /** The avatar provider selected by the current published runtime settings. */
  private get avatarProvider(): AvatarProviderAdapter {
    const activeId = this.settings.providers.avatar.activeProfileId;
    const active = this.settings.providers.avatar.profiles?.find((profile) => profile.id === activeId && profile.status === 'READY');
    if (this.settings.providers.avatar.adapter === 'local-vrm') {
      const modelAssetId = active?.provider === 'LOCAL_VRM' ? active.modelAssetId : undefined;
      this.localVrmAvatarProvider.configure({
        profileId: active?.id,
        modelAssetId,
        modelUrl: modelAssetId ? `/api/media-assets/${encodeURIComponent(modelAssetId)}/content` : undefined,
      });
      return this.localVrmAvatarProvider;
    }
    if (this.settings.providers.avatar.adapter === 'baidu-cloud') {
      if (this.settings.providers.avatar.cloneApi?.provider === 'baidu') return this.getCloudAvatarProvider('baidu');
      this.baiduCloudAvatarProvider.configureCloud({
        profileId: active?.id,
        videoUrl: active?.provider === 'BAIDU_CLOUD' ? active.cloudVideoUrl : undefined,
        chromaColor: active?.chromaColor,
      });
      return this.baiduCloudAvatarProvider;
    }
    if (this.settings.providers.avatar.adapter === 'aliyun-cloud') return this.getCloudAvatarProvider('aliyun');
    if (this.settings.providers.avatar.adapter === 'musetalk') {
      return this.getMuseTalkAvatarProvider();
    }
    return this.mockAvatarProvider;
  }

  /**
   * Always bind MuseTalk calls to the currently saved service URL.
   *
   * Digital-human rendering has several direct code paths that do not read the
   * generic avatarProvider getter first. Keeping configuration here prevents a
   * URL changed in Settings from silently continuing to use the startup URL.
   */
  private getMuseTalkAvatarProvider(): MuseTalkAvatarAdapter {
    this.museTalkAvatarProvider.configure(this.settings.providers.avatar.url);
    return this.museTalkAvatarProvider;
  }

  private getCloudAvatarProvider(provider: 'aliyun' | 'baidu'): CloudAvatarProviderAdapter {
    const api = this.settings.providers.avatar.cloneApi ?? defaultSettings.providers.avatar.cloneApi!;
    const config = provider === 'aliyun'
      ? api.aliyun ?? defaultSettings.providers.avatar.cloneApi!.aliyun!
      : api.baidu ?? defaultSettings.providers.avatar.cloneApi!.baidu!;
    const secret = this.resolveSecret(provider === 'aliyun' ? 'avatarCloneAliyun' : 'avatarCloneBaidu').value ?? '';
    const adapter = new CloudAvatarProviderAdapter({
      id: `${provider}-cloud-avatar`, vendorId: `${provider}-cloud`, vendorLabel: provider === 'aliyun' ? '阿里云实时数字人' : '百度曦灵实时数字人',
      config, apiKey: secret, outputDirectory: this.mediaDirectory,
    });
    if (provider === 'aliyun') this.aliyunCloudAvatarProvider = adapter;
    else this.baiduRealtimeAvatarProvider = adapter;
    return adapter;
  }

  private resolveSecret(kind: 'llm' | 'tts' | 'voiceClone' | 'avatarClone' | 'voiceCloneAliyun' | 'voiceCloneBaidu' | 'avatarCloneAliyun' | 'avatarCloneBaidu'): { value?: string; storedWithDpapi: boolean; fromEnvironment: boolean } {
    if (kind === 'tts' && this.settings.providers.tts.reuseLlmKey) return this.resolveSecret('llm');
    const voiceApi = this.settings.providers.tts.voiceCloneApi ?? defaultSettings.providers.tts.voiceCloneApi!;
    const avatarApi = this.settings.providers.avatar.cloneApi ?? defaultSettings.providers.avatar.cloneApi!;
    const voiceAliyun = voiceApi.aliyun ?? defaultSettings.providers.tts.voiceCloneApi!.aliyun!;
    const voiceBaidu = voiceApi.baidu ?? defaultSettings.providers.tts.voiceCloneApi!.baidu!;
    const avatarAliyun = avatarApi.aliyun ?? defaultSettings.providers.avatar.cloneApi!.aliyun!;
    const avatarBaidu = avatarApi.baidu ?? defaultSettings.providers.avatar.cloneApi!.baidu!;
    const setting = kind === 'llm' ? this.settings.providers.llm
      : kind === 'tts' ? this.settings.providers.tts
        : kind === 'voiceCloneAliyun' ? voiceAliyun
          : kind === 'voiceCloneBaidu' ? voiceBaidu
            : kind === 'avatarCloneAliyun' ? avatarAliyun
              : kind === 'avatarCloneBaidu' ? avatarBaidu
                : kind === 'voiceClone' ? voiceApi : avatarApi;
    const environmentValue = process.env[setting.apiKeyEnv]?.trim();
    const path = kind === 'llm' ? this.llmSecretPath
      : kind === 'tts' ? this.ttsSecretPath
        : kind === 'voiceCloneAliyun' ? this.voiceCloneAliyunSecretPath
          : kind === 'voiceCloneBaidu' ? this.voiceCloneBaiduSecretPath
            : kind === 'avatarCloneAliyun' ? this.avatarCloneAliyunSecretPath
              : kind === 'avatarCloneBaidu' ? this.avatarCloneBaiduSecretPath
                : kind === 'voiceClone' ? this.voiceCloneSecretPath : this.avatarCloneSecretPath;
    const stored = readDpapiSecret(path)?.trim();
    return {
      value: environmentValue || stored || undefined,
      storedWithDpapi: Boolean(stored),
      fromEnvironment: Boolean(environmentValue),
    };
  }

  getProviderSecretStatus(): ProviderSecretStatus {
    const llm = this.resolveSecret('llm');
    const tts = this.resolveSecret('tts');
    return {
      llm: { configured: Boolean(llm.value), storedWithDpapi: llm.storedWithDpapi, fromEnvironment: llm.fromEnvironment },
      tts: {
        configured: Boolean(tts.value), storedWithDpapi: tts.storedWithDpapi,
        fromEnvironment: tts.fromEnvironment, reusesLlmKey: this.settings.providers.tts.reuseLlmKey,
      },
      voiceClone: { configured: Boolean(this.resolveSecret('voiceClone').value), storedWithDpapi: this.resolveSecret('voiceClone').storedWithDpapi, fromEnvironment: this.resolveSecret('voiceClone').fromEnvironment },
      avatarClone: { configured: Boolean(this.resolveSecret('avatarClone').value), storedWithDpapi: this.resolveSecret('avatarClone').storedWithDpapi, fromEnvironment: this.resolveSecret('avatarClone').fromEnvironment },
      voiceCloneAliyun: { configured: Boolean(this.resolveSecret('voiceCloneAliyun').value), storedWithDpapi: this.resolveSecret('voiceCloneAliyun').storedWithDpapi, fromEnvironment: this.resolveSecret('voiceCloneAliyun').fromEnvironment },
      voiceCloneBaidu: { configured: Boolean(this.resolveSecret('voiceCloneBaidu').value), storedWithDpapi: this.resolveSecret('voiceCloneBaidu').storedWithDpapi, fromEnvironment: this.resolveSecret('voiceCloneBaidu').fromEnvironment },
      avatarCloneAliyun: { configured: Boolean(this.resolveSecret('avatarCloneAliyun').value), storedWithDpapi: this.resolveSecret('avatarCloneAliyun').storedWithDpapi, fromEnvironment: this.resolveSecret('avatarCloneAliyun').fromEnvironment },
      avatarCloneBaidu: { configured: Boolean(this.resolveSecret('avatarCloneBaidu').value), storedWithDpapi: this.resolveSecret('avatarCloneBaidu').storedWithDpapi, fromEnvironment: this.resolveSecret('avatarCloneBaidu').fromEnvironment },
    };
  }

  setProviderSecret(kind: 'llm' | 'tts' | 'voiceClone' | 'avatarClone' | 'voiceCloneAliyun' | 'voiceCloneBaidu' | 'avatarCloneAliyun' | 'avatarCloneBaidu', apiKey: string): ProviderSecretStatus {
    const value = apiKey.trim();
    if (value.length < 8 || value.length > 4_096) throw new Error('API_KEY_LENGTH_INVALID');
    const path = kind === 'llm' ? this.llmSecretPath
      : kind === 'tts' ? this.ttsSecretPath
        : kind === 'voiceCloneAliyun' ? this.voiceCloneAliyunSecretPath
          : kind === 'voiceCloneBaidu' ? this.voiceCloneBaiduSecretPath
            : kind === 'avatarCloneAliyun' ? this.avatarCloneAliyunSecretPath
              : kind === 'avatarCloneBaidu' ? this.avatarCloneBaiduSecretPath
                : kind === 'voiceClone' ? this.voiceCloneSecretPath : this.avatarCloneSecretPath;
    writeDpapiSecret(path, value);
    if (kind === 'llm' || kind === 'tts') this.providerVerification.delete(kind);
    this.persistence.recordEvent('PROVIDER_SECRET_UPDATED', { provider: kind, storage: 'WINDOWS_DPAPI' });
    return this.getProviderSecretStatus();
  }

  clearProviderSecret(kind: 'llm' | 'tts' | 'voiceClone' | 'avatarClone' | 'voiceCloneAliyun' | 'voiceCloneBaidu' | 'avatarCloneAliyun' | 'avatarCloneBaidu'): ProviderSecretStatus {
    const path = kind === 'llm' ? this.llmSecretPath
      : kind === 'tts' ? this.ttsSecretPath
        : kind === 'voiceCloneAliyun' ? this.voiceCloneAliyunSecretPath
          : kind === 'voiceCloneBaidu' ? this.voiceCloneBaiduSecretPath
            : kind === 'avatarCloneAliyun' ? this.avatarCloneAliyunSecretPath
              : kind === 'avatarCloneBaidu' ? this.avatarCloneBaiduSecretPath
                : kind === 'voiceClone' ? this.voiceCloneSecretPath : this.avatarCloneSecretPath;
    deleteDpapiSecret(path);
    if (kind === 'llm' || kind === 'tts') this.providerVerification.delete(kind);
    this.persistence.recordEvent('PROVIDER_SECRET_CLEARED', { provider: kind });
    return this.getProviderSecretStatus();
  }

  private providerFingerprint(kind: 'llm' | 'tts'): string {
    const settings = kind === 'llm' ? this.settings.providers.llm : this.settings.providers.tts;
    const secret = this.resolveSecret(kind).value ?? '';
    return createHash('sha256').update(JSON.stringify(settings)).update('\0').update(secret).digest('hex');
  }

  private getAnswerComposer(): AnswerComposer {
    if (this.settings.providers.llm.adapter === 'rule-based') return this.localAnswerComposer;
    const external = new OpenAICompatibleAnswerComposer({
      baseUrl: this.settings.providers.llm.baseUrl,
      model: this.settings.providers.llm.model,
      apiKey: this.resolveSecret('llm').value ?? '',
      timeoutMs: Math.max(5_000, this.settings.moderation.llmTimeoutMs * 5),
    });
    // In production an external model is a required stage, not cosmetic
    // polish.  A failed or invalid DeepSeek response must retry/pause the
    // reading instead of silently speaking a generic local template.
    return external;
  }

  private getTtsAdapter(): TtsAdapter {
    if (this.ttsAdapterOverride) return this.ttsAdapterOverride;
    const activeVoice = this.getActiveVoiceProfile();
    const selectedTtsAdapter = this.settings.providers.tts.adapter;
    // The top-level mode is authoritative. A previously activated cloud voice
    // must not hijack Windows or GPT-SoVITS after the operator switches local.
    if (selectedTtsAdapter !== 'windows' && selectedTtsAdapter !== 'gptsovits' && selectedTtsAdapter !== 'kokoro' && (activeVoice?.provider === 'aliyun-cosyvoice' || activeVoice?.provider === 'baidu-xiling')) {
      const provider = activeVoice.provider === 'aliyun-cosyvoice' ? 'aliyun' : 'baidu';
      const api = this.settings.providers.tts.voiceCloneApi ?? defaultSettings.providers.tts.voiceCloneApi!;
      const config = provider === 'aliyun'
        ? api.aliyun ?? defaultSettings.providers.tts.voiceCloneApi!.aliyun!
        : api.baidu ?? defaultSettings.providers.tts.voiceCloneApi!.baidu!;
      return new CloudVoiceCloneAdapter({ id: `${provider}-voice-tts`, label: provider === 'aliyun' ? '阿里云 CosyVoice 克隆音色' : '百度曦灵克隆音色', config, apiKey: this.resolveSecret(provider === 'aliyun' ? 'voiceCloneAliyun' : 'voiceCloneBaidu').value ?? '', outputDirectory: this.audioDirectory });
    }
    if (this.settings.providers.tts.adapter === 'gptsovits') {
      if (activeVoice?.provider === 'gptsovits-v3' && activeVoice.cloneMode === 'COUNTRY_ACCENT') {
        return new VoiceAccentTtsAdapter({
          baseUrl: this.getAccentSettings().baseUrl,
          voices: this.settings.providers.tts.gptsovits.voices,
          outputDirectory: this.audioDirectory,
        });
      }
      return new GptSoVitsTtsAdapter({
        baseUrl: this.settings.providers.tts.gptsovits.baseUrl,
        voices: this.settings.providers.tts.gptsovits.voices,
        outputDirectory: this.audioDirectory,
        apiVersion: this.settings.providers.tts.gptsovits.apiVersion,
        releaseGpuAfterSynthesis: this.gpuRuntimeProfile.releaseVoiceGpuAfterSynthesis,
        requireGpuRelease: this.gpuRuntimeProfile.id === 'SAFE_8GB',
      });
    }
    if (this.settings.providers.tts.adapter === 'kokoro') return new KokoroTtsAdapter({
      baseUrl: this.settings.providers.tts.kokoro.baseUrl,
      defaultVoice: this.settings.providers.tts.kokoro.defaultVoice,
      outputDirectory: this.audioDirectory,
      // The bundled CPU model can need more than two minutes for a dense
      // 30-second script. Let the first request finish instead of aborting it
      // and immediately queueing duplicate work in the single Kokoro worker.
      timeoutMs: 180_000,
    });
    if (this.settings.providers.tts.adapter === 'windows') return this.windowsTts;
    if (this.settings.providers.tts.adapter === 'elevenlabs') return new ElevenLabsTtsAdapter({
      outputDirectory: this.audioDirectory,
      baseUrl: this.settings.providers.tts.baseUrl,
      model: this.settings.providers.tts.model,
      apiKey: this.resolveSecret('tts').value ?? '',
      stability: this.settings.providers.tts.stability,
      similarityBoost: this.settings.providers.tts.similarityBoost,
      style: this.settings.providers.tts.style,
      speakerBoost: this.settings.providers.tts.speakerBoost,
    });
    return new OpenAICompatibleTtsAdapter({
      outputDirectory: this.audioDirectory,
      baseUrl: this.settings.providers.tts.baseUrl,
      model: this.settings.providers.tts.model,
      apiKey: this.resolveSecret('tts').value ?? '',
      instructions: this.settings.providers.tts.instructions,
    });
  }

  private getElevenLabsVoiceClient(): ElevenLabsVoiceClient {
    if (this.settings.providers.tts.adapter !== 'elevenlabs') throw new Error('请先把语音方式切换为 ElevenLabs 声音克隆并保存。');
    return new ElevenLabsVoiceClient({
      baseUrl: this.settings.providers.tts.baseUrl,
      apiKey: this.resolveSecret('tts').value ?? '',
    });
  }

  async listVoiceProfiles(): Promise<VoiceProfile[]> {
    return this.getElevenLabsVoiceClient().listVoices();
  }

  async cloneVoice(input: { name: string; fileName: string; mimeType: string; audio: Buffer; authorizationConfirmed: boolean }): Promise<VoiceProfile> {
    if (!input.authorizationConfirmed) throw new Error('VOICE_AUTHORIZATION_REQUIRED');
    if (!input.name.trim()) throw new Error('VOICE_NAME_REQUIRED');
    if (input.audio.length < 1_024 || input.audio.length > 10 * 1024 * 1024) throw new Error('VOICE_SAMPLE_SIZE_INVALID');
    if (!isSupportedVoiceSample(input.audio, input.mimeType, input.fileName)) throw new Error('VOICE_SAMPLE_FORMAT_INVALID');
    const voice = await this.getElevenLabsVoiceClient().cloneVoice(input);
    this.settings = this.updateSettings({ providers: { tts: { voiceId: voice.voiceId } } });
    this.persistence.recordEvent('VOICE_CLONE_CREATED', { provider: voice.provider, voiceId: voice.voiceId, name: voice.name, requiresVerification: voice.requiresVerification });
    return voice;
  }

  async testProvider(kind: 'llm' | 'tts', sampleText?: string): Promise<{ ok: true; provider: string; verifiedAt: number; sample?: unknown }> {
    if (kind === 'llm') {
      if (this.settings.providers.llm.adapter !== 'openai-compatible') throw new Error('请先把内容生成方式切换为外部兼容接口并保存。');
      const result = await this.meihuaEngine.cast({
        readingId: 'provider-test', question: 'Should I proceed with my current plan?', username: 'TestViewer', receivedAt: new Date().toISOString(), locale: 'en', seedPolicy: 'NUMBER',
        userProvidedNumbers: questionSums('TestViewer', 'Should I proceed with my current plan?', 'provider-test'),
      });
      const answer = await this.getAnswerComposer().compose({ username: 'TestViewer', question: 'Should I proceed with my current plan?', result, targetSeconds: 20, language: 'en', category: 'CAREER' });
      assertValidAnswerContent(answer);
      const verifiedAt = Date.now();
      this.providerVerification.set('llm', { fingerprint: this.providerFingerprint('llm'), verifiedAt });
      this.persistence.recordEvent('PROVIDER_TEST_PASSED', { provider: 'llm', model: this.settings.providers.llm.model, verifiedAt });
      return { ok: true, provider: 'llm', verifiedAt, sample: { keywords: answer.keywords, estimatedSeconds: answer.estimatedSeconds } };
    }
    const activeVoice = this.getActiveVoiceProfile();
    const locale = activeVoice?.language && activeVoice.language !== 'ar' ? activeVoice.language : this.settings.overlay.contentLanguage;
    const samples: Record<AppSettings['overlay']['contentLanguage'], string> = {
      en: 'Voice connection test completed successfully.',
      'zh-CN': '声音连接测试已成功完成。',
      es: 'La prueba de conexión de voz se completó correctamente.',
      fr: 'Le test de connexion vocale a réussi.',
      de: 'Der Sprachverbindungstest wurde erfolgreich abgeschlossen.',
      ja: '音声接続テストが正常に完了しました。',
      ko: '음성 연결 테스트가 성공적으로 완료되었습니다.',
      pt: 'O teste de conexão de voz foi concluído com sucesso.',
      ru: 'Проверка голосового подключения успешно завершена.',
    };
    const sampleLocale = locale === 'yue' ? 'zh-CN' : locale;
    const text = sampleText?.trim().slice(0, 500) || samples[sampleLocale];
    const audio = await this.runGpuTask('VOICE_TEST', () => this.getTtsAdapter().synthesize({
      readingId: 'provider-test', text,
      voiceId: activeVoice?.voiceId ?? this.settings.providers.tts.voiceId,
      speed: activeVoice?.speed ?? this.settings.providers.tts.speed,
      locale, targetLocale: activeVoice?.targetLocale ?? this.getVoiceTargetLocale(), targetSeconds: 5,
    }));
    if (!audio.audioPath) throw new Error('TTS_TEST_AUDIO_MISSING');
    await this.audioPlayer.play({ filePath: join(this.audioDirectory, basename(audio.audioPath)) });
    const verifiedAt = Date.now();
    this.providerVerification.set('tts', { fingerprint: this.providerFingerprint('tts'), verifiedAt });
    this.persistence.recordEvent('PROVIDER_TEST_PASSED', { provider: 'tts', model: this.settings.providers.tts.model, voice: activeVoice?.voiceId ?? this.settings.providers.tts.voiceId, verifiedAt, durationMs: audio.durationMs });
    return { ok: true, provider: 'tts', verifiedAt, sample: audio };
  }

  runMaintenance(): { removedAudioFiles: number; inbox: number; audit: number; integrity: string; backup?: string } {
    const now = Date.now();
    let removedAudioFiles = 0;
    for (const filePath of this.persistence.listTerminalAudioPathsBefore(now - 30 * 24 * 60 * 60 * 1_000)) {
      try {
        if (existsSync(filePath)) { unlinkSync(filePath); removedAudioFiles++; }
      } catch { /* A missing or locked historic audio file is reported by the next run. */ }
    }
    const pruned = this.persistence.pruneOperationalData({
      rawEventBefore: now - 7 * 24 * 60 * 60 * 1_000,
      auditBefore: now - 90 * 24 * 60 * 60 * 1_000,
    });
    const integrity = this.persistence.integrityCheck();
    const backup = this.persistence.createDailyBackup(join(process.cwd(), 'data', 'backups'), now);
    const result = { removedAudioFiles, ...pruned, integrity, backup };
    this.persistence.runMaintenanceRecord('DAILY_RETENTION', result);
    return result;
  }

  updateSettings(patch: AppSettingsPatch): AppSettings {
    const previousLlmOrigin = providerOrigin(this.settings.providers.llm.baseUrl);
    const previousTtsOrigin = providerOrigin(this.settings.providers.tts.baseUrl);
    const incomingVoices = patch.providers?.tts?.gptsovits?.voices?.map((voice) => {
      const internal = this.settings.providers.tts.gptsovits.voices.find((item) => item.id === voice.id);
      return { ...voice, refAudioPath: internal?.refAudioPath ?? voice.refAudioPath };
    });
    const next = normalizeSettings({
      ...this.settings,
      ...patch,
      queue: { ...this.settings.queue, ...patch.queue },
      moderation: { ...this.settings.moderation, ...patch.moderation },
      reading: { ...this.settings.reading, ...patch.reading },
      meihua: { ...this.settings.meihua, ...patch.meihua },
      gifts: {
        ...this.settings.gifts,
        ...patch.gifts,
        rules: patch.gifts?.rules ?? this.settings.gifts.rules,
      },
      engagement: {
        ...this.settings.engagement,
        ...patch.engagement,
        likeRules: patch.engagement?.likeRules ?? this.settings.engagement.likeRules,
        commentRules: patch.engagement?.commentRules ?? this.settings.engagement.commentRules,
      },
      overlay: {
        ...this.settings.overlay,
        ...patch.overlay,
        effects: { ...this.settings.overlay.effects, ...patch.overlay?.effects },
        modules: Object.fromEntries(Object.entries(this.settings.overlay.modules).map(([id, value]) => [id, { ...value, ...patch.overlay?.modules?.[id as keyof AppSettings['overlay']['modules']] }])) as AppSettings['overlay']['modules'],
      },
      providers: {
        ...this.settings.providers,
        ...patch.providers,
        liveInput: { ...this.settings.providers.liveInput, ...patch.providers?.liveInput },
        llm: { ...this.settings.providers.llm, ...patch.providers?.llm },
        tts: { ...this.settings.providers.tts, ...patch.providers?.tts,
          gptsovits: { ...this.settings.providers.tts.gptsovits, ...patch.providers?.tts?.gptsovits,
            voices: incomingVoices ?? this.settings.providers.tts.gptsovits.voices },
          accent: { ...this.getAccentSettings(), ...patch.providers?.tts?.accent,
            profiles: patch.providers?.tts?.accent?.profiles ?? this.getAccentSettings().profiles } },
        avatar: { ...this.settings.providers.avatar, ...patch.providers?.avatar },
      },
      audioBus: { ...this.settings.audioBus, ...patch.audioBus },
      presentation: {
        ...this.settings.presentation,
        ...patch.presentation,
        profiles: patch.presentation?.profiles ?? this.settings.presentation.profiles,
      },
    });
    if (patch.queue?.expireMinutes !== undefined) {
      const entitlementExpireMinutes = next.queue.expireMinutes;
      next.gifts.entitlementExpireMinutes = entitlementExpireMinutes;
      next.engagement.likeRules = next.engagement.likeRules.map((rule) => ({ ...rule, grantExpireMinutes: entitlementExpireMinutes }));
      next.engagement.commentRules = next.engagement.commentRules.map((rule) => ({ ...rule, queueExpireMinutes: entitlementExpireMinutes }));
    }
    const nextLlmOrigin = providerOrigin(next.providers.llm.baseUrl);
    const nextTtsOrigin = providerOrigin(next.providers.tts.baseUrl);
    if (next.meihua.engine !== this.settings.meihua.engine) {
      this.meihuaEngine = next.meihua.engine === 'LEGACY_V2_1' ? new DeterministicMeihuaEngine() : new MingyuMeihuaEngine();
      this.persistence.recordEvent('MEIHUA_ENGINE_SWITCHED', { engine: next.meihua.engine });
    }
    if (previousLlmOrigin && previousLlmOrigin !== nextLlmOrigin) {
      deleteDpapiSecret(this.llmSecretPath);
      this.providerVerification.delete('llm');
      this.persistence.recordEvent('PROVIDER_SECRET_CLEARED_FOR_ORIGIN_CHANGE', { provider: 'llm', previousOrigin: previousLlmOrigin, nextOrigin: nextLlmOrigin || 'INVALID' });
    }
    if (previousTtsOrigin && previousTtsOrigin !== nextTtsOrigin && !next.providers.tts.reuseLlmKey) {
      deleteDpapiSecret(this.ttsSecretPath);
      this.providerVerification.delete('tts');
      this.persistence.recordEvent('PROVIDER_SECRET_CLEARED_FOR_ORIGIN_CHANGE', { provider: 'tts', previousOrigin: previousTtsOrigin, nextOrigin: nextTtsOrigin || 'INVALID' });
    }
    this.settings = next;
    if (patch.queue?.expireMinutes !== undefined) {
      this.persistence.alignPendingQualificationExpiry(this.settings.queue.expireMinutes);
    }
    this.persistence.setSetting('settings', this.settings);
    this.tikfinity.configure(this.settings.providers.liveInput.url);
    if (this.settings.providers.liveInput.adapter === 'tikfinity') this.startTikfinityInput();
    else void this.tikfinity.stop();
    this.vtube.configure(this.settings.providers.avatar.url, readDpapiSecret(this.vtubeTokenPath));
    this.persistence.recordEvent('SETTINGS_UPDATED', { settings: this.settings });
    this.publishSnapshot();
    return this.settings;
  }

  resetSettings(): AppSettings {
    this.settings = structuredClone(this.initialSettings);
    this.persistence.setSetting('settings', this.settings);
    this.tikfinity.configure(this.settings.providers.liveInput.url);
    if (this.settings.providers.liveInput.adapter === 'tikfinity') this.startTikfinityInput();
    else void this.tikfinity.stop();
    this.vtube.configure(this.settings.providers.avatar.url, readDpapiSecret(this.vtubeTokenPath));
    this.persistence.recordEvent('SETTINGS_RESET_TO_CONFIG', { settings: this.settings });
    this.publishSnapshot();
    return this.settings;
  }

  getHealth(): RuntimeHealth {
    const usingVtube = this.settings.providers.avatar.adapter === 'vtube-studio';
    const providers = providerHealth(this.settings.providers, { input: this.liveInput, tikfinity: this.tikfinity, tts: this.getTtsAdapter(), avatar: usingVtube ? this.vtube : this.avatarProvider });
    if (this.settings.providers.llm.adapter === 'openai-compatible') {
      const secret = this.resolveSecret('llm');
      const configured = Boolean(secret.value && this.settings.providers.llm.baseUrl && this.settings.providers.llm.model);
      const verified = configured && this.providerVerification.get('llm')?.fingerprint === this.providerFingerprint('llm');
      providers[1] = {
        id: 'openai-compatible', label: '外部结构化内容生成', configured,
        status: !configured ? 'NOT_CONFIGURED' : verified ? 'READY' : 'DEGRADED',
        message: !configured ? '需要接口地址、模型和 API Key' : verified ? '已完成真实 JSON Schema 调用验证' : '配置已保存，尚未执行真实连接测试',
      };
    }
    const activeConfiguredVoice = this.getActiveVoiceProfile();
    if (activeConfiguredVoice?.provider === 'aliyun-cosyvoice' || activeConfiguredVoice?.provider === 'baidu-xiling') {
      const cloudProvider = activeConfiguredVoice.provider === 'aliyun-cosyvoice' ? 'aliyun' : 'baidu';
      const cloudHealth = this.getCloudVoiceAdapter(cloudProvider).health();
      const verified = activeConfiguredVoice.status === 'READY' && Boolean(activeConfiguredVoice.previewUrl);
      providers[2] = { ...cloudHealth, status: !cloudHealth.configured ? 'NOT_CONFIGURED' : verified ? 'READY' : 'DEGRADED', message: verified ? `${cloudProvider === 'aliyun' ? '阿里云' : '百度曦灵'}克隆音色已通过真实试听` : cloudHealth.message };
    } else if (this.settings.providers.tts.adapter === 'kokoro') {
      const configured = Boolean(this.settings.providers.tts.kokoro.baseUrl && this.settings.providers.tts.kokoro.defaultVoice);
      const serviceReady = configured && this.kokoroServiceHealth.ready && Date.now() - this.kokoroServiceHealth.checkedAt < 60_000;
      providers[2] = {
        id: 'kokoro-tts', label: 'Kokoro 本地英文女声', configured,
        status: !configured ? 'NOT_CONFIGURED' : serviceReady ? 'READY' : 'DEGRADED',
        message: !configured ? '需要 Kokoro 本地服务配置' : serviceReady ? '本地 Kokoro 模型与音色服务已就绪' : this.kokoroServiceHealth.detail,
      };
    } else if (this.settings.providers.tts.adapter === 'gptsovits') {
      const voices = this.settings.providers.tts.gptsovits.voices.length;
      const activeVoice = this.getActiveVoiceProfile();
      // Verification used to live only in memory. After a service restart a
      // previously tested local voice therefore became DEGRADED even though
      // its persisted preview WAV was still present and playable, blocking
      // every LIVE session. Treat a valid persisted preview as durable
      // verification evidence, while still requiring the exact file to exist
      // under the controlled audio directory.
      const previewFileName = activeVoice?.previewUrl?.match(/^\/api\/audio\/([^/?#]+)$/)?.[1];
      const persistedPreviewVerified = Boolean(previewFileName && existsSync(join(this.audioDirectory, basename(decodeURIComponent(previewFileName)))));
      const verified = persistedPreviewVerified || this.providerVerification.get('tts')?.fingerprint === this.providerFingerprint('tts');
      const accentMode = activeVoice?.cloneMode === 'COUNTRY_ACCENT';
      const accentConfigured = Boolean(this.getAccentSettings().baseUrl && activeVoice?.accentProfileId && this.getAccentSettings().profiles.some((profile) => profile.id === activeVoice.accentProfileId && profile.enabled));
      const accentReady = !accentMode || this.digitalHumanServiceHealth.accent;
      providers[2] = {
        id: accentMode ? 'openvoice-accent-tts' : 'gptsovits-tts', label: accentMode ? 'OpenVoice 本地目标口音' : 'GPT-SoVITS 本地声音克隆',
        configured: voices > 0 && (!accentMode || accentConfigured),
        status: !voices || (accentMode && !accentConfigured) ? 'NOT_CONFIGURED' : !accentReady ? 'DEGRADED' : verified ? 'READY' : 'DEGRADED',
        message: !voices
          ? '需要上传至少一个音色（参考音频+文字）'
          : accentMode && !accentConfigured ? '目标口音服务或口音配置不可用'
            : accentMode && !accentReady ? '目标口音服务当前未通过健康检查；不能用于正式播报'
            : verified ? `已通过真实试音（${voices} 个音色可用）` : '音色已配置，需试音验证后才用于正式直播',
      };
    } else if (this.settings.providers.tts.adapter !== 'windows') {
      const secret = this.resolveSecret('tts');
      const configured = Boolean(secret.value && this.settings.providers.tts.baseUrl && this.settings.providers.tts.model && this.settings.providers.tts.voiceId);
      const verified = configured && this.providerVerification.get('tts')?.fingerprint === this.providerFingerprint('tts');
      const cloned = this.settings.providers.tts.adapter === 'elevenlabs';
      providers[2] = {
        id: cloned ? 'elevenlabs-tts' : 'openai-compatible-tts', label: cloned ? 'ElevenLabs 授权声音克隆' : '外部语音生成', configured,
        status: !configured ? 'NOT_CONFIGURED' : verified ? 'READY' : 'DEGRADED',
        message: !configured
          ? (cloned ? '需要 ElevenLabs API Key、multilingual 模型和真实克隆 voiceId' : '需要接口地址、模型、声音和 API Key')
          : verified ? '已生成真实 WAV，并通过 Windows 默认设备完成试听'
            : (cloned ? '克隆声音已选择，但尚未完成真实多语言 WAV 试听' : '配置已保存，尚未生成真实 WAV 试听'),
      };
    }
    const hasAvatarAsset = Object.values(this.publishedProfileVersion.profile.avatar.slots)
      .some((slot) => slot.assetId && this.persistence.getMediaAsset(slot.assetId));
    if (this.settings.providers.avatar.adapter === 'none') {
      providers[3] = {
        id: 'obs-media-avatar', label: 'OBS 人物素材源', configured: hasAvatarAsset,
        status: hasAvatarAsset ? 'READY' : 'NOT_CONFIGURED',
        message: hasAvatarAsset ? '人物动作素材由 /obs/source/avatar 按导演阶段自动切换' : '尚未上传并绑定人物素材；可不显示人物，但不能标记为已配置',
      };
    } else if (usingVtube) {
      providers[3] = this.vtube.health();
    } else if (this.settings.providers.avatar.adapter === 'mock') {
      providers[3] = this.avatarProvider.health();
    } else if (this.settings.providers.avatar.adapter === 'musetalk') {
      providers[3] = this.avatarProvider.health();
    } else if (this.settings.providers.avatar.adapter === 'local-vrm' || this.settings.providers.avatar.adapter === 'baidu-cloud' || this.settings.providers.avatar.adapter === 'aliyun-cloud') {
      providers[3] = this.avatarProvider.health();
    } else {
      providers[3] = { id: 'warudo-reserved', label: 'Warudo 预留', configured: false, status: 'NOT_CONFIGURED', message: '当前仅保留协议，尚未实现，不能用于正式直播' };
    }
    return {
      autoProcessing: this.autoProcessing,
      acceptingQuestions: this.acceptingQuestions,
      currentReadingId: this.active?.readingId,
      replayReadingId: this.replay?.reading.id,
      queueLength: this.queue.size,
      input: providers[0].status,
      llm: providers[1].status,
      tts: providers[2].status,
      avatar: providers[3].status,
      overlayClients: this.overlayClients.size,
      uptimeMs: Date.now() - this.startedAt,
      providers,
      tikfinity: this.tikfinity.diagnostics(),
      vtube: this.vtube.getState(),
      avatarProvider: this.avatarProvider.getState(),
      sync: structuredClone(this.syncMetrics),
      metrics: this.persistence.getDashboardMetrics(),
      currentSession: this.currentSession,
      currentStage: this.getDirectorStage(),
      activeCue: this.activeCue,
    };
  }

  getPreflight(mode: LiveSessionMode = 'REHEARSAL'): { ready: boolean; checks: Array<{ id: string; label: string; status: 'PASS' | 'WARN' | 'FAIL'; message: string }> } {
    const health = this.getHealth();
    const missingAssets = Object.values(this.publishedProfileVersion.profile.avatar.slots)
      .filter((slot) => slot.assetId && !this.persistence.getMediaAsset(slot.assetId)).length;
    const usingVtube = this.settings.providers.avatar.adapter === 'vtube-studio';
    const missingObsSources = this.getObsSourceHealth().filter((source) => source.enabled && !source.connected);
    const mockQueueItems = mode === 'LIVE' ? this.getQueueOverview().filter((item) => item.eventSource === 'MOCK') : [];
    const tikfinityStatus = health.tikfinity?.verified ? 'PASS' as const : mode === 'LIVE' ? 'FAIL' as const : 'WARN' as const;
    const vtubeStatus = usingVtube && health.vtube?.authenticated && health.vtube?.model?.modelLoaded ? 'PASS' as const : 'WARN' as const;
    // This check describes the host playback path, not the currently selected TTS
    // provider. Provider readiness is reported separately by the `tts` check.
    const nativeAudioStatus = process.platform === 'win32' ? 'PASS' as const : 'FAIL' as const;
    const activeVoice = (this.settings.providers.tts.voiceProfiles ?? []).find((profile) => (profile.id ?? profile.voiceId) === this.settings.providers.tts.activeVoiceProfileId);
    const activeAvatar = (this.settings.providers.avatar.profiles ?? []).find((profile) => profile.id === this.settings.providers.avatar.activeProfileId);
    const avatarReady = activeAvatar?.provider === 'LOCAL_VIDEO'
      ? Boolean(this.settings.providers.avatar.adapter === 'musetalk' && activeAvatar.preparedAvatarId && health.avatar === 'READY')
      : activeAvatar?.provider === 'ALIYUN_CLOUD' || activeAvatar?.provider === 'BAIDU_CLOUD'
        ? Boolean(activeAvatar.cloudFigureId && activeAvatar.cloudVideoUrl)
        : Boolean(activeAvatar?.status === 'READY');
    const digitalHumanReady = Boolean(activeVoice?.status === 'READY' && activeAvatar?.status === 'READY' && avatarReady && (activeVoice.provider !== 'gptsovits-v3' || activeVoice.cloneMode !== 'COUNTRY_ACCENT' || (this.digitalHumanServiceHealth.accent && this.getAccentSettings().profiles.some((profile) => profile.id === activeVoice.accentProfileId && profile.enabled))));
    const presentationPreflight = this.getPresentationPreflight();
    const usingDigitalHuman = this.settings.presentation.mode === 'DIGITAL_HUMAN';
    const liveCudaRequired = mode === 'LIVE' && usingDigitalHuman && activeAvatar?.provider === 'LOCAL_VIDEO';
    const liveCudaReady = !liveCudaRequired || this.gpuRuntimeProfile.id !== 'CPU_COMPAT';
    const digitalHumanCheckStatus = !usingDigitalHuman || digitalHumanReady ? 'PASS' as const : presentationPreflight.ready ? 'WARN' as const : 'FAIL' as const;
    const checks = [
      { id: 'database', label: '本地数据库', status: 'PASS' as const, message: 'V2 数据库可读写' },
      { id: 'scene', label: '已发布场景', status: missingAssets ? 'FAIL' as const : 'PASS' as const, message: missingAssets ? `${missingAssets} 个数字人动作素材缺失` : `已发布版本 v${this.publishedProfileVersion.version}` },
      { id: 'tts', label: '语音输出', status: health.tts === 'READY' ? 'PASS' as const : 'FAIL' as const, message: health.providers.find((item) => item.id === 'tts' || item.id.endsWith('-tts'))?.message ?? health.tts },
      { id: 'presentation', label: '画面模式', status: presentationPreflight.ready ? 'PASS' as const : 'FAIL' as const, message: presentationPreflight.checks.find((item) => item.id === 'presentation')?.message ?? '画面模式未就绪' },
      { id: 'digital-human', label: '已选数字人组合', status: digitalHumanCheckStatus, message: !usingDigitalHuman ? '当前使用预录视频或仅声音，不检查实时数字人' : digitalHumanReady ? '声音、目标口音和头像类型一致' : presentationPreflight.ready ? '数字人未就绪，已配置画面回退策略' : '当前声音或视频数字人尚未完整就绪' },
      { id: 'cuda-live', label: '实时 CUDA', status: liveCudaReady ? 'PASS' as const : 'FAIL' as const, message: liveCudaReady ? '实时数字人口型运行环境可用' : '当前为 CPU 慢速验证模式；实时直播必须识别到 NVIDIA CUDA' },
      { id: 'tikfinity', label: 'TikFinity', status: tikfinityStatus, message: health.tikfinity?.verified ? '已收到并验证合法真实事件' : mode === 'LIVE' ? '正式开播必须收到一条合法 TikFinity 事件' : '本地排练可不连接 TikFinity' },
      { id: 'native-audio', label: '本机语音播放路径', status: nativeAudioStatus, message: nativeAudioStatus === 'PASS' ? '后台将已生成 WAV 直接播放到 Windows 默认输出设备，不需要 OBS 音频浏览器源' : '当前主机不是 Windows，不能使用本机生产播放路径' },
      { id: 'obs-sources', label: 'OBS 画面来源', status: missingObsSources.length ? (mode === 'LIVE' ? 'FAIL' as const : 'WARN' as const) : 'PASS' as const, message: missingObsSources.length ? `未连接：${missingObsSources.map((source) => source.sourceId).join('、')}` : '所有已启用 OBS 浏览器来源均已连接' },
      { id: 'data-provenance', label: '正式队列来源', status: mockQueueItems.length ? 'FAIL' as const : 'PASS' as const, message: mockQueueItems.length ? `仍有 ${mockQueueItems.length} 条 MOCK 模拟资格或任务；清理或归档后才能正式开播` : '当前队列中没有模拟事件残留' },
      { id: 'vtube', label: '数字人动作（可选）', status: vtubeStatus, message: vtubeStatus === 'PASS' ? `模型已连接：${health.vtube?.model?.modelName ?? '已加载模型'}；仅触发阶段动作，不驱动口型` : '不阻止开播；可使用遮口人物、预录人物，或稍后连接 VTube Studio 阶段动作' },
      { id: 'avatar-assets', label: '预录人物回退', status: Object.values(this.publishedProfileVersion.profile.avatar.slots).some((slot) => slot.assetId) ? 'PASS' as const : 'WARN' as const, message: Object.values(this.publishedProfileVersion.profile.avatar.slots).some((slot) => slot.assetId) ? '预录人物回退已配置' : '没有预录人物回退素材；VTube Studio 直连时不影响正式人物画面' },
    ];
    return { ready: checks.every((item) => item.status !== 'FAIL'), checks };
  }

  startSession(input: { operatorNote?: string; mode?: LiveSessionMode } = {}): { ok: boolean; session?: LiveSession; preflight: ReturnType<LiveRuntime['getPreflight']>; reason?: string } {
    const mode = input.mode ?? 'REHEARSAL';
    const preflight = this.getPreflight(mode);
    if (this.currentSession && this.currentSession.status !== 'ENDED') return { ok: false, session: this.currentSession, preflight, reason: '已有未结束直播场次。' };
    if (mode === 'LIVE' && preflight.checks.some((item) => (item.id === 'presentation' || item.id === 'cuda-live' || item.id === 'tts' || item.id === 'native-audio') && item.status === 'FAIL')) {
      const failed = preflight.checks.filter((item) => item.status === 'FAIL').map((item) => item.id);
      this.persistence.recordEvent('LIVE_SESSION_BLOCKED_PRESENTATION_NOT_READY', { checks: failed, mode: this.settings.presentation.mode });
      return { ok: false, preflight, reason: failed.includes('cuda-live') ? 'CUDA_REQUIRED_FOR_LIVE' : failed.includes('presentation') ? (this.settings.presentation.mode === 'DIGITAL_HUMAN' ? 'DIGITAL_HUMAN_NOT_READY' : 'PRESENTATION_VIDEO_NOT_READY') : 'LIVE_PREFLIGHT_FAILED' };
    }
    // Health checks remain visible diagnostics, but the operator owns the
    // decision to start. Missing optional sources/providers must not disable
    // the single "立即开播" control.
    const warnings = preflight.checks.filter((item) => item.status !== 'PASS');
    const now = Date.now();
    this.currentSession = {
      sessionId: randomUUID(), mode, status: 'LIVE', profileVersionId: this.publishedProfileVersion.versionId,
      startedAt: now, lastHeartbeatAt: now, operatorNote: input.operatorNote?.trim() || undefined,
    };
    this.directorSequence = 0;
    this.activeCue = undefined;
    this.sideCues.clear();
    this.persistence.saveLiveSession(this.currentSession);
    this.acceptingQuestions = true;
    this.autoProcessing = true;
    this.startDirectorCue('IDLE', undefined, { statusText: '直播已开始，等待符合资格的观众' });
    this.persistence.recordEvent('LIVE_SESSION_STARTED', { sessionId: this.currentSession.sessionId, mode, profileVersionId: this.currentSession.profileVersionId, warnings: warnings.map((item) => item.id) });
    this.broadcastV2('SESSION_CHANGED', this.currentSession);
    this.publishSnapshot();
    if (this.settings.providers.liveInput.adapter === 'tikfinity') this.startTikfinityInput();
    this.ensureQueueProcessing();
    return { ok: true, session: this.currentSession, preflight };
  }

  pauseSession(): { ok: boolean; session?: LiveSession; reason?: string } {
    if (!this.currentSession || this.currentSession.status !== 'LIVE') return { ok: false, session: this.currentSession, reason: '当前没有可暂停的直播场次。' };
    this.currentSession = { ...this.currentSession, status: 'PAUSED', lastHeartbeatAt: Date.now() };
    this.persistence.saveLiveSession(this.currentSession);
    this.acceptingQuestions = false;
    // Keep the diagnostics socket connected; liveIntakeOpen() blocks intake.
    this.startDirectorCue('PAUSED', undefined, { reason: 'OPERATOR_PAUSE' }, 'SYSTEM');
    this.persistence.recordEvent('LIVE_SESSION_PAUSED', { sessionId: this.currentSession.sessionId });
    this.broadcastV2('SESSION_CHANGED', this.currentSession);
    this.publishSnapshot();
    return { ok: true, session: this.currentSession };
  }

  resumeSession(): { ok: boolean; session?: LiveSession; reason?: string } {
    if (!this.currentSession || this.currentSession.status !== 'PAUSED') return { ok: false, session: this.currentSession, reason: '当前没有已暂停的直播场次。' };
    this.currentSession = { ...this.currentSession, status: 'LIVE', lastHeartbeatAt: Date.now() };
    this.persistence.saveLiveSession(this.currentSession);
    this.acceptingQuestions = true;
    this.autoProcessing = true;
    if (this.settings.providers.liveInput.adapter === 'tikfinity') this.startTikfinityInput();
    if (!this.active) this.startDirectorCue('IDLE', undefined, { statusText: '已恢复事件接入' });
    this.persistence.recordEvent('LIVE_SESSION_RESUMED', { sessionId: this.currentSession.sessionId });
    this.broadcastV2('SESSION_CHANGED', this.currentSession);
    this.publishSnapshot();
    this.ensureQueueProcessing();
    return { ok: true, session: this.currentSession };
  }

  endSession(input: { operatorNote?: string } = {}): { ok: boolean; session?: LiveSession; reason?: string } {
    if (!this.currentSession || ['ENDED', 'ENDING'].includes(this.currentSession.status)) return { ok: false, session: this.currentSession, reason: '当前没有可正常收播的场次。' };
    this.currentSession = { ...this.currentSession, status: 'ENDING', lastHeartbeatAt: Date.now(), operatorNote: input.operatorNote?.trim() || this.currentSession.operatorNote };
    this.persistence.saveLiveSession(this.currentSession);
    this.acceptingQuestions = false;
    // Keep the diagnostics socket connected between live sessions.
    this.persistence.recordEvent('LIVE_SESSION_END_REQUESTED', { sessionId: this.currentSession.sessionId });
    if (!this.active) this.finalizeSession('NORMAL_END');
    else this.broadcastV2('SESSION_CHANGED', this.currentSession);
    this.publishSnapshot();
    return { ok: true, session: this.currentSession };
  }

  abortSession(input: { reason?: string } = {}): { ok: boolean; session?: LiveSession; reason?: string } {
    if (!this.currentSession || this.currentSession.status === 'ENDED') return { ok: false, session: this.currentSession, reason: '当前没有可立即收播的场次。' };
    this.autoProcessing = false;
    this.acceptingQuestions = false;
    this.skipCurrent();
    this.finalizeSession(input.reason?.trim() || 'IMMEDIATE_ABORT');
    return { ok: true, session: this.currentSession };
  }

  getCurrentSession(): LiveSession | undefined { return this.currentSession; }

  getSessionReport(sessionId: string) {
    const session = this.persistence.getLiveSession(sessionId);
    if (!session) return undefined;
    return {
      session,
      cues: this.persistence.listDirectorCues(sessionId, 1_000).reverse(),
      giftRanking: this.persistence.getSessionGiftRanking(sessionId, 100),
      engagementRanking: this.persistence.getSessionEngagementRanking(sessionId, 100),
      readings: this.persistence.listReadings({ limit: 500 }).filter((reading) => reading.sessionId === sessionId),
    };
  }

  getDirectorCues(limit = 200): DirectorCue[] {
    return this.currentSession ? this.persistence.listDirectorCues(this.currentSession.sessionId, limit) : [];
  }

  getDirectorState() { return { session: this.currentSession, stage: this.getDirectorStage(), activeCue: this.activeCue, snapshot: this.getBroadcastSnapshotV2() }; }

  getSceneDraft(): SceneProfileVersion { return this.draftProfileVersion; }
  getSceneVersions(): SceneProfileVersion[] { return this.persistence.listSceneProfileVersions('main'); }

  private normalizeSceneProfile(profile: SceneProfile): SceneProfile {
    if (profile.profileId !== 'main') throw new Error('SCENE_PROFILE_ID_MISMATCH');
    for (const [sourceId, source] of Object.entries(profile.sources)) {
      if (source.sourceId !== sourceId) throw new Error(`SOURCE_ID_MISMATCH:${sourceId}`);
      if (source.width < 160 || source.width > 1920 || source.height < 60 || source.height > 1920) throw new Error(`SOURCE_SIZE_INVALID:${sourceId}`);
      if (!Number.isFinite(source.fontScale) || source.fontScale < 0.5 || source.fontScale > 2.5) throw new Error(`SOURCE_FONT_SCALE_INVALID:${sourceId}`);
      if (source.giftOffers) {
        if (sourceId !== 'gift-alert' || source.giftOffers.length > 20) throw new Error(`GIFT_OFFERS_INVALID:${sourceId}`);
        const offerIds = new Set<string>();
        const giftIds = new Set<string>();
        for (const offer of source.giftOffers) {
          if (!offer.id?.trim() || offerIds.has(offer.id) || !offer.giftId?.trim() || giftIds.has(offer.giftId) || !offer.giftName?.trim() || typeof offer.message !== 'string' || !Number.isFinite(offer.speechTargetSeconds) || offer.speechTargetSeconds < 5 || offer.speechTargetSeconds > 600 || (offer.coins !== undefined && (!Number.isFinite(offer.coins) || offer.coins < 0))) throw new Error(`GIFT_OFFER_INVALID:${offer.id}`);
          offerIds.add(offer.id); giftIds.add(offer.giftId);
        }
      }
    }
    const normalized = migrateSceneComposition(profile);
    normalized.sources.avatar = { ...normalized.sources.avatar, decorationAssetId: undefined };
    this.validateComposition(normalized);
    return normalized;
  }

  updateSceneDraft(profile: SceneProfile): SceneProfileVersion {
    const normalized = this.normalizeSceneProfile(profile);
    this.draftProfileVersion = { ...this.draftProfileVersion, profile: structuredClone(normalized), createdAt: Date.now() };
    this.persistence.saveSceneProfileVersion(this.draftProfileVersion);
    this.persistence.recordEvent('SCENE_DRAFT_UPDATED', { versionId: this.draftProfileVersion.versionId });
    return this.draftProfileVersion;
  }

  publishSceneDraft(input: { profile?: SceneProfile; expectedVersion?: number } = {}): { ok: boolean; version?: SceneProfileVersion; draftVersion?: number; draftVersionId?: string; publishedVersionId?: string; publishedAt?: number; sceneHash?: string; reason?: string } {
    if (input.expectedVersion !== undefined && input.expectedVersion !== this.draftProfileVersion.version) {
      return { ok: false, reason: 'SCENE_DRAFT_VERSION_CONFLICT' };
    }
    const now = Date.now();
    const profile = input.profile ? this.normalizeSceneProfile(input.profile) : this.draftProfileVersion.profile;
    const published = { ...this.draftProfileVersion, profile: structuredClone(profile), status: 'PUBLISHED' as const, publishedAt: now, createdAt: now };
    const nextDraft: SceneProfileVersion = {
      versionId: randomUUID(), profileId: 'main', version: published.version + 1,
      status: 'DRAFT', profile: structuredClone(published.profile), createdAt: now,
    };
    const nextSession = this.currentSession && this.currentSession.status !== 'ENDED'
      ? { ...this.currentSession, profileVersionId: published.versionId, lastHeartbeatAt: now }
      : undefined;
    this.persistence.publishSceneProfile({ published, nextDraft, session: nextSession });
    this.publishedProfileVersion = published;
    if (nextSession) this.currentSession = nextSession;
    this.draftProfileVersion = nextDraft;
    this.persistence.recordEvent('SCENE_PROFILE_PUBLISHED', { versionId: this.publishedProfileVersion.versionId, version: this.publishedProfileVersion.version });
    this.broadcastV2('PROFILE_PUBLISHED', this.publishedProfileVersion);
    const sceneHash = createHash('sha256').update(JSON.stringify(this.publishedProfileVersion.profile)).digest('hex');
    return { ok: true, version: this.publishedProfileVersion, draftVersion: nextDraft.version, draftVersionId: nextDraft.versionId, publishedVersionId: this.publishedProfileVersion.versionId, publishedAt: now, sceneHash };
  }

  restoreSceneVersion(versionId: string): { ok: boolean; draft?: SceneProfileVersion; reason?: string } {
    const version = this.persistence.getSceneProfileVersion(versionId);
    if (!version) return { ok: false, reason: '场景版本不存在。' };
    this.draftProfileVersion = { ...this.draftProfileVersion, profile: structuredClone(version.profile), createdAt: Date.now() };
    this.persistence.saveSceneProfileVersion(this.draftProfileVersion);
    return { ok: true, draft: this.draftProfileVersion };
  }

  listMediaAssets(): MediaAsset[] { return this.persistence.listMediaAssets().map((asset) => this.toPublicMediaAsset(asset)); }

  getPresentationSettings(): PresentationSettings {
    return structuredClone(this.settings.presentation);
  }

  listPresentationVideos(): VideoPresentationProfile[] {
    return structuredClone(this.settings.presentation.profiles);
  }

  private getPresentationProfile(id?: string): VideoPresentationProfile | undefined {
    if (!id) return undefined;
    return this.settings.presentation.profiles.find((profile) => profile.id === id);
  }

  private probeVideoDurationMs(filePath: string): number | undefined {
    const ffmpeg = bundledFfmpegPath();
    if (!ffmpeg || !existsSync(filePath)) return undefined;
    const result = spawnSync(ffmpeg, ['-hide_banner', '-i', filePath], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    const match = /Duration:\s*(\d+):(\d{2}):(\d+(?:\.\d+)?)/i.exec(output);
    if (!match) return undefined;
    const durationMs = (Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3])) * 1_000;
    return Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : undefined;
  }

  private validatePresentationVideoAsset(assetId: string): { asset: MediaAsset; durationMs: number } {
    const asset = this.persistence.getMediaAsset(assetId);
    const sourcePath = asset ? this.resolveAssetPath(asset) : undefined;
    if (!asset || !asset.mimeType.startsWith('video/') || !sourcePath || !existsSync(sourcePath)) throw new Error('PRESENTATION_VIDEO_NOT_FOUND');
    const durationMs = asset.durationMs && asset.durationMs > 0 ? asset.durationMs : this.probeVideoDurationMs(sourcePath);
    if (!durationMs) throw new Error('PRESENTATION_VIDEO_INVALID');
    if (asset.durationMs !== durationMs) this.persistence.saveMediaAsset({ ...asset, durationMs });
    return { asset: { ...asset, durationMs }, durationMs };
  }

  createVideoPresentationProfile(input: { name?: string; assetId: string; playback?: 'LOOP' | 'ONCE'; fit?: 'COVER' | 'CONTAIN' }): VideoPresentationProfile {
    const validated = this.validatePresentationVideoAsset(input.assetId);
    const now = Date.now();
    const profile: VideoPresentationProfile = {
      id: randomUUID(),
      name: asText(input.name, basename(validated.asset.fileName, extname(validated.asset.fileName)) || '预录视频', 80),
      assetId: validated.asset.id,
      status: 'READY',
      playback: input.playback === 'ONCE' ? 'ONCE' : 'LOOP',
      fit: input.fit === 'CONTAIN' ? 'CONTAIN' : 'COVER',
      durationMs: validated.durationMs,
      createdAt: now,
      updatedAt: now,
    };
    this.updateSettings({ presentation: { profiles: [...this.settings.presentation.profiles, profile] } });
    this.persistence.recordEvent('PRESENTATION_VIDEO_PROFILE_CREATED', { id: profile.id, assetId: profile.assetId, playback: profile.playback });
    return profile;
  }

  validateVideoPresentationProfile(id: string): VideoPresentationProfile {
    const profile = this.getPresentationProfile(id);
    if (!profile) throw new Error('PRESENTATION_VIDEO_PROFILE_NOT_FOUND');
    try {
      const validated = this.validatePresentationVideoAsset(profile.assetId);
      const next = { ...profile, status: 'READY' as const, durationMs: validated.durationMs, lastError: undefined, updatedAt: Date.now() };
      this.updateSettings({ presentation: { profiles: this.settings.presentation.profiles.map((item) => item.id === id ? next : item) } });
      this.persistence.recordEvent('PRESENTATION_VIDEO_PROFILE_VALIDATED', { id, durationMs: validated.durationMs });
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'PRESENTATION_VIDEO_INVALID';
      const next = { ...profile, status: 'FAILED' as const, lastError: message, updatedAt: Date.now() };
      this.updateSettings({ presentation: { profiles: this.settings.presentation.profiles.map((item) => item.id === id ? next : item) } });
      throw error;
    }
  }

  activateVideoPresentationProfile(id: string): VideoPresentationProfile {
    const profile = this.getPresentationProfile(id);
    if (!profile) throw new Error('PRESENTATION_VIDEO_PROFILE_NOT_FOUND');
    if (profile.status !== 'READY') throw new Error('PRESENTATION_VIDEO_NOT_READY');
    this.validatePresentationVideoAsset(profile.assetId);
    this.updateSettings({ presentation: { activeVideoProfileId: id, fallbackVideoProfileId: this.settings.presentation.fallbackVideoProfileId ?? id } });
    this.persistence.recordEvent('PRESENTATION_VIDEO_PROFILE_ACTIVATED', { id, appliesFrom: 'NEXT_READING' });
    this.publishSnapshot('STATE_CHANGED');
    return profile;
  }

  disableVideoPresentationProfile(id: string): VideoPresentationProfile {
    const profile = this.getPresentationProfile(id);
    if (!profile) throw new Error('PRESENTATION_VIDEO_PROFILE_NOT_FOUND');
    const next = { ...profile, status: 'DISABLED' as const, updatedAt: Date.now() };
    const activeVideoProfileId = this.settings.presentation.activeVideoProfileId === id ? undefined : this.settings.presentation.activeVideoProfileId;
    const fallbackVideoProfileId = this.settings.presentation.fallbackVideoProfileId === id ? undefined : this.settings.presentation.fallbackVideoProfileId;
    this.updateSettings({ presentation: { profiles: this.settings.presentation.profiles.map((item) => item.id === id ? next : item), activeVideoProfileId, fallbackVideoProfileId } });
    this.persistence.recordEvent('PRESENTATION_VIDEO_PROFILE_DISABLED', { id });
    return next;
  }

  updatePresentationSettings(patch: AppSettingsPatch['presentation']): PresentationSettings {
    const next = { ...this.settings.presentation, ...patch, profiles: patch?.profiles ?? this.settings.presentation.profiles };
    if (next.activeVideoProfileId && !next.profiles.some((profile) => profile.id === next.activeVideoProfileId)) throw new Error('PRESENTATION_VIDEO_PROFILE_NOT_FOUND');
    if (next.fallbackVideoProfileId && !next.profiles.some((profile) => profile.id === next.fallbackVideoProfileId)) throw new Error('PRESENTATION_VIDEO_PROFILE_NOT_FOUND');
    this.updateSettings({ presentation: next });
    return this.getPresentationSettings();
  }

  getPresentationPreflight(): { mode: PresentationMode; ready: boolean; checks: Array<{ id: string; label: string; status: 'PASS' | 'WARN' | 'FAIL'; message: string }>; activeVideoProfileId?: string; fallbackVideoProfileId?: string } {
    const settings = this.settings.presentation;
    const active = this.getPresentationProfile(settings.activeVideoProfileId);
    const fallback = this.getPresentationProfile(settings.fallbackVideoProfileId);
    const activeReady = Boolean(active && active.status === 'READY' && (() => { try { this.validatePresentationVideoAsset(active.assetId); return true; } catch { return false; } })());
    const fallbackReady = Boolean(fallback && fallback.status === 'READY' && (() => { try { this.validatePresentationVideoAsset(fallback.assetId); return true; } catch { return false; } })());
    const digitalReady = this.isDigitalHumanSelectionReady();
    const checks = settings.mode === 'AUDIO_ONLY'
      ? [{ id: 'presentation', label: '画面模式', status: 'PASS' as const, message: '仅声音模式，不需要画面资源' }]
      : settings.mode === 'DIGITAL_HUMAN'
        ? [
          { id: 'presentation', label: '画面模式', status: digitalReady ? 'PASS' as const : settings.fallbackPolicy === 'VIDEO' && fallbackReady ? 'WARN' as const : settings.fallbackPolicy === 'AUDIO_ONLY' ? 'WARN' as const : 'FAIL' as const, message: digitalReady ? '实时数字人已就绪' : settings.fallbackPolicy === 'VIDEO' && fallbackReady ? '数字人未就绪，开播时切换备用视频' : settings.fallbackPolicy === 'AUDIO_ONLY' ? '数字人未就绪，开播时仅保留声音' : '实时数字人未就绪，严格模式禁止开播' },
          { id: 'digital-human', label: '数字人组合', status: digitalReady ? 'PASS' as const : settings.fallbackPolicy === 'STRICT' ? 'FAIL' as const : 'WARN' as const, message: digitalReady ? '声音、头像和渲染能力已匹配' : settings.fallbackPolicy === 'VIDEO' && fallbackReady ? '当前数字人不可用，已配置备用视频' : settings.fallbackPolicy === 'AUDIO_ONLY' ? '当前数字人不可用，已配置仅声音回退' : '当前声音或数字人头像尚未 READY' },
        ]
        : [{ id: 'presentation', label: '预录视频', status: activeReady ? 'PASS' as const : fallbackReady ? 'WARN' as const : 'FAIL' as const, message: activeReady ? `已启用${settings.mode === 'VIDEO_ONCE' ? '单次' : '循环'}预录视频` : fallbackReady ? '默认视频不可用，将使用备用视频' : '请上传并校验一个可播放的预录视频' }];
    return { mode: settings.mode, ready: checks.every((item) => item.status !== 'FAIL'), checks, activeVideoProfileId: settings.activeVideoProfileId, fallbackVideoProfileId: settings.fallbackVideoProfileId };
  }

  private isDigitalHumanSelectionReady(): boolean {
    const voice = this.getActiveVoiceProfile();
    const avatar = (this.settings.providers.avatar.profiles ?? []).find((profile) => profile.id === this.settings.providers.avatar.activeProfileId);
    if (!voice || !avatar || avatar.status !== 'READY') return false;
    if (avatar.provider === 'LOCAL_VIDEO') return this.settings.providers.avatar.adapter === 'musetalk' && Boolean(avatar.preparedAvatarId);
    if (avatar.provider === 'ALIYUN_CLOUD') return Boolean(avatar.cloudFigureId || avatar.preparedAvatarId);
    if (avatar.provider === 'BAIDU_CLOUD') return Boolean(avatar.cloudFigureId || avatar.preparedAvatarId);
    return true;
  }

  private isReadyPresentationVideo(profile?: VideoPresentationProfile): boolean {
    if (!profile || profile.status !== 'READY') return false;
    try { this.validatePresentationVideoAsset(profile.assetId); return true; } catch { return false; }
  }

  private presentationModeForVideo(profile: VideoPresentationProfile): PresentationMode {
    return profile.playback === 'ONCE' ? 'VIDEO_ONCE' : 'VIDEO_LOOP';
  }

  private resolvePresentationSnapshot(): PresentationSnapshot {
    const settings = this.settings.presentation;
    const active = this.getPresentationProfile(settings.activeVideoProfileId);
    const fallback = this.getPresentationProfile(settings.fallbackVideoProfileId);
    if (settings.mode === 'AUDIO_ONLY') return { mode: 'AUDIO_ONLY', fallbackApplied: false, selectedAt: Date.now() };
    if (settings.mode === 'DIGITAL_HUMAN') {
      if (this.isDigitalHumanSelectionReady()) return { mode: 'DIGITAL_HUMAN', avatarProfileId: this.settings.providers.avatar.activeProfileId, fallbackApplied: false, selectedAt: Date.now() };
      if (settings.fallbackPolicy === 'VIDEO' && this.isReadyPresentationVideo(fallback)) return { mode: this.presentationModeForVideo(fallback!), videoProfileId: fallback!.id, fallbackApplied: true, fallbackReason: 'DIGITAL_HUMAN_NOT_READY', selectedAt: Date.now() };
      if (settings.fallbackPolicy === 'AUDIO_ONLY') return { mode: 'AUDIO_ONLY', fallbackApplied: true, fallbackReason: 'DIGITAL_HUMAN_NOT_READY', selectedAt: Date.now() };
      return { mode: 'DIGITAL_HUMAN', avatarProfileId: this.settings.providers.avatar.activeProfileId, fallbackApplied: false, fallbackReason: 'DIGITAL_HUMAN_NOT_READY', selectedAt: Date.now() };
    }
    if (this.isReadyPresentationVideo(active)) {
      return { mode: settings.mode, videoProfileId: active!.id, fallbackApplied: false, selectedAt: Date.now() };
    }
    if (this.isReadyPresentationVideo(fallback)) {
      return { mode: this.presentationModeForVideo(fallback!), videoProfileId: fallback!.id, fallbackApplied: true, fallbackReason: 'ACTIVE_PRESENTATION_VIDEO_NOT_READY', selectedAt: Date.now() };
    }
    // Offline/rehearsal runs remain useful on a fresh install before the
    // operator uploads the default video. Formal LIVE preflight still blocks
    // this configuration; rehearsal deliberately keeps the audio pipeline
    // testable and records the visual fallback in the immutable snapshot.
    if (this.currentSession?.mode !== 'LIVE') return { mode: 'AUDIO_ONLY', fallbackApplied: true, fallbackReason: 'PRESENTATION_VIDEO_NOT_READY', selectedAt: Date.now() };
    return { mode: settings.mode, videoProfileId: active?.id, fallbackApplied: false, fallbackReason: 'PRESENTATION_VIDEO_NOT_READY', selectedAt: Date.now() };
  }

  private getPresentationMedia(reading?: Reading): AvatarStageMedia | undefined {
    const selection = reading?.presentationSnapshot;
    const mode = selection?.mode ?? this.settings.presentation.mode;
    if (mode !== 'VIDEO_LOOP' && mode !== 'VIDEO_ONCE') return undefined;
    const profile = this.getPresentationProfile(selection?.videoProfileId ?? this.settings.presentation.activeVideoProfileId);
    if (!this.isReadyPresentationVideo(profile)) return undefined;
    const asset = this.persistence.getMediaAsset(profile!.assetId);
    if (!asset) return undefined;
    return {
      kind: 'VIDEO_URL',
      url: `/api/media-assets/${encodeURIComponent(asset.id)}/content`,
      label: profile!.name,
      muted: true,
      outputAssetId: asset.id,
      playback: mode === 'VIDEO_ONCE' ? 'ONCE' : 'LOOP',
      fit: profile!.fit,
    };
  }

  /** Refresh managed local dependencies before health display or a LIVE start. */
  async refreshProviderReadiness(force = false): Promise<void> {
    if (this.settings.providers.tts.adapter !== 'kokoro') return;
    const now = Date.now();
    if (!force && now - this.kokoroServiceHealth.checkedAt < 15_000) return;
    if (this.providerReadinessProbe) return this.providerReadinessProbe;
    this.providerReadinessProbe = (async () => {
      const baseUrl = this.settings.providers.tts.kokoro.baseUrl.trim().replace(/\/+$/, '');
      if (!baseUrl) {
        this.kokoroServiceHealth = { ready: false, checkedAt: Date.now(), detail: '需要 Kokoro 本地服务地址' };
        return;
      }
      try {
        const response = await this.serviceFetcher(`${baseUrl}/health`, { signal: AbortSignal.timeout(4_000) });
        const body = (await response.json().catch(() => ({}))) as { ready?: boolean; model_ready?: boolean; engine_loaded?: boolean; engine_error?: string };
        const ready = response.ok && body.ready === true && body.model_ready !== false && body.engine_loaded !== false;
        this.kokoroServiceHealth = {
          ready,
          checkedAt: Date.now(),
          detail: ready ? '本地 Kokoro 模型与音色服务已就绪' : body.engine_error || `Kokoro 服务未就绪（HTTP ${response.status}）`,
        };
      } catch (error) {
        this.kokoroServiceHealth = { ready: false, checkedAt: Date.now(), detail: error instanceof Error ? `Kokoro 服务不可用：${error.message}` : 'Kokoro 服务不可用' };
      }
    })();
    try { await this.providerReadinessProbe; }
    finally { this.providerReadinessProbe = undefined; }
  }

  private seedDefaultPresentationProfile(): void {
    if (this.settings.presentation.profiles.length) return;
    const source = this.persistence.listMediaAssets().find((asset) => asset.mimeType.startsWith('video/') && asset.fileName === 'meihua-background-h264.mp4');
    if (!source) {
      this.persistence.setSetting('settings', this.settings);
      return;
    }
    try {
      const validated = this.validatePresentationVideoAsset(source.id);
      const now = Date.now();
      const profile: VideoPresentationProfile = { id: randomUUID(), name: '默认预录人物视频', assetId: source.id, status: 'READY', playback: 'ONCE', fit: 'COVER', durationMs: validated.durationMs, createdAt: now, updatedAt: now };
      this.settings = normalizeSettings({ ...this.settings, presentation: { ...this.settings.presentation, profiles: [profile], activeVideoProfileId: profile.id, fallbackVideoProfileId: profile.id } });
      this.persistence.recordEvent('DEFAULT_PRESENTATION_VIDEO_SEEDED', { profileId: profile.id, assetId: source.id });
    } catch (error) {
      this.persistence.recordEvent('DEFAULT_PRESENTATION_VIDEO_SEED_FAILED', { assetId: source.id, message: error instanceof Error ? error.message : 'PRESENTATION_VIDEO_INVALID' });
    }
    this.persistence.setSetting('settings', this.settings);
  }

  private toPublicMediaAsset(asset: MediaAsset): MediaAsset {
    const { storagePath: _storagePath, storageKey: _storageKey, ...publicAsset } = asset;
    return publicAsset;
  }

  private getActiveVoiceProfile() {
    const { activeVoiceProfileId, voiceProfiles = [] } = this.settings.providers.tts;
    if (!activeVoiceProfileId) return undefined;
    const profile = voiceProfiles.find((item) => (item.id ?? item.voiceId) === activeVoiceProfileId);
    return profile?.status === 'READY' ? profile : undefined;
  }

  private resolveVoiceSelectionSnapshot(): VoiceSelectionSnapshot {
    const settings = this.settings.providers.tts;
    const active = this.getActiveVoiceProfile();
    // Reference/sample language is never the broadcast language.  The
    // operator's target language is authoritative for both preview and live.
    const language = this.settings.overlay.contentLanguage;
    const targetLocale = contentLanguageToVoiceLocale(language);
    const profileMatchesTarget = !active?.targetLocale || localeToContentLanguage(active.targetLocale) === language;
    return {
      voiceProfileId: active?.id ?? settings.activeVoiceProfileId ?? settings.voiceId,
      voiceId: active?.voiceId ?? settings.voiceId,
      contentLanguage: language,
      targetLocale,
      targetCountry: profileMatchesTarget ? active?.targetCountry : undefined,
      accentProfileId: profileMatchesTarget ? active?.accentProfileId : undefined,
      sourceLanguage: active?.sourceLanguage,
      speed: active?.speed ?? settings.speed,
    };
  }

  private getContentLanguage() {
    return this.settings.overlay.contentLanguage;
  }

  private getVoiceLanguage() {
    return this.settings.overlay.contentLanguage;
  }

  private getVoiceTargetLocale(): VoiceTargetLocale {
    return contentLanguageToVoiceLocale(this.settings.overlay.contentLanguage);
  }

  private getAccentSettings(): NonNullable<AppSettings['providers']['tts']['accent']> {
    return this.settings.providers.tts.accent ?? defaultSettings.providers.tts.accent!;
  }

  /** Capture one immutable pairing for the exact audio/video output of a reading. */
  private createDigitalHumanOutputSnapshot(input: {
    readingId: string;
    preset: DigitalHumanPreset;
    audioAssetId: string;
    audioDurationMs: number;
    avatarProfileId?: string;
    videoAssetId?: string;
    videoDurationMs?: number;
    presentationMode?: PresentationMode;
    videoProfileId?: string;
    fallbackApplied?: boolean;
  }): DigitalHumanOutputSnapshot {
    const voice = (this.settings.providers.tts.voiceProfiles ?? []).find((profile) => (profile.id ?? profile.voiceId) === input.preset.voiceProfileId);
    return {
      readingId: input.readingId,
      voiceProfileId: input.preset.voiceProfileId,
      avatarProfileId: input.avatarProfileId ?? input.preset.avatarProfileId,
      targetLocale: input.preset.speechLocale ?? voice?.targetLocale ?? this.getVoiceTargetLocale(),
      targetCountry: input.preset.targetCountry ?? voice?.targetCountry,
      accentProfileId: input.preset.accentProfileId ?? voice?.accentProfileId,
      audioAssetId: input.audioAssetId,
      videoAssetId: input.videoAssetId,
      audioDurationMs: input.audioDurationMs,
      videoDurationMs: input.videoDurationMs,
      audioVideoOffsetMs: input.preset.audioVideoOffsetMs,
      presentationMode: input.presentationMode,
      videoProfileId: input.videoProfileId,
      fallbackApplied: input.fallbackApplied,
      createdAt: Date.now(),
    };
  }

  private resolveAssetPath(asset: MediaAsset): string | undefined {
    const key = asset.storageKey ? basename(asset.storageKey) : asset.storagePath ? basename(asset.storagePath) : undefined;
    if (key) return join(this.mediaDirectory, key);
    return asset.storagePath;
  }

  private reconcileMediaAssets(): void {
    for (const asset of this.persistence.listMediaAssets()) {
      const fallbackExtension = extname(asset.fileName).toLocaleLowerCase();
      const storageKey = basename(asset.storageKey || asset.storagePath || `${asset.contentHash}${fallbackExtension}`);
      const target = join(this.mediaDirectory, storageKey);
      const legacy = asset.storagePath;
      if (!existsSync(target) && legacy && existsSync(legacy)) copyFileSync(legacy, target);
      if (!existsSync(target)) {
        this.persistence.deleteMediaAsset(asset.id);
        this.persistence.recordEvent('MEDIA_ASSET_MISSING_REMOVED', { id: asset.id, fileName: asset.fileName });
        continue;
      }
      this.persistence.saveMediaAsset({ ...asset, storageKey, storagePath: target });
    }
  }

  private removeMissingAssetReferences(profile: SceneProfile): SceneProfile {
    const next = structuredClone(profile);
    const exists = (id?: string) => !id || Boolean(this.persistence.getMediaAsset(id));
    for (const source of Object.values(next.sources)) {
      if (!exists(source.backgroundAssetId)) source.backgroundAssetId = undefined;
      if (!exists(source.decorationAssetId)) source.decorationAssetId = undefined;
    }
    for (const slot of Object.values(next.avatar.slots)) if (!exists(slot.assetId)) slot.assetId = undefined;
    if (!exists(next.visualAssets?.lux3dCoreAssetId) && next.visualAssets) next.visualAssets.lux3dCoreAssetId = undefined;
    for (const layer of next.composition?.layers ?? []) {
      if (layer.kind === 'ASSET' && !exists(layer.assetId)) {
        layer.assetId = undefined;
        layer.visible = false;
      }
    }
    return next;
  }

  private validateComposition(profile: SceneProfile): void {
    const composition = profile.composition;
    if (!composition || composition.width !== 1080 || composition.height !== 1920 || !Array.isArray(composition.layers)) throw new Error('SCENE_COMPOSITION_INVALID');
    if (composition.layers.length > 80) throw new Error('SCENE_LAYERS_TOO_MANY');
    const ids = new Set<string>();
    const zIndexes = new Set<number>();
    const modules = new Set<SceneModuleId>();
    const finite = (...values: number[]) => values.every(Number.isFinite);
    for (const layer of composition.layers) {
      if (!layer.id?.trim() || ids.has(layer.id)) throw new Error('SCENE_LAYER_ID_INVALID');
      ids.add(layer.id);
      const { x, y, width, height, rotation } = layer.transform ?? {};
      if (!finite(x, y, width, height, rotation, layer.opacity, layer.zIndex)) throw new Error(`SCENE_LAYER_NUMBER_INVALID:${layer.id}`);
      if (zIndexes.has(layer.zIndex)) throw new Error(`SCENE_LAYER_ZINDEX_DUPLICATE:${layer.id}`);
      zIndexes.add(layer.zIndex);
      if (width < 1 || height < 1 || width > 4320 || height > 7680) throw new Error(`SCENE_LAYER_SIZE_INVALID:${layer.id}`);
      if (x < -2160 || x > 2160 || y < -3840 || y > 3840 || rotation < -360 || rotation > 360 || layer.opacity < 0 || layer.opacity > 1) throw new Error(`SCENE_LAYER_TRANSFORM_INVALID:${layer.id}`);
      if (layer.kind === 'MODULE') {
        if (!sceneModuleIds.includes(layer.moduleId) || modules.has(layer.moduleId)) throw new Error(`SCENE_MODULE_DUPLICATE_OR_INVALID:${layer.moduleId}`);
        modules.add(layer.moduleId);
      } else if (layer.kind === 'ASSET') {
        if (layer.assetId) {
          const asset = this.persistence.getMediaAsset(layer.assetId);
          if (!asset || asset.kind === 'LUX3D_MODEL') throw new Error(`SCENE_ASSET_INVALID:${layer.id}`);
        }
      } else if (layer.kind === 'TEXT') {
        if (typeof layer.text !== 'string' || !finite(layer.fontSize) || layer.fontSize < 8 || layer.fontSize > 300) throw new Error(`SCENE_TEXT_INVALID:${layer.id}`);
      } else throw new Error('SCENE_LAYER_KIND_INVALID');
    }
    for (const [sourceId, source] of Object.entries(profile.sources)) {
      if (source.decorationAssetId) {
        const asset = this.persistence.getMediaAsset(source.decorationAssetId);
        if (!asset || !asset.mimeType.startsWith('image/')) throw new Error(`SOURCE_DECORATION_INVALID:${sourceId}`);
      }
    }
    if (profile.visualAssets?.lux3dCoreAssetId) {
      const asset = this.persistence.getMediaAsset(profile.visualAssets.lux3dCoreAssetId);
      if (!asset || !['LUX3D_MODEL', 'OVERLAY_IMAGE'].includes(asset.kind)) throw new Error('LUX3D_ASSET_INVALID');
    }
  }

  private findAssetUsages(id: string): string[] {
    const usages = new Set<string>();
    for (const profile of this.settings.providers.avatar.profiles ?? []) {
      if (profile.modelAssetId === id) usages.add(`数字人档案 · ${profile.name}`);
      if (profile.previewAssetId === id) usages.add(`数字人预览 · ${profile.name}`);
    }
    for (const version of this.persistence.listSceneProfileVersions('main', 500)) {
      const prefix = `${version.status.toLocaleLowerCase()} v${version.version}`;
      for (const [sourceId, source] of Object.entries(version.profile.sources)) {
        if (source.backgroundAssetId === id) usages.add(`${prefix} · ${sourceId} 背景`);
        if (source.decorationAssetId === id) usages.add(`${prefix} · ${sourceId} 装饰`);
      }
      for (const [action, slot] of Object.entries(version.profile.avatar.slots)) if (slot.assetId === id) usages.add(`${prefix} · 数字人 ${action}`);
      if (version.profile.visualAssets?.lux3dCoreAssetId === id) usages.add(`${prefix} · 玄金罗盘`);
      for (const layer of version.profile.composition?.layers ?? []) if (layer.kind === 'ASSET' && layer.assetId === id) usages.add(`${prefix} · 图层 ${layer.name}`);
      for (const element of version.profile.elements ?? []) if (element.assetId === id) usages.add(`${prefix} · 旧元素 ${element.id}`);
    }
    return [...usages];
  }

  getVTubeStatus(): VTubeStudioConnectionState { return this.vtube.getState(); }

  private async probeService(url: string, path: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch(`${url.replace(/\/+$/, '')}${path}`, { signal: AbortSignal.timeout(2_500) });
      return { ok: response.ok, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  /** One-shot health probe for both digital-human services (admin status card). */
  async probeDigitalHumanServices(): Promise<{ gptsovits: { baseUrl: string; ok: boolean; detail: string; voices: number }; accent: { baseUrl: string; ok: boolean; detail: string; profiles: VoiceAccentProfile[] }; musetalk: { baseUrl: string; ok: boolean; detail: string; avatars: string[] } }> {
    const gptsovitsBase = this.settings.providers.tts.gptsovits.baseUrl;
    const accentBase = this.getAccentSettings().baseUrl;
    const musetalkBase = this.settings.providers.avatar.url;
    const [gptsovits, accent, musetalk] = await Promise.all([
      // V3 now provides a lightweight real health endpoint.  /docs merely
      // proves FastAPI opened a page; it cannot prove the managed GPU runtime
      // can accept synthesis/release requests.
      this.probeService(gptsovitsBase, '/health'),
      this.probeService(accentBase, '/health'),
      this.probeService(musetalkBase, '/health'),
    ]);
    let avatars: string[] = [];
    let museTalkReady = false;
    let museTalkDetail = musetalk.detail;
    let accentReady = false;
    let accentDetail = accent.ok ? accent.detail : '本地目标口音服务未启动，请确认 CUDA 与 OpenVoice 模型已安装';
    if (accent.ok) {
      try {
        const response = await fetch(`${accentBase.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(2_500) });
        const body = (await response.json().catch(() => ({}))) as { ready?: boolean; runtime_mode?: string; missing?: string[]; model_ready?: boolean };
        accentReady = response.ok && body.ready === true;
        accentDetail = accentReady
          ? `目标口音服务已就绪 · ${body.runtime_mode === 'cuda' ? 'CUDA 加速' : 'CPU 运行'}`
          : `目标口音底座未就绪${body.missing?.length ? `；缺少 ${body.missing.join(', ')}` : ''}`;
      } catch (error) {
        accentReady = false;
        accentDetail = error instanceof Error ? error.message : '目标口音健康检查失败';
      }
    }
    if (musetalk.ok) {
      try {
        const response = await fetch(`${musetalkBase.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(2_500) });
        const body = (await response.json()) as { avatars?: string[]; ready?: boolean; missing?: string[]; missing_dependencies?: string[]; cuda_ready?: boolean; runtime_mode?: string };
        avatars = Array.isArray(body.avatars) ? body.avatars : [];
        museTalkReady = body.ready === true;
        museTalkDetail = museTalkReady
          ? `模型与渲染服务已就绪 · ${body.runtime_mode === 'cuda' ? 'CUDA 加速' : 'CPU 运行'}`
          : `底座未就绪${body.missing?.length ? `；缺少模型 ${body.missing.join(', ')}` : ''}${body.missing_dependencies?.length ? `；缺少依赖 ${body.missing_dependencies.join(', ')}` : ''}`;
      } catch { /* status already reports the failure */ }
    }
    this.digitalHumanServiceHealth = { accent: accentReady, musetalk: musetalk.ok && museTalkReady };
    const gptDetail = gptsovits.ok
      ? gptsovits.detail
      : '本地 V3 服务未启动，请运行统一启动入口';
    return {
      gptsovits: { baseUrl: gptsovitsBase, ok: gptsovits.ok, detail: gptDetail, voices: (this.settings.providers.tts.voiceProfiles ?? []).filter((profile) => profile.provider === 'gptsovits-v3' && profile.status === 'READY' && profile.previewUrl).length },
      accent: { baseUrl: accentBase, ok: accentReady, detail: accentDetail, profiles: this.getAccentSettings().profiles },
      musetalk: { baseUrl: musetalkBase, ok: musetalk.ok && museTalkReady, detail: museTalkDetail, avatars },
    };
  }

  /** Proxy avatar preparation to the MuseTalk rendering service. */
  async prepMuseTalkAvatar(avatarId: string, videoPath: string): Promise<{ ok: boolean; detail: string }> {
    const base = this.settings.providers.avatar.url.replace(/\/+$/, '');
    try {
      const response = await fetch(`${base}/avatars/prep`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ avatar_id: avatarId, video_path: videoPath }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}` };
      if (body.prepared === true || body.status === 'READY') return { ok: true, detail: `prepared:${body.avatar_id ?? avatarId}` };
      const jobId = typeof body.job_id === 'string' ? body.job_id : '';
      if (!jobId) return { ok: false, detail: 'MUSETALK_AVATAR_PREP_NO_JOB' };
      const deadline = Date.now() + 2 * 60 * 60_000;
      let job = body;
      while (!['READY', 'FAILED', 'CANCELED'].includes(String(job.status))) {
        if (Date.now() >= deadline) return { ok: false, detail: 'MUSETALK_AVATAR_PREP_TIMEOUT' };
        await delay(750);
        const poll = await fetch(`${base}/avatars/prep/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(10_000) });
        job = await poll.json().catch(() => ({})) as Record<string, unknown>;
      }
      return job.status === 'READY' && job.prepared === true
        ? { ok: true, detail: `prepared:${avatarId}` }
        : { ok: false, detail: String(job.failure_reason ?? `MUSETALK_AVATAR_PREP_${job.status}`) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  /** Render + play a short audition clip for one prepared avatar. */
  async testMuseTalkAvatar(avatarId: string): Promise<{ ok: boolean; detail: string; previewAssetId?: string }> {
    const verifiedVoice = (this.settings.providers.tts.voiceProfiles ?? []).find((profile) => profile.status === 'READY' && profile.previewUrl?.startsWith('/api/audio/'));
    const latestAudio = verifiedVoice?.previewUrl
      ?? this.persistence.listReadings({ limit: 20 }).find((reading) => reading.tts?.audioPath)?.tts?.audioPath;
    const audioPath = latestAudio ? join(this.audioDirectory, basename(latestAudio)) : '';
    if (!audioPath || !existsSync(audioPath)) return { ok: false, detail: '没有可用的历史语音 WAV；先完成一次测算或试音' };
    try {
      const adapter = this.getMuseTalkAvatarProvider();
      const rendered = await this.runGpuTask('AVATAR_RENDER', () => adapter.render(audioPath, `test-${Date.now()}`, avatarId));
      const asset = this.importGeneratedAvatarVideo(rendered.videoPath, `avatar-test-${avatarId}`);
      this.activeAvatarMedia = { kind: 'VIDEO_URL', url: `/api/media-assets/${encodeURIComponent(asset.id)}/content`, label: 'MuseTalk 试画面', muted: true, profileId: avatarId };
      this.publishSnapshot('STATE_CHANGED');
      return { ok: true, detail: '试画面已进入统一舞台预览', previewAssetId: asset.id };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  listGptSoVitsVoices(): { baseUrl: string; voices: GptSoVitsVoice[] } {
    return { baseUrl: this.settings.providers.tts.gptsovits.baseUrl, voices: this.settings.providers.tts.gptsovits.voices.map((voice) => ({ ...voice, refAudioPath: '' })) };
  }

  queueVoiceClone(input: { id?: string; name: string; fileName: string; mimeType: string; base64: string; refText?: string; refLanguage: GptSoVitsVoice['refLanguage'] | 'auto'; targetLocale?: VoiceTargetLocale; targetCountry?: string; accentProfileId?: string; cloneMode?: VoiceCloneMode }): { profile: VoiceProfile; job: DigitalHumanJob } {
    const name = input.name.trim();
    if (!name) throw new Error('VOICE_NAME_REQUIRED');
    if (!input.base64) throw new Error('VOICE_AUDIO_REQUIRED');
    const audio = Buffer.from(input.base64, 'base64');
    if (audio.length > 30 * 1024 * 1024) throw new Error('VOICE_SAMPLE_TOO_LARGE');
    if (!isSupportedVoiceSample(audio, input.mimeType, input.fileName)) throw new Error('VOICE_SAMPLE_FORMAT_INVALID');
    if (audio.length < 12_000) throw new Error('VOICE_SAMPLE_TOO_SHORT');
    const targetLocale = input.targetLocale ?? (input.refLanguage === 'en' ? 'en-US' : input.refLanguage === 'ja' ? 'ja-JP' : input.refLanguage === 'ko' ? 'ko-KR' : input.refLanguage === 'yue' ? 'yue-HK' : 'zh-CN');
    const cloneMode = input.cloneMode ?? 'COUNTRY_ACCENT';
    const configuredVoiceProvider = this.settings.providers.tts.voiceCloneApi?.provider ?? 'aliyun';
    const profileProvider: VoiceProfile['provider'] = configuredVoiceProvider === 'baidu' ? 'baidu-xiling' : configuredVoiceProvider === 'local-openvoice' ? 'gptsovits-v3' : 'aliyun-cosyvoice';
    if (configuredVoiceProvider === 'baidu' && targetLocale !== 'zh-CN') throw new Error(`VOICE_TARGET_UNSUPPORTED:baidu-xiling:${targetLocale}`);
    const accent = this.getAccentSettings().profiles.find((profile) => profile.id === input.accentProfileId)
      ?? this.getAccentSettings().profiles.find((profile) => profile.locale === targetLocale && profile.enabled);
    if (cloneMode === 'COUNTRY_ACCENT' && !accent) throw new Error(`VOICE_TARGET_UNSUPPORTED:${targetLocale}`);
    const providerConfig = configuredVoiceProvider === 'baidu'
      ? this.settings.providers.tts.voiceCloneApi?.baidu ?? defaultSettings.providers.tts.voiceCloneApi!.baidu!
      : this.settings.providers.tts.voiceCloneApi?.aliyun ?? defaultSettings.providers.tts.voiceCloneApi!.aliyun!;
    const dedupeKey = createHash('sha256').update(audio).update('\0').update(JSON.stringify({ provider: configuredVoiceProvider, model: providerConfig.model, targetModel: providerConfig.targetModel, targetLocale, targetCountry: input.targetCountry ?? accent?.country, accentProfileId: input.accentProfileId ?? accent?.id, cloneMode })).digest('hex');
    const existing = this.persistence.findActiveDigitalHumanJob(`VOICE_CLONE:${dedupeKey}`);
    if (existing) {
      const existingProfile = (this.settings.providers.tts.voiceProfiles ?? []).find((profile) => (profile.id ?? profile.voiceId) === existing.profileId);
      if (existingProfile) return { profile: existingProfile, job: existing };
    }
    const id = input.id ?? randomUUID();
    const jobsDirectory = join(this.voicesDirectory, 'jobs');
    mkdirSync(jobsDirectory, { recursive: true });
    const stagedAudioPath = join(jobsDirectory, `${id}.source`);
    const manifestPath = join(jobsDirectory, `${id}.json`);
    // A failed run may leave its staging files behind.  Re-cloning the same
    // profile is an explicit retry, so replace only those two exact files.
    try { unlinkSync(stagedAudioPath); } catch { /* no stale source */ }
    try { unlinkSync(manifestPath); } catch { /* no stale manifest */ }
    writeFileSync(stagedAudioPath, audio, { flag: 'wx' });
    writeFileSync(manifestPath, JSON.stringify({ id, name, fileName: input.fileName, mimeType: input.mimeType, refText: input.refText, refLanguage: input.refLanguage, targetLocale, targetCountry: input.targetCountry ?? accent?.country, accentProfileId: input.accentProfileId ?? accent?.id, cloneMode, cloneProvider: configuredVoiceProvider, stagedAudioPath }, null, 2), { flag: 'wx' });
    const now = Date.now();
    const profile: VoiceProfile = {
      id, voiceId: id, provider: profileProvider, name, language: localeToContentLanguage(targetLocale),
      sourceLanguage: input.refLanguage === 'auto' ? undefined : input.refLanguage, targetLocale,
      targetCountry: input.targetCountry ?? accent?.country, accentProfileId: input.accentProfileId ?? accent?.id,
      cloneMode, status: 'PROCESSING', speed: 1, createdAt: now, updatedAt: now, lastError: 'VOICE_CLONE_QUEUED',
    };
    const profiles = (this.settings.providers.tts.voiceProfiles ?? []).filter((candidate) => (candidate.id ?? candidate.voiceId) !== id);
    this.updateSettings({ providers: { tts: { voiceProfiles: [...profiles, profile] } } });
    const job: DigitalHumanJob = { id: randomUUID(), kind: 'VOICE_CLONE', profileId: id, status: 'QUEUED', stage: 'QUEUED', progress: 0, dedupeKey: `VOICE_CLONE:${dedupeKey}`, createdAt: now, updatedAt: now };
    this.saveDigitalHumanJob(job);
    this.persistence.recordEvent('VOICE_CLONE_JOB_CREATED', { id, jobId: job.id, targetLocale, targetCountry: profile.targetCountry, accentProfileId: profile.accentProfileId });
    this.launchVoiceClone(job);
    return { profile, job };
  }

  private getCloudVoiceAdapter(provider: 'aliyun' | 'baidu'): CloudVoiceCloneAdapter {
    const api = this.settings.providers.tts.voiceCloneApi ?? defaultSettings.providers.tts.voiceCloneApi!;
    const config = provider === 'aliyun'
      ? api.aliyun ?? defaultSettings.providers.tts.voiceCloneApi!.aliyun!
      : api.baidu ?? defaultSettings.providers.tts.voiceCloneApi!.baidu!;
    return new CloudVoiceCloneAdapter({ id: `${provider}-voice-clone`, label: provider === 'aliyun' ? '阿里云 CosyVoice' : '百度曦灵', config, apiKey: this.resolveSecret(provider === 'aliyun' ? 'voiceCloneAliyun' : 'voiceCloneBaidu').value ?? '', outputDirectory: this.audioDirectory });
  }

  private async cloneCloudVoice(input: { id: string; name: string; fileName: string; audio: Buffer; referenceText?: string; sourceLanguage?: string; targetLocale?: VoiceTargetLocale; targetCountry?: string; provider: 'aliyun' | 'baidu' }): Promise<{ providerCloneId: string }> {
    const result = await this.getCloudVoiceAdapter(input.provider).clone(input);
    this.persistence.recordEvent('CLOUD_VOICE_CLONE_CREATED', { provider: input.provider, profileId: input.id, providerCloneId: result.providerCloneId, engineVersion: result.engineVersion });
    return result;
  }

  private async testCloudVoiceProfile(id: string): Promise<{ ok: true; durationMs: number; audioUrl: string; verifiedAt: number }> {
    const profile = (this.settings.providers.tts.voiceProfiles ?? []).find((item) => (item.id ?? item.voiceId) === id);
    if (!profile || !profile.voiceId) throw new Error('VOICE_PROFILE_NOT_FOUND');
    const provider = profile.provider === 'baidu-xiling' ? 'baidu' : profile.provider === 'aliyun-cosyvoice' ? 'aliyun' : undefined;
    if (!provider) throw new Error('CLOUD_VOICE_PROFILE_REQUIRED');
    const targetLocale = profile.targetLocale ?? 'zh-CN';
    const sample: Record<VoiceTargetLocale, string> = {
      'zh-CN': '这是一次云端声音克隆试听。', 'yue-HK': '呢次係一次雲端聲音克隆試聽。',
      'en-US': 'This is a cloud voice clone audition for the live reading.', 'en-GB': 'This is a cloud voice clone audition for the live reading.',
      'ja-JP': 'これはライブ配信用のクラウド音声テストです。', 'ko-KR': '라이브 방송을 위한 클라우드 음성 테스트입니다.',
      'es-ES': 'Esta es una prueba de voz en la nube.', 'fr-FR': 'Ceci est un test de voix cloud.',
    };
    try {
      const audio = await this.runGpuTask('VOICE_TEST', () => this.getCloudVoiceAdapter(provider).synthesize({ readingId: `cloud-voice-test-${Date.now()}`, text: sample[targetLocale], voiceId: profile.voiceId, speed: profile.speed ?? 1, locale: targetLocale, targetLocale }));
      if (!audio.audioPath) throw new Error('VOICE_TEST_AUDIO_MISSING');
      const fileName = basename(audio.audioPath);
      const filePath = join(this.audioDirectory, fileName);
      if (!existsSync(filePath) || statSync(filePath).size < 1_000 || audio.durationMs < 500) throw new Error('VOICE_TEST_AUDIO_INVALID');
      const audioUrl = `/api/audio/${encodeURIComponent(fileName)}`;
      const now = Date.now();
      this.providerVerification.set('tts', { fingerprint: this.providerFingerprint('tts'), verifiedAt: now });
      this.updateSettings({ providers: { tts: { voiceProfiles: (this.settings.providers.tts.voiceProfiles ?? []).map((candidate) => (candidate.id ?? candidate.voiceId) === id ? { ...candidate, status: 'READY', approvedAt: now, previewUrl: audioUrl, testText: sample[targetLocale], updatedAt: now, lastError: undefined } : candidate) } } });
      this.persistence.recordEvent('CLOUD_VOICE_REAL_TEST_PASSED', { id, provider, durationMs: audio.durationMs, audioUrl });
      return { ok: true, durationMs: audio.durationMs, audioUrl, verifiedAt: now };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CLOUD_VOICE_TEST_FAILED';
      this.updateSettings({ providers: { tts: { voiceProfiles: (this.settings.providers.tts.voiceProfiles ?? []).map((candidate) => (candidate.id ?? candidate.voiceId) === id ? { ...candidate, status: 'FAILED', previewUrl: undefined, updatedAt: Date.now(), lastError: message } : candidate) } } });
      this.persistence.recordEvent('CLOUD_VOICE_REAL_TEST_FAILED', { id, provider, error: message });
      throw error;
    }
  }

  private launchVoiceClone(job: DigitalHumanJob): void {
    if (this.digitalHumanJobRunners.has(job.id)) return;
    const runner = (async () => {
      const manifestPath = join(this.voicesDirectory, 'jobs', `${job.profileId}.json`);
      try {
        this.patchDigitalHumanJob(job.id, { status: 'PROCESSING', stage: 'NORMALIZING_AUDIO', progress: 10, startedAt: Date.now() });
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id: string; name: string; fileName: string; mimeType: string; refText?: string; refLanguage: GptSoVitsVoice['refLanguage'] | 'auto'; targetLocale?: VoiceTargetLocale; targetCountry?: string; accentProfileId?: string; cloneMode?: VoiceCloneMode; cloneProvider?: 'aliyun' | 'baidu' | 'local-openvoice'; stagedAudioPath: string };
        const bytes = readFileSync(manifest.stagedAudioPath);
        if (manifest.cloneProvider === 'aliyun' || manifest.cloneProvider === 'baidu') {
          this.patchDigitalHumanJob(job.id, { stage: 'CLOUD_CLONING', progress: 35 });
          let referenceText = manifest.refText?.trim();
          let sourceLanguage = manifest.refLanguage === 'auto' ? undefined : manifest.refLanguage;
          // Xiling requires the exact transcript of the uploaded sample. If the
          // operator did not provide it, derive it before submitting the cloud job.
          if (manifest.cloneProvider === 'baidu' && !referenceText) {
            const transcription = transcribeVoiceReference(manifest.stagedAudioPath, 'auto');
            referenceText = transcription.text;
            sourceLanguage = transcription.language;
          }
          const cloned = await this.cloneCloudVoice({
            id: job.profileId, name: manifest.name, fileName: manifest.fileName, audio: bytes,
            referenceText, sourceLanguage,
            targetLocale: manifest.targetLocale, targetCountry: manifest.targetCountry, provider: manifest.cloneProvider,
          });
          this.updateSettings({ providers: { tts: { voiceProfiles: (this.settings.providers.tts.voiceProfiles ?? []).map((profile) => (profile.id ?? profile.voiceId) === job.profileId ? { ...profile, voiceId: cloned.providerCloneId, cloneId: cloned.providerCloneId, status: 'PROCESSING', lastError: undefined, updatedAt: Date.now() } : profile) } } });
          this.patchDigitalHumanJob(job.id, { stage: 'VERIFYING_PREVIEW', progress: 70 });
          await this.testCloudVoiceProfile(job.profileId);
        } else {
          const pack = await this.addGptSoVitsVoice({ ...manifest, base64: bytes.toString('base64') });
          this.patchDigitalHumanJob(job.id, { stage: 'VERIFYING_PREVIEW', progress: 70 });
          await this.testGptSoVitsVoice(pack.id);
        }
        this.patchDigitalHumanJob(job.id, { status: 'READY', stage: 'COMPLETE', progress: 100, finishedAt: Date.now() });
        try { unlinkSync(manifest.stagedAudioPath); unlinkSync(manifestPath); } catch { /* cleanup is best effort */ }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'VOICE_CLONE_FAILED';
        const profiles = this.settings.providers.tts.voiceProfiles ?? [];
        const canceled = this.persistence.getDigitalHumanJob(job.id)?.status === 'CANCELED';
        this.updateSettings({ providers: { tts: { voiceProfiles: profiles.map((profile) => (profile.id ?? profile.voiceId) === job.profileId ? { ...profile, status: canceled ? 'NEEDS_REVIEW' : 'FAILED', lastError: canceled ? 'VOICE_CLONE_CANCELED' : message, updatedAt: Date.now(), previewUrl: undefined } : profile) } } });
        if (!canceled) this.patchDigitalHumanJob(job.id, { status: 'FAILED', stage: 'FAILED', progress: 100, errorCode: message.split(':', 1)[0], errorMessage: message, finishedAt: Date.now() });
      } finally {
        this.digitalHumanJobRunners.delete(job.id);
      }
    })();
    this.digitalHumanJobRunners.set(job.id, runner);
  }

  async addGptSoVitsVoice(input: { id?: string; name: string; fileName: string; mimeType: string; base64: string; refText?: string; refLanguage: GptSoVitsVoice['refLanguage'] | 'auto'; targetLocale?: VoiceTargetLocale; targetCountry?: string; accentProfileId?: string; cloneMode?: VoiceCloneMode }): Promise<GptSoVitsVoice> {
    const name = input.name.trim();
    if (!name) throw new Error('VOICE_NAME_REQUIRED');
    if (!input.base64) throw new Error('VOICE_AUDIO_REQUIRED');
    if (input.base64.length > 30 * 1024 * 1024) throw new Error('VOICE_SAMPLE_TOO_LARGE');
    const audio = Buffer.from(input.base64, 'base64');
    if (!isSupportedVoiceSample(audio, input.mimeType, input.fileName)) throw new Error('VOICE_SAMPLE_FORMAT_INVALID');
    if (audio.length < 12_000) throw new Error('VOICE_SAMPLE_TOO_SHORT');
    mkdirSync(this.voicesDirectory, { recursive: true });
    const id = input.id ?? `${name.replace(/[^a-zA-Z0-9一-鿿_-]/g, '').slice(0, 24) || 'voice'}-${Date.now().toString(36)}`;
    const voiceDirectory = join(this.voicesDirectory, id);
    mkdirSync(voiceDirectory, { recursive: true });
    const ffmpeg = bundledFfmpegPath();
    if (!ffmpeg) throw new Error('FFMPEG_UNAVAILABLE: 音频处理组件未就绪，请重启中控后重试');
    const sourceExtension = extname(input.fileName).toLowerCase() || '.bin';
    const sourcePath = join(voiceDirectory, `source${sourceExtension}`);
    const refAudioPath = join(voiceDirectory, 'reference.wav');
    writeFileSync(sourcePath, audio, { flag: 'wx' });
    try {
      const result = spawnSync(ffmpeg, [
        '-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '32000',
        '-c:a', 'pcm_s16le', refAudioPath,
      ], { encoding: 'utf8', windowsHide: true, timeout: 90_000 });
      if (result.error || result.status !== 0 || !existsSync(refAudioPath)) {
        throw new Error(`VOICE_AUDIO_NORMALIZE_FAILED:${result.error?.message ?? result.stderr?.slice(-240) ?? 'ffmpeg exited unexpectedly'}`);
      }
    } finally {
      try { unlinkSync(sourcePath); } catch { /* temporary input is best effort */ }
    }
    const durationMs = wavDurationMs(readFileSync(refAudioPath));
    if (!durationMs || durationMs < 10_000 || durationMs > 30_000) {
      try { unlinkSync(refAudioPath); } catch { /* failed validation must not leave a profile source */ }
      throw new Error('VOICE_SAMPLE_DURATION_INVALID: 参考音频必须为 10–30 秒');
    }
    let referenceText = input.refText?.trim().slice(0, 400) ?? '';
    let sourceLanguage: GptSoVitsRefLanguage = input.refLanguage === 'auto' ? 'zh' : input.refLanguage;
    // New clone requests always carry a target locale.  For those requests,
    // detect the uploaded sample independently of the operator's selection so
    // a manually supplied transcript/language cannot silently describe a
    // different recording.  The old direct pack helper remains compatible for
    // callers that do not provide target metadata.
    const shouldValidateReferenceLanguage = input.refLanguage === 'auto' || Boolean(input.targetLocale);
    if (shouldValidateReferenceLanguage || !referenceText) {
      try {
        const transcription = transcribeVoiceReference(refAudioPath, shouldValidateReferenceLanguage ? 'auto' : input.refLanguage);
        if (input.refLanguage !== 'auto' && transcription.language !== input.refLanguage) {
          throw new Error(`VOICE_REFERENCE_LANGUAGE_MISMATCH:${input.refLanguage}:${transcription.language}`);
        }
        if (!referenceText) referenceText = transcription.text;
        sourceLanguage = transcription.language;
      } catch (error) {
        try { unlinkSync(refAudioPath); } catch { /* failed clone leaves no unusable voice */ }
        throw error;
      }
    }
    const targetLocale = input.targetLocale ?? (sourceLanguage === 'zh' ? 'zh-CN' : sourceLanguage === 'en' ? 'en-US' : sourceLanguage === 'ja' ? 'ja-JP' : sourceLanguage === 'ko' ? 'ko-KR' : 'yue-HK');
    const accentProfile = this.getAccentSettings().profiles.find((profile) => profile.id === input.accentProfileId)
      ?? this.getAccentSettings().profiles.find((profile) => profile.locale === targetLocale && profile.enabled);
    const cloneMode = input.cloneMode ?? 'COUNTRY_ACCENT';
    if (cloneMode === 'COUNTRY_ACCENT' && !accentProfile) throw new Error(`VOICE_TARGET_UNSUPPORTED:${targetLocale}`);
    const pack: GptSoVitsVoice = {
      id, name, refAudioPath,
      refText: referenceText,
      refLanguage: sourceLanguage,
      sourceLanguage,
      targetLocale,
      targetCountry: input.targetCountry ?? accentProfile?.country,
      accentProfileId: input.accentProfileId ?? accentProfile?.id,
      cloneMode,
      createdAt: Date.now(),
    };
    const profile: VoiceProfile = {
      id, voiceId: id, provider: 'gptsovits-v3', name,
      language: localeToContentLanguage(targetLocale), sourceLanguage, targetLocale,
      targetCountry: pack.targetCountry, accentProfileId: pack.accentProfileId, cloneMode,
      status: 'NEEDS_REVIEW', speed: 1,
      testText: referenceText.slice(0, 300), createdAt: Date.now(), updatedAt: Date.now(),
      lastError: 'VOICE_REAL_TEST_REQUIRED',
    };
    const existingPacks = this.settings.providers.tts.gptsovits.voices.filter((voice) => voice.id !== id);
    const existingProfiles = (this.settings.providers.tts.voiceProfiles ?? []).filter((candidate) => (candidate.id ?? candidate.voiceId) !== id);
    this.updateSettings({ providers: { tts: {
      gptsovits: { ...this.settings.providers.tts.gptsovits, voices: [...existingPacks, pack] },
      voiceProfiles: [...existingProfiles, profile],
    } } });
    this.persistence.recordEvent('GPTSOVITS_VOICE_ADDED', { id, name, refLanguage: pack.refLanguage, automaticApproval: false, folder: id });
    return pack;
  }

  async removeGptSoVitsVoice(id: string): Promise<boolean> {
    const pack = this.settings.providers.tts.gptsovits.voices.find((voice) => voice.id === id);
    if (!pack) return false;
    this.updateSettings({ providers: { tts: {
      activeVoiceProfileId: this.settings.providers.tts.activeVoiceProfileId === id ? undefined : this.settings.providers.tts.activeVoiceProfileId,
      gptsovits: { ...this.settings.providers.tts.gptsovits, voices: this.settings.providers.tts.gptsovits.voices.filter((voice) => voice.id !== id) },
      voiceProfiles: (this.settings.providers.tts.voiceProfiles ?? []).filter((profile) => (profile.id ?? profile.voiceId) !== id),
    } } });
    try { unlinkSync(pack.refAudioPath); } catch { /* already gone is fine */ }
    this.persistence.recordEvent('GPTSOVITS_VOICE_REMOVED', { id });
    return true;
  }

  /** A voice is READY only after GPT-SoVITS produced a playable WAV. */
  async testGptSoVitsVoice(id: string, sampleText?: string): Promise<{ ok: true; durationMs: number; audioUrl: string; verifiedAt: number }> {
    const cloudProfile = (this.settings.providers.tts.voiceProfiles ?? []).find((profile) => (profile.id ?? profile.voiceId) === id);
    if (cloudProfile?.provider === 'aliyun-cosyvoice' || cloudProfile?.provider === 'baidu-xiling') return this.testCloudVoiceProfile(id);
    const pack = this.settings.providers.tts.gptsovits.voices.find((voice) => voice.id === id);
    if (!pack) throw new Error('VOICE_PACK_NOT_FOUND');
    const targetLocale = pack.targetLocale ?? (pack.refLanguage === 'en' ? 'en-US' : pack.refLanguage === 'ja' ? 'ja-JP' : pack.refLanguage === 'ko' ? 'ko-KR' : pack.refLanguage === 'yue' ? 'yue-HK' : 'zh-CN');
    const samples: Record<VoiceTargetLocale, string> = {
      'zh-CN': '这是一次快速的声音试音测试。', 'yue-HK': '呢次係一個快速嘅聲音試音測試。',
      'en-US': 'This is a quick voice test for the live reading.', 'en-GB': 'This is a quick voice test for the live reading.',
      'ja-JP': 'これはライブ配信用の音声テストです。', 'ko-KR': '라이브 방송을 위한 음성 테스트입니다.',
      'es-ES': 'Esta es una prueba rápida de voz.', 'fr-FR': 'Ceci est un test rapide de la voix.',
    };
    const sample = sampleText?.trim().slice(0, 200) || samples[targetLocale];
    const adapter: TtsAdapter = pack.cloneMode === 'COUNTRY_ACCENT'
      ? new VoiceAccentTtsAdapter({ baseUrl: this.getAccentSettings().baseUrl, voices: [pack], outputDirectory: this.audioDirectory })
      : new GptSoVitsTtsAdapter({
        baseUrl: this.settings.providers.tts.gptsovits.baseUrl, voices: [pack], outputDirectory: this.audioDirectory,
        apiVersion: this.settings.providers.tts.gptsovits.apiVersion,
        releaseGpuAfterSynthesis: this.gpuRuntimeProfile.releaseVoiceGpuAfterSynthesis,
        requireGpuRelease: this.gpuRuntimeProfile.id === 'SAFE_8GB',
      });
    try {
      const audio = await this.runGpuTask('VOICE_TEST', () => adapter.synthesize({
        readingId: `voice-test-${Date.now()}`, text: sample,
        voiceId: pack.id, speed: this.settings.providers.tts.speed,
        locale: targetLocale, targetLocale, targetCountry: pack.targetCountry,
        accentProfileId: pack.accentProfileId, sourceLanguage: pack.sourceLanguage ?? pack.refLanguage, targetSeconds: 6,
      }));
      if (!audio.audioPath) throw new Error('VOICE_TEST_AUDIO_MISSING');
      const fileName = basename(audio.audioPath);
      const filePath = join(this.audioDirectory, fileName);
      if (!existsSync(filePath) || statSync(filePath).size < 1_000 || audio.durationMs < 500) throw new Error('VOICE_TEST_AUDIO_INVALID');
      if (pack.cloneMode === 'COUNTRY_ACCENT') {
        const targetLanguage: GptSoVitsRefLanguage | undefined = targetLocale === 'zh-CN' ? 'zh' : targetLocale === 'yue-HK' ? 'yue' : targetLocale === 'en-US' || targetLocale === 'en-GB' ? 'en' : targetLocale === 'ja-JP' ? 'ja' : targetLocale === 'ko-KR' ? 'ko' : undefined;
        if (targetLanguage) {
          const verification = transcribeVoiceReference(filePath, targetLanguage);
          if (verification.language !== targetLanguage) throw new Error(`VOICE_TARGET_LANGUAGE_MISMATCH:${targetLocale}:${verification.language}`);
        }
      }
      const audioUrl = `/api/audio/${encodeURIComponent(fileName)}`;
      const now = Date.now();
      if (pack.cloneMode === 'COUNTRY_ACCENT') this.digitalHumanServiceHealth.accent = true;
      this.providerVerification.set('tts', { fingerprint: this.providerFingerprint('tts'), verifiedAt: now });
      this.updateSettings({ providers: { tts: { voiceProfiles: (this.settings.providers.tts.voiceProfiles ?? []).map((profile) =>
        (profile.id ?? profile.voiceId) === id ? { ...profile, status: 'READY', approvedAt: now, previewUrl: audioUrl, testText: sample, updatedAt: now, lastError: undefined } : profile) } } });
      this.persistence.recordEvent('GPTSOVITS_VOICE_REAL_TEST_PASSED', { id, durationMs: audio.durationMs, audioUrl });
      return { ok: true, durationMs: audio.durationMs, audioUrl, verifiedAt: now };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'VOICE_REAL_TEST_FAILED';
      if (pack.cloneMode === 'COUNTRY_ACCENT') this.digitalHumanServiceHealth.accent = false;
      this.updateSettings({ providers: { tts: { voiceProfiles: (this.settings.providers.tts.voiceProfiles ?? []).map((profile) =>
        (profile.id ?? profile.voiceId) === id ? { ...profile, status: 'FAILED', previewUrl: undefined, updatedAt: Date.now(), lastError: message } : profile) } } });
      this.persistence.recordEvent('GPTSOVITS_VOICE_REAL_TEST_FAILED', { id, error: message });
      throw error;
    }
  }

  listDigitalHumanProfiles(): { voices: VoiceProfile[]; avatars: AvatarProfile[]; accentProfiles: VoiceAccentProfile[]; activeVoiceProfileId?: string; activeAvatarProfileId?: string; audioBus: AppSettings['audioBus']; voiceCloneProvider: NonNullable<AppSettings['providers']['tts']['voiceCloneApi']>['provider']; voiceCloneConfigured: boolean } {
    return {
      voices: this.settings.providers.tts.voiceProfiles ?? [],
      avatars: this.settings.providers.avatar.profiles ?? [],
      accentProfiles: this.getAccentSettings().profiles,
      activeVoiceProfileId: this.settings.providers.tts.activeVoiceProfileId,
      activeAvatarProfileId: this.settings.providers.avatar.activeProfileId,
      audioBus: this.settings.audioBus,
      voiceCloneProvider: this.settings.providers.tts.voiceCloneApi?.provider ?? 'aliyun',
      voiceCloneConfigured: this.settings.providers.tts.voiceCloneApi?.provider === 'local-openvoice'
        ? true
        : Boolean(this.resolveSecret(this.settings.providers.tts.voiceCloneApi?.provider === 'baidu' ? 'voiceCloneBaidu' : 'voiceCloneAliyun').value),
    };
  }

  private seedDevelopmentDigitalHumanProfiles(): void {
    const now = Date.now();
    const voicePath = join(this.voicesDirectory, 'MeihuaDevelopmentVoice-mtd8x53z.wav');
    const voiceId = 'MeihuaDevelopmentVoice-mtd8x53z';
    const voices = this.settings.providers.tts.voiceProfiles ?? [];
    const packs = this.settings.providers.tts.gptsovits.voices ?? [];
    if (existsSync(voicePath) && !voices.some((profile) => (profile.id ?? profile.voiceId) === voiceId)) {
      const referenceText = 'Welcome to the Meihua live development studio. This sample verifies voice cloning, lip synchronization, and avatar actions.';
      this.settings = normalizeSettings({ ...this.settings, providers: { ...this.settings.providers, tts: { ...this.settings.providers.tts,
        gptsovits: { ...this.settings.providers.tts.gptsovits, voices: [...packs, { id: voiceId, name: 'Meihua Development Voice', refAudioPath: voicePath, refText: referenceText, refLanguage: 'en', createdAt: now }] },
        voiceProfiles: [...voices, { id: voiceId, voiceId, provider: 'gptsovits-v3', name: 'Meihua Development Voice', language: 'en', status: 'NEEDS_REVIEW', speed: 1, testText: referenceText, createdAt: now, updatedAt: now }],
      } } });
      this.persistence.recordEvent('DEVELOPMENT_VOICE_SEEDED', { voiceId });
    }
    const avatars = this.settings.providers.avatar.profiles ?? [];
    if (!avatars.some((profile) => profile.provider === 'LOCAL_VIDEO')) {
      const source = this.persistence.listMediaAssets().find((asset) => asset.mimeType === 'video/mp4' && asset.fileName === 'meihua-background-h264.mp4');
      if (source) {
        const profile: AvatarProfile = {
          id: randomUUID(), name: '梅花女师开发视频人物', provider: 'LOCAL_VIDEO', status: 'UPLOADED',
          sourceAssetId: source.id, preparedAvatarId: `avatar-${randomUUID()}`, previewAssetId: source.id,
          maxTextureSize: 2048, renderFps: 30, chromaColor: '#00ff00', createdAt: now, updatedAt: now,
          version: 1, developmentOnly: true, authorizationConfirmed: true, actionBindings: defaultAvatarActionBindings(),
        };
        this.settings = normalizeSettings({ ...this.settings, providers: { ...this.settings.providers, avatar: { ...this.settings.providers.avatar, profiles: [...avatars, profile] } } });
        this.persistence.recordEvent('DEVELOPMENT_VIDEO_AVATAR_SEEDED', { profileId: profile.id, sourceAssetId: source.id, warning: 'DEV_ONLY_WATERMARKED_ASSET' });
      }
    }
    // A normalized reference file is not proof that synthesis works. Downgrade
    // records created by older builds unless a playable test WAV was persisted.
    const currentVoiceProfiles = this.settings.providers.tts.voiceProfiles ?? [];
    const currentPacks = this.settings.providers.tts.gptsovits.voices ?? [];
    const upgradedVoiceProfiles = currentVoiceProfiles.map((profile) => {
      const id = profile.id ?? profile.voiceId;
      const pack = currentPacks.find((candidate) => candidate.id === id);
      return profile.provider === 'gptsovits-v3' && pack && existsSync(pack.refAudioPath) && profile.status !== 'DISABLED' && !profile.previewUrl
        ? { ...profile, status: 'NEEDS_REVIEW' as const, approvedAt: undefined, updatedAt: now, lastError: 'VOICE_REAL_TEST_REQUIRED' }
        : profile;
    });
    if (upgradedVoiceProfiles.some((profile, index) => profile !== currentVoiceProfiles[index])) {
      this.settings = normalizeSettings({ ...this.settings, providers: { ...this.settings.providers, tts: { ...this.settings.providers.tts, voiceProfiles: upgradedVoiceProfiles } } });
      this.persistence.recordEvent('UNVERIFIED_LOCAL_VOICES_DOWNGRADED', { count: upgradedVoiceProfiles.filter((profile) => profile.status === 'NEEDS_REVIEW').length });
    }
    // MuseTalk preprocessing is the clone operation. A playable source video is
    // the preview shown immediately after cloning; lip-sync is rendered later
    // from the real reading audio. Older builds incorrectly downgraded every
    // prepared avatar on restart merely because its preview was the source
    // video, which made a valid clone look broken and cleared the selection.
    const normalizedVoices = this.settings.providers.tts.voiceProfiles ?? [];
    const selectedVoice = normalizedVoices.find((profile) => (profile.id ?? profile.voiceId) === this.settings.providers.tts.activeVoiceProfileId);
    const normalizedAvatars = this.settings.providers.avatar.profiles ?? [];
    const selectedAvatar = normalizedAvatars.find((profile) => profile.id === this.settings.providers.avatar.activeProfileId);
    const legacyDevelopmentVrm = selectedAvatar?.provider === 'LOCAL_VRM' && selectedAvatar.developmentOnly === true;
    if ((selectedVoice && selectedVoice.status !== 'READY') || (selectedAvatar && (selectedAvatar.status !== 'READY' || legacyDevelopmentVrm))) {
      this.settings = normalizeSettings({ ...this.settings, providers: { ...this.settings.providers,
        tts: { ...this.settings.providers.tts, activeVoiceProfileId: selectedVoice?.status === 'READY' ? this.settings.providers.tts.activeVoiceProfileId : undefined },
        avatar: { ...this.settings.providers.avatar, activeProfileId: selectedAvatar?.status === 'READY' && !legacyDevelopmentVrm ? this.settings.providers.avatar.activeProfileId : undefined, adapter: selectedAvatar?.status === 'READY' && !legacyDevelopmentVrm ? this.settings.providers.avatar.adapter : 'none' },
      } });
      this.persistence.recordEvent(legacyDevelopmentVrm ? 'LEGACY_DEVELOPMENT_VRM_SELECTION_CLEARED' : 'UNVERIFIED_DIGITAL_HUMAN_SELECTION_CLEARED', { profileId: selectedAvatar?.id });
    }
    this.persistence.setSetting('settings', this.settings);
  }

  /** One compact, truthful launch checklist for the operator-facing three-step page. */
  getDigitalHumanLaunchStatus(): { ready: boolean; checks: Array<{ id: 'events' | 'content' | 'voice' | 'avatar'; label: string; status: 'PASS' | 'WARN' | 'FAIL'; message: string }> } {
    const health = this.getHealth();
    const voices = this.settings.providers.tts.voiceProfiles ?? [];
    const avatars = this.settings.providers.avatar.profiles ?? [];
    const activeVoice = voices.find((item) => (item.id ?? item.voiceId) === this.settings.providers.tts.activeVoiceProfileId);
    const activeAvatar = avatars.find((item) => item.id === this.settings.providers.avatar.activeProfileId);
    const pass = (status: string) => status === 'READY';
    const checks = [
      { id: 'events' as const, label: '直播事件', status: pass(health.input) ? 'PASS' as const : health.input === 'NOT_CONFIGURED' ? 'FAIL' as const : 'WARN' as const, message: pass(health.input) ? 'TikFinity 已收到有效事件' : health.tikfinity?.lastError || '请在高级诊断中完成 TikFinity 连接' },
      { id: 'content' as const, label: '内容生成', status: pass(health.llm) || this.settings.providers.llm.adapter === 'rule-based' ? 'PASS' as const : health.llm === 'NOT_CONFIGURED' ? 'FAIL' as const : 'WARN' as const, message: pass(health.llm) ? '内容模型已通过真实连接验证' : this.settings.providers.llm.adapter === 'rule-based' ? '正在使用本地规则兜底内容' : '内容模型尚未完成真实测试' },
      { id: 'voice' as const, label: '声音播报', status: activeVoice?.status === 'READY' && pass(health.tts) && this.settings.audioBus.enabled && (activeVoice.provider !== 'gptsovits-v3' || activeVoice.cloneMode !== 'COUNTRY_ACCENT' || (this.digitalHumanServiceHealth.accent && this.getAccentSettings().profiles.some((profile) => profile.id === activeVoice.accentProfileId && profile.enabled))) ? 'PASS' as const : !activeVoice ? 'FAIL' as const : 'WARN' as const, message: activeVoice?.status === 'READY' ? `${activeVoice.name} 已选中；${this.settings.audioBus.outputDeviceName || '请指定输出设备'}` : '请先试听、批准并启用一个声音档案' },
      { id: 'avatar' as const, label: '数字人画面', status: activeAvatar?.status === 'READY' && pass(health.avatar) && (activeAvatar.provider !== 'LOCAL_VIDEO' || (this.settings.providers.avatar.adapter === 'musetalk' && Boolean(activeAvatar.preparedAvatarId))) ? 'PASS' as const : !activeAvatar ? 'FAIL' as const : 'WARN' as const, message: activeAvatar?.status === 'READY' ? `${activeAvatar.name} 已在舞台待命` : '请上传并启用一个通过检查的数字人' },
    ];
    return { ready: checks.every((item) => item.status === 'PASS'), checks };
  }

  approveVoiceProfile(id: string): VoiceProfile {
    const profiles = this.settings.providers.tts.voiceProfiles ?? [];
    const current = profiles.find((profile) => (profile.id ?? profile.voiceId) === id);
    if (!current) throw new Error('VOICE_PROFILE_NOT_FOUND');
    if (current.language === 'ar') throw new Error('ARABIC_VOICE_SLOT_DISABLED');
    if (!current.previewUrl?.startsWith('/api/audio/')) throw new Error('VOICE_REAL_TEST_REQUIRED');
    if (!['VALIDATING', 'NEEDS_REVIEW', 'READY'].includes(current.status ?? '')) throw new Error('VOICE_PROFILE_MUST_BE_TESTED');
    const approved = { ...current, status: 'READY' as const, approvedAt: Date.now(), updatedAt: Date.now(), lastError: undefined };
    this.updateSettings({ providers: { tts: { voiceProfiles: profiles.map((profile) => (profile.id ?? profile.voiceId) === id ? approved : profile) } } });
    this.persistence.recordEvent('VOICE_PROFILE_APPROVED', { id, provider: approved.provider, language: approved.language });
    return approved;
  }

  activateVoiceProfile(id: string): VoiceProfile {
    const current = (this.settings.providers.tts.voiceProfiles ?? []).find((profile) => (profile.id ?? profile.voiceId) === id);
    if (!current) throw new Error('VOICE_PROFILE_NOT_FOUND');
    if (current.status !== 'READY') throw new Error('VOICE_PROFILE_NOT_READY');
    this.updateSettings({ providers: { tts: {
      adapter: current.provider === 'gptsovits-v3' ? 'gptsovits' : this.settings.providers.tts.adapter,
      activeVoiceProfileId: id, voiceId: current.voiceId,
    } } });
    this.persistence.recordEvent('VOICE_PROFILE_ACTIVATED', { id, appliesFrom: 'NEXT_READING' });
    return current;
  }

  disableVoiceProfile(id: string): VoiceProfile {
    const profiles = this.settings.providers.tts.voiceProfiles ?? [];
    const current = profiles.find((profile) => (profile.id ?? profile.voiceId) === id);
    if (!current) throw new Error('VOICE_PROFILE_NOT_FOUND');
    const disabled = { ...current, status: 'DISABLED' as const, updatedAt: Date.now() };
    this.updateSettings({ providers: { tts: {
      activeVoiceProfileId: this.settings.providers.tts.activeVoiceProfileId === id ? undefined : this.settings.providers.tts.activeVoiceProfileId,
      voiceProfiles: profiles.map((profile) => (profile.id ?? profile.voiceId) === id ? disabled : profile),
    } } });
    this.persistence.recordEvent('VOICE_PROFILE_DISABLED', { id });
    return disabled;
  }

  retryVoiceProfile(id: string): { profile: VoiceProfile; job: DigitalHumanJob } {
    const profiles = this.settings.providers.tts.voiceProfiles ?? [];
    const current = profiles.find((profile) => (profile.id ?? profile.voiceId) === id);
    const pack = this.settings.providers.tts.gptsovits.voices.find((voice) => voice.id === id);
    if (!current || !pack) throw new Error('VOICE_PROFILE_NOT_FOUND');
    if (!existsSync(pack.refAudioPath)) throw new Error('VOICE_REFERENCE_AUDIO_MISSING');
    const queued = this.queueVoiceClone({
      id,
      name: current.name,
      fileName: 'reference.wav',
      mimeType: 'audio/wav',
      base64: readFileSync(pack.refAudioPath).toString('base64'),
      refText: pack.refText,
      refLanguage: pack.refLanguage,
      targetLocale: pack.targetLocale ?? current.targetLocale,
      targetCountry: pack.targetCountry ?? current.targetCountry,
      accentProfileId: pack.accentProfileId ?? current.accentProfileId,
      cloneMode: pack.cloneMode ?? current.cloneMode ?? 'COUNTRY_ACCENT',
    });
    this.persistence.recordEvent('VOICE_PROFILE_RECLONE_QUEUED', { id, jobId: queued.job.id });
    return queued;
  }

  createAvatarProfile(input: { name: string; provider: AvatarProfile['provider']; modelAssetId?: string; sourceAssetId?: string; cloudFigureId?: string; cloudVideoUrl?: string; chromaColor?: string; authorizationConfirmed?: boolean; developmentOnly?: boolean }): AvatarProfile {
    if (!input.name.trim()) throw new Error('AVATAR_NAME_REQUIRED');
    if (input.provider === 'LOCAL_VRM') {
      const asset = input.modelAssetId ? this.persistence.getMediaAsset(input.modelAssetId) : undefined;
      if (!asset || asset.kind !== 'AVATAR_VRM') throw new Error('AVATAR_VRM_ASSET_REQUIRED');
      const modelPath = this.resolveAssetPath(asset);
      if (!modelPath || !existsSync(modelPath)) throw new Error('AVATAR_VRM_FILE_MISSING');
      validateVrmModel(modelPath);
    }
    if (input.provider === 'LOCAL_VIDEO' || input.provider === 'ALIYUN_CLOUD' || input.provider === 'BAIDU_CLOUD') {
      const asset = input.sourceAssetId ? this.persistence.getMediaAsset(input.sourceAssetId) : undefined;
      if (!asset || !asset.mimeType.startsWith('video/')) throw new Error('AVATAR_VIDEO_ASSET_REQUIRED');
      if (!input.authorizationConfirmed) throw new Error('AVATAR_AUTHORIZATION_REQUIRED');
    }
    const now = Date.now();
    const profile: AvatarProfile = {
      id: randomUUID(), name: input.name.trim().slice(0, 80), provider: input.provider,
      status: input.provider === 'LOCAL_VRM' ? 'READY' : 'UPLOADED', modelAssetId: input.modelAssetId,
      sourceAssetId: input.sourceAssetId, preparedAvatarId: input.provider === 'LOCAL_VIDEO' ? `avatar-${randomUUID()}` : undefined,
      cloudFigureId: input.cloudFigureId?.trim().slice(0, 160), cloudVideoUrl: input.cloudVideoUrl?.trim().slice(0, 1000),
      maxTextureSize: 2048, renderFps: 30, chromaColor: input.chromaColor ?? '#00ff00', createdAt: now, updatedAt: now,
      version: 1, developmentOnly: input.developmentOnly === true, authorizationConfirmed: input.authorizationConfirmed === true,
      actionBindings: defaultAvatarActionBindings(),
    };
    this.updateSettings({ providers: { avatar: { profiles: [...(this.settings.providers.avatar.profiles ?? []), profile] } } });
    this.persistence.recordEvent('AVATAR_PROFILE_CREATED', { id: profile.id, provider: profile.provider });
    return profile;
  }

  activateAvatarProfile(id: string): AvatarProfile {
    const profile = (this.settings.providers.avatar.profiles ?? []).find((item) => item.id === id);
    if (!profile) throw new Error('AVATAR_PROFILE_NOT_FOUND');
    if (profile.status !== 'READY') throw new Error('AVATAR_PROFILE_NOT_READY');
    this.updateSettings({ providers: { avatar: { activeProfileId: id, adapter: profile.provider === 'LOCAL_VRM' ? 'local-vrm' : profile.provider === 'LOCAL_VIDEO' ? 'musetalk' : profile.provider === 'ALIYUN_CLOUD' ? 'aliyun-cloud' : 'baidu-cloud' } } });
    if (profile.provider === 'LOCAL_VIDEO' || profile.provider === 'ALIYUN_CLOUD' || profile.provider === 'BAIDU_CLOUD') {
      const assetId = profile.previewAssetId ?? profile.sourceAssetId;
      if (assetId) this.activeAvatarMedia = { kind: 'VIDEO_URL', url: `/api/media-assets/${encodeURIComponent(assetId)}/content`, label: profile.name, muted: true, profileId: profile.id, playback: 'LOOP' };
    }
    this.persistence.recordEvent('AVATAR_PROFILE_ACTIVATED', { id, appliesFrom: 'NEXT_READING' });
    this.publishSnapshot('STATE_CHANGED');
    return profile;
  }

  disableAvatarProfile(id: string): AvatarProfile {
    const profile = this.getAvatarProfile(id);
    const disabled = this.replaceAvatarProfile(id, { status: 'DISABLED' });
    if (this.settings.providers.avatar.activeProfileId === id) this.updateSettings({ providers: { avatar: { activeProfileId: undefined, adapter: 'none' } } });
    this.persistence.recordEvent('AVATAR_PROFILE_DISABLED', { id, provider: profile.provider });
    this.publishSnapshot('STATE_CHANGED');
    return disabled;
  }

  async retryAvatarProfile(id: string): Promise<AvatarProfile> {
    const profile = this.getAvatarProfile(id);
    if (profile.provider === 'LOCAL_VIDEO') {
      this.replaceAvatarProfile(id, { status: 'UPLOADED', lastError: undefined });
      return this.prepareAvatarProfile(id);
    }
    if (profile.provider === 'LOCAL_VRM') return this.replaceAvatarProfile(id, { status: 'READY', lastError: undefined });
    return this.replaceAvatarProfile(id, { status: 'UPLOADED', lastError: undefined });
  }

  retryAvatarPreparation(id: string): DigitalHumanJob {
    const profile = this.getAvatarProfile(id);
    if (profile.provider !== 'LOCAL_VIDEO' && profile.provider !== 'ALIYUN_CLOUD' && profile.provider !== 'BAIDU_CLOUD') throw new Error('VIDEO_AVATAR_REQUIRED');
    this.replaceAvatarProfile(id, { status: 'UPLOADED', previewAssetId: undefined, lastError: undefined });
    return this.queueAvatarPreparation(id);
  }

  private replaceAvatarProfile(id: string, patch: Partial<AvatarProfile>): AvatarProfile {
    const profiles = this.settings.providers.avatar.profiles ?? [];
    const current = profiles.find((item) => item.id === id);
    if (!current) throw new Error('AVATAR_PROFILE_NOT_FOUND');
    const next = { ...current, ...patch, id: current.id, updatedAt: Date.now() };
    this.updateSettings({ providers: { avatar: { profiles: profiles.map((item) => item.id === id ? next : item) } } });
    return next;
  }

  getAvatarProfile(id: string): AvatarProfile {
    const profile = (this.settings.providers.avatar.profiles ?? []).find((item) => item.id === id);
    if (!profile) throw new Error('AVATAR_PROFILE_NOT_FOUND');
    return profile;
  }

  private saveDigitalHumanJob(job: DigitalHumanJob): DigitalHumanJob {
    this.persistence.saveDigitalHumanJob(job);
    return structuredClone(job);
  }

  private patchDigitalHumanJob(id: string, patch: Partial<DigitalHumanJob>): DigitalHumanJob {
    const current = this.persistence.getDigitalHumanJob(id);
    if (!current) throw new Error('DIGITAL_HUMAN_JOB_NOT_FOUND');
    return this.saveDigitalHumanJob({ ...current, ...patch, id: current.id, updatedAt: Date.now() });
  }

  getDigitalHumanJob(id: string): DigitalHumanJob {
    const job = this.persistence.getDigitalHumanJob(id);
    if (!job) throw new Error('DIGITAL_HUMAN_JOB_NOT_FOUND');
    return job;
  }

  listDigitalHumanJobs(profileId?: string): DigitalHumanJob[] {
    return this.persistence.listDigitalHumanJobs({ profileId });
  }

  cancelDigitalHumanJob(id: string): DigitalHumanJob {
    const job = this.getDigitalHumanJob(id);
    if (['READY', 'FAILED', 'CANCELED'].includes(job.status)) return job;
    return this.patchDigitalHumanJob(id, { status: 'CANCELED', stage: 'CANCELED', finishedAt: Date.now() });
  }

  private launchAvatarPreparation(job: DigitalHumanJob): void {
    if (this.digitalHumanJobRunners.has(job.id)) return;
    const runner = (async () => {
      try {
        this.patchDigitalHumanJob(job.id, { status: 'PROCESSING', stage: 'CONNECTING', progress: 5, startedAt: Date.now() });
        const profile = await this.prepareAvatarProfile(job.profileId);
        const latest = this.getDigitalHumanJob(job.id);
        if (latest.status === 'CANCELED') return;
        if (profile.status !== 'READY') throw new Error(profile.lastError || 'MUSETALK_AVATAR_PREP_FAILED');
        this.patchDigitalHumanJob(job.id, { status: 'READY', stage: 'COMPLETE', progress: 100, finishedAt: Date.now() });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'AVATAR_PREP_FAILED';
        if (this.persistence.getDigitalHumanJob(job.id)?.status !== 'CANCELED') {
          this.patchDigitalHumanJob(job.id, { status: 'FAILED', stage: 'FAILED', progress: 100, errorCode: message.split(':', 1)[0], errorMessage: message, finishedAt: Date.now() });
        }
      } finally {
        this.digitalHumanJobRunners.delete(job.id);
      }
    })();
    this.digitalHumanJobRunners.set(job.id, runner);
  }

  private resumeDigitalHumanJobs(): void {
    // The constructor schedules this scan as a microtask so normal startup is
    // not delayed.  Tests and embedding hosts can close the persistence layer
    // in the same turn, though; a late recovery scan must never become an
    // unhandled "database is not open" exception.
    try {
      for (const job of this.persistence.listDigitalHumanJobs()) {
        if (job.status !== 'QUEUED' && job.status !== 'PROCESSING') continue;
        if (job.kind === 'AVATAR_PREP') this.launchAvatarPreparation(job);
        if (job.kind === 'VOICE_CLONE') this.launchVoiceClone(job);
      }
    } catch (error) {
      if (!(error instanceof Error) || !/database is not open/i.test(error.message)) throw error;
    }
  }

  queueAvatarPreparation(id: string): DigitalHumanJob {
    const profile = this.getAvatarProfile(id);
    if (!['LOCAL_VIDEO', 'ALIYUN_CLOUD', 'BAIDU_CLOUD'].includes(profile.provider) || !profile.sourceAssetId) throw new Error('VIDEO_AVATAR_REQUIRED');
    const asset = this.persistence.getMediaAsset(profile.sourceAssetId);
    const path = asset ? this.resolveAssetPath(asset) : undefined;
    if (!path || !existsSync(path)) throw new Error('AVATAR_SOURCE_VIDEO_MISSING');
    const dedupeKey = `AVATAR_PREP:${id}:${asset?.contentHash ?? profile.sourceAssetId}:${profile.version ?? 1}`;
    const existing = this.persistence.findActiveDigitalHumanJob(dedupeKey);
    if (existing) {
      this.launchAvatarPreparation(existing);
      return existing;
    }
    const now = Date.now();
    const job: DigitalHumanJob = { id: randomUUID(), kind: 'AVATAR_PREP', profileId: id, status: 'QUEUED', stage: 'QUEUED', progress: 0, dedupeKey, createdAt: now, updatedAt: now };
    this.replaceAvatarProfile(id, { status: 'PREPARING', lastError: undefined });
    this.saveDigitalHumanJob(job);
    this.persistence.recordEvent('VIDEO_AVATAR_PREP_JOB_CREATED', { id, jobId: job.id, dedupeKey });
    this.launchAvatarPreparation(job);
    return job;
  }

  async prepareAvatarProfile(id: string): Promise<AvatarProfile> {
    const profile = this.getAvatarProfile(id);
    if (!['LOCAL_VIDEO', 'ALIYUN_CLOUD', 'BAIDU_CLOUD'].includes(profile.provider) || !profile.sourceAssetId) throw new Error('VIDEO_AVATAR_REQUIRED');
    // Keep the narrowed value outside async callbacks; TypeScript deliberately
    // does not assume profile fields remain unchanged after an await boundary.
    const preparedAvatarId = profile.preparedAvatarId;
    const asset = this.persistence.getMediaAsset(profile.sourceAssetId);
    const path = asset ? this.resolveAssetPath(asset) : undefined;
    if (!path || !existsSync(path)) throw new Error('AVATAR_SOURCE_VIDEO_MISSING');
    this.replaceAvatarProfile(id, { status: 'PREPARING', lastError: undefined });
    try {
      if (profile.provider === 'ALIYUN_CLOUD' || profile.provider === 'BAIDU_CLOUD') {
        const provider = profile.provider === 'ALIYUN_CLOUD' ? 'aliyun' : 'baidu';
        const adapter = this.getCloudAvatarProvider(provider);
        const connection = await adapter.connect();
        if (!connection.connected) {
          const pending = this.replaceAvatarProfile(id, { status: 'UPLOADED', previewAssetId: undefined, lastError: `${provider.toUpperCase()}_AVATAR_NOT_READY:${connection.lastError ?? 'SERVICE_OFFLINE'}` });
          this.persistence.recordEvent('CLOUD_AVATAR_PREP_DEFERRED', { id, provider, reason: connection.lastError ?? 'SERVICE_OFFLINE' });
          return pending;
        }
        const cloned = await this.runGpuTask('AVATAR_PREP', () => adapter.clone({ name: profile.name, videoPath: path, authorizationConfirmed: profile.authorizationConfirmed === true }));
        this.persistence.recordEvent('CLOUD_AVATAR_TRAINING_SUBMITTED', { id, provider, cloudFigureId: cloned.cloudFigureId, engineVersion: cloned.engineVersion });
        const training = await adapter.waitForClone(cloned.cloudFigureId);
        const prepared = this.replaceAvatarProfile(id, { status: 'READY', preparedAvatarId: cloned.cloudFigureId, cloudFigureId: cloned.cloudFigureId, cloudVideoUrl: cloned.streamUrl, previewAssetId: profile.sourceAssetId, lastError: undefined });
        this.persistence.recordEvent('CLOUD_AVATAR_PREPARED', { id, provider, cloudFigureId: cloned.cloudFigureId, engineVersion: training.engineVersion ?? cloned.engineVersion });
        return prepared;
      }
      const adapter = this.getMuseTalkAvatarProvider();
      if (!preparedAvatarId) throw new Error('LOCAL_VIDEO_PREPARED_AVATAR_ID_MISSING');
      const connection = await adapter.connect();
      if (!connection.connected) {
        const prepared = this.replaceAvatarProfile(id, { status: 'UPLOADED', previewAssetId: undefined, lastError: `MUSETALK_NOT_READY:${connection.lastError ?? 'SERVICE_OFFLINE'}` });
        this.persistence.recordEvent('VIDEO_AVATAR_PREP_DEFERRED', { id, preparedAvatarId: profile.preparedAvatarId, reason: connection.lastError ?? 'SERVICE_OFFLINE' });
        return prepared;
      }
      await this.runGpuTask('AVATAR_PREP', () => adapter.prepareAvatar(preparedAvatarId, path));
      const prepared = this.replaceAvatarProfile(id, { status: 'READY', previewAssetId: profile.sourceAssetId, lastError: undefined });
      this.persistence.recordEvent('VIDEO_AVATAR_PREPARED', { id, preparedAvatarId: profile.preparedAvatarId });
      return prepared;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AVATAR_PREP_FAILED';
      this.replaceAvatarProfile(id, { status: 'FAILED', lastError: message });
      throw error;
    }
  }

  updateAvatarActions(id: string, bindings: Partial<Record<AvatarAction, AvatarActionBinding>>): AvatarProfile {
    const profile = this.getAvatarProfile(id);
    const allowedAssets = new Set(this.persistence.listMediaAssets().filter((asset) => asset.kind === 'AVATAR_VIDEO' || asset.kind === 'AVATAR_IMAGE').map((asset) => asset.id));
    const safe = Object.fromEntries(Object.entries(bindings).flatMap(([action, binding]) => {
      if (!digitalHumanActions.includes(action as AvatarAction) || !binding) return [];
      if (binding.assetId && !allowedAssets.has(binding.assetId)) throw new Error('AVATAR_ACTION_ASSET_INVALID');
      return [[action, { ...binding, action: action as AvatarAction }]];
    })) as Partial<Record<AvatarAction, AvatarActionBinding>>;
    const next = this.replaceAvatarProfile(id, { actionBindings: { ...profile.actionBindings, ...safe } });
    this.persistence.recordEvent('AVATAR_ACTION_BINDINGS_UPDATED', { id, actions: Object.keys(safe) });
    return next;
  }

  async testAvatarProfile(id: string): Promise<{ profile: AvatarProfile; detail: string; previewAssetId?: string }> {
    const profile = this.getAvatarProfile(id);
    if (profile.provider === 'ALIYUN_CLOUD' || profile.provider === 'BAIDU_CLOUD') {
      const verifiedVoice = (this.settings.providers.tts.voiceProfiles ?? []).find((candidate) => candidate.status === 'READY' && candidate.previewUrl?.startsWith('/api/audio/'));
      const latestAudio = verifiedVoice?.previewUrl ?? this.persistence.listReadings({ limit: 20 }).find((reading) => reading.tts?.audioPath)?.tts?.audioPath;
      const audioPath = latestAudio ? join(this.audioDirectory, basename(latestAudio)) : '';
      if (!audioPath || !existsSync(audioPath)) throw new Error('CLOUD_AVATAR_TEST_AUDIO_REQUIRED');
      if (!profile.cloudFigureId && !profile.preparedAvatarId) throw new Error('CLOUD_AVATAR_NOT_PREPARED');
      const provider = profile.provider === 'ALIYUN_CLOUD' ? 'aliyun' : 'baidu';
      const adapter = this.getCloudAvatarProvider(provider);
      const rendered = await this.runGpuTask('AVATAR_RENDER', () => adapter.render(audioPath, `cloud-avatar-test-${Date.now()}`, profile.cloudFigureId ?? profile.preparedAvatarId!, '这是数字人的实时渲染测试。'));
      adapter.setMediaUrl(rendered.streamUrl, rendered.rtc);
      this.activeAvatarMedia = { kind: rendered.rtc ? 'WEBRTC' : 'VIDEO_URL', url: rendered.streamUrl, rtc: rendered.rtc, label: profile.name, muted: true, profileId: profile.id };
      const ready = this.replaceAvatarProfile(id, { status: 'READY', cloudVideoUrl: rendered.streamUrl, lastError: undefined });
      this.publishSnapshot('STATE_CHANGED');
      return { profile: ready, detail: `${provider === 'aliyun' ? '阿里云' : '百度曦灵'}实时渲染试听已返回视频流` };
    }
    if (profile.provider !== 'LOCAL_VIDEO' || !profile.preparedAvatarId) throw new Error('LOCAL_VIDEO_AVATAR_REQUIRED');
    const result = await this.testMuseTalkAvatar(profile.preparedAvatarId);
    if (!result.ok || !result.previewAssetId || result.previewAssetId === profile.sourceAssetId) {
      const detail = result.ok ? 'MUSETALK_DID_NOT_PRODUCE_NEW_LIPSYNC_VIDEO' : result.detail;
      this.replaceAvatarProfile(id, { status: 'NEEDS_REVIEW', previewAssetId: profile.previewAssetId, lastError: detail });
      throw new Error(detail);
    }
    const ready = this.replaceAvatarProfile(id, { status: 'READY', previewAssetId: result.previewAssetId ?? profile.previewAssetId, lastError: undefined });
    return { profile: ready, detail: result.detail, previewAssetId: result.previewAssetId };
  }

  listDigitalHumanPresets(): DigitalHumanPreset[] { return structuredClone(this.digitalHumanPresets); }

  saveDigitalHumanPreset(input: Partial<DigitalHumanPreset> & { name: string }): DigitalHumanPreset {
    const now = Date.now();
    const current = input.id ? this.digitalHumanPresets.find((item) => item.id === input.id) : undefined;
    const preset: DigitalHumanPreset = {
      ...(current ?? createDefaultDigitalHumanPreset()), ...input,
      id: current?.id ?? randomUUID(), name: input.name.trim().slice(0, 80), status: 'DRAFT',
      speed: clampFloat(input.speed, current?.speed ?? 1, 0.6, 1.6), lipStrength: clampFloat(input.lipStrength, current?.lipStrength ?? 1, 0, 2),
      mouthCloseThreshold: clampFloat(input.mouthCloseThreshold, current?.mouthCloseThreshold ?? 0.08, 0, 1),
      audioVideoOffsetMs: clamp(Number(input.audioVideoOffsetMs), current?.audioVideoOffsetMs ?? 0, -1_000, 1_000),
      version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now, publishedAt: undefined,
    };
    this.digitalHumanPresets = current ? this.digitalHumanPresets.map((item) => item.id === preset.id ? preset : item) : [...this.digitalHumanPresets, preset];
    this.persistence.setSetting('digital-human-presets', this.digitalHumanPresets);
    return structuredClone(preset);
  }

  activateDigitalHumanPreset(id: string): DigitalHumanPreset {
    const current = this.digitalHumanPresets.find((item) => item.id === id);
    if (!current) throw new Error('DIGITAL_HUMAN_PRESET_NOT_FOUND');
    const avatar = current.avatarProfileId ? this.getAvatarProfile(current.avatarProfileId) : undefined;
    const voice = current.voiceProfileId ? (this.settings.providers.tts.voiceProfiles ?? []).find((item) => (item.id ?? item.voiceId) === current.voiceProfileId) : undefined;
    if (!avatar || avatar.status !== 'READY') throw new Error('AVATAR_PROFILE_NOT_READY');
    if (avatar.provider === 'LOCAL_VIDEO' && (!avatar.preparedAvatarId || this.settings.providers.avatar.adapter !== 'musetalk')) throw new Error('DIGITAL_HUMAN_VIDEO_PROVIDER_MISMATCH');
    if (!voice || voice.status !== 'READY') throw new Error('VOICE_PROFILE_NOT_READY');
    if (voice.provider === 'gptsovits-v3' && voice.cloneMode === 'COUNTRY_ACCENT' && !this.getAccentSettings().profiles.some((profile) => profile.id === voice.accentProfileId && profile.enabled)) throw new Error('VOICE_ACCENT_PROFILE_UNAVAILABLE');
    if (current.avatarProfileId) this.activateAvatarProfile(current.avatarProfileId);
    if (current.voiceProfileId) this.activateVoiceProfile(current.voiceProfileId);
    const now = Date.now();
    this.digitalHumanPresets = this.digitalHumanPresets.map((item) => item.id === id ? { ...item, status: 'ACTIVE', publishedAt: now, updatedAt: now } : item.status === 'ACTIVE' ? { ...item, status: 'ARCHIVED' } : item);
    this.persistence.setSetting('digital-human-presets', this.digitalHumanPresets);
    this.persistence.recordEvent('DIGITAL_HUMAN_PRESET_ACTIVATED', { id, appliesFrom: 'NEXT_READING' });
    return structuredClone(this.digitalHumanPresets.find((item) => item.id === id)!);
  }

  /** Select once, then expose the chosen digital human in the workbench draft. */
  selectDigitalHuman(input: { avatarProfileId: string; voiceProfileId: string }): DigitalHumanPreset {
    const avatar = this.getAvatarProfile(input.avatarProfileId);
    const voice = (this.settings.providers.tts.voiceProfiles ?? []).find((item) => (item.id ?? item.voiceId) === input.voiceProfileId);
    if (avatar.status !== 'READY') throw new Error('AVATAR_PROFILE_NOT_READY');
    if (avatar.provider === 'LOCAL_VIDEO' && (!avatar.preparedAvatarId || this.settings.providers.avatar.adapter !== 'musetalk')) throw new Error('DIGITAL_HUMAN_VIDEO_PROVIDER_MISMATCH');
    if (!voice || voice.status !== 'READY') throw new Error('VOICE_PROFILE_NOT_READY');
    if (voice.provider === 'gptsovits-v3' && voice.cloneMode === 'COUNTRY_ACCENT') {
      const accent = this.getAccentSettings().profiles.find((profile) => profile.id === voice.accentProfileId && profile.enabled);
      if (!accent) throw new Error('VOICE_ACCENT_PROFILE_UNAVAILABLE');
    }
    const current = this.digitalHumanPresets.find((item) => item.status === 'ACTIVE') ?? this.digitalHumanPresets[0];
    const saved = this.saveDigitalHumanPreset({
      ...current,
      id: current?.id,
      name: current?.name || '默认数字人方案',
      avatarProfileId: avatar.id,
      voiceProfileId: input.voiceProfileId,
      language: voice.language === 'ar' ? 'en' : voice.language,
      speechLocale: voice.targetLocale,
      targetCountry: voice.targetCountry,
      accentProfileId: voice.accentProfileId,
      speed: voice.speed ?? 1,
    });
    const activated = this.activateDigitalHumanPreset(saved.id);
    const profile = structuredClone(this.draftProfileVersion.profile);
    profile.sources.avatar = { ...profile.sources.avatar, enabled: true };
    const avatarLayer = profile.composition?.layers.find((layer) => layer.kind === 'MODULE' && layer.moduleId === 'avatar');
    if (avatarLayer) avatarLayer.visible = true;
    this.updateSceneDraft(profile);
    this.persistence.recordEvent('DIGITAL_HUMAN_MAPPED_TO_WORKBENCH', { avatarProfileId: avatar.id, voiceProfileId: input.voiceProfileId, presetId: activated.id });
    return activated;
  }

  listDigitalHumanBroadcast(): DigitalHumanBroadcastItem[] {
    return [...this.digitalHumanBroadcast.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map((item) => structuredClone(item));
  }

  enqueueManualBroadcast(text: string, action: AvatarAction = 'SPEAKING_NEUTRAL'): DigitalHumanBroadcastItem {
    const preset = this.digitalHumanPresets.find((item) => item.status === 'ACTIVE') ?? this.digitalHumanPresets[0];
    if (!preset) throw new Error('DIGITAL_HUMAN_PRESET_REQUIRED');
    const item: DigitalHumanBroadcastItem = { id: randomUUID(), source: 'MANUAL', text: text.trim().slice(0, 2_000), action, presetSnapshot: structuredClone(preset), status: 'QUEUED', renderJobIds: [], createdAt: Date.now() };
    if (!item.text) throw new Error('BROADCAST_TEXT_REQUIRED');
    this.digitalHumanBroadcast.set(item.id, item);
    this.persistence.recordEvent('DIGITAL_HUMAN_BROADCAST_QUEUED', { id: item.id, source: item.source, action });
    queueMicrotask(() => void this.processDigitalHumanBroadcastQueue());
    return structuredClone(item);
  }

  private updateDigitalHumanBroadcast(id: string, patch: Partial<DigitalHumanBroadcastItem>): DigitalHumanBroadcastItem {
    const current = this.digitalHumanBroadcast.get(id);
    if (!current) throw new Error('DIGITAL_HUMAN_BROADCAST_NOT_FOUND');
    const next = { ...current, ...patch, id: current.id };
    this.digitalHumanBroadcast.set(id, next);
    return next;
  }

  recordAvatarMediaReady(renderJobId: string): void {
    const waiter = this.avatarMediaReadyWaiters.get(renderJobId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.avatarMediaReadyWaiters.delete(renderJobId);
    waiter.resolve();
    this.persistence.recordEvent('AVATAR_MEDIA_READY', { renderJobId });
  }

  private waitForAvatarMediaReady(renderJobId: string, signal: AbortSignal): Promise<void> {
    if (this.overlayClients.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { this.avatarMediaReadyWaiters.delete(renderJobId); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 1_500);
      this.avatarMediaReadyWaiters.set(renderJobId, { resolve: finish, timer });
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  listAvatarRenderJobs(): AvatarRenderJob[] {
    return [...this.avatarRenderJobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200)
      .map((job) => structuredClone(job));
  }

  private updateAvatarRenderJob(id: string, patch: Partial<AvatarRenderJob>): AvatarRenderJob {
    const current = this.avatarRenderJobs.get(id);
    if (!current) throw new Error('AVATAR_RENDER_JOB_NOT_FOUND');
    const next = { ...current, ...patch, id: current.id, updatedAt: Date.now() };
    this.avatarRenderJobs.set(id, next);
    return next;
  }

  private async prepareDigitalHumanSegment(item: DigitalHumanBroadcastItem, text: string, segmentIndex: number, targetSeconds: number | undefined, signal: AbortSignal): Promise<{ prepared: PreparedDigitalHumanSegment; job: AvatarRenderJob }> {
    if (signal.aborted) throw new PipelineAbortedError();
    const preset = item.presetSnapshot;
    const avatar = (this.settings.providers.avatar.profiles ?? []).find((profile) => profile.id === preset.avatarProfileId);
    const voice = (this.settings.providers.tts.voiceProfiles ?? []).find((profile) => (profile.id ?? profile.voiceId) === preset.voiceProfileId);
    const cacheKey = createHash('sha256').update(JSON.stringify({
      text,
      avatarId: avatar?.id,
      avatarVersion: avatar?.version,
      voiceId: voice?.id ?? voice?.voiceId,
      speed: preset.speed,
      language: preset.language,
      targetLocale: preset.speechLocale ?? voice?.targetLocale,
      targetCountry: preset.targetCountry ?? voice?.targetCountry,
      accentProfileId: preset.accentProfileId ?? voice?.accentProfileId,
      cloneMode: voice?.cloneMode,
    })).digest('hex');
    const now = Date.now();
    const job: AvatarRenderJob = {
      id: randomUUID(), avatarProfileId: avatar?.id ?? 'NONE', segmentId: `${item.id}-${segmentIndex + 1}`,
      status: 'QUEUED', progress: 0, cacheKey, createdAt: now, updatedAt: now,
    };
    this.avatarRenderJobs.set(job.id, job);
    const cached = this.digitalHumanSegmentCache.get(cacheKey);
    if (cached && existsSync(cached.audioFilePath) && (!cached.outputAssetId || this.persistence.getMediaAsset(cached.outputAssetId))) {
      const ready = this.updateAvatarRenderJob(job.id, { status: 'READY', progress: 100, audioAssetId: basename(cached.audioFilePath), outputAssetId: cached.outputAssetId, durationMs: cached.durationMs, startedAt: now });
      this.persistence.recordEvent('AVATAR_SEGMENT_CACHE_HIT', { broadcastId: item.id, segmentIndex, cacheKey });
      return { prepared: cached, job: ready };
    }
    try {
      this.updateAvatarRenderJob(job.id, { status: 'PREPARING', progress: 10, startedAt: Date.now() });
      const audio = await this.runGpuTask('VOICE_SYNTHESIS', () => this.getTtsAdapter().synthesize({
        readingId: `broadcast-${item.id}-${segmentIndex + 1}`, text,
        voiceId: voice?.voiceId ?? this.settings.providers.tts.voiceId,
        speed: preset.speed || voice?.speed || this.settings.providers.tts.speed,
        locale: preset.language === 'yue' ? 'zh-CN' : preset.language,
        targetLocale: preset.speechLocale ?? voice?.targetLocale ?? this.getVoiceTargetLocale(),
        targetCountry: preset.targetCountry ?? voice?.targetCountry,
        accentProfileId: preset.accentProfileId ?? voice?.accentProfileId,
        sourceLanguage: voice?.sourceLanguage,
        targetSeconds: Math.max(3, Math.min(30, Math.round(targetSeconds ?? Math.ceil(text.length / 12)))),
      }));
      if (signal.aborted) throw new PipelineAbortedError();
      if (!audio.audioPath) throw new Error('TTS_AUDIO_PATH_MISSING');
      const audioFilePath = join(this.audioDirectory, basename(audio.audioPath));
      if (!existsSync(audioFilePath)) throw new Error('TTS_AUDIO_FILE_MISSING');
      let outputAssetId: string | undefined;
      const needsAvatarRender = avatar?.provider === 'LOCAL_VIDEO' || avatar?.provider === 'ALIYUN_CLOUD' || avatar?.provider === 'BAIDU_CLOUD';
      this.updateAvatarRenderJob(job.id, { status: needsAvatarRender ? 'RENDERING' : 'READY', progress: needsAvatarRender ? 35 : 100, audioAssetId: basename(audioFilePath), durationMs: audio.durationMs });
      let mediaUrl: string | undefined;
      let mediaKind: PreparedDigitalHumanSegment['mediaKind'];
      if (avatar?.provider === 'LOCAL_VIDEO' && avatar.preparedAvatarId && avatar.lastError !== deferredMuseTalkPreparation) {
        const rendered = await this.runGpuTask('AVATAR_RENDER', () => this.getMuseTalkAvatarProvider().render(audioFilePath, `${item.id}-${segmentIndex + 1}`, avatar.preparedAvatarId));
        if (signal.aborted) throw new PipelineAbortedError();
        const asset = this.importGeneratedAvatarVideo(rendered.videoPath, `broadcast-${item.id}-${segmentIndex + 1}`);
        outputAssetId = asset.id;
        mediaUrl = `/api/media-assets/${encodeURIComponent(asset.id)}/content`;
        mediaKind = 'VIDEO_URL';
      } else if ((avatar?.provider === 'ALIYUN_CLOUD' || avatar?.provider === 'BAIDU_CLOUD') && (avatar.cloudFigureId || avatar.preparedAvatarId)) {
        const provider = avatar.provider === 'ALIYUN_CLOUD' ? 'aliyun' : 'baidu';
        const cloud = this.getCloudAvatarProvider(provider);
        const rendered = await this.runGpuTask('AVATAR_RENDER', () => cloud.render(audioFilePath, `${item.id}-${segmentIndex + 1}`, avatar.cloudFigureId ?? avatar.preparedAvatarId!, text));
        cloud.setMediaUrl(rendered.streamUrl, rendered.rtc);
        const rtc = rendered.rtc;
        mediaUrl = rendered.streamUrl;
        mediaKind = cloud.getState().media.kind === 'WEBRTC' ? 'WEBRTC' : 'VIDEO_URL';
        const prepared = { cacheKey, text, audioFilePath, audioPublicPath: audio.audioPath, durationMs: audio.durationMs, outputAssetId, mediaUrl, mediaKind, rtc };
        this.digitalHumanSegmentCache.set(cacheKey, prepared);
        const ready = this.updateAvatarRenderJob(job.id, { status: 'READY', progress: 100, outputAssetId });
        return { prepared, job: ready };
      }
      const prepared = { cacheKey, text, audioFilePath, audioPublicPath: audio.audioPath, durationMs: audio.durationMs, outputAssetId, mediaUrl, mediaKind };
      this.digitalHumanSegmentCache.set(cacheKey, prepared);
      const ready = this.updateAvatarRenderJob(job.id, { status: 'READY', progress: 100, outputAssetId });
      return { prepared, job: ready };
    } catch (error) {
      this.updateAvatarRenderJob(job.id, { status: signal.aborted ? 'CANCELED' : 'FAILED', failureReason: error instanceof Error ? error.message : 'SEGMENT_PREPARATION_FAILED', finishedAt: Date.now() });
      throw error;
    }
  }

  private async processDigitalHumanBroadcastQueue(): Promise<void> {
    if (this.processingDigitalHumanBroadcast || this.closing) return;
    if (this.active) {
      setTimeout(() => void this.processDigitalHumanBroadcastQueue(), 750).unref?.();
      return;
    }
    const item = [...this.digitalHumanBroadcast.values()]
      .filter((candidate) => candidate.status === 'QUEUED')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!item) return;
    this.processingDigitalHumanBroadcast = true;
    const controller = new AbortController();
    this.activeDigitalHumanBroadcast = { id: item.id, controller };
    try {
      const segments = splitDigitalHumanSentences(item.text);
      if (!segments.length) throw new Error('BROADCAST_TEXT_REQUIRED');
      this.updateDigitalHumanBroadcast(item.id, { status: 'PREBUFFERING', failureReason: undefined, segmentCount: segments.length, currentSegment: 0 });
      const schedule = (segmentText: string, index: number) => {
        const promise = this.prepareDigitalHumanSegment(item, segmentText, index, undefined, controller.signal);
        void promise.catch(() => undefined);
        return promise;
      };
      let pending = schedule(segments[0], 0);
      const allowGpuPrebuffer = this.gpuRuntimeProfile.prebufferSegments > 0;
      const renderJobIds = [...item.renderJobIds];
      for (let index = 0; index < segments.length; index += 1) {
        const { prepared, job } = await pending;
        if (!renderJobIds.includes(job.id)) renderJobIds.push(job.id);
        const nextIndex = index + 1;
        const hasNext = nextIndex < segments.length;
        // SAFE_8GB deliberately does not start the next GPU job while this
        // segment is playing.  The next job begins during the visible thinking
        // transition only after the current audio/video has ended.
        const prebuffered = hasNext && allowGpuPrebuffer;
        if (prebuffered) pending = schedule(segments[nextIndex], nextIndex);
        const avatar = (this.settings.providers.avatar.profiles ?? []).find((profile) => profile.id === item.presetSnapshot.avatarProfileId);
        let mediaUrl: string | undefined;
        if (prepared.outputAssetId) {
          mediaUrl = `/api/media-assets/${encodeURIComponent(prepared.outputAssetId)}/content`;
           this.activeAvatarMedia = { kind: 'VIDEO_URL', url: mediaUrl, label: avatar?.name ?? 'Digital human', muted: true, profileId: avatar?.id, renderJobId: job.id, outputAssetId: prepared.outputAssetId, playback: 'ONCE' };
           this.publishSnapshot('STATE_CHANGED');
           await this.waitForAvatarMediaReady(job.id, controller.signal);
         } else if (prepared.rtc) {
           this.activeAvatarMedia = { kind: 'WEBRTC', rtc: prepared.rtc, label: avatar?.name ?? 'Digital human', muted: true, profileId: avatar?.id, renderJobId: job.id, playback: 'ONCE' };
           this.publishSnapshot('STATE_CHANGED');
         }
        this.updateAvatarRenderJob(job.id, { status: 'PLAYING', startedAt: Date.now() });
        this.updateDigitalHumanBroadcast(item.id, { status: 'PLAYING', renderJobIds, currentSegment: index + 1, startedAt: this.digitalHumanBroadcast.get(item.id)?.startedAt ?? Date.now() });
        await this.performAvatar(index === 0 ? item.action : 'SPEAKING_NEUTRAL', `broadcast-${item.id}-${index + 1}`);
        if (mediaUrl) await this.getMuseTalkAvatarProvider().speak(mediaUrl);
        await this.audioPlayer.play({ filePath: prepared.audioFilePath, signal: controller.signal });
        this.updateAvatarRenderJob(job.id, { status: 'FINISHED', progress: 100, finishedAt: Date.now() });
        if (hasNext) {
          if (!prebuffered) pending = schedule(segments[nextIndex], nextIndex);
          await this.performAvatar('THINKING', `broadcast-${item.id}-buffering`);
        }
      }
      this.updateDigitalHumanBroadcast(item.id, { status: 'FINISHED', finishedAt: Date.now() });
      await this.performAvatar('FINISH', `broadcast-${item.id}`);
    } catch (error) {
      const current = this.digitalHumanBroadcast.get(item.id);
      for (const jobId of current?.renderJobIds ?? []) {
        const job = this.avatarRenderJobs.get(jobId);
        if (job && !['FINISHED', 'FAILED', 'CANCELED'].includes(job.status)) this.updateAvatarRenderJob(jobId, { status: controller.signal.aborted ? 'CANCELED' : 'FAILED', failureReason: error instanceof Error ? error.message : 'DIGITAL_HUMAN_BROADCAST_FAILED', finishedAt: Date.now() });
      }
      if (current && !['PAUSED', 'SKIPPED'].includes(current.status)) {
        const failureReason = error instanceof Error ? error.message : 'DIGITAL_HUMAN_BROADCAST_FAILED';
        this.updateDigitalHumanBroadcast(item.id, { status: 'FAILED', failureReason, finishedAt: Date.now() });
        this.persistence.recordEvent('DIGITAL_HUMAN_BROADCAST_FAILED', { id: item.id, failureReason });
      }
    } finally {
      this.processingDigitalHumanBroadcast = false;
      if (this.activeDigitalHumanBroadcast?.id === item.id) this.activeDigitalHumanBroadcast = undefined;
      queueMicrotask(() => void this.processDigitalHumanBroadcastQueue());
    }
  }

  controlDigitalHumanBroadcast(id: string, action: 'pause' | 'resume' | 'skip' | 'replay' | 'stop'): DigitalHumanBroadcastItem {
    const current = this.digitalHumanBroadcast.get(id);
    if (!current) throw new Error('DIGITAL_HUMAN_BROADCAST_NOT_FOUND');
    const status: DigitalHumanBroadcastItem['status'] = action === 'pause' ? 'PAUSED' : action === 'resume' || action === 'replay' ? 'QUEUED' : 'SKIPPED';
    const next = { ...current, status, finishedAt: status === 'SKIPPED' ? Date.now() : current.finishedAt };
    this.digitalHumanBroadcast.set(id, next);
    if (this.activeDigitalHumanBroadcast?.id === id && (action === 'pause' || action === 'skip' || action === 'stop')) this.activeDigitalHumanBroadcast.controller.abort();
    this.persistence.recordEvent('DIGITAL_HUMAN_BROADCAST_CONTROL', { id, action });
    if (status === 'QUEUED') queueMicrotask(() => void this.processDigitalHumanBroadcastQueue());
    return structuredClone(next);
  }

  updateAudioBus(input: Partial<AppSettings['audioBus']>): AppSettings['audioBus'] {
    const audioBus = { ...this.settings.audioBus, ...input, muteBrowserAudio: true as const, sampleRate: input.sampleRate === 24000 ? 24000 as const : 48000 as const };
    this.updateSettings({ audioBus });
    this.persistence.recordEvent('AUDIO_BUS_UPDATED', { outputDeviceName: audioBus.outputDeviceName, requireExactDevice: audioBus.requireExactDevice });
    return this.settings.audioBus;
  }

  async saveAndEnableDigitalHuman(input: Partial<AppSettings['audioBus']>): Promise<ReturnType<LiveRuntime['getDigitalHumanLaunchStatus']> & { voiceTest?: string; avatarTest?: string }> {
    this.updateAudioBus(input);
    const activeVoiceId = this.settings.providers.tts.activeVoiceProfileId;
    const activeAvatarId = this.settings.providers.avatar.activeProfileId;
    const activeVoice = (this.settings.providers.tts.voiceProfiles ?? []).find((item) => (item.id ?? item.voiceId) === activeVoiceId);
    const activeAvatar = (this.settings.providers.avatar.profiles ?? []).find((item) => item.id === activeAvatarId);
    let voiceTest: string | undefined;
    let avatarTest: string | undefined;

    if (activeVoice?.status === 'READY' && activeVoice.provider === 'gptsovits-v3') {
      try {
        const result = await this.testGptSoVitsVoice(activeVoice.voiceId, activeVoice.testText);
        voiceTest = `PASS:${result.durationMs}ms`;
      } catch (error) {
        this.providerVerification.delete('tts');
        const message = error instanceof Error ? error.message : 'VOICE_TEST_FAILED';
        voiceTest = `FAIL:${message}`;
        this.updateSettings({ providers: { tts: { voiceProfiles: (this.settings.providers.tts.voiceProfiles ?? []).map((profile) =>
          (profile.id ?? profile.voiceId) === activeVoiceId ? { ...profile, lastError: message, updatedAt: Date.now() } : profile) } } });
      }
    }

    if (activeAvatar?.status === 'READY') {
      try {
        const provider = this.avatarProvider;
        await provider.connect();
        await provider.detectCapabilities();
        await provider.perform('SPEAKING_NEUTRAL', { readingId: `launch-check-${Date.now()}` });
        await provider.perform('IDLE', { readingId: `launch-check-${Date.now()}` });
        avatarTest = 'PASS';
      } catch (error) {
        avatarTest = `FAIL:${error instanceof Error ? error.message : 'AVATAR_TEST_FAILED'}`;
      }
    }

    this.publishSnapshot('STATE_CHANGED');
    return { ...this.getDigitalHumanLaunchStatus(), voiceTest, avatarTest };
  }

  async connectVTube(): Promise<VTubeStudioConnectionState> {
    this.vtube.configure(this.settings.providers.avatar.url, readDpapiSecret(this.vtubeTokenPath));
    const state = await this.vtube.connect();
    this.persistence.recordEvent('VTUBE_CONNECT_ATTEMPT', { state });
    this.publishSnapshot();
    return state;
  }

  async authorizeVTube(): Promise<VTubeStudioConnectionState> {
    const state = await this.vtube.authorize();
    this.persistence.recordEvent('VTUBE_AUTHORIZE_ATTEMPT', { state });
    this.publishSnapshot();
    return state;
  }

  async disconnectVTube(): Promise<VTubeStudioConnectionState> {
    await this.vtube.disconnect();
    this.persistence.recordEvent('VTUBE_DISCONNECTED', {});
    this.publishSnapshot();
    return this.vtube.getState();
  }

  async testVTubeMouth() {
    const result = { ok: false, reason: 'LIP_SYNC_DISABLED_BY_DESIGN' };
    this.persistence.recordEvent('VTUBE_MOUTH_TEST', result);
    return result;
  }

  async testVTubeActions() {
    const result = await this.vtube.testActions();
    this.persistence.recordEvent('VTUBE_ACTION_TEST', result);
    return result;
  }

  getAvatarProviderState(): AvatarProviderAdapterState {
    return this.avatarProvider.getState();
  }

  /**
   * Full mock linkage for the V2.2 avatar provider contract: connect, capability
   * detection, session creation, one pass over every stage action, media output
   * and disconnect. It only exercises the local simulation, so it can never be
   * presented as a vendor verification result.
   */
  async runAvatarProviderMockLinkage(): Promise<{ ok: boolean; actions: Array<{ action: string; ok: boolean; reason?: string }>; state: AvatarProviderAdapterState; media: AvatarStageMedia }> {
    const provider = this.mockAvatarProvider;
    const actions: Array<{ action: string; ok: boolean; reason?: string }> = [];
    try {
      await provider.connect();
      await provider.detectCapabilities();
      const session = await provider.createSession({ note: 'mock-linkage' });
      for (const action of ['IDLE', 'QUESTION_RECEIVED', 'CASTING', 'THINKING', 'SPEAKING_NEUTRAL', 'SPEAKING_EMPHASIS', 'THANK_GIFT', 'FINISH', 'ERROR_RECOVER']) {
        try {
          await provider.perform(action as AvatarAction, { readingId: 'mock-linkage' });
          actions.push({ action, ok: true });
        } catch (error) {
          actions.push({ action, ok: false, reason: error instanceof Error ? error.message : 'unknown' });
        }
      }
      const media = provider.mediaOutput();
      const state = provider.getState();
      this.persistence.recordEvent('AVATAR_PROVIDER_MOCK_LINKAGE', { ok: actions.every((item) => item.ok), sessionId: session.sessionId, media });
      await provider.disconnect();
      return { ok: actions.every((item) => item.ok), actions, state, media };
    } catch (error) {
      this.persistence.recordEvent('AVATAR_PROVIDER_MOCK_LINKAGE_FAILED', { message: error instanceof Error ? error.message : 'unknown' });
      await provider.disconnect();
      return { ok: false, actions, state: provider.getState(), media: provider.mediaOutput() };
    }
  }

  registerAudioSource(sourceInstanceId: string): AudioSourceLease {
    const now = Date.now();
    this.sweepAudioLease(now);
    this.audioSourceHeartbeats.set(sourceInstanceId, now);
    if (!this.activeAudioLease || this.activeAudioLease.sourceInstanceId === sourceInstanceId) {
      const lease: AudioSourceLease = {
        sourceInstanceId,
        leaseId: this.activeAudioLease?.leaseId ?? randomUUID(),
        acquiredAt: this.activeAudioLease?.acquiredAt ?? now,
        expiresAt: now + 3_500,
        active: true,
      };
      this.activeAudioLease = lease;
      this.syncMetrics = { ...this.syncMetrics, activeLease: lease, activeAudioSources: this.countLiveAudioSources(now) };
      this.persistence.recordSyncMetric('AUDIO_SOURCE_LEASE_ACQUIRED', lease, this.currentSession?.sessionId);
      this.publishSnapshot();
      return lease;
    }
    this.syncMetrics = { ...this.syncMetrics, activeAudioSources: this.countLiveAudioSources(now), lastFailure: { code: 'DUPLICATE_AUDIO_SOURCE', message: 'A second audio browser source is muted because another source owns the playback lease.', at: now } };
    this.persistence.recordSyncMetric('AUDIO_SOURCE_LEASE_REJECTED', { sourceInstanceId, owner: this.activeAudioLease.sourceInstanceId }, this.currentSession?.sessionId);
    return { sourceInstanceId, leaseId: '', acquiredAt: now, expiresAt: this.activeAudioLease.expiresAt, active: false };
  }

  heartbeatAudioSource(sourceInstanceId: string, leaseId: string): { ok: boolean; lease?: AudioSourceLease; reason?: string } {
    const now = Date.now();
    if (!this.activeAudioLease || this.activeAudioLease.sourceInstanceId !== sourceInstanceId || this.activeAudioLease.leaseId !== leaseId) {
      return { ok: false, reason: 'AUDIO_LEASE_NOT_HELD' };
    }
    const lease = { ...this.activeAudioLease, expiresAt: now + 3_500 };
    this.activeAudioLease = lease;
    this.audioSourceHeartbeats.set(sourceInstanceId, now);
    this.syncMetrics = { ...this.syncMetrics, activeLease: lease, activeAudioSources: this.countLiveAudioSources(now) };
    return { ok: true, lease };
  }

  releaseAudioSource(sourceInstanceId: string, leaseId?: string): { ok: boolean } {
    this.audioSourceHeartbeats.delete(sourceInstanceId);
    if (this.activeAudioLease?.sourceInstanceId === sourceInstanceId && (!leaseId || this.activeAudioLease.leaseId === leaseId)) {
      this.activeAudioLease = undefined;
      this.syncMetrics = { ...this.syncMetrics, activeLease: undefined, activeAudioSources: this.countLiveAudioSources(Date.now()) };
      this.persistence.recordSyncMetric('LEGACY_AUDIO_SOURCE_RELEASED', { sourceInstanceId }, this.currentSession?.sessionId);
    }
    return { ok: true };
  }

  getSyncMetrics(): SyncMetrics { return structuredClone(this.syncMetrics); }

  getObsSourceHealth(): Array<{ sourceId: string; enabled: boolean; connected: boolean; connections: number; lastConnectedAt?: number }> {
    return Object.values(this.publishedProfileVersion.profile.sources)
      .filter((source) => !['full-preview', 'avatar', 'audio'].includes(source.sourceId))
      .map((source) => {
        const connections = [...this.overlaySocketSources.values()].filter((connection) => connection.sourceId === source.sourceId);
        return {
          sourceId: source.sourceId,
          enabled: source.enabled,
          connected: connections.length > 0,
          connections: connections.length,
          lastConnectedAt: connections.length ? Math.max(...connections.map((connection) => connection.connectedAt)) : undefined,
        };
      });
  }

  recordAudioPlaybackEvent(input: { event: 'PLAY_STARTED' | 'PLAY_ENDED' | 'PLAY_FAILED' | 'PLAY_PAUSED'; sourceInstanceId: string; leaseId: string; readingId?: string; cueId?: string; positionMs?: number; message?: string }) {
    const snapshot = this.getBroadcastSnapshotV2();
    if (!this.activeAudioLease || this.activeAudioLease.sourceInstanceId !== input.sourceInstanceId || this.activeAudioLease.leaseId !== input.leaseId || this.activeAudioLease.expiresAt <= Date.now()) {
      return { ok: false, reason: 'AUDIO_LEASE_NOT_HELD' };
    }
    if (input.readingId && input.readingId !== snapshot.reading?.id) return { ok: false, reason: 'READING_IS_NOT_CURRENT' };
    if (input.cueId && input.cueId !== snapshot.activeCue?.cueId) return { ok: false, reason: 'CUE_IS_NOT_CURRENT' };
    this.persistence.recordEvent(`AUDIO_${input.event}`, {
      sessionId: snapshot.session?.sessionId,
      readingId: snapshot.reading?.id,
      cueId: snapshot.activeCue?.cueId,
      positionMs: Math.max(0, Math.round(input.positionMs ?? 0)),
      message: input.message?.slice(0, 500),
    });
    if (input.event === 'PLAY_STARTED' && snapshot.activeCue?.stage === 'SPEAKING') {
      const startsAt = this.confirmAudioMasterClock(snapshot.activeCue.cueId, input.positionMs ?? 0);
      if (startsAt !== undefined) {
        this.syncMetrics = { ...this.syncMetrics, lastAudioStartedAt: startsAt, lastFailure: undefined };
        this.persistence.recordSyncMetric('AUDIO_PLAY_STARTED', { startsAt, sourceInstanceId: input.sourceInstanceId, cueId: snapshot.activeCue.cueId }, snapshot.session?.sessionId);
      }
    }
    if (input.event === 'PLAY_ENDED' && snapshot.activeCue?.stage === 'SPEAKING') {
      this.syncMetrics = { ...this.syncMetrics, lastAudioEndedAt: Date.now() };
      this.audioEndedBeforeWait.add(snapshot.activeCue.cueId);
      this.audioEndWaiters.get(snapshot.activeCue.cueId)?.resolve();
      this.audioEndWaiters.delete(snapshot.activeCue.cueId);
    }
    if (input.event === 'PLAY_FAILED' || input.event === 'PLAY_PAUSED') {
      this.failAudioPlayback(input.event === 'PLAY_FAILED' ? 'AUDIO_PLAY_FAILED' : 'AUDIO_PLAY_PAUSED', input.message ?? `Audio source reported ${input.event}.`);
    }
    return { ok: true };
  }

  private transcodeVideoBytes(bytes: Buffer, sourceExtension: string): Buffer {
    const ffmpeg = bundledFfmpegPath();
    if (!ffmpeg) throw new Error('FFMPEG_UNAVAILABLE: 视频兼容处理组件未就绪');
    const token = randomUUID();
    // Keep the temporary input extension for FFmpeg probing, but make its basename
    // different from the MP4 output. For MP4 input the old names were identical,
    // causing FFmpeg to abort with "cannot edit existing files in-place".
    const sourcePath = join(this.mediaDirectory, `.processing-${token}.input${sourceExtension || '.mp4'}`);
    const outputPath = join(this.mediaDirectory, `.processing-${token}.mp4`);
    writeFileSync(sourcePath, bytes, { flag: 'wx' });
    try {
      const result = spawnSync(ffmpeg, ['-y', '-i', sourcePath, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', outputPath], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 });
      if (result.error || result.status !== 0 || !existsSync(outputPath)) throw new Error(`VIDEO_TRANSCODE_FAILED:${result.error?.message ?? result.stderr?.slice(-280) ?? 'ffmpeg exited unexpectedly'}`);
      return readFileSync(outputPath);
    } finally {
      try { unlinkSync(sourcePath); } catch { /* temporary input */ }
      try { unlinkSync(outputPath); } catch { /* temporary output */ }
    }
  }

  /** Replaces an existing source file in-place at the same asset ID, so scene references never break. */
  normalizeVideoAsset(id: string): MediaAsset {
    const asset = this.persistence.getMediaAsset(id);
    const sourcePath = asset ? this.resolveAssetPath(asset) : undefined;
    if (!asset || !sourcePath || !existsSync(sourcePath) || !asset.mimeType.startsWith('video/')) throw new Error('VIDEO_ASSET_NOT_FOUND');
    const bytes = this.transcodeVideoBytes(readFileSync(sourcePath), extname(asset.fileName));
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const storageKey = `${contentHash}.mp4`;
    const storagePath = join(this.mediaDirectory, storageKey);
    if (!existsSync(storagePath)) writeFileSync(storagePath, bytes, { flag: 'wx' });
    const normalized: MediaAsset = { ...asset, fileName: asset.fileName.replace(/\.(webm|mp4)$/i, '.mp4'), mimeType: 'video/mp4', contentHash, sizeBytes: bytes.length, storageKey, storagePath, transparency: 'ABSENT', createdAt: Date.now() };
    this.persistence.saveMediaAsset(normalized);
    this.persistence.recordEvent('MEDIA_ASSET_VIDEO_NORMALIZED', { id, fileName: normalized.fileName, sizeBytes: normalized.sizeBytes });
    // The scene keeps the same asset ID, so explicitly notify existing OBS clients
    // that the media contents have a new revision instead of waiting for a profile publish.
    this.publishSnapshot();
    return this.toPublicMediaAsset(normalized);
  }

  uploadMediaAsset(input: { kind: MediaAssetKind; fileName: string; mimeType: string; base64: string }): MediaAsset {
    const fileName = basename(input.fileName.trim());
    let normalizedFileName = fileName;
    let mimeType = input.mimeType.toLocaleLowerCase();
    const allowed: Record<string, { extensions: string[]; kinds: MediaAssetKind[] }> = {
      'image/png': { extensions: ['.png'], kinds: ['BACKGROUND_IMAGE', 'AVATAR_IMAGE', 'STICKER_IMAGE', 'OVERLAY_IMAGE'] },
      'image/jpeg': { extensions: ['.jpg', '.jpeg'], kinds: ['BACKGROUND_IMAGE', 'AVATAR_IMAGE', 'STICKER_IMAGE', 'OVERLAY_IMAGE'] },
      'image/webp': { extensions: ['.webp'], kinds: ['BACKGROUND_IMAGE', 'AVATAR_IMAGE', 'STICKER_IMAGE', 'OVERLAY_IMAGE'] },
      'image/svg+xml': { extensions: ['.svg'], kinds: ['BACKGROUND_IMAGE', 'STICKER_IMAGE', 'OVERLAY_IMAGE'] },
      'video/mp4': { extensions: ['.mp4'], kinds: ['BACKGROUND_VIDEO', 'AVATAR_VIDEO'] },
      'video/webm': { extensions: ['.webm'], kinds: ['BACKGROUND_VIDEO', 'AVATAR_VIDEO'] },
      'model/gltf-binary': { extensions: ['.glb', '.vrm', '.vrma'], kinds: ['LUX3D_MODEL', 'AVATAR_VRM', 'AVATAR_ANIMATION'] },
      'application/octet-stream': { extensions: ['.vrm', '.vrma'], kinds: ['AVATAR_VRM', 'AVATAR_ANIMATION'] },
      'audio/wav': { extensions: ['.wav'], kinds: ['AUDIO_REFERENCE'] },
      'audio/x-wav': { extensions: ['.wav'], kinds: ['AUDIO_REFERENCE'] },
      'audio/mpeg': { extensions: ['.mp3'], kinds: ['AUDIO_REFERENCE'] },
    };
    const contract = allowed[mimeType];
    if (!fileName || !contract || !contract.extensions.includes(extname(fileName).toLocaleLowerCase()) || !contract.kinds.includes(input.kind)) throw new Error('MEDIA_TYPE_EXTENSION_OR_KIND_INVALID');
    let bytes = Buffer.from(input.base64, 'base64');
    if (!bytes.length || bytes.length > 80 * 1024 * 1024) throw new Error('MEDIA_SIZE_INVALID');
    const signatureValid = mimeType === 'image/svg+xml'
      ? bytes.subarray(0, 200).toString('utf8').includes('<svg')
      : mimeType === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mimeType === 'image/jpeg'
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
      : mimeType === 'image/webp'
        ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        : mimeType === 'model/gltf-binary' || mimeType === 'application/octet-stream'
          ? bytes.subarray(0, 4).equals(Buffer.from('glTF'))
        : mimeType === 'audio/wav' || mimeType === 'audio/x-wav'
          ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
        : mimeType === 'audio/mpeg'
          ? bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
        : mimeType === 'video/mp4'
          ? bytes.toString('ascii', 4, 8) === 'ftyp'
          : bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!signatureValid) throw new Error('MEDIA_FILE_SIGNATURE_INVALID');
    if (input.kind === 'BACKGROUND_VIDEO' || input.kind === 'AVATAR_VIDEO') {
      bytes = this.transcodeVideoBytes(bytes, extname(fileName));
      mimeType = 'video/mp4';
      normalizedFileName = fileName.replace(/\.(webm|mp4)$/i, '.mp4');
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const existing = this.persistence.getMediaAssetByHash(contentHash);
    if (existing) return this.toPublicMediaAsset(existing);
    let width: number | undefined;
    let height: number | undefined;
    let transparency: MediaAsset['transparency'] = 'UNKNOWN';
    if (mimeType === 'image/png' && bytes.length >= 26) {
      width = bytes.readUInt32BE(16);
      height = bytes.readUInt32BE(20);
      transparency = [4, 6].includes(bytes[25]) ? 'PRESENT' : 'ABSENT';
    } else if (mimeType === 'image/webp' || mimeType === 'video/webm') transparency = 'SUPPORTED_FORMAT';
    const id = randomUUID();
    const storageKey = `${contentHash}${extname(normalizedFileName).toLocaleLowerCase()}`;
    const storagePath = join(this.mediaDirectory, storageKey);
    writeFileSync(storagePath, bytes, { flag: 'wx' });
    const asset: MediaAsset = {
      id, kind: input.kind, origin: 'UPLOADED', fileName: normalizedFileName, mimeType, contentHash, sizeBytes: bytes.length, storageKey, storagePath,
      width, height, transparency, createdAt: Date.now(),
    };
    this.persistence.saveMediaAsset(asset);
    this.persistence.recordEvent('MEDIA_ASSET_CREATED', { id, kind: asset.kind, fileName, sizeBytes: asset.sizeBytes, transparency });
    return this.toPublicMediaAsset(asset);
  }

  private importGeneratedAvatarVideo(filePath: string, name: string): MediaAsset {
    if (!existsSync(filePath)) throw new Error('AVATAR_RENDER_OUTPUT_MISSING');
    const bytes = readFileSync(filePath);
    if (!bytes.length) throw new Error('AVATAR_RENDER_OUTPUT_EMPTY');
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const existing = this.persistence.getMediaAssetByHash(contentHash);
    if (existing) return this.toPublicMediaAsset(existing);
    const storageKey = `${contentHash}.mp4`;
    const storagePath = join(this.mediaDirectory, storageKey);
    if (!existsSync(storagePath)) writeFileSync(storagePath, bytes, { flag: 'wx' });
    const asset: MediaAsset = {
      id: randomUUID(), kind: 'AVATAR_VIDEO', origin: 'UPLOADED', fileName: `${name.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 60) || 'avatar-render'}.mp4`,
      mimeType: 'video/mp4', contentHash, sizeBytes: bytes.length, storageKey, storagePath,
      transparency: 'ABSENT', createdAt: Date.now(),
    };
    this.persistence.saveMediaAsset(asset);
    this.persistence.recordEvent('AVATAR_RENDER_MEDIA_REGISTERED', { assetId: asset.id, sizeBytes: asset.sizeBytes });
    return this.toPublicMediaAsset(asset);
  }

  getMediaAssetContent(id: string): { asset: MediaAsset; path: string } | undefined {
    const asset = this.persistence.getMediaAsset(id);
    const path = asset ? this.resolveAssetPath(asset) : undefined;
    if (!asset || !path || !existsSync(path)) return undefined;
    return { asset: this.toPublicMediaAsset(asset), path };
  }

  /**
   * Material cards use cached WebP thumbnails so opening the library never asks
   * Chromium to decode every full-resolution image or video at once.
   */
  async getMediaAssetThumbnail(id: string): Promise<{ asset: MediaAsset; path: string } | undefined> {
    const asset = this.persistence.getMediaAsset(id);
    const source = asset ? this.resolveAssetPath(asset) : undefined;
    if (!asset || !source || !existsSync(source)) return undefined;
    if (!asset.mimeType.startsWith('image/') && !asset.mimeType.startsWith('video/')) return undefined;
    const directory = join(this.mediaDirectory, '.thumbnails');
    const target = join(directory, `${asset.contentHash}.webp`);
    if (!existsSync(target)) {
      const existing = this.thumbnailJobs.get(target);
      const job = existing ?? this.createMediaThumbnail(source, target, asset.mimeType.startsWith('video/'));
      if (!existing) this.thumbnailJobs.set(target, job);
      await job;
    }
    return existsSync(target) ? { asset: this.toPublicMediaAsset(asset), path: target } : undefined;
  }

  private createMediaThumbnail(source: string, target: string, video: boolean): Promise<string | undefined> {
    const ffmpeg = bundledFfmpegPath();
    if (!ffmpeg) return Promise.resolve(undefined);
    mkdirSync(join(this.mediaDirectory, '.thumbnails'), { recursive: true });
    const args = [
      '-y',
      ...(video ? ['-ss', '0.1'] : []),
      '-i', source,
      '-frames:v', '1',
      '-vf', 'scale=320:-2:flags=lanczos',
      '-c:v', 'libwebp',
      '-quality', '72',
      target,
    ];
    return new Promise((resolve) => {
      let settled = false;
      const complete = (success: boolean) => {
        if (settled) return;
        settled = true;
        this.thumbnailJobs.delete(target);
        if (!success) {
          try { unlinkSync(target); } catch { /* incomplete thumbnail */ }
        }
        resolve(success ? target : undefined);
      };
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
      child.once('error', () => complete(false));
      child.once('close', (code) => complete(code === 0 && existsSync(target) && statSync(target).size > 0));
    });
  }

  deleteMediaAsset(id: string): { ok: boolean; reason?: string; usages?: string[] } {
    const asset = this.persistence.getMediaAsset(id);
    if (!asset) return { ok: false, reason: '素材不存在。' };
    if (asset.origin === 'SYSTEM') return { ok: false, reason: '系统预置素材不能删除；请复制后再编辑。' };
    const usages = this.findAssetUsages(id);
    if (usages.length) return { ok: false, reason: '素材仍被场景版本引用，不能删除。', usages };
    const storagePath = this.resolveAssetPath(asset);
    if (storagePath && existsSync(storagePath)) unlinkSync(storagePath);
    this.persistence.deleteMediaAsset(id);
    this.persistence.recordEvent('MEDIA_ASSET_DELETED', { id, fileName: asset.fileName });
    return { ok: true };
  }

  private seedSystemAssets(directory: string): void {
    const seed = [
      { fileName: '罗盘 · 初版 3D 转盘.glb', kind: 'LUX3D_MODEL' as const, mimeType: 'model/gltf-binary', transparency: 'UNKNOWN' as const, file: 'meihua-auxing-compass-g1-turbo.glb' },
      { fileName: '罗盘 · 黑金八卦盘.png', kind: 'OVERLAY_IMAGE' as const, mimeType: 'image/png', transparency: 'PRESENT' as const, file: 'meihua-auxing-compass-v3.png' },
    ];
    for (const item of seed) {
      const source = join(directory, item.file);
      if (!existsSync(source)) continue;
      const bytes = readFileSync(source);
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      if (this.persistence.getMediaAssetByHash(contentHash)) continue;
      const storageKey = `${contentHash}${extname(item.file)}`;
      const storagePath = join(this.mediaDirectory, storageKey);
      if (!existsSync(storagePath)) writeFileSync(storagePath, bytes, { flag: 'wx' });
      const imageDimensions = item.mimeType === 'image/png' && bytes.length >= 26
        ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
        : {};
      this.persistence.saveMediaAsset({
        id: randomUUID(), kind: item.kind, origin: 'SYSTEM', fileName: item.fileName, mimeType: item.mimeType,
        contentHash, sizeBytes: bytes.length, storageKey, storagePath, transparency: item.transparency, createdAt: Date.now(), ...imageDimensions,
      });
    }
  }

  createPreviewSession(input: { scenario?: PreviewSession['scenario'] } = {}): PreviewSession {
    const now = Date.now();
    const preview: PreviewSession = {
      previewSessionId: randomUUID(), scenario: input.scenario ?? 'IDLE',
      profile: structuredClone(this.draftProfileVersion.profile), createdAt: now, updatedAt: now, expiresAt: now + 4 * 60 * 60_000,
    };
    this.previewSessions.set(preview.previewSessionId, preview);
    return preview;
  }

  updatePreviewSession(id: string, patch: { scenario?: PreviewSession['scenario']; profile?: SceneProfile }): PreviewSession | undefined {
    const current = this.previewSessions.get(id);
    if (!current) return undefined;
    const next = {
      ...current,
      scenario: patch.scenario ?? current.scenario,
      profile: patch.profile ? structuredClone(patch.profile) : current.profile,
      updatedAt: Date.now(),
      expiresAt: Date.now() + 4 * 60 * 60_000,
    };
    this.previewSessions.set(id, next);
    this.broadcastPreview(id);
    return next;
  }

  deletePreviewSession(id: string): boolean {
    const clients = this.previewClients.get(id);
    if (clients) for (const socket of clients) socket.close(1000, 'Preview session closed');
    this.previewClients.delete(id);
    return this.previewSessions.delete(id);
  }

  attachPreview(socket: WebSocket, id: string): boolean {
    if (!this.previewSessions.has(id)) return false;
    const clients = this.previewClients.get(id) ?? new Set<WebSocket>();
    clients.add(socket);
    this.previewClients.set(id, clients);
    this.send(socket, this.previewMessage(id));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    return true;
  }

  getPreviewSnapshot(id: string): BroadcastSnapshotV2 | undefined {
    const preview = this.previewSessions.get(id);
    if (!preview) return undefined;
    const base = this.getBroadcastSnapshotV2();
    // The workbench's default IDLE preview mirrors the real director while a
    // session is live. Only an explicitly selected test scenario substitutes
    // sample state. This keeps queue, current viewer, rankings and cue timing
    // identical to the formal OBS source while still allowing draft styling.
    const mirrorLiveDirector = this.currentSession?.status === 'LIVE' && preview.scenario === 'IDLE';
    const scenarioStage: DirectorStage = mirrorLiveDirector
      ? base.stage
      : preview.scenario === 'GIFT' ? 'QUALIFIED' : preview.scenario === 'QUEUE' ? 'IDLE' : preview.scenario;
    // A live workbench preview already uses the active director reading. Do
    // not scan and deserialize historical rows on every synthesis progress
    // update; this query used to stall the API once the production DB grew.
    const recent = mirrorLiveDirector
      ? undefined
      : this.persistence.listReadings({ limit: 30 }).find((item) => item.meihua && item.answer);
    const now = Date.now();
    const sampleReading: Reading = recent ?? {
      id: `preview-${id}`, source: 'manual', username: '示例观众', rawQuestion: '这个计划现在适合继续推进吗？',
      normalizedQuestion: '这个计划现在适合继续推进吗？', status: scenarioStage === 'SPEAKING' ? 'SPEAKING' : 'CASTING', priority: 'HIGH',
      qualification: { kind: 'COMMENT_KEYWORD', ruleId: 'preview', label: '评论关键词' }, createdAt: now,
      answer: { opening: 'PreviewViewer, your reading is ready.', speech: 'The primary pattern favors steady progress. Focus on one practical step and review the result before expanding.', keywords: ['steady progress', 'practical step'], closing: 'Use this as cultural entertainment and personal reflection.', estimatedSeconds: 12 },
      meihua: {
        primary: { name: 'Water over Thunder', upperTrigram: 'Kan', lowerTrigram: 'Zhen', lines: [1, 2, 3, 4, 5, 6].map((index) => ({ index: index as 1|2|3|4|5|6, yinYang: index % 2 ? 'YANG' as const : 'YIN' as const, moving: index === 3 })) },
        mutual: { name: 'Mountain over Fire', number: 22, upperTrigram: 'Gen', lowerTrigram: 'Li', lines: [1, 2, 3, 4, 5, 6].map((index) => ({ index: index as 1|2|3|4|5|6, yinYang: index <= 3 ? 'YIN' as const : 'YANG' as const, moving: false })) },
        changed: { name: 'Water over Wind', number: 48, upperTrigram: 'Kan', lowerTrigram: 'Xun', lines: [1, 2, 3, 4, 5, 6].map((index) => ({ index: index as 1|2|3|4|5|6, yinYang: index === 3 ? 'YIN' as const : index % 2 ? 'YANG' as const : 'YIN' as const, moving: false })) },
        movingLines: [3], interpretationFacts: ['Preview uses the same renderer as the formal OBS source.'], engineVersion: 'preview-session',
      },
    };
    const scenariosWithReading: Array<PreviewSession['scenario']> = ['SELECTED', 'CASTING', 'INTERPRETING', 'COMPOSING', 'SYNTHESIZING', 'SPEAKING', 'FINISH', 'ERROR'];
    const reading = mirrorLiveDirector
      ? base.reading
      : scenariosWithReading.includes(preview.scenario) || preview.scenario === 'GIFT' ? sampleReading : undefined;
    const speechPlan = mirrorLiveDirector
      ? base.speechPlan
      : reading?.answer ? buildSpeechPlan(reading.id, reading.answer, reading.tts?.durationMs ?? 12_000) : undefined;
    const cue: DirectorCue = {
      cueId: `preview-cue-${id}`, sessionId: `preview-${id}`, readingId: reading?.id, sequence: 1,
      stage: scenarioStage, track: 'MAIN', startsAt: now - (scenarioStage === 'SPEAKING' ? 1_500 : 0),
      revision: preview.updatedAt, payload: { preview: true, avatarAction: scenarioStage === 'SPEAKING' ? 'SPEAKING_NEUTRAL' : scenarioStage === 'CASTING' ? 'CASTING' : 'IDLE' }, createdAt: now,
    };
    const previewQueue = [
      { id: 'preview-q1', username: '有缘人甲', eventSource: 'MOCK' as const, source: 'GIFT' as const, status: 'QUEUED' as const, label: '玫瑰', giftName: '玫瑰', question: '这个计划现在适合继续推进吗？', position: 1, priority: 'HIGH' as const, speechTargetSeconds: 30, createdAt: now - 42_000 },
      { id: 'preview-waiting', username: '有缘人乙', eventSource: 'MOCK' as const, source: 'GIFT' as const, status: 'WAITING_QUESTION' as const, label: '玫瑰', giftName: '玫瑰', speechTargetSeconds: 30, createdAt: now - 12_000, expiresAt: now + 30 * 60_000 },
      { id: 'preview-q2', username: '有缘人丙', eventSource: 'MOCK' as const, source: 'LIKE' as const, status: 'QUEUED' as const, label: '点赞达到 100 次', question: '现在适合换工作吗？', position: 2, priority: 'NORMAL' as const, speechTargetSeconds: 20, createdAt: now - 25_000 },
    ];
    return {
      ...base, sequence: Math.max(base.sequence, preview.updatedAt), serverTime: now, stage: scenarioStage, activeCue: mirrorLiveDirector ? base.activeCue : cue,
      reading, speechPlan,
      queue: base.queue.length ? base.queue : preview.scenario === 'QUEUE' || preview.scenario === 'GIFT' ? [
        { readingId: 'preview-q1', username: 'NextViewer', position: 1, priority: 'HIGH' },
        { readingId: 'preview-q2', username: 'WaitingViewer', position: 2, priority: 'NORMAL' },
      ] : [],
      qualificationQueue: base.qualificationQueue.length ? base.qualificationQueue : preview.scenario === 'QUEUE' || preview.scenario === 'GIFT' ? previewQueue : [],
      sideCues: mirrorLiveDirector
        ? base.sideCues
        : preview.scenario === 'GIFT' ? [{ ...cue, cueId: `preview-gift-${id}`, track: 'GIFT', payload: { preview: true, username: 'GiftViewer', giftName: 'Rose', action: 'APPLIED_TO_QUEUE', speechTargetSeconds: 40 } }] : [],
      profileVersion: { ...this.draftProfileVersion, profile: preview.profile },
      audioUrl: mirrorLiveDirector ? base.audioUrl : undefined,
    };
  }

  private mediaEpochFor(profileVersion: SceneProfileVersion): number {
    const ids = new Set<string>();
    for (const source of Object.values(profileVersion.profile.sources)) {
      if (source.backgroundAssetId) ids.add(source.backgroundAssetId);
      if (source.decorationAssetId) ids.add(source.decorationAssetId);
    }
    for (const slot of Object.values(profileVersion.profile.avatar.slots)) if (slot.assetId) ids.add(slot.assetId);
    if (profileVersion.profile.visualAssets?.lux3dCoreAssetId) ids.add(profileVersion.profile.visualAssets.lux3dCoreAssetId);
    for (const layer of profileVersion.profile.composition?.layers ?? []) if (layer.kind === 'ASSET' && layer.assetId) ids.add(layer.assetId);
    const assetTimes = [...ids]
      .map((id) => this.persistence.getMediaAsset(id)?.createdAt ?? 0);
    return Math.max(profileVersion.publishedAt ?? profileVersion.createdAt, ...assetTimes);
  }

  getBroadcastSnapshotV2(): BroadcastSnapshotV2 {
    const queue = this.queue.list().slice(0, this.settings.queue.maxVisible).map((item, index) => ({
      readingId: item.readingId, username: item.username, position: index + 1, priority: item.priority,
    }));
    const reading = this.replay?.reading ?? (this.active ? this.getReading(this.active.readingId) : undefined);
    const sessionProfile = this.currentSession && this.currentSession.status !== 'ENDED' ? this.persistence.getSceneProfileVersion(this.currentSession.profileVersionId) : undefined;
    const presentationMode = reading?.presentationSnapshot?.mode ?? this.settings.presentation.mode;
    const presentationMedia = this.activePresentationMedia ?? this.getPresentationMedia(reading);
    const providerMedia = presentationMode === 'DIGITAL_HUMAN' ? (this.activeAvatarMedia ?? this.avatarProvider.mediaOutput()) : { kind: 'STATIC' as const };
    const profileVersion = sessionProfile ?? this.publishedProfileVersion;
    const hasMediaAssets = Object.values(profileVersion.profile.avatar.slots).some((slot) => slot.assetId);
    const sceneHash = createHash('sha256').update(JSON.stringify(profileVersion.profile)).digest('hex');
    return {
      protocolVersion: 2,
      session: this.currentSession,
      sequence: this.directorSequence,
      serverTime: Date.now(),
      stage: this.getDirectorStage(),
      activeCue: this.activeCue,
      sideCues: [...this.sideCues.values()].filter((cue) => !cue.endsAt || cue.endsAt > Date.now()),
      reading,
      speechPlan: reading?.speechPlan,
      queue,
      qualificationQueue: this.getQueueOverview(),
      giftRanking: this.currentSession ? this.persistence.getSessionGiftRanking(this.currentSession.sessionId, this.settings.engagement.obsRankingLimit) : [],
      engagementRanking: this.currentSession ? this.persistence.getSessionEngagementRanking(this.currentSession.sessionId, this.settings.engagement.obsRankingLimit) : [],
      mediaAssets: this.listMediaAssets(),
      profileVersion,
      sceneHash,
      mediaEpoch: this.mediaEpochFor(profileVersion),
      acceptingEvents: this.acceptingQuestions,
      audioUrl: reading?.tts?.audioPath,
      presentationMode,
      presentationMedia: presentationMedia?.kind !== 'STATIC' ? presentationMedia : undefined,
      avatarRuntime: presentationMode === 'AUDIO_ONLY' ? 'NONE' : presentationMode !== 'DIGITAL_HUMAN'
        ? (presentationMedia?.kind === 'VIDEO_URL' ? 'MEDIA' : 'NONE')
        : this.settings.providers.avatar.adapter === 'vtube-studio' ? 'VTUBE_STUDIO' : providerMedia.kind !== 'STATIC' ? 'PROVIDER' : hasMediaAssets ? 'MEDIA' : 'NONE',
      avatarStageMedia: presentationMode === 'DIGITAL_HUMAN' && providerMedia.kind !== 'STATIC' ? providerMedia : undefined,
      sync: structuredClone(this.syncMetrics),
      lastError: reading?.errorCode ? { code: reading.errorCode, message: reading.errorMessage ?? reading.errorCode, at: reading.completedAt ?? Date.now() } : undefined,
    };
  }

  getOverlayState(): OverlayState {
    const queue = this.queue.list().slice(0, this.settings.queue.maxVisible).map((item, index) => ({
      readingId: item.readingId,
      username: item.username,
      position: index + 1,
    }));
    const replay = this.replay;
    const current = replay?.reading ?? (this.active ? this.getReading(this.active.readingId) : undefined);
    if (!current) {
      const copy = statusCopy[this.settings.overlay.contentLanguage];
      return {
        mode: queue.length ? 'QUEUED' : 'IDLE',
        queue,
        keywords: [],
        statusText: this.acceptingQuestions ? (queue.length ? copy.queued : copy.idle) : copy.paused,
        disclaimer: this.settings.overlay.disclaimer,
        contentLanguage: this.settings.overlay.contentLanguage,
        effects: this.settings.overlay.effects,
        moduleSettings: this.settings.overlay.modules,
        giftAlert: this.giftAlert?.expiresAt && this.giftAlert.expiresAt > Date.now() ? this.giftAlert : undefined,
        updatedAt: Date.now(),
      };
    }

    const status = replay?.stage ?? current.status;
    const mode = status === 'SPEAKING' ? 'SPEAKING' : status === 'FINISH' || status === 'COMPLETED' ? 'FINISH' : 'CASTING';
    const copy = statusCopy[this.settings.overlay.contentLanguage];
    const statusText: Record<string, string> = {
      SELECTED: `${copy.selected} · @${current.username}`,
      CASTING: `${copy.casting} · @${current.username}`,
      INTERPRETING: copy.interpreting,
      COMPOSING_SPEECH: copy.composing,
      SYNTHESIZING: copy.synthesizing,
      SPEAKING: `${copy.speaking} · @${current.username}`,
      FINISH: replay ? copy.replay : copy.finish,
      COMPLETED: copy.finish,
    };
    const overlayHexagram = current.meihua?.provenance && this.settings.overlay.contentLanguage !== 'zh-CN'
      ? { ...current.meihua, provenance: { ...current.meihua.provenance, formula: 'Upper = (year branch + lunar month + lunar day) mod 8 · Lower adds hour branch mod 8 · Moving line mod 6' } }
      : current.meihua;
    return {
      mode,
      current: {
        readingId: current.id,
        username: current.username,
        question: current.normalizedQuestion ?? current.rawQuestion,
        giftName: current.gift?.giftName,
        speechTargetSeconds: current.speechTargetSeconds,
        audioPath: current.tts?.audioPath,
        answer: current.answer,
        pipeline: current.pipeline,
      },
      hexagram: overlayHexagram,
      keywords: current.answer?.keywords ?? [],
      subtitle: undefined,
      giftAlert: this.giftAlert?.expiresAt && this.giftAlert.expiresAt > Date.now() ? this.giftAlert : undefined,
      queue,
      statusText: statusText[status] ?? copy.processing,
      disclaimer: this.settings.overlay.disclaimer,
      contentLanguage: this.settings.overlay.contentLanguage,
      effects: this.settings.overlay.effects,
      moduleSettings: this.settings.overlay.modules,
      isReplay: Boolean(replay),
      updatedAt: Date.now(),
    };
  }

  getQueue(): Array<QueueItem & { question?: string; status: Reading['status']; waitingMs: number; giftName?: string; speechTargetSeconds?: number; expiresAt?: number; qualification?: Reading['qualification'] }> {
    return this.queue.list().map((item) => {
      const reading = this.getReading(item.readingId);
      return {
        ...item,
        question: reading?.normalizedQuestion ?? reading?.rawQuestion,
        status: reading?.status ?? 'QUEUED',
        waitingMs: Date.now() - item.queuedAt,
        giftName: reading?.gift?.giftName,
        speechTargetSeconds: reading?.speechTargetSeconds,
        expiresAt: reading?.expiresAt,
        qualification: reading?.qualification,
      };
    });
  }

  getQueueOverview(): QueueOverviewEntry[] {
    const now = Date.now();
    const queued: QueueOverviewEntry[] = this.getQueue().map((item, index) => ({
      id: item.readingId,
      username: item.username,
      eventSource: this.getReading(item.readingId)?.source === 'tikfinity' ? 'TIKFINITY' : this.getReading(item.readingId)?.source === 'manual' ? 'MANUAL' : 'MOCK',
      source: item.qualification?.kind ?? 'QUEUE',
      status: 'QUEUED',
      label: item.giftName ?? item.qualification?.label ?? '正式排队',
      question: item.question,
      giftName: item.giftName,
      position: index + 1,
      priority: item.priority,
      speechTargetSeconds: item.speechTargetSeconds ?? this.settings.reading.speechTargetSeconds,
      createdAt: now - item.waitingMs,
      expiresAt: item.expiresAt,
    }));
    const queuedIds = new Set(queued.map((item) => item.id));
    const waiting: QueueOverviewEntry[] = this.getPendingQualifications()
      .filter((item) => !queuedIds.has(item.id))
      .map((item) => ({
        id: item.id,
        username: item.username,
        eventSource: item.sourceEventId.startsWith('mock-') || item.sourceEventId.startsWith('linkage-') ? 'MOCK' as const : 'TIKFINITY' as const,
        source: item.kind,
        status: 'WAITING_QUESTION',
        label: item.label,
        giftName: item.kind === 'GIFT' ? item.label : undefined,
        speechTargetSeconds: item.speechTargetSeconds,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
      }));
    return [...queued, ...waiting];
  }

  private calculateOperationalDataReport(): {
    report: OperationalDataRecalculationReport;
    engagement: Array<{ userKey: string; username: string; likeCount: number; validCommentCount: number; points: number; reachedAt: number }>;
    gifts: Array<{ userKey: string; username: string; points: number; giftCount: number; reachedAt: number }>;
  } {
    const session = this.currentSession ?? this.persistence.listLiveSessions(1)[0];
    const recalculatedAt = Date.now();
    if (!session?.startedAt) {
      return {
        report: {
          canApply: false,
          applied: false,
          scanned: { liveEvents: 0, chats: 0, likes: 0, gifts: 0, readings: 0 },
          rebuilt: { queueItems: 0, pendingQualifications: 0, engagementUsers: 0, giftUsers: 0 },
          preserved: { rawEvents: 0, completedReadings: 0 },
          recalculatedAt,
          blockingReason: '没有可用于重新计算的直播场次。',
        },
        engagement: [],
        gifts: [],
      };
    }

    const range = { from: session.startedAt, to: session.endedAt ?? recalculatedAt };
    const liveEvents = this.persistence.listLiveEventInboxByRange(range.from, range.to);
    const readings = this.persistence.listReadingsForSession(session.sessionId);
    const engagementByUser = new Map<string, { userKey: string; username: string; likeCount: number; validCommentCount: number; reachedAt: number }>();
    const giftsByUser = new Map<string, { userKey: string; username: string; points: number; giftCount: number; reachedAt: number }>();

    const ensureEngagement = (identity: { userId?: string; username: string }, at: number) => {
      const userKey = viewerKey(identity);
      const current = engagementByUser.get(userKey) ?? {
        userKey,
        username: identity.username,
        likeCount: 0,
        validCommentCount: 0,
        reachedAt: at,
      };
      current.username = identity.username || current.username;
      current.reachedAt = Math.max(current.reachedAt, at);
      engagementByUser.set(userKey, current);
      return current;
    };

    for (const item of liveEvents) {
      if (item.kind !== 'like') continue;
      const event = item.payload as LiveLikeEvent;
      const target = ensureEngagement(event, event.timestamp || item.receivedAt);
      target.likeCount += Math.max(0, Math.round(event.likeCount));
    }

    const countedComments = new Set<string>();
    for (const reading of readings) {
      if (reading.source !== 'tikfinity' || reading.moderationDecision !== 'ALLOW' || reading.status === 'REJECTED') continue;
      const dedupeKey = reading.sourceEventId ?? reading.id;
      if (countedComments.has(dedupeKey)) continue;
      countedComments.add(dedupeKey);
      const target = ensureEngagement(reading, reading.createdAt);
      target.validCommentCount += 1;
    }

    if (this.settings.gifts.enabled) {
      for (const item of liveEvents) {
        if (item.kind !== 'gift') continue;
        const event = item.payload as LiveGiftEvent;
        const repeatCount = clamp(event.repeatCount, 1, 1, 9_999);
        const giftId = event.giftId?.trim().toLocaleLowerCase();
        const giftName = event.giftName.trim().toLocaleLowerCase();
        const rule = this.settings.gifts.rules.find((candidate) => {
          if (!candidate.enabled || repeatCount < candidate.minRepeatCount) return false;
          const configuredId = candidate.giftId?.trim().toLocaleLowerCase();
          if (configuredId && giftId && configuredId === giftId) return true;
          if (candidate.giftName.trim().toLocaleLowerCase() === giftName) return true;
          return !configuredId && ['任意礼物', 'any gift', 'any', '*'].includes(candidate.giftName.trim().toLocaleLowerCase());
        });
        if (!rule) continue;
        const userKey = viewerKey(event);
        const at = event.timestamp || item.receivedAt;
        const target = giftsByUser.get(userKey) ?? { userKey, username: event.username, points: 0, giftCount: 0, reachedAt: at };
        target.username = event.username || target.username;
        target.points += rule.leaderboardPoints * repeatCount;
        target.giftCount += repeatCount;
        target.reachedAt = Math.max(target.reachedAt, at);
        giftsByUser.set(userKey, target);
      }
    }

    const engagement = [...engagementByUser.values()].map((item) => ({
      ...item,
      points: Math.floor(item.likeCount / Math.max(1, this.settings.engagement.likeUnit)) * this.settings.engagement.likePoints
        + item.validCommentCount * this.settings.engagement.commentPoints,
    }));
    const gifts = [...giftsByUser.values()];
    const pendingQualifications = this.persistence.listGiftEntitlements(500).filter((item) => item.status === 'PENDING' && item.expiresAt > recalculatedAt).length
      + this.persistence.listQualificationGrants(500, 'PENDING').filter((item) => item.expiresAt > recalculatedAt).length;
    const blockingReason = this.active
      ? '当前有正在处理或播报的解卦，请等待本轮结束后再重新计算。'
      : this.replay
        ? '当前正在回放历史解卦，请先结束回放。'
        : this.processingInbox
          ? '直播事件正在写入，请稍后再试。'
          : undefined;

    return {
      report: {
        canApply: !blockingReason,
        applied: false,
        sessionId: session.sessionId,
        sessionStatus: session.status,
        range,
        scanned: {
          liveEvents: liveEvents.length,
          chats: liveEvents.filter((item) => item.kind === 'chat').length,
          likes: liveEvents.filter((item) => item.kind === 'like').length,
          gifts: liveEvents.filter((item) => item.kind === 'gift').length,
          readings: readings.length,
        },
        rebuilt: {
          queueItems: readings.filter((item) => item.status === 'QUEUED').length,
          pendingQualifications,
          engagementUsers: engagement.length,
          giftUsers: gifts.length,
        },
        preserved: {
          rawEvents: liveEvents.length,
          completedReadings: readings.filter((item) => item.status === 'COMPLETED').length,
        },
        recalculatedAt,
        blockingReason,
      },
      engagement,
      gifts,
    };
  }

  getOperationalDataRecalculationPreview(): OperationalDataRecalculationReport {
    return this.calculateOperationalDataReport().report;
  }

  recalculateOperationalData(): OperationalDataRecalculationReport {
    const calculated = this.calculateOperationalDataReport();
    if (!calculated.report.canApply || !calculated.report.sessionId) return calculated.report;

    this.persistence.replaceSessionDerivedStats({
      sessionId: calculated.report.sessionId,
      engagement: calculated.engagement,
      gifts: calculated.gifts,
    });
    this.likeTotals.clear();
    for (const item of calculated.engagement) this.likeTotals.set(item.userKey, item.likeCount);

    this.queue.clear();
    for (const reading of this.persistence.listQueued()) {
      this.readings.set(reading.id, reading);
      this.queue.enqueue({
        readingId: reading.id,
        username: reading.username,
        priority: reading.priority,
        queuedAt: reading.createdAt,
        expiresAt: reading.expiresAt,
      });
    }
    this.expireQueued();
    this.persistence.expireGiftEntitlements();
    this.persistence.expireQualificationGrants();

    const report: OperationalDataRecalculationReport = {
      ...calculated.report,
      applied: true,
      rebuilt: {
        ...calculated.report.rebuilt,
        queueItems: this.queue.size,
        pendingQualifications: this.getPendingQualifications().length,
      },
      recalculatedAt: Date.now(),
    };
    this.persistence.recordEvent('OPERATIONAL_DATA_RECALCULATED', report);
    this.persistence.runMaintenanceRecord('OPERATIONAL_DATA_RECALCULATION', report);
    this.publishSnapshot('STATE_CHANGED');
    return report;
  }

  getReading(readingId: string): Reading | undefined {
    return this.readings.get(readingId) ?? this.persistence.getReading(readingId);
  }

  getReadings(limit?: number): Reading[] {
    return this.persistence.listReadings({ limit });
  }

  getEvents(limit?: number) {
    return this.persistence.listEvents(limit);
  }

  getGiftEntitlements(options?: number | { limit?: number; from?: number; to?: number }): GiftEntitlement[] {
    this.persistence.expireGiftEntitlements();
    return this.persistence.listGiftEntitlements(options);
  }

  getPendingQualifications() {
    const now = Date.now();
    this.persistence.expireGiftEntitlements(now);
    this.persistence.expireQualificationGrants(now);
    const gifts = this.persistence.listGiftEntitlements(200)
      .filter((item) => item.status === 'PENDING' && item.expiresAt > now)
      .map((item) => ({
        id: item.id, sourceEventId: item.sourceEventId, username: item.username, kind: 'GIFT' as const, label: item.giftName,
        speechTargetSeconds: item.speechTargetSeconds, createdAt: item.createdAt, expiresAt: item.expiresAt,
      }));
    const grants = this.persistence.listQualificationGrants(200, 'PENDING')
      .filter((item) => item.expiresAt > now)
      .map((item) => ({
        id: item.id, sourceEventId: item.sourceEventId, username: item.username, kind: item.kind, label: item.label,
        speechTargetSeconds: item.speechTargetSeconds, createdAt: item.createdAt, expiresAt: item.expiresAt,
      }));
    return [...gifts, ...grants].sort((a, b) => b.createdAt - a.createdAt);
  }

  getAudioFilePath(fileName: string): string | undefined {
    const safeName = basename(fileName);
    if (!safeName || safeName !== fileName || !safeName.endsWith('.wav')) return undefined;
    return join(this.audioDirectory, safeName);
  }

  /** Public vendor-ingest asset paths. Filenames are random and never listed by the API. */
  getPublicAudioFilePath(fileName: string): string | undefined {
    const safeName = basename(fileName);
    if (!safeName || safeName !== fileName || !/^[a-zA-Z0-9._-]+\.(?:wav|mp3|m4a)$/i.test(safeName)) return undefined;
    return join(this.audioDirectory, safeName);
  }

  getPublicMediaFilePath(fileName: string): string | undefined {
    const safeName = basename(fileName);
    if (!safeName || safeName !== fileName || !/^[a-zA-Z0-9._-]+\.(?:mp4|mov|webm)$/i.test(safeName)) return undefined;
    return join(this.mediaDirectory, 'cloud-assets', safeName);
  }

  getBlockedUsers(): BlockedUser[] {
    return this.persistence.listBlockedUsers();
  }

  /** Safe, durable event history for the operator console. */
  getRecentTikfinityEvents(limit = 20) {
    const seen = new Map<string, number>();
    return this.persistence.listLiveEventInbox(undefined, Math.min(500, limit * 3)).flatMap((item) => {
      const payload = item.payload;
      const username = payload.username.trim().toLocaleLowerCase();
      const value = item.kind === 'chat' ? (payload as LiveChatEvent).message.trim().toLocaleLowerCase()
        : item.kind === 'gift' ? `${(payload as LiveGiftEvent).giftId ?? (payload as LiveGiftEvent).giftName}:${(payload as LiveGiftEvent).repeatCount ?? 1}`
          : String((payload as LiveLikeEvent).likeCount ?? 0);
      const fingerprint = `${item.kind}:${username}:${value}`;
      const previous = seen.get(fingerprint);
      if (previous !== undefined && Math.abs(previous - item.receivedAt) < 1_000) return [];
      seen.set(fingerprint, item.receivedAt);
      return [{
        id: item.id,
        kind: item.kind,
        receivedAt: item.receivedAt,
        status: item.status,
        username: payload.username,
        message: item.kind === 'chat' ? (payload as LiveChatEvent).message.slice(0, 180) : undefined,
        giftId: item.kind === 'gift' ? (payload as LiveGiftEvent).giftId : undefined,
        giftName: item.kind === 'gift' ? (payload as LiveGiftEvent).giftName : undefined,
        repeatCount: item.kind === 'gift' ? (payload as LiveGiftEvent).repeatCount : undefined,
        likeCount: item.kind === 'like' ? (payload as LiveLikeEvent).likeCount : undefined,
      }];
    }).slice(0, limit);
  }

  getCapturedGiftCatalog(limit = 200) {
    const catalog = new Map<string, { giftId?: string; giftName: string; coinValue?: number; lastSeenAt: number; count: number }>();
    for (const item of this.persistence.listLiveEventInbox(undefined, 500).filter((candidate) => candidate.kind === 'gift')) {
      const payload = item.payload as LiveGiftEvent;
      const key = payload.giftId?.trim() || payload.giftName.trim().toLocaleLowerCase();
      const existing = catalog.get(key);
      if (existing) {
        existing.count += Math.max(1, payload.repeatCount);
        if (payload.diamondCount && payload.diamondCount > 0) existing.coinValue = payload.diamondCount;
        existing.lastSeenAt = Math.max(existing.lastSeenAt, item.receivedAt);
      } else catalog.set(key, {
        giftId: payload.giftId?.trim() || undefined,
        giftName: payload.giftName.trim(),
        coinValue: payload.diamondCount && payload.diamondCount > 0 ? payload.diamondCount : undefined,
        lastSeenAt: item.receivedAt,
        count: Math.max(1, payload.repeatCount),
      });
    }
    return [...catalog.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, Math.min(Math.max(limit, 1), 200));
  }

  setAcceptingQuestions(accepting: boolean): void {
    this.acceptingQuestions = accepting;
    this.persistence.recordEvent('QUESTION_INTAKE_CHANGED', { accepting });
    this.publishSnapshot();
  }

  private commentMatches(message: string, rule: CommentRule): { matched: true; question?: string; keyword?: string } | undefined {
    const source = message.normalize('NFKC').trim();
    // 空白设置：关键词留空 = 匹配任何评论（运营口径：任何评论都算一次提问）
    if (!rule.keywords.length) return { matched: true, question: rule.stripKeyword ? source : source };
    for (const keyword of rule.keywords) {
      let matched = false;
      if (rule.matchMode === 'EXACT') matched = canonicalRecognitionText(source, /\p{Script=Latin}/u.test(keyword)) === canonicalRecognitionText(keyword, /\p{Script=Latin}/u.test(keyword));
      else if (rule.matchMode === 'CONTAINS') matched = containsRecognitionKeyword(source, keyword);
      else {
        try { matched = new RegExp(keyword, 'iu').test(source); } catch { matched = false; }
      }
      if (!matched) continue;
      if (!rule.stripKeyword) return { matched: true, question: source, keyword };
      const stripped = rule.matchMode === 'REGEX'
        ? (() => { try { return source.replace(new RegExp(keyword, 'iu'), '').trim(); } catch { return source; } })()
        : source.replace(new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'), '').replace(/^\s*[:：,，-]\s*/, '').trim();
      return { matched: true, question: stripped || undefined, keyword };
    }
    return undefined;
  }

  /**
   * A viewer has already paid/earned the right to ask. Once their comment also
   * matches an operator-configured intent keyword, accept terse topic phrases
   * such as "career", "reading" or "帮我测一下财运" as a real question.
   * Safety, advertising, empty input and maximum-length checks still win.
   */
  private resolveQualifiedKeywordQuestion(
    message: string,
    match: { matched: true; question?: string; keyword?: string } | undefined,
  ): { question: string; moderation: ReturnType<typeof moderateQuestion>; normalizedFromKeyword: boolean } {
    const original = (match?.question ?? message).normalize('NFKC').trim();
    const initial = moderateQuestion(original, this.settings.moderation);
    if (initial.decision === 'ALLOW' || !match) {
      return { question: initial.normalizedQuestion, moderation: initial, normalizedFromKeyword: false };
    }

    // Keyword matching may only relax question *shape*. It must never bypass
    // policy or turn punctuation/emoji into a divination request.
    if (!['too_short', 'not_a_clear_question'].includes(initial.reason)) {
      return { question: initial.normalizedQuestion, moderation: initial, normalizedFromKeyword: false };
    }
    const meaningful = original.replace(/[\p{P}\p{S}\s]/gu, '');
    if (!meaningful) {
      return { question: initial.normalizedQuestion, moderation: initial, normalizedFromKeyword: false };
    }

    const bareReadingIntents = new Set([
      '测算', '测一卦', '算一卦', '起卦', '占卜', '解卦', '问卦', '梅花易数', '看卦', '卦象', '卦辞',
      'reading', 'fortune reading', 'divination', 'hexagram', 'meihua', 'cast for me', 'calculate for me', 'read me', 'give me a reading', 'please read',
      'lectura', 'adivinación', 'lecture', 'deutung', 'wahrsagung', '占って', '占い', '易占', '점쳐', '운세', '괘',
      'leitura', 'adivinhação', 'гадание', 'предсказание',
    ].map((item) => canonicalRecognitionText(item, /\p{Script=Latin}/u.test(item))));
    const bareTopicIntents = new Set([
      'career', 'new job', 'business', 'money', 'finance', 'income', 'investment', 'love', 'relationship', 'marriage', 'study', 'exam', 'school', 'travel', 'project', 'decision',
      'trabajo', 'dinero', 'amor', 'relación', 'travail', 'argent', 'amour', 'relation', 'arbeit', 'geld', 'liebe', 'beziehung',
      '仕事', '転職', 'お金', '恋愛', '結婚', '직업', '이직', '돈', '연애', '결혼', 'trabalho', 'dinheiro', 'relacionamento', 'работа', 'деньги', 'любовь', 'отношения',
    ].map((item) => canonicalRecognitionText(item, /\p{Script=Latin}/u.test(item))));
    const explicitReadingRequests = /帮我(?:算|测)|请(?:测|算)|想(?:测|问)|cast\s+for\s+me|calculate\s+for\s+me|read\s+me|give\s+me\s+a\s+reading|please\s+(?:read|tell)|hazme\s+una\s+lectura|léeme|fais-moi\s+une\s+lecture|deute\s+für\s+mich|占って(?:ください)?|見てください|점쳐\s*주세요|운세\s*봐주세요|faça\s+uma\s+leitura|погадайте\s+мне/iu;
    const foldKeyword = Boolean(match.keyword && /\p{Script=Latin}/u.test(match.keyword));
    const normalizedKeyword = match.keyword ? canonicalRecognitionText(match.keyword, foldKeyword) : undefined;
    const normalizedOriginal = canonicalRecognitionText(original, foldKeyword);
    const isBareIntent = Boolean(normalizedKeyword)
      && normalizedOriginal === normalizedKeyword
      && bareReadingIntents.has(normalizedKeyword!);
    const isBareTopic = Boolean(normalizedKeyword)
      && normalizedOriginal === normalizedKeyword
      && bareTopicIntents.has(normalizedKeyword!);
    const isExplicitReadingRequest = explicitReadingRequests.test(original);

    let candidate = original;
    if (isBareIntent || (isExplicitReadingRequest && [...meaningful].length < this.settings.moderation.minChars)) {
      if (/\p{Script=Hangul}/u.test(original)) candidate = '현재 제 전반적인 운세와 가장 주의해야 할 점은 무엇인가요?';
      else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(original)) candidate = '今の全体的な運勢と、最も注意すべきことは何ですか？';
      else if (/\p{Script=Han}/u.test(original)) candidate = '请为我测算当前整体运势，以及现在最需要注意的事情？';
      else if (/\p{Script=Cyrillic}/u.test(original)) candidate = 'Что мне сейчас важнее всего учитывать в моей общей ситуации?';
      else candidate = 'What is the most important guidance for my current overall situation?';
    } else if (isBareTopic || isExplicitReadingRequest) {
      candidate = `${candidate}?`;
    } else {
      return { question: initial.normalizedQuestion, moderation: initial, normalizedFromKeyword: false };
    }

    const moderation = moderateQuestion(candidate, this.settings.moderation);
    return {
      question: moderation.normalizedQuestion,
      moderation,
      normalizedFromKeyword: moderation.decision === 'ALLOW' && moderation.normalizedQuestion !== initial.normalizedQuestion,
    };
  }

  private createCommentQualification(event: LiveChatEvent, rule: CommentRule, userKey: string): void {
    const now = Date.now();
    const existing = this.persistence.getLatestQualificationGrant(userKey, 'COMMENT_KEYWORD', rule.id, this.currentSession?.sessionId);
    if (existing?.status === 'PENDING' && existing.expiresAt > now) return;
    if (existing && now - existing.createdAt < rule.cooldownMinutes * 60_000) {
      this.persistence.recordEvent('COMMENT_QUALIFICATION_COOLDOWN', { ruleId: rule.id, username: event.username, eventId: event.eventId });
      return;
    }
    const grant: QualificationGrant = {
      id: randomUUID(), sourceEventId: event.eventId, sessionId: this.currentSession?.sessionId,
      userKey, username: event.username, kind: 'COMMENT_KEYWORD', ruleId: rule.id,
      label: rule.label, priority: rule.priority, speechTargetSeconds: rule.speechTargetSeconds,
      status: 'PENDING', createdAt: event.timestamp,
      expiresAt: event.timestamp + rule.queueExpireMinutes * 60_000,
    };
    this.persistence.saveQualificationGrant(grant);
    this.persistence.recordEvent('COMMENT_QUALIFICATION_CREATED', { grantId: grant.id, ruleId: grant.ruleId, username: event.username, expiresAt: grant.expiresAt });
  }

  /** Durable, single-file event ordering for real TikFinity input. */
  /** TikFinity 入账闸门：只有正在播出的场次入账；暂停/恢复态只保留连接诊断。 */
  private liveIntakeOpen(): boolean {
    return this.currentSession?.status === 'LIVE';
  }

  private startTikfinityInput(): void {
    if (this.closing || process.env.MEIHUA_DISABLE_TIKFINITY === '1') return;
    void this.tikfinity.start({
      onChat: async (event) => { await this.enqueueTikfinityEvent('chat', event); },
      onGift: async (event) => { await this.enqueueTikfinityEvent('gift', event); },
      onLike: async (event) => { await this.enqueueTikfinityEvent('like', event); },
    });
  }

  private async enqueueTikfinityEvent(kind: LiveEventInboxItem['kind'], event: LiveChatEvent | LiveGiftEvent | LiveLikeEvent): Promise<void> {
    const item = this.persistence.enqueueLiveEvent({ source: 'tikfinity', eventId: event.eventId, kind, payload: event });
    if (!item) {
      this.persistence.recordEvent('TIKFINITY_INBOX_DUPLICATE', { kind, eventId: event.eventId });
      return;
    }
    const intakeOpen = this.liveIntakeOpen();
    if (!intakeOpen) {
      // The operator console promises that room activity remains visible before
      // Start is pressed. Persist it, but finish it immediately so a later
      // session can never replay idle-room activity into qualifications.
      this.persistence.completeLiveEvent(item.id);
    } else {
      // Likes arrive in dense bursts. The durable inbox is already the raw
      // audit trail, so duplicating every like into app_events only amplifies
      // SQLite writes and can starve the HTTP server during a live session.
      if (kind !== 'like') this.persistence.recordEvent('TIKFINITY_INBOX_RECEIVED', { id: item.id, kind, eventId: event.eventId });
    }
    // Coalesce bursts of likes/comments.  The inbox is durable and the admin
    // console polls it, while queue changes still publish immediately from
    // their normal mutation path.
    this.scheduleLiveInboxSnapshot();
    if (intakeOpen) await this.processLiveInbox();
  }

  private scheduleLiveInboxSnapshot(): void {
    if (this.liveInboxSnapshotTimer || this.closing) return;
    this.liveInboxSnapshotTimer = setTimeout(() => {
      this.liveInboxSnapshotTimer = undefined;
      if (!this.closing) this.publishSnapshot('STATE_CHANGED');
    }, 250);
  }

  private async processLiveInbox(): Promise<void> {
    if (this.processingInbox || this.closing) return;
    this.processingInbox = true;
    let processed = 0;
    try {
      // Bound each drain. A busy TikFinity room can continuously add likes;
      // an unbounded microtask loop prevents Node from serving the admin UI,
      // static files and WebSocket heartbeats even though the process is alive.
      for (; processed < 40; processed += 1) {
        const item = this.persistence.claimNextLiveEvent();
        if (!item) break;
        try {
          if (item.kind === 'chat') await this.ingestTikfinityChat(item.payload as LiveChatEvent);
          else if (item.kind === 'gift') await this.ingestGift(item.payload as LiveGiftEvent);
          else await this.ingestLike(item.payload as LiveLikeEvent);
          this.persistence.completeLiveEvent(item.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown inbox processing error';
          this.persistence.completeLiveEvent(item.id, message);
          this.persistence.recordEvent('TIKFINITY_INBOX_FAILED', { id: item.id, kind: item.kind, message });
        }
      }
    } finally {
      this.processingInbox = false;
    }
    // Give sockets and HTTP requests a turn before taking the next batch.
    // An empty follow-up costs one indexed lookup and avoids a race with an
    // event that arrived while the previous batch was completing.
    if (processed >= 40 && !this.closing) setImmediate(() => { void this.processLiveInbox(); });
  }

  async ingestTikfinityChat(event: LiveChatEvent): Promise<Reading | undefined> {
    if (event.source === 'tikfinity' && !this.liveIntakeOpen()) {
      this.persistence.recordEvent('LIVE_EVENT_IGNORED_SESSION_NOT_LIVE', { kind: 'chat', eventId: event.eventId, sessionStatus: this.currentSession?.status });
      return undefined;
    }
    const key = viewerKey(event);
    this.persistence.expireGiftEntitlements();
    this.persistence.expireQualificationGrants();
    const pendingGift = this.persistence.findBestPendingGiftEntitlement(key);
    const pendingGrant = pendingGift ? undefined : this.persistence.findBestPendingQualificationGrant(key);
    const commentRule = this.settings.engagement.enabled
      ? this.settings.engagement.commentRules.find((rule) => rule.enabled && this.commentMatches(event.message, rule) !== undefined)
      : undefined;
    const commentMatch = commentRule ? this.commentMatches(event.message, commentRule) : undefined;

    if (pendingGift || pendingGrant) {
      const resolved = this.resolveQualifiedKeywordQuestion(event.message, commentMatch);
      const { question, moderation } = resolved;
      if (moderation.decision !== 'ALLOW') {
        this.persistence.recordEvent('QUALIFIED_VIEWER_COMMENT_NOT_A_QUESTION', {
          eventId: event.eventId, username: event.username, qualification: pendingGift ? 'GIFT' : pendingGrant?.kind,
          reason: moderation.reason, keyword: commentMatch?.keyword,
        });
        return undefined;
      }
      if (resolved.normalizedFromKeyword) {
        this.persistence.recordEvent('QUALIFIED_KEYWORD_QUESTION_NORMALIZED', {
          eventId: event.eventId,
          username: event.username,
          qualification: pendingGift ? 'GIFT' : pendingGrant?.kind,
          keyword: commentMatch?.keyword,
          originalQuestion: event.message,
          normalizedQuestion: question,
        });
      }
      const reading = await this.ingest({ ...event, message: question }, pendingGrant?.priority ?? 'NORMAL', pendingGrant ? {
        qualification: { kind: pendingGrant.kind, ruleId: pendingGrant.ruleId, label: pendingGrant.label },
        queueExpireMinutes: this.settings.queue.expireMinutes,
        speechTargetSeconds: pendingGrant.speechTargetSeconds,
        rawQuestion: event.message,
      } : { rawQuestion: event.message });
      if (pendingGrant && reading.status === 'QUEUED') {
        this.persistence.markQualificationGrantApplied(pendingGrant.id, reading.id);
        this.persistence.recordEvent('QUALIFICATION_GRANT_CLAIMED', { grantId: pendingGrant.id, kind: pendingGrant.kind }, reading.id);
      }
      if (reading.status === 'QUEUED') this.addEngagementStats(event, 0, 1);
      return reading;
    }

    if (!this.settings.engagement.enabled) {
      this.persistence.recordEvent('CHAT_IGNORED_QUALIFICATION_DISABLED', { eventId: event.eventId, username: event.username });
      return undefined;
    }

    // Comments never create entitlement. A viewer first earns a pending grant
    // through likes or a gift, then claims it with one clear question.
    const directQuestion = commentMatch?.question ?? event.message;
    const directModeration = moderateQuestion(directQuestion, this.settings.moderation);
    if (directModeration.decision === 'ALLOW') {
      this.persistence.recordEvent('QUESTION_REJECTED_NO_QUALIFICATION', {
        eventId: event.eventId, username: event.username,
        reason: 'Reach 100 likes or send the configured gift first, then ask one clear question.',
      });
      return undefined;
    }

    if (commentRule) {
      this.persistence.recordEvent('COMMENT_KEYWORD_REJECTED_NO_QUALIFICATION', {
        eventId: event.eventId, username: event.username, reason: directModeration.reason,
      });
      return undefined;
    }
    this.persistence.recordEvent('CHAT_IGNORED_NO_ELIGIBILITY', { eventId: event.eventId, username: event.username, messageLength: event.message.length });
    return undefined;
  }

  async ingestLike(event: LiveLikeEvent): Promise<{ granted: boolean; total: number; ruleId?: string }> {
    if (event.source === 'tikfinity' && !this.liveIntakeOpen()) {
      this.persistence.recordEvent('LIVE_EVENT_IGNORED_SESSION_NOT_LIVE', { kind: 'like', eventId: event.eventId, sessionStatus: this.currentSession?.status });
      return { granted: false, total: this.likeTotals.get(viewerKey(event)) ?? 0 };
    }
    if (!this.persistence.claimLiveEvent(event.source, event.eventId, 'like', event.timestamp)) {
      return { granted: false, total: this.likeTotals.get(viewerKey(event)) ?? 0 };
    }
    const key = viewerKey(event);
    const persistedTotal = this.currentSession ? this.persistence.getSessionUserLikeCount(this.currentSession.sessionId, key) : 0;
    const previous = this.likeTotals.get(key) ?? persistedTotal;
    const total = previous + Math.max(0, Math.round(event.likeCount));
    this.likeTotals.set(key, total);
    this.addEngagementStats(event, Math.max(0, Math.round(event.likeCount)), 0);
    const auditUnit = Math.max(100, this.settings.engagement.likeUnit);
    if (Math.floor(total / auditUnit) > Math.floor(previous / auditUnit)) {
      this.persistence.recordEvent('LIKE_PROGRESS_RECORDED', { eventId: event.eventId, username: event.username, increment: event.likeCount, sessionTotal: total, roomTotal: event.totalLikeCount, auditUnit });
    }
    if (!this.settings.engagement.enabled) return { granted: false, total };
    // 排队规则：点赞资格只在跨过阈值那一刻发一次；该观众已在队/测算中/冷却期内时不再叠加新资格
    const queuedUsernames = new Set(this.queue.list().map((item) => item.username.trim().toLocaleLowerCase()));
    for (const rule of this.settings.engagement.likeRules.filter((candidate) => candidate.enabled)) {
      if (Math.floor(total / rule.threshold) <= Math.floor(previous / rule.threshold)) continue;
      const latest = this.persistence.getLatestQualificationGrant(key, 'LIKE', rule.id, this.currentSession?.sessionId);
      if (latest && Date.now() - latest.createdAt < rule.cooldownMinutes * 60_000) continue;
      const normalizedUsername = event.username.trim().toLocaleLowerCase();
      if (queuedUsernames.has(normalizedUsername)) {
        this.persistence.recordEvent('LIKE_GRANT_SKIPPED_ALREADY_QUEUED', { username: event.username, total });
        continue;
      }
      const grant: QualificationGrant = {
        id: randomUUID(), sourceEventId: event.eventId, sessionId: this.currentSession?.sessionId,
        userKey: key, username: event.username, kind: 'LIKE', ruleId: rule.id, label: rule.label,
        priority: rule.priority, speechTargetSeconds: rule.speechTargetSeconds, status: 'PENDING',
        createdAt: event.timestamp, expiresAt: event.timestamp + rule.grantExpireMinutes * 60_000,
      };
      this.persistence.saveQualificationGrant(grant);
      this.persistence.recordEvent('LIKE_GRANT_CREATED', { grantId: grant.id, ruleId: rule.id, username: event.username, total, expiresAt: grant.expiresAt });
      this.startDirectorCue('QUALIFIED', undefined, {
        username: event.username,
        qualification: 'LIKE',
        message: `@${event.username}, 100 likes reached. Ask one clear question now.`,
      }, 'SYSTEM', 8_000);
      this.publishSnapshot('QUEUE_CHANGED');
      return { granted: true, total, ruleId: rule.id };
    }
    return { granted: false, total };
  }

  async ingest(event: LiveChatEvent, priority: Reading['priority'] = 'NORMAL', options: IngestOptions = {}): Promise<Reading> {
    const existing = this.persistence.getReadingBySourceEventId(event.source, event.eventId);
    if (existing) {
      this.persistence.recordEvent('DUPLICATE_SOURCE_EVENT_IGNORED', { source: event.source, eventId: event.eventId }, existing.id);
      return existing;
    }
    const reading: Reading = {
      id: randomUUID(),
      sessionId: this.currentSession?.sessionId,
      sourceEventId: event.eventId,
      source: event.source,
      username: event.username.trim() || '匿名观众',
      userId: event.userId,
      rawQuestion: options.rawQuestion ?? event.message,
      status: 'RECEIVED',
      priority,
      qualification: options.qualification ?? (event.source === 'manual' ? { kind: 'MANUAL', ruleId: 'manual', label: '后台人工加入' } : undefined),
      expiresAt: event.source === 'manual' ? undefined : event.timestamp + (options.queueExpireMinutes ?? this.settings.queue.expireMinutes) * 60_000,
      // Persist the effective duration at intake. The composer and TTS stages
      // must consume the same immutable value instead of re-reading defaults.
      speechTargetSeconds: options.speechTargetSeconds ?? this.settings.reading.speechTargetSeconds,
      createdAt: event.timestamp,
    };
    this.save(reading, 'READING_RECEIVED');
    const key = viewerKey(event);

    if (!options.bypassUserLimits && !this.acceptingQuestions) {
      return this.transition(reading.id, 'REJECTED', { moderationDecision: 'REJECT', moderationReason: 'intake_paused' });
    }
    if (!options.bypassUserLimits && this.persistence.isBlocked(key)) {
      return this.transition(reading.id, 'REJECTED', { moderationDecision: 'REJECT', moderationReason: 'blocked_user' });
    }

    const moderation = moderateQuestion(event.message, this.settings.moderation);
    if (moderation.decision !== 'ALLOW') {
      return this.transition(reading.id, 'REJECTED', {
        normalizedQuestion: moderation.normalizedQuestion,
        category: moderation.category,
        moderationDecision: moderation.decision,
        moderationReason: moderation.reason,
      });
    }

    const dedupe = queueKey(reading.username, moderation.normalizedQuestion);
    this.pruneDedupe();
    if (!options.bypassUserLimits && this.recentQuestionKeys.get(dedupe) && Date.now() - (this.recentQuestionKeys.get(dedupe) ?? 0) < this.settings.queue.dedupeWindowSeconds * 1_000) {
      return this.transition(reading.id, 'REJECTED', {
        normalizedQuestion: moderation.normalizedQuestion,
        category: moderation.category,
        moderationDecision: 'REJECT',
        moderationReason: 'duplicate_within_window',
      });
    }
    this.recentQuestionKeys.set(dedupe, Date.now());

    const userHasQueued = this.queue.list().some((item) => {
      const queuedReading = this.getReading(item.readingId);
      return queuedReading ? viewerKey({ userId: queuedReading.userId, username: queuedReading.username }) === key : false;
    });
    const activeReading = this.active ? this.getReading(this.active.readingId) : undefined;
    const userIsActive = activeReading ? viewerKey({ userId: activeReading.userId, username: activeReading.username }) === key : false;
    if (!options.bypassUserLimits && (userHasQueued || userIsActive)) {
      return this.transition(reading.id, 'REJECTED', {
        normalizedQuestion: moderation.normalizedQuestion,
        category: moderation.category,
        moderationDecision: 'REJECT',
        moderationReason: 'user_already_has_unfinished_reading',
      });
    }
    if (!options.bypassUserLimits && this.settings.queue.sameUserCooldownMinutes > 0 && this.persistence.hasCompletedSince(key, Date.now() - this.settings.queue.sameUserCooldownMinutes * 60_000)) {
      return this.transition(reading.id, 'REJECTED', {
        normalizedQuestion: moderation.normalizedQuestion,
        category: moderation.category,
        moderationDecision: 'REJECT',
        moderationReason: 'user_cooldown_active',
      });
    }

    this.persistence.expireGiftEntitlements();
    const pendingGift = options.bypassUserLimits ? undefined : this.persistence.findBestPendingGiftEntitlement(key);
    const appliedGift = pendingGift ? this.giftApplied(pendingGift) : undefined;
    let accepted = this.transition(reading.id, 'ACCEPTED', {
      normalizedQuestion: moderation.normalizedQuestion,
      category: moderation.category,
      moderationDecision: moderation.decision,
      moderationReason: moderation.reason,
      priority: appliedGift ? strongestPriority(priority, appliedGift.priority) : priority,
      gift: appliedGift,
      expiresAt: appliedGift ? undefined : reading.expiresAt,
      qualification: appliedGift ? { kind: 'GIFT', ruleId: appliedGift.ruleId, label: appliedGift.giftName } : reading.qualification,
      speechTargetSeconds: appliedGift
        ? Math.max(this.settings.reading.speechTargetSeconds, appliedGift.speechTargetSeconds)
        : options.speechTargetSeconds ?? reading.speechTargetSeconds ?? this.settings.reading.speechTargetSeconds,
    });
    this.expireQueued();
    if (this.queue.size >= this.settings.queue.maxTotal) {
      accepted = this.transition(accepted.id, 'FAILED', { errorCode: 'QUEUE_FULL', errorMessage: 'The queue is full.' });
      return this.transition(accepted.id, 'SKIPPED');
    }

    const queued = this.transition(accepted.id, 'QUEUED', { pipeline: this.createPipelineSnapshot(accepted.id, 'QUEUED') });
    this.queue.enqueue({ readingId: queued.id, username: queued.username, priority: queued.priority, queuedAt: queued.createdAt, expiresAt: queued.expiresAt });
    if (pendingGift) {
      this.persistence.markGiftEntitlementApplied(pendingGift.id, queued.id);
      this.persistence.recordEvent('GIFT_ENTITLEMENT_CLAIMED', { entitlementId: pendingGift.id, giftName: pendingGift.giftName }, queued.id);
    }
    this.publishSnapshot('QUEUE_CHANGED');
    if (this.currentSession) this.startDirectorCue('QUALIFIED', queued.id, { qualification: queued.qualification, username: queued.username }, 'SYSTEM', 1_800);
    this.ensureQueueProcessing();
    return queued;
  }

  async ingestGift(event: LiveGiftEvent): Promise<GiftIngestResult> {
    if (event.source === 'tikfinity' && !this.liveIntakeOpen()) {
      this.persistence.recordEvent('LIVE_EVENT_IGNORED_SESSION_NOT_LIVE', { kind: 'gift', eventId: event.eventId, sessionStatus: this.currentSession?.status });
      return { accepted: false, action: 'IGNORED', reason: 'session_not_live' };
    }
    const duplicate = this.persistence.getGiftEntitlementBySourceEventId(event.eventId);
    if (duplicate) {
      return {
        accepted: duplicate.status !== 'EXPIRED',
        action: duplicate.status === 'APPLIED' ? 'APPLIED_TO_QUEUE' : duplicate.status === 'PENDING' ? 'PENDING_QUESTION' : 'IGNORED',
        reason: duplicate.status === 'EXPIRED' ? 'entitlement_expired' : 'duplicate_source_event',
        entitlement: duplicate,
        readingId: duplicate.readingId,
      };
    }
    const username = event.username.trim() || '匿名观众';
    const userKey = viewerKey({ userId: event.userId, username });
    const repeatCount = clamp(event.repeatCount, 1, 1, 9_999);
    this.persistence.expireGiftEntitlements();
    this.persistence.recordEvent('GIFT_RECEIVED', {
      eventId: event.eventId,
      userKey,
      username,
      giftId: event.giftId,
      giftName: event.giftName,
      repeatCount,
      source: event.source,
    });
    if (!this.settings.gifts.enabled) return { accepted: false, action: 'IGNORED', reason: 'gifts_disabled' };

    const giftId = event.giftId?.trim().toLocaleLowerCase();
    const giftName = event.giftName.trim().toLocaleLowerCase();
    const rule = this.settings.gifts.rules.find((candidate) => {
      if (!candidate.enabled || repeatCount < candidate.minRepeatCount) return false;
      const configuredId = candidate.giftId?.trim().toLocaleLowerCase();
      const idMatched = Boolean(configuredId && giftId && configuredId === giftId);
      const nameMatched = candidate.giftName.trim().toLocaleLowerCase() === giftName;
      if (idMatched || nameMatched) return true;
      // 「任意礼物」兜底：无 giftId 且名称为占位名的规则接住一切未命中礼物
      const isCatchAll = !configuredId && ['任意礼物', 'any gift', 'any', '*'].includes(candidate.giftName.trim().toLocaleLowerCase());
      return isCatchAll;
    });
    if (!rule) {
      this.persistence.recordEvent('GIFT_IGNORED_NO_RULE', { eventId: event.eventId, giftId: event.giftId, giftName: event.giftName, repeatCount });
      return { accepted: false, action: 'IGNORED', reason: 'no_matching_rule' };
    }
    const configuredId = rule.giftId?.trim().toLocaleLowerCase();
    if (configuredId && configuredId !== giftId && rule.giftName.trim().toLocaleLowerCase() === giftName) {
      this.persistence.recordEvent('GIFT_MATCHED_BY_NAME_FALLBACK', { eventId: event.eventId, configuredId, receivedGiftId: giftId, giftName: event.giftName, ruleId: rule.id });
    }

    if (this.currentSession && this.currentSession.status !== 'ENDED') {
      this.persistence.addSessionGiftStats({
        sessionId: this.currentSession.sessionId, userKey, username,
        points: rule.leaderboardPoints * repeatCount, giftCount: repeatCount, at: event.timestamp,
      });
      this.broadcastV2('RANKING_CHANGED', {
        giftRanking: this.persistence.getSessionGiftRanking(this.currentSession.sessionId, this.settings.engagement.obsRankingLimit),
        engagementRanking: this.persistence.getSessionEngagementRanking(this.currentSession.sessionId, this.settings.engagement.obsRankingLimit),
      });
    }

    const entitlement: GiftEntitlement = {
      id: randomUUID(),
      sourceEventId: event.eventId,
      userKey,
      username,
      ruleId: rule.id,
      giftId: event.giftId?.trim() || undefined,
      giftName: rule.giftName.trim() || event.giftName.trim(),
      repeatCount,
      priority: rule.priority,
      speechTargetSeconds: rule.speechTargetSeconds,
      receivedAt: event.timestamp,
      status: 'PENDING',
      createdAt: event.timestamp,
      expiresAt: event.timestamp + this.settings.gifts.entitlementExpireMinutes * 60_000,
    };
    this.persistence.saveGiftEntitlement(entitlement);
    this.persistence.recordEvent('GIFT_ENTITLEMENT_CREATED', { entitlementId: entitlement.id, ruleId: rule.id, priority: rule.priority, speechTargetSeconds: rule.speechTargetSeconds });

    const queuedReading = this.queue.list()
      .map((item) => this.getReading(item.readingId))
      .find((reading) => reading ? viewerKey({ userId: reading.userId, username: reading.username }) === userKey : false);
    // 无论去向（PENDING / APPLIED）都推送一次快照，后台排队模块与数据栏及时同步礼物流
    this.publishSnapshot();
    if (!queuedReading) {
      this.showGiftAlert(username, entitlement.giftName, 'PENDING_QUESTION', entitlement.speechTargetSeconds);
      return { accepted: true, action: 'PENDING_QUESTION', entitlement };
    }

    const updated = this.applyGiftToQueuedReading(queuedReading, entitlement);
    this.showGiftAlert(username, entitlement.giftName, 'APPLIED_TO_QUEUE', entitlement.speechTargetSeconds);
    return { accepted: true, action: 'APPLIED_TO_QUEUE', entitlement: { ...entitlement, status: 'APPLIED', readingId: updated.id, appliedAt: Date.now() }, readingId: updated.id };
  }

  private giftApplied(entitlement: GiftEntitlement): NonNullable<Reading['gift']> {
    return {
      entitlementId: entitlement.id,
      ruleId: entitlement.ruleId,
      giftId: entitlement.giftId,
      giftName: entitlement.giftName,
      repeatCount: entitlement.repeatCount,
      priority: entitlement.priority,
      speechTargetSeconds: entitlement.speechTargetSeconds,
      receivedAt: entitlement.receivedAt,
    };
  }

  private applyGiftToQueuedReading(reading: Reading, entitlement: GiftEntitlement): Reading {
    const appliedGift = this.giftApplied(entitlement);
    const priority = strongestPriority(reading.priority, appliedGift.priority);
    const speechTargetSeconds = Math.max(reading.speechTargetSeconds ?? this.settings.reading.speechTargetSeconds, appliedGift.speechTargetSeconds);
    const updated = this.replace(reading.id, { priority, gift: appliedGift, speechTargetSeconds, expiresAt: undefined, qualification: { kind: 'GIFT', ruleId: appliedGift.ruleId, label: appliedGift.giftName } }, 'GIFT_APPLIED_TO_QUEUE');
    this.queue.setPriority(reading.id, priority);
    this.queue.setExpiresAt(reading.id, undefined);
    this.persistence.markGiftEntitlementApplied(entitlement.id, reading.id);
    this.persistence.recordEvent('GIFT_QUEUE_PROMOTED', {
      entitlementId: entitlement.id,
      giftName: entitlement.giftName,
      priority,
      speechTargetSeconds,
    }, reading.id);
    this.publishSnapshot('QUEUE_CHANGED');
    return updated;
  }

  private showGiftAlert(username: string, giftName: string, action: 'PENDING_QUESTION' | 'APPLIED_TO_QUEUE', speechTargetSeconds: number): void {
    if (this.giftAlertTimer) clearTimeout(this.giftAlertTimer);
    this.giftAlert = { username, giftName, action, speechTargetSeconds, expiresAt: Date.now() + 6_000 };
    this.startDirectorCue('QUALIFIED', undefined, { username, giftName, action, speechTargetSeconds, avatarAction: 'THANK_GIFT' }, 'GIFT', 6_000);
    this.publishSnapshot();
    this.giftAlertTimer = setTimeout(() => {
      this.giftAlert = undefined;
      this.publishSnapshot();
    }, 6_050);
  }

  private addEngagementStats(event: Pick<LiveChatEvent, 'userId' | 'username'>, likeDelta: number, validCommentDelta: number): void {
    if (!this.currentSession || this.currentSession.status === 'ENDED') return;
    this.persistence.addSessionEngagementStats({
      sessionId: this.currentSession.sessionId,
      userKey: viewerKey(event),
      username: event.username,
      likeDelta,
      validCommentDelta,
      likeUnit: this.settings.engagement.likeUnit,
      likePoints: this.settings.engagement.likePoints,
      commentPoints: this.settings.engagement.commentPoints,
    });
    this.scheduleRankingBroadcast();
  }

  private scheduleRankingBroadcast(): void {
    if (this.rankingBroadcastTimer || this.closing) return;
    this.rankingBroadcastTimer = setTimeout(() => {
      this.rankingBroadcastTimer = undefined;
      if (this.closing || !this.currentSession || this.currentSession.status === 'ENDED') return;
      this.broadcastV2('RANKING_CHANGED', {
        giftRanking: this.persistence.getSessionGiftRanking(this.currentSession.sessionId, this.settings.engagement.obsRankingLimit),
        engagementRanking: this.persistence.getSessionEngagementRanking(this.currentSession.sessionId, this.settings.engagement.obsRankingLimit),
      });
    }, 300);
  }

  resume(): { ok: boolean; reason?: string } {
    // V7.2: LLM 失败已自动回退本地模板，内容层不再阻塞开播自动处理；
    // 语音（TTS）仍是硬性门槛——没有语音就没有直播口播。
    const unavailable = this.getHealth().providers.filter((provider) => provider.status !== 'READY' && provider.id !== 'openai-compatible');
    if (unavailable.length) {
      const reason = `无法开始自动处理：${unavailable.map((provider) => provider.label).join('、')} 尚未完成配置`;
      this.persistence.recordEvent('AUTO_PROCESSING_BLOCKED', { reason });
      return { ok: false, reason };
    }
    this.stopReplay();
    this.autoProcessing = true;
    this.persistence.recordEvent('AUTO_PROCESSING_RESUMED', {});
    this.publishSnapshot();
    this.ensureQueueProcessing();
    return { ok: true };
  }

  pause(): void {
    this.autoProcessing = false;
    this.persistence.recordEvent('AUTO_PROCESSING_PAUSED', {});
    this.publishSnapshot();
  }

  skipCurrent(): boolean {
    if (!this.active) return false;
    this.active.abortReason = 'SKIP';
    this.active.controller.abort();
    return true;
  }

  retryCurrent(): boolean {
    if (!this.active) return false;
    const current = this.getReading(this.active.readingId);
    if (!current) return false;
    this.retryAfterAbort = {
      original: current,
      event: {
        source: 'manual',
        eventId: `retry-${current.id}-${Date.now()}`,
        userId: current.userId,
        username: current.username,
        message: current.normalizedQuestion ?? current.rawQuestion,
        timestamp: Date.now(),
        raw: { retryOf: current.id },
      },
    };
    return this.skipCurrent();
  }

  retryReading(readingId: string): boolean {
    if (this.active) return false;
    const current = this.getReading(readingId);
    if (!current || !['FAILED', 'FAILED_TIMEOUT'].includes(current.status)) return false;
    const retrying = this.transition(readingId, 'RETRYING', {
      errorCode: undefined,
      errorMessage: undefined,
      completedAt: undefined,
      meihua: undefined,
      answer: undefined,
      tts: undefined,
      speechPlan: undefined,
      lipSyncPlan: undefined,
      digitalHumanSnapshot: undefined,
      presentationSnapshot: undefined,
      pipeline: this.createPipelineSnapshot(readingId, 'QUEUED', current.pipeline?.attempt ?? 0),
    });
    this.queue.enqueue({ readingId, username: retrying.username, priority: retrying.priority, queuedAt: Date.now(), expiresAt: undefined });
    this.persistence.recordEvent('FAILED_READING_REQUEUED', { previousStatus: current.status }, readingId);
    this.publishSnapshot('QUEUE_CHANGED');
    if (this.autoProcessing) queueMicrotask(() => void this.pump());
    return true;
  }

  private shouldAutoRetryPipeline(reading: Reading): boolean {
    if (!['FAILED', 'FAILED_TIMEOUT'].includes(reading.status)) return false;
    if (!this.autoProcessing || this.currentSession?.status !== 'LIVE') return false;
    if ((reading.pipeline?.attempt ?? 0) >= (reading.pipeline?.maxAttempts ?? maxPipelineAttempts)) return false;
    const detail = `${reading.errorCode ?? ''} ${reading.errorMessage ?? ''}`;
    // Configuration, credentials, unsupported targets and missing models will
    // not become healthy by repeating the same request.
    return !/(AUTH|MODEL_MISSING|NOT_CONFIGURED|UNSUPPORTED|CUDA_REQUIRED|VOICE_TARGET|PARAMETER_MISSING)/i.test(detail);
  }

  private schedulePipelineRetry(reading: Reading): void {
    if (this.pipelineRetryTimers.has(reading.id)) return;
    const attempt = reading.pipeline?.attempt ?? 1;
    const delayMs = Math.min(8_000, 1_000 * 2 ** Math.max(0, attempt - 1));
    const retryAt = Date.now() + delayMs;
    this.checkpoint(reading.id, 'FAILED', {
      nextRetryAt: retryAt,
      lastError: { code: reading.errorCode ?? 'PIPELINE_ERROR', message: reading.errorMessage ?? 'Pipeline failed.', at: Date.now() },
    });
    this.persistence.recordEvent('PIPELINE_AUTO_RETRY_SCHEDULED', { attempt, retryAt, delayMs }, reading.id);
    const timer = setTimeout(() => {
      this.pipelineRetryTimers.delete(reading.id);
      if (this.closing || this.currentSession?.status !== 'LIVE' || !this.autoProcessing) return;
      if (!this.retryReading(reading.id)) this.persistence.recordEvent('PIPELINE_AUTO_RETRY_SKIPPED', { reason: 'reading_changed_or_busy' }, reading.id);
    }, delayMs);
    this.pipelineRetryTimers.set(reading.id, timer);
  }

  forceIdle(): void {
    this.pause();
    this.stopReplay();
    this.skipCurrent();
  }

  private async runSegmentedReadingSpeech(readingId: string, answer: NonNullable<Reading['answer']>, contentLanguage: AppSettings['overlay']['contentLanguage'], targetSeconds: number, controller: AbortController, avatar: AvatarProfile): Promise<void> {
    const basePreset = this.digitalHumanPresets.find((item) => item.status === 'ACTIVE') ?? createDefaultDigitalHumanPreset();
    const activeVoice = this.getActiveVoiceProfile();
    const preset: DigitalHumanPreset = {
      ...basePreset, avatarProfileId: avatar.id, voiceProfileId: activeVoice?.id ?? activeVoice?.voiceId ?? this.settings.providers.tts.voiceId,
      language: contentLanguage, speed: activeVoice?.speed ?? this.settings.providers.tts.speed,
    };
    const text = `${answer.opening} ${answer.speech} ${answer.closing}`.trim();
    const segments = splitDigitalHumanSentences(text);
    if (!segments.length) throw new Error('READING_SPEECH_EMPTY');
    const totalSpeechUnits = Math.max(1, countSpeechUnits(text, contentLanguage));
    const item: DigitalHumanBroadcastItem = {
      id: `reading-${readingId}`, source: 'READING', readingId, text, action: 'SPEAKING_NEUTRAL',
      presetSnapshot: structuredClone(preset), status: 'PREBUFFERING', renderJobIds: [],
      segmentCount: segments.length, currentSegment: 0, createdAt: Date.now(),
    };
    this.digitalHumanBroadcast.set(item.id, item);
    const schedule = (segmentText: string, index: number) => {
      const segmentTargetSeconds = Math.max(3, targetSeconds * countSpeechUnits(segmentText, contentLanguage) / totalSpeechUnits);
      const promise = this.prepareDigitalHumanSegment(item, segmentText, index, segmentTargetSeconds, controller.signal);
      void promise.catch(() => undefined);
      return promise;
    };
    let pending = schedule(segments[0], 0);
    const allowGpuPrebuffer = this.gpuRuntimeProfile.prebufferSegments > 0;
    const first = await pending;
    const firstLip = buildLipSyncPlan({ wav: readFileSync(first.prepared.audioFilePath) });
    const preliminaryPlan = buildSpeechPlan(readingId, answer, first.prepared.durationMs);
    this.replace(readingId, {
      tts: { audioPath: first.prepared.audioPublicPath ?? `/api/audio/${basename(first.prepared.audioFilePath)}`, durationMs: first.prepared.durationMs, providerId: 'segmented-prebuffer', lipSyncPlan: firstLip, analysisVersion: 'wav-amplitude-v1' },
      speechPlan: { ...preliminaryPlan, voiceProfileId: preset.voiceProfileId, contentLanguage, audioAssetId: basename(first.prepared.audioFilePath), lipSyncPlan: firstLip },
      lipSyncPlan: firstLip,
    }, 'TTS_FIRST_SEGMENT_READY');
    this.transition(readingId, 'SPEAKING');
    const speakingCue = this.startDirectorCue('SPEAKING', readingId, { avatarAction: 'SPEAKING_NEUTRAL', awaitingAudioStart: true });
    if (!speakingCue) throw new Error('Unable to start the speaking master clock.');
    const preparedSegments: PreparedDigitalHumanSegment[] = [];
    const lipPlans: ReturnType<typeof buildLipSyncPlan>[] = [];
    const renderJobIds: string[] = [];
    let totalDurationMs = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const current = index === 0 ? first : await pending;
      if (!renderJobIds.includes(current.job.id)) renderJobIds.push(current.job.id);
      const nextIndex = index + 1;
      const hasNext = nextIndex < segments.length;
      const prebuffered = hasNext && allowGpuPrebuffer;
      if (prebuffered) pending = schedule(segments[nextIndex], nextIndex);
      preparedSegments.push(current.prepared);
      const lip = buildLipSyncPlan({ wav: readFileSync(current.prepared.audioFilePath) });
      lipPlans.push(lip);
      if (current.prepared.mediaUrl || current.prepared.outputAssetId) {
        const mediaUrl = current.prepared.mediaUrl ?? `/api/media-assets/${encodeURIComponent(current.prepared.outputAssetId!)}/content`;
        this.activeAvatarMedia = { kind: current.prepared.mediaKind ?? 'VIDEO_URL', url: mediaUrl, label: avatar.name, muted: true, profileId: avatar.id, renderJobId: current.job.id, outputAssetId: current.prepared.outputAssetId, playback: 'ONCE' };
        this.publishSnapshot('STATE_CHANGED');
        if (current.prepared.outputAssetId) {
          await this.waitForAvatarMediaReady(current.job.id, controller.signal);
          await this.getMuseTalkAvatarProvider().speak(mediaUrl);
        }
      }
      this.updateAvatarRenderJob(current.job.id, { status: 'PLAYING', startedAt: Date.now() });
      this.updateDigitalHumanBroadcast(item.id, { status: 'PLAYING', renderJobIds, currentSegment: index + 1, startedAt: this.digitalHumanBroadcast.get(item.id)?.startedAt ?? Date.now() });
      await this.performAvatar(index === 0 ? 'SPEAKING_NEUTRAL' : 'SPEAKING_EMPHASIS', `${readingId}-segment-${index + 1}`);
      const result = await this.audioPlayer.play({
        filePath: current.prepared.audioFilePath, signal: controller.signal,
        onStarted: index === 0 ? (startedAt) => {
          const confirmed = this.confirmAudioMasterClock(speakingCue.cueId, 0, 'NATIVE_WINDOWS', startedAt);
          if (confirmed !== undefined) {
            const reading = this.requireReading(readingId);
            if (reading.speechPlan) this.replace(readingId, { speechPlan: { ...reading.speechPlan, startedAt: confirmed } }, 'SPEECH_STARTED');
          }
        } : undefined,
      });
      totalDurationMs += current.prepared.durationMs;
      this.syncMetrics = { ...this.syncMetrics, lastAudioEndedAt: result.endedAt };
      this.updateAvatarRenderJob(current.job.id, { status: 'FINISHED', progress: 100, finishedAt: Date.now() });
      if (hasNext) {
        if (!prebuffered) pending = schedule(segments[nextIndex], nextIndex);
        await this.performAvatar('THINKING', `${readingId}-segment-buffer`);
      }
    }
    const mergedLip = {
      ...lipPlans[0], totalDurationMs,
      visemes: lipPlans.flatMap((plan, index) => { const offset = lipPlans.slice(0, index).reduce((sum, value) => sum + value.totalDurationMs, 0); return plan.visemes.map((frame) => ({ ...frame, offsetMs: frame.offsetMs + offset })); }),
      amplitudes: lipPlans.flatMap((plan, index) => { const offset = lipPlans.slice(0, index).reduce((sum, value) => sum + value.totalDurationMs, 0); return plan.amplitudes.map((frame) => ({ ...frame, offsetMs: frame.offsetMs + offset })); }),
      createdAt: Date.now(),
    };
    const finalPlan = buildSpeechPlan(readingId, answer, totalDurationMs);
    this.replace(readingId, {
      tts: { audioPath: preparedSegments[0].audioPublicPath ?? `/api/audio/${basename(preparedSegments[0].audioFilePath)}`, durationMs: totalDurationMs, providerId: 'segmented-prebuffer', lipSyncPlan: mergedLip, analysisVersion: 'wav-amplitude-v1' },
      speechPlan: { ...finalPlan, voiceProfileId: preset.voiceProfileId, contentLanguage, audioAssetId: basename(preparedSegments[0].audioFilePath), lipSyncPlan: mergedLip, startedAt: this.requireReading(readingId).speechPlan?.startedAt, avatarActionTimeline: finalPlan.segments.map((segment) => ({ action: segment.avatarAction, offsetMs: segment.offsetMs, durationMs: segment.durationMs })) },
      lipSyncPlan: mergedLip,
      digitalHumanSnapshot: this.createDigitalHumanOutputSnapshot({
        readingId,
        preset,
        audioAssetId: basename(preparedSegments[0].audioFilePath),
        audioDurationMs: totalDurationMs,
        videoAssetId: preparedSegments.find((segment) => Boolean(segment.outputAssetId))?.outputAssetId,
        videoDurationMs: this.avatarRenderJobs.get(renderJobIds.find((id) => Boolean(this.avatarRenderJobs.get(id)?.outputAssetId)) ?? '')?.durationMs,
        presentationMode: 'DIGITAL_HUMAN',
        avatarProfileId: avatar.id,
        fallbackApplied: false,
      }),
    }, 'TTS_SEGMENTED_SPEECH_FINISHED');
    this.updateDigitalHumanBroadcast(item.id, { status: 'FINISHED', renderJobIds, finishedAt: Date.now() });
  }

  removeQueued(readingId: string): boolean {
    const item = this.queue.remove(readingId);
    if (!item) return false;
    this.transition(readingId, 'SKIPPED', { errorCode: 'REMOVED_BY_ADMIN', errorMessage: 'Removed from queue by administrator.' });
    this.publishSnapshot('QUEUE_CHANGED');
    return true;
  }

  clearQueue(): number {
    const items = this.queue.clear();
    for (const item of items) this.transition(item.readingId, 'SKIPPED', { errorCode: 'QUEUE_CLEARED', errorMessage: 'Queue cleared by administrator.' });
    this.persistence.recordEvent('QUEUE_CLEARED', { count: items.length });
    this.publishSnapshot('QUEUE_CHANGED');
    return items.length;
  }

  promote(readingId: string): boolean {
    const promoted = this.queue.promote(readingId);
    if (!promoted) return false;
    const reading = this.getReading(readingId);
    if (reading) this.save({ ...reading, priority: 'MANUAL' }, 'QUEUE_PROMOTED');
    this.publishSnapshot('QUEUE_CHANGED');
    return true;
  }

  blockUser(input: { userKey: string; username: string; reason: string }): void {
    const userKey = input.userKey.trim().toLocaleLowerCase();
    this.persistence.blockUser({ userKey, username: input.username.trim() || userKey, reason: input.reason.trim() || 'blocked_by_admin' });
    for (const item of this.queue.list()) {
      const reading = this.getReading(item.readingId);
      if (reading && viewerKey({ username: reading.username, userId: reading.userId }) === userKey) this.removeQueued(reading.id);
    }
    const active = this.active ? this.getReading(this.active.readingId) : undefined;
    if (active && viewerKey({ username: active.username, userId: active.userId }) === userKey) this.skipCurrent();
    this.persistence.recordEvent('USER_BLOCKED', { userKey, username: input.username });
  }

  unblockUser(userKey: string): boolean {
    const removed = this.persistence.unblockUser(userKey.trim().toLocaleLowerCase());
    if (removed) this.persistence.recordEvent('USER_UNBLOCKED', { userKey });
    return removed;
  }

  async replayReading(readingId: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.active) return { ok: false, reason: '当前有正在处理的任务，不能进入回放。' };
    if (this.autoProcessing) return { ok: false, reason: '请先暂停自动处理，再进入回放。' };
    const reading = this.getReading(readingId);
    if (!reading?.meihua || !reading.answer) return { ok: false, reason: '该历史任务没有完整的卦象和口播，无法回放。' };
    this.stopReplay();
    const controller = new AbortController();
    this.replay = { reading, stage: 'CASTING', controller };
    this.persistence.recordEvent('REPLAY_STARTED', {}, readingId);
    this.publishSnapshot();
    try {
      await delay(1_200, controller.signal);
      if (!this.replay) return { ok: true };
      this.replay.stage = 'INTERPRETING';
      this.publishSnapshot();
      await delay(700, controller.signal);
      if (!this.replay) return { ok: true };
      this.replay.stage = 'SPEAKING';
      this.publishSnapshot();
      await delay(reading.tts?.durationMs ?? 4_000, controller.signal);
      if (!this.replay) return { ok: true };
      this.replay.stage = 'FINISH';
      this.publishSnapshot();
      await delay(1_000, controller.signal);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof PipelineAbortedError)) throw error;
      return { ok: true };
    } finally {
      if (this.replay?.reading.id === readingId) this.replay = undefined;
      this.persistence.recordEvent('REPLAY_FINISHED', {}, readingId);
      this.publishSnapshot();
    }
  }

  stopReplay(): boolean {
    if (!this.replay) return false;
    this.replay.controller.abort();
    this.replay = undefined;
    this.publishSnapshot();
    return true;
  }

  async seedMockQuestions(): Promise<void> {
    const questions = [
      '今年适不适合换工作？', '我是否应该继续准备这次考试？', '这段关系适不适合主动沟通？', '最近适合开始新的学习计划吗？',
      '我能不能把重心放到正在准备的项目上？', '下个月适不适合和伙伴推进合作？', '现在是否适合整理自己的职业方向？',
      '我该不该先完成手头任务再做选择？', '这个阶段适不适合拓展新的能力？', '我是否应该给自己一点时间再决定？',
    ];
    for (const [index, message] of questions.entries()) {
      await this.ingest({ source: 'mock', eventId: `seed-${Date.now()}-${index}`, username: `MockUser${index + 1}`, message, timestamp: Date.now() + index, raw: { seeded: true } });
    }
  }

  attachOverlay(socket: WebSocket): void {
    this.overlayClients.add(socket);
    this.send(socket, { type: 'SNAPSHOT', payload: this.getOverlayState() });
    this.send(socket, this.createV2Message('SNAPSHOT', this.getBroadcastSnapshotV2()));
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: unknown; sourceId?: unknown };
        if (message.type !== 'SOURCE_HELLO' || typeof message.sourceId !== 'string') return;
        const source = Object.values(this.publishedProfileVersion.profile.sources).find((candidate) => candidate.sourceId === message.sourceId);
        if (!source || source.sourceId === 'full-preview' || source.sourceId === 'avatar') return;
        this.overlaySocketSources.set(socket, { sourceId: source.sourceId, connectedAt: Date.now() });
      } catch { /* Browser-source diagnostics must never interrupt the director. */ }
    });
    const detach = () => { this.overlayClients.delete(socket); this.overlaySocketSources.delete(socket); };
    socket.on('close', detach);
    socket.on('error', detach);
  }

  /**
   * Prepare the next queued reading while the current WAV is playing. The
   * reading remains QUEUED, so ordering and operator controls do not change;
   * only immutable artifacts are attached. A restart can safely reuse them.
   */
  private scheduleNextReadingPreprocess(): void {
    if (this.closing || !this.active) return;
    const next = this.queue.list()[0];
    if (!next || this.preprocessingReadings.has(next.readingId)) return;
    const reading = this.getReading(next.readingId);
    if (!reading || reading.status !== 'QUEUED' || (reading.meihua && reading.answer && reading.tts?.audioPath && reading.speechPlan)) return;
    this.preprocessingReadings.add(next.readingId);
    void this.preprocessQueuedReading(next.readingId).catch((error: unknown) => {
      this.persistence.recordEvent('NEXT_READING_PREPROCESS_FAILED', {
        message: error instanceof Error ? error.message : 'Unknown preprocessing error',
      }, next.readingId);
    }).finally(() => {
      this.preprocessingReadings.delete(next.readingId);
      if (!this.closing) this.publishSnapshot('STATE_CHANGED');
    });
  }

  private async preprocessQueuedReading(readingId: string): Promise<void> {
    let reading = this.requireReading(readingId);
    if (reading.status !== 'QUEUED') return;
    const presentationSnapshot = reading.presentationSnapshot ?? this.resolvePresentationSnapshot();
    const voiceSnapshot = reading.voiceSnapshot ?? this.resolveVoiceSelectionSnapshot();
    if (!reading.presentationSnapshot || !reading.voiceSnapshot) {
      this.replace(readingId, { presentationSnapshot, voiceSnapshot }, 'NEXT_OUTPUT_SELECTION_PRELOCKED');
    }
    reading = this.requireReading(readingId);
    const meihua = reading.meihua ?? await this.withRetry('NEXT_MEIHUA_ENGINE', readingId, () => this.meihuaEngine.cast({
      readingId,
      question: reading.normalizedQuestion ?? reading.rawQuestion,
      username: reading.username,
      receivedAt: new Date(reading.createdAt).toISOString(),
      locale: 'zh-CN',
      seedPolicy: 'NUMBER',
      userProvidedNumbers: questionSums(reading.username, reading.normalizedQuestion ?? reading.rawQuestion, reading.sourceEventId ?? readingId),
    }));
    if (this.requireReading(readingId).status !== 'QUEUED') return;
    const targetSeconds = reading.speechTargetSeconds ?? this.settings.reading.speechTargetSeconds;
    let answer = reading.answer ?? await this.withRetry('NEXT_ANSWER_COMPOSER', readingId, () => this.getAnswerComposer().compose({
      username: reading.username,
      question: reading.normalizedQuestion ?? reading.rawQuestion,
      result: meihua,
      targetSeconds,
      language: voiceSnapshot.contentLanguage,
      speechRate: voiceSnapshot.speed,
      category: reading.category,
    }));
    assertValidAnswerContent(answer);
    assertAnswerLengthTarget(answer, voiceSnapshot.contentLanguage, targetSeconds, voiceSnapshot.speed);
    answer = withAnswerLengthMetrics(answer, voiceSnapshot.contentLanguage, targetSeconds, voiceSnapshot.speed);
    if (this.requireReading(readingId).status !== 'QUEUED') return;
    const tts = reading.tts?.audioPath && existsSync(join(this.audioDirectory, basename(reading.tts.audioPath)))
      ? reading.tts
      : await this.synthesizeWithFallback(readingId, `${answer.opening}${answer.speech}${answer.closing}`, targetSeconds, voiceSnapshot);
    if (!tts.audioPath || tts.durationMs < 900) throw new Error('NEXT_TTS_AUDIO_INVALID');
    if (this.requireReading(readingId).status !== 'QUEUED') return;
    const audioFilePath = join(this.audioDirectory, basename(tts.audioPath));
    const lipSyncPlan = buildLipSyncPlan({ wav: readFileSync(audioFilePath) });
    const baseSpeechPlan = buildSpeechPlan(readingId, answer, tts.durationMs);
    const speechPlan = {
      ...baseSpeechPlan,
      voiceProfileId: voiceSnapshot.voiceProfileId ?? voiceSnapshot.voiceId,
      contentLanguage: voiceSnapshot.contentLanguage,
      audioAssetId: basename(tts.audioPath),
      lipSyncPlan,
      avatarActionTimeline: baseSpeechPlan.segments.map((segment) => ({ action: segment.avatarAction, offsetMs: segment.offsetMs, durationMs: segment.durationMs })),
    };
    this.replace(readingId, {
      meihua, answer,
      tts: { ...tts, lipSyncPlan, analysisVersion: 'wav-amplitude-v1' },
      speechPlan, lipSyncPlan,
      pipeline: this.createPipelineSnapshot(readingId, 'QUEUED', reading.pipeline?.attempt ?? 0,
        { hexagram: true, script: true, audio: true, lipSync: true, avatar: false }),
    }, 'NEXT_READING_PREPROCESSED');
    this.persistence.recordEvent('NEXT_READING_PREPROCESS_READY', {
      voiceId: voiceSnapshot.voiceId,
      language: voiceSnapshot.contentLanguage,
      audioDurationMs: tts.durationMs,
    }, readingId);
  }

  private async pump(): Promise<void> {
    if (!this.autoProcessing || this.active || this.replay) return;
    this.expireQueued();
    const candidate = this.queue.list()[0];
    if (candidate && this.preprocessingReadings.has(candidate.readingId)) {
      setTimeout(() => { if (!this.closing) void this.pump(); }, 500);
      return;
    }
    const next = this.queue.next();
    if (!next) {
      this.publishSnapshot('QUEUE_CHANGED');
      return;
    }
    const queuedReading = this.requireReading(next.readingId);
    const presentationSnapshot = queuedReading.presentationSnapshot ?? this.resolvePresentationSnapshot();
    // Capture both sides of the output pair at the same queue boundary. A
    // voice change made in the admin panel is therefore guaranteed to affect
    // the next reading, while an in-flight reading keeps its original voice.
    const voiceSnapshot = queuedReading.voiceSnapshot ?? this.resolveVoiceSelectionSnapshot();
    this.replace(next.readingId, { presentationSnapshot, voiceSnapshot }, 'OUTPUT_SELECTION_SNAPSHOT_LOCKED');
    this.activeAvatarMedia = undefined;
    this.activePresentationMedia = undefined;
    const attempt = (queuedReading.pipeline?.attempt ?? 0) + 1;
    this.replace(next.readingId, {
      pipeline: this.createPipelineSnapshot(next.readingId, 'QUEUED', attempt),
    }, 'PIPELINE_ATTEMPT_STARTED');
    const controller = new AbortController();
    this.active = { readingId: next.readingId, controller };
    this.publishSnapshot('QUEUE_CHANGED');
    await this.runPipeline(next.readingId, controller);
  }

  /** A LIVE session with a queued question must never remain idle. */
  private ensureQueueProcessing(): void {
    if (this.currentSession?.status !== 'LIVE') return;
    this.autoProcessing = true;
    queueMicrotask(() => void this.pump());
  }

  private async runPipeline(readingId: string, controller: AbortController): Promise<void> {
    const configuredDurationMs = (this.requireReading(readingId).speechTargetSeconds ?? this.settings.reading.speechTargetSeconds) * 1_000;
    // The watchdog covers the complete pipeline, not only playback. Local
    // Kokoro/MuseTalk may spend tens of seconds preparing a WAV/video before
    // the audio clock starts. Give synthesis/rendering a bounded but realistic
    // budget so a valid speaking task is not retried and replayed as a fake
    // duplicate when the audio itself is still healthy.
    const pipelineOverheadBudgetMs = Math.max(90_000, this.settings.reading.watchdogMs);
    const timeout = setTimeout(() => {
      if (this.active?.readingId === readingId) {
        this.active.abortReason = 'TIMEOUT';
        controller.abort();
      }
    }, configuredDurationMs + pipelineOverheadBudgetMs);
    try {
      const lockedPresentation = this.requireReading(readingId).presentationSnapshot ?? this.resolvePresentationSnapshot();
      let effectivePresentation = lockedPresentation;
      if ((lockedPresentation.mode === 'VIDEO_LOOP' || lockedPresentation.mode === 'VIDEO_ONCE') && !this.isReadyPresentationVideo(this.getPresentationProfile(lockedPresentation.videoProfileId))) {
        throw new Error('PRESENTATION_VIDEO_NOT_READY');
      }
      if (lockedPresentation.mode === 'DIGITAL_HUMAN' && !this.isDigitalHumanSelectionReady() && !lockedPresentation.fallbackApplied) {
        throw new Error('DIGITAL_HUMAN_NOT_READY');
      }
      this.transition(readingId, 'SELECTED');
      this.checkpoint(readingId, 'SELECTED');
      this.startDirectorCue('SELECTED', readingId, { avatarAction: 'QUESTION_RECEIVED' });
      await this.performAvatar('QUESTION_RECEIVED', readingId);
      await delay(500, controller.signal);
      this.transition(readingId, 'CASTING');
      this.checkpoint(readingId, 'CASTING');
      this.startDirectorCue('CASTING', readingId, { avatarAction: 'CASTING' });
      await this.performAvatar('CASTING', readingId);
      await delay(1_400, controller.signal);
      this.transition(readingId, 'INTERPRETING');
      this.checkpoint(readingId, 'INTERPRETING');
      this.startDirectorCue('INTERPRETING', readingId, { avatarAction: 'THINKING' });
      await this.performAvatar('THINKING', readingId);
      const interpreting = this.requireReading(readingId);
      const lockedVoice = interpreting.voiceSnapshot ?? this.resolveVoiceSelectionSnapshot();
      if (!interpreting.voiceSnapshot) this.replace(readingId, { voiceSnapshot: lockedVoice }, 'VOICE_SNAPSHOT_BACKFILLED');
      const meihua = interpreting.meihua ?? await this.withRetry('MEIHUA_ENGINE', readingId, () => this.meihuaEngine.cast({
        readingId,
        question: interpreting.normalizedQuestion ?? interpreting.rawQuestion,
        // Live readings use the standard three-number remainder method. The
        // numbers are derived from this viewer + question + source event, so
        // different questions do not collapse to one nickname-only hexagram,
        // while retries of the same reading remain deterministic.
        username: interpreting.username,
        receivedAt: new Date(interpreting.createdAt).toISOString(),
        locale: 'zh-CN',
        seedPolicy: 'NUMBER',
        userProvidedNumbers: questionSums(
          interpreting.username,
          interpreting.normalizedQuestion ?? interpreting.rawQuestion,
          interpreting.sourceEventId ?? readingId,
        ),
      }));
      if (controller.signal.aborted) throw new PipelineAbortedError();
      this.replace(readingId, { meihua }, 'MEIHUA_CAST');
      this.checkpoint(readingId, 'HEXAGRAM_READY', { artifacts: { hexagram: true } });
      this.transition(readingId, 'COMPOSING_SPEECH');
      this.checkpoint(readingId, 'COMPOSING');
      this.startDirectorCue('COMPOSING', readingId, { avatarAction: 'THINKING' });
      const composing = this.requireReading(readingId);
      const contentLanguage = lockedVoice.contentLanguage;
      const targetSeconds = composing.speechTargetSeconds ?? this.settings.reading.speechTargetSeconds;
      const llmSettings = this.settings.providers.llm;
      this.persistence.recordEvent('ANSWER_COMPOSITION_STARTED', {
        adapter: llmSettings.adapter,
        model: llmSettings.model,
        baseUrl: llmSettings.baseUrl,
        targetSeconds,
        language: contentLanguage,
      }, readingId);
      let answer = composing.answer ?? await this.withRetry('ANSWER_COMPOSER', readingId, () => this.getAnswerComposer().compose({
        username: composing.username,
        question: composing.normalizedQuestion ?? composing.rawQuestion,
        result: meihua,
        targetSeconds,
        language: contentLanguage,
        speechRate: lockedVoice.speed,
        category: composing.category,
      }));
      if (controller.signal.aborted) throw new PipelineAbortedError();
      assertValidAnswerContent(answer);
      assertNoGenericAnswerContent(answer);
      assertAnswerLengthTarget(answer, contentLanguage, targetSeconds, lockedVoice.speed);
      answer = withAnswerLengthMetrics(answer, contentLanguage, targetSeconds, lockedVoice.speed);
      this.persistence.recordEvent('ANSWER_COMPOSITION_FINISHED', {
        configuredAdapter: llmSettings.adapter,
        model: llmSettings.model,
        speechUnits: answer.speechUnits,
        targetSpeechUnits: answer.targetSpeechUnits,
        targetSeconds,
      }, readingId);
      this.replace(readingId, { answer }, 'ANSWER_COMPOSED');
      this.checkpoint(readingId, 'SCRIPT_READY', { artifacts: { hexagram: true, script: true } });
      this.transition(readingId, 'SYNTHESIZING');
      this.checkpoint(readingId, 'SYNTHESIZING', { artifacts: { hexagram: true, script: true } });
      this.startDirectorCue('SYNTHESIZING', readingId, { avatarAction: 'THINKING' });
      const segmentedAvatar = (this.settings.providers.avatar.profiles ?? []).find((profile) => profile.id === this.settings.providers.avatar.activeProfileId);
      if (lockedPresentation.mode === 'DIGITAL_HUMAN' && this.settings.providers.avatar.adapter === 'musetalk' && this.getMuseTalkAvatarProvider().getState().connected && segmentedAvatar?.provider === 'LOCAL_VIDEO' && segmentedAvatar.status === 'READY' && segmentedAvatar.preparedAvatarId && segmentedAvatar.lastError !== deferredMuseTalkPreparation) {
        this.checkpoint(readingId, 'RENDERING', { artifacts: { hexagram: true, script: true } });
        await this.runSegmentedReadingSpeech(readingId, answer, contentLanguage, targetSeconds, controller, segmentedAvatar);
        this.checkpoint(readingId, 'VOICE_READY', { artifacts: { hexagram: true, script: true, audio: true, lipSync: true, avatar: true } });
        this.checkpoint(readingId, 'SPEAKING', { artifacts: { hexagram: true, script: true, audio: true, lipSync: true, avatar: true } });
        this.transition(readingId, 'COMPLETED');
        this.checkpoint(readingId, 'FINISH', { artifacts: { hexagram: true, script: true, audio: true, lipSync: true, avatar: true } });
        this.startDirectorCue('FINISH', readingId, { avatarAction: 'FINISH' });
        await this.performAvatar('FINISH', readingId);
        await delay(900, controller.signal);
        return;
      }
      const ttsStartedAt = Date.now();
      const existingTts = this.requireReading(readingId).tts;
      let tts = existingTts?.audioPath && existsSync(join(this.audioDirectory, basename(existingTts.audioPath)))
        ? existingTts
        : undefined;
      if (tts) {
        this.persistence.recordEvent('PREPROCESSED_TTS_REUSED', { voiceId: lockedVoice.voiceId, durationMs: tts.durationMs }, readingId);
      } else {
        this.persistence.recordEvent('TTS_SYNTHESIS_STARTED', {
          voiceId: lockedVoice.voiceId,
          voiceProfileId: lockedVoice.voiceProfileId,
          targetSeconds,
        }, readingId);
        // Local CPU synthesis can be quiet for a long time. Keep the durable
        // pipeline moving so the console never looks frozen at 66%.
        let ttsProgressActive = true;
        const ttsProgressTimer = setInterval(() => {
          if (!ttsProgressActive) return;
          try {
            const current = this.getReading(readingId);
            if (current?.pipeline?.phase !== 'SYNTHESIZING') return;
            const progress = Math.min(78, 67 + Math.floor((Date.now() - ttsStartedAt) / 2_500));
            this.replace(readingId, {
              pipeline: { ...current.pipeline, progress, updatedAt: Date.now() },
            }, 'TTS_SYNTHESIS_PROGRESS');
          } catch {
            ttsProgressActive = false;
            clearInterval(ttsProgressTimer);
          }
        }, 15_000);
        tts = await this.synthesizeWithFallback(readingId, `${answer.opening}${answer.speech}${answer.closing}`, targetSeconds, lockedVoice)
          .catch((error) => {
            this.persistence.recordEvent('TTS_SYNTHESIS_FAILED', { message: error instanceof Error ? error.message : 'unknown', elapsedMs: Date.now() - ttsStartedAt }, readingId);
            throw error;
          })
          .finally(() => {
            ttsProgressActive = false;
            clearInterval(ttsProgressTimer);
          });
      }
      this.persistence.recordEvent('TTS_SYNTHESIS_FINISHED', { provider: tts.providerId, durationMs: tts.durationMs, elapsedMs: Date.now() - ttsStartedAt }, readingId);
      if (controller.signal.aborted) throw new PipelineAbortedError();
      if (!tts.audioPath || tts.durationMs < 900) throw new Error('TTS did not produce a playable WAV with a valid duration.');
      const audioFilePath = join(this.audioDirectory, basename(tts.audioPath));
      const lipSyncPlan = buildLipSyncPlan({ wav: readFileSync(audioFilePath) });
      const activeAvatar = lockedPresentation.mode === 'DIGITAL_HUMAN'
        ? (this.settings.providers.avatar.profiles ?? []).find((profile) => profile.id === lockedPresentation.avatarProfileId)
        : undefined;
      const baseSpeechPlan = buildSpeechPlan(readingId, answer, tts.durationMs);
      // Built-in voices (for example Kokoro af_heart) do not have a cloned
      // profile row. Still lock their concrete voice id into the reading so
      // the audio bus and the audit snapshot cannot become ambiguous.
      const selectedVoiceProfileId = lockedVoice.voiceProfileId ?? lockedVoice.voiceId;
      const speechPlan = {
        ...baseSpeechPlan,
        voiceProfileId: selectedVoiceProfileId,
        contentLanguage,
        audioAssetId: basename(tts.audioPath),
        lipSyncPlan,
        avatarActionTimeline: baseSpeechPlan.segments.map((segment) => ({
          action: segment.avatarAction,
          offsetMs: segment.offsetMs,
          durationMs: segment.durationMs,
        })),
      };
      this.replace(readingId, { tts: { ...tts, lipSyncPlan, analysisVersion: 'wav-amplitude-v1' }, speechPlan, lipSyncPlan }, 'TTS_AUDIO_READY');
      this.checkpoint(readingId, 'VOICE_READY', { artifacts: { hexagram: true, script: true, audio: true, lipSync: true } });
      // MuseTalk segment mode: render the lip-synced video while the speaking
      // cue is still waiting for the audio clock; failures never block audio.
      const museTalk = lockedPresentation.mode === 'DIGITAL_HUMAN' && this.settings.providers.avatar.adapter === 'musetalk' ? this.getMuseTalkAvatarProvider() : undefined;
      const cloudAvatar = activeAvatar?.provider === 'ALIYUN_CLOUD' || activeAvatar?.provider === 'BAIDU_CLOUD'
        ? this.getCloudAvatarProvider(activeAvatar.provider === 'ALIYUN_CLOUD' ? 'aliyun' : 'baidu')
        : undefined;
      let museTalkMediaUrl: string | undefined;
      let cloudAvatarMediaUrl: string | undefined;
      let cloudAvatarRtc = false;
      let renderedVideoAssetId: string | undefined;
      let renderedVideoDurationMs: number | undefined;
      if (lockedPresentation.mode === 'VIDEO_LOOP' || lockedPresentation.mode === 'VIDEO_ONCE') {
        this.activePresentationMedia = this.getPresentationMedia(this.requireReading(readingId));
        this.activeAvatarMedia = undefined;
        this.publishSnapshot('STATE_CHANGED');
      } else if (lockedPresentation.mode === 'AUDIO_ONLY') {
        this.activePresentationMedia = undefined;
        this.activeAvatarMedia = undefined;
        this.publishSnapshot('STATE_CHANGED');
      }
      this.checkpoint(readingId, 'RENDERING', { artifacts: { hexagram: true, script: true, audio: true, lipSync: true } });
      if (museTalk) {
        try {
          if (!tts.audioPath) throw new Error('TTS_AUDIO_PATH_MISSING');
          const ttsAudioFilePath = join(this.audioDirectory, basename(tts.audioPath));
          const rendered = await this.runGpuTask('AVATAR_RENDER', () => museTalk.render(ttsAudioFilePath, readingId, activeAvatar?.preparedAvatarId ?? 'default'));
          renderedVideoDurationMs = rendered.durationMs;
          const asset = this.importGeneratedAvatarVideo(rendered.videoPath, `reading-${readingId}`);
          renderedVideoAssetId = asset.id;
          museTalkMediaUrl = `/api/media-assets/${encodeURIComponent(asset.id)}/content`;
          this.activeAvatarMedia = { kind: 'VIDEO_URL', url: museTalkMediaUrl, label: activeAvatar?.name ?? 'MuseTalk 本地视频数字人', muted: true, profileId: activeAvatar?.id, renderJobId: rendered.jobId, outputAssetId: asset.id, playback: 'ONCE' };
          this.publishSnapshot('STATE_CHANGED');
          await this.waitForAvatarMediaReady(rendered.jobId, controller.signal);
        } catch (error) {
          this.persistence.recordEvent('AVATAR_RENDER_FAILED', { message: error instanceof Error ? error.message : 'unknown' }, readingId);
        }
      }
      if (cloudAvatar && (activeAvatar?.cloudFigureId || activeAvatar?.preparedAvatarId)) {
        try {
           const rendered = await this.runGpuTask('AVATAR_RENDER', () => cloudAvatar.render(audioFilePath, readingId, activeAvatar.cloudFigureId ?? activeAvatar.preparedAvatarId!, `${answer.opening}${answer.speech}${answer.closing}`));
           cloudAvatar.setMediaUrl(rendered.streamUrl, rendered.rtc);
           cloudAvatarMediaUrl = rendered.streamUrl;
           cloudAvatarRtc = Boolean(rendered.rtc);
           this.activeAvatarMedia = { kind: rendered.rtc ? 'WEBRTC' : 'VIDEO_URL', url: rendered.streamUrl, rtc: rendered.rtc, label: activeAvatar.name, muted: true, profileId: activeAvatar.id, renderJobId: rendered.jobId, playback: 'ONCE' };
           this.publishSnapshot('STATE_CHANGED');
        } catch (error) {
          this.persistence.recordEvent('CLOUD_AVATAR_RENDER_FAILED', { provider: activeAvatar.provider, message: error instanceof Error ? error.message : 'unknown' }, readingId);
        }
      }
      const renderMissing = activeAvatar?.provider === 'LOCAL_VIDEO' && !museTalkMediaUrl
        ? 'DIGITAL_HUMAN_VIDEO_OUTPUT_MISSING'
        : (activeAvatar?.provider === 'ALIYUN_CLOUD' || activeAvatar?.provider === 'BAIDU_CLOUD') && !cloudAvatarMediaUrl && !cloudAvatarRtc
          ? 'DIGITAL_HUMAN_CLOUD_OUTPUT_MISSING'
          : undefined;
      if (renderMissing) {
        const fallback = this.getPresentationProfile(this.settings.presentation.fallbackVideoProfileId);
        if (this.settings.presentation.fallbackPolicy === 'VIDEO' && this.isReadyPresentationVideo(fallback)) {
          effectivePresentation = { mode: this.presentationModeForVideo(fallback!), videoProfileId: fallback!.id, avatarProfileId: lockedPresentation.avatarProfileId, fallbackApplied: true, fallbackReason: renderMissing, selectedAt: lockedPresentation.selectedAt };
          this.replace(readingId, { presentationSnapshot: effectivePresentation }, 'DIGITAL_HUMAN_FALLBACK_TO_VIDEO');
          this.activeAvatarMedia = undefined;
          this.activePresentationMedia = this.getPresentationMedia(this.requireReading(readingId));
          this.publishSnapshot('STATE_CHANGED');
        } else if (this.settings.presentation.fallbackPolicy === 'AUDIO_ONLY') {
          effectivePresentation = { mode: 'AUDIO_ONLY', avatarProfileId: lockedPresentation.avatarProfileId, fallbackApplied: true, fallbackReason: renderMissing, selectedAt: lockedPresentation.selectedAt };
          this.replace(readingId, { presentationSnapshot: effectivePresentation }, 'DIGITAL_HUMAN_FALLBACK_TO_AUDIO');
          this.activeAvatarMedia = undefined;
          this.activePresentationMedia = undefined;
          this.publishSnapshot('STATE_CHANGED');
        } else {
          throw new Error(renderMissing);
        }
      }
      const outputSnapshot: DigitalHumanOutputSnapshot = this.createDigitalHumanOutputSnapshot({
        readingId,
        preset: {
          ...(this.digitalHumanPresets.find((item) => item.status === 'ACTIVE') ?? createDefaultDigitalHumanPreset()),
          voiceProfileId: selectedVoiceProfileId,
        },
        audioAssetId: basename(tts.audioPath),
        audioDurationMs: tts.durationMs,
        avatarProfileId: activeAvatar?.id,
        videoAssetId: renderedVideoAssetId ?? this.activePresentationMedia?.outputAssetId,
        videoDurationMs: renderedVideoDurationMs ?? (this.getPresentationProfile(effectivePresentation.videoProfileId)?.durationMs),
        presentationMode: effectivePresentation.mode,
        videoProfileId: effectivePresentation.videoProfileId,
        fallbackApplied: effectivePresentation.fallbackApplied,
      });
      this.replace(readingId, { digitalHumanSnapshot: outputSnapshot }, 'DIGITAL_HUMAN_OUTPUT_SNAPSHOT_CREATED');
      this.checkpoint(readingId, 'SPEAKING', { artifacts: { hexagram: true, script: true, audio: true, lipSync: true, avatar: true } });
      this.transition(readingId, 'SPEAKING');
      const speakingCue = this.startDirectorCue('SPEAKING', readingId, {
        avatarAction: 'SPEAKING_NEUTRAL', awaitingAudioStart: true,
      });
      if (!speakingCue) throw new Error('Unable to start the speaking master clock.');
      await this.performAvatar('SPEAKING_NEUTRAL', readingId);
      // The current WAV is ready and playback is about to begin. Use that
      // speaking window to prepare the next queue entry off the critical path.
      this.scheduleNextReadingPreprocess();
      try {
        const result = await this.audioPlayer.play({
          filePath: join(this.audioDirectory, basename(tts.audioPath)),
          signal: controller.signal,
          onStarted: (startedAt) => {
            const confirmed = this.confirmAudioMasterClock(speakingCue.cueId, 0, 'NATIVE_WINDOWS', startedAt);
            if (confirmed !== undefined) {
              const current = this.requireReading(readingId);
              if (current.speechPlan) this.replace(readingId, { speechPlan: { ...current.speechPlan, startedAt: confirmed } }, 'SPEECH_STARTED');
              this.syncMetrics = { ...this.syncMetrics, lastAudioStartedAt: confirmed, lastFailure: undefined };
              this.persistence.recordSyncMetric('NATIVE_AUDIO_PLAY_STARTED', { cueId: speakingCue.cueId, startedAt: confirmed }, this.currentSession?.sessionId);
            }
            // The rendered lips start exactly when the audio master clock starts.
            if (museTalk && museTalkMediaUrl) {
              void museTalk.speak(museTalkMediaUrl).catch((error: unknown) => {
                this.persistence.recordEvent('AVATAR_PLAY_FAILED', { message: error instanceof Error ? error.message : 'unknown' }, readingId);
              });
            }
          },
        });
        this.syncMetrics = { ...this.syncMetrics, lastAudioEndedAt: result.endedAt };
        this.persistence.recordSyncMetric('NATIVE_AUDIO_PLAY_ENDED', { cueId: speakingCue.cueId, ...result }, this.currentSession?.sessionId);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new PipelineAbortedError();
        throw new AudioPlaybackError('NATIVE_AUDIO_PLAY_FAILED', error instanceof Error ? error.message : 'Windows native audio playback failed.');
      }
      this.transition(readingId, 'COMPLETED');
      this.checkpoint(readingId, 'FINISH', { artifacts: { hexagram: true, script: true, audio: true, lipSync: true, avatar: true } });
      this.startDirectorCue('FINISH', readingId, { avatarAction: 'FINISH' });
      await this.performAvatar('FINISH', readingId);
      // A quiet internal handoff prevents two viewers from sounding joined
      // together. No visible countdown is emitted.
      await delay(this.queue.size > 0 ? 3_000 : 900, controller.signal);
    } catch (error) {
      const current = this.getReading(readingId);
      if (!this.closing && current && !isTerminal(current.status)) {
        if (error instanceof AudioPlaybackError) {
          this.startDirectorCue('ERROR', readingId, { avatarAction: 'ERROR_RECOVER', message: error.message, code: error.code });
          this.transition(readingId, 'FAILED', { errorCode: error.code, errorMessage: error.message,
            speechPlan: current.speechPlan ? { ...current.speechPlan, failureReason: error.message } : undefined });
          this.checkpoint(readingId, 'FAILED', { lastError: { code: error.code, message: error.message, at: Date.now() } });
          await this.performAvatar('ERROR_RECOVER', readingId);
        } else if (error instanceof PipelineAbortedError) {
          if (this.active?.abortReason === 'TIMEOUT') {
            this.transition(readingId, 'FAILED_TIMEOUT', { errorCode: 'WATCHDOG_TIMEOUT', errorMessage: 'The reading exceeded the configured watchdog limit.' });
            this.checkpoint(readingId, 'FAILED', { lastError: { code: 'WATCHDOG_TIMEOUT', message: 'The reading exceeded the configured watchdog limit.', at: Date.now() } });
          } else {
            this.transition(readingId, 'ABORTED', { errorCode: 'ABORTED_BY_ADMIN', errorMessage: 'The reading was stopped by an administrator.' });
          }
        } else if (current.status === 'QUEUED' || isProcessing(current.status)) {
          const message = error instanceof Error ? error.message : 'Unknown pipeline error';
          this.startDirectorCue('ERROR', readingId, { avatarAction: 'ERROR_RECOVER', message });
          this.transition(readingId, 'FAILED', { errorCode: 'PIPELINE_ERROR', errorMessage: message,
            speechPlan: current.speechPlan ? { ...current.speechPlan, failureReason: message } : undefined });
          this.checkpoint(readingId, 'FAILED', { lastError: { code: 'PIPELINE_ERROR', message, at: Date.now() } });
          await this.performAvatar('ERROR_RECOVER', readingId);
        }
      }
    } finally {
      clearTimeout(timeout);
      if (this.active?.readingId === readingId) this.active = undefined;
      const retry = this.retryAfterAbort;
      this.retryAfterAbort = undefined;
      const failedReading = this.getReading(readingId);
      if (!this.closing && failedReading && this.shouldAutoRetryPipeline(failedReading)) this.schedulePipelineRetry(failedReading);
      if (!this.closing) {
        this.publishSnapshot('STATE_CHANGED');
        if (this.currentSession?.status === 'ENDING') this.finalizeSession('NORMAL_END');
        else if (this.currentSession?.status === 'LIVE') this.startDirectorCue('IDLE', undefined, { statusText: '等待下一位符合资格的观众', avatarAction: 'IDLE' });
      }
      if (retry && !this.closing) {
        const queuedRetry = await this.ingest(retry.event, retry.original.priority, { bypassUserLimits: true });
        if (retry.original.gift || retry.original.speechTargetSeconds) {
          this.replace(queuedRetry.id, { gift: retry.original.gift, speechTargetSeconds: retry.original.speechTargetSeconds, priority: retry.original.priority }, 'RETRY_READING_CONTEXT_RESTORED');
          this.queue.setPriority(queuedRetry.id, retry.original.priority);
          this.publishSnapshot('QUEUE_CHANGED');
        }
      }
      if (this.autoProcessing) queueMicrotask(() => void this.pump());
    }
  }

  private async synthesizeWithFallback(readingId: string, text: string, targetSeconds: number, voiceSnapshot?: VoiceSelectionSnapshot) {
    const selection = voiceSnapshot ?? this.resolveVoiceSelectionSnapshot();
    const adapter = this.getTtsAdapter();
    const input = {
      readingId, text, voiceId: selection.voiceId,
      speed: selection.speed, locale: selection.contentLanguage,
      targetLocale: selection.targetLocale, targetCountry: selection.targetCountry,
      accentProfileId: selection.accentProfileId, sourceLanguage: selection.sourceLanguage, targetSeconds,
    };
    const synthesize = () => this.runGpuTask('VOICE_SYNTHESIS', () => adapter.synthesize(input));
    // A timed-out HTTP request does not stop the native ONNX inference that is
    // already running in Kokoro. Retrying immediately therefore stacks the
    // same 30-second script behind itself and makes the UI appear frozen for
    // many minutes. Kokoro gets one bounded attempt; the pipeline-level retry
    // remains available after the service has genuinely failed.
    const first = adapter.id === 'kokoro-tts'
      ? await synthesize()
      : await this.withRetry('TTS_PRIMARY', readingId, synthesize);
    const targetMs = Math.max(3_000, targetSeconds * 1_000);
    // Production acceptance allows a natural-speech window of ±15%.
    // Tighter limits make local engines chase tiny cadence differences and
    // can reject otherwise valid narration after all correction attempts.
    const toleranceMs = Math.max(1_200, targetMs * 0.15);
    let best = first;
    let requestedSpeed = input.speed;
    const firstErrorMs = first.durationMs - targetMs;
    const withDurationQuality = (result: typeof first, speed: number) => ({
      ...result,
      quality: {
        ...result.quality,
        targetSeconds,
        actualDurationMs: result.durationMs,
        durationErrorMs: result.durationMs - targetMs,
        durationTargetMet: Math.abs(result.durationMs - targetMs) <= toleranceMs,
        speed,
      },
    });
    if (Math.abs(firstErrorMs) <= toleranceMs) {
      this.persistence.recordSyncMetric('TTS_DURATION_MEASURED', { readingId, targetMs, actualMs: first.durationMs, errorMs: firstErrorMs, speed: input.speed, targetMet: true }, this.currentSession?.sessionId);
      return withDurationQuality(first, input.speed);
    }

    // Kokoro ONNX inference is the expensive operation. Correct its finished
    // WAV with a local tempo pass instead of synthesizing the same narration
    // up to two more times. This keeps the requested duration contract without
    // freezing the workbench for several minutes on CPU-only machines.
    if (adapter.id === 'kokoro-tts') {
      if (!first.audioPath) throw new Error('KOKORO_OUTPUT_PATH_MISSING');
      const audioPath = join(this.audioDirectory, basename(first.audioPath));
      const correctedDurationMs = retimeLocalWav(audioPath, targetMs);
      if (!correctedDurationMs || Math.abs(correctedDurationMs - targetMs) > toleranceMs) {
        throw new Error(`TTS_DURATION_TARGET_NOT_MET:${correctedDurationMs ?? first.durationMs}:${targetMs}`);
      }
      const corrected = { ...first, durationMs: correctedDurationMs };
      this.persistence.recordSyncMetric('TTS_DURATION_CORRECTED', {
        readingId, targetMs, correction: 'LOCAL_WAV_TEMPO', previousDurationMs: first.durationMs,
        correctedDurationMs, previousSpeed: input.speed, correctedSpeed: input.speed,
        errorMs: correctedDurationMs - targetMs, targetMet: true,
      }, this.currentSession?.sessionId);
      return withDurationQuality(corrected, input.speed);
    }

    // Every supported TTS adapter receives speed. Previously only the
    // OpenAI-compatible adapter entered this loop, so Windows/GPT-SoVITS and
    // the local accent engine could return a 7-second WAV for a 30-second
    // entitlement and still be marked usable.
    for (let correction = 0; correction < 2; correction += 1) {
      const currentErrorMs = best.durationMs - targetMs;
      if (Math.abs(currentErrorMs) <= toleranceMs) break;
      const minimumSpeed = best.providerId?.includes('gptsovits') ? 0.6 : 0.25;
      const maximumSpeed = best.providerId?.includes('gptsovits') ? 1.6 : 4;
      const correctedSpeed = clampFloat(requestedSpeed * best.durationMs / targetMs, requestedSpeed, minimumSpeed, maximumSpeed);
      if (Math.abs(correctedSpeed - requestedSpeed) < 0.03) break;
      const corrected = await this.withRetry('TTS_DURATION_CORRECTION', readingId, () => this.runGpuTask('VOICE_SYNTHESIS', () => adapter.synthesize({
        ...input, speed: correctedSpeed, targetSeconds,
      })));
      const correctedErrorMs = corrected.durationMs - targetMs;
      this.persistence.recordSyncMetric('TTS_DURATION_CORRECTED', {
        readingId, targetMs, correction: correction + 1, previousDurationMs: best.durationMs,
        correctedDurationMs: corrected.durationMs, previousSpeed: requestedSpeed,
        correctedSpeed, errorMs: correctedErrorMs, targetMet: Math.abs(correctedErrorMs) <= toleranceMs,
      }, this.currentSession?.sessionId);
      requestedSpeed = correctedSpeed;
      if (Math.abs(correctedErrorMs) >= Math.abs(best.durationMs - targetMs)) break;
      best = corrected;
    }
    this.persistence.recordSyncMetric('TTS_DURATION_MEASURED', {
      readingId, targetMs, actualMs: best.durationMs, errorMs: best.durationMs - targetMs,
      speed: requestedSpeed, targetMet: Math.abs(best.durationMs - targetMs) <= toleranceMs,
    }, this.currentSession?.sessionId);
    if (Math.abs(best.durationMs - targetMs) > toleranceMs) {
      throw new Error(`TTS_DURATION_TARGET_NOT_MET:${best.durationMs}:${targetMs}`);
    }
    return withDurationQuality(best, requestedSpeed);
  }

  private async withRetry<T>(type: string, readingId: string, action: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.settings.reading.externalRetryCount; attempt++) {
      try {
        if (attempt > 0) this.persistence.recordEvent('EXTERNAL_RETRY', { type, attempt }, readingId);
        return await action();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async performAvatar(action: AvatarAction, readingId: string): Promise<void> {
    try {
      const vtube = this.settings.providers.avatar.adapter === 'vtube-studio';
      if (vtube) await this.vtube.perform(action, { readingId });
      else await this.avatarProvider.perform(action, { readingId });
      this.persistence.recordEvent('AVATAR_ACTION', { action }, readingId);
    } catch (error) {
      this.persistence.recordEvent('AVATAR_ACTION_FAILED', { action, message: error instanceof Error ? error.message : 'unknown' }, readingId);
      // Both adapters must return to IDLE after a failed action; the reading
      // audio remains authoritative either way.
      if (action !== 'IDLE') {
        const vtube = this.settings.providers.avatar.adapter === 'vtube-studio';
        try { await (vtube ? this.vtube.perform('IDLE', { readingId }) : this.avatarProvider.perform('IDLE', { readingId })); } catch { /* The reading audio remains authoritative. */ }
      }
    }
  }

  private expireQueued(): void {
    const cutoff = Date.now() - this.settings.queue.expireMinutes * 60_000;
    for (const item of this.queue.list()) {
      const reading = this.getReading(item.readingId);
      if (reading?.gift || reading?.qualification?.kind === 'GIFT' || reading?.qualification?.kind === 'MANUAL') continue;
      if ((reading?.expiresAt ?? item.expiresAt ?? 0) <= Date.now() || (!reading?.expiresAt && item.queuedAt < cutoff)) {
        this.queue.remove(item.readingId);
        this.transition(item.readingId, 'SKIPPED', { errorCode: 'QUEUE_EXPIRED', errorMessage: 'Queue wait time exceeded the configured limit.' });
      }
    }
  }

  private confirmAudioMasterClock(cueId: string, positionMs: number, source = 'LEGACY_BROWSER_SOURCE', observedAt = Date.now()): number | undefined {
    const cue = this.activeCue;
    if (!cue || cue.cueId !== cueId || cue.stage !== 'SPEAKING') return undefined;
    if (cue.payload.awaitingAudioStart !== true) return cue.startsAt;
    const startsAt = observedAt - Math.max(0, Math.round(positionMs));
    const updated: DirectorCue = {
      ...cue,
      startsAt,
      revision: cue.revision + 1,
      payload: { ...cue.payload, awaitingAudioStart: false, audioClockSource: source, audioStartedAt: startsAt },
    };
    this.activeCue = updated;
    this.persistence.saveDirectorCue(updated);
    this.persistence.recordEvent('AUDIO_MASTER_CLOCK_STARTED', { cueId, startsAt, source, positionMs }, cue.readingId);
    this.broadcastV2('CUE_UPDATED', updated);
    this.publishSnapshot();
    this.audioStartWaiters.get(cueId)?.resolve(startsAt);
    this.audioStartWaiters.delete(cueId);
    return startsAt;
  }

  private waitForAudioMasterClock(cueId: string, signal: AbortSignal): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (startsAt: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        resolve(startsAt);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.audioStartWaiters.delete(cueId);
        reject(new PipelineAbortedError());
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.audioStartWaiters.delete(cueId);
        reject(new AudioPlaybackError('AUDIO_PLAY_START_TIMEOUT', 'The unique audio source did not confirm PLAY_STARTED. Speaking was not simulated.'));
      }, 5_000);
      this.audioStartWaiters.set(cueId, { resolve: finish, reject: (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        reject(error);
      } });
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private waitForAudioEnd(cueId: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (this.audioEndedBeforeWait.delete(cueId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        reject(error);
      };
      const abort = () => fail(new PipelineAbortedError());
      const timeout = setTimeout(() => fail(new AudioPlaybackError('AUDIO_PLAY_END_TIMEOUT', 'Audio never reported PLAY_ENDED; the reading was stopped to protect synchronization.')), Math.max(2_000, timeoutMs));
      this.audioEndWaiters.set(cueId, { resolve: finish, reject: fail });
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private countLiveAudioSources(now = Date.now()): number {
    let count = 0;
    for (const [id, heartbeat] of this.audioSourceHeartbeats) {
      if (heartbeat >= now - 3_500) count++;
      else this.audioSourceHeartbeats.delete(id);
    }
    return count;
  }

  private sweepAudioLease(now = Date.now()): void {
    const activeCount = this.countLiveAudioSources(now);
    this.syncMetrics = { ...this.syncMetrics, activeAudioSources: activeCount };
    if (!this.activeAudioLease || this.activeAudioLease.expiresAt > now) return;
    const expired = this.activeAudioLease;
    this.activeAudioLease = undefined;
    this.syncMetrics = { ...this.syncMetrics, activeLease: undefined, activeAudioSources: activeCount };
    this.persistence.recordSyncMetric('AUDIO_SOURCE_LEASE_EXPIRED', expired, this.currentSession?.sessionId);
    this.persistence.recordSyncMetric('LEGACY_AUDIO_SOURCE_LEASE_EXPIRED', expired, this.currentSession?.sessionId);
  }

  private failAudioPlayback(code: string, message: string): void {
    const now = Date.now();
    this.syncMetrics = { ...this.syncMetrics, lastFailure: { code, message, at: now } };
    const cueId = this.activeCue?.stage === 'SPEAKING' ? this.activeCue.cueId : undefined;
    if (cueId) {
      this.audioStartWaiters.get(cueId)?.reject(new AudioPlaybackError(code, message));
      this.audioStartWaiters.delete(cueId);
      this.audioEndWaiters.get(cueId)?.reject(new AudioPlaybackError(code, message));
      this.audioEndWaiters.delete(cueId);
    }
    if (this.active?.controller && this.active.abortReason !== 'SKIP' && this.active.abortReason !== 'TIMEOUT') {
      this.active.abortReason = 'AUDIO_FAILED';
      // The waiters reject first; abort ensures no subsequent visual stage can continue.
      this.active.controller.abort();
    }
    this.persistence.recordSyncMetric('AUDIO_FAILURE', { code, message }, this.currentSession?.sessionId);
    this.publishSnapshot();
  }

  private pruneDedupe(): void {
    const cutoff = Date.now() - this.settings.queue.dedupeWindowSeconds * 1_000;
    for (const [key, timestamp] of this.recentQuestionKeys) if (timestamp < cutoff) this.recentQuestionKeys.delete(key);
  }

  private requireReading(readingId: string): Reading {
    const reading = this.getReading(readingId);
    if (!reading) throw new Error(`Reading not found: ${readingId}`);
    return reading;
  }

  private createPipelineSnapshot(readingId: string, phase: ReadingPipelinePhase = 'QUEUED', attempt = 0, artifacts?: Partial<ReadingPipelineArtifacts>): ReadingPipelineSnapshot {
    const now = Date.now();
    return {
      readingId,
      phase,
      phaseLabel: pipelinePhaseLabels[phase],
      progress: pipelinePhaseProgress[phase],
      attempt: Math.max(0, Math.min(attempt, maxPipelineAttempts)),
      maxAttempts: maxPipelineAttempts,
      stageStartedAt: now,
      updatedAt: now,
      artifacts: {
        hexagram: Boolean(artifacts?.hexagram),
        script: Boolean(artifacts?.script),
        audio: Boolean(artifacts?.audio),
        lipSync: Boolean(artifacts?.lipSync),
        avatar: Boolean(artifacts?.avatar),
      },
    };
  }

  private checkpoint(
    readingId: string,
    phase: ReadingPipelinePhase,
    patch: { attempt?: number; artifacts?: Partial<ReadingPipelineArtifacts>; nextRetryAt?: number; lastError?: ReadingPipelineSnapshot['lastError'] } = {},
  ): Reading {
    const current = this.requireReading(readingId);
    const previous = current.pipeline ?? this.createPipelineSnapshot(readingId);
    const now = Date.now();
    const next: ReadingPipelineSnapshot = {
      ...previous,
      phase,
      phaseLabel: pipelinePhaseLabels[phase],
      progress: pipelinePhaseProgress[phase],
      attempt: patch.attempt ?? previous.attempt,
      stageStartedAt: previous.phase === phase ? previous.stageStartedAt : now,
      updatedAt: now,
      artifacts: { ...previous.artifacts, ...patch.artifacts },
      ...(patch.nextRetryAt === undefined ? {} : { nextRetryAt: patch.nextRetryAt }),
      ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
    };
    return this.replace(readingId, { pipeline: next }, `PIPELINE_CHECKPOINT_${phase}`);
  }

  private transition(readingId: string, status: Reading['status'], patch: Partial<Reading> = {}): Reading {
    const next = transitionReading(this.requireReading(readingId), status, patch);
    this.save(next, 'READING_STATE_CHANGED');
    this.publishSnapshot('STATE_CHANGED');
    return next;
  }

  private replace(readingId: string, patch: Partial<Reading>, eventType: string): Reading {
    const next = { ...this.requireReading(readingId), ...patch };
    this.save(next, eventType);
    this.publishSnapshot('STATE_CHANGED');
    return next;
  }

  private save(reading: Reading, eventType: string): void {
    this.readings.set(reading.id, reading);
    if (this.closing) return;
    this.persistence.saveReading(reading);
    this.persistence.recordEvent(eventType, { status: reading.status }, reading.id);
  }

  private getDirectorStage(): DirectorStage {
    // A paused session still shows its live stages while a replay or an active
    // pipeline is running; otherwise the PAUSED mask would hide the actual
    // director work (for example a replay started right after a restart).
    const replayBusy = Boolean(this.replay);
    const activeReading = this.active ? this.getReading(this.active.readingId) : undefined;
    const pipelineBusy = Boolean(activeReading && isProcessing(activeReading.status));
    if (!replayBusy && !pipelineBusy && (this.currentSession?.status === 'PAUSED' || this.currentSession?.status === 'RECOVERING')) return 'PAUSED';
    if (this.activeCue?.stage) return this.activeCue.stage;
    const reading = this.replay?.reading ?? (this.active ? this.getReading(this.active.readingId) : undefined);
    const status = this.replay?.stage ?? reading?.status;
    const mapping: Partial<Record<string, DirectorStage>> = {
      RECEIVED: 'QUALIFIED', ACCEPTED: 'QUALIFIED', QUEUED: 'QUALIFIED', SELECTED: 'SELECTED', CASTING: 'CASTING',
      INTERPRETING: 'INTERPRETING', COMPOSING_SPEECH: 'COMPOSING', SYNTHESIZING: 'SYNTHESIZING', SPEAKING: 'SPEAKING',
      COMPLETED: 'FINISH', FINISH: 'FINISH', FAILED: 'ERROR', FAILED_TIMEOUT: 'ERROR', ABORTED: 'ERROR', SKIPPED: 'ERROR',
    };
    return status ? mapping[status] ?? 'IDLE' : 'IDLE';
  }

  private startDirectorCue(stage: DirectorStage, readingId?: string, payload: Record<string, unknown> = {}, track: DirectorCue['track'] = 'MAIN', durationMs?: number): DirectorCue | undefined {
    if (!this.currentSession || this.currentSession.status === 'ENDED') return undefined;
    const now = Date.now();
    if (track === 'MAIN' && this.activeCue && !this.activeCue.endsAt) {
      const ended = { ...this.activeCue, endsAt: now, revision: this.activeCue.revision + 1 };
      this.persistence.saveDirectorCue(ended);
      this.broadcastV2('CUE_ENDED', ended);
    }
    const cue: DirectorCue = {
      cueId: randomUUID(), sessionId: this.currentSession.sessionId, readingId,
      sequence: ++this.directorSequence, stage, track, startsAt: now,
      endsAt: durationMs ? now + durationMs : undefined, revision: 1, payload, createdAt: now,
    };
    this.persistence.saveDirectorCue(cue);
    if (track === 'MAIN') this.activeCue = cue;
    else this.sideCues.set(cue.cueId, cue);
    this.broadcastV2('CUE_STARTED', cue);
    this.publishSnapshot();
    if (durationMs && track !== 'MAIN') {
      const timer = setTimeout(() => {
        this.sideCueTimers.delete(cue.cueId);
        if (this.closing) return;
        const current = this.sideCues.get(cue.cueId);
        if (!current) return;
        const ended = { ...current, endsAt: Date.now(), revision: current.revision + 1 };
        this.persistence.saveDirectorCue(ended);
        this.sideCues.delete(cue.cueId);
        this.broadcastV2('CUE_ENDED', ended);
        this.publishSnapshot();
      }, durationMs + 20);
      this.sideCueTimers.set(cue.cueId, timer);
    }
    return cue;
  }

  private finishActiveCue(): void {
    if (!this.activeCue || this.activeCue.endsAt) return;
    const ended = { ...this.activeCue, endsAt: Date.now(), revision: this.activeCue.revision + 1 };
    this.persistence.saveDirectorCue(ended);
    this.broadcastV2('CUE_ENDED', ended);
    this.activeCue = undefined;
  }

  private finalizeSession(reason: string): void {
    if (!this.currentSession || this.currentSession.status === 'ENDED') return;
    this.finishActiveCue();
    const now = Date.now();
    this.currentSession = { ...this.currentSession, status: 'ENDED', endedAt: now, lastHeartbeatAt: now, endReason: reason };
    this.persistence.saveLiveSession(this.currentSession);
    this.autoProcessing = false;
    this.acceptingQuestions = false;
    // Keep the diagnostics socket connected between live sessions.
    for (const timer of this.pipelineRetryTimers.values()) clearTimeout(timer);
    this.pipelineRetryTimers.clear();
    this.persistence.recordEvent('LIVE_SESSION_ENDED', { sessionId: this.currentSession.sessionId, reason });
    this.broadcastV2('SESSION_CHANGED', this.currentSession);
    this.publishSnapshot();
  }

  private createV2Message(type: DirectorMessageV2['type'], payload: unknown): DirectorMessageV2 {
    const now = Date.now();
    return { type, protocolVersion: 2, sessionId: this.currentSession?.sessionId, sequence: this.directorSequence, serverTime: now, payload } as DirectorMessageV2;
  }

  private broadcastV2(type: DirectorMessageV2['type'], payload: unknown): void {
    const message = this.createV2Message(type, payload);
    for (const socket of this.overlayClients) this.send(socket, message);
    for (const socket of this.adminClients) this.send(socket, message);
    // Draft previews use their own profile, but live business data still needs
    // to follow the formal OBS source. Coalesce bursts from pipeline progress
    // into one snapshot so the workbench cannot make the synchronous SQLite
    // read path monopolize the event loop.
    if (type !== 'HEARTBEAT') this.schedulePreviewBroadcast();
  }

  private schedulePreviewBroadcast(): void {
    if (this.closing || this.previewBroadcastTimer || this.previewClients.size === 0) return;
    this.previewBroadcastTimer = setTimeout(() => {
      this.previewBroadcastTimer = undefined;
      if (this.closing) return;
      for (const id of this.previewClients.keys()) this.broadcastPreview(id);
    }, 250);
  }

  /** 后台专用 WS 通道：与 overlay 分离，不注册 SOURCE_HELLO，不影响来源健康统计。 */
  attachAdmin(socket: WebSocket): void {
    this.adminClients.add(socket);
    this.send(socket, this.createV2Message('SNAPSHOT', this.getBroadcastSnapshotV2()));
    socket.on('close', () => this.adminClients.delete(socket));
    socket.on('error', () => this.adminClients.delete(socket));
  }

  private previewMessage(id: string): DirectorMessageV2 {
    const snapshot = this.getPreviewSnapshot(id);
    if (!snapshot) throw new Error('PREVIEW_SESSION_NOT_FOUND');
    return {
      type: 'SNAPSHOT', protocolVersion: 2, sessionId: `preview-${id}`,
      sequence: snapshot.sequence, serverTime: snapshot.serverTime, payload: snapshot,
    };
  }

  private broadcastPreview(id: string): void {
    const clients = this.previewClients.get(id);
    if (!clients?.size) return;
    const message = this.previewMessage(id);
    for (const socket of clients) this.send(socket, message);
  }

  private publishSnapshot(type: Extract<OverlayMessage['type'], 'STATE_CHANGED' | 'QUEUE_CHANGED'> = 'STATE_CHANGED'): void {
    const state = this.getOverlayState();
    if (type === 'QUEUE_CHANGED') {
      this.broadcast({ type, payload: state.queue });
      this.broadcast({ type: 'STATE_CHANGED', payload: state });
      this.broadcastV2('QUEUE_CHANGED', this.getBroadcastSnapshotV2().queue);
      this.broadcastV2('SNAPSHOT', this.getBroadcastSnapshotV2());
      return;
    }
    this.broadcast({ type, payload: state });
    this.broadcastV2('SNAPSHOT', this.getBroadcastSnapshotV2());
  }

  private broadcast(message: OverlayMessage): void {
    for (const socket of this.overlayClients) this.send(socket, message);
  }

  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}
