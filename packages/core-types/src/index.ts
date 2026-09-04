export type ReadingStatus =
  | 'RECEIVED'
  | 'REJECTED'
  | 'ACCEPTED'
  | 'QUEUED'
  | 'SELECTED'
  | 'CASTING'
  | 'INTERPRETING'
  | 'COMPOSING_SPEECH'
  | 'SYNTHESIZING'
  | 'SPEAKING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRYING'
  | 'SKIPPED'
  | 'ABORTED'
  | 'FAILED_TIMEOUT';

export type QueuePriority = 'NORMAL' | 'HIGH' | 'MANUAL';

export type LiveSessionStatus = 'PREPARING' | 'LIVE' | 'PAUSED' | 'ENDING' | 'ENDED' | 'RECOVERING';
export type LiveSessionMode = 'REHEARSAL' | 'LIVE';

export type DirectorStage =
  | 'IDLE'
  | 'QUALIFIED'
  | 'SELECTED'
  | 'CASTING'
  | 'INTERPRETING'
  | 'COMPOSING'
  | 'SYNTHESIZING'
  | 'SPEAKING'
  | 'FINISH'
  | 'ERROR'
  | 'PAUSED';

export type AvatarActionName =
  | 'IDLE'
  | 'QUESTION_RECEIVED'
  | 'CASTING'
  | 'THINKING'
  | 'SPEAKING_NEUTRAL'
  | 'SPEAKING_EMPHASIS'
  | 'THANK_GIFT'
  | 'FINISH'
  | 'ERROR_RECOVER';

export type AdapterStatus =
  | 'READY'
  | 'NOT_CONFIGURED'
  | 'DISCONNECTED'
  | 'DEGRADED'
  | 'ERROR'
  | 'CONNECTING'
  | 'AUTH_REQUIRED'
  | 'MODEL_MISSING'
  | 'PARAMETER_MISSING';

export type ModerationDecision = 'ALLOW' | 'REJECT' | 'UNCLEAR' | 'CHAT_ONLY';

export interface LiveChatEvent {
  source: 'mock' | 'tikfinity' | 'manual';
  eventId: string;
  userId?: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  message: string;
  timestamp: number;
  raw: unknown;
}

/** Normalized gift event emitted by the live-input adapter. */
export interface LiveGiftEvent {
  source: LiveChatEvent['source'];
  eventId: string;
  userId?: string;
  username: string;
  displayName?: string;
  giftId?: string;
  giftName: string;
  repeatCount: number;
  giftType?: number;
  repeatEnd?: boolean;
  /** Recorded only when the real provider payload exposes it; rules never assume it exists. */
  diamondCount?: number;
  timestamp: number;
  raw: unknown;
}

/** Normalized TikTok like event. likeCount is the increment carried by this event. */
export interface LiveLikeEvent {
  source: LiveChatEvent['source'];
  eventId: string;
  userId?: string;
  username: string;
  displayName?: string;
  likeCount: number;
  totalLikeCount?: number;
  timestamp: number;
  raw: unknown;
}

export interface ModerationResult {
  decision: ModerationDecision;
  category: 'CAREER' | 'RELATIONSHIP' | 'STUDY' | 'LIFE' | 'FINANCE_GENERAL' | 'OTHER' | 'RISK';
  confidence: number;
  reason: string;
  normalizedQuestion: string;
}

export interface HexagramLine {
  index: 1 | 2 | 3 | 4 | 5 | 6;
  yinYang: 'YIN' | 'YANG';
  moving: boolean;
}

export interface MeihuaInput {
  readingId: string;
  question: string;
  receivedAt: string;
  locale: string;
  /** Deterministic number source for the NICKNAME casting policy. */
  username?: string;
  userProvidedNumbers?: number[];
  seedPolicy: 'TIME' | 'NUMBER' | 'CUSTOM' | 'NICKNAME';
}

export interface MeihuaResult {
  primary: {
    name: string;
    number?: number;
    upperTrigram: string;
    lowerTrigram: string;
    lines: HexagramLine[];
  };
  mutual?: {
    name: string;
    number?: number;
    upperTrigram: string;
    lowerTrigram: string;
    lines: HexagramLine[];
  };
  changed?: {
    name: string;
    number?: number;
    upperTrigram: string;
    lowerTrigram: string;
    lines: HexagramLine[];
  };
  movingLines: number[];
  bodyTrigram?: string;
  useTrigram?: string;
  fiveElements?: Record<string, string>;
  relations?: string[];
  timingSignals?: string[];
  interpretationFacts: string[];
  warnings?: string[];
  engineVersion: string;
  provenance?: {
    method: 'TRADITIONAL_TIME' | 'NUMBER' | 'NICKNAME';
    formula: string;
    source: string;
    receivedAt: string;
    inputs: Record<string, string | number | number[]>;
  };
}

export interface AnswerContent {
  opening: string;
  speech: string;
  keywords: string[];
  closing: string;
  estimatedSeconds: number;
  /** Measured narration units used to prove the queue duration was applied. */
  speechUnits?: number;
  targetSpeechUnits?: number;
  minimumSpeechUnits?: number;
  maximumSpeechUnits?: number;
  contentLanguage?: ContentLanguage;
}

/**
 * Durable checkpoints for the single reading pipeline.  The phase is
 * intentionally finer grained than ReadingStatus so the admin and OBS output
 * can prove which artifact is ready before the next one is consumed.
 */
export type ReadingPipelinePhase =
  | 'QUEUED'
  | 'SELECTED'
  | 'CASTING'
  | 'INTERPRETING'
  | 'HEXAGRAM_READY'
  | 'COMPOSING'
  | 'SCRIPT_READY'
  | 'SYNTHESIZING'
  | 'VOICE_READY'
  | 'RENDERING'
  | 'SPEAKING'
  | 'FINISH'
  | 'FAILED';

export interface ReadingPipelineArtifacts {
  hexagram: boolean;
  script: boolean;
  audio: boolean;
  lipSync: boolean;
  avatar: boolean;
}

export interface ReadingPipelineSnapshot {
  readingId: string;
  phase: ReadingPipelinePhase;
  phaseLabel: string;
  progress: number;
  attempt: number;
  maxAttempts: number;
  stageStartedAt: number;
  updatedAt: number;
  artifacts: ReadingPipelineArtifacts;
  nextRetryAt?: number;
  lastError?: { code: string; message: string; at: number };
}

export type LipSyncMode = 'VISEME_AMPLITUDE' | 'AMPLITUDE_ONLY' | 'NONE';

export interface VisemeFrame {
  offsetMs: number;
  durationMs: number;
  viseme: number;
  nextViseme?: number;
  vowel: 'A' | 'I' | 'U' | 'E' | 'O' | 'SILENCE';
  emphasis?: string;
}

export interface AmplitudeFrame {
  offsetMs: number;
  durationMs: number;
  rms: number;
  mouthOpen: number;
}

export interface LipSyncPlan {
  version: 1;
  mode: LipSyncMode;
  frameIntervalMs: number;
  totalDurationMs: number;
  visemes: VisemeFrame[];
  amplitudes: AmplitudeFrame[];
  createdAt: number;
}

export interface TtsResult {
  audioPath?: string;
  durationMs: number;
  providerId?: string;
  targetLocale?: VoiceTargetLocale;
  engineVersion?: string;
  processingMs?: number;
  quality?: Record<string, string | number | boolean>;
  lipSyncPlan?: LipSyncPlan;
  analysisVersion?: string;
}

export interface SpeechSegment {
  segmentId: string;
  text: string;
  offsetMs: number;
  durationMs: number;
  avatarAction: AvatarActionName;
  emphasis: boolean;
  hexagramFocus?: 'PRIMARY' | 'MUTUAL' | 'CHANGED' | 'MOVING_LINES';
  keywords: string[];
}

export interface SpeechPlan {
  readingId: string;
  totalDurationMs: number;
  segments: SpeechSegment[];
  createdAt: number;
  revision: number;
  /** Immutable voice selection captured when this reading starts. */
  voiceProfileId?: string;
  /** The language the answer composer and voice must both use. */
  contentLanguage?: ContentLanguage;
  /** Managed audio URL; host filesystem paths never cross the API boundary. */
  audioAssetId?: string;
  /** Set only after the native audio bus confirms playback. */
  startedAt?: number;
  lipSyncPlan?: LipSyncPlan;
  avatarActionTimeline?: Array<{ action: AvatarActionName; offsetMs: number; durationMs: number }>;
  failureReason?: string;
}

/**
 * Immutable voice choice captured when a queued reading is selected. Global
 * admin changes affect the next reading, never an in-flight audio job.
 */
export interface VoiceSelectionSnapshot {
  voiceProfileId?: string;
  voiceId: string;
  contentLanguage: ContentLanguage;
  targetLocale: VoiceTargetLocale;
  targetCountry?: string;
  accentProfileId?: string;
  sourceLanguage?: GptSoVitsRefLanguage;
  speed: number;
}

export interface GiftApplied {
  entitlementId: string;
  ruleId: string;
  giftId?: string;
  giftName: string;
  repeatCount: number;
  priority: QueuePriority;
  speechTargetSeconds: number;
  receivedAt: number;
}

export interface Reading {
  id: string;
  sessionId?: string;
  sourceEventId?: string;
  source: LiveChatEvent['source'];
  username: string;
  userId?: string;
  rawQuestion: string;
  normalizedQuestion?: string;
  category?: ModerationResult['category'];
  moderationDecision?: ModerationDecision;
  moderationReason?: string;
  status: ReadingStatus;
  priority: QueuePriority;
  gift?: GiftApplied;
  qualification?: {
    kind: 'GIFT' | 'LIKE' | 'COMMENT_KEYWORD' | 'MANUAL';
    ruleId: string;
    label: string;
  };
  /** Per-reading speech duration, potentially granted by a qualifying gift. */
  speechTargetSeconds?: number;
  /** Immutable voice selection captured when this reading leaves the queue. */
  voiceSnapshot?: VoiceSelectionSnapshot;
  meihua?: MeihuaResult;
  answer?: AnswerContent;
  /** Durable end-to-end checkpoint for queue -> cast -> answer -> voice -> output. */
  pipeline?: ReadingPipelineSnapshot;
  tts?: TtsResult;
  speechPlan?: SpeechPlan;
  lipSyncPlan?: LipSyncPlan;
  /** Immutable pairing of the exact voice/audio/avatar output used for this reading. */
  digitalHumanSnapshot?: DigitalHumanOutputSnapshot;
  /** Immutable presentation selection captured when this reading starts. */
  presentationSnapshot?: PresentationSnapshot;
  createdAt: number;
  /** Queue-specific expiry. Free rules may expire sooner than paid rules. */
  expiresAt?: number;
  selectedAt?: number;
  completedAt?: number;
  errorCode?: string;
  errorMessage?: string;
}

export type OverlayMode = 'IDLE' | 'QUEUED' | 'CASTING' | 'SPEAKING' | 'FINISH';

export interface OverlayState {
  mode: OverlayMode;
  current?: {
    readingId: string;
    username: string;
    question: string;
    giftName?: string;
    speechTargetSeconds?: number;
    audioPath?: string;
    answer?: AnswerContent;
    pipeline?: ReadingPipelineSnapshot;
  };
  hexagram?: MeihuaResult;
  keywords: string[];
  queue: Array<{ readingId: string; username: string; position: number }>;
  statusText: string;
  disclaimer: string;
  contentLanguage: ContentLanguage;
  effects: OverlayEffects;
  moduleSettings: Record<OverlayModuleId, OverlayModuleSettings>;
  subtitle?: string;
  giftAlert?: {
    username: string;
    giftName: string;
    action: 'PENDING_QUESTION' | 'APPLIED_TO_QUEUE';
    speechTargetSeconds: number;
    expiresAt: number;
  };
  isReplay?: boolean;
  updatedAt: number;
}

export type ContentLanguage = 'en' | 'zh-CN' | 'es' | 'fr' | 'de' | 'ja' | 'ko' | 'pt' | 'ru';

export interface OverlayEffects {
  accentColor: string;
  backgroundOpacity: number;
  glowIntensity: number;
  animationStyle: 'smooth' | 'energetic' | 'minimal';
  particles: boolean;
}

export type OverlayModuleId = 'status' | 'current' | 'hexagram' | 'keywords' | 'gift' | 'queue' | 'subtitles' | 'disclaimer' | 'audio';

export interface OverlayModuleSettings {
  enabled: boolean;
  width: number;
  height: number;
  fontScale: number;
  backgroundOpacity: number;
  maxItems: number;
  idleBehavior: 'HIDE' | 'PREVIEW' | 'KEEP_LAST';
  accentColor?: string;
  /** Optional operator-authored label shown above dynamic content. */
  titleText: string;
  /** Text used when the module is configured to show an idle preview. */
  idleText: string;
  showTitle: boolean;
  textColor: string;
  backgroundColor: string;
  brightness: number;
  glowIntensity: number;
  animationStyle: OverlayEffects['animationStyle'];
}

export interface QueueSettings {
  maxVisible: number;
  maxTotal: number;
  sameUserCooldownMinutes: number;
  expireMinutes: number;
  dedupeWindowSeconds: number;
}

export interface ModerationSettings {
  minChars: number;
  treatAnyCommentAsQuestion: boolean;
  maxChars: number;
  llmTimeoutMs: number;
}

export interface ReadingSettings {
  speechTargetSeconds: number;
  watchdogMs: number;
  externalRetryCount: number;
}

/**
 * Meihua casting engine selection. MINGYU_CORE is the V2.2 canonical engine
 * (邵雍《梅花易数》通行本) that passed the fixed-sample dual-cast comparison;
 * LEGACY_V2_1 stays selectable as the documented rollback path.
 */
export interface MeihuaEngineSettings {
  engine: 'MINGYU_CORE' | 'LEGACY_V2_1';
}

export interface GiftRule {
  id: string;
  enabled: boolean;
  /** Match the adapter's stable gift ID when available. */
  giftId?: string;
  /** Fallback match, case-insensitive and trimmed. */
  giftName: string;
  minRepeatCount: number;
  priority: QueuePriority;
  speechTargetSeconds: number;
  /** Session gift-ranking points granted per final settled gift unit. */
  leaderboardPoints: number;
  /** TikTok streakable gifts are granted only on repeatEnd=true. */
  requireStreakEnd: boolean;
}

export interface GiftSettings {
  enabled: boolean;
  /** How long a received gift can wait for the viewer's question. */
  entitlementExpireMinutes: number;
  rules: GiftRule[];
}

export interface LikeRule {
  id: string;
  enabled: boolean;
  label: string;
  threshold: number;
  priority: QueuePriority;
  speechTargetSeconds: number;
  grantExpireMinutes: number;
  cooldownMinutes: number;
}

export interface CommentRule {
  id: string;
  enabled: boolean;
  label: string;
  keywords: string[];
  matchMode: 'EXACT' | 'CONTAINS' | 'REGEX';
  stripKeyword: boolean;
  priority: QueuePriority;
  speechTargetSeconds: number;
  queueExpireMinutes: number;
  cooldownMinutes: number;
}

export interface EngagementSettings {
  enabled: boolean;
  likeRules: LikeRule[];
  commentRules: CommentRule[];
  likeUnit: number;
  likePoints: number;
  commentPoints: number;
  obsRankingLimit: number;
  adminRankingLimit: number;
}

export interface QualificationGrant {
  id: string;
  sourceEventId: string;
  sessionId?: string;
  userKey: string;
  username: string;
  kind: 'LIKE' | 'COMMENT_KEYWORD';
  ruleId: string;
  label: string;
  priority: QueuePriority;
  speechTargetSeconds: number;
  status: 'PENDING' | 'APPLIED' | 'EXPIRED';
  readingId?: string;
  createdAt: number;
  appliedAt?: number;
  expiresAt: number;
}

export interface LiveSession {
  sessionId: string;
  mode: LiveSessionMode;
  status: LiveSessionStatus;
  profileVersionId: string;
  startedAt?: number;
  endedAt?: number;
  lastHeartbeatAt: number;
  operatorNote?: string;
  endReason?: string;
}

export interface DirectorCue<TPayload = Record<string, unknown>> {
  cueId: string;
  sessionId: string;
  readingId?: string;
  sequence: number;
  stage: DirectorStage;
  track: 'MAIN' | 'GIFT' | 'SYSTEM';
  startsAt: number;
  endsAt?: number;
  revision: number;
  payload: TPayload;
  createdAt: number;
}

export type ObsSourceId =
  | 'avatar'
  | 'background'
  | 'current-viewer'
  | 'hexagram'
  | 'subtitles'
  | 'queue'
  | 'gift-alert'
  | 'gift-ranking'
  | 'engagement-ranking'
  | 'status'
  | 'effects'
  | 'sticker'
  | 'disclaimer'
  | 'audio'
  | 'meihua-stage'
  | 'full-preview';

export type MediaAssetKind = 'BACKGROUND_IMAGE' | 'BACKGROUND_VIDEO' | 'AVATAR_VIDEO' | 'AVATAR_IMAGE' | 'AVATAR_VRM' | 'AVATAR_ANIMATION' | 'AUDIO_REFERENCE' | 'STICKER_IMAGE' | 'OVERLAY_IMAGE' | 'LUX3D_MODEL';

export interface MediaAsset {
  id: string;
  kind: MediaAssetKind;
  origin: 'SYSTEM' | 'UPLOADED';
  fileName: string;
  mimeType: string;
  contentHash: string;
  sizeBytes: number;
  /** Relative key inside the managed media directory. Never expose host paths to clients. */
  storageKey?: string;
  /** @deprecated Internal persistence compatibility only. API responses omit this field. */
  storagePath?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  transparency: 'PRESENT' | 'ABSENT' | 'SUPPORTED_FORMAT' | 'UNKNOWN';
  createdAt: number;
}

/** Assets that belong to the scene rather than a single text/data module. */
export interface SceneVisualAssets {
  /** The interchangeable centre asset used by the Lux3D compass source. */
  lux3dCoreAssetId?: string;
}

export interface AvatarActionSlot {
  action: AvatarActionName;
  assetId?: string;
  mode: 'TRANSPARENT' | 'CHROMA_KEY' | 'STATIC_FALLBACK';
  chromaColor: string;
  playback: 'LOOP' | 'ONCE';
  minDurationMs: number;
  maxDurationMs: number;
  transitionInMs: number;
  transitionOutMs: number;
  fallbackAction: AvatarActionName;
}

export interface MediaAvatarProfile {
  slots: Record<AvatarActionName, AvatarActionSlot>;
}

export type PresentationMode = 'VIDEO_LOOP' | 'VIDEO_ONCE' | 'DIGITAL_HUMAN' | 'AUDIO_ONLY';
export type PresentationFallbackPolicy = 'VIDEO' | 'STRICT' | 'AUDIO_ONLY';
export type VideoPresentationStatus = 'UPLOADED' | 'VALIDATING' | 'READY' | 'DISABLED' | 'FAILED';

export interface VideoPresentationProfile {
  id: string;
  name: string;
  assetId: string;
  status: VideoPresentationStatus;
  playback: 'LOOP' | 'ONCE';
  fit: 'COVER' | 'CONTAIN';
  durationMs?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PresentationSettings {
  mode: PresentationMode;
  profiles: VideoPresentationProfile[];
  activeVideoProfileId?: string;
  fallbackVideoProfileId?: string;
  fallbackPolicy: PresentationFallbackPolicy;
}

export interface PresentationSnapshot {
  mode: PresentationMode;
  videoProfileId?: string;
  avatarProfileId?: string;
  fallbackApplied: boolean;
  fallbackReason?: string;
  selectedAt: number;
}

export interface DigitalHumanOutputSnapshot {
  readingId: string;
  voiceProfileId?: string;
  avatarProfileId?: string;
  targetLocale: VoiceTargetLocale;
  targetCountry?: string;
  accentProfileId?: string;
  audioAssetId: string;
  videoAssetId?: string;
  audioDurationMs: number;
  videoDurationMs?: number;
  audioVideoOffsetMs: number;
  presentationMode?: PresentationMode;
  videoProfileId?: string;
  fallbackApplied?: boolean;
  createdAt: number;
}

export interface GiftWindowOffer {
  id: string;
  giftId: string;
  giftName: string;
  coins?: number;
  speechTargetSeconds: number;
  message: string;
}

export interface ObsSourceConfig {
  sourceId: ObsSourceId;
  enabled: boolean;
  width: number;
  height: number;
  fontScale: number;
  backgroundOpacity: number;
  /** OBS output background. Transparent is native alpha; chroma supports keyed workflows. */
  backgroundMode?: 'TRANSPARENT' | 'CHROMA' | 'SOLID';
  /** Removes panel borders, radii and shadows from formal OBS output. */
  borderless?: boolean;
  /** Hard content-only mode: no frame, fill, blur, radius or shadow in editor/OBS. */
  contentOnly?: boolean;
  /** Key color used when backgroundMode is CHROMA. */
  chromaColor?: string;
  maxItems: number;
  idleBehavior: 'HIDE' | 'PREVIEW' | 'KEEP_LAST';
  titleText: string;
  idleText: string;
  showTitle: boolean;
  textColor: string;
  backgroundColor: string;
  accentColor: string;
  brightness: number;
  glowIntensity: number;
  animationStyle: OverlayEffects['animationStyle'];
  fontFamily?: string;
  contentTemplate?: string;
  /** Optional visual placed behind an individual module panel. */
  decorationAssetId?: string;
  /** Background/sticker media only. Other modules use decorationAssetId. */
  backgroundAssetId?: string;
  /** Static gift offer shown by the configurable gift window. */
  selectedGiftId?: string;
  selectedGiftName?: string;
  selectedGiftCoins?: number;
  selectedGiftSpeechSeconds?: number;
  giftMessage?: string;
  giftOffers?: GiftWindowOffer[];
}

export type SceneModuleId = Exclude<ObsSourceId, 'audio' | 'meihua-stage' | 'full-preview'> | 'lux3d';

export interface SceneTransform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

interface SceneLayerBase {
  id: string;
  name: string;
  transform: SceneTransform;
  visible: boolean;
  locked: boolean;
  opacity: number;
  zIndex: number;
}

export interface SceneModuleLayer extends SceneLayerBase {
  kind: 'MODULE';
  moduleId: SceneModuleId;
}

export interface SceneAssetLayer extends SceneLayerBase {
  kind: 'ASSET';
  assetId?: string;
  fit: 'CONTAIN' | 'COVER' | 'FILL';
}

export interface SceneTextLayer extends SceneLayerBase {
  kind: 'TEXT';
  text: string;
  fontSize: number;
  color: string;
  fontFamily?: string;
  align: 'LEFT' | 'CENTER' | 'RIGHT';
}

export type SceneLayer = SceneModuleLayer | SceneAssetLayer | SceneTextLayer;

export interface SceneComposition {
  width: 1080;
  height: 1920;
  layers: SceneLayer[];
}

export interface SceneElement {
  id: string;
  kind: 'image' | 'text';
  /** 图片元素绑定的素材 id（STICKER_IMAGE/BACKGROUND_IMAGE 均可）。 */
  assetId?: string;
  /** 文字元素内容。 */
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  fontSize?: number;
  color?: string;
  zIndex?: number;
}

export interface SceneProfile {
  profileId: string;
  name: string;
  contentLanguage: ContentLanguage;
  disclaimer: string;
  effects: OverlayEffects;
  sources: Record<ObsSourceId, ObsSourceConfig>;
  avatar: MediaAvatarProfile;
  visualAssets?: SceneVisualAssets;
  /** The authoritative WYSIWYG layout used by both the admin canvas and OBS stage. */
  composition?: SceneComposition;
  /** @deprecated Migrated into composition.layers. */
  canvasPreviewLayout?: Partial<Record<ObsSourceId, { x: number; y: number; width: number; height: number }>>;
  /** @deprecated Migrated into composition.layers. */
  elements?: SceneElement[];
}

export interface SceneProfileVersion {
  versionId: string;
  profileId: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  profile: SceneProfile;
  createdAt: number;
  publishedAt?: number;
}

export interface SessionGiftRankingEntry {
  sessionId: string;
  userKey: string;
  username: string;
  points: number;
  giftCount: number;
  reachedAt: number;
  rank: number;
}

export interface SessionEngagementRankingEntry {
  sessionId: string;
  userKey: string;
  username: string;
  points: number;
  likeCount: number;
  validCommentCount: number;
  reachedAt: number;
  rank: number;
}

/** Preview/result for rebuilding operator-facing data from durable source records. */
export interface OperationalDataRecalculationReport {
  canApply: boolean;
  applied: boolean;
  sessionId?: string;
  sessionStatus?: LiveSessionStatus;
  range?: { from: number; to: number };
  scanned: {
    liveEvents: number;
    chats: number;
    likes: number;
    gifts: number;
    readings: number;
  };
  rebuilt: {
    queueItems: number;
    pendingQualifications: number;
    engagementUsers: number;
    giftUsers: number;
  };
  preserved: {
    rawEvents: number;
    completedReadings: number;
  };
  recalculatedAt: number;
  blockingReason?: string;
}

export interface PreviewSession {
  previewSessionId: string;
  scenario: DirectorStage | 'GIFT' | 'QUEUE';
  profile: SceneProfile;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface QueueOverviewEntry {
  id: string;
  username: string;
  eventSource: 'MOCK' | 'TIKFINITY' | 'MANUAL';
  source: 'GIFT' | 'LIKE' | 'COMMENT_KEYWORD' | 'MANUAL' | 'QUEUE';
  status: 'WAITING_QUESTION' | 'QUEUED';
  label: string;
  question?: string;
  giftName?: string;
  position?: number;
  priority?: QueuePriority;
  speechTargetSeconds: number;
  createdAt: number;
  expiresAt?: number;
}

export type AvatarStageMediaKind = 'STATIC' | 'VIDEO_URL' | 'WEBRTC' | 'VRM';

/** Connection material returned by Alibaba Avatar when the output channel is DingRTC. */
export interface AvatarRtcConnection {
  provider: 'aliyun-avatar';
  sessionId: string;
  channelId: string;
  token: string;
  userId: string;
  appId: string;
  userInfoInChannel?: string;
  gslb: string[];
  expiredTime?: number;
}

/** Media the integrated stage should embed for the person slot. STATIC means the staged prerecorded action assets stay authoritative. */
export interface AvatarStageMedia {
  kind: AvatarStageMediaKind;
  url?: string;
  label?: string;
  profileId?: string;
  modelAssetId?: string;
  chromaColor?: string;
  muted?: boolean;
  renderJobId?: string;
  outputAssetId?: string;
  playback?: 'LOOP' | 'ONCE';
  fit?: 'COVER' | 'CONTAIN';
  rtc?: AvatarRtcConnection;
}

/** What a concrete avatar vendor is actually able to deliver through the adapter. */
export interface AvatarProviderCapabilities {
  /** The vendor supports explicit session creation and teardown. */
  sessionLifecycle: boolean;
  /** The vendor exposes stage actions (IDLE/CASTING/SPEAKING/…) as callable operations. */
  stageActions: boolean;
  /** The vendor renders the avatar with its own realtime audio output. */
  realtimeAudio: boolean;
  /** The vendor drives realtime lip sync from the speaking plan. */
  lipSync: boolean;
  /** The vendor can output a clean green-screen compositing feed. */
  greenScreenOutput: boolean;
  /** The vendor exposes a stream the integrated stage can embed directly. */
  mediaStreamOutput: boolean;
}

export const emptyAvatarProviderCapabilities: AvatarProviderCapabilities = {
  sessionLifecycle: false,
  stageActions: false,
  realtimeAudio: false,
  lipSync: false,
  greenScreenOutput: false,
  mediaStreamOutput: false,
};

/**
 * Provider-agnostic avatar adapter state. A vendor must be selected and its
 * capabilities verified before anything is presented as production-ready; until
 * then the layer reports "适配层完成，供应商待接入".
 */
export interface AvatarProviderAdapterState {
  vendorId: string;
  vendorLabel: string;
  vendorSelected: boolean;
  status: AdapterStatus;
  connected: boolean;
  sessionActive: boolean;
  sessionId?: string;
  capabilities: AvatarProviderCapabilities;
  media: AvatarStageMedia;
  lastAction?: AvatarActionName;
  lastError?: string;
  checkedAt: number;
}

export interface BroadcastSnapshotV2 {
  protocolVersion: 2;
  session?: LiveSession;
  sequence: number;
  serverTime: number;
  stage: DirectorStage;
  activeCue?: DirectorCue;
  sideCues: DirectorCue[];
  reading?: Reading;
  speechPlan?: SpeechPlan;
  queue: Array<{ readingId: string; username: string; position: number; priority: QueuePriority }>;
  qualificationQueue: QueueOverviewEntry[];
  giftRanking: SessionGiftRankingEntry[];
  engagementRanking: SessionEngagementRankingEntry[];
  mediaAssets?: MediaAsset[];
  profileVersion: SceneProfileVersion;
  /** Digest of the published scene structure; used to diagnose editor/OBS mismatches. */
  sceneHash?: string;
  /** Shared server epoch for background/video playback synchronization. */
  mediaEpoch?: number;
  acceptingEvents: boolean;
  audioUrl?: string;
  /** Canonical presentation mode for the current immutable reading snapshot. */
  presentationMode?: PresentationMode;
  /** Canonical visual media for prerecorded-video mode; avatarStageMedia remains compatible. */
  presentationMedia?: AvatarStageMedia;
  /** VTube Studio is captured directly in OBS; the legacy browser avatar stays transparent. */
  avatarRuntime?: 'MEDIA' | 'VTUBE_STUDIO' | 'LOCAL_VRM' | 'BAIDU_CLOUD' | 'PROVIDER' | 'NONE';
  /** Media slot for the integrated stage; STATIC falls back to staged action assets. */
  avatarStageMedia?: AvatarStageMedia;
  avatarRuntimeStatus?: AvatarRuntimeStatus;
  sync?: SyncMetrics;
  lastError?: { code: string; message: string; at: number };
}

/** V5.6 底色策略：透明为默认；历史绿幕值一律按透明呈现，纯色仅背景/整屏角色保留。 */
export function resolveBackgroundMode(config: Pick<ObsSourceConfig, 'sourceId' | 'backgroundMode'>): 'TRANSPARENT' | 'SOLID' {
  const stored = config.backgroundMode;
  const solidRoles = config.sourceId === 'background' || config.sourceId === 'full-preview';
  if (stored === 'SOLID' || (stored === 'CHROMA' && solidRoles)) return 'SOLID';
  return 'TRANSPARENT';
}

export type DirectorMessageV2 =
  | { type: 'SNAPSHOT'; protocolVersion: 2; sessionId?: string; sequence: number; serverTime: number; payload: BroadcastSnapshotV2 }
  | { type: 'CUE_STARTED' | 'CUE_UPDATED' | 'CUE_ENDED'; protocolVersion: 2; sessionId?: string; sequence: number; serverTime: number; payload: DirectorCue }
  | { type: 'QUEUE_CHANGED' | 'RANKING_CHANGED' | 'SESSION_CHANGED' | 'PROFILE_PUBLISHED' | 'SPEECH_PREPARED' | 'SPEECH_STARTED' | 'SPEECH_FINISHED' | 'SPEECH_FAILED' | 'ERROR'; protocolVersion: 2; sessionId?: string; sequence: number; serverTime: number; payload: unknown }
  | { type: 'HEARTBEAT'; protocolVersion: 2; sessionId?: string; sequence: number; serverTime: number; payload: { serverTime: number } };

export interface GiftEntitlement extends Omit<GiftApplied, 'entitlementId'> {
  id: string;
  sourceEventId: string;
  userKey: string;
  username: string;
  status: 'PENDING' | 'APPLIED' | 'EXPIRED';
  readingId?: string;
  createdAt: number;
  appliedAt?: number;
  expiresAt: number;
}

export type GptSoVitsRefLanguage = 'zh' | 'en' | 'ja' | 'ko' | 'yue';
/** Language/region used by the final speech engine. Country is not inferred from this value. */
export type VoiceTargetLocale = 'zh-CN' | 'yue-HK' | 'en-US' | 'en-GB' | 'ja-JP' | 'ko-KR' | 'es-ES' | 'fr-FR';
export type VoiceCloneMode = 'COUNTRY_ACCENT' | 'TIMBRE_ONLY';
export type VoiceJobStatus = 'QUEUED' | 'PROCESSING' | 'READY' | 'FAILED' | 'CANCELED';

export interface VoiceAccentProfile {
  id: string;
  country: string;
  label: string;
  locale: VoiceTargetLocale;
  engine: 'openvoice-v2';
  enabled: boolean;
}

export type VoiceProfileStatus = 'PROCESSING' | 'NEEDS_REVIEW' | 'READY' | 'DISABLED' | 'FAILED' | 'DRAFT' | 'VALIDATING' | 'REJECTED';
export type VoiceCloneProvider = 'GPT_SOVITS_V3' | 'BAIDU_LITE' | 'BAIDU_XILING' | 'ALIYUN_COSYVOICE' | 'LEGACY';
export type AvatarProfileProvider = 'LOCAL_VIDEO' | 'LOCAL_VRM' | 'BAIDU_CLOUD' | 'ALIYUN_CLOUD';
export type AvatarProfileStatus = 'UPLOADED' | 'VALIDATING' | 'PREPARING' | 'NEEDS_REVIEW' | 'READY' | 'DISABLED' | 'FAILED';
export type AvatarRenderJobStatus = 'QUEUED' | 'PREPARING' | 'RENDERING' | 'READY' | 'PLAYING' | 'FINISHED' | 'FAILED' | 'CANCELED';

/** A consented source recording. The host path stays inside the orchestrator. */
export interface VoiceClone {
  id: string;
  name: string;
  provider: VoiceCloneProvider;
  referenceFileName: string;
  referenceText: string;
  sourceLanguage: GptSoVitsRefLanguage;
  targetLocale?: VoiceTargetLocale;
  targetCountry?: string;
  accentProfileId?: string;
  cloneMode?: VoiceCloneMode;
  authorizationConfirmed: boolean;
  providerCloneId?: string;
  status: VoiceProfileStatus;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

/** A local GPT-SoVITS voice pack: one clean reference clip + its transcript. */
export interface GptSoVitsVoice {
  id: string;
  name: string;
  refAudioPath: string;
  refText: string;
  refLanguage: GptSoVitsRefLanguage;
  /** Actual language detected in the uploaded reference recording. */
  sourceLanguage?: GptSoVitsRefLanguage;
  /** Final language/region requested by the operator. */
  targetLocale?: VoiceTargetLocale;
  targetCountry?: string;
  accentProfileId?: string;
  cloneMode?: VoiceCloneMode;
  createdAt: number;
}

export interface ProviderSettings {
  liveInput: { adapter: 'local' | 'tikfinity'; url: string };
  llm: { adapter: 'rule-based' | 'openai-compatible'; baseUrl: string; model: string; apiKeyEnv: string };
  tts: {
    adapter: 'windows' | 'kokoro' | 'openai-compatible' | 'elevenlabs' | 'external' | 'gptsovits';
    baseUrl: string;
    model: string;
    voiceId: string;
    speed: number;
    instructions: string;
    apiKeyEnv: string;
    reuseLlmKey: boolean;
    stability: number;
    similarityBoost: number;
    style: number;
    speakerBoost: boolean;
    /** Local GPT-SoVITS voice-cloning service settings. */
    gptsovits: { baseUrl: string; apiVersion?: 'V2' | 'V3' | 'CHANYIN_QFTTS'; voices: GptSoVitsVoice[] };
    /** Local Kokoro preset voice service settings. No API key is required. */
    kokoro: { baseUrl: string; defaultVoice: string };
    /** Local CUDA voice/accent conversion service settings. */
    accent?: { baseUrl: string; profiles: VoiceAccentProfile[] };
    /** Cloud/local provider used when creating a cloned voice through the operator UI. */
    voiceCloneApi?: VoiceCloneApiSettings;
    activeVoiceProfileId?: string;
    voiceClones?: VoiceClone[];
    voiceProfiles?: VoiceProfile[];
    baidu?: { baseUrl: string; appId: string; accessTokenConfigured: boolean };
  };
  avatar: {
    adapter: 'none' | 'mock' | 'musetalk' | 'vtube-studio' | 'warudo' | 'local-vrm' | 'baidu-cloud' | 'aliyun-cloud';
    url: string;
    /** Cloud/local provider used for digital-human clone/render API calls. */
    cloneApi?: DigitalHumanCloneApiSettings;
    activeProfileId?: string;
    profiles?: AvatarProfile[];
    baidu?: { baseUrl: string; appId: string; accessTokenConfigured: boolean };
  };
}

export interface VoiceCloneApiSettings {
  provider: 'aliyun' | 'baidu' | 'local-openvoice';
  /** Aliyun DashScope/Model Studio voice-customization endpoint or local service URL. */
  baseUrl: string;
  /** Enrollment model, e.g. voice-enrollment or qwen-voice-enrollment. */
  model: string;
  /** TTS model that will drive the created voice. */
  targetModel: string;
  region: 'cn-beijing' | 'ap-southeast-1';
  apiKeyEnv: string;
  workspaceId?: string;
  /** Provider-specific settings are kept together so both vendors can be configured at once. */
  aliyun?: VoiceCloudProviderConfig;
  baidu?: VoiceCloudProviderConfig;
}

export interface DigitalHumanCloneApiSettings {
  provider: 'aliyun' | 'baidu' | 'local-musetalk';
  /** Aliyun Avatar OpenAPI endpoint or local MuseTalk URL. */
  baseUrl: string;
  /** Cloud API operation/model identifier, e.g. StartInstance or videoretalk. */
  model: string;
  region: 'cn-zhangjiakou' | 'cn-beijing';
  apiKeyEnv: string;
  tenantId?: string;
  appId?: string;
  instanceId?: string;
  projectId?: string;
  /** Provider-specific settings are kept together so both vendors can be configured at once. */
  aliyun?: AvatarCloudProviderConfig;
  baidu?: AvatarCloudProviderConfig;
}

export interface VoiceCloudProviderConfig {
  baseUrl: string;
  clonePath: string;
  synthesizePath: string;
  /** Optional asynchronous synthesis status endpoint (used by Baidu Xiling). */
  synthesizeStatusPath?: string;
  /** Official protocol selects the vendor wire format; GENERIC_JSON keeps the adapter contract for self-hosted gateways. */
  protocol?: 'GENERIC_JSON' | 'ALIYUN_DASHSCOPE' | 'ALIYUN_QWEN_OMNI' | 'BAIDU_XILING';
  /** Public, unauthenticated base URL used when a vendor requires an audio URL. */
  publicBaseUrl?: string;
  /** Optional file-upload endpoint used by Baidu Xiling. */
  uploadPath?: string;
  uploadProviderType?: string;
  model: string;
  targetModel: string;
  region: string;
  apiKeyEnv: string;
  appId?: string;
  workspaceId?: string;
  accessTokenEnv?: string;
}

export interface AvatarCloudProviderConfig {
  baseUrl: string;
  clonePath: string;
  renderPath: string;
  /** Optional status/health endpoint for asynchronous avatar training. */
  statusPath?: string;
  healthPath?: string;
  /** Official protocol selects the vendor wire format; GENERIC_JSON is for a compatible gateway. */
  protocol?: 'GENERIC_JSON' | 'ALIYUN_AVATAR_OPENAPI' | 'BAIDU_XILING';
  /** Public base URL for vendor-side video/portrait fetches (Alibaba OpenAPI). */
  publicBaseUrl?: string;
  portraitUrl?: string;
  uploadPath?: string;
  uploadProviderType?: string;
  customizeType?: 'LITE_2D_GENERAL' | 'LITE_2D_PERSONAL';
  gender?: 'MALE' | 'FEMALE' | 'UNKNOWN';
  keepBackground?: boolean;
  webSocketPath?: string;
  model: string;
  region: string;
  apiKeyEnv: string;
  accessKeyIdEnv?: string;
  accessKeySecretEnv?: string;
  appId?: string;
  tenantId?: string;
  instanceId?: string;
  projectId?: string;
  /** HTTP_STREAM uses a returned media URL; RTC remains available to a future SDK adapter. */
  streamMode: 'HTTP_STREAM' | 'RTC';
}

export interface VoiceProfile {
  id?: string;
  voiceId: string;
  provider: 'elevenlabs' | 'openai-custom' | 'gptsovits-v3' | 'baidu-lite' | 'baidu-xiling' | 'aliyun-cosyvoice' | 'legacy';
  name: string;
  cloneId?: string;
  language?: ContentLanguage | 'yue' | 'ar';
  sourceLanguage?: GptSoVitsRefLanguage;
  targetLocale?: VoiceTargetLocale;
  targetCountry?: string;
  accentProfileId?: string;
  cloneMode?: VoiceCloneMode;
  accentVerifiedAt?: number;
  status?: VoiceProfileStatus;
  speed?: number;
  testText?: string;
  approvedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  lastError?: string;
  category?: string;
  description?: string;
  requiresVerification?: boolean;
  previewUrl?: string;
}

export interface AvatarProfile {
  id: string;
  name: string;
  provider: AvatarProfileProvider;
  status: AvatarProfileStatus;
  /** Managed source video used to prepare a MuseTalk avatar. */
  sourceAssetId?: string;
  /** Stable service-side avatar identifier; never a host filesystem path. */
  preparedAvatarId?: string;
  modelAssetId?: string;
  previewAssetId?: string;
  cloudFigureId?: string;
  cloudVideoUrl?: string;
  maxTextureSize: 1024 | 2048;
  renderFps: 30;
  chromaColor?: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  version?: number;
  developmentOnly?: boolean;
  authorizationConfirmed?: boolean;
  actionBindings?: Partial<Record<AvatarActionName, AvatarActionBinding>>;
}

export interface AvatarActionBinding {
  action: AvatarActionName;
  assetId?: string;
  playback: 'LOOP' | 'ONCE';
  minDurationMs: number;
  transitionInMs: number;
  transitionOutMs: number;
  fallbackAction: AvatarActionName;
}

export interface VideoAvatarProfile extends AvatarProfile {
  provider: 'LOCAL_VIDEO';
  sourceAssetId: string;
  preparedAvatarId: string;
}

export interface AvatarRenderJob {
  id: string;
  avatarProfileId: string;
  readingId?: string;
  segmentId?: string;
  audioAssetId?: string;
  outputAssetId?: string;
  status: AvatarRenderJobStatus;
  progress: number;
  durationMs?: number;
  cacheKey?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  failureReason?: string;
}

export interface DigitalHumanJob {
  id: string;
  kind: 'VOICE_CLONE' | 'VOICE_PREVIEW' | 'AVATAR_PREP';
  profileId: string;
  status: VoiceJobStatus;
  stage: string;
  progress: number;
  dedupeKey?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface DigitalHumanPreset {
  id: string;
  name: string;
  avatarProfileId?: string;
  voiceProfileId?: string;
  language: ContentLanguage | 'yue';
  speechLocale?: VoiceTargetLocale;
  targetCountry?: string;
  accentProfileId?: string;
  speed: number;
  emotion: 'CALM' | 'WARM' | 'SERIOUS' | 'ENERGETIC';
  lipStrength: number;
  mouthCloseThreshold: number;
  audioVideoOffsetMs: number;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
}

export interface DigitalHumanBroadcastItem {
  id: string;
  source: 'READING' | 'MANUAL' | 'SCRIPT';
  readingId?: string;
  text: string;
  action: AvatarActionName;
  presetSnapshot: DigitalHumanPreset;
  status: 'QUEUED' | 'PREBUFFERING' | 'READY' | 'PLAYING' | 'PAUSED' | 'FINISHED' | 'SKIPPED' | 'FAILED';
  renderJobIds: string[];
  segmentCount?: number;
  currentSegment?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  failureReason?: string;
}

export interface AvatarMediaReadyEvent {
  sourceInstanceId: string;
  renderJobId: string;
  outputAssetId: string;
  mediaEpoch: number;
  readyAt: number;
}

export interface AudioBusSettings {
  enabled: boolean;
  outputDeviceName: string;
  requireExactDevice: boolean;
  muteBrowserAudio: true;
  sampleRate: 24000 | 48000;
}

export interface AvatarSession {
  sessionId: string;
  profileId: string;
  provider: AvatarProfileProvider;
  status: 'PREPARING' | 'READY' | 'SPEAKING' | 'FINISHED' | 'FAILED';
  readingId?: string;
  startedAt?: number;
  endedAt?: number;
  lastError?: string;
}

export interface AvatarRuntimeStatus {
  profileId?: string;
  provider: AvatarProfileProvider | 'NONE';
  status: AdapterStatus;
  action: AvatarActionName;
  session?: AvatarSession;
  vramBudgetMb: 11264;
  renderFps: 30;
  lastError?: string;
  checkedAt: number;
}

export interface ProviderSecretStatus {
  llm: { configured: boolean; storedWithDpapi: boolean; fromEnvironment: boolean };
  tts: { configured: boolean; storedWithDpapi: boolean; fromEnvironment: boolean; reusesLlmKey: boolean };
  voiceClone: { configured: boolean; storedWithDpapi: boolean; fromEnvironment: boolean };
  avatarClone: { configured: boolean; storedWithDpapi: boolean; fromEnvironment: boolean };
  voiceCloneAliyun: { configured: boolean; storedWithDpapi: boolean; fromEnvironment: boolean };
  voiceCloneBaidu: { configured: boolean; storedWithDpapi: boolean; fromEnvironment: boolean };
  avatarCloneAliyun: { configured: boolean; storedWithDpapi: boolean; fromEnvironment: boolean };
  avatarCloneBaidu: { configured: boolean; storedWithDpapi: boolean; fromEnvironment: boolean };
}

export interface VTubeStudioModelProfile {
  modelLoaded: boolean;
  modelId?: string;
  modelName?: string;
  requiredParameters: string[];
  missingParameters: string[];
  requiredHotkeys: string[];
  missingHotkeys: string[];
  checkedAt: number;
}

export interface VTubeStudioConnectionState {
  status: AdapterStatus;
  url: string;
  connected: boolean;
  authenticated: boolean;
  model?: VTubeStudioModelProfile;
  reconnectAttempts: number;
  lastConnectedAt?: number;
  lastError?: string;
}

export interface AudioSourceLease {
  sourceInstanceId: string;
  leaseId: string;
  acquiredAt: number;
  expiresAt: number;
  active: boolean;
}

export interface SyncMetrics {
  activeAudioSources: number;
  activeLease?: AudioSourceLease;
  lastAudioStartedAt?: number;
  lastAudioEndedAt?: number;
  lastLipSyncTickAt?: number;
  lipSchedulerDriftMs?: number;
  subtitleDriftMs?: number;
  lastFailure?: { code: string; message: string; at: number };
}

export interface LiveEventInboxItem {
  id: number;
  source: 'tikfinity';
  eventId: string;
  kind: 'chat' | 'gift' | 'like';
  payload: LiveChatEvent | LiveGiftEvent | LiveLikeEvent;
  status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';
  receivedAt: number;
  processedAt?: number;
  error?: string;
}

export interface TikfinityDiagnostics {
  status: AdapterStatus;
  connected: boolean;
  verified: boolean;
  url: string;
  lastConnectedAt?: number;
  lastEventAt?: number;
  reconnectAttempts: number;
  events: Record<'chat' | 'gift' | 'like' | 'follow' | 'share' | 'unknown', number>;
  /** Operator-facing projection; raw TikTok metadata remains in the inbox only. */
  recentSamples: Array<{
    event: string;
    receivedAt: number;
    fields: string[];
    username?: string;
    message?: string;
    giftName?: string;
    repeatCount?: number;
    likeCount?: number;
  }>;
  lastError?: string;
}

export interface AppSettings {
  queue: QueueSettings;
  moderation: ModerationSettings;
  reading: ReadingSettings;
  meihua: MeihuaEngineSettings;
  gifts: GiftSettings;
  engagement: EngagementSettings;
  overlay: { disclaimer: string; contentLanguage: ContentLanguage; effects: OverlayEffects; modules: Record<OverlayModuleId, OverlayModuleSettings> };
  providers: ProviderSettings;
  audioBus: AudioBusSettings;
  presentation: PresentationSettings;
}

export interface AppSettingsPatch {
  queue?: Partial<QueueSettings>;
  moderation?: Partial<ModerationSettings>;
  reading?: Partial<ReadingSettings>;
  meihua?: Partial<MeihuaEngineSettings>;
  gifts?: Partial<Omit<GiftSettings, 'rules'>> & { rules?: GiftRule[] };
  engagement?: Partial<Omit<EngagementSettings, 'likeRules' | 'commentRules'>> & { likeRules?: LikeRule[]; commentRules?: CommentRule[] };
  overlay?: Partial<Omit<AppSettings['overlay'], 'effects' | 'modules'>> & { effects?: Partial<OverlayEffects>; modules?: Partial<Record<OverlayModuleId, Partial<OverlayModuleSettings>>> };
  providers?: {
    liveInput?: Partial<ProviderSettings['liveInput']>;
    llm?: Partial<ProviderSettings['llm']>;
    tts?: Partial<ProviderSettings['tts']>;
    avatar?: Partial<ProviderSettings['avatar']>;
  };
  audioBus?: Partial<AudioBusSettings>;
  presentation?: Partial<Omit<PresentationSettings, 'profiles'>> & { profiles?: VideoPresentationProfile[] };
}

export interface AdapterHealth {
  id: string;
  label: string;
  status: AdapterStatus;
  message: string;
  configured: boolean;
}

export interface BlockedUser {
  userKey: string;
  username: string;
  reason: string;
  createdAt: number;
}

export interface AppEvent {
  id: number;
  readingId?: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface DashboardMetrics {
  completedLast30Minutes: number;
  failedLast30Minutes: number;
  averageQueueWaitMs: number;
  averageSpeakingMs: number;
}

export interface RuntimeHealth {
  autoProcessing: boolean;
  acceptingQuestions: boolean;
  currentReadingId?: string;
  replayReadingId?: string;
  queueLength: number;
  input: AdapterStatus;
  llm: AdapterStatus;
  tts: AdapterStatus;
  avatar: AdapterStatus;
  avatarProvider?: AvatarProviderAdapterState;
  avatarRuntimeStatus?: AvatarRuntimeStatus;
  overlayClients: number;
  uptimeMs: number;
  providers: AdapterHealth[];
  tikfinity?: TikfinityDiagnostics;
  vtube?: VTubeStudioConnectionState;
  sync?: SyncMetrics;
  metrics: DashboardMetrics;
  currentSession?: LiveSession;
  currentStage?: DirectorStage;
  activeCue?: DirectorCue;
}

export type OverlayMessage =
  | { type: 'SNAPSHOT'; payload: OverlayState }
  | { type: 'STATE_CHANGED'; payload: OverlayState }
  | { type: 'QUEUE_CHANGED'; payload: OverlayState['queue'] }
  | { type: 'HEARTBEAT'; ts: number };
