import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ActivityIcon as Activity } from '@phosphor-icons/react/Pulse';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react/ArrowCounterClockwise';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { BroadcastIcon as Broadcast } from '@phosphor-icons/react/Broadcast';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/CaretRight';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle';
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from '@phosphor-icons/react/ClockCounterClockwise';
import { DatabaseIcon as Database } from '@phosphor-icons/react/Database';
import { GiftIcon as Gift } from '@phosphor-icons/react/Gift';
import { HeartIcon as Heart } from '@phosphor-icons/react/Heart';
import { HouseLineIcon as HouseLine } from '@phosphor-icons/react/HouseLine';
import { LightningIcon as Lightning } from '@phosphor-icons/react/Lightning';
import { ListNumbersIcon as ListNumbers } from '@phosphor-icons/react/ListNumbers';
import { MonitorPlayIcon as MonitorPlay } from '@phosphor-icons/react/MonitorPlay';
import { PaletteIcon as Palette } from '@phosphor-icons/react/Palette';
import { PauseIcon as Pause } from '@phosphor-icons/react/Pause';
import { PlayIcon as Play } from '@phosphor-icons/react/Play';
import { PlugIcon as Plug } from '@phosphor-icons/react/Plug';
import { RadioIcon as Radio } from '@phosphor-icons/react/Radio';
import { SkipForwardIcon as SkipForward } from '@phosphor-icons/react/SkipForward';
import { SpeakerHighIcon as SpeakerHigh } from '@phosphor-icons/react/SpeakerHigh';
import { SquaresFourIcon as SquaresFour } from '@phosphor-icons/react/SquaresFour';
import { StickerIcon as Sticker } from '@phosphor-icons/react/Sticker';
import { StopIcon as Stop } from '@phosphor-icons/react/Stop';
import { TextAaIcon as TextAa } from '@phosphor-icons/react/TextAa';
import { TimerIcon as Timer } from '@phosphor-icons/react/Timer';
import { UserCircleIcon as UserCircle } from '@phosphor-icons/react/UserCircle';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/WarningCircle';
import { WifiHighIcon as WifiHigh } from '@phosphor-icons/react/WifiHigh';
import { XIcon as X } from '@phosphor-icons/react/X';
import type {
  AppEvent, AppSettings, BroadcastSnapshotV2, DirectorCue, LiveSession, MediaAsset, MediaAssetKind,
  ObsSourceConfig, ObsSourceId, OperationalDataRecalculationReport, ProviderSecretStatus, Reading, RuntimeHealth, SceneProfileVersion,
  VoiceProfile, QueueOverviewEntry, SceneElement,
} from '@meihua/core-types';
import { resolveBackgroundMode } from '@meihua/core-types';
import type { SceneProfile } from '@meihua/core-types';
import { englishGiftName, giftGlyph, giftIconUrl, referenceGiftCatalog, type GiftCatalogEntry } from './giftCatalog.js';
import { adminRequest as request, apiBase, authenticatedMediaUrl, controlToken, overlayBase, productionMode } from './adminApi.js';
import { StudioWorkbench } from './StudioWorkbench.js';
import { DigitalHumanStudio } from './DigitalHumanStudio.js';

type Tab = 'live' | 'avatar' | 'simple' | 'obs' | 'connect' | 'records';
type QueueRow = { readingId: string; username: string; question?: string; priority: Reading['priority']; waitingMs: number; giftName?: string; expiresAt?: number; qualification?: Reading['qualification'] };
type LiveCaptureItem = { id: number; kind: 'chat' | 'gift' | 'like'; receivedAt: number; status: string; username?: string; message?: string; giftId?: string; giftName?: string; repeatCount?: number; likeCount?: number };
type InteractionFilter = 'all' | LiveCaptureItem['kind'];
type PendingQualification = { id: string; username: string; kind: 'GIFT' | 'LIKE' | 'COMMENT_KEYWORD'; label: string; speechTargetSeconds: number; createdAt: number; expiresAt: number };
type CapturedGift = { giftId?: string; giftName: string; coinValue?: number; lastSeenAt: number; count: number };
type DirectorState = { session?: LiveSession; stage: string; activeCue?: DirectorCue; snapshot: BroadcastSnapshotV2 };
type Preflight = { ready: boolean; checks: Array<{ id: string; label: string; status: 'PASS' | 'WARN' | 'FAIL'; message: string }> };
type DigitalHumanStatus = {
  gptsovits: { baseUrl: string; ok: boolean; detail: string; voices: number };
  musetalk: { baseUrl: string; ok: boolean; detail: string; avatars: string[] };
};
type VoicePack = { id: string; name: string; refAudioPath: string; refText: string; refLanguage: string; createdAt: number };
type CanvasBox = { x: number; y: number; width: number; height: number };
type CanvasLayout = Partial<Record<ObsSourceId, CanvasBox>>;

function LiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return <div className="clock"><span>{now.toLocaleDateString('zh-CN', { weekday: 'short' })}</span><strong>{now.toLocaleTimeString('zh-CN', { hour12: false })}</strong></div>;
}

const tabs: Array<{ id: Tab; label: string; note: string }> = [
  { id: 'live', label: '总控台', note: '节目监看与导演控制' },
  { id: 'avatar', label: '数字人中心', note: '克隆声音、人物并选择使用' },
  { id: 'connect', label: '接入与播报', note: '大模型、声音、画面与开播前检查' },
  { id: 'obs', label: '画面工作台', note: 'OBS 来源、文字与主题' },
  { id: 'simple', label: '资格与队列', note: '点赞、礼物和提问规则' },
  { id: 'records', label: '数据记录', note: '榜单、测算与审计' },
];

const tabIcons: Record<Tab, ReactNode> = {
  live: <HouseLine weight="fill" />,
  avatar: <UserCircle weight="fill" />,
  obs: <MonitorPlay weight="fill" />,
  simple: <ListNumbers weight="fill" />,
  connect: <Plug weight="fill" />,
  records: <ClockCounterClockwise weight="fill" />,
};

const themePresets = [
  { id: 'amber', name: '琥珀夜场', text: '#fff4d6', accent: '#e8ad43', background: '#11100d', brightness: 1, glow: 0.65, font: 'Microsoft YaHei' },
  { id: 'jade', name: '翡翠直播', text: '#e5fff4', accent: '#22c984', background: '#071510', brightness: 1, glow: 0.5, font: 'Inter' },
  { id: 'blue', name: '冰蓝科技', text: '#edf7ff', accent: '#4ca6ff', background: '#07121d', brightness: 1.05, glow: 0.72, font: 'Arial' },
  { id: 'ink', name: '水墨雅韵', text: '#f4efe5', accent: '#caa66a', background: '#151412', brightness: 0.95, glow: 0.28, font: 'Microsoft YaHei' },
  { id: 'mono', name: '高对比', text: '#ffffff', accent: '#ffffff', background: '#050505', brightness: 1.15, glow: 0.15, font: 'Arial' },
  { id: 'rose', name: '绛红古典', text: '#fff0e9', accent: '#e87965', background: '#1a0c0c', brightness: 1, glow: 0.58, font: 'Microsoft YaHei' },
  { id: 'violet', name: '紫微星幕', text: '#f7f0ff', accent: '#a887ff', background: '#0e0a18', brightness: 1.05, glow: 0.7, font: 'Inter' },
  { id: 'sand', name: '暖砂纸感', text: '#2a2118', accent: '#a7672f', background: '#eee0c7', brightness: 1, glow: 0.08, font: 'Georgia' },
] as const;

const stageNames: Record<string, string> = {
  IDLE: '等待观众', QUALIFIED: '资格已确认', SELECTED: '已选中观众', CASTING: '正在起卦',
  INTERPRETING: '卦理解读', COMPOSING: '生成解读', SYNTHESIZING: '合成语音', SPEAKING: '正在播报',
  FINISH: '本轮完成', ERROR: '流程异常', PAUSED: '接入暂停',
};

const sourceNames: Record<ObsSourceId, string> = {
  sticker: '自定义贴纸', avatar: '播报画面（视频 / 数字人）', background: '直播背景', 'current-viewer': '当前用户 · 问题 · 卦名', hexagram: '卦象与当前测算', subtitles: '动态口播字幕', queue: '资格与排队名单',
  'gift-alert': '礼物反馈', 'gift-ranking': '礼物榜', 'engagement-ranking': '互动榜', status: '直播状态', effects: '画面特效', disclaimer: '免责声明', audio: '唯一音频', 'meihua-stage': '正式直播舞台（推荐默认）', 'full-preview': '完整预览',
};

const obsSourceIds = (Object.keys(sourceNames) as ObsSourceId[]).filter((id) => id !== 'audio');
const canvasSourceIds: ObsSourceId[] = ['background', 'avatar', 'status', 'gift-alert', 'hexagram', 'queue', 'gift-ranking', 'engagement-ranking', 'subtitles', 'disclaimer', 'effects'];
const defaultCanvasLayout: CanvasLayout = {
  background: { x: 0, y: 0, width: 1080, height: 1920 },
  effects: { x: 0, y: 0, width: 1080, height: 1920 },
  status: { x: 60, y: 30, width: 960, height: 100 },
  'current-viewer': { x: 60, y: 150, width: 960, height: 180 },
  'gift-alert': { x: 60, y: 350, width: 960, height: 170 },
  'gift-ranking': { x: 60, y: 545, width: 460, height: 380 },
  'engagement-ranking': { x: 560, y: 545, width: 460, height: 380 },
  avatar: { x: 30, y: 960, width: 500, height: 880 },
  hexagram: { x: 560, y: 960, width: 490, height: 560 },
  queue: { x: 560, y: 1540, width: 490, height: 350 },
  sticker: { x: 760, y: 40, width: 260, height: 260 },
  subtitles: { x: 30, y: 1860, width: 1020, height: 40 },
  disclaimer: { x: 30, y: 1760, width: 1020, height: 70 },
};
const speechDurationOptions = [20, 30, 40, 60, 90] as const;
const contentLanguageOptions: Array<{ value: AppSettings['overlay']['contentLanguage']; label: string; ttsHint: string }> = [
  { value: 'en', label: 'English · 英语', ttsHint: 'Kokoro / GPT-SoVITS / 云语音' },
  { value: 'zh-CN', label: '简体中文', ttsHint: 'Windows / GPT-SoVITS / 云语音' },
  { value: 'es', label: 'Español · 西班牙语', ttsHint: '多语言云语音' },
  { value: 'fr', label: 'Français · 法语', ttsHint: '多语言云语音' },
  { value: 'de', label: 'Deutsch · 德语', ttsHint: '多语言云语音' },
  { value: 'ja', label: '日本語 · 日语', ttsHint: 'GPT-SoVITS / 多语言云语音' },
  { value: 'ko', label: '한국어 · 韩语', ttsHint: 'GPT-SoVITS / 多语言云语音' },
  { value: 'pt', label: 'Português · 葡萄牙语', ttsHint: '多语言云语音' },
  { value: 'ru', label: 'Русский · 俄语', ttsHint: '多语言云语音' },
];

const recommendedQuestionKeywordGroups = [
  { label: '中文问法', values: ['测算', '测一卦', '算一卦', '起卦', '占卜', '解卦', '问卦', '梅花易数', '看卦', '帮我算', '帮我测', '请测', '想问', '适合吗', '可以吗', '能不能', '该不该', '要不要', '会不会', '如何', '怎么办', '怎么样', '什么时候', '何时', '有机会吗', '能成功吗', '值得吗', '选哪个', '？', '?'] },
  { label: '常见主题', values: ['换工作', '找工作', '事业发展', '适合创业', '生意如何', '项目能成吗', '什么时候发财', '财运如何', '投资适合吗', '买房合适吗', '搬家合适吗', '考试能过吗', '学业如何', '感情如何', '会复合吗', '桃花如何', '婚姻如何'] },
  { label: 'English', values: ['reading', 'fortune reading', 'divination', 'hexagram', 'meihua', 'cast for me', 'read me', 'give me a reading', 'should i', 'can i', 'could i', 'will i', 'when will', 'how can', 'which one', 'change jobs', 'career', 'business', 'money', 'finance', 'love', 'relationship', 'marriage', 'study', 'exam', 'move house', 'travel', 'decision'] },
  { label: '其他语言', values: ['lectura', 'adivinación', 'est-ce que', 'dois-je', 'deutung', 'sollte ich', '占って', '転職', '점쳐', '이직', 'leitura', 'quando', 'гадание', 'стоит ли'] },
] as const;
const recommendedQuestionKeywords = [...new Set(recommendedQuestionKeywordGroups.flatMap((group) => [...group.values]))];
const voicePresets = [
  { id: 'alloy', name: 'Alloy', note: '中性、稳定' },
  { id: 'coral', name: 'Coral', note: '温暖、清晰' },
  { id: 'nova', name: 'Nova', note: '明亮、自然' },
  { id: 'onyx', name: 'Onyx', note: '沉稳、厚实' },
  { id: 'sage', name: 'Sage', note: '克制、舒缓' },
  { id: 'shimmer', name: 'Shimmer', note: '轻盈、柔和' },
] as const;
const localVoicePresets = [
  { id: 'Microsoft Zira Desktop', name: '英文女声 · Zira', note: 'Windows 本地 / en-US / 根据当前文案合成' },
  { id: 'Microsoft Huihui Desktop', name: '中文女声 · Huihui', note: 'Windows 本地 / zh-CN / 根据当前文案合成' },
] as const;
const voiceDemoScripts = [
  { label: '英文解卦', text: 'Your primary hexagram suggests steady progress. Take one careful step, then review the real result before moving further.' },
  { label: '中文解卦', text: '本卦提示你先稳住节奏，从一个可以验证的小步骤开始，再根据实际反馈继续推进。' },
  { label: '西语解卦', text: 'El hexagrama principal recomienda avanzar con calma, comprobar un paso concreto y observar el resultado real.' },
] as const;

function elapsed(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return total < 60 ? `${total} 秒` : `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
}

function captureDescription(sample: LiveCaptureItem) {
  if (sample.kind === 'chat') return sample.message || '收到一条空评论';
  if (sample.kind === 'gift') return `${sample.giftName ?? '未知礼物'}${sample.repeatCount && sample.repeatCount > 1 ? ` × ${sample.repeatCount}` : ''}`;
  return `本次点赞 +${sample.likeCount ?? 0}`;
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function Pill({ status }: { status: string }) { return <span className={`pill pill-${status.toLocaleLowerCase()}`}>{status}</span>; }

function SourceIcon({ sourceId }: { sourceId: ObsSourceId }) {
  if (sourceId === 'sticker') return <Sticker weight="fill" />;
  if (sourceId === 'avatar' || sourceId === 'current-viewer') return <UserCircle weight="fill" />;
  if (sourceId === 'background' || sourceId === 'full-preview') return <MonitorPlay weight="fill" />;
  if (sourceId === 'hexagram') return <SquaresFour weight="fill" />;
  if (sourceId === 'queue') return <ListNumbers weight="fill" />;
  if (sourceId === 'gift-alert' || sourceId === 'gift-ranking') return <Gift weight="fill" />;
  if (sourceId === 'engagement-ranking') return <Heart weight="fill" />;
  if (sourceId === 'status') return <Radio weight="fill" />;
  if (sourceId === 'effects') return <Lightning weight="fill" />;
  if (sourceId === 'disclaimer') return <WarningCircle weight="fill" />;
  return <TextAa weight="fill" />;
}

function Panel({ title, hint, action, children, className = '', intakeNote }: { title: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string; intakeNote?: string }) {
  return <section className={`panel ${className}`}><header><div><h2>{title}</h2>{hint && <p>{hint}</p>}</div>{action}</header>{intakeNote && <div className="notice intake-notice"><CheckCircle weight="fill" />{intakeNote}</div>}{children}</section>;
}

function eventSummary(payload: unknown) {
  if (payload === null || payload === undefined) return '无附加信息';
  if (typeof payload !== 'object') return String(payload);
  const entries = Object.entries(payload as Record<string, unknown>)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return entries.length ? entries.join(' · ') : `${Object.keys(payload as object).length} 项结构化信息`;
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return <button onClick={() => { void navigator.clipboard.writeText(value); setDone(true); window.setTimeout(() => setDone(false), 1_200); }}>{done ? '已复制' : '复制地址'}</button>;
}

function SimpleUploader({ purpose, onDone, onError = (message) => window.alert(message) }: { purpose: 'avatar' | 'background' | 'sticker'; onDone: () => Promise<void>; onError?: (message: string) => void }) {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file);
      });
      const video = file.type.startsWith('video/');
      const kind = purpose === 'sticker' ? 'STICKER_IMAGE' : `${purpose === 'avatar' ? 'AVATAR' : 'BACKGROUND'}_${video ? 'VIDEO' : 'IMAGE'}` as MediaAssetKind;
      await request('/api/media-assets', { method: 'POST', body: JSON.stringify({ kind, fileName: file.name, mimeType: file.type, base64 }) });
      setFile(undefined); await onDone();
    } catch (error) {
      onError(error instanceof Error ? error.message : '上传失败，请检查素材格式后重试');
    } finally { setBusy(false); }
  };
  return <div className="upload-simple"><label>{purpose === 'avatar' ? '选择人物图片或视频' : purpose === 'sticker' ? '选择贴纸图片（PNG/WebP 透明底最佳）' : '选择背景图片或视频'}<input type="file" accept={purpose === 'sticker' ? 'image/png,image/webp,image/svg+xml' : 'image/png,image/webp,video/webm,video/mp4'} onChange={(event) => setFile(event.target.files?.[0])} /></label><button disabled={!file || busy} onClick={() => void upload()}>{busy ? '正在上传…' : '上传素材'}</button></div>;
}

function AssetLibraryUploader({ kind, onDone }: { kind: 'OVERLAY_IMAGE' | 'LUX3D_MODEL'; onDone: () => Promise<void> }) {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(file);
      });
      await request('/api/media-assets', { method: 'POST', body: JSON.stringify({ kind, fileName: file.name, mimeType: kind === 'LUX3D_MODEL' ? 'model/gltf-binary' : file.type, base64 }) });
      setFile(undefined);
      await onDone();
    } finally { setBusy(false); }
  };
  const isModel = kind === 'LUX3D_MODEL';
  return <div className="upload-simple material-upload">
    <label>{isModel ? '上传 GLB 3D 模型' : '上传透明 PNG 或 WebP 装饰素材'}<input type="file" accept={isModel ? '.glb,model/gltf-binary' : 'image/png,image/webp'} onChange={(event) => setFile(event.target.files?.[0])} /></label>
    <button disabled={!file || busy} onClick={() => void upload()}>{busy ? '正在上传…' : isModel ? '加入 3D 素材库' : '加入素材库'}</button>
  </div>;
}

function AssetLibraryModal({
  assets, sourceAssetId, lux3dAssetId, onClose, onDone, onBindSource, onBindLux3D,
}: {
  assets: MediaAsset[];
  sourceAssetId?: string;
  lux3dAssetId?: string;
  onClose: () => void;
  onDone: () => Promise<void>;
  onBindSource: (assetId?: string) => void;
  onBindLux3D: (assetId?: string) => void;
}) {
  const decorationAssets = assets.filter((asset) => ['BACKGROUND_IMAGE', 'STICKER_IMAGE', 'OVERLAY_IMAGE'].includes(asset.kind));
  const lux3dAssets = assets.filter((asset) => ['LUX3D_MODEL', 'OVERLAY_IMAGE'].includes(asset.kind));
  return <div className="studio-modal-v5 material-library-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="asset-modal-v5">
      <header><div><b>素材库</b><small>系统预置素材与上传素材统一管理；绑定后自动保存到场景草稿。</small></div><button onClick={onClose}>关闭</button></header>
      <div className="material-library-controls">
        <AssetLibraryUploader kind="OVERLAY_IMAGE" onDone={onDone} />
        <AssetLibraryUploader kind="LUX3D_MODEL" onDone={onDone} />
        <label>当前模块装饰<select value={sourceAssetId ?? ''} onChange={(event) => onBindSource(event.target.value || undefined)}><option value="">不使用装饰素材</option>{decorationAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.origin === 'SYSTEM' ? '系统 · ' : ''}{asset.fileName}</option>)}</select></label>
        <label>玄金罗盘核心<select value={lux3dAssetId ?? ''} onChange={(event) => onBindLux3D(event.target.value || undefined)}><option value="">系统默认黑金盘</option>{lux3dAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.origin === 'SYSTEM' ? '系统 · ' : ''}{asset.fileName}</option>)}</select></label>
      </div>
      <div className="material-library-grid">{assets.map((asset) => <article key={asset.id} className={asset.origin === 'SYSTEM' ? 'is-system' : ''}>
        {asset.kind === 'LUX3D_MODEL' ? <div className="material-model-thumb">3D<br />GLB</div> : <img src={authenticatedMediaUrl(asset.id)} alt={asset.fileName} onError={(event) => { event.currentTarget.style.display = 'none'; event.currentTarget.closest('article')?.classList.add('is-missing'); }} />}
        <div><b>{asset.fileName}</b><small>{asset.origin === 'SYSTEM' ? '系统预置 · 不可删除' : '已上传'} · {asset.kind}</small></div>
      </article>)}</div>
    </section>
  </div>;
}

function PresentationPanel({ settings, assets, onSaved }: { settings: AppSettings; assets: MediaAsset[]; onSaved: () => Promise<void> }) {
  const [videoFile, setVideoFile] = useState<File>();
  const [videoName, setVideoName] = useState('默认预录人物视频');
  const [busy, setBusy] = useState('');
  const presentation = settings.presentation;
  const videoAssets = assets.filter((asset) => asset.mimeType.startsWith('video/'));
  const save = async (patch: Record<string, unknown>) => {
    setBusy('save');
    try {
      await request('/api/presentation/settings', { method: 'PUT', body: JSON.stringify(patch) });
      await onSaved();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '画面设置保存失败');
    } finally { setBusy(''); }
  };
  const profileAction = async (profileId: string, action: 'validate' | 'disable') => {
    setBusy(action);
    try {
      await request(`/api/presentation/videos/${encodeURIComponent(profileId)}/${action}`, { method: 'POST' });
      await onSaved();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '视频档案操作失败');
    } finally { setBusy(''); }
  };
  const upload = async () => {
    if (!videoFile) return;
    setBusy('upload');
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(videoFile);
      });
      const asset = await request<MediaAsset>('/api/media-assets', { method: 'POST', signal: AbortSignal.timeout(10 * 60_000), body: JSON.stringify({ kind: 'BACKGROUND_VIDEO', fileName: videoFile.name, mimeType: videoFile.type || 'video/mp4', base64 }) });
      const playback = presentation.mode === 'VIDEO_ONCE' ? 'ONCE' : 'LOOP';
      const profile = await request<{ profile: AppSettings['presentation']['profiles'][number] }>('/api/presentation/videos', { method: 'POST', body: JSON.stringify({ name: videoName.trim() || videoFile.name, assetId: asset.id, playback, fit: 'COVER' }) });
      await request('/api/presentation/videos/' + encodeURIComponent(profile.profile.id) + '/activate', { method: 'POST' });
      setVideoFile(undefined);
      await onSaved();
    } finally { setBusy(''); }
  };
  const active = presentation.profiles.find((profile) => profile.id === presentation.activeVideoProfileId);
  const fallback = presentation.profiles.find((profile) => profile.id === presentation.fallbackVideoProfileId);
  const assetUrl = (assetId: string) => authenticatedMediaUrl(assetId);
  return <Panel className="presentation-panel" title="画面模式 · 统一播报" hint="默认用预录视频保证链路稳定；只有选择实时数字人时才会调用 MuseTalk 或云端数字人。">
    <div className="presentation-console">
      <div className="presentation-mode-grid">
        <label>播报画面<select value={presentation.mode} onChange={(event) => void save({ mode: event.target.value })} disabled={busy !== ''}>
          <option value="VIDEO_LOOP">预录视频循环（推荐）</option>
          <option value="VIDEO_ONCE">预录视频单次</option>
          <option value="DIGITAL_HUMAN">实时数字人</option>
          <option value="AUDIO_ONLY">仅声音</option>
        </select></label>
        <label>数字人失败策略<select value={presentation.fallbackPolicy} onChange={(event) => void save({ fallbackPolicy: event.target.value })} disabled={busy !== ''}>
          <option value="VIDEO">切备用视频（推荐）</option>
          <option value="STRICT">严格阻止开播</option>
          <option value="AUDIO_ONLY">只保留声音</option>
        </select></label>
      </div>
      <div className="presentation-status-strip">
        <span className="status-dot" />
        <b>{presentation.mode === 'DIGITAL_HUMAN' ? '实时数字人模式' : presentation.mode === 'AUDIO_ONLY' ? '仅声音模式' : '预录视频模式'}</b>
        <small>{active ? `默认：${active.name}` : '还没有可用的默认视频'}{fallback ? ` · 备用：${fallback.name}` : ''}</small>
      </div>
      <div className="presentation-upload-row">
        <label>视频名称<input value={videoName} onChange={(event) => setVideoName(event.target.value)} /></label>
        <label>上传预录视频<input type="file" accept="video/mp4,video/webm" onChange={(event) => setVideoFile(event.target.files?.[0])} /></label>
        <button className="primary" disabled={!videoFile || busy !== ''} onClick={() => void upload()}>{busy === 'upload' ? '处理中…' : '上传并设为默认'}</button>
      </div>
      <div className="presentation-profile-list">
        {presentation.profiles.map((profile) => {
          const asset = assets.find((item) => item.id === profile.assetId);
          return <article key={profile.id} className={profile.id === presentation.activeVideoProfileId ? 'is-active' : ''}>
            {asset ? <video src={assetUrl(asset.id)} muted playsInline controls preload="metadata" /> : <div className="presentation-missing">素材缺失</div>}
            <div><b>{profile.name}</b><small>{profile.status} · {profile.durationMs ? `${Math.round(profile.durationMs / 1000)} 秒` : '未测时长'} · {profile.playback === 'LOOP' ? '循环' : '单次'}</small></div>
            <div className="presentation-actions"><button disabled={busy !== '' || profile.status !== 'READY'} onClick={() => void save({ activeVideoProfileId: profile.id })}>设为默认</button><button disabled={busy !== '' || profile.status !== 'READY'} onClick={() => void save({ fallbackVideoProfileId: profile.id })}>设为备用</button><button disabled={busy !== ''} onClick={() => void profileAction(profile.id, 'validate')}>{profile.status === 'READY' ? '复核' : '校验'}</button><button disabled={busy !== ''} onClick={() => void profileAction(profile.id, 'disable')}>停用</button></div>
          </article>;
        })}
        {!presentation.profiles.length && <div className="empty">上传一个 MP4/WebM，系统会先标准化并校验可播放时长。</div>}
      </div>
      <small className="truth-note">预录视频始终静音，声音从唯一 Audio Bus 输出；实时数字人未就绪时不会偷偷切换 VRM，只按上面的策略处理。</small>
    </div>
  </Panel>;
}

export function App() {
  const [tab, setTab] = useState<Tab>('live');
  const [health, setHealth] = useState<RuntimeHealth>();
  const [settings, setSettings] = useState<AppSettings>();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [director, setDirector] = useState<DirectorState>();
  const [preflight, setPreflight] = useState<Preflight>();
  const [draft, setDraft] = useState<SceneProfileVersion>();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [captureHistory, setCaptureHistory] = useState<LiveCaptureItem[]>([]);
  const [interactionFilter, setInteractionFilter] = useState<InteractionFilter>('all');
  const [interactionResetAt, setInteractionResetAt] = useState(0);
  const [recalculationPreview, setRecalculationPreview] = useState<OperationalDataRecalculationReport>();
  const [recalculationOpen, setRecalculationOpen] = useState(false);
  const [pendingQualifications, setPendingQualifications] = useState<PendingQualification[]>([]);
  const [queueOverview, setQueueOverview] = useState<QueueOverviewEntry[]>([]);
  const [capturedGifts, setCapturedGifts] = useState<CapturedGift[]>([]);
  const [secretStatus, setSecretStatus] = useState<ProviderSecretStatus>();
  const [llmApiKey, setLlmApiKey] = useState('');
  const [ttsApiKey, setTtsApiKey] = useState('');
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfile[]>([]);
  const [voiceSample, setVoiceSample] = useState<File>();
  const [voiceName, setVoiceName] = useState('');
  const [voiceAuthorized, setVoiceAuthorized] = useState(false);
  const [voiceDemoText, setVoiceDemoText] = useState<string>(voiceDemoScripts[0].text);
  const [dhStatus, setDhStatus] = useState<DigitalHumanStatus>();
  const [voicePackName, setVoicePackName] = useState('');
  const [voicePackFile, setVoicePackFile] = useState<File>();
  const [voicePackText, setVoicePackText] = useState('');
  const [voicePackLang, setVoicePackLang] = useState<'zh' | 'en'>('en');
  const [avatarVideoPath, setAvatarVideoPath] = useState('');
  const [dataRailOpen, setDataRailOpen] = useState(true);
  const [wsConnected, setWsConnected] = useState(true);
  const wsConnectedRef = useRef(true);
  const setWsBoth = (value: boolean) => { wsConnectedRef.current = value; setWsConnected(value); };
  const [linkageReport, setLinkageReport] = useState<{ ok: boolean; username: string; afterGift?: QueueOverviewEntry; afterQuestion?: QueueOverviewEntry }>();
  const [selectedSource, setSelectedSource] = useState<ObsSourceId>('status');
  const [inspectorTab, setInspectorTab] = useState<'content' | 'appearance' | 'motion'>('content');
  const [leftPaletteOpen, setLeftPaletteOpen] = useState(true);
  const [rightPaletteOpen, setRightPaletteOpen] = useState(true);
  const [floatingPreviewOpen, setFloatingPreviewOpen] = useState(true);
  const [obsView, setObsView] = useState<'list' | 'canvas'>('canvas');
  const [selectedElementId, setSelectedElementId] = useState<string>();
  const elementDragRef = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: { x: number; y: number; width: number; height: number } } | undefined>(undefined);

  const patchElements = (updater: (list: NonNullable<SceneProfile['elements']>) => NonNullable<SceneProfile['elements']>) => setDraft((current) => {
    if (!current) return current;
    const next = { ...current, profile: { ...current.profile, elements: updater(current.profile.elements ?? []) } };
    scheduleAutoApplyRef.current?.(next.profile);
    return next;
  });

  const addSceneElement = (kind: 'image' | 'text') => {
    const id = `el-${Date.now().toString(36)}`;
    const el = kind === 'text'
      ? { id, kind: 'text' as const, text: '双击右侧属性面板编辑文字', x: 340, y: 700, width: 400, height: 80, fontSize: 42, color: '#fff5d6', opacity: 1, zIndex: 50 }
      : { id, kind: 'image' as const, x: 380, y: 520, width: 320, height: 320, opacity: 1, zIndex: 50 };
    patchElements((list) => [...list, el]);
    setSelectedElementId(id);
  };

  const updateSceneElement = (id: string, patch: Partial<SceneElement>) => patchElements((list) => list.map((el) => (el.id === id ? { ...el, ...patch } : el)));

  const removeSceneElement = (id: string) => {
    patchElements((list) => list.filter((el) => el.id !== id));
    setSelectedElementId(undefined);
  };

  const reorderSceneElement = (id: string, direction: 'front' | 'back') => patchElements((list) => {
    const index = list.findIndex((el) => el.id === id);
    if (index < 0) return list;
    const target = direction === 'front' ? list.length - 1 : 0;
    const copy = [...list];
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    return copy;
  });

  const beginElementDrag = (event: ReactPointerEvent<HTMLElement>, el: SceneElement, mode: 'move' | 'resize') => {
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    elementDragRef.current = { id: el.id, mode, startX: event.clientX, startY: event.clientY, orig: { x: el.x, y: el.y, width: el.width, height: el.height } };
  };
  const moveElementDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = elementDragRef.current;
    if (!drag) return;
    const scale = canvasZoom / 100;
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    if (drag.mode === 'move') updateSceneElement(drag.id, { x: Math.round(drag.orig.x + dx), y: Math.round(drag.orig.y + dy) });
    else updateSceneElement(drag.id, { width: Math.max(24, Math.round(drag.orig.width + dx)), height: Math.max(24, Math.round(drag.orig.height + dy)) });
  };
  const endElementDrag = () => { elementDragRef.current = undefined; };
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [sourceDirectoryOpen, setSourceDirectoryOpen] = useState(false);
  const [giftLibraryOpen, setGiftLibraryOpen] = useState(false);
  const [giftSearch, setGiftSearch] = useState('');
  const [canvasZoom, setCanvasZoom] = useState(60);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridVisible, setGridVisible] = useState(true);
  const [canvasLayout, setCanvasLayout] = useState<CanvasLayout>(defaultCanvasLayout);
  const canvasLayoutSynced = useRef(false);
  const [floatingPreviewPos, setFloatingPreviewPos] = useState({ x: 390, y: 390 });
  const [floatingPreviewSize, setFloatingPreviewSize] = useState<{ width: number; height: number }>();
  const floatingResizeRef = useRef<{ startX: number; startY: number; originW: number; originH: number } | undefined>(undefined);
  const [recordView, setRecordView] = useState<'readings' | 'events'>('readings');
  const [recordQuery, setRecordQuery] = useState('');
  const [recordStatus, setRecordStatus] = useState('ALL');
  const [recordDate, setRecordDate] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [authExpired, setAuthExpired] = useState(false);
  const ttsPersistTimerRef = useRef<number>(0);
  const llmPersistTimerRef = useRef<number>(0);
  const liveInputPersistTimerRef = useRef<number>(0);
  const canvasInteractionRef = useRef<{ mode: 'move' | 'resize'; sourceId: ObsSourceId; dir: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'; startX: number; startY: number; startBox: CanvasBox } | undefined>(undefined);
  const floatingDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | undefined>(undefined);

  const notify = useCallback((message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3_500); }, []);
  const refreshingRef = useRef(false);
  const refresh = async (replaceEditable = false) => {
    if (refreshingRef.current) return; // 重入保护：上一轮未完成直接跳过，防请求雪崩
    refreshingRef.current = true;
    try { await refreshInner(replaceEditable); } finally { refreshingRef.current = false; }
  };
  const refreshInner = async (replaceEditable = false) => {
    // 单项失败只跳过该项（沿用旧值），绝不让整个刷新链挂掉导致页面空白
    const settle = <T,>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (): { ok: false } => ({ ok: false }));
    // 全部先并发发出，再逐个收割（保留各自类型）
    const healthPr = request<RuntimeHealth>('/api/health');
    const settingsPr = request<AppSettings>('/api/settings');
    const queuePr = request<QueueRow[]>('/api/queue');
    const overviewPr = request<QueueOverviewEntry[]>('/api/queue/overview');
    const directorPr = request<DirectorState>('/api/director/state');
    const preflightPr = request<Preflight>('/api/preflight?mode=LIVE');
    const draftPr = request<SceneProfileVersion>('/api/scene-profile/draft');
    const assetsPr = request<MediaAsset[]>('/api/media-assets');
    const readingsPr = request<Reading[]>('/api/readings?limit=80');
    const eventsPr = request<AppEvent[]>('/api/logs?limit=100');
    const capturePr = request<LiveCaptureItem[]>('/api/live-events/recent?limit=20');
    const pendingPr = request<PendingQualification[]>('/api/qualifications/pending');
    const giftsPr = request<CapturedGift[]>('/api/live-events/gift-catalog');
    const secretsPr = request<ProviderSecretStatus>('/api/providers/secrets/status');
    const settingsRes = await settle(settingsPr);
    // Render the operator console from settings as soon as the core API is
    // available.  Health includes aggregate metrics and optional providers;
    // it must not hold the whole application at a blank loading screen.
    if (settingsRes.ok) setSettings((current) => replaceEditable || !current ? settingsRes.value : current);
    const healthRes = await settle(healthPr);
    const queueRes = await settle(queuePr);
    const overviewRes = await settle(overviewPr);
    const directorRes = await settle(directorPr);
    const preflightRes = await settle(preflightPr);
    const draftRes = await settle(draftPr);
    const assetsRes = await settle(assetsPr);
    const readingsRes = await settle(readingsPr);
    const eventsRes = await settle(eventsPr);
    const captureRes = await settle(capturePr);
    const pendingRes = await settle(pendingPr);
    const giftsRes = await settle(giftsPr);
    const secretsRes = await settle(secretsPr);
    const nextHealth = healthRes.ok ? healthRes.value : undefined;
    const nextSettings = settingsRes.ok ? settingsRes.value : undefined;
    const nextDraft = draftRes.ok ? draftRes.value : undefined;
    const hasAvatarAsset = nextDraft ? Object.values(nextDraft.profile.avatar.slots).some((slot) => slot.assetId) : false;
    if (nextHealth) setHealth(nextSettings && nextSettings.providers.avatar.adapter === 'none' && !hasAvatarAsset ? { ...nextHealth, avatar: 'NOT_CONFIGURED' } : nextHealth);
    if (queueRes.ok) setQueue(arrayOrEmpty<QueueRow>(queueRes.value));
    if (overviewRes.ok) setQueueOverview(arrayOrEmpty<QueueOverviewEntry>(overviewRes.value));
    if (directorRes.ok) setDirector(directorRes.value);
    if (preflightRes.ok) setPreflight(preflightRes.value);
    if (assetsRes.ok) setAssets(arrayOrEmpty<MediaAsset>(assetsRes.value));
    if (readingsRes.ok) setReadings(arrayOrEmpty<Reading>(readingsRes.value));
    if (eventsRes.ok) setEvents(arrayOrEmpty<AppEvent>(eventsRes.value));
    if (captureRes.ok) setCaptureHistory(arrayOrEmpty<LiveCaptureItem>(captureRes.value));
    if (pendingRes.ok) setPendingQualifications(arrayOrEmpty<PendingQualification>(pendingRes.value));
    if (giftsRes.ok) setCapturedGifts(arrayOrEmpty<CapturedGift>(giftsRes.value));
    if (secretsRes.ok) setSecretStatus(secretsRes.value);
    if (nextSettings) setSettings((current) => replaceEditable || !current ? nextSettings : current);
    setDraft((current) => {
      if (!canvasLayoutSynced.current && nextDraft) {
        canvasLayoutSynced.current = true;
        const saved = nextDraft.profile.canvasPreviewLayout;
        if (saved && Object.keys(saved).length) setCanvasLayout((currentLayout) => ({ ...defaultCanvasLayout, ...saved }));
      }
      return replaceEditable || !current ? nextDraft : current;
    });
    if (healthRes.ok && draftRes.ok) {
      setAuthExpired(false);
      window.sessionStorage.removeItem('meihua-auth-reload-attempted');
    }
  };

  useEffect(() => {
    const handleExpired = () => {
      setAuthExpired(true);
      if (window.sessionStorage.getItem('meihua-auth-reload-attempted')) return;
      window.sessionStorage.setItem('meihua-auth-reload-attempted', '1');
      window.setTimeout(() => window.location.reload(), 900);
    };
    window.addEventListener('meihua-auth-expired', handleExpired);
    return () => window.removeEventListener('meihua-auth-expired', handleExpired);
  }, []);

  const refreshInteractionSnapshot = async () => {
    setBusy('refresh-interactions');
    try {
      const [nextCaptureHistory, nextHealth] = await Promise.all([
        request<LiveCaptureItem[]>('/api/live-events/recent?limit=50'),
        request<RuntimeHealth>('/api/health'),
      ]);
      // Replace the visible snapshot. Never append polling results, otherwise
      // the same TikFinity event appears repeatedly in the console.
      setCaptureHistory(arrayOrEmpty<LiveCaptureItem>(nextCaptureHistory));
      setHealth(nextHealth);
      notify('实时互动数据已刷新');
    } catch (error) {
      notify(error instanceof Error ? error.message : '实时互动刷新失败');
    } finally { setBusy(''); }
  };

  const refreshQueueSnapshot = async () => {
    setBusy('refresh-queue');
    try {
      const [nextQueue, nextQueueOverview, nextPendingQualifications] = await Promise.all([
        request<QueueRow[]>('/api/queue'),
        request<QueueOverviewEntry[]>('/api/queue/overview'),
        request<PendingQualification[]>('/api/qualifications/pending'),
      ]);
      setQueue(arrayOrEmpty<QueueRow>(nextQueue));
      setQueueOverview(arrayOrEmpty<QueueOverviewEntry>(nextQueueOverview));
      setPendingQualifications(arrayOrEmpty<PendingQualification>(nextPendingQualifications));
      notify('排队数据已刷新');
    } catch (error) {
      notify(error instanceof Error ? error.message : '排队数据刷新失败');
    } finally { setBusy(''); }
  };

  const resetInteractionSnapshot = () => {
    setInteractionResetAt(Date.now());
    setInteractionFilter('all');
    notify('实时互动已从当前时刻重新计数，历史记录仍保留在数据记录中');
  };

  const resetQueueSnapshot = async () => {
    if (!window.confirm('确认清空当前正式排队任务？\n\n礼物和点赞产生的待提问权益不会删除，历史记录也会保留。')) return;
    setBusy('reset-queue');
    try {
      const result = await request<{ cleared: number }>('/api/queue/clear', { method: 'POST', body: '{}' });
      const [nextQueue, nextQueueOverview, nextPendingQualifications] = await Promise.all([
        request<QueueRow[]>('/api/queue'),
        request<QueueOverviewEntry[]>('/api/queue/overview'),
        request<PendingQualification[]>('/api/qualifications/pending'),
      ]);
      setQueue(arrayOrEmpty<QueueRow>(nextQueue));
      setQueueOverview(arrayOrEmpty<QueueOverviewEntry>(nextQueueOverview));
      setPendingQualifications(arrayOrEmpty<PendingQualification>(nextPendingQualifications));
      notify(`已清空 ${result.cleared} 个正式排队任务；待提问权益未受影响`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '重置队列失败');
    } finally { setBusy(''); }
  };

  const openOperationalRecalculation = async () => {
    setBusy('recalculation-preview');
    try {
      const preview = await request<OperationalDataRecalculationReport>('/api/operations/recalculate/preview');
      setRecalculationPreview(preview);
      setRecalculationOpen(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法生成统一重新计算预览');
    } finally { setBusy(''); }
  };

  const applyOperationalRecalculation = async () => {
    setBusy('recalculate-data');
    try {
      const report = await request<OperationalDataRecalculationReport>('/api/operations/recalculate', { method: 'POST', body: '{}' });
      setRecalculationPreview(report);
      setInteractionResetAt(0);
      setInteractionFilter('all');
      await refresh(false);
      setRecalculationOpen(false);
      notify(`统一重新计算完成：恢复 ${report.rebuilt.queueItems} 条排队，重建 ${report.rebuilt.engagementUsers + report.rebuilt.giftUsers} 位观众统计`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '统一重新计算失败');
    } finally { setBusy(''); }
  };

  useEffect(() => {
    if (!recalculationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy !== 'recalculate-data') setRecalculationOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [recalculationOpen, busy]);

  useEffect(() => {
    void refresh().catch((error) => notify(`中控连接失败：${error.message}`));
    // 轮询只是兜底：WS 推送在线时低频保底，断开时 5 秒兜底（原 1.5s×14 请求会压垮连接导致白屏）
    const timer = window.setInterval(() => {
      if (!wsConnectedRef.current) void refresh().catch(() => undefined);
    }, 5_000);
    const slowTimer = window.setInterval(() => {
      if (wsConnectedRef.current) void refresh().catch(() => undefined);
    }, 15_000);
    // Interaction history is a separate durable stream. Keep it fresh even
    // when the director WebSocket is healthy; the old 15s full refresh made a
    // newly captured comment look as if TikFinity had stopped working.
    const captureTimer = window.setInterval(() => {
      void request<LiveCaptureItem[]>('/api/live-events/recent?limit=50')
        .then((items) => setCaptureHistory(arrayOrEmpty<LiveCaptureItem>(items)))
        .catch(() => undefined);
    }, 2_000);
    return () => { window.clearInterval(timer); window.clearInterval(slowTimer); window.clearInterval(captureTimer); };
  }, []);

  useEffect(() => {
    const resetScroll = () => window.scrollTo({ top: 0, behavior: 'auto' });
    resetScroll();
    const frame = window.requestAnimationFrame(resetScroll);
    const timer = window.setTimeout(resetScroll, 120);
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [tab]);

  const act = async (name: string, action: () => Promise<unknown>, success: string, reloadEditable = false) => {
    setBusy(name);
    try { await action(); notify(success); await refresh(reloadEditable); }
    catch (error) { notify(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(''); }
  };

  const probeDigitalHuman = async () => setDhStatus(await request<DigitalHumanStatus>('/api/digital-human/status'));
  const uploadVoicePack = async () => {
    if (!voicePackFile || !voicePackName.trim()) throw new Error('请先填写音色名称并选择参考音频');
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error('读取音频文件失败'));
      reader.readAsDataURL(voicePackFile);
    });
    const queued = await request<{ profile?: { id?: string; voiceId: string }; job?: { id: string } }>('/api/tts/voices', { method: 'POST', body: JSON.stringify({ name: voicePackName, fileName: voicePackFile.name, mimeType: voicePackFile.type || 'audio/wav', base64, refText: voicePackText, refLanguage: voicePackLang, targetLocale: voicePackLang === 'en' ? 'en-US' : 'zh-CN', targetCountry: voicePackLang === 'en' ? 'US' : 'CN', accentProfileId: voicePackLang === 'en' ? 'en-us' : 'zh-cn-standard', cloneMode: 'COUNTRY_ACCENT' }) });
    if (queued.job) {
      const deadline = Date.now() + 2 * 60 * 60_000;
      while (Date.now() < deadline) {
        const job = await request<{ status: string; errorMessage?: string; errorCode?: string }>(`/api/digital-human/jobs/${encodeURIComponent(queued.job.id)}`);
        if (job.status === 'READY') break;
        if (job.status === 'FAILED' || job.status === 'CANCELED') throw new Error(job.errorMessage || job.errorCode || 'DIGITAL_HUMAN_JOB_FAILED');
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      if (Date.now() >= deadline) throw new Error('DIGITAL_HUMAN_JOB_TIMEOUT');
    }
    setVoicePackName(''); setVoicePackFile(undefined); setVoicePackText('');
    await probeDigitalHuman();
  };
  const auditionVoicePack = async (id: string) => {
    await request(`/api/tts/voices/${encodeURIComponent(id)}/test`, { method: 'POST', body: JSON.stringify({}) });
  };
  const prepMuseTalkAvatar = async () => {
    if (!avatarVideoPath.trim()) throw new Error('请先填写人物视频的完整路径');
    const result = await request<{ ok: boolean; detail: string }>('/api/avatar/musetalk/prep', { method: 'POST', body: JSON.stringify({ avatarId: 'default', videoPath: avatarVideoPath }) });
    if (!result.ok) throw new Error(result.detail);
    await probeDigitalHuman();
    return result.detail;
  };
  const testMuseTalkAvatar = async () => {
    const result = await request<{ ok: boolean; detail: string }>('/api/avatar/musetalk/test', { method: 'POST', body: JSON.stringify({ avatarId: 'default' }) });
    if (!result.ok) throw new Error(result.detail);
    return result.detail;
  };

  useEffect(() => {
    if (tab === 'obs' || tab === 'avatar') void probeDigitalHuman().catch(() => undefined);
  }, [tab]);

  // 后台丝滑化：WebSocket 推送驱动实时数据（导演快照/队列/榜单秒级），轮询降级为兜底。
  useEffect(() => {
    const wsUrl = `${apiBase.replace('http', 'ws')}/ws/admin?token=${encodeURIComponent(controlToken)}`;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let stopped = false;
    let queueRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let captureRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    const queueDetailsRefresh = () => {
      if (queueRefreshTimer) clearTimeout(queueRefreshTimer);
      queueRefreshTimer = setTimeout(() => {
        Promise.all([
          request('/api/queue/overview'),
          request('/api/qualifications/pending'),
        ]).then(([nextOverview, nextPending]) => {
          setQueueOverview(arrayOrEmpty<QueueOverviewEntry>(nextOverview));
          setPendingQualifications(arrayOrEmpty<PendingQualification>(nextPending));
        }).catch(() => undefined);
      }, 60);
    };
    const captureRefresh = () => {
      if (captureRefreshTimer) clearTimeout(captureRefreshTimer);
      captureRefreshTimer = setTimeout(() => {
        void request<LiveCaptureItem[]>('/api/live-events/recent?limit=50')
          .then((items) => setCaptureHistory(arrayOrEmpty<LiveCaptureItem>(items)))
          .catch(() => undefined);
      }, 80);
    };
    const connect = () => {
      if (stopped) return;
      try {
        socket = new WebSocket(wsUrl);
        socket.onopen = () => { setWsBoth(true); };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { type?: string; payload?: unknown };
            const payload = message.payload as BroadcastSnapshotV2 & { rankingPayload?: boolean };
            if (message.type === 'SNAPSHOT' && payload) {
              setDirector({ session: payload.session, stage: payload.stage, activeCue: payload.activeCue, snapshot: payload });
              if (payload.queue) setQueue(payload.queue as unknown as QueueRow[]);
              queueDetailsRefresh();
              captureRefresh();
            } else if (message.type === 'QUEUE_CHANGED' && payload) {
              setQueue(payload as unknown as QueueRow[]);
              queueDetailsRefresh();
              captureRefresh();
            } else if (message.type === 'RANKING_CHANGED' && payload) {
              setDirector((current) => current ? ({ ...current, snapshot: { ...current.snapshot, giftRanking: (payload as { giftRanking?: BroadcastSnapshotV2['giftRanking'] }).giftRanking ?? current.snapshot.giftRanking, engagementRanking: (payload as { engagementRanking?: BroadcastSnapshotV2['engagementRanking'] }).engagementRanking ?? current.snapshot.engagementRanking } }) : current);
            } else if (message.type === 'PROFILE_PUBLISHED') {
              void refresh(true);
            } else if (['CUE_STARTED', 'CUE_UPDATED', 'CUE_ENDED', 'SESSION_CHANGED'].includes(message.type ?? '')) {
              void request<DirectorState>('/api/director/state').then(setDirector).catch(() => undefined);
              queueDetailsRefresh();
              captureRefresh();
            }
          } catch { /* 单条消息损坏不打断推送 */ }
        };
        socket.onerror = () => setWsBoth(false);
        socket.onclose = () => { setWsBoth(false); if (!stopped) retry = setTimeout(connect, 1500); };
      } catch { if (!stopped) retry = setTimeout(connect, 1500); }
    };
    connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); socket?.close(); if (queueRefreshTimer) clearTimeout(queueRefreshTimer); if (captureRefreshTimer) clearTimeout(captureRefreshTimer); };
  }, []);

  const saveProviderSecret = async (kind: 'llm' | 'tts', apiKey: string) => {
    if (!apiKey.trim()) throw new Error('请先输入 API Key');
    const status = await request<ProviderSecretStatus>(`/api/providers/secrets/${kind}`, { method: 'PUT', body: JSON.stringify({ apiKey }) });
    setSecretStatus(status);
    if (kind === 'llm') setLlmApiKey(''); else setTtsApiKey('');
  };

  const loadVoiceProfiles = async () => {
    const voices = await request<VoiceProfile[]>('/api/voices');
    setVoiceProfiles(voices);
    return voices;
  };

  const cloneVoice = async () => {
    if (!voiceSample || !voiceName.trim()) throw new Error('请填写声音名称并选择样音文件');
    if (!voiceAuthorized) throw new Error('必须确认声音权利与本人授权');
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.readAsDataURL(voiceSample);
    });
    const voice = await request<VoiceProfile>('/api/voices/clone', {
      method: 'POST',
      body: JSON.stringify({
        name: voiceName.trim(), fileName: voiceSample.name, mimeType: voiceSample.type,
        base64, authorizationConfirmed: true,
      }),
    });
    patchTts({ voiceId: voice.voiceId, activeVoiceProfileId: undefined });
    setVoiceProfiles((current) => [voice, ...current.filter((item) => item.voiceId !== voice.voiceId)]);
    setVoiceSample(undefined); setVoiceName(''); setVoiceAuthorized(false);
  };

  const autoApplyTimer = useRef<number>(0);
  const autoApplyProfileRef = useRef<SceneProfileVersion['profile'] | undefined>(undefined);
  const scheduleAutoApplyRef = useRef<null | ((profile: SceneProfileVersion['profile']) => void)>(null);
  {
    // 延迟绑定：组件体内定义，供 patchElements 复用同一套防抖自动发布
    scheduleAutoApplyRef.current = (profile) => {
      window.clearTimeout(autoApplyTimer.current);
      autoApplyTimer.current = window.setTimeout(() => {
        void request('/api/scene-profile/draft', { method: 'PUT', body: JSON.stringify(profile) }).catch(() => undefined);
      }, 800);
    };
  }
  const patchSource = (sourceId: ObsSourceId, patch: Partial<ObsSourceConfig>) => {
    setDraft((current) => {
      if (!current) return current;
      const nextProfile = { ...current.profile, sources: { ...current.profile.sources, [sourceId]: { ...current.profile.sources[sourceId], ...patch } } };
       // 属性实时保存到草稿；正式 OBS 画面只在用户点击发布时原子切换。
      window.clearTimeout(autoApplyTimer.current);
      autoApplyTimer.current = window.setTimeout(() => {
        void request('/api/scene-profile/draft', { method: 'PUT', body: JSON.stringify(nextProfile) }).catch(() => undefined);
      }, 800);
      return { ...current, profile: nextProfile };
    });
  };
  const patchVisualAssets = (patch: { lux3dCoreAssetId?: string }) => {
    setDraft((current) => {
      if (!current) return current;
      const nextProfile = { ...current.profile, visualAssets: { ...current.profile.visualAssets, ...patch } };
      window.clearTimeout(autoApplyTimer.current);
      autoApplyTimer.current = window.setTimeout(() => {
        void request('/api/scene-profile/draft', { method: 'PUT', body: JSON.stringify(nextProfile) }).catch(() => undefined);
      }, 800);
      return { ...current, profile: nextProfile };
    });
  };
  const patchTts = (patch: Partial<AppSettings['providers']['tts']>) => setSettings((current) => {
    if (!current) return current;
    const nextTts = { ...current.providers.tts, ...patch };
    window.clearTimeout(ttsPersistTimerRef.current);
    ttsPersistTimerRef.current = window.setTimeout(() => {
      // JSON omits undefined, which used to leave an old cloned profile
      // active on the server when the operator switched back to a built-in
      // voice. Send an explicit empty id so the old profile is really cleared.
      const persistedTts = { ...nextTts, activeVoiceProfileId: nextTts.activeVoiceProfileId ?? '' };
      void request('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ providers: { tts: persistedTts } }),
      }).then(() => notify('语音选择已保存，下一条测算立即使用新音色')).catch((error) => {
        notify(`语音设置保存失败：${error instanceof Error ? error.message : '请重试'}`);
      });
    }, 350);
    return { ...current, providers: { ...current.providers, tts: nextTts } };
  });
  const patchLlm = (patch: Partial<AppSettings['providers']['llm']>) => setSettings((current) => {
    if (!current) return current;
    const nextLlm = { ...current.providers.llm, ...patch };
    window.clearTimeout(llmPersistTimerRef.current);
    llmPersistTimerRef.current = window.setTimeout(() => {
      void request('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ providers: { llm: nextLlm } }),
      }).then(() => notify('文本模型配置已保存，下一条测算立即使用')).catch((error) => {
        notify(`文本模型配置保存失败：${error instanceof Error ? error.message : '请重试'}`);
      });
    }, 350);
    return { ...current, providers: { ...current.providers, llm: nextLlm } };
  });
  const patchLiveInput = (patch: Partial<AppSettings['providers']['liveInput']>) => setSettings((current) => {
    if (!current) return current;
    const nextLiveInput = { ...current.providers.liveInput, ...patch };
    window.clearTimeout(liveInputPersistTimerRef.current);
    liveInputPersistTimerRef.current = window.setTimeout(() => {
      void request('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ providers: { liveInput: nextLiveInput } }),
      }).then(() => notify('实时互动接入设置已保存，连接将自动重试')).catch((error) => {
        notify(`实时互动接入保存失败：${error instanceof Error ? error.message : '请重试'}`);
      });
    }, 350);
    return { ...current, providers: { ...current.providers, liveInput: nextLiveInput } };
  });
  const addGiftRule = (entry: GiftCatalogEntry) => setSettings((current) => {
    if (!current) return current;
    const exists = current.gifts.rules.some((rule) => entry.giftId ? rule.giftId === entry.giftId : rule.giftName.toLocaleLowerCase() === entry.name.toLocaleLowerCase());
    if (exists) { notify(`${entry.name} 已在测算规则中`); return current; }
    return { ...current, gifts: { ...current.gifts, rules: [...current.gifts.rules, {
      id: crypto.randomUUID(), enabled: true, giftId: entry.giftId, giftName: entry.name,
       minRepeatCount: 1, priority: 'NORMAL', speechTargetSeconds: 30,
       leaderboardPoints: Math.max(1, entry.coins ?? 1), requireStreakEnd: false,
    }] } };
  });
  const patchAllSources = (patch: Partial<ObsSourceConfig>) => setDraft((current) => current ? ({ ...current, profile: { ...current.profile, sources: Object.fromEntries(Object.entries(current.profile.sources).map(([id, source]) => [id, { ...source, ...patch }])) as typeof current.profile.sources } }) : current);
  const applyTheme = (preset: typeof themePresets[number]) => {
    patchAllSources({
      textColor: preset.text,
      accentColor: preset.accent,
      backgroundColor: preset.background,
      brightness: preset.brightness,
      glowIntensity: preset.glow,
      fontFamily: preset.font,
    });
    notify(`已套用“${preset.name}”，保存后正式生效`);
  };

  const firstLike = settings?.engagement.likeRules[0];
  const firstComment = settings?.engagement.commentRules[0];
  const changeLikeThreshold = (threshold: number) => {
    if (!settings) return;
    const normalizedThreshold = Math.max(1, threshold);
    setSettings({ ...settings, engagement: { ...settings.engagement, likeRules: [{ ...(firstLike ?? { id: 'simple-like', priority: 'NORMAL', speechTargetSeconds: settings.reading.speechTargetSeconds, grantExpireMinutes: 30, cooldownMinutes: 30 }), label: `累计点赞 ${normalizedThreshold} 次`, enabled: true, threshold: normalizedThreshold }] } });
  };
  const changeCommentKeywords = (value: string) => settings && setSettings({ ...settings, engagement: { ...settings.engagement, commentRules: [{ ...(firstComment ?? { id: 'question-recognition', label: '问题识别', priority: 'NORMAL', matchMode: 'CONTAINS', stripKeyword: false, cooldownMinutes: 10, queueExpireMinutes: settings.queue.expireMinutes, speechTargetSeconds: settings.reading.speechTargetSeconds }), enabled: true, keywords: [...new Set(value.split(/[、,，;；\n]+/).map((item) => item.trim()).filter(Boolean))], stripKeyword: false, queueExpireMinutes: settings.queue.expireMinutes, speechTargetSeconds: settings.reading.speechTargetSeconds }] } });
  const addRecommendedQuestionKeywords = () => {
    if (!settings) return;
    const merged = [...new Set([...(firstComment?.keywords ?? []), ...recommendedQuestionKeywords])];
    changeCommentKeywords(merged.join('、'));
    notify(`已补齐 ${recommendedQuestionKeywordGroups.length} 组常用问法；保存后生效`);
  };
  const changeQualificationExpiry = (minutes: number) => {
    if (!settings) return;
    const normalizedMinutes = Math.max(1, Math.min(720, minutes));
    setSettings({
      ...settings,
      queue: { ...settings.queue, expireMinutes: normalizedMinutes },
      gifts: { ...settings.gifts, entitlementExpireMinutes: normalizedMinutes },
      engagement: {
        ...settings.engagement,
        likeRules: settings.engagement.likeRules.map((rule) => ({ ...rule, grantExpireMinutes: normalizedMinutes })),
        commentRules: settings.engagement.commentRules.map((rule) => ({ ...rule, queueExpireMinutes: normalizedMinutes })),
      },
    });
  };

  const saveSimpleRules = async () => {
    if (!settings) return;
    const normalized: AppSettings = {
      ...settings,
      gifts: { ...settings.gifts, entitlementExpireMinutes: settings.queue.expireMinutes, rules: settings.gifts.rules.map((rule) => ({ ...rule, priority: rule.priority === 'MANUAL' ? 'HIGH' : rule.priority, leaderboardPoints: Math.max(rule.minRepeatCount, 1) })) },
      engagement: {
        ...settings.engagement,
        likeRules: settings.engagement.likeRules.slice(0, 1).map((rule) => ({ ...rule, enabled: true, priority: 'NORMAL', speechTargetSeconds: settings.reading.speechTargetSeconds, grantExpireMinutes: settings.queue.expireMinutes })),
        commentRules: settings.engagement.commentRules.slice(0, 1).map((rule) => ({ ...rule, enabled: true, priority: 'NORMAL', matchMode: 'CONTAINS', stripKeyword: false, queueExpireMinutes: settings.queue.expireMinutes, speechTargetSeconds: settings.reading.speechTargetSeconds })),
      },
    };
    setSettings(normalized);
    await request('/api/settings', { method: 'PUT', body: JSON.stringify(normalized) });
  };

  const saveScene = async () => {
    if (!draft) return;
    await request('/api/scene-profile/draft', { method: 'PUT', body: JSON.stringify({ ...draft.profile, canvasPreviewLayout: canvasLayout }) });
    if (!director?.session || director.session.status === 'ENDED') await request('/api/scene-profile/publish', { method: 'POST' });
  };

  const mapAvatar = (kind: 'idle' | 'speaking' | 'gift', assetId: string) => {
    const asset = assets.find((item) => item.id === assetId);
    const mode = !asset || asset.mimeType.startsWith('image/') ? 'STATIC_FALLBACK' : asset.mimeType === 'video/mp4' ? 'CHROMA_KEY' : 'TRANSPARENT';
    setDraft((current) => {
      if (!current) return current;
      const actions = kind === 'idle' ? ['IDLE', 'QUESTION_RECEIVED', 'CASTING', 'THINKING', 'FINISH', 'ERROR_RECOVER'] : kind === 'speaking' ? ['SPEAKING_NEUTRAL', 'SPEAKING_EMPHASIS'] : ['THANK_GIFT'];
      const slots = { ...current.profile.avatar.slots };
      for (const action of actions) slots[action as keyof typeof slots] = { ...slots[action as keyof typeof slots], assetId: assetId || undefined, mode };
      return { ...current, profile: { ...current.profile, avatar: { slots } } };
    });
  };

  const getCanvasBox = (sourceId: ObsSourceId): CanvasBox => canvasLayout[sourceId] ?? defaultCanvasLayout[sourceId] ?? { x: 90, y: 90, width: 900, height: 220 };
  const beginCanvasInteraction = (event: ReactPointerEvent<HTMLElement>, sourceId: ObsSourceId, mode: 'move' | 'resize', dir: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' = 'se') => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    canvasInteractionRef.current = { mode, sourceId, dir, startX: event.clientX, startY: event.clientY, startBox: getCanvasBox(sourceId) };
    setSelectedSource(sourceId);
    setRightPaletteOpen(true);
  };
  const updateCanvasInteraction = (clientX: number, clientY: number) => {
    const interaction = canvasInteractionRef.current;
    if (!interaction) return;
    const scale = Math.max(0.2, canvasZoom / 100);
    const dx = (clientX - interaction.startX) / scale;
    const dy = (clientY - interaction.startY) / scale;
    const snap = (value: number) => snapEnabled ? Math.round(value / 10) * 10 : Math.round(value);
    let next: CanvasBox;
    if (interaction.mode === 'move') {
      // 自由拖拽：允许部分移出画布，但至少保留 30px 在画布内
      next = {
        ...interaction.startBox,
        x: Math.max(30 - interaction.startBox.width, Math.min(1050, snap(interaction.startBox.x + dx))),
        y: Math.max(30 - interaction.startBox.height, Math.min(1890, snap(interaction.startBox.y + dy))),
      };
    } else {
      // 自由缩放：最小 80×40，上限放宽到 2160×2400
      const dir = interaction.dir ?? 'se';
      const start = interaction.startBox;
      let x = start.x;
      let y = start.y;
      let width = start.width;
      let height = start.height;
      if (dir.includes('e')) width = Math.max(80, Math.min(2160, snap(start.width + dx)));
      if (dir.includes('s')) height = Math.max(40, Math.min(2400, snap(start.height + dy)));
      if (dir.includes('w')) {
        const candidate = snap(start.width - dx);
        width = Math.max(80, Math.min(2160, candidate));
        x = start.x + (start.width - width);
      }
      if (dir.includes('n')) {
        const candidate = snap(start.height - dy);
        height = Math.max(40, Math.min(2400, candidate));
        y = start.y + (start.height - height);
      }
      x = Math.max(30 - width, Math.min(1050, x));
      y = Math.max(30 - height, Math.min(1890, y));
      next = { x, y, width, height };
    }
    setCanvasLayout((current) => ({ ...current, [interaction.sourceId]: next }));
  };
  const moveCanvasInteraction = (event: ReactPointerEvent<HTMLElement>) => updateCanvasInteraction(event.clientX, event.clientY);
  const endCanvasInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    canvasInteractionRef.current = undefined;
  };
  const resetCanvasLayout = () => {
    setCanvasLayout(defaultCanvasLayout);
    setDraft((current) => current ? ({ ...current, profile: { ...current.profile, canvasPreviewLayout: undefined } }) : current);
  };
  const beginFloatingDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    floatingDragRef.current = { startX: event.clientX, startY: event.clientY, originX: floatingPreviewPos.x, originY: floatingPreviewPos.y };
  };
  const moveFloatingDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = floatingDragRef.current;
    if (!drag) return;
    setFloatingPreviewPos({
      x: Math.max(12, Math.min(420, drag.originX + event.clientX - drag.startX)),
      y: Math.max(70, Math.min(620, drag.originY + event.clientY - drag.startY)),
    });
  };
  const beginFloatingResize = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const size = floatingPreviewSize ?? { width: source?.width ?? 480, height: source?.height ?? 300 };
    floatingResizeRef.current = { startX: event.clientX, startY: event.clientY, originW: size.width, originH: size.height };
  };
  const moveFloatingResize = (event: ReactPointerEvent<HTMLElement>) => {
    const resize = floatingResizeRef.current;
    if (!resize) return;
    setFloatingPreviewSize({
      width: Math.max(220, Math.min(900, resize.originW + event.clientX - resize.startX)),
      height: Math.max(140, Math.min(1400, resize.originH + event.clientY - resize.startY)),
    });
  };
  const endFloatingResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    floatingResizeRef.current = undefined;
  };
  const endFloatingDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    floatingDragRef.current = undefined;
  };

  useEffect(() => {
    const move = (event: PointerEvent) => updateCanvasInteraction(event.clientX, event.clientY);
    const end = () => { canvasInteractionRef.current = undefined; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [canvasZoom, snapEnabled]);

  const giftRanking = director?.snapshot.giftRanking ?? [];
  const engagementRanking = director?.snapshot.engagementRanking ?? [];
  const active = director?.snapshot.reading;
  const session = director?.session;
  const stage = director?.stage ?? 'IDLE';
  const pipelineSteps = [
    ['QUEUED', '排队'], ['CASTING', '起卦'], ['HEXAGRAM_READY', '卦象'],
    ['SCRIPT_READY', '卦辞话术'], ['VOICE_READY', '克隆声音'], ['RENDERING', '数字人'],
    ['SPEAKING', '统一播报'], ['FINISH', '完成'],
  ] as const;
  const activePipeline = active?.pipeline;
  const source = draft?.profile.sources[selectedSource];
  const normalizedRecordQuery = recordQuery.trim().toLocaleLowerCase();
  const filteredReadings = readings.filter((item) => {
    const matchesQuery = !normalizedRecordQuery || `${item.username} ${item.normalizedQuestion ?? item.rawQuestion}`.toLocaleLowerCase().includes(normalizedRecordQuery);
    const matchesStatus = recordStatus === 'ALL' || item.status === recordStatus;
    const matchesDate = !recordDate || new Date(item.createdAt).toLocaleDateString('en-CA') === recordDate;
    return matchesQuery && matchesStatus && matchesDate;
  });
  const filteredEvents = events.filter((item) => {
    const matchesQuery = !normalizedRecordQuery || `${item.type} ${eventSummary(item.payload)}`.toLocaleLowerCase().includes(normalizedRecordQuery);
    const matchesDate = !recordDate || new Date(item.createdAt).toLocaleDateString('en-CA') === recordDate;
    return matchesQuery && matchesDate;
  });
  const completedReadings = readings.filter((item) => item.status === 'COMPLETED').length;
  const currentInteractionSnapshot = captureHistory.filter((item) => item.receivedAt >= interactionResetAt);
  const interactionCounts = {
    all: currentInteractionSnapshot.length,
    chat: currentInteractionSnapshot.filter((item) => item.kind === 'chat').length,
    like: currentInteractionSnapshot.filter((item) => item.kind === 'like').length,
    gift: currentInteractionSnapshot.filter((item) => item.kind === 'gift').length,
  };
  const visibleInteractions = interactionFilter === 'all'
    ? currentInteractionSnapshot
    : currentInteractionSnapshot.filter((item) => item.kind === interactionFilter);
  const giftPoints = giftRanking.reduce((total, item) => total + item.points, 0);
  const engagementPoints = engagementRanking.reduce((total, item) => total + item.points, 0);
  const capturedGiftEntries: GiftCatalogEntry[] = capturedGifts.map((gift) => {
    const reference = gift.giftId ? referenceGiftCatalog.find((item) => item.giftId === gift.giftId) : undefined;
    return {
      key: `captured:${gift.giftId ?? gift.giftName.toLocaleLowerCase()}`,
      name: reference?.name ?? englishGiftName(gift.giftId, gift.giftName),
      coins: gift.coinValue ?? reference?.coins,
      giftId: gift.giftId,
      source: 'CAPTURED',
      iconUrl: reference?.iconUrl ?? giftIconUrl(gift.giftId, gift.giftName),
      verification: 'TIKFINITY_CAPTURED',
    };
  });
  const capturedNames = new Set(capturedGiftEntries.map((item) => item.name.toLocaleLowerCase()));
  const capturedIds = new Set(capturedGiftEntries.flatMap((item) => item.giftId ? [item.giftId] : []));
  const giftCatalogQuery = giftSearch.trim().toLocaleLowerCase();
  const visibleGiftCatalog = [...capturedGiftEntries, ...referenceGiftCatalog.filter((item) => !capturedNames.has(item.name.toLocaleLowerCase()) && !(item.giftId && capturedIds.has(item.giftId)))]
    .filter((item) => !giftCatalogQuery || `${item.name} ${item.coins ?? ''} ${item.giftId ?? ''}`.toLocaleLowerCase().includes(giftCatalogQuery));
  const liveControls = session?.status === 'LIVE'
    ? <button className="control-button danger" disabled={Boolean(busy)} onClick={() => void act('abort', () => request(`/api/sessions/${session.sessionId}/abort`, { method: 'POST', body: JSON.stringify({ reason: '管理员关闭直播' }) }), '直播已关闭')}><Stop weight="fill" />关闭直播</button>
    : <button className="control-button primary" disabled={Boolean(busy)} onClick={() => void act('live', () => session?.status === 'PAUSED' ? request(`/api/sessions/${session.sessionId}/resume`, { method: 'POST' }) : request('/api/sessions/start', { method: 'POST', body: JSON.stringify({ mode: 'LIVE' }) }), '直播已开始')}><Broadcast weight="fill" />立即开播</button>;

  const livePage = <section className="page dashboard-page">
    <div className="workspace-title"><div><span className="eyebrow">LIVE DIRECTOR DESK</span><h2>节目总控台</h2><p>一个任务驱动观众、卦象、语音、人物动作和全部 OBS 来源。</p></div><div className="workspace-status"><span className="status-dot" /><strong>{stageNames[stage] ?? stage}</strong><small>序列 {director?.snapshot.sequence ?? 0}</small></div></div>
    <div className="data-recalculation-bar"><div><Database weight="duotone" /><span><b>直播数据总控</b><small>以直播间原始事件和已记录任务，统一重建队列、资格与统计</small></span></div><button className="recalculate-control" disabled={Boolean(busy)} onClick={() => void openOperationalRecalculation()}><ArrowCounterClockwise weight="bold" />{busy === 'recalculation-preview' ? '正在核对数据…' : '统一重新计算'}</button></div>
    <div className="dashboard-grid">
      <Panel title="节目监看" hint="当前任务的唯一真相源" className="program-monitor" action={<Pill status={session?.status ?? 'OFFLINE'} />}>
        <div className="monitor-stage">
          <div className="viewer-column"><div className="viewer-avatar"><UserCircle weight="duotone" /></div><span>当前观众</span><strong>{active ? `@${active.username}` : '等待观众'}</strong><small>连接状态 · {stage}</small></div>
          <div className="question-column"><span>对方的问题</span><h3>{active?.normalizedQuestion ?? active?.rawQuestion ?? '符合资格的观众提问后，问题会自动显示在这里'}</h3><div className="hexagram-summary"><span>梅花易数 · 本卦</span><strong>{active?.meihua?.primary.name ?? '等待起卦'}</strong><small>{active?.meihua ? `${active.meihua.primary.upperTrigram}上 · ${active.meihua.primary.lowerTrigram}下${active.meihua.movingLines.length ? ` · 动爻 ${active.meihua.movingLines.join('、')}` : ''}` : '收到任务后自动生成真实可复现卦象'}</small></div><div className="reading-script"><span>本次测算话术 · {active?.speechTargetSeconds ? `${active.speechTargetSeconds} 秒` : '—'} · {active?.answer?.speechUnits ?? '—'}/{active?.answer?.targetSpeechUnits ?? '—'} 单位</span><p>{active?.answer ? [active.answer.opening, active.answer.speech, active.answer.closing].filter(Boolean).join(' ') : '卦象生成后，本次实际播报话术会完整显示在这里。'}</p></div></div>
          <div className="result-column"><span>变卦 / 体用</span><strong>{active?.meihua?.changed?.name ?? '—'}</strong><small>{active?.meihua ? `体 ${active.meihua.bodyTrigram ?? '—'} · 用 ${active.meihua.useTrigram ?? '—'}` : '尚未进入测算'}</small><div className="stage-badge"><Lightning weight="fill" />{stageNames[stage] ?? stage}</div></div>
        </div>
        <div className="monitor-stats"><div><span>阶段</span><strong>{stage}</strong></div><div><span>观众数</span><strong>{queue.length + (active ? 1 : 0)}</strong></div><div><span>目标播报</span><strong>{active?.speechTargetSeconds ? `${active.speechTargetSeconds} 秒` : '—'}</strong></div><div><span>实测音频</span><strong>{active?.tts?.durationMs ? `${(active.tts.durationMs / 1000).toFixed(1)} 秒${active.tts.quality?.durationTargetMet === false ? ' · 待校正' : ''}` : '—'}</strong></div></div>
        <div className="pipeline-strip"><div className="pipeline-strip-head"><span>统一播报链路</span><small>{activePipeline ? `${activePipeline.phaseLabel} · ${activePipeline.progress}% · 第 ${activePipeline.attempt}/${activePipeline.maxAttempts} 次` : '等待下一位进入测算'}</small></div><div className="pipeline-strip-steps">{pipelineSteps.map(([phase, label]) => { const currentIndex = pipelineSteps.findIndex(([item]) => item === (activePipeline?.phase ?? 'QUEUED')); const stepIndex = pipelineSteps.findIndex(([item]) => item === phase); const done = Boolean(activePipeline && stepIndex < currentIndex); const current = activePipeline?.phase === phase; return <span key={phase} className={`${done ? 'is-done' : ''} ${current ? 'is-current' : ''}`}><i />{label}</span>; })}</div><div className="pipeline-artifacts"><span className={activePipeline?.artifacts.hexagram ? 'ready' : ''}>卦象 {activePipeline?.artifacts.hexagram ? '已出' : '待生成'}</span><span className={activePipeline?.artifacts.script ? 'ready' : ''}>话术 {activePipeline?.artifacts.script ? '已出' : '待生成'}</span><span className={activePipeline?.artifacts.audio ? 'ready' : ''}>声音 {activePipeline?.artifacts.audio ? '已出' : '待生成'}</span><span className={activePipeline?.artifacts.avatar ? 'ready' : ''}>数字人 {activePipeline?.artifacts.avatar ? '已出' : '待渲染'}</span></div></div>
        <div className="director-transport"><div className="timeline"><span>导演时间轴</span><div className="timeline-track"><i /></div><b>{session?.mode === 'LIVE' ? session.status : session?.mode === 'REHEARSAL' ? 'REHEARSAL' : 'OFFLINE'}</b></div><div className="transport-actions"><button onClick={() => void act('retry', () => request('/api/director/retry-current', { method: 'POST' }), '已安排重答')}><ArrowCounterClockwise />重答当前</button><button className="transport-main" disabled={!active}><Pause weight="fill" />{stage === 'SPEAKING' ? '播报中' : '待机'}</button><button onClick={() => void act('skip', () => request('/api/director/skip-current', { method: 'POST' }), '已跳过当前')}><SkipForward weight="fill" />跳过当前</button><button className="danger" onClick={() => void act('idle', () => request('/api/director/force-idle', { method: 'POST' }), '已强制待机')}><Stop weight="fill" />紧急待机</button></div></div>
        <div className="theme-dock"><div className="dock-heading"><span><Palette weight="fill" />画面主题</span><button className="text-button" onClick={() => setTab('obs')}>进入工作台<CaretRight /></button></div><div className="theme-shortcuts">{themePresets.slice(0, 5).map((preset) => <button key={preset.id} onClick={() => { applyTheme(preset); setTab('obs'); }}><i style={{ backgroundColor: preset.background, borderColor: preset.accent }}><b style={{ backgroundColor: preset.accent }} /></i><span>{preset.name}</span></button>)}</div></div>
      </Panel>
      <div className="right-rail">
        <Panel title="下一位" action={<span className="rail-tag">{queue[0] ? '待邀请' : '空闲'}</span>}><div className="next-viewer"><UserCircle weight="duotone" /><span><strong>{queue[0] ? `@${queue[0].username}` : '暂无下一位'}</strong><small>{queue[0] ? `${queue[0].giftName ? `礼物 · ${queue[0].giftName}` : '免费资格'} · 已等 ${elapsed(queue[0].waitingMs)}` : '新问题进入后自动排序'}</small></span></div></Panel>
        <Panel title={`排队与待提问 (${queueOverview.length})`} className="queue-rail" action={<div className="panel-actions"><button className="snapshot-refresh" disabled={Boolean(busy)} onClick={() => void refreshQueueSnapshot()}><ArrowCounterClockwise />刷新</button><button className="snapshot-reset" disabled={Boolean(busy)} onClick={() => void resetQueueSnapshot()}>清空队列</button></div>}><div className="queue-list linkage-rail-list">{queueOverview.slice(0, 6).map((item) => <div key={item.id} className={item.status === 'WAITING_QUESTION' ? 'waiting-question' : 'queued-question'}><em>{item.status === 'QUEUED' ? item.position ?? '•' : '?'}</em><span><strong>@{item.username}</strong><small>{item.status === 'WAITING_QUESTION' ? `${item.eventSource} · 未提问 · ${item.giftName ?? item.label}` : `${item.eventSource} · 已提问 · ${item.question}`}</small></span><Pill status={item.status === 'WAITING_QUESTION' ? '未提问' : '排队中'} /></div>)}{!queueOverview.length && <div className="empty">暂无待提问或排队观众</div>}</div></Panel>
        <Panel title={`待处理资格 (${pendingQualifications.filter((item) => item.kind !== 'COMMENT_KEYWORD').length})`} className="qualification-rail"><div className="qualification-list">{(['GIFT','LIKE'] as const).map((kind) => { const count = pendingQualifications.filter((item) => item.kind === kind).length; const Icon = kind === 'GIFT' ? Gift : Heart; return <div key={kind}><Icon weight="fill" /><span>{kind === 'GIFT' ? '礼物资格待提问' : '点赞资格待提问'}</span><strong>{count}</strong></div>; })}</div></Panel>
      </div>
      <Panel title="实时互动" hint="刷新会读取最新记录；“从现在统计”只改变本页显示起点，不删除历史数据" className="activity-panel" intakeNote={(!session || session.status === 'ENDED') ? '未开播：礼物、点赞和评论仅展示不入账；点击左上「立即开播」后才开始累计资格。' : undefined} action={<div className="activity-actions"><div className="filter-pills" role="tablist" aria-label="实时互动筛选">{([['all','全部'],['like','点赞'],['chat','评论'],['gift','礼物']] as const).map(([kind,label]) => <button key={kind} className={interactionFilter === kind ? 'active' : ''} onClick={() => setInteractionFilter(kind)}>{label}<b>{interactionCounts[kind]}</b></button>)}</div><button className="snapshot-refresh" disabled={Boolean(busy)} onClick={() => void refreshInteractionSnapshot()}><ArrowCounterClockwise />刷新</button><button className="snapshot-reset" disabled={Boolean(busy)} onClick={resetInteractionSnapshot}>从现在统计</button></div>}><div className="capture-list">{visibleInteractions.slice(0, 12).map((sample) => <div key={sample.id} className={`capture-${sample.kind}`}><Pill status={sample.kind.toUpperCase()} /><time>{new Date(sample.receivedAt).toLocaleTimeString()}</time><span><strong>{sample.username ? `@${sample.username}` : '直播间事件'}</strong><small>{captureDescription(sample)}</small></span></div>)}{!visibleInteractions.length && <div className="empty">当前筛选中没有新的实时互动。</div>}</div></Panel>
      <Panel title="接入健康" hint="关键服务实时状态" className="health-panel" action={<Pill status={health?.input ?? 'UNKNOWN'} />}><div className="health-list"><div><WifiHigh /><span>OBS 浏览器源</span><strong>{health?.overlayClients ?? 0} 在线</strong></div><div><Radio /><span>TikFinity</span><strong>{health?.tikfinity?.status ?? health?.input ?? 'UNKNOWN'}</strong></div><div><SpeakerHigh /><span>语音输出</span><strong>{health?.tts ?? 'UNKNOWN'}</strong></div><div><Database /><span>内容引擎</span><strong>{health?.llm ?? 'UNKNOWN'}</strong></div></div></Panel>
      <Panel title="开播检查" hint="正式开播不可绕过" className="preflight-panel"><div className="preflight-compact">{preflight?.checks.slice(0, 6).map((check) => <div key={check.id} className={`check-${check.status.toLowerCase()}`}>{check.status === 'PASS' ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}<span><strong>{check.label}</strong><small>{check.message}</small></span></div>)}</div></Panel>
    </div>
  </section>;

  const simplePage = settings && <section className="page simple-page">
    <div className="workspace-title"><div><h2>资格与队列</h2><p>先获得点赞或礼物资格，再提交一个明确问题；系统负责识别、排队和预处理。</p></div><button className="primary" onClick={() => void act('save-rules', saveSimpleRules, '排队规则已保存', true)}><CheckCircle weight="fill" />保存全部规则</button></div>
    <div className="qualification-summary">
      <div><Heart weight="fill" /><span>点赞门槛<small>累计后获得一次资格</small></span><strong>{firstLike?.threshold ?? 100}</strong></div>
      <div><ChatCircle weight="fill" /><span>问题关键词<small>仅识别问题，不发资格</small></span><strong>{firstComment?.keywords.length ?? 0} 个</strong></div>
      <div><Timer weight="fill" /><span>免费排队<small>超时自动取消</small></span><strong>{settings.queue.expireMinutes} 分钟</strong></div>
      <div><Gift weight="fill" /><span>礼物规则<small>到期前提交明确问题</small></span><strong>{settings.gifts.rules.length} 条</strong></div>
    </div>
    <div className="qualification-layout">
      <Panel title="资格入口" hint="普通评论不会发放资格；关键词只帮助系统识别和清理已获得资格者的问题。" className="free-rules-panel"><div className="simple-rules"><label className="like-rule-field"><span><Heart weight="fill" />累计点赞资格</span><input type="number" min="1" value={firstLike?.threshold ?? 100} onChange={(event) => changeLikeThreshold(Number(event.target.value))} /><small>同一观众累计达到 {firstLike?.threshold ?? 100} 次后获得一次 {settings.reading.speechTargetSeconds} 秒测算资格。</small></label><div className="question-keyword-field"><header><span><ChatCircle weight="fill" /><b>问题识别关键词</b></span><button type="button" onClick={addRecommendedQuestionKeywords}>补齐推荐问法</button></header><textarea rows={5} aria-label="问题识别关键词" value={firstComment?.keywords.join('、') ?? ''} onChange={(event) => changeCommentKeywords(event.target.value)} /><div className="keyword-groups">{recommendedQuestionKeywordGroups.map((group) => <span key={group.label}><b>{group.label}</b><small>{group.values.slice(0, 5).join(' · ')}</small></span>)}</div><small>支持中文、英语、西语、法语、德语、日语、韩语、葡语和俄语。最终仍会经过问句结构、长度、广告和高风险主题校验。</small></div></div></Panel>
      <Panel title="排队策略" hint="四个数字控制所有资格和队列，不再出现界面 20 分钟、后台 30 分钟的冲突。" className="queue-policy-panel"><div className="policy-fields"><label><span><ListNumbers weight="fill" />画面显示人数</span><input type="number" min="1" max="12" value={settings.queue.maxVisible} onChange={(event) => setSettings({ ...settings, queue: { ...settings.queue, maxVisible: Math.max(1, Math.min(12, Number(event.target.value))) } })} /><small>OBS 排队名单显示前 {settings.queue.maxVisible} 位。</small></label><label><span><ListNumbers weight="fill" />队列总容量</span><input type="number" min="1" max="100" value={settings.queue.maxTotal} onChange={(event) => setSettings({ ...settings, queue: { ...settings.queue, maxTotal: Math.max(1, Math.min(100, Number(event.target.value))) } })} /><small>正式队列最多 {settings.queue.maxTotal} 位。</small></label><label><span><Timer weight="fill" />资格等待时限</span><input type="number" min="1" max="720" value={settings.queue.expireMinutes} onChange={(event) => changeQualificationExpiry(Number(event.target.value))} /><small>点赞、礼物和待提问资格统一为 {settings.queue.expireMinutes} 分钟。</small></label><label><span><SpeakerHigh weight="fill" />默认测算时长</span><select value={settings.reading.speechTargetSeconds} onChange={(event) => setSettings({ ...settings, reading: { ...settings.reading, speechTargetSeconds: Number(event.target.value) } })}>{speechDurationOptions.map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select><small>点赞资格默认生成 {settings.reading.speechTargetSeconds} 秒解读；礼物规则可单独设置。</small></label></div><div className="queue-flow"><b>自动执行顺序</b><span>{firstLike?.threshold ?? 100} 次点赞或指定礼物 → 提交明确问题 → 正式排队 → 后台预处理 → 播报</span><small>无资格聊天只进入互动记录，不占正式队列。</small></div></Panel>
    </div>
    <Panel title={`资格与排队联动 · ${queueOverview.length}`} hint="礼物到账后先显示未提问；同一观众提交问题后自动转入正式队列。" className="linkage-panel" action={<div className="panel-actions"><button className="snapshot-refresh" disabled={Boolean(busy)} onClick={() => void refreshQueueSnapshot()}><ArrowCounterClockwise />刷新队列</button><button className="snapshot-reset" disabled={Boolean(busy)} onClick={() => void resetQueueSnapshot()}>清空队列</button>{!productionMode ? <button disabled={Boolean(busy)} onClick={() => void act('linkage-test', async () => { const report = await request<{ ok: boolean; username: string; afterGift?: QueueOverviewEntry; afterQuestion?: QueueOverviewEntry }>('/api/mock/linkage', { method: 'POST', body: '{}' }); setLinkageReport(report); return report; }, '礼物→提问→排队模拟已完成')}><Play weight="fill" />运行完整联动模拟</button> : <Pill status="LIVE ONLY" />}</div>}>
      <div className="linkage-queue-grid">
        <section><header><b>待提问</b><span>{queueOverview.filter((item) => item.status === 'WAITING_QUESTION').length}</span></header><div className="capture-list">{queueOverview.filter((item) => item.status === 'WAITING_QUESTION').slice(0, 10).map((item) => <div key={item.id}><Pill status="未提问" /><span><strong>@{item.username}</strong><small>{item.giftName ?? item.label} · {item.speechTargetSeconds} 秒权益</small></span><time>{item.expiresAt ? `${Math.max(1, Math.ceil((item.expiresAt - Date.now()) / 60_000))} 分钟` : '永久等待'}</time></div>)}{!queueOverview.some((item) => item.status === 'WAITING_QUESTION') && <div className="empty">没有等待问题的观众</div>}</div></section>
        <section><header><b>已提问 · 正式排队</b><span>{queueOverview.filter((item) => item.status === 'QUEUED').length}</span></header><div className="capture-list">{queueOverview.filter((item) => item.status === 'QUEUED').slice(0, 10).map((item) => <div key={item.id}><Pill status="已提问" /><span><strong>{item.position ? `${item.position}. ` : ''}@{item.username}</strong><small>{item.question} · {item.giftName ?? item.label}</small></span><time>{item.speechTargetSeconds} 秒</time></div>)}{!queueOverview.some((item) => item.status === 'QUEUED') && <div className="empty">正式队列为空</div>}</div></section>
      </div>
      {linkageReport && <div className={`linkage-report ${linkageReport.ok ? 'passed' : 'failed'}`}><CheckCircle weight="fill" /><span><b>{linkageReport.ok ? '链路通过' : '链路失败'} · @{linkageReport.username}</b><small>礼物后：{linkageReport.afterGift?.status ?? '未捕获'} → 提问后：{linkageReport.afterQuestion?.status ?? '未捕获'}</small></span></div>}
    </Panel>
    <Panel title="礼物与测算时长" hint="选择礼物并指定播报时长即可；礼物 ID 优先匹配，实际抓到的新礼物会自动进入礼物库。" className="gift-rule-panel" action={<button onClick={() => setGiftLibraryOpen((value) => !value)}><Gift weight="fill" />{giftLibraryOpen ? '收起礼物库' : '添加礼物'}</button>}>
      {giftLibraryOpen && <section className="gift-library">
        <header><div><b>礼物库</b><small>TikFinity 实际捕获优先 · 参考目录 {referenceGiftCatalog.length} 种 · 礼物会因地区与活动变化</small></div><input value={giftSearch} onChange={(event) => setGiftSearch(event.target.value)} placeholder="搜索礼物名称、ID 或币值" /></header>
        <div>{visibleGiftCatalog.map((entry) => { const added = settings.gifts.rules.some((rule) => entry.giftId ? rule.giftId === entry.giftId : rule.giftName.toLocaleLowerCase() === entry.name.toLocaleLowerCase()); return <button key={entry.key} className={added ? 'added' : ''} disabled={added} onClick={() => addGiftRule(entry)}><em>{entry.iconUrl ? <img src={entry.iconUrl} alt="" /> : giftGlyph(entry.name)}</em><span><b>{entry.name}</b><small>{entry.source === 'CAPTURED' ? 'TikFinity 已实捕' : `${entry.coins ?? '—'} coins`}{entry.giftId ? ` · ID ${entry.giftId}` : ''}</small></span><strong>{added ? '已添加' : '添加'}</strong></button>; })}</div>
        {!visibleGiftCatalog.length && <p className="empty">没有匹配的礼物；请先在直播间送出一次，让 TikFinity 自动捕获真实 ID。</p>}
      </section>}
      <div className="gift-rule-grid">{settings.gifts.rules.map((rule) => { const captured = capturedGifts.find((gift) => gift.giftId && gift.giftId === rule.giftId) ?? capturedGifts.find((gift) => gift.giftName.toLocaleLowerCase() === rule.giftName.toLocaleLowerCase()); return <article key={rule.id} className={rule.enabled ? 'enabled' : ''}>
        <div className="gift-rule-icon">{giftIconUrl(rule.giftId, rule.giftName) ? <img src={giftIconUrl(rule.giftId, rule.giftName)} alt="" /> : giftGlyph(rule.giftName)}</div>
        <div className="gift-rule-identity"><strong>{rule.giftName}</strong><small>{rule.giftId ? `真实 ID ${rule.giftId}` : '按名称匹配'}{captured ? ` · 已捕获 ${captured.count} 次` : ' · 等待实播验证'}</small></div>
        <label>礼物数量<input type="number" min="1" value={rule.minRepeatCount} onChange={(event) => setSettings({ ...settings, gifts: { ...settings.gifts, rules: settings.gifts.rules.map((item) => item.id === rule.id ? { ...item, minRepeatCount: Math.max(1, Number(event.target.value)) } : item) } })} /></label><label>测算时间<select value={rule.speechTargetSeconds} onChange={(event) => setSettings({ ...settings, gifts: { ...settings.gifts, rules: settings.gifts.rules.map((item) => item.id === rule.id ? { ...item, speechTargetSeconds: Number(event.target.value), priority: 'HIGH' } : item) } })}>{speechDurationOptions.map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select></label>
        <label className="gift-enable"><input type="checkbox" checked={rule.enabled} onChange={(event) => setSettings({ ...settings, gifts: { ...settings.gifts, rules: settings.gifts.rules.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked } : item) } })} /><span>{rule.enabled ? '已启用' : '已停用'}</span></label>
        <button className="gift-remove" title="删除礼物规则" onClick={() => setSettings({ ...settings, gifts: { ...settings.gifts, rules: settings.gifts.rules.filter((item) => item.id !== rule.id) } })}>删除</button>
      </article>; })}</div>
      {!settings.gifts.rules.length && <div className="empty gift-empty">尚未配置礼物。点击“添加礼物”，选择礼物并设置测算时间。</div>}
      <div className="gift-flow-note"><b>后台自动联动</b><span>礼物到账 → 标记未提问 → 同用户评论自动补全问题 → 进入礼物队列 → 起卦 → 生成固定时长解读 → 语音播报</span></div>
    </Panel>
  </section>;

  const obsPage = draft && <StudioWorkbench
    draft={draft}
    assets={assets}
    giftRules={settings?.gifts.rules ?? []}
    stageStatus={director?.stage}
    livePreview={session?.status === 'LIVE'}
    onReload={async (replaceEditable = true) => { await refresh(replaceEditable); }}
    notify={notify}
  />;

  const localClonedVoiceProfiles = (settings?.providers.tts.voiceProfiles ?? []).filter((profile) => profile.provider === 'gptsovits-v3' && profile.status === 'READY');
  const connectPage = settings && <section className="page connect-page">
    <div className="workspace-title"><div><h2>接入与播报</h2><p>按直播事件、内容语言、声音和最终画面的顺序配置；上一步决定下一步显示什么。</p></div><button className="primary" onClick={() => void act('connect-save', () => request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }), '接入与播报设置已保存', true)}><CheckCircle weight="fill" />保存全部配置</button></div>
    <div className="integration-overview">
      <article><Radio weight="fill" /><span><b>直播事件</b><small>{health?.providers.find((item) => item.id === 'tikfinity' || item.id === 'local-live-input')?.message ?? '等待验证事件'}</small></span><Pill status={health?.input ?? 'UNKNOWN'} /></article>
      <article><Lightning weight="fill" /><span><b>内容生成</b><small>{settings.providers.llm.adapter === 'rule-based' ? '本地规则引擎' : settings.providers.llm.model || '尚未选择模型'}</small></span><Pill status={health?.llm ?? 'UNKNOWN'} /></article>
      <article><SpeakerHigh weight="fill" /><span><b>语音输出</b><small>{settings.providers.tts.adapter === 'windows' ? settings.providers.tts.voiceId : settings.providers.tts.model || '尚未选择语音模型'}</small></span><Pill status={health?.tts ?? 'UNKNOWN'} /></article>
      <article><UserCircle weight="fill" /><span><b>最终画面</b><small>{settings.presentation.mode === 'VIDEO_ONCE' ? '预录视频单次播放' : settings.presentation.mode === 'VIDEO_LOOP' ? '预录视频循环播放' : settings.presentation.mode === 'DIGITAL_HUMAN' ? '实时数字人' : '仅声音'}</small></span><Pill status={health?.avatar ?? 'UNKNOWN'} /></article>
      <div className="integration-flow"><b>正式链路</b><span>TikFinity → 本地起卦 → DeepSeek 解读 → 当前音色 → {settings.presentation.mode === 'VIDEO_ONCE' ? '视频单次播放' : settings.presentation.mode === 'VIDEO_LOOP' ? '视频循环播放' : settings.presentation.mode === 'DIGITAL_HUMAN' ? '实时数字人' : '仅声音'}</span><small>每条任务开始时锁定语言、音色和画面，处理中修改配置只影响下一位。</small></div>
    </div>
    <div className="connect-step-strip" aria-label="接入配置顺序"><span><i>1</i><b>事件与内容</b><small>连接直播间并选择输出语言</small></span><em>→</em><span><i>2</i><b>声音</b><small>选择音色并用文案试听</small></span><em>→</em><span><i>3</i><b>画面</b><small>视频单次或实时数字人</small></span><em>→</em><span><i>4</i><b>开播预检</b><small>真实服务全部通过才开播</small></span></div>
    <div className="connect-grid">
      <article><header><span><Radio weight="fill" /><b>直播事件</b></span><Pill status={health?.input ?? 'UNKNOWN'} /></header><p>抓取 TikTok 评论、点赞和礼物；只有收到合法事件才会显示 READY。</p><label>来源<select value={settings.providers.liveInput.adapter} onChange={(event) => patchLiveInput({ adapter: event.target.value as typeof settings.providers.liveInput.adapter })}><option value="tikfinity">TikFinity Desktop（直播）</option><option value="local">本地排练</option></select></label><label>接口地址<input value={settings.providers.liveInput.url} onChange={(event) => patchLiveInput({ url: event.target.value })} /></label><small className="truth-note">当前：{health?.providers.find((item) => item.id === 'tikfinity' || item.id === 'local-live-input')?.message ?? '等待检查'} · 默认每 2 秒刷新事件记录</small></article>
      <article><header><span><Lightning weight="fill" /><b>内容生成与语言</b></span><Pill status={health?.llm ?? 'UNKNOWN'} /></header><p>本地梅花引擎先锁定本卦、动爻和变卦，模型只按事实生成所选语言的话术；失败或内容过短会暂停重试。</p><div className="content-output-controls"><label>播报语言<select value={settings.overlay.contentLanguage} onChange={(event) => setSettings({ ...settings, overlay: { ...settings.overlay, contentLanguage: event.target.value as AppSettings['overlay']['contentLanguage'] } })}>{contentLanguageOptions.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}</select><small>{contentLanguageOptions.find((language) => language.value === settings.overlay.contentLanguage)?.ttsHint}</small></label><label>文本模型<select value={settings.providers.llm.adapter} onChange={(event) => patchLlm({ adapter: event.target.value as typeof settings.providers.llm.adapter })}><option value="rule-based">本地规则引擎</option><option value="openai-compatible">OpenAI 兼容接口（DeepSeek / 阿里百炼）</option></select></label></div>{settings.providers.llm.adapter === 'openai-compatible' && <div className="provider-fields"><label>接口地址<input placeholder="https://api.deepseek.com/v1" value={settings.providers.llm.baseUrl} onChange={(event) => patchLlm({ baseUrl: event.target.value })} /></label><label>模型<input placeholder="deepseek-chat 或 qwen-plus" value={settings.providers.llm.model} onChange={(event) => patchLlm({ model: event.target.value })} /></label><label className="wide">API Key<input type="password" autoComplete="new-password" placeholder={secretStatus?.llm.configured ? '已安全保存；留空不会覆盖' : '输入 API Key'} value={llmApiKey} onChange={(event) => setLlmApiKey(event.target.value)} /></label><div className="secret-state"><span>{secretStatus?.llm.configured ? '✓ API Key 已由 Windows DPAPI 加密保存' : '尚未保存 API Key'}</span><div><button disabled={!llmApiKey || Boolean(busy)} onClick={() => void act('llm-secret', () => saveProviderSecret('llm', llmApiKey), '内容生成 API Key 已安全保存')}>保存密钥</button><button className="primary" disabled={Boolean(busy)} onClick={() => void act('llm-test', async () => { await request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }); await request('/api/providers/llm/test', { method: 'POST' }); }, '外部内容生成已通过真实调用测试', true)}>测试连接</button></div></div></div>}<small className="truth-note">当前正式输出：{contentLanguageOptions.find((language) => language.value === settings.overlay.contentLanguage)?.label}。声音服务必须支持同一语言，否则开播预检会明确阻止。</small></article>
      <article className="voice-card"><header><span><SpeakerHigh weight="fill" /><b>语音与声音克隆</b></span><Pill status={health?.tts ?? 'UNKNOWN'} /></header><p>卦象文案按所选国家语言生成，再由同一个授权音色合成 WAV 并自动播放。</p>
        <label>方式<select value={settings.providers.tts.adapter} onChange={(event) => {
          const adapter = event.target.value as typeof settings.providers.tts.adapter;
          if (adapter === 'windows') patchTts({ adapter, voiceId: 'Microsoft Zira Desktop', reuseLlmKey: true, activeVoiceProfileId: undefined });
          else if (adapter === 'elevenlabs') patchTts({ adapter, baseUrl: 'https://api.elevenlabs.io/v1', model: 'eleven_multilingual_v2', voiceId: '', reuseLlmKey: false, activeVoiceProfileId: undefined });
          else if (adapter === 'kokoro') patchTts({ adapter, baseUrl: 'http://127.0.0.1:9890', model: 'kokoro-v1.0.onnx', voiceId: 'af_heart', reuseLlmKey: false, activeVoiceProfileId: undefined, kokoro: { ...settings.providers.tts.kokoro, baseUrl: 'http://127.0.0.1:9890', defaultVoice: 'af_heart' } });
    else patchTts({ adapter, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voiceId: 'alloy', reuseLlmKey: true, activeVoiceProfileId: undefined });
        }}><option value="windows">Windows 本地语音（不克隆）</option><option value="kokoro">Kokoro 本地神经英文女声（免 Key）</option><option value="gptsovits">本地声音克隆（GPT-SoVITS）</option><option value="elevenlabs">ElevenLabs 授权声音克隆</option><option value="openai-compatible">OpenAI 兼容语音</option></select></label>
         {settings.providers.tts.adapter === 'windows' ? <div className="local-provider-fields"><label>本地系统声音<select value={settings.providers.tts.voiceId} onChange={(event) => patchTts({ voiceId: event.target.value, activeVoiceProfileId: undefined })}>{localVoicePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label><small className="truth-note">当前选择的 Windows 音色会根据下方试听文案和正式卦辞重新合成 WAV；不需要接口地址、模型或 API Key。系统未安装所选音色时会明确报错，不会偷偷改用默认声音。</small></div> : settings.providers.tts.adapter === 'kokoro' ? <div className="local-provider-fields"><label>内置英文女声<select value={settings.providers.tts.voiceId} onChange={(event) => patchTts({ voiceId: event.target.value, activeVoiceProfileId: undefined, kokoro: { ...settings.providers.tts.kokoro, defaultVoice: event.target.value } })}><option value="af_heart">Heart · 温暖自然（推荐）</option><option value="af_bella">Bella · 清晰明亮</option><option value="af_sarah">Sarah · 稳定亲和</option><option value="bf_emma">Emma · 英式女声</option></select></label><label>语速 <b>{settings.providers.tts.speed.toFixed(2)}×</b><input type="range" min="0.5" max="2" step="0.05" value={settings.providers.tts.speed} onChange={(event) => patchTts({ speed: Number(event.target.value) })} /></label><label className="wide">试听文案<textarea rows={3} value={voiceDemoText} onChange={(event) => setVoiceDemoText(event.target.value)} /></label><div className="secret-state"><span>本地 Kokoro · 无需 API Key</span><button className="primary" disabled={Boolean(busy) || !voiceDemoText.trim()} onClick={() => void act('kokoro-test', async () => { await request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }); await request('/api/providers/tts/test', { method: 'POST', body: JSON.stringify({ text: voiceDemoText, locale: 'en' }) }); }, 'Kokoro 英文女声已生成并播放', true)}>生成并试听</button></div><small className="wide truth-note">试听和正式卦辞都会由当前 Kokoro 音色重新合成，不会回退成 Windows 原声；这是预置音色模板，不是真人声音克隆。</small></div> : settings.providers.tts.adapter === 'gptsovits' ? <div className="local-provider-fields"><label>本地克隆音色<select value={settings.providers.tts.activeVoiceProfileId ?? settings.providers.tts.voiceId} onChange={(event) => { const id = event.target.value; patchTts({ voiceId: id, activeVoiceProfileId: localClonedVoiceProfiles.some((profile) => profile.id === id) ? id : undefined }); }}><option value="">先在“数字人工作台”创建本地声音</option>{localClonedVoiceProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.targetLocale ?? profile.language}</option>)}</select></label><small className="truth-note">当前为本地 GPT-SoVITS 声音，直接在本机合成；不需要云端 API Key。上传声音、克隆和试听请在“数字人工作台”完成。</small><label>语速 <b>{settings.providers.tts.speed.toFixed(2)}×</b><input type="range" min="0.25" max="2" step="0.05" value={settings.providers.tts.speed} onChange={(event) => patchTts({ speed: Number(event.target.value) })} /></label><div className="voice-demo-library wide"><div>{voiceDemoScripts.map((sample) => <button key={sample.label} className={voiceDemoText === sample.text ? 'active' : ''} onClick={() => setVoiceDemoText(sample.text)}>{sample.label}</button>)}</div><label>试听文案<textarea rows={3} value={voiceDemoText} onChange={(event) => setVoiceDemoText(event.target.value)} /></label></div><div className="secret-state"><span>✓ 本地语音无需 API Key</span><button className="primary" disabled={Boolean(busy) || !settings.providers.tts.voiceId || !voiceDemoText.trim()} onClick={() => void act('tts-test', async () => { await request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }); await request('/api/providers/tts/test', { method: 'POST', body: JSON.stringify({ text: voiceDemoText }) }); }, '真实语音已生成并通过本机试听', true)}>生成并试听</button></div></div> : <div className="provider-fields">
          <label>接口地址<input value={settings.providers.tts.baseUrl} onChange={(event) => patchTts({ baseUrl: event.target.value })} /></label>
          <label>多语言模型<input value={settings.providers.tts.model} onChange={(event) => patchTts({ model: event.target.value })} /></label>
          {settings.providers.tts.adapter === 'elevenlabs' ? <>
            <label className="wide">已创建的声音<div className="inline-field"><select value={settings.providers.tts.voiceId} onChange={(event) => patchTts({ voiceId: event.target.value })}><option value="">先保存 API Key，再刷新声音库</option>{voiceProfiles.map((voice) => <option key={voice.voiceId} value={voice.voiceId}>{voice.name}{voice.category ? ` · ${voice.category}` : ''}</option>)}</select><button disabled={Boolean(busy) || !secretStatus?.tts.configured} onClick={() => void act('voice-list', loadVoiceProfiles, '声音库已刷新')}>刷新声音库</button></div></label>
            <details className="voice-clone wide"><summary>克隆一个新声音</summary><div className="clone-grid"><label>声音名称<input placeholder="例如：梅花老师英文音色" value={voiceName} onChange={(event) => setVoiceName(event.target.value)} /></label><label>授权样音<input type="file" accept="audio/wav,audio/mpeg,audio/ogg,audio/flac,audio/aac,audio/mp4,audio/webm,video/mp4,video/webm" onChange={(event) => setVoiceSample(event.target.files?.[0])} /></label><label className="check-label wide"><input type="checkbox" checked={voiceAuthorized} onChange={(event) => setVoiceAuthorized(event.target.checked)} />我确认这是本人声音，或已取得声音所有者明确授权</label><button className="primary wide" disabled={!voiceSample || !voiceName.trim() || !voiceAuthorized || Boolean(busy) || !secretStatus?.tts.configured} onClick={() => void act('voice-clone', cloneVoice, '声音已真实创建并自动选中', true)}>上传样音并创建声音</button><small className="wide truth-note">支持 WAV、MP3、OGG、FLAC、AAC、M4A、MP4、WebM，最大 10MB。原始样音直接发送给服务商，本机不保存副本。</small></div></details>
            <label>稳定度 <b>{Math.round(settings.providers.tts.stability * 100)}%</b><input type="range" min="0" max="1" step="0.05" value={settings.providers.tts.stability} onChange={(event) => patchTts({ stability: Number(event.target.value) })} /></label>
            <label>音色相似度 <b>{Math.round(settings.providers.tts.similarityBoost * 100)}%</b><input type="range" min="0" max="1" step="0.05" value={settings.providers.tts.similarityBoost} onChange={(event) => patchTts({ similarityBoost: Number(event.target.value) })} /></label>
            <label>表现力 <b>{Math.round(settings.providers.tts.style * 100)}%</b><input type="range" min="0" max="1" step="0.05" value={settings.providers.tts.style} onChange={(event) => patchTts({ style: Number(event.target.value) })} /></label>
            <label className="check-label"><input type="checkbox" checked={settings.providers.tts.speakerBoost} onChange={(event) => patchTts({ speakerBoost: event.target.checked })} />增强原声相似度</label>
          </> : <><div className="voice-preset-library wide"><header><b>官方内置音色预设</b><small>选择后用下方真实接口生成试听，不下载来源不明的声音文件。</small></header><div>{voicePresets.map((preset) => <button key={preset.id} className={settings.providers.tts.voiceId === preset.id ? 'active' : ''} onClick={() => patchTts({ voiceId: preset.id })}><SpeakerHigh weight="fill" /><span><b>{preset.name}</b><small>{preset.note}</small></span></button>)}</div></div><label>声音 ID<input placeholder="alloy 或服务商 voiceId" value={settings.providers.tts.voiceId} onChange={(event) => patchTts({ voiceId: event.target.value })} /></label><label className="tone-field">语气与表达<input value={settings.providers.tts.instructions} onChange={(event) => patchTts({ instructions: event.target.value })} /></label><label className="check-label"><input type="checkbox" checked={settings.providers.tts.reuseLlmKey} onChange={(event) => patchTts({ reuseLlmKey: event.target.checked })} />与内容生成共用 API Key</label></>}
          <label>语速 <b>{settings.providers.tts.speed.toFixed(2)}×</b><input type="range" min={settings.providers.tts.adapter === 'elevenlabs' ? '0.7' : '0.25'} max={settings.providers.tts.adapter === 'elevenlabs' ? '1.2' : '2'} step="0.05" value={settings.providers.tts.speed} onChange={(event) => patchTts({ speed: Number(event.target.value) })} /></label>
          {!settings.providers.tts.reuseLlmKey && <label className="wide">语音 API Key<input type="password" autoComplete="new-password" placeholder={secretStatus?.tts.configured ? '已加密保存；留空不会覆盖' : '输入语音服务 API Key'} value={ttsApiKey} onChange={(event) => setTtsApiKey(event.target.value)} /></label>}
          <div className="voice-demo-library wide"><div>{voiceDemoScripts.map((sample) => <button key={sample.label} className={voiceDemoText === sample.text ? 'active' : ''} onClick={() => setVoiceDemoText(sample.text)}>{sample.label}</button>)}</div><label>试听文案<textarea rows={3} value={voiceDemoText} onChange={(event) => setVoiceDemoText(event.target.value)} /></label></div>
          <div className="secret-state"><span>{secretStatus?.tts.configured ? '✓ 语音密钥已由 Windows DPAPI 加密保存' : '尚未配置语音密钥'}</span><div>{!settings.providers.tts.reuseLlmKey && <button disabled={!ttsApiKey || Boolean(busy)} onClick={() => void act('tts-secret', () => saveProviderSecret('tts', ttsApiKey), '语音 API Key 已安全保存')}>保存密钥</button>}<button className="primary" disabled={Boolean(busy) || !settings.providers.tts.voiceId || !voiceDemoText.trim()} onClick={() => void act('tts-test', async () => { await request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }); await request('/api/providers/tts/test', { method: 'POST', body: JSON.stringify({ text: voiceDemoText }) }); }, '真实语音已生成并通过本机试听', true)}>生成并试听</button></div></div>
          <small className="wide truth-note">输出语言自动跟随“画面工作台”的语言设置；声音克隆不会改变文本语言。克隆音色可能保留原说话人的口音，正式开播前应逐语言试听。</small>
        </div>}
      </article>
      {settings.presentation.mode === 'DIGITAL_HUMAN' && <article className="avatar-runtime-card"><header><span><UserCircle weight="fill" /><b>实时数字人运行方式</b></span><Pill status={health?.avatar ?? 'UNKNOWN'} /></header><p>只有选择“实时数字人”时才显示此项；预录视频模式完全不依赖人物渲染服务。</p><label>运行方式<select value={settings.providers.avatar.adapter} onChange={(event) => setSettings({ ...settings, providers: { ...settings.providers, avatar: { ...settings.providers.avatar, adapter: event.target.value as typeof settings.providers.avatar.adapter } } })}><option value="none">OBS 人物素材源</option><option value="mock">数字人供应商适配层（模拟）</option><option value="musetalk">MuseTalk 本地实时口型（需 GPU）</option><option value="vtube-studio">VTube Studio 阶段动作（实验）</option></select></label>{settings.providers.avatar.adapter === 'mock' && <div className="secret-state adapter-layer-note"><span>{health?.avatarProvider?.status === 'READY' ? '适配层已连接' : '适配层待接入'}</span><small>真实供应商需完成账户授权、绿幕输出与 OBS 录制验收。</small></div>}{settings.providers.avatar.adapter === 'musetalk' && <label>渲染服务地址<input value={settings.providers.avatar.url} onChange={(event) => setSettings({ ...settings, providers: { ...settings.providers, avatar: { ...settings.providers.avatar, url: event.target.value } } })} /></label>}{settings.providers.avatar.adapter === 'vtube-studio' && <label>实验接口地址<input value={settings.providers.avatar.url} onChange={(event) => setSettings({ ...settings, providers: { ...settings.providers, avatar: { ...settings.providers.avatar, url: event.target.value } } })} /></label>}<button onClick={() => setTab('avatar')}><UserCircle />进入数字人中心</button></article>}
    </div>
    <div className="connect-output-heading"><div><b>最终画面与统一播报</b><small>这里决定声音开始时 OBS 播什么；画面工作台里的“播报画面”图层会直接使用这项设置。</small></div><span>{settings.presentation.mode === 'VIDEO_ONCE' ? '推荐 · 每条只播一次' : settings.presentation.mode}</span></div>
    <PresentationPanel settings={settings} assets={assets} onSaved={() => refresh(true)} />
    <details className="connect-advanced"><summary><span><b>高级人物与数字人说明</b><small>默认视频模式不需要配置；需要 MuseTalk、云数字人或 VTube Studio 时再展开。</small></span><CaretRight /></summary><Panel title="数字人投产方案" hint="实时数字人是可选模式，不得影响默认预录视频链路。"><div className="avatar-production"><div className="recommended-flow"><span>推荐</span><b>预录人物视频</b><p>声音开始时从第 0 秒静音播放一次，声音结束立即停止；这是当前生产默认。</p></div><div><b>实时数字人</b><p>使用同一 WAV 驱动 MuseTalk、阿里或百度数字人口型，失败时按备用策略处理。</p></div><div><b>VTube Studio</b><p>仅保留实验阶段动作；未授权、无模型时不会显示 READY。</p></div></div>{settings.providers.avatar.adapter === 'vtube-studio' && <details className="advanced-connect"><summary>打开 VTube Studio 实验联调</summary><div className="wizard-steps"><button onClick={() => void act('vtube-connect', () => request('/api/avatar/vtube/connect', { method: 'POST' }), '已检查 VTube Studio 连接')}><span>1</span><b>检查连接</b><small>确认 Plugin API 已开启</small></button><button onClick={() => void act('vtube-authorize', () => request('/api/avatar/vtube/authorize', { method: 'POST' }), '请在授权弹窗中确认')}><span>2</span><b>授权</b><small>令牌由 DPAPI 保存</small></button><button onClick={() => void act('vtube-actions', () => request('/api/avatar/vtube/test-actions', { method: 'POST' }), '已发送动作测试')}><span>3</span><b>测试动作</b><small>不发送嘴型参数</small></button></div></details>}</Panel></details>
  </section>;

  const recordsPage = <section className="page records-page">
    <div className="workspace-title"><div><span className="eyebrow">SESSION RECORDS</span><h2>数据记录</h2><p>本场榜单、最近测算与系统审计分区展示。</p></div><Pill status={session?.status ?? 'ARCHIVED'} /></div>
    <div className="record-summary">
      <div><Database weight="fill" /><span>全部测算<small>当前本机数据库</small></span><strong>{readings.length}</strong></div>
      <div><CheckCircle weight="fill" /><span>成功完成<small>已生成并结束</small></span><strong>{completedReadings}</strong></div>
      <div><Gift weight="fill" /><span>本场礼物积分<small>{giftRanking.length} 位观众</small></span><strong>{giftPoints}</strong></div>
      <div><Heart weight="fill" /><span>本场互动积分<small>{engagementRanking.length} 位观众</small></span><strong>{engagementPoints}</strong></div>
    </div>
    <div className="records-layout">
      <Panel title="记录中心" hint="按类型、日期、状态或观众快速筛选。" className="record-browser" action={<span className="version-tag">{recordView === 'readings' ? filteredReadings.length : filteredEvents.length} 条结果</span>}>
        <div className="record-tabs"><button className={recordView === 'readings' ? 'active' : ''} onClick={() => setRecordView('readings')}>测算记录</button><button className={recordView === 'events' ? 'active' : ''} onClick={() => setRecordView('events')}>系统审计</button></div>
        <div className="record-toolbar"><label>搜索<input placeholder="观众、问题或事件" value={recordQuery} onChange={(event) => setRecordQuery(event.target.value)} /></label><label>日期<input type="date" value={recordDate} onChange={(event) => setRecordDate(event.target.value)} /></label>{recordView === 'readings' && <label>状态<select value={recordStatus} onChange={(event) => setRecordStatus(event.target.value)}><option value="ALL">全部状态</option><option value="COMPLETED">已完成</option><option value="REJECTED">已拒绝</option><option value="SKIPPED">已跳过</option><option value="FAILED">失败</option><option value="QUEUED">排队中</option></select></label>}<button onClick={() => { setRecordQuery(''); setRecordDate(''); setRecordStatus('ALL'); }}>清除筛选</button></div>
        {recordView === 'readings' ? <div className="reading-table"><header><span>观众与时间</span><span>问题</span><span>结果</span></header>{filteredReadings.slice(0, 40).map((item) => <div key={item.id}><span><strong>@{item.username}</strong><small>{new Date(item.createdAt).toLocaleString()}</small></span><p>{item.normalizedQuestion ?? item.rawQuestion}</p><Pill status={item.status} /></div>)}{!filteredReadings.length && <div className="empty">没有符合筛选条件的测算记录</div>}</div> : <div className="event-list">{filteredEvents.slice(0, 50).map((item) => <div key={item.id}><time>{new Date(item.createdAt).toLocaleString()}</time><strong>{item.type}</strong><details><summary>{eventSummary(item.payload)}</summary><code>{JSON.stringify(item.payload, null, 2)}</code></details></div>)}{!filteredEvents.length && <div className="empty">没有符合筛选条件的审计事件</div>}</div>}
      </Panel>
      <aside className="ranking-rail"><Panel title="礼物榜" hint="本场礼物积分" action={<Gift weight="fill" />}><div className="ranking-list">{giftRanking.slice(0, 10).map((item) => <div key={item.userKey}><em>{item.rank}</em><strong>@{item.username}</strong><b>{item.points} 分</b></div>)}{!giftRanking.length && <div className="empty">本场暂无礼物</div>}</div></Panel><Panel title="互动榜" hint="点赞与有效评论" action={<Heart weight="fill" />}><div className="ranking-list">{engagementRanking.slice(0, 10).map((item) => <div key={item.userKey}><em>{item.rank}</em><strong>@{item.username}</strong><b>{item.points} 分</b></div>)}{!engagementRanking.length && <div className="empty">本场暂无互动积分</div>}</div></Panel></aside>
    </div>
  </section>;

  const legacyAvatarPage = (
    <div>
      <div className="workspace-title"><div><span className="eyebrow">DIGITAL HUMAN</span><h2>数字人工作台</h2><p>音色克隆 → 口型渲染 → 舞台合成：服务就绪后直播流水线自动使用。</p></div><button className="primary" disabled={busy === 'dh-probe'} onClick={() => void act('dh-probe', probeDigitalHuman, '数字人服务状态已刷新', true)}><CheckCircle weight="fill" />{busy === 'dh-probe' ? '检测中…' : '检测服务'}</button></div>
      <div className="connect-grid">
        <article><header><span><SpeakerHigh weight="fill" /><b>声音克隆 · GPT-SoVITS</b></span><Pill status={dhStatus ? (dhStatus.gptsovits.ok ? 'READY' : 'NOT_CONFIGURED') : 'UNKNOWN'} /></header><p>{dhStatus ? (dhStatus.gptsovits.ok ? `服务在线（${dhStatus.gptsovits.voices} 个音色）` : `服务未连通：${dhStatus.gptsovits.detail}`) : '点击「检测服务」查看状态'}</p><label>服务地址<input value={settings?.providers.tts.gptsovits.baseUrl ?? ''} onChange={(event) => setSettings((current) => current ? ({ ...current, providers: { ...current.providers, tts: { ...current.providers.tts, gptsovits: { ...current.providers.tts.gptsovits, baseUrl: event.target.value } } } }) : current)} /></label><small className="truth-note">启动：scripts/start-gptsovits.ps1（默认 127.0.0.1:9881）</small></article>
        <article><header><span><UserCircle weight="fill" /><b>口型渲染 · MuseTalk</b></span><Pill status={dhStatus ? (dhStatus.musetalk.ok ? 'READY' : 'NOT_CONFIGURED') : 'UNKNOWN'} /></header><p>{dhStatus ? (dhStatus.musetalk.ok ? `服务在线 · 已准备形象：${dhStatus.musetalk.avatars.length ? dhStatus.musetalk.avatars.join('、') : '无'}` : `服务未连通：${dhStatus.musetalk.detail}`) : '点击「检测服务」查看状态'}</p><label>渲染服务地址<input value={settings?.providers.avatar.url ?? ''} onChange={(event) => setSettings((current) => current ? ({ ...current, providers: { ...current.providers, avatar: { ...current.providers.avatar, url: event.target.value } } }) : current)} /></label><small className="truth-note">需带 NVIDIA GPU 的直播机；OBS 采集虚拟摄像头画面（静音）</small></article>
      </div>
      <Panel title="音色库（本地声音克隆）" hint="上传 5–10 秒干净人声 + 它说的文字；试音通过后即可进入直播链路。" action={<button onClick={() => void act('voice-upload', uploadVoicePack, '音色已上传', true)} disabled={!voicePackName || !voicePackFile}>上传音色</button>}>
        {(settings?.providers.tts.gptsovits.voices ?? []).map((voice) => (
          <div key={voice.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
            <b>{voice.name}</b>
            <span style={{ opacity: .7 }}>{voice.refLanguage.toUpperCase()} · {voice.refText.slice(0, 40)}</span>
            <span style={{ flex: 1 }} />
            <button disabled={Boolean(busy)} onClick={() => void act(`audition-${voice.id}`, () => auditionVoicePack(voice.id), `试音完成（${voice.name}）`)}>试音</button>
            <button disabled={Boolean(busy)} onClick={() => void act(`remove-${voice.id}`, () => request(`/api/tts/voices/${encodeURIComponent(voice.id)}`, { method: 'DELETE' }), '音色已删除', true)}>删除</button>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
          <label>音色名称<input value={voicePackName} onChange={(event) => setVoicePackName(event.target.value)} placeholder="例如：美式女声" /></label>
          <label>参考语言<select value={voicePackLang} onChange={(event) => setVoicePackLang(event.target.value as 'zh' | 'en')}><option value="en">English</option><option value="zh">中文</option></select></label>
          <label className="wide">参考音频（5–10 秒干净人声）<input type="file" accept="audio/wav,audio/mpeg" onChange={(event) => setVoicePackFile(event.target.files?.[0])} /></label>
          <label className="wide">参考音频说的文字<input value={voicePackText} onChange={(event) => setVoicePackText(event.target.value)} placeholder="逐字填写音频里说的内容" /></label>
        </div>
        <small className="truth-note">西语等 GPT-SoVITS 不支持的语种会自动路由：云端 TTS（已配置时）→ Windows 西语声音。</small>
      </Panel>
      <Panel title="形象库（MuseTalk 口型渲染）" hint="上传正面人物视频并预处理；试画面会把口型视频推送到虚拟摄像头。" action={<button onClick={() => void act('avatar-prep', prepMuseTalkAvatar, '形象预处理完成')}>预处理形象</button>}>
        <label>人物视频完整路径（正面半身、25fps 左右、5 秒以上）<input value={avatarVideoPath} onChange={(event) => setAvatarVideoPath(event.target.value)} placeholder="例如 E:\meihua\avatar\source.mp4" /></label>
        <div style={{ marginTop: 10 }}>
          <button disabled={Boolean(busy)} onClick={() => void act('avatar-test', testMuseTalkAvatar, '试画面完成')}>试画面（用最近一条语音渲染）</button>
          <span style={{ marginLeft: 12, opacity: .7 }}>{dhStatus?.musetalk.avatars.length ? `已准备：${dhStatus.musetalk.avatars.join('、')}` : '尚无已准备形象'}</span>
        </div>
        <small className="truth-note">预处理与渲染需要 GPU（RTX 3060 12G 起步）；画面经虚拟摄像头进入 OBS，务必在 OBS 中将其静音。</small>
      </Panel>
    </div>
  );

  void legacyAvatarPage;
  const avatarPage = <DigitalHumanStudio />;

  const studioConsole = <main className="admin-shell">
    <header className="topbar"><div className="brand-lockup"><div className="brand-mark"><SquaresFour weight="fill" /></div><div><p>MEIHUA LIVE CONTROL</p><h1>Studio Console</h1></div></div><div className="session-controls">{liveControls}</div><div className="top-metrics"><div><span>开播状态</span><strong className={session?.status === 'LIVE' ? 'live-text' : ''}>{session?.status === 'LIVE' ? 'LIVE' : session?.status ?? '未开播'}</strong></div><div><span>当前阶段</span><strong>{stage}</strong></div><div><span>正在连麦观众</span><strong>{active ? `@${active.username}` : '等待观众'}</strong></div><LiveClock /></div></header>
    <aside className="sidebar"><nav className="side-nav">{tabs.map((item) => <button key={item.id} aria-label={`${item.label} ${item.note}`} title={item.label} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><span className="nav-icon">{tabIcons[item.id]}</span><span><strong>{item.label}</strong><small>{item.note}</small></span></button>)}</nav><div className="sidebar-foot"><div className="operator"><UserCircle weight="fill" /><span><strong>梅花老师</strong><small>直播导演</small></span></div><div className="system-mini"><span><i className="status-dot" />中控运行中</span><small>已运行 {elapsed(health?.uptimeMs ?? 0)}</small></div></div></aside>
    <section className="workspace">{!wsConnected && <div className="notice ws-fallback-notice"><Lightning weight="fill" />实时推送已断开，已切换为兜底轮询（5 秒）</div>}{notice && <div className="notice"><CheckCircle weight="fill" />{notice}</div>}{tab === 'live' ? livePage : tab === 'avatar' ? avatarPage : tab === 'obs' ? obsPage : tab === 'simple' ? simplePage : tab === 'connect' ? connectPage : recordsPage}</section>
  </main>;

  return <>
    {studioConsole}
    {authExpired && <div className="mw-auth-recovery"><div><b>中控服务已重启</b><p>安全令牌已更新，页面正在重新连接。若没有自动恢复，请手动刷新一次。</p><button onClick={() => window.location.reload()}>立即重新连接</button></div></div>}
    {recalculationOpen && recalculationPreview && <div className="studio-modal-v5 operation-recalculation-modal" onMouseDown={(event) => { if (event.target === event.currentTarget && busy !== 'recalculate-data') setRecalculationOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="recalculation-title">
        <header>
          <div><b id="recalculation-title">统一重新计算</b><small>以本场直播原始事件和已记录任务为唯一依据</small></div>
          <button className="modal-close" aria-label="关闭统一重新计算窗口" disabled={busy === 'recalculate-data'} onClick={() => setRecalculationOpen(false)}><X weight="bold" /></button>
        </header>
        <div className="recalculation-body">
          <div className="recalculation-intro"><Database weight="duotone" /><div><b>重建派生数据，不删除原始记录</b><p>系统将重新核对直播事件、排队任务、待提问资格、点赞统计和礼物榜单。已完成的解卦、直播原始事件、音频和素材全部保留。</p></div></div>
          <div className="recalculation-session">
            <span>计算场次</span><strong>{recalculationPreview.sessionId ? `${recalculationPreview.sessionId.slice(0, 8)}…` : '无可用场次'}</strong>
            <span>场次状态</span><strong>{recalculationPreview.sessionStatus ?? '—'}</strong>
            <span>数据范围</span><strong>{recalculationPreview.range ? `${new Date(recalculationPreview.range.from).toLocaleString()} 至 ${new Date(recalculationPreview.range.to).toLocaleString()}` : '—'}</strong>
          </div>
          <div className="recalculation-metrics" aria-label="重新计算影响预览">
            <article><span>直播原始事件</span><b>{recalculationPreview.scanned.liveEvents}</b><small>评论 {recalculationPreview.scanned.chats} · 点赞 {recalculationPreview.scanned.likes} · 礼物 {recalculationPreview.scanned.gifts}</small></article>
            <article><span>已记录任务</span><b>{recalculationPreview.scanned.readings}</b><small>保留已完成 {recalculationPreview.preserved.completedReadings} 条</small></article>
            <article><span>恢复正式排队</span><b>{recalculationPreview.rebuilt.queueItems}</b><small>按数据库 QUEUED 状态重建</small></article>
            <article><span>待提问资格</span><b>{recalculationPreview.rebuilt.pendingQualifications}</b><small>只保留尚未过期的资格</small></article>
            <article><span>互动统计观众</span><b>{recalculationPreview.rebuilt.engagementUsers}</b><small>按当前点赞与评论积分规则</small></article>
            <article><span>礼物榜观众</span><b>{recalculationPreview.rebuilt.giftUsers}</b><small>按当前启用的礼物规则</small></article>
          </div>
          {recalculationPreview.blockingReason
            ? <div className="recalculation-blocked" role="alert"><WarningCircle weight="fill" /><span><b>现在不能执行</b><small>{recalculationPreview.blockingReason}</small></span></div>
            : <div className="recalculation-safe"><CheckCircle weight="fill" /><span><b>可以安全执行</b><small>执行后中控台会立即刷新，直播历史和已完成解卦不会改变。</small></span></div>}
        </div>
        <footer className="recalculation-footer"><button disabled={busy === 'recalculate-data'} onClick={() => setRecalculationOpen(false)}>取消</button><button className="primary" disabled={!recalculationPreview.canApply || Boolean(busy)} onClick={() => void applyOperationalRecalculation()}><ArrowCounterClockwise weight="bold" />{busy === 'recalculate-data' ? '正在重新计算…' : '开始统一重新计算'}</button></footer>
      </section>
    </div>}
    {assetLibraryOpen && draft && source && <AssetLibraryModal
      assets={assets}
      sourceAssetId={source.backgroundAssetId}
      lux3dAssetId={draft.profile.visualAssets?.lux3dCoreAssetId}
      onClose={() => setAssetLibraryOpen(false)}
      onDone={() => refresh(true)}
      onBindSource={(assetId) => patchSource(selectedSource, { backgroundAssetId: assetId })}
      onBindLux3D={(assetId) => patchVisualAssets({ lux3dCoreAssetId: assetId })}
    />}
  </>;

}
