import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { resolveBackgroundMode } from "@meihua/core-types";
import type {
  BroadcastSnapshotV2,
  AvatarActionName,
  ContentLanguage,
  DirectorMessageV2,
  DirectorStage,
  HexagramLine,
  MeihuaResult,
  ObsSourceConfig,
  ObsSourceId,
  QueueOverviewEntry,
  SceneProfile,
  SceneProfileVersion,
  SpeechSegment,
} from "@meihua/core-types";
import "./captions.css";
import "./obs-output.css";
import { formatHexagramDisplayName } from "@meihua/answer-composer";
import { StageSource } from "./stage.js";
import { VrmAvatar } from "./VrmAvatar.js";

const apiBase =
  import.meta.env.VITE_ORCHESTRATOR_HTTP ?? "http://127.0.0.1:3210";
const liveSocketUrl =
  import.meta.env.VITE_ORCHESTRATOR_WS ?? "ws://127.0.0.1:3210/ws/overlay";
const controlToken =
  typeof document !== "undefined"
    ? (document.querySelector<HTMLMetaElement>(
        'meta[name="meihua-control-token"]',
      )?.content ?? "")
    : "";
const authHeaders: Record<string, string> = controlToken
  ? { "x-meihua-token": controlToken }
  : {};
export const authenticatedUrl = (url: string) =>
  controlToken
    ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(controlToken)}`
    : url;

/** A content hash is part of the URL so an in-place media repair cannot leave OBS on a stale cached file. */
export const mediaAssetUrl = (snapshot: BroadcastSnapshotV2, assetId: string) => {
  const revision = snapshot.mediaAssets?.find((asset) => asset.id === assetId)?.contentHash ?? String(snapshot.mediaEpoch ?? "0");
  return authenticatedUrl(`${apiBase}/api/media-assets/${assetId}/content?v=${encodeURIComponent(revision)}`);
};

export function qualificationLabel(
  source: QueueOverviewEntry["source"],
  label?: string,
  _giftName?: string,
): string {
  // Gift names are admin metadata. The live canvas exposes only the qualification.
  if (source === "GIFT") return "GIFT PRIORITY";
  if (source === "LIKE") {
    const count = String(label ?? "").match(/\d+/)?.[0];
    return count ? `${count} LIKES` : "LIKE QUALIFIED";
  }
  if (source === "COMMENT_KEYWORD")
    return label ? `KEYWORD: ${label}` : "KEYWORD QUALIFIED";
  if (source === "MANUAL") return "MANUALLY ADDED";
  return "QUEUED";
}

export function qualificationText(
  item: Pick<QueueOverviewEntry, "source" | "label" | "giftName">,
): string {
  return qualificationLabel(item.source, item.label, item.giftName);
}

const sourceMeta: Record<ObsSourceId, { name: string; description: string }> = {
  avatar: {
    name: "媒体数字人",
    description: "动作视频或静态形象，视频始终静音",
  },
  background: { name: "背景", description: "独立图片或循环视频背景" },
  "current-viewer": {
    name: "当前观众",
    description: "@观众、问题、资格和本轮时长",
  },
  hexagram: {
    name: "卦象与当前测算",
    description: "观众、问题、本卦、互卦、变卦和动爻",
  },
  subtitles: { name: "分句字幕", description: "按统一口播时间轴滚动" },
  queue: {
    name: "资格与等待队列",
    description: "待提问观众、已提问观众和实时顺序",
  },
  "gift-alert": {
    name: "礼物窗口",
    description: "配置礼物、测算时间和一句话；到账时显示实时反馈",
  },
  "gift-ranking": { name: "本场礼物榜", description: "按礼物规则积分统计" },
  "engagement-ranking": {
    name: "本场互动榜",
    description: "点赞与有效评论积分",
  },
  status: { name: "处理状态", description: "待机、起卦、推演、合成和口播" },
  effects: { name: "全局特效", description: "透明粒子、闪光与转场层" },
  sticker: {
    name: "自定义贴纸",
    description: "上传图片贴纸（PNG/WebP 透明底最佳），自由摆放在画面任意位置",
  },
  disclaimer: { name: "免责声明", description: "可配置的固定文本" },
  audio: { name: "唯一语音源", description: "不可见的 TTS 音频输出" },
  "meihua-stage": {
    name: "正式直播舞台",
    description:
      "单条链接完成整屏构图；背景、人物、当前观众、问题、卦象、队列、礼物反馈与免责声明一体联动，推荐默认使用",
  },
  "full-preview": {
    name: "完整参考画面",
    description: "仅用于排练，不作为正式分层来源",
  },
};

const sourceIds = Object.keys(sourceMeta) as ObsSourceId[];
const canvasSourceNames: Record<ObsSourceId, string> = {
  avatar: "DIGITAL HUMAN",
  background: "LIVE BACKGROUND",
  "current-viewer": "CURRENT VIEWER",
  hexagram: "MEIHUA CAST",
  subtitles: "LIVE CAPTIONS",
  queue: "WAITING LIST",
  "gift-alert": "GIFT PRIORITY",
  "gift-ranking": "GIFT RANKING",
  "engagement-ranking": "ENGAGEMENT RANKING",
  status: "LIVE STATUS",
  effects: "VISUAL EFFECTS",
  sticker: "CUSTOM STICKER",
  disclaimer: "DISCLAIMER",
  audio: "VOICE OUTPUT",
  "meihua-stage": "LIVE STAGE",
  "full-preview": "FULL PREVIEW",
};
const legacyAliases: Record<string, ObsSourceId> = {
  current: "current-viewer",
  gift: "gift-alert",
  keywords: "subtitles",
  status: "status",
  hexagram: "hexagram",
  queue: "queue",
  subtitles: "subtitles",
  disclaimer: "disclaimer",
  audio: "audio",
};

type Route =
  | { kind: "source"; sourceId: ObsSourceId; previewId?: string }
  | { kind: "lux3d" }
  | { kind: "manager" }
  | { kind: "unknown"; path: string };

function routeFromLocation(): Route {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/modules") return { kind: "manager" };
  if (path === "/obs/source/lux3d") return { kind: "lux3d" };
  const preview = path.match(/^\/preview\/([^/]+)\/source\/([a-z-]+)$/);
  if (preview && sourceIds.includes(preview[2] as ObsSourceId))
    return {
      kind: "source",
      previewId: preview[1],
      sourceId: preview[2] as ObsSourceId,
    };
  const official = path.match(/^\/obs\/source\/([a-z-]+)$/)?.[1] as
    | ObsSourceId
    | undefined;
  if (official && sourceIds.includes(official))
    return { kind: "source", sourceId: official };
  const legacy = path.match(/^\/module\/([a-z-]+)$/)?.[1];
  if (legacy && legacyAliases[legacy])
    return { kind: "source", sourceId: legacyAliases[legacy] };
  if (/^\/obs\/source\//.test(path)) return { kind: "unknown", path };
  return { kind: "source", sourceId: "full-preview" };
}

function useBroadcast(previewId?: string, sourceId?: ObsSourceId) {
  const [snapshot, setSnapshot] = useState<BroadcastSnapshotV2>();
  const [connected, setConnected] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const snapshotUrl = previewId
      ? `${apiBase}/api/preview-sessions/${previewId}/snapshot`
      : `${apiBase}/api/director/state`;
    const socketUrl = authenticatedUrl(
      previewId
        ? `${liveSocketUrl.replace(/\/ws\/overlay$/, "")}/ws/preview/${previewId}`
        : liveSocketUrl,
    );
    const apply = (value: BroadcastSnapshotV2) => {
      if (stopped) return;
      setSnapshot((current) =>
        !current || value.sequence >= current.sequence ? value : current,
      );
      setClockOffset(value.serverTime - Date.now());
    };
    const receivePreviewProfile = (event: MessageEvent) => {
      if (!previewId || event.source !== window.parent) return;
      const message = event.data as {
        type?: string;
        previewSessionId?: string;
        profile?: SceneProfile;
      };
      if (
        message?.type !== "MEIHUA_PREVIEW_PROFILE" ||
        message.previewSessionId !== previewId ||
        !message.profile?.sources
      )
        return;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              profileVersion: {
                ...current.profileVersion,
                profile: message.profile as SceneProfile,
              },
            }
          : current,
      );
    };
    window.addEventListener("message", receivePreviewProfile);
    const recoverExpiredToken = () => {
      const key = 'meihua-overlay-auth-reload-at';
      const previous = Number(window.sessionStorage.getItem(key) ?? 0);
      if (Date.now() - previous < 5_000) return;
      window.sessionStorage.setItem(key, String(Date.now()));
      window.location.reload();
    };
    const load = () =>
      fetch(snapshotUrl, { headers: authHeaders })
        .then((response) => {
          if (response.status === 401) recoverExpiredToken();
          return response.ok
            ? response.json()
            : Promise.reject(new Error("snapshot unavailable"));
        })
        .then((value) => {
          apply((previewId ? value : value.snapshot) as BroadcastSnapshotV2);
        })
        .catch(() => undefined);
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl);
      socket.onopen = () => {
        setConnected(true);
        if (!previewId && sourceId)
          socket?.send(JSON.stringify({ type: "SOURCE_HELLO", sourceId }));
        void load();
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as DirectorMessageV2;
        if (message.protocolVersion !== 2) return;
        setClockOffset(message.serverTime - Date.now());
        if (message.type === "SNAPSHOT") apply(message.payload);
        else if (message.type === "RANKING_CHANGED") {
          const rankings = message.payload as Pick<
            BroadcastSnapshotV2,
            "giftRanking" | "engagementRanking"
          >;
          setSnapshot((current) =>
            current
              ? { ...current, ...rankings, serverTime: message.serverTime }
              : current,
          );
        } else if (message.type === "QUEUE_CHANGED") {
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  queue: message.payload as BroadcastSnapshotV2["queue"],
                  serverTime: message.serverTime,
                }
              : current,
          );
        } else void load();
      };
      socket.onerror = () => setConnected(false);
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 900);
      };
    };
    void load();
    connect();
    poll = setInterval(load, 3_000);
    return () => {
      stopped = true;
      window.removeEventListener("message", receivePreviewProfile);
      if (retry) clearTimeout(retry);
      if (poll) clearInterval(poll);
      socket?.close();
    };
  }, [previewId, sourceId]);
  return { snapshot, connected, serverNow: () => Date.now() + clockOffset };
}

function rgba(hex: string, opacity: number) {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "0d0d11";
  const value = Number.parseInt(normalized, 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}

export function sourceStyle(config: ObsSourceConfig): CSSProperties {
  const backgroundMode = resolveBackgroundMode(config);
  // 裸模式：面板全透明、去边框去辉光去滤镜，由浏览器源原生透出（OBS 无需任何抠图）
  const clean = backgroundMode === "TRANSPARENT";
  return {
    "--accent": config.accentColor,
    "--text": config.textColor,
    "--panel": clean
      ? "transparent"
      : rgba(config.backgroundColor, config.backgroundOpacity),
    "--source-bg":
      backgroundMode === "SOLID" ? config.backgroundColor : "transparent",
    "--panel-line": clean
      ? "transparent"
      : `color-mix(in srgb, ${config.accentColor || "#e9b86e"} 42%, transparent)`,
    "--font-scale": config.fontScale,
    "--font-family": config.fontFamily || "Inter, Arial, sans-serif",
    "--brightness": clean ? 1 : config.brightness,
    "--glow": clean ? "0px" : `${Math.round(4 + config.glowIntensity * 28)}px`,
  } as CSSProperties;
}

function useTimeline(
  snapshot: BroadcastSnapshotV2 | undefined,
  serverNow: () => number,
) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (snapshot?.stage !== "SPEAKING") return;
    const timer = setInterval(() => tick((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [snapshot?.stage, snapshot?.activeCue?.cueId]);
  const clockReady = snapshot?.activeCue?.payload.awaitingAudioStart !== true;
  const elapsedMs =
    snapshot?.activeCue && clockReady
      ? Math.max(0, serverNow() - snapshot.activeCue.startsAt)
      : 0;
  const segment =
    snapshot?.stage === "SPEAKING"
      ? snapshot.speechPlan?.segments.find(
          (item) =>
            elapsedMs >= item.offsetMs &&
            elapsedMs < item.offsetMs + item.durationMs,
        )
      : snapshot?.stage === "FINISH"
        ? snapshot.speechPlan?.segments.at(-1)
        : undefined;
  return { elapsedMs, segment: clockReady ? segment : undefined };
}

export function Hexagram({ lines }: { lines?: HexagramLine[] }) {
  if (!lines) return null;
  return (
    <div className="hex-lines">
      {[...lines]
        .sort((a, b) => b.index - a.index)
        .map((line) => (
          <div
            key={line.index}
            className={`hex-line ${line.yinYang.toLocaleLowerCase()} ${line.moving ? "moving" : ""}`}
          >
            <small>{line.index}</small>
            <i />
            <i />
          </div>
        ))}
    </div>
  );
}

/** OBS 浏览器源自适应：模块按设计稿尺寸等比缩放，任意源尺寸都不裁切不变形。 */
function useFitScale(width: number, height: number, enabled: boolean): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!enabled) return;
    const resize = () =>
      setScale(
        Math.min(window.innerWidth / width, window.innerHeight / height),
      );
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [width, height, enabled]);
  return scale;
}

function Frame({
  config,
  children,
  visible,
  previewId,
  className = "",
  embeddedSize,
}: {
  config: ObsSourceConfig;
  children: ReactNode;
  visible: boolean;
  previewId?: string;
  className?: string;
  embeddedSize?: { width: number; height: number };
}) {
  const backgroundMode = resolveBackgroundMode(config).toLocaleLowerCase();
  const modeClass = backgroundMode;
  const borderless =
    config.borderless ??
    !["background", "full-preview"].includes(config.sourceId);
  const contentOnly =
    config.contentOnly ?? (backgroundMode === "transparent" && borderless);
  // The composition desk is black by design; it must not replace each source's
  // formal OBS background configuration.
  const locationSearch =
    typeof window === "undefined" ? "" : window.location.search;
  const canvasPreview = new URLSearchParams(locationSearch).has("canvas");
  const showMode = new URLSearchParams(locationSearch).has("show");
  // 预览小窗跟随设计尺寸：后台改宽度/高度，弹窗自动调整到新尺寸（含浏览器边框）
  useEffect(() => {
    if (!showMode) return;
    window.resizeTo(config.width + 16, config.height + 40);
  }, [showMode, config.width, config.height]);
  const fit = useFitScale(config.width, config.height, !canvasPreview);
  if (embeddedSize) {
    const embeddedFit = Math.min(
      embeddedSize.width / config.width,
      embeddedSize.height / config.height,
    );
    return (
      <main
        className={`source-root stage-embedded-source background-${modeClass} ${borderless ? "borderless" : ""} ${contentOnly ? "content-only" : ""} effect-${config.animationStyle} ${visible ? "is-visible" : "is-hidden"} ${className}`}
        style={{
          ...sourceStyle(config),
          width: "100%",
          height: "100%",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: config.width,
            height: config.height,
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: `translate(-50%, -50%) scale(${embeddedFit})`,
            transformOrigin: "center center",
          }}
        >
          {visible ? children : null}
        </div>
      </main>
    );
  }
  if (!canvasPreview) {
    // 正式输出：根铺满 OBS 源整体，内部按设计稿尺寸等比缩放并居中 —— OBS 里宽高随便填
    return (
      <main
        className={`source-root background-${modeClass} ${borderless ? "borderless" : ""} ${contentOnly ? "content-only" : ""} effect-${config.animationStyle} ${visible ? "is-visible" : "is-hidden"} ${className}`}
        style={{
          ...sourceStyle(config),
          width: "100vw",
          height: "100vh",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {previewId && <span className="preview-label">预览会话</span>}
        <div
          style={{
            width: config.width,
            height: config.height,
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: `translate(-50%, -50%) scale(${fit})`,
            transformOrigin: "center center",
          }}
        >
          {visible ? children : null}
        </div>
      </main>
    );
  }
  return (
    <main
      className={`source-root background-${modeClass} canvas-preview ${borderless ? "borderless" : ""} ${contentOnly ? "content-only" : ""} effect-${config.animationStyle} ${visible ? "is-visible" : "is-hidden"} ${className}`}
      style={sourceStyle(config)}
    >
      {previewId && <span className="preview-label">PREVIEW SESSION</span>}
      {visible ? children : null}
    </main>
  );
}

const stageLabels: Partial<
  Record<ContentLanguage, Record<DirectorStage, string>>
> = {
  en: {
    IDLE: "Waiting for the next viewer",
    QUALIFIED: "A viewer has qualified",
    SELECTED: "Next viewer selected",
    CASTING: "Casting the hexagram",
    INTERPRETING: "Reading the pattern",
    COMPOSING: "Preparing the interpretation",
    SYNTHESIZING: "Preparing the voice",
    SPEAKING: "Live reading in progress",
    FINISH: "Reading complete",
    ERROR: "Unable to complete this reading",
    PAUSED: "Live intake paused",
  },
  "zh-CN": {
    IDLE: "正在等待下一位观众",
    QUALIFIED: "观众已获得资格",
    SELECTED: "已选中下一位观众",
    CASTING: "正在起卦",
    INTERPRETING: "正在推演卦象",
    COMPOSING: "正在组织解读",
    SYNTHESIZING: "正在生成语音",
    SPEAKING: "正在解读",
    FINISH: "本轮解读完成",
    ERROR: "本轮处理失败",
    PAUSED: "直播接入已暂停",
  },
};

export function labelFor(stage: DirectorStage, language: ContentLanguage) {
  return stageLabels[language]?.[stage] ?? stageLabels.en![stage];
}

export const sourceCopy: Record<
  ContentLanguage,
  {
    primary: string;
    mutual: string;
    changed: string;
    moving: string;
    question: string;
    waitingQuestion: string;
    queued: string;
    next: string;
  }
> = {
  en: {
    primary: "PRIMARY",
    mutual: "MUTUAL",
    changed: "CHANGED",
    moving: "Moving line",
    question: "QUESTION",
    waitingQuestion: "TO BE ASKED",
    queued: "QUEUED",
    next: "NEXT",
  },
  "zh-CN": {
    primary: "本卦",
    mutual: "互卦",
    changed: "变卦",
    moving: "动爻",
    question: "问题",
    waitingQuestion: "未提问",
    queued: "已提问 · 排队中",
    next: "下一位",
  },
  es: {
    primary: "PRINCIPAL",
    mutual: "MUTUO",
    changed: "CAMBIADO",
    moving: "Línea móvil",
    question: "PREGUNTA",
    waitingQuestion: "FALTA PREGUNTA",
    queued: "EN COLA",
    next: "SIGUIENTE",
  },
  fr: {
    primary: "PRINCIPAL",
    mutual: "MUTUEL",
    changed: "TRANSFORMÉ",
    moving: "Ligne mobile",
    question: "QUESTION",
    waitingQuestion: "QUESTION REQUISE",
    queued: "EN ATTENTE",
    next: "SUIVANT",
  },
  de: {
    primary: "GRUND",
    mutual: "KERN",
    changed: "GEWANDELT",
    moving: "Wandellinie",
    question: "FRAGE",
    waitingQuestion: "FRAGE FEHLT",
    queued: "IN WARTESCHLANGE",
    next: "NÄCHSTE",
  },
  ja: {
    primary: "本卦",
    mutual: "互卦",
    changed: "変卦",
    moving: "動爻",
    question: "質問",
    waitingQuestion: "未質問",
    queued: "質問済み・待機中",
    next: "次",
  },
  ko: {
    primary: "본괘",
    mutual: "호괘",
    changed: "변괘",
    moving: "동효",
    question: "질문",
    waitingQuestion: "질문 필요",
    queued: "질문 완료 · 대기 중",
    next: "다음",
  },
  pt: {
    primary: "PRINCIPAL",
    mutual: "MÚTUO",
    changed: "MUDADO",
    moving: "Linha móvel",
    question: "PERGUNTA",
    waitingQuestion: "FALTA PERGUNTA",
    queued: "NA FILA",
    next: "PRÓXIMO",
  },
  ru: {
    primary: "ОСНОВНАЯ",
    mutual: "ВЗАИМНАЯ",
    changed: "ИЗМЕНЁННАЯ",
    moving: "Подвижная черта",
    question: "ВОПРОС",
    waitingQuestion: "НУЖЕН ВОПРОС",
    queued: "В ОЧЕРЕДИ",
    next: "СЛЕДУЮЩИЙ",
  },
};

function renderTemplate(
  template: string | undefined,
  values: Record<string, string | number | undefined>,
  fallback: string,
) {
  if (!template?.trim()) return fallback;
  return template.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, key: string) =>
    String(values[key] ?? ""),
  );
}

function reportAudio(
  snapshot: BroadcastSnapshotV2,
  lease: { sourceInstanceId: string; leaseId: string },
  event: "PLAY_STARTED" | "PLAY_ENDED" | "PLAY_FAILED" | "PLAY_PAUSED",
  audio: HTMLAudioElement,
  message?: string,
) {
  if (window.location.pathname.replace(/\/+$/, "") !== "/obs/source/audio")
    return;
  void fetch(`${apiBase}/api/audio/playback-events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({
      event,
      sourceInstanceId: lease.sourceInstanceId,
      leaseId: lease.leaseId,
      readingId: snapshot.reading?.id,
      cueId: snapshot.activeCue?.cueId,
      positionMs: audio.currentTime * 1_000,
      message,
    }),
  }).catch(() => undefined);
}

function AudioSource({
  snapshot,
  serverNow,
}: {
  snapshot: BroadcastSnapshotV2;
  serverNow: () => number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const sourceInstanceId = useRef(crypto.randomUUID());
  const [lease, setLease] = useState<{
    sourceInstanceId: string;
    leaseId: string;
    active: boolean;
  }>();
  const leaseRef = useRef<typeof lease>(undefined);
  const key = `${snapshot.reading?.id ?? ""}:${snapshot.audioUrl ?? ""}:${snapshot.activeCue?.cueId ?? ""}`;
  const officialAudioSource =
    window.location.pathname.replace(/\/+$/, "") === "/obs/source/audio";
  useEffect(() => {
    leaseRef.current = lease;
  }, [lease]);
  useEffect(() => {
    if (!officialAudioSource) return;
    let stopped = false;
    const register = async () => {
      try {
        const response = await fetch(`${apiBase}/api/audio/sources/register`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ sourceInstanceId: sourceInstanceId.current }),
        });
        const value = (await response.json()) as {
          sourceInstanceId: string;
          leaseId: string;
          active: boolean;
        };
        if (!stopped) setLease(value);
      } catch {
        if (!stopped)
          setLease({
            sourceInstanceId: sourceInstanceId.current,
            leaseId: "",
            active: false,
          });
      }
    };
    void register();
    return () => {
      stopped = true;
      const current = leaseRef.current;
      if (current?.active && current.leaseId)
        void fetch(
          `${apiBase}/api/audio/sources/${encodeURIComponent(current.sourceInstanceId)}?leaseId=${encodeURIComponent(current.leaseId)}`,
          { method: "DELETE", headers: authHeaders },
        ).catch(() => undefined);
    };
    // This browser-source instance must acquire at most one lease per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officialAudioSource]);
  useEffect(() => {
    if (!officialAudioSource || !lease?.active || !lease.leaseId) return;
    let stopped = false;
    const heartbeat = setInterval(() => {
      if (!lease?.active || !lease.leaseId) return;
      void fetch(
        `${apiBase}/api/audio/sources/${encodeURIComponent(lease.sourceInstanceId)}/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ leaseId: lease.leaseId }),
        },
      )
        .then((response) =>
          response.ok
            ? response.json()
            : Promise.reject(new Error("lease lost")),
        )
        .then((value: { lease?: { active: boolean } }) => {
          if (!stopped && !value.lease?.active)
            setLease((current) =>
              current ? { ...current, active: false } : current,
            );
        })
        .catch(() => {
          if (!stopped)
            setLease((current) =>
              current ? { ...current, active: false } : current,
            );
        });
    }, 1_000);
    return () => {
      stopped = true;
      clearInterval(heartbeat);
    };
  }, [officialAudioSource, lease?.active, lease?.leaseId]);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    if (
      !officialAudioSource ||
      !lease?.active ||
      !lease.leaseId ||
      snapshot.stage !== "SPEAKING" ||
      !snapshot.audioUrl ||
      !snapshot.activeCue
    ) {
      audio.pause();
      return;
    }
    audio.src = authenticatedUrl(`${apiBase}${snapshot.audioUrl}`);
    const seekAndPlay = () => {
      const target = Math.max(
        0,
        (serverNow() - snapshot.activeCue!.startsAt) / 1000,
      );
      if (Number.isFinite(audio.duration))
        audio.currentTime = Math.min(
          target,
          Math.max(0, audio.duration - 0.05),
        );
      void audio
        .play()
        .then(() => reportAudio(snapshot, lease, "PLAY_STARTED", audio))
        .catch((error: unknown) =>
          reportAudio(
            snapshot,
            lease,
            "PLAY_FAILED",
            audio,
            error instanceof Error ? error.message : String(error),
          ),
        );
    };
    const ended = () => reportAudio(snapshot, lease, "PLAY_ENDED", audio);
    const failed = () =>
      reportAudio(
        snapshot,
        lease,
        "PLAY_FAILED",
        audio,
        audio.error?.message ?? "HTML audio playback error",
      );
    audio.addEventListener("ended", ended);
    audio.addEventListener("error", failed);
    if (audio.readyState >= 1) seekAndPlay();
    else audio.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    return () => {
      if (!audio.paused) reportAudio(snapshot, lease, "PLAY_PAUSED", audio);
      audio.pause();
      audio.removeEventListener("ended", ended);
      audio.removeEventListener("error", failed);
    };
  }, [key, officialAudioSource, lease?.active, lease?.leaseId]);
  return <audio ref={ref} preload="auto" data-source="tts-audio" />;
}

function ClockedAvatarVideo({
  src,
  snapshot,
  segment,
  loop,
  serverNow,
}: {
  src: string;
  snapshot: BroadcastSnapshotV2;
  segment?: SpeechSegment;
  loop: boolean;
  serverNow: () => number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const cue = snapshot.activeCue;
  const waiting = cue?.payload.awaitingAudioStart === true;
  const segmentStart =
    snapshot.stage === "SPEAKING" ? (segment?.offsetMs ?? 0) : 0;
  useEffect(() => {
    const video = ref.current;
    if (!video || !cue || waiting) {
      video?.pause();
      return;
    }
    const synchronize = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      const elapsedSeconds = Math.max(
        0,
        (serverNow() - cue.startsAt - segmentStart) / 1_000,
      );
      const target = loop
        ? elapsedSeconds % video.duration
        : Math.min(elapsedSeconds, Math.max(0, video.duration - 0.04));
      if (Math.abs(video.currentTime - target) > 0.12)
        video.currentTime = target;
      if (!loop && elapsedSeconds >= video.duration) {
        video.pause();
        return;
      }
      void video.play().catch(() => undefined);
    };
    if (video.readyState >= 1) synchronize();
    else video.addEventListener("loadedmetadata", synchronize, { once: true });
    const timer = setInterval(synchronize, 400);
    return () => {
      clearInterval(timer);
      video.removeEventListener("loadedmetadata", synchronize);
    };
  }, [
    src,
    cue?.cueId,
    cue?.revision,
    segment?.segmentId,
    segmentStart,
    waiting,
    loop,
    serverNow,
  ]);
  return (
    <video ref={ref} src={src} muted playsInline loop={loop} preload="auto" />
  );
}

/**
 * Keeps looping media on the same server epoch in the editor preview and OBS.
 * It deliberately owns no React state: incoming queue/status snapshots therefore
 * do not recreate the video node or restart a background from frame zero.
 */
export function SynchronizedVideo({
  src,
  mediaEpoch,
  className,
  style,
  loop = true,
  playing = true,
  resetKey,
  onReady,
}: {
  src: string;
  mediaEpoch?: number;
  className?: string;
  style?: CSSProperties;
  loop?: boolean;
  /** Controlled playback for the unified presentation clock. */
  playing?: boolean;
  /** Changes reset the media to frame zero before the next speaking cue. */
  resetKey?: string | number;
  onReady?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const lastResetKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const nextResetKey = `${src}:${String(resetKey ?? "")}`;
    if (lastResetKey.current !== nextResetKey) {
      video.pause();
      video.currentTime = 0;
      lastResetKey.current = nextResetKey;
    }
    const synchronize = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      onReady?.();
      if (!playing) {
        video.pause();
        return;
      }
      if (mediaEpoch) {
        const elapsed = Math.max(0, (Date.now() - mediaEpoch) / 1_000);
        if (!loop && elapsed >= video.duration) {
          video.currentTime = Math.max(0, video.duration - 0.04);
          video.pause();
          return;
        }
        const target = loop ? elapsed % video.duration : Math.min(elapsed, Math.max(0, video.duration - 0.04));
        if (Math.abs(video.currentTime - target) > 0.28) video.currentTime = target;
      }
      void video.play().catch(() => undefined);
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) synchronize();
    else video.addEventListener("loadedmetadata", synchronize, { once: true });
    const timer = window.setInterval(synchronize, 4_000);
    return () => {
      window.clearInterval(timer);
      video.removeEventListener("loadedmetadata", synchronize);
    };
  }, [src, mediaEpoch, loop, playing, resetKey]);
  return <video ref={ref} className={className} style={style} src={src} muted playsInline loop={loop} preload="auto" />;
}

function AvatarSource({
  snapshot,
  segment,
  serverNow,
}: {
  snapshot: BroadcastSnapshotV2;
  segment?: SpeechSegment;
  serverNow: () => number;
}) {
  if (snapshot.avatarRuntime === "VTUBE_STUDIO") return null;
  const presentationMedia = snapshot.presentationMedia;
  const presentationWaiting = snapshot.activeCue?.payload.awaitingAudioStart === true;
  const presentationSpeaking = snapshot.stage === "SPEAKING" && !presentationWaiting;
  if (snapshot.presentationMode === "AUDIO_ONLY") return null;
  if ((snapshot.presentationMode === "VIDEO_LOOP" || snapshot.presentationMode === "VIDEO_ONCE") && presentationMedia?.url) {
    const src = authenticatedUrl(presentationMedia.url.startsWith("http") ? presentationMedia.url : `${apiBase}${presentationMedia.url}`);
    return (
      <section className="avatar-stage presentation-video">
        <SynchronizedVideo
          src={src}
          mediaEpoch={presentationSpeaking ? snapshot.activeCue?.startsAt : undefined}
          resetKey={`${snapshot.reading?.id ?? "idle"}:${snapshot.activeCue?.cueId ?? "idle"}:${presentationMedia.outputAssetId ?? presentationMedia.url}`}
          playing={presentationSpeaking}
          loop={presentationMedia.playback !== "ONCE"}
          style={{ objectFit: presentationMedia.fit === "CONTAIN" ? "contain" : "cover" }}
        />
      </section>
    );
  }
  const cueAction = String(snapshot.activeCue?.payload.avatarAction ?? "IDLE");
  const action =
    (snapshot.stage === "SPEAKING" ? segment?.avatarAction : cueAction) ??
    "IDLE";
  const providerMedia = snapshot.avatarStageMedia;
  if (providerMedia?.kind === "VRM" && providerMedia.url) {
    const src = authenticatedUrl(providerMedia.url.startsWith("http") ? providerMedia.url : `${apiBase}${providerMedia.url}`);
    return (
      <section className="avatar-stage">
        <VrmAvatar
          src={src}
          action={action as AvatarActionName}
          lipSyncPlan={snapshot.speechPlan?.lipSyncPlan ?? snapshot.reading?.lipSyncPlan}
          startedAt={snapshot.speechPlan?.startedAt}
          now={serverNow}
        />
      </section>
    );
  }
  const slots = snapshot.profileVersion.profile.avatar.slots;
  const selected = slots[action as keyof typeof slots] ?? slots.IDLE;
  const fallback = selected.assetId
    ? selected
    : (slots[selected.fallbackAction] ?? slots.IDLE);
  const asset = fallback.assetId;
  if (!asset) return null;
  const url = mediaAssetUrl(snapshot, asset);
  const metadata = snapshot.mediaAssets?.find((item) => item.id === asset);
  const isVideo = metadata
    ? metadata.mimeType.startsWith("video/")
    : fallback.mode !== "STATIC_FALLBACK";
  const waiting = snapshot.activeCue?.payload.awaitingAudioStart === true;
  return (
    <section
      className={`avatar-stage ${fallback.mode === "CHROMA_KEY" ? "chroma" : ""} ${waiting ? "is-clock-waiting" : ""}`}
      style={{ "--chroma": fallback.chromaColor } as CSSProperties}
    >
      {isVideo ? (
        <ClockedAvatarVideo
          key={`${action}:${asset}:${segment?.segmentId ?? ""}`}
          src={url}
          snapshot={snapshot}
          segment={segment}
          loop={fallback.playback === "LOOP"}
          serverNow={serverNow}
        />
      ) : (
        <img src={url} alt="" />
      )}
    </section>
  );
}

function BackgroundSource({
  snapshot,
  config,
}: {
  snapshot: BroadcastSnapshotV2;
  config: ObsSourceConfig;
}) {
  // 无素材时渲染 source 配置的底色（白/黑/绿幕三主题直接生效）
  const asset = snapshot.mediaAssets?.find(
    (item) => item.id === config.backgroundAssetId,
  );
  if (!config.backgroundAssetId) return <div className="background-fallback" />;
  const assetUrl = mediaAssetUrl(snapshot, config.backgroundAssetId);
  const waitingForAudio = snapshot.activeCue?.payload.awaitingAudioStart === true;
  const speaking = snapshot.stage === "SPEAKING" && !waitingForAudio;
  return (
    <div className="background-media">
      {asset?.mimeType.startsWith("video/") ? (
        <SynchronizedVideo
          src={assetUrl}
          // The background is a per-reading visual, not a second idle loop.
          // It starts on the confirmed audio master clock and plays once.
          mediaEpoch={speaking ? snapshot.activeCue?.startsAt : undefined}
          playing={speaking}
          loop={false}
          resetKey={`${snapshot.reading?.id ?? "idle"}:${snapshot.activeCue?.cueId ?? "idle"}:${assetUrl}`}
        />
      ) : (
        <img src={assetUrl} alt="" />
      )}
    </div>
  );
}

function Ranking({
  title,
  entries,
  kind,
  template,
}: {
  title: string;
  entries:
    | BroadcastSnapshotV2["giftRanking"]
    | BroadcastSnapshotV2["engagementRanking"];
  kind: "gift" | "engagement";
  template?: string;
}) {
  return (
    <section className="panel ranking">
      <header>
        <b>{title}</b>
        <span>TOP {entries.length}</span>
      </header>
      {entries.map((entry) => (
        <div key={entry.userKey}>
          <em>{entry.rank}</em>
          <strong>
            {renderTemplate(
              template,
              {
                rank: entry.rank,
                username: entry.username,
                points: entry.points,
              },
              `@${entry.username}`,
            )}
          </strong>
          <span>{entry.points} pts</span>
          <small>
            {kind === "gift"
              ? `${"giftCount" in entry ? entry.giftCount : 0} gifts`
              : `${"likeCount" in entry ? entry.likeCount : 0} likes`}
          </small>
        </div>
      ))}
    </section>
  );
}

export function SourceContent({
  sourceId,
  snapshot,
  serverNow,
  previewId,
  embeddedSize,
}: {
  sourceId: ObsSourceId;
  snapshot: BroadcastSnapshotV2;
  serverNow: () => number;
  previewId?: string;
  embeddedSize?: { width: number; height: number };
}) {
  // Audio is emitted only by the native Audio Bus. Captions are visual-only
  // and advance from the same immutable speech timeline as the WAV.
  if (sourceId === "audio") return null;
  const profile = snapshot.profileVersion.profile;
  const config = profile.sources[sourceId];
  const decorationAsset =
    sourceId !== "background" &&
    sourceId !== "sticker" &&
    sourceId !== "avatar" &&
    config.decorationAssetId
      ? snapshot.mediaAssets?.find(
          (asset) =>
            asset.id === config.decorationAssetId &&
            ["BACKGROUND_IMAGE", "STICKER_IMAGE", "OVERLAY_IMAGE"].includes(
              asset.kind,
            ),
        )
      : undefined;
  const decorationAssetUrl = decorationAsset
    ? mediaAssetUrl(snapshot, decorationAsset.id)
    : undefined;
  const { segment } = useTimeline(snapshot, serverNow);
  const current = snapshot.reading;
  // 工作台画布模式（?canvas=1）：模块始终可见（显示待机内容），
  // 让操作者在排版时能看到全部模块；正式输出仍遵循 idleBehavior。
  const urlParams = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
  const canvasMode = urlParams.has("canvas");
  // ?show=1 独立窗口预览：模块始终显示（无任务/停用时给待机占位），方便检查样式
  const showMode = urlParams.has("show");
  const configuredGiftOffers = config.giftOffers?.length
    ? config.giftOffers
    : config.selectedGiftId
      ? [
          {
            id: `legacy-${config.selectedGiftId}`,
            giftId: config.selectedGiftId,
            giftName: config.selectedGiftName ?? "Gift",
            speechTargetSeconds: config.selectedGiftSpeechSeconds ?? 30,
            message: config.giftMessage ?? config.idleText,
          },
        ]
      : [];
  const has: Record<ObsSourceId, boolean> = {
    avatar:
      snapshot.avatarRuntime !== "VTUBE_STUDIO" &&
      Boolean(Object.values(profile.avatar.slots).some((slot) => slot.assetId)),
    background: Boolean(config.backgroundAssetId),
    "current-viewer": Boolean(current),
    hexagram: Boolean(current?.meihua),
    subtitles: Boolean(segment),
    queue: snapshot.qualificationQueue.length > 0,
    sticker: Boolean(config.backgroundAssetId),
    "gift-alert": Boolean(configuredGiftOffers.length),
    "gift-ranking": snapshot.giftRanking.length > 0,
    "engagement-ranking": snapshot.engagementRanking.length > 0,
    status: true,
    effects: profile.effects.particles,
    disclaimer: Boolean(profile.disclaimer),
    audio: true,
    "meihua-stage": true,
    "full-preview": true,
  };
  const visible =
    Boolean(embeddedSize) ||
    canvasMode ||
    showMode ||
    (config.enabled &&
      (has[sourceId] ||
        Boolean(decorationAssetUrl) ||
        config.idleBehavior === "PREVIEW"));
  const title =
    config.showTitle && config.titleText ? (
      <b className="custom-title">{config.titleText}</b>
    ) : null;
  // 工作台画布模式：没有实时内容的模块也要显示“名称+待机文案”的占位卡片，
  // 让操作者在排版时能看到每个模块的位置与大小；正式输出不受影响。
  const idlePlaceholder =
    (canvasMode || showMode) && !has[sourceId] ? (
      <div className="canvas-idle">
        <b>{canvasSourceNames[sourceId]}</b>
        <span>{config.idleText || "Hidden until live content is available"}</span>
      </div>
    ) : undefined;
  let content: ReactNode = null;
  if (sourceId === "avatar")
    content = (
      <AvatarSource
        snapshot={snapshot}
        segment={segment}
        serverNow={serverNow}
      />
    );
  else if (sourceId === "background")
    content = <BackgroundSource snapshot={snapshot} config={config} />;
  else if (sourceId === "status") {
    const stageText =
      snapshot.stage === "IDLE"
        ? config.idleText || labelFor(snapshot.stage, "en")
        : labelFor(snapshot.stage, "en");
    content = (
      <section className="panel status">
        <i />
        <div>
          {title}
          <strong>
            {renderTemplate(
              config.contentTemplate,
              { stage: stageText, username: current?.username },
              stageText,
            )}
          </strong>
          {current && <small>@{current.username}</small>}
        </div>
      </section>
    );
  } else if (sourceId === "current-viewer")
    content = (
      <section className="panel current">
        {title}
        <p>@{current?.username ?? "WAITING"}</p>
        <span className="current-question">
          {current?.normalizedQuestion ?? current?.rawQuestion ?? config.idleText}
        </span>
        <strong>
          {current?.meihua?.primary
            ? formatHexagramDisplayName(
                current.meihua.primary.number,
                current.meihua.primary.name,
                "en",
              )
            : config.idleText || "WAITING FOR A CAST"}
        </strong>
      </section>
    );
  else if (sourceId === "hexagram") {
    content = current?.meihua?.primary ? (
      <section className="hexagrams-primary-only" aria-label="Primary hexagram">
        <Hexagram lines={current.meihua.primary.lines} />
      </section>
    ) : null;
  } else if (sourceId === "subtitles") {
    content = segment ? (
      <section className={`panel subtitles ${segment.emphasis ? "emphasis" : ""}`} aria-live="polite">
        <strong key={segment.segmentId}>{segment.text}</strong>
      </section>
    ) : null;
  } else if (sourceId === "queue") {
    const copy = sourceCopy.en;
    content = (
      <section className="panel queue">
        {title}
        <header>
          <span>{copy.next}</span>
          <b>{snapshot.qualificationQueue.length}</b>
        </header>
        {snapshot.qualificationQueue.slice(0, config.maxItems).map((item) => (
          <div
            key={item.id}
            className={`queue-${item.status.toLocaleLowerCase()}`}
          >
            <em>
              {item.position ? String(item.position).padStart(2, "0") : "·"}
            </em>
            <span className="queue-person">
              <strong>
                {renderTemplate(
                  config.contentTemplate,
                  {
                    position: item.position,
                    username: item.username,
                    priority: item.priority,
                    status: item.status,
                  },
                  `@${item.username}`,
                )}
              </strong>
              <b className="queue-state">
                {item.status === "WAITING_QUESTION"
                  ? copy.waitingQuestion
                  : copy.queued}
              </b>
            </span>
          </div>
        ))}
      </section>
    );
  } else if (sourceId === "gift-alert") {
    content = (
      <section className="panel gift gift-window gift-offer-window">
        {title}
        <div className="gift-offer-list">
          {configuredGiftOffers.slice(0, config.maxItems).map((offer) => (
            <div className="gift-offer-item" key={offer.id}>
              <img src={`/gifts/${offer.giftId}.png`} alt="" />
              <span>
                <strong>{offer.message}</strong>
              </span>
            </div>
          ))}
        </div>
      </section>
    );
  } else if (sourceId === "gift-ranking")
    content = (
      <Ranking
        title={config.titleText || "GIFT RANKING"}
        entries={snapshot.giftRanking.slice(0, config.maxItems)}
        kind="gift"
        template={config.contentTemplate}
      />
    );
  else if (sourceId === "engagement-ranking")
    content = (
      <Ranking
        title={config.titleText || "ENGAGEMENT RANKING"}
        entries={snapshot.engagementRanking.slice(0, config.maxItems)}
        kind="engagement"
        template={config.contentTemplate}
      />
    );
  else if (sourceId === "effects")
    content = (
      <div className="particles">
        {Array.from({ length: 18 }, (_, index) => (
          <i key={index} style={{ "--i": index } as CSSProperties} />
        ))}
      </div>
    );
  else if (sourceId === "sticker") {
    const url = config.backgroundAssetId
      ? mediaAssetUrl(snapshot, config.backgroundAssetId)
      : "";
    content = url ? (
      <img className="sticker-media" src={url} alt="" />
    ) : (
      <div className="canvas-idle">
        <b>自定义贴纸</b>
        <span>在「素材与背景」上传贴纸图片</span>
      </div>
    );
  } else if (sourceId === "disclaimer")
    content = (
      <section className="disclaimer">
        {renderTemplate(
          config.contentTemplate,
          { disclaimer: profile.disclaimer },
          profile.disclaimer || config.idleText,
        )}
      </section>
    );
  return (
    <Frame
      config={config}
      visible={visible}
      previewId={previewId}
      className={`source-${sourceId}`}
      embeddedSize={embeddedSize}
    >
      {decorationAssetUrl && (
        <img
          className="source-decoration-asset"
          src={decorationAssetUrl}
          alt=""
        />
      )}
      {idlePlaceholder ?? content}
    </Frame>
  );
}

function FullPreview({
  snapshot,
  serverNow,
}: {
  snapshot: BroadcastSnapshotV2;
  serverNow: () => number;
}) {
  const config = snapshot.profileVersion.profile.sources["full-preview"];
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const updateViewport = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);
  const scale = Math.min(viewport.width / 1080, viewport.height / 1920);
  return (
    <main className="full-preview-viewport">
      <div
        className="full-preview-canvas"
        style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <Frame config={config} visible className="full-stage">
          <SourceContent
            sourceId="background"
            snapshot={snapshot}
            serverNow={serverNow}
          />
          <div className="full-effects">
            <SourceContent
              sourceId="effects"
              snapshot={snapshot}
              serverNow={serverNow}
            />
          </div>
          <div className="full-avatar">
            <SourceContent
              sourceId="avatar"
              snapshot={snapshot}
              serverNow={serverNow}
            />
          </div>
          <div className="full-status">
            <SourceContent
              sourceId="status"
              snapshot={snapshot}
              serverNow={serverNow}
            />
          </div>
          <div className="full-hex">
            <SourceContent
              sourceId="hexagram"
              snapshot={snapshot}
              serverNow={serverNow}
            />
          </div>
          <div className="full-queue">
            <SourceContent
              sourceId="queue"
              snapshot={snapshot}
              serverNow={serverNow}
            />
          </div>
          <div className="full-gift">
            <SourceContent
              sourceId="gift-alert"
              snapshot={snapshot}
              serverNow={serverNow}
            />
          </div>
          <div className="full-subtitles">
            <SourceContent
              sourceId="subtitles"
              snapshot={snapshot}
              serverNow={serverNow}
            />
          </div>
          <div className="full-disclaimer">
            <SourceContent
              sourceId="disclaimer"
              snapshot={snapshot}
              serverNow={serverNow}
            />
          </div>
        </Frame>
      </div>
    </main>
  );
}

function ModuleManager({
  profileVersion,
}: {
  profileVersion: SceneProfileVersion;
}) {
  const [copied, setCopied] = useState("");
  const origin = window.location.origin;
  return (
    <main className="source-manager">
      <header>
        <p>MEIHUA LIVE · OBS SOURCES V2</p>
        <h1>OBS 独立来源中心</h1>
        <span>
          正式地址只显示真实直播状态；字幕由实际音频开始时间驱动，浏览器音频继续停用。默认推荐只添加一条正式直播舞台。
        </span>
      </header>
      <section className="stage-highlight">
        {(() => {
          const config = profileVersion.profile.sources["meihua-stage"];
          const url = `${origin}/obs/source/meihua-stage`;
          return (
            <article className="stage-card">
              <div>
                <h2>
                  正式直播舞台 <em>推荐默认</em>
                </h2>
                <code>
                  {config.width} × {config.height}
                </code>
              </div>
              <p>
                一条链接完成整屏直播构图：背景、人物、当前观众、问题、卦象、队列、礼物反馈与免责声明。转场全部由导演
                Cue 驱动。
              </p>
              <input readOnly value={url} />
              <footer>
                <button
                  onClick={() =>
                    window.open(
                      url,
                      "obs-meihua-stage",
                      `width=${config.width},height=${config.height}`,
                    )
                  }
                >
                  打开正式舞台
                </button>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(url);
                    setCopied("meihua-stage");
                    setTimeout(() => setCopied(""), 1_500);
                  }}
                >
                  {copied === "meihua-stage" ? "已复制" : "复制 OBS 地址"}
                </button>
              </footer>
            </article>
          );
        })()}
        <article className="stage-card lux3d-card">
          <div>
            <h2>玄金罗盘 · 3D 动画</h2>
            <code>透明背景 · 外圈旋转 · 起卦显卦</code>
          </div>
          <p>
            独立的 Lux3D
            视觉源：外圈持续转动，中心卦纹平时静止；开始测算时中心卦纹聚能旋转一次，然后显示本卦、互卦、变卦和卦名。
          </p>
          <input readOnly value={`${origin}/obs/source/lux3d`} />
          <footer>
            <button
              onClick={() =>
                window.open(
                  `${origin}/obs/source/lux3d`,
                  "obs-lux3d",
                  "width=420,height=420",
                )
              }
            >
              打开 3D 预览
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(
                  `${origin}/obs/source/lux3d`,
                );
                setCopied("lux3d");
                setTimeout(() => setCopied(""), 1_500);
              }}
            >
              {copied === "lux3d" ? "已复制" : "复制 OBS 地址"}
            </button>
          </footer>
        </article>
      </section>
      <section>
        {sourceIds
          .filter(
            (id) => !["full-preview", "audio", "meihua-stage"].includes(id),
          )
          .map((id) => {
            const config = profileVersion.profile.sources[id];
            const url = `${origin}/obs/source/${id}`;
            return (
              <article key={id}>
                <div>
                  <h2>{sourceMeta[id].name}</h2>
                  <code>
                    {config.width} × {config.height}
                  </code>
                </div>
                <p>{sourceMeta[id].description}</p>
                <input readOnly value={url} />
                <footer>
                  <button
                    onClick={() =>
                      window.open(
                        url,
                        `obs-${id}`,
                        `width=${config.width},height=${config.height}`,
                      )
                    }
                  >
                    打开正式来源
                  </button>
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(url);
                      setCopied(id);
                      setTimeout(() => setCopied(""), 1_500);
                    }}
                  >
                    {copied === id ? "已复制" : "复制 OBS 地址"}
                  </button>
                </footer>
              </article>
            );
          })}
      </section>
    </main>
  );
}

const lux3dHexagramOrder = ["primary", "mutual", "changed"] as const;

function Lux3DHexagramOverlay({
  meihua,
  language: _language,
}: {
  meihua?: MeihuaResult;
  language: ContentLanguage;
}) {
  if (!meihua) return null;
  const copy = sourceCopy.en;
  return (
    <div className="lux3d-hex-overlay" aria-label="Current hexagrams">
      {lux3dHexagramOrder.map((key) => {
        const value = meihua[key];
        if (!value) return null;
        return (
          <div className="lux3d-hex-card" key={key}>
            <span>{copy[key]}</span>
            <Hexagram lines={value.lines} />
            <strong>
              {formatHexagramDisplayName(value.number, value.name, "en")}
            </strong>
          </div>
        );
      })}
    </div>
  );
}

function Lux3DSource({ snapshot }: { snapshot?: BroadcastSnapshotV2 }) {
  const [viewerReady, setViewerReady] = useState(false);
  const viewerRef = useRef<HTMLElement>(null);
  const readingId = snapshot?.reading?.id ?? snapshot?.activeCue?.readingId;
  const castingStages: DirectorStage[] = [
    "SELECTED",
    "CASTING",
    "INTERPRETING",
    "COMPOSING",
    "SYNTHESIZING",
    "SPEAKING",
  ];
  const isCasting = Boolean(
    readingId && snapshot?.stage && castingStages.includes(snapshot.stage),
  );
  const meihua = snapshot?.reading?.meihua;
  const language: ContentLanguage = "en";
  const effectKey = [
    readingId ?? "idle",
    meihua?.primary?.number ?? "pending",
  ].join(":");
  // React can create the custom element before model-viewer upgrades it. Set
  // the critical attributes after upgrade so the source is never stale or
  // left without its intended front-facing orientation.
  useEffect(() => {
    if (!viewerReady) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.setAttribute("src", "/lux3d/meihua-auxing-compass-v2-g1-turbo.glb");
    viewer.setAttribute("alt", "鐜勯噾姊呰姳缃楃洏");
    viewer.setAttribute("orientation", "0deg 0deg 0deg");
  }, [viewerReady]);

  // The static wrapper is kept mounted so OBS never sees a blank frame while
  // a new reading arrives. Toggle its classes to restart only the visual cue.
  useEffect(() => {
    const root = viewerRef.current?.parentElement;
    if (!root) return;
    root.classList.toggle("is-casting", isCasting);
    root.dataset.reading = effectKey;
    root.classList.remove("lux3d-new-reading");
    void root.offsetWidth;
    root.classList.add("lux3d-new-reading");
  }, [effectKey, isCasting, viewerReady]);

  const viewer = createElement("model-viewer", {
    ref: viewerRef,
    src: "/lux3d/meihua-auxing-compass-v2-g1-turbo.glb",
    alt: "玄金梅花罗盘",
    "disable-zoom": "",
    "interaction-prompt": "none",
    "shadow-intensity": "0",
    exposure: "1.15",
    orientation: "0deg 0deg 0deg",
    "camera-orbit": "0deg 90deg auto",
    "field-of-view": "32deg",
  });
  return (
    <main className="source-root lux3d-source" aria-label="玄金罗盘 3D 动画">
      <div className="lux3d-aura" />
      <span ref={viewerRef} className="lux3d-state-anchor" aria-hidden="true" />
      <div className="lux3d-outer-ring" aria-hidden="true" />
      <div className="lux3d-orbit" aria-hidden="true" />
      <div className="lux3d-casting-rays" aria-hidden="true" />
      <img
        className="lux3d-core"
        src="/lux3d/meihua-auxing-compass-v3.png"
        alt="Meihua compass"
      />
      <Lux3DHexagramOverlay meihua={meihua} language={language} />
      {viewerReady ? (
        viewer
      ) : (
        <div className="lux3d-loading">Loading 3D visual…</div>
      )}
    </main>
  );
}

export function MaterialLux3DSource({
  snapshot,
  embedded = false,
}: {
  snapshot?: BroadcastSnapshotV2;
  embedded?: boolean;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const readingId = snapshot?.reading?.id ?? snapshot?.activeCue?.readingId;
  const castingStages: DirectorStage[] = [
    "SELECTED",
    "CASTING",
    "INTERPRETING",
    "COMPOSING",
    "SYNTHESIZING",
    "SPEAKING",
  ];
  const isCasting = Boolean(
    readingId && snapshot?.stage && castingStages.includes(snapshot.stage),
  );
  const meihua = snapshot?.reading?.meihua;
  const language: ContentLanguage = "en";
  const selectedId =
    snapshot?.profileVersion.profile.visualAssets?.lux3dCoreAssetId;
  const selectedAsset = snapshot?.mediaAssets?.find(
    (asset) => asset.id === selectedId,
  );
  const isModel = selectedAsset?.kind === "LUX3D_MODEL";
  const selectedUrl = selectedAsset && snapshot
    ? mediaAssetUrl(snapshot, selectedAsset.id)
    : undefined;
  const imageSrc =
    !isModel && selectedUrl
      ? selectedUrl
      : "/lux3d/meihua-auxing-compass-v3.png";
  const [modelReady, setModelReady] = useState(false);
  const effectKey = [
    readingId ?? "idle",
    meihua?.primary?.number ?? "pending",
  ].join(":");

  useEffect(() => {
    let active = true;
    setModelReady(false);
    if (isModel)
      void import("@google/model-viewer").then(() => {
        if (active) setModelReady(true);
      });
    return () => {
      active = false;
    };
  }, [isModel]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.classList.toggle("is-casting", isCasting);
    root.dataset.reading = effectKey;
    root.classList.remove("lux3d-new-reading");
    void root.offsetWidth;
    root.classList.add("lux3d-new-reading");
  }, [effectKey, isCasting]);

  return (
    <main
      ref={rootRef}
      className={`source-root lux3d-source ${embedded ? "lux3d-embedded" : ""}`}
      aria-label="玄金罗盘 3D 动画"
    >
      <div className="lux3d-aura" />
      <div className="lux3d-outer-ring" aria-hidden="true" />
      <div className="lux3d-orbit" aria-hidden="true" />
      <div className="lux3d-casting-rays" aria-hidden="true" />
      {isModel && modelReady ? (
        createElement("model-viewer", {
          className: "lux3d-model-core",
          src: selectedUrl,
          alt: selectedAsset?.fileName ?? "梅花罗盘",
          "disable-zoom": "",
          "interaction-prompt": "none",
          "shadow-intensity": "0",
          exposure: "1.1",
          orientation: "0deg 0deg 0deg",
          "camera-orbit": "0deg 90deg auto",
          "field-of-view": "32deg",
        })
      ) : (
        <img className="lux3d-core" src={imageSrc} alt="梅花罗盘" />
      )}
      <Lux3DHexagramOverlay meihua={meihua} language={language} />
    </main>
  );
}

export function App() {
  const route = useMemo(routeFromLocation, []);
  const previewId = route.kind === "source" ? route.previewId : undefined;
  const sourceId = route.kind === "source" ? route.sourceId : undefined;
  const { snapshot, connected, serverNow } = useBroadcast(previewId, sourceId);
  useEffect(() => {
    document.body.className =
      route.kind === "manager" ? "manager-mode" : "source-mode";
  }, [route.kind]);
  if (route.kind === "lux3d")
    return <MaterialLux3DSource snapshot={snapshot} />;
  if (!snapshot)
    return (
      <main
        className="connecting"
        aria-label={connected ? "loading scene" : "connecting"}
      />
    );
  if (route.kind === "unknown") {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#101216",
          color: "#ffd9a0",
          fontFamily: "monospace",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 28 }}>未知 OBS 来源</h1>
          <p style={{ opacity: 0.75 }}>{route.path}</p>
          <p style={{ opacity: 0.55 }}>
            请到后台「画面工作台」复制正确的浏览器源地址
          </p>
        </div>
      </main>
    );
  }
  if (route.kind === "manager")
    return <ModuleManager profileVersion={snapshot.profileVersion} />;
  if (route.sourceId === "full-preview")
    return <FullPreview snapshot={snapshot} serverNow={serverNow} />;
  if (route.sourceId === "meihua-stage")
    return <StageSource snapshot={snapshot} />;
  return (
    <SourceContent
      sourceId={route.sourceId}
      snapshot={snapshot}
      serverNow={serverNow}
      previewId={previewId}
    />
  );
}
