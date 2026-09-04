import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  GiftWindowOffer,
  GiftRule,
  MediaAsset,
  MediaAssetKind,
  ObsSourceConfig,
  ObsSourceId,
  SceneComposition,
  SceneLayer,
  SceneModuleId,
  SceneProfile,
  SceneProfileVersion,
} from "@meihua/core-types";
import {
  adminRequest,
  authenticatedMediaUrl,
  authenticatedMediaThumbnailUrl,
  overlayBase,
} from "./adminApi.js";
import { giftIconUrl, referenceGiftCatalog } from "./giftCatalog.js";
import "./workbench.css";

const moduleNames: Record<SceneModuleId, string> = {
  background: "直播背景",
  effects: "画面特效",
  status: "直播状态",
  "current-viewer": "当前用户 · 问题 · 卦名",
  "gift-alert": "礼物窗口",
  avatar: "播报画面（视频 / 数字人）",
  queue: "资格与排队名单",
  lux3d: "玄金罗盘",
  hexagram: "卦象与当前测算",
  subtitles: "口播字幕",
  "gift-ranking": "礼物榜",
  "engagement-ranking": "互动榜",
  sticker: "自定义贴纸",
  disclaimer: "免责声明",
};

const moduleGroups: Array<{ label: string; ids: SceneModuleId[] }> = [
  {
    label: "核心画面",
    ids: ["background", "avatar", "current-viewer", "hexagram", "lux3d"],
  },
  { label: "直播信息", ids: ["status", "queue", "subtitles", "disclaimer"] },
  {
    label: "互动与效果",
    ids: [
      "gift-alert",
      "gift-ranking",
      "engagement-ranking",
      "effects",
      "sticker",
    ],
  },
];

const blankComposition = (): SceneComposition => ({
  width: 1080,
  height: 1920,
  layers: [],
});
const cloneComposition = (value: SceneComposition) => structuredClone(value);
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

type Props = {
  draft: SceneProfileVersion;
  assets: MediaAsset[];
  giftRules: GiftRule[];
  stageStatus?: string;
  /** When LIVE, keep the published OBS output isolated from this editable draft. */
  livePreview?: boolean;
  /** `true` reloads the published draft after an atomic publish; `false` only refreshes assets. */
  onReload: (replaceEditable?: boolean) => Promise<void>;
  notify: (message: string) => void;
};

type DragState = {
  layerId: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  original: SceneLayer["transform"];
  element: HTMLElement;
  latest?: Partial<SceneLayer["transform"]>;
};

function MediaThumb({ asset }: { asset: MediaAsset }) {
  const src = authenticatedMediaUrl(asset.id);
  const thumbnail = authenticatedMediaThumbnailUrl(asset.id, asset.contentHash);
  const [previewVideo, setPreviewVideo] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  if (asset.mimeType.startsWith("video/"))
    return <div
      className="mw-video-poster"
      onMouseEnter={() => setPreviewVideo(true)}
      onMouseLeave={() => setPreviewVideo(false)}
    >
      {previewVideo ? <video src={src} muted loop playsInline autoPlay preload="metadata" /> : thumbnailFailed ? <><b>VIDEO</b><span>悬停预览</span></> : <img src={thumbnail} alt="" width={320} height={180} loading="lazy" decoding="async" onError={() => setThumbnailFailed(true)} />}
    </div>;
  if (asset.kind === "LUX3D_MODEL" || asset.kind === "AVATAR_VRM" || asset.mimeType.includes("vrm"))
    return (
      <div className="mw-model-thumb">
        <b>3D</b>
        <span>{asset.kind === "AVATAR_VRM" || asset.mimeType.includes("vrm") ? "VRM" : "GLB"}</span>
      </div>
    );
  return <img src={thumbnailFailed ? src : thumbnail} alt={asset.fileName} width={320} height={180} loading="lazy" decoding="async" onError={() => setThumbnailFailed(true)} />;
}

function MaterialLibrary({
  assets,
  onClose,
  onChanged,
  selectionLabel,
  selectedAssetId,
  canSelect,
  onSelect,
}: {
  assets: MediaAsset[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  selectionLabel?: string;
  selectedAssetId?: string;
  canSelect?: (asset: MediaAsset) => boolean;
  onSelect?: (asset: MediaAsset) => void;
}) {
  const [filter, setFilter] = useState<
    "ALL" | "IMAGE" | "VIDEO" | "MODEL" | "SYSTEM" | "UPLOADED"
  >("ALL");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 16;
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return assets.filter(
      (asset) =>
        (filter === "ALL" ||
          (filter === "IMAGE" && asset.mimeType.startsWith("image/")) ||
          (filter === "VIDEO" && asset.mimeType.startsWith("video/")) ||
          (filter === "MODEL" && asset.kind === "LUX3D_MODEL") ||
          asset.origin === filter) &&
        (!needle || `${asset.fileName} ${asset.kind}`.toLocaleLowerCase().includes(needle)),
    );
  }, [assets, filter, query]);
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const shownAssets = visible.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => setPage(0), [filter, query]);

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () =>
          resolve(String(reader.result).split(",")[1] ?? "");
        reader.readAsDataURL(file);
      });
      const lower = file.name.toLocaleLowerCase();
      const kind: MediaAssetKind = lower.endsWith(".glb")
        ? "LUX3D_MODEL"
        : file.type.startsWith("video/")
          ? "BACKGROUND_VIDEO"
          : "OVERLAY_IMAGE";
      await adminRequest("/api/media-assets", {
        method: "POST",
        body: JSON.stringify({
          kind,
          fileName: file.name,
          mimeType: kind === "LUX3D_MODEL" ? "model/gltf-binary" : file.type,
          base64,
        }),
      });
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (asset: MediaAsset) => {
    if (asset.origin === "SYSTEM") return;
    if (!window.confirm(`删除素材“${asset.fileName}”？`)) return;
    try {
      await adminRequest(`/api/media-assets/${asset.id}`, { method: "DELETE" });
      await onChanged();
    } catch (error) {
      const value = error as Error & { usages?: string[] };
      window.alert(
        value.usages?.length
          ? `${value.message}\n\n使用位置：\n${value.usages.join("\n")}`
          : value.message,
      );
    }
  };

  return (
    <div
      className="mw-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="mw-library">
        <header>
          <div>
            <b>统一素材库</b>
            <small>图片、视频与 3D 素材统一管理，不再出现多个上传入口</small>
          </div>
          <button onClick={onClose}>关闭</button>
        </header>
        <div className="mw-library-tools">
          <div className="mw-filter-tabs">
            {(
              ["ALL", "IMAGE", "VIDEO", "MODEL", "SYSTEM", "UPLOADED"] as const
            ).map((item) => (
              <button
                key={item}
                className={filter === item ? "active" : ""}
                onClick={() => setFilter(item)}
              >
                {
                  (
                    {
                      ALL: "全部",
                      IMAGE: "图片",
                      VIDEO: "视频",
                      MODEL: "3D",
                      SYSTEM: "系统",
                      UPLOADED: "已上传",
                    } as const
                  )[item]
                }
              </button>
            ))}
          </div>
          <input
            className="mw-asset-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索素材名称"
          />
          <label className="mw-upload">
            {busy ? "正在上传…" : "＋ 上传素材"}
            <input
              disabled={busy}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml,video/mp4,video/webm,.glb"
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
        <div className={`mw-selection-hint ${onSelect ? "" : "is-neutral"}`}>
          {onSelect
            ? `正在为「${selectionLabel ?? "当前模块"}」选择素材；点击卡片应用，完成编辑后统一保存并发布到 OBS。`
            : "图片按需加载；视频移入卡片时才播放，避免打开素材库时同时解码。"}
        </div>
        <div className="mw-asset-grid">
          {shownAssets.map((asset) => {
            const selectable = onSelect && (canSelect?.(asset) ?? true);
            const chosen = asset.id === selectedAssetId;
            return (
              <article
                key={asset.id}
                className={`${selectable ? "selectable" : ""} ${chosen ? "selected" : ""}`}
                onClick={() => {
                  if (selectable) onSelect(asset);
                }}
              >
                <div className="mw-asset-preview">
                  <MediaThumb asset={asset} />
                </div>
                <div className="mw-asset-meta">
                  <b title={asset.fileName}>{asset.fileName}</b>
                  <small>
                    {asset.origin === "SYSTEM" ? "系统素材" : "已上传"} ·{" "}
                    {asset.kind}
                  </small>
                </div>
                {selectable && (
                  <button
                    className="mw-select-asset"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(asset);
                    }}
                  >
                    {chosen ? "✓ 已选中" : "选用"}
                  </button>
                )}
                {asset.origin === "UPLOADED" && (
                  <button
                    className="mw-delete-asset"
                    onClick={(event) => {
                      event.stopPropagation();
                      void remove(asset);
                    }}
                  >
                    删除
                  </button>
                )}
              </article>
            );
          })}
        </div>
        {!visible.length && <div className="mw-empty">这个分类还没有素材</div>}
        <footer className="mw-library-pagination">
          <span>共 {visible.length} 个素材 · 每页最多 {pageSize} 个</span>
          <div>
            <button disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>上一页</button>
            <b>{page + 1} / {pageCount}</b>
            <button disabled={page + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>下一页</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function StudioWorkbenchView({
  draft,
  assets,
  giftRules,
  stageStatus,
  livePreview = false,
  onReload,
  notify,
}: Props) {
  const [workingProfile, setWorkingProfile] = useState<SceneProfile>(() => structuredClone(draft.profile));
  const composition = workingProfile.composition ?? blankComposition();
  const [selectedId, setSelectedId] = useState<string | undefined>(
    composition.layers.find((layer) => layer.visible)?.id ??
      composition.layers[0]?.id,
  );
  const [zoom, setZoom] = useState(42);
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [librarySelectMode, setLibrarySelectMode] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draggedLayerId, setDraggedLayerId] = useState<string>();
  const [dropTargetId, setDropTargetId] = useState<string>();
  const [saveState, setSaveState] = useState<
    "SAVED" | "DIRTY" | "PUBLISHING"
  >("SAVED");
  const [previewId, setPreviewId] = useState<string>();
  const historyRef = useRef<SceneComposition[]>([]);
  const futureRef = useRef<SceneComposition[]>([]);
  const dragRef = useRef<DragState | undefined>(undefined);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previewIdRef = useRef<string | undefined>(undefined);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const pendingPreviewProfileRef = useRef<SceneProfile | undefined>(undefined);
  const previewRequestInFlightRef = useRef(false);
  const previewMountedRef = useRef(true);
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);
  useEffect(() => {
    setWorkingProfile(structuredClone(draft.profile));
    setSaveState("SAVED");
    historyRef.current = [];
    futureRef.current = [];
  }, [draft.versionId, draft.version]);
  useEffect(() => {
    previewMountedRef.current = true;
    let active = true;
    let sessionId: string | undefined;
    void adminRequest<{ previewSessionId: string }>("/api/preview-sessions", {
      method: "POST",
      body: JSON.stringify({ scenario: "IDLE" }),
    })
      .then((session) => {
        if (!active) {
          void adminRequest(`/api/preview-sessions/${session.previewSessionId}`, {
            method: "DELETE",
          });
          return;
        }
        sessionId = session.previewSessionId;
        previewIdRef.current = sessionId;
        setPreviewId(sessionId);
      })
      .catch(() => notifyRef.current("草稿预览连接失败，已保留正式画面预览"));
    return () => {
      active = false;
      previewMountedRef.current = false;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      if (sessionId)
        void adminRequest(`/api/preview-sessions/${sessionId}`, {
          method: "DELETE",
        });
    };
  // A preview belongs to this workbench mount, not to a parent re-render.
  // Recreating it on every notification reset the iframe/video and made editing feel stuck.
  }, []);

  const flushPreviewUpdate = async () => {
    const sessionId = previewIdRef.current;
    const profile = pendingPreviewProfileRef.current;
    if (!sessionId || !profile || previewRequestInFlightRef.current) return;
    pendingPreviewProfileRef.current = undefined;
    previewRequestInFlightRef.current = true;
    try {
      await adminRequest(`/api/preview-sessions/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ profile }),
      });
    } catch {
      // A preview failure must not block local editing or the published OBS output.
    } finally {
      previewRequestInFlightRef.current = false;
      if (previewMountedRef.current && pendingPreviewProfileRef.current) {
        previewTimerRef.current = setTimeout(() => {
          previewTimerRef.current = undefined;
          void flushPreviewUpdate();
        }, 60);
      }
    }
  };

  const sendPreviewToFrame = (profile: SceneProfile) => {
    const frame = previewFrameRef.current;
    const sessionId = previewIdRef.current;
    if (!frame?.contentWindow || !sessionId) return;
    frame.contentWindow.postMessage(
      {
        type: "MEIHUA_PREVIEW_PROFILE",
        previewSessionId: sessionId,
        profile,
      },
      new URL(overlayBase).origin,
    );
  };

  useEffect(() => {
    if (!previewId) return;
    sendPreviewToFrame(workingProfile);
    pendingPreviewProfileRef.current = workingProfile;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = undefined;
      void flushPreviewUpdate();
    }, 180);
    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [previewId, workingProfile]);
  const selected = composition.layers.find((layer) => layer.id === selectedId);
  const orderedLayers = useMemo(
    () => [...composition.layers].sort((a, b) => b.zIndex - a.zIndex),
    [composition.layers],
  );
  const stageUrl = `${overlayBase}/obs/source/meihua-stage`;
  const draftStageUrl = previewId
    ? `${overlayBase}/preview/${previewId}/source/meihua-stage`
    : stageUrl;
  const updateProfile = (profile: SceneProfile) => {
    setSaveState("DIRTY");
    setWorkingProfile(profile);
  };

  const applyComposition = (next: SceneComposition, record = true) => {
    if (record) {
      historyRef.current = [
        ...historyRef.current.slice(-39),
        cloneComposition(composition),
      ];
      futureRef.current = [];
    }
    setSaveState("DIRTY");
    setWorkingProfile((current) => ({ ...current, composition: next }));
  };

  const patchLayer = (
    id: string,
    patch: Partial<SceneLayer>,
    record = true,
  ) => {
    const next = cloneComposition(composition);
    const index = next.layers.findIndex((layer) => layer.id === id);
    if (index < 0) return;
    next.layers[index] = { ...next.layers[index], ...patch } as SceneLayer;
    applyComposition(next, record);
  };

  const patchTransform = (
    id: string,
    patch: Partial<SceneLayer["transform"]>,
    record = true,
  ) => {
    const layer = composition.layers.find((item) => item.id === id);
    if (!layer) return;
    patchLayer(
      id,
      { transform: { ...layer.transform, ...patch } } as Partial<SceneLayer>,
      record,
    );
  };

  const undo = () => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    futureRef.current.push(cloneComposition(composition));
    applyComposition(previous, false);
  };
  const redo = () => {
    const next = futureRef.current.pop();
    if (!next) return;
    historyRef.current.push(cloneComposition(composition));
    applyComposition(next, false);
  };

  const addModule = (moduleId: SceneModuleId) => {
    const existing = composition.layers.find(
      (layer) => layer.kind === "MODULE" && layer.moduleId === moduleId,
    );
    if (!existing) return;
    patchLayer(existing.id, { visible: true }, true);
    if (moduleId !== "lux3d") {
      const source = workingProfile.sources[moduleId];
      updateProfile({
        ...workingProfile,
        sources: {
          ...workingProfile.sources,
          [moduleId]: { ...source, enabled: true },
        },
        composition: {
          ...composition,
          layers: composition.layers.map((layer) =>
            layer.id === existing.id ? { ...layer, visible: true } : layer,
          ),
        },
      });
    }
    setSelectedId(existing.id);
    setAddOpen(false);
  };

  const addAsset = () => {
    const layer: SceneLayer = {
      id: uid("asset"),
      kind: "ASSET",
      name: "新素材",
      assetId: undefined,
      fit: "CONTAIN",
      transform: { x: 340, y: 650, width: 400, height: 400, rotation: 0 },
      visible: true,
      locked: false,
      opacity: 1,
      zIndex: Math.max(
        50,
        ...composition.layers.map((item) => item.zIndex + 1),
      ),
    };
    applyComposition({
      ...composition,
      layers: [...composition.layers, layer],
    });
    setSelectedId(layer.id);
    setAddOpen(false);
  };
  const addText = () => {
    const layer: SceneLayer = {
      id: uid("text"),
      kind: "TEXT",
      name: "新文字",
      text: "输入文字",
      fontSize: 44,
      color: "#fff5d6",
      align: "CENTER",
      transform: { x: 240, y: 700, width: 600, height: 90, rotation: 0 },
      visible: true,
      locked: false,
      opacity: 1,
      zIndex: Math.max(
        50,
        ...composition.layers.map((item) => item.zIndex + 1),
      ),
    };
    applyComposition({
      ...composition,
      layers: [...composition.layers, layer],
    });
    setSelectedId(layer.id);
    setAddOpen(false);
  };

  const removeLayer = (layer: SceneLayer) => {
    if (layer.kind === "MODULE")
      return patchLayer(layer.id, { visible: false });
    applyComposition({
      ...composition,
      layers: composition.layers.filter((item) => item.id !== layer.id),
    });
    setSelectedId(undefined);
  };

  const applyOrderedLayers = (topToBottom: SceneLayer[]) => {
    const zIndexById = new Map(
      topToBottom.map((layer, index) => [
        layer.id,
        (topToBottom.length - index) * 10,
      ]),
    );
    applyComposition({
      ...composition,
      layers: composition.layers.map((layer) => ({
        ...layer,
        zIndex: zIndexById.get(layer.id) ?? layer.zIndex,
      })),
    });
  };
  const reorder = (layer: SceneLayer, direction: 1 | -1) => {
    const next = [...orderedLayers];
    const from = next.findIndex((item) => item.id === layer.id);
    const to = clamp(from - direction, 0, next.length - 1);
    if (from === to) return;
    next.splice(to, 0, ...next.splice(from, 1));
    applyOrderedLayers(next);
  };
  const dropLayer = (event: ReactDragEvent<HTMLElement>, targetId: string) => {
    event.preventDefault();
    if (!draggedLayerId || draggedLayerId === targetId) return;
    const next = [...orderedLayers];
    const from = next.findIndex((item) => item.id === draggedLayerId);
    const to = next.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    next.splice(to, 0, ...next.splice(from, 1));
    applyOrderedLayers(next);
    setDraggedLayerId(undefined);
    setDropTargetId(undefined);
  };

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    layer: SceneLayer,
    mode: "move" | "resize",
  ) => {
    if (layer.locked) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    historyRef.current = [
      ...historyRef.current.slice(-39),
      cloneComposition(composition),
    ];
    futureRef.current = [];
    dragRef.current = {
      layerId: layer.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      original: layer.transform,
      element:
        event.currentTarget.closest<HTMLElement>(".mw-stage-layer") ??
        event.currentTarget,
    };
    setSelectedId(layer.id);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const factor = zoom / 100;
    const dx = (event.clientX - drag.startX) / factor;
    const dy = (event.clientY - drag.startY) / factor;
    const step = snap ? 10 : 1;
    const round = (value: number) => Math.round(value / step) * step;
    if (drag.mode === "move") {
      drag.latest = {
        x: round(drag.original.x + dx),
        y: round(drag.original.y + dy),
      };
      drag.element.style.left = `${drag.latest.x}px`;
      drag.element.style.top = `${drag.latest.y}px`;
    } else {
      drag.latest = {
        width: Math.max(24, round(drag.original.width + dx)),
        height: Math.max(24, round(drag.original.height + dy)),
      };
      drag.element.style.width = `${drag.latest.width}px`;
      drag.element.style.height = `${drag.latest.height}px`;
    }
  };
  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (drag?.latest) patchTransform(drag.layerId, drag.latest, false);
  };

  const publish = async (): Promise<boolean> => {
    setSaveState("PUBLISHING");
    try {
      await adminRequest("/api/scene-profile/publish", {
        method: "POST",
        body: JSON.stringify({ profile: workingProfile, expectedVersion: draft.version }),
      });
      await onReload();
      setSaveState("SAVED");
      notify("已发布到 OBS，正式舞台已无感切换");
      return true;
    } catch (error) {
      setSaveState("DIRTY");
      notify(error instanceof Error ? error.message : "发布失败");
      return false;
    }
  };

  const publishAndCopyStageUrl = async () => {
    const published = await publish();
    if (!published) return;
    await navigator.clipboard.writeText(stageUrl);
    notify("当前工作台已发布，并已复制 OBS 正式地址");
  };

  const uploadRefresh = async () => {
    // Uploading or deleting a material must never overwrite the in-memory scene draft.
    await onReload(false);
  };
  const availableMedia = assets.filter((asset) => asset.kind !== "LUX3D_MODEL");
  const luxAssets = assets.filter((asset) =>
    ["LUX3D_MODEL", "OVERLAY_IMAGE"].includes(asset.kind),
  );
  const openLibrary = (selectForCurrent = false) => {
    setLibrarySelectMode(selectForCurrent);
    setLibraryOpen(true);
  };
  const selectedLibraryAssetId =
    selected?.kind === "ASSET"
      ? selected.assetId
      : selected?.kind === "MODULE" && selected.moduleId === "lux3d"
        ? workingProfile.visualAssets?.lux3dCoreAssetId
        : selected?.kind === "MODULE"
          ? workingProfile.sources[selected.moduleId as ObsSourceId][
              selected.moduleId === "background" ||
              selected.moduleId === "sticker"
                ? "backgroundAssetId"
                : "decorationAssetId"
            ]
          : undefined;
  const canSelectLibraryAsset = (asset: MediaAsset) => {
    if (!selected) return false;
    if (selected.kind === "ASSET") return asset.kind !== "LUX3D_MODEL";
    if (selected.kind !== "MODULE") return false;
    if (selected.moduleId === "avatar") return false;
    if (selected.moduleId === "lux3d")
      return ["LUX3D_MODEL", "OVERLAY_IMAGE"].includes(asset.kind);
    return (
      asset.mimeType.startsWith("image/") ||
      (selected.moduleId === "background" &&
        asset.mimeType.startsWith("video/"))
    );
  };
  const selectLibraryAsset = (asset: MediaAsset) => {
    if (!selected || !canSelectLibraryAsset(asset)) return;
    if (selected.kind === "ASSET")
      patchLayer(selected.id, {
        assetId: asset.id,
        name: asset.fileName,
      } as Partial<SceneLayer>);
    else if (selected.kind === "MODULE" && selected.moduleId === "lux3d")
      updateProfile({
        ...workingProfile,
        visualAssets: {
          ...workingProfile.visualAssets,
          lux3dCoreAssetId: asset.id,
        },
      });
    else if (selected.kind === "MODULE") {
      const source = workingProfile.sources[selected.moduleId as ObsSourceId];
      const field =
        selected.moduleId === "background" || selected.moduleId === "sticker"
          ? "backgroundAssetId"
          : "decorationAssetId";
      updateProfile({
        ...workingProfile,
        sources: {
          ...workingProfile.sources,
          [selected.moduleId]: { ...source, [field]: asset.id },
        },
      });
    }
    notify(`已为「${selected.name}」选用素材：${asset.fileName}`);
  };

  return (
    <section className="mw-page">
      <header className="mw-toolbar">
        <div className="mw-title">
          <b>画面工作台</b>
          <span>轻量 OBS 场景编辑器 · 1080 × 1920</span>
        </div>
        <div className="mw-tools">
          <button disabled={!historyRef.current.length} onClick={undo}>
            ↶ 撤销
          </button>
          <button disabled={!futureRef.current.length} onClick={redo}>
            ↷ 重做
          </button>
          <button
            className={grid ? "active" : ""}
            onClick={() => setGrid((value) => !value)}
          >
            网格
          </button>
          <button
            className={snap ? "active" : ""}
            onClick={() => setSnap((value) => !value)}
          >
            吸附
          </button>
          <div className="mw-zoom">
            <button
              onClick={() => setZoom((value) => clamp(value - 5, 25, 65))}
            >
              −
            </button>
            <b>{zoom}%</b>
            <button
              onClick={() => setZoom((value) => clamp(value + 5, 25, 65))}
            >
              ＋
            </button>
          </div>
        </div>
        <div className="mw-actions">
          <span className="mw-live-state">
            OBS 实际状态 · {stageStatus ?? "CONNECTING"}
          </span>
          <span className={`mw-save-state is-${saveState.toLocaleLowerCase()}`}>
            {saveState === "SAVED"
              ? "当前版本已发布"
              : saveState === "DIRTY"
                ? "有未发布修改"
                : "正在保存并发布…"}
          </span>
          <button onClick={() => openLibrary(false)}>素材库</button>
          <button
            className="primary"
            disabled={saveState === "PUBLISHING"}
            onClick={() => void publish()}
          >
            保存并发布到 OBS
          </button>
        </div>
      </header>

      <div className="mw-workspace">
        <aside className="mw-layers">
          <header>
            <span>
              <b>场景图层</b>
              <small>
                {composition.layers.filter((layer) => layer.visible).length}{" "}
                个显示中
              </small>
            </span>
            <button
              className="primary"
              onClick={() => setAddOpen((value) => !value)}
            >
              ＋ 添加
            </button>
          </header>
          {addOpen && (
            <div className="mw-add-menu">
              <button onClick={addAsset}>图片 / 视频</button>
              <button onClick={addText}>文字</button>
              {moduleGroups.map((group) => (
                <section key={group.label}>
                  <b>{group.label}</b>
                  {group.ids.map((id) => {
                    const layer = composition.layers.find(
                      (item) => item.kind === "MODULE" && item.moduleId === id,
                    );
                    return (
                      <button
                        key={id}
                        disabled={layer?.visible}
                        onClick={() => addModule(id)}
                      >
                        {layer?.visible ? "✓ " : "＋ "}
                        {moduleNames[id]}
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
          <div className="mw-layer-list">
            {orderedLayers.map((layer) => (
              <article
                key={layer.id}
                className={`${selectedId === layer.id ? "selected" : ""} ${draggedLayerId === layer.id ? "dragging" : ""} ${dropTargetId === layer.id ? "drop-target" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDropTargetId(layer.id);
                }}
                onDrop={(event) => dropLayer(event, layer.id)}
                onClick={() => setSelectedId(layer.id)}
              >
                <span
                  className="mw-drag-handle"
                  title="拖动调整上下图层"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    setDraggedLayerId(layer.id);
                  }}
                  onDragEnd={() => {
                    setDraggedLayerId(undefined);
                    setDropTargetId(undefined);
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  ⋮⋮
                </span>
                <button
                  className={`mw-eye ${layer.visible ? "on" : ""}`}
                  title={layer.visible ? "隐藏" : "显示"}
                  onClick={(event) => {
                    event.stopPropagation();
                    patchLayer(layer.id, { visible: !layer.visible });
                  }}
                >
                  ●
                </button>
                <span
                  className={`mw-kind kind-${layer.kind.toLocaleLowerCase()}`}
                >
                  {layer.kind === "MODULE"
                    ? "M"
                    : layer.kind === "ASSET"
                      ? "图"
                      : "字"}
                </span>
                <span className="mw-layer-name">
                  <b>{layer.name}</b>
                  <small>
                    {Math.round(layer.transform.width)} ×{" "}
                    {Math.round(layer.transform.height)}
                  </small>
                </span>
                <button
                  title={layer.locked ? "解锁" : "锁定"}
                  onClick={(event) => {
                    event.stopPropagation();
                    patchLayer(layer.id, { locked: !layer.locked });
                  }}
                >
                  {layer.locked ? "🔒" : "◇"}
                </button>
                <div className="mw-layer-order">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      reorder(layer, 1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      reorder(layer, -1);
                    }}
                  >
                    ↓
                  </button>
                </div>
              </article>
            ))}
          </div>
        </aside>

        <main
          className={`mw-canvas-area ${grid ? "show-grid" : ""}`}
          onPointerDown={() => setSelectedId(undefined)}
        >
          <div className="mw-canvas-caption">
            <span>
              <i />
              {livePreview ? "直播数据镜像 · 与 OBS 同步" : "草稿预览 · 操作后自动同步"}
            </span>
            <b>
              {livePreview
                ? saveState === "DIRTY"
                  ? "正在预览未发布布局 · OBS 仍使用已发布版本"
                  : "布局与实时数据均来自当前 OBS 版本"
                : "安全区 1080 × 1920"}
            </b>
          </div>
          <div
            className="mw-stage-shell"
            style={{ width: (1080 * zoom) / 100, height: (1920 * zoom) / 100 }}
          >
            <div
              className="mw-stage"
              style={{ transform: `scale(${zoom / 100})` }}
            >
              <iframe
                ref={previewFrameRef}
                className="mw-stage-live-render"
                title="草稿舞台实时画面"
                src={draftStageUrl}
                onLoad={() => sendPreviewToFrame(workingProfile)}
              />
              {composition.layers
                .filter((layer) => layer.visible)
                .sort((a, b) => a.zIndex - b.zIndex)
                .map((layer) => (
                  <div
                    key={layer.id}
                    className={`mw-stage-layer ${selectedId === layer.id ? "selected" : ""} ${layer.locked ? "locked" : ""}`}
                    style={{
                      left: layer.transform.x,
                      top: layer.transform.y,
                      width: layer.transform.width,
                      height: layer.transform.height,
                      opacity: 1,
                      zIndex: 1000 + layer.zIndex,
                      transform: `rotate(${layer.transform.rotation}deg)`,
                    }}
                    onPointerDown={(event) => beginDrag(event, layer, "move")}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    {selectedId === layer.id && !layer.locked && (
                      <>
                        <span className="mw-selection-label">{layer.name}</span>
                        <i
                          className="mw-resize"
                          onPointerDown={(event) =>
                            beginDrag(event, layer, "resize")
                          }
                          onPointerMove={moveDrag}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                        />
                      </>
                    )}
                  </div>
                ))}
              <div className="mw-safe-area" />
            </div>
          </div>
        </main>

        <aside className="mw-inspector">
          {selected ? (
            <>
              <header>
                <div>
                  <b>{selected.name}</b>
                  <small>
                    {selected.kind === "MODULE"
                      ? "业务模块"
                      : selected.kind === "ASSET"
                        ? "媒体素材"
                        : "文字图层"}
                  </small>
                </div>
                <button onClick={() => removeLayer(selected)}>
                  {selected.kind === "MODULE" ? "从画面隐藏" : "删除"}
                </button>
              </header>
              <section>
                <h3>变换</h3>
                <div className="mw-field-grid">
                  <label>
                    X
                    <input
                      type="number"
                      value={selected.transform.x}
                      onChange={(event) =>
                        patchTransform(selected.id, {
                          x: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Y
                    <input
                      type="number"
                      value={selected.transform.y}
                      onChange={(event) =>
                        patchTransform(selected.id, {
                          y: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    宽
                    <input
                      type="number"
                      min="1"
                      value={selected.transform.width}
                      onChange={(event) =>
                        patchTransform(selected.id, {
                          width: Math.max(1, Number(event.target.value)),
                        })
                      }
                    />
                  </label>
                  <label>
                    高
                    <input
                      type="number"
                      min="1"
                      value={selected.transform.height}
                      onChange={(event) =>
                        patchTransform(selected.id, {
                          height: Math.max(1, Number(event.target.value)),
                        })
                      }
                    />
                  </label>
                </div>
                <label>
                  旋转
                  <input
                    type="number"
                    min="-360"
                    max="360"
                    value={selected.transform.rotation}
                    onChange={(event) =>
                      patchTransform(selected.id, {
                        rotation: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  透明度 <b>{Math.round(selected.opacity * 100)}%</b>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={selected.opacity}
                    onChange={(event) =>
                      patchLayer(selected.id, {
                        opacity: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="mw-check">
                  <input
                    type="checkbox"
                    checked={selected.visible}
                    onChange={(event) =>
                      patchLayer(selected.id, { visible: event.target.checked })
                    }
                  />
                  显示图层
                </label>
                <label className="mw-check">
                  <input
                    type="checkbox"
                    checked={selected.locked}
                    onChange={(event) =>
                      patchLayer(selected.id, { locked: event.target.checked })
                    }
                  />
                  锁定图层
                </label>
              </section>
              {selected.kind === "TEXT" && (
                <section>
                  <h3>文字</h3>
                  <label>
                    内容
                    <textarea
                      rows={4}
                      value={selected.text}
                      onChange={(event) =>
                        patchLayer(selected.id, {
                          text: event.target.value,
                        } as Partial<SceneLayer>)
                      }
                    />
                  </label>
                  <div className="mw-field-grid">
                    <label>
                      字号
                      <input
                        type="number"
                        min="8"
                        max="300"
                        value={selected.fontSize}
                        onChange={(event) =>
                          patchLayer(selected.id, {
                            fontSize: Number(event.target.value),
                          } as Partial<SceneLayer>)
                        }
                      />
                    </label>
                    <label>
                      颜色
                      <input
                        type="color"
                        value={selected.color}
                        onChange={(event) =>
                          patchLayer(selected.id, {
                            color: event.target.value,
                          } as Partial<SceneLayer>)
                        }
                      />
                    </label>
                  </div>
                  <label>
                    对齐
                    <select
                      value={selected.align}
                      onChange={(event) =>
                        patchLayer(selected.id, {
                          align: event.target.value,
                        } as Partial<SceneLayer>)
                      }
                    >
                      <option value="LEFT">左对齐</option>
                      <option value="CENTER">居中</option>
                      <option value="RIGHT">右对齐</option>
                    </select>
                  </label>
                </section>
              )}
              {selected.kind === "ASSET" && (
                <section>
                  <h3>素材</h3>
                  <label>
                    图片 / 视频
                    <select
                      value={selected.assetId ?? ""}
                      onChange={(event) =>
                        patchLayer(selected.id, {
                          assetId: event.target.value || undefined,
                        } as Partial<SceneLayer>)
                      }
                    >
                      <option value="">请选择素材</option>
                      {availableMedia.map((asset) => (
                        <option value={asset.id} key={asset.id}>
                          {asset.fileName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    填充方式
                    <select
                      value={selected.fit}
                      onChange={(event) =>
                        patchLayer(selected.id, {
                          fit: event.target.value,
                        } as Partial<SceneLayer>)
                      }
                    >
                      <option value="CONTAIN">完整显示</option>
                      <option value="COVER">铺满裁切</option>
                      <option value="FILL">拉伸铺满</option>
                    </select>
                  </label>
                  <button className="primary" onClick={() => openLibrary(true)}>
                    从素材库选择
                  </button>
                </section>
              )}
              {selected.kind === "MODULE" && (
                <ModuleInspector
                  layer={selected}
                  profile={workingProfile}
                  assets={assets}
                  giftRules={giftRules}
                  onChange={updateProfile}
                  onOpenLibrary={() => openLibrary(true)}
                />
              )}
            </>
          ) : (
            <div className="mw-no-selection">
              <b>选择一个图层</b>
              <span>在左侧图层列表或画布中点击</span>
            </div>
          )}
        </aside>
      </div>

      <footer className="mw-output">
        <span className="mw-obs-badge">OBS</span>
        <div>
          <b>工作台发布后与 OBS 正式画面完全同源</b>
          <small>复制前自动发布当前工作台，避免 OBS 仍显示旧画面</small>
        </div>
        <code>{stageUrl}</code>
        <button
          className="primary"
          disabled={saveState === "PUBLISHING"}
          onClick={() => void publishAndCopyStageUrl()}
        >
          {saveState === "PUBLISHING" ? "正在发布…" : "发布并复制 OBS 地址"}
        </button>
        <button
          onClick={() =>
            window.open(
              draftStageUrl,
              "meihua-stage-draft",
              "width=540,height=960",
            )
          }
        >
          打开草稿预览
        </button>
        <button
          onClick={() =>
            window.open(
              stageUrl,
              "meihua-stage-published",
              "width=540,height=960",
            )
          }
        >
          打开 OBS 正式预览
        </button>
        <button
          className="mw-advanced-toggle"
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          高级来源 {advancedOpen ? "收起" : "展开"}
        </button>
      </footer>
      {advancedOpen && (
        <div className="mw-advanced-sources">
          独立模块地址仅用于诊断：
          {Object.entries(moduleNames)
            .filter(([id]) => id !== "lux3d")
            .map(([id, name]) => (
              <code key={id}>
                {name} · {overlayBase}/obs/source/{id}
              </code>
            ))}
        </div>
      )}
      {libraryOpen && (
        <MaterialLibrary
          assets={assets}
          onClose={() => setLibraryOpen(false)}
          onChanged={uploadRefresh}
          selectionLabel={librarySelectMode ? selected?.name : undefined}
          selectedAssetId={
            librarySelectMode ? selectedLibraryAssetId : undefined
          }
          canSelect={librarySelectMode ? canSelectLibraryAsset : undefined}
          onSelect={librarySelectMode ? selectLibraryAsset : undefined}
        />
      )}
    </section>
  );
}

export const StudioWorkbench = memo(
  StudioWorkbenchView,
  (previous, next) =>
    previous.draft.versionId === next.draft.versionId &&
    previous.draft.version === next.draft.version &&
    previous.assets === next.assets &&
    previous.giftRules === next.giftRules &&
    previous.stageStatus === next.stageStatus &&
    previous.livePreview === next.livePreview,
);

function ModuleInspector({
  layer,
  profile,
  assets,
  giftRules,
  onChange,
  onOpenLibrary,
}: {
  layer: Extract<SceneLayer, { kind: "MODULE" }>;
  profile: SceneProfile;
  assets: MediaAsset[];
  giftRules: GiftRule[];
  onChange: (profile: SceneProfile) => void;
  onOpenLibrary: () => void;
}) {
  if (layer.moduleId === "lux3d") {
    const selected = profile.visualAssets?.lux3dCoreAssetId ?? "";
    return (
      <section>
        <h3>玄金罗盘</h3>
        <label>
          罗盘核心
          <select
            value={selected}
            onChange={(event) =>
              onChange({
                ...profile,
                visualAssets: {
                  ...profile.visualAssets,
                  lux3dCoreAssetId: event.target.value || undefined,
                },
              })
            }
          >
            <option value="">系统默认黑金盘</option>
            {assets
              .filter((asset) =>
                ["LUX3D_MODEL", "OVERLAY_IMAGE"].includes(asset.kind),
              )
              .map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.origin === "SYSTEM" ? "系统 · " : ""}
                  {asset.fileName}
                </option>
              ))}
          </select>
        </label>
        <small>
          待机时外圈持续旋转；开始测算时中心聚能旋转并显示本卦、互卦和变卦。
        </small>
        <button onClick={onOpenLibrary}>管理罗盘素材</button>
      </section>
    );
  }
  const source = profile.sources[layer.moduleId] as ObsSourceConfig;
  const patch = (value: Partial<ObsSourceConfig>) =>
    onChange({
      ...profile,
      sources: {
        ...profile.sources,
        [layer.moduleId]: { ...source, ...value },
      },
    });
  const assetField =
    layer.moduleId === "background" || layer.moduleId === "sticker"
      ? "backgroundAssetId"
      : "decorationAssetId";
  const transparent = Boolean(source.contentOnly);
  const giftOffers: GiftWindowOffer[] = source.giftOffers?.length
    ? source.giftOffers
    : source.selectedGiftId
      ? [{
          id: `legacy-${source.selectedGiftId}`,
          giftId: source.selectedGiftId,
          giftName: source.selectedGiftName ?? "礼物测算",
          coins: source.selectedGiftCoins,
          speechTargetSeconds: source.selectedGiftSpeechSeconds ?? 30,
          message: source.giftMessage ?? source.idleText,
        }]
      : [];
  const patchOffers = (offers: GiftWindowOffer[]) => patch({ giftOffers: offers });
  const patchOffer = (id: string, value: Partial<GiftWindowOffer>) =>
    patchOffers(giftOffers.map((offer) => offer.id === id ? { ...offer, ...value } : offer));
  const availableGiftOptions = referenceGiftCatalog.map((gift) => {
    const rule = giftRules.find((item) => item.giftId === gift.giftId);
    return { giftId: gift.giftId!, giftName: gift.name, coins: gift.coins, speechTargetSeconds: rule?.speechTargetSeconds ?? 30 };
  });
  for (const rule of giftRules) {
    if (rule.giftId && !availableGiftOptions.some((gift) => gift.giftId === rule.giftId)) availableGiftOptions.push({ giftId: rule.giftId, giftName: rule.giftName, coins: undefined, speechTargetSeconds: rule.speechTargetSeconds });
  }
  return (
    <>
      <section>
        <h3>内容</h3>
        {layer.moduleId === "gift-alert" && (
          <div className="mw-gift-window-config">
            <label>
              添加礼物
              <select
                value=""
                onChange={(event) => {
                  const gift = availableGiftOptions.find((item) => item.giftId === event.target.value);
                  if (!gift || giftOffers.some((offer) => offer.giftId === gift.giftId)) return;
                  const offer: GiftWindowOffer = {
                    id: `gift-offer-${gift.giftId}-${crypto.randomUUID()}`,
                    giftId: gift.giftId,
                    giftName: gift.giftName,
                    coins: gift.coins,
                    speechTargetSeconds: gift.speechTargetSeconds,
                    message: `送出${gift.giftName}，获得 ${gift.speechTargetSeconds} 秒专属梅花易数测算`,
                  };
                  patch({ giftOffers: [...giftOffers, offer], maxItems: Math.max(source.maxItems, giftOffers.length + 1) });
                }}
              >
                <option value="">＋ 从已配置礼物中添加</option>
                {availableGiftOptions.filter((gift) => !giftOffers.some((offer) => offer.giftId === gift.giftId)).map((gift) => <option key={gift.giftId} value={gift.giftId}>{gift.giftName} · {gift.coins ?? "—"} 票 · {gift.speechTargetSeconds} 秒 · ID {gift.giftId}</option>)}
              </select>
            </label>
            <small>可添加多个礼物。价格/票数只供管理员配置，不会显示在直播画面。</small>
            <div className="mw-gift-offer-editor">
              {giftOffers.map((offer) => <article key={offer.id}>
                <header><img src={giftIconUrl(offer.giftId)} alt="" /><span><b>{offer.giftName}</b><small>ID {offer.giftId}</small></span><button onClick={() => patchOffers(giftOffers.filter((item) => item.id !== offer.id))}>删除</button></header>
                <div className="mw-field-grid">
                  <label>价格 / 票数<input type="number" min="0" value={offer.coins ?? 0} onChange={(event) => patchOffer(offer.id, { coins: Math.max(0, Number(event.target.value)) })} /></label>
                  <label>测算时间（秒）<input type="number" min="5" max="600" value={offer.speechTargetSeconds} onChange={(event) => patchOffer(offer.id, { speechTargetSeconds: Math.max(5, Number(event.target.value)) })} /></label>
                </div>
                <label>礼物旁的一句话<textarea rows={2} value={offer.message} onChange={(event) => patchOffer(offer.id, { message: event.target.value })} /></label>
              </article>)}
              {!giftOffers.length && <div className="mw-empty-offers">还没有礼物，使用上方下拉框添加。</div>}
            </div>
          </div>
        )}
        <label className="mw-check">
          <input
            type="checkbox"
            checked={source.showTitle}
            onChange={(event) => patch({ showTitle: event.target.checked })}
          />
          显示模块标题
        </label>
        <label>
          标题
          <input
            value={source.titleText}
            onChange={(event) => patch({ titleText: event.target.value })}
          />
        </label>
        <label>
          待机内容
          <textarea
            rows={3}
            value={source.idleText}
            onChange={(event) => patch({ idleText: event.target.value })}
          />
        </label>
        <label>
          动态正文模板
          <textarea
            rows={3}
            value={source.contentTemplate ?? ""}
            placeholder={
              layer.moduleId === "current-viewer"
                ? "例如：@{{username}} · {{question}}"
                : "留空时使用系统默认实时内容"
            }
            onChange={(event) =>
              patch({ contentTemplate: event.target.value })
            }
          />
        </label>
        {layer.moduleId === "current-viewer" && (
          <small>
            可用变量：{"{{username}}"}、{"{{question}}"}、
            {"{{qualification}}"}、{"{{seconds}}"}。直播事件更新时会自动替换。
          </small>
        )}
        <label>
          最多显示
          <select
            value={source.maxItems}
            onChange={(event) =>
              patch({ maxItems: Number(event.target.value) })
            }
          >
            {[1, 3, 5, 6, 10, 20].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </section>
      <section>
        <h3>外观与素材</h3>
        <button
          className={`mw-transparent-toggle ${transparent ? "active" : ""}`}
          onClick={() =>
            patch(
              transparent
                ? {
                    contentOnly: false,
                    backgroundMode: "SOLID",
                    backgroundOpacity: 0.82,
                    borderless: false,
                  }
                : {
                    contentOnly: true,
                    backgroundMode: "TRANSPARENT",
                    backgroundOpacity: 0,
                    borderless: true,
                  },
            )
          }
        >
          {transparent ? "恢复窗口底板" : "仅显示内容（去掉框框）"}
        </button>
        <small>只移除模块底板、边框和阴影，文字、礼物和业务内容保留。</small>
        <label>
          文字大小 <b>{Math.round(source.fontScale * 100)}%</b>
          <input type="range" min="0.5" max="2.5" step="0.05" value={source.fontScale} onChange={(event) => patch({ fontScale: Number(event.target.value) })} />
        </label>
        <div className="mw-color-grid">
          <label>
            文字
            <input
              type="color"
              value={source.textColor}
              onChange={(event) => patch({ textColor: event.target.value })}
            />
          </label>
          <label>
            主题
            <input
              type="color"
              value={source.accentColor}
              onChange={(event) => patch({ accentColor: event.target.value })}
            />
          </label>
          <label>
            底色
            <input
              type="color"
              value={source.backgroundColor}
              onChange={(event) =>
                patch({ backgroundColor: event.target.value })
              }
            />
          </label>
        </div>
        {layer.moduleId !== "avatar" ? <>
          <label>
            {layer.moduleId === "background" ? "背景图片 / 视频" : "装饰素材"}
            <select
              value={source[assetField] ?? ""}
              onChange={(event) =>
                patch({ [assetField]: event.target.value || undefined })
              }
            >
              <option value="">不使用素材</option>
              {assets
                .filter(
                  (asset) =>
                    asset.mimeType.startsWith("image/") ||
                    (layer.moduleId === "background" &&
                      asset.mimeType.startsWith("video/")),
                )
                .map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.mimeType.startsWith("video/") ? "视频 · " : ""}
                    {asset.fileName}
                  </option>
                ))}
            </select>
          </label>
          <button
            className={layer.moduleId === "background" ? "primary" : ""}
            onClick={onOpenLibrary}
          >
            {layer.moduleId === "background"
              ? "选择图片或视频背景"
              : "打开素材库"}
          </button>
        </> : <small>播报画面由“接入与播报 → 最终画面”统一提供，不允许叠加装饰素材，避免遮挡人物和视频。</small>}
        {layer.moduleId === "background" && (
          <small>支持 MP4 / WebM，正式舞台与草稿预览均会静音、循环播放。</small>
        )}
        <label>
          动画
          <select
            value={source.animationStyle}
            onChange={(event) =>
              patch({
                animationStyle: event.target
                  .value as ObsSourceConfig["animationStyle"],
              })
            }
          >
            <option value="smooth">柔和</option>
            <option value="energetic">醒目</option>
            <option value="minimal">极简</option>
          </select>
        </label>
      </section>
    </>
  );
}
