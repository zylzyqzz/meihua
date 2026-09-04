import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BroadcastSnapshotV2, ContentLanguage, ObsSourceConfig, ObsSourceId, SceneComposition, SceneLayer } from '@meihua/core-types';
import { Hexagram, MaterialLux3DSource, SourceContent, SynchronizedVideo, authenticatedUrl, mediaAssetUrl, labelFor, qualificationLabel, sourceCopy, sourceStyle } from './App.js';
import { resolveBackgroundMode } from '@meihua/core-types';
import { VrmAvatar } from './VrmAvatar.js';
import './stage.css';

const apiBase = import.meta.env.VITE_ORCHESTRATOR_HTTP ?? 'http://127.0.0.1:3210';

/**
 * V2.2 official integrated stage. It renders one 1080×1920 composition from the
 * existing BroadcastSnapshotV2 + DirectorCue stream only: every visual change is
 * caused by a snapshot or cue message, so the stage keeps no independent timers.
 */

type StageCopy = {
  brand: string;
  idleHint: string;
  queueTitle: string;
  queueEmpty: string;
  castStatus: string;
  hexTitle: string;
  hexEmpty: string;
  giftPendingResult: string;
  giftAppliedResult: string;
  honorific: string;
};

const stageCopy: Record<ContentLanguage, StageCopy> = {
  en: {
    brand: 'MEIHUA · LIVE CAST', idleHint: '100 likes or 4 Roses unlock a reading. Then ask one clear question.', queueTitle: 'WAITING LIST', queueEmpty: 'No one is waiting yet',
    castStatus: 'CASTING NOW', hexTitle: 'THE READING', hexEmpty: 'Waiting to cast',
    giftPendingResult: 'Priority saved — ask your question', giftAppliedResult: 'Priority updated in the waiting list', honorific: 'for',
  },
  'zh-CN': {
    brand: '梅花 · 直播演播台', idleHint: '把一个清晰的问题发在评论区', queueTitle: '等待队列', queueEmpty: '队列空闲',
    castStatus: '正在测算', hexTitle: '本场测算', hexEmpty: '等待起卦',
    giftPendingResult: '权益已保留 —— 请把问题发在评论区', giftAppliedResult: '已在队列中提升优先', honorific: '的',
  },
  es: {
    brand: 'MEIHUA · CAST', idleHint: 'Escribe una pregunta clara en el chat', queueTitle: 'COLA DE ESPERA', queueEmpty: 'Aún no hay nadie',
    castStatus: 'CALCULANDO', hexTitle: 'LA LECTURA', hexEmpty: 'Esperando la tirada',
    giftPendingResult: 'Prioridad guardada — haz tu pregunta', giftAppliedResult: 'Prioridad actualizada en la cola', honorific: 'para',
  },
  fr: {
    brand: 'MEIHUA · DIRECT', idleHint: 'Posez une question claire dans le chat', queueTitle: 'FILE D’ATTENTE', queueEmpty: 'Personne pour l’instant',
    castStatus: 'TIRAGE EN COURS', hexTitle: 'LA LECTURE', hexEmpty: 'En attente du tirage',
    giftPendingResult: 'Priorité gardée — posez votre question', giftAppliedResult: 'Priorité mise à jour dans la file', honorific: 'pour',
  },
  de: {
    brand: 'MEIHUA · LIVE', idleHint: 'Stelle eine klare Frage im Chat', queueTitle: 'WARTESCHLANGE', queueEmpty: 'Noch niemand da',
    castStatus: 'WIRD BERECHNET', hexTitle: 'DIE DEUTUNG', hexEmpty: 'Warte auf die Deutung',
    giftPendingResult: 'Priorität gesichert — stelle deine Frage', giftAppliedResult: 'Priorität in der Warteschlange erhöht', honorific: 'für',
  },
  ja: {
    brand: '梅花 · ライブ配信', idleHint: 'チャットに明確な質問を一つ送ってください', queueTitle: '待機リスト', queueEmpty: '現在待機者はいません',
    castStatus: '占い中', hexTitle: '本日のリーディング', hexEmpty: '卦を待っています',
    giftPendingResult: '優先権を確保しました —— 質問をどうぞ', giftAppliedResult: '待機リストで優先されました', honorific: 'の',
  },
  ko: {
    brand: '매화 · 라이브 캐스트', idleHint: '채팅에 명확한 질문 하나를 남겨주세요', queueTitle: '대기 목록', queueEmpty: '아직 대기자가 없습니다',
    castStatus: '점괘 계산 중', hexTitle: '이번 리딩', hexEmpty: '점괘 대기 중',
    giftPendingResult: '우선권 저장됨 — 질문을 남겨주세요', giftAppliedResult: '대기 목록에서 우선순위 상승', honorific: '의',
  },
  pt: {
    brand: 'MEIHUA · AO VIVO', idleHint: 'Envie uma pergunta clara no chat', queueTitle: 'FILA DE ESPERA', queueEmpty: 'Ninguém por enquanto',
    castStatus: 'CALCULANDO', hexTitle: 'A LEITURA', hexEmpty: 'Aguardando o lançamento',
    giftPendingResult: 'Prioridade salva — faça sua pergunta', giftAppliedResult: 'Prioridade atualizada na fila', honorific: 'para',
  },
  ru: {
    brand: 'МЭЙХУА · ЭФИР', idleHint: 'Задайте один ясный вопрос в чате', queueTitle: 'ОЧЕРЕДЬ', queueEmpty: 'Пока никого нет',
    castStatus: 'РАСЧЁТ', hexTitle: 'ЧТЕНИЕ', hexEmpty: 'Ожидание гексаграммы',
    giftPendingResult: 'Приоритет сохранён — задайте вопрос', giftAppliedResult: 'Приоритет в очереди повышен', honorific: 'для',
  },
};

function StageBackground({ snapshot, config }: { snapshot: BroadcastSnapshotV2; config: ObsSourceConfig }) {
  const assetId = config.backgroundAssetId;
  const asset = assetId ? snapshot.mediaAssets?.find((item) => item.id === assetId) : undefined;
  if (assetId && asset) {
    const url = mediaAssetUrl(snapshot, assetId);
    const waitingForAudio = snapshot.activeCue?.payload.awaitingAudioStart === true;
    const speaking = snapshot.stage === 'SPEAKING' && !waitingForAudio;
    return <div className="stage-bg-media">{asset.mimeType.startsWith('video/')
      ? <SynchronizedVideo src={url} mediaEpoch={speaking ? snapshot.activeCue?.startsAt : undefined} playing={speaking} loop={false} resetKey={`${snapshot.reading?.id ?? 'idle'}:${snapshot.activeCue?.cueId ?? 'idle'}:${url}`} />
      : <img src={url} alt="" />}</div>;
  }
  // The built-in backdrop is pure CSS so the default scene stays asset-free.
  return <div className="stage-bg-gradient"><i className="stage-glow stage-glow-a" /><i className="stage-glow stage-glow-b" /><i className="stage-vignette" /></div>;
}

function StagePersonArea({ snapshot }: { snapshot: BroadcastSnapshotV2 }) {
  const presentation = snapshot.presentationMedia;
  const waiting = snapshot.activeCue?.payload.awaitingAudioStart === true;
  const speaking = snapshot.stage === 'SPEAKING' && !waiting;
  const presentationEpoch = speaking ? snapshot.activeCue?.startsAt : undefined;
  if (snapshot.presentationMode === 'AUDIO_ONLY') return null;
  if (snapshot.presentationMode === 'VIDEO_LOOP' || snapshot.presentationMode === 'VIDEO_ONCE') {
    if (!presentation?.url) return <div className="stage-person stage-person-empty"><i className="stage-light-cone" /></div>;
    const src = authenticatedUrl(presentation.url.startsWith('http') ? presentation.url : `${apiBase}${presentation.url}`);
    return <div className="stage-person media-provider presentation-video"><SynchronizedVideo src={src} mediaEpoch={presentationEpoch} resetKey={`${snapshot.reading?.id ?? 'idle'}:${snapshot.activeCue?.cueId ?? 'idle'}:${presentation.outputAssetId ?? presentation.url}`} playing={speaking} loop={presentation.playback !== 'ONCE'} style={{ objectFit: presentation.fit === 'CONTAIN' ? 'contain' : 'cover' }} /></div>;
  }
  const media = snapshot.avatarStageMedia;
  if (media?.kind === 'VRM' && media.url) {
    const src = authenticatedUrl(media.url.startsWith('http') ? media.url : `${apiBase}${media.url}`);
    const action = String(snapshot.activeCue?.payload.avatarAction ?? 'IDLE') as Parameters<typeof VrmAvatar>[0]['action'];
    return <div className="stage-person media-provider"><VrmAvatar src={src} action={action} lipSyncPlan={snapshot.speechPlan?.lipSyncPlan ?? snapshot.reading?.lipSyncPlan} startedAt={snapshot.speechPlan?.startedAt} /></div>;
  }
  if (media && media.kind !== 'STATIC' && media.url) {
    // External provider stream; prerecorded assets remain the fallback below.
    const src = authenticatedUrl(media.url.startsWith('http') ? media.url : `${apiBase}${media.url}`);
    const notifyReady = media.renderJobId ? () => { void fetch(authenticatedUrl(`${apiBase}/api/digital-human/media-ready`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ renderJobId: media.renderJobId }) }).catch(() => undefined); } : undefined;
    return <div className="stage-person media-provider"><SynchronizedVideo src={src} mediaEpoch={presentationEpoch ?? snapshot.mediaEpoch} resetKey={`${snapshot.reading?.id ?? 'idle'}:${snapshot.activeCue?.cueId ?? 'idle'}:${media.outputAssetId ?? media.url}`} playing={snapshot.stage === 'SPEAKING' ? !waiting : false} loop={media.playback !== 'ONCE'} onReady={notifyReady} /></div>;
  }
  const profile = snapshot.profileVersion.profile;
  const cueAction = String(snapshot.activeCue?.payload.avatarAction ?? 'IDLE');
  const action = (cueAction in profile.avatar.slots ? cueAction : 'IDLE') as keyof typeof profile.avatar.slots;
  const selected = profile.avatar.slots[action] ?? profile.avatar.slots.IDLE;
  const fallback = selected.assetId ? selected : profile.avatar.slots[selected.fallbackAction] ?? profile.avatar.slots.IDLE;
  if (!fallback?.assetId) return <div className="stage-person stage-person-empty"><i className="stage-light-cone" /></div>;
  const url = mediaAssetUrl(snapshot, fallback.assetId);
  const metadata = snapshot.mediaAssets?.find((item) => item.id === fallback.assetId);
  const isVideo = metadata ? metadata.mimeType.startsWith('video/') : fallback.mode !== 'STATIC_FALLBACK';
  return <div className={`stage-person media-slot ${fallback.mode === 'CHROMA_KEY' ? 'chroma' : ''}`} key={action}><i className="stage-light-cone" />{isVideo ? <SynchronizedVideo src={url} mediaEpoch={snapshot.mediaEpoch} /> : <img src={url} alt="" />}</div>;
}

function StageQueue({ snapshot, config, copy }: { snapshot: BroadcastSnapshotV2; config: ObsSourceConfig; copy: StageCopy }) {
  const current = snapshot.reading;
  const currentQualification = current?.qualification ? qualificationLabel(current.qualification.kind, current.qualification.label, current.gift?.giftName) : undefined;
  const casting = current && ['SELECTED', 'CASTING', 'INTERPRETING', 'COMPOSING', 'SYNTHESIZING', 'SPEAKING', 'FINISH'].includes(snapshot.stage)
    ? { username: current.username, label: currentQualification, question: current.normalizedQuestion ?? current.rawQuestion }
    : undefined;
  const slots = Math.max(1, config.maxItems);
  const entries = snapshot.qualificationQueue.slice(0, Math.max(0, slots - (casting ? 1 : 0)));
  const copyL = sourceCopy.en;
  return <section className="stage-panel stage-queue">
    <header><b>{copy.queueTitle}</b><span>{(casting ? 1 : 0) + entries.length}</span></header>
    {casting ? <div className="stage-queue-row is-casting"><em>NOW</em><span><strong>@{casting.username}</strong><b>{copy.castStatus}</b></span></div> : null}
    {entries.length === 0 && !casting ? <div className="stage-queue-empty">{copy.queueEmpty}</div> : null}
    {entries.map((item) => <div key={item.id} className={`stage-queue-row ${item.status === 'WAITING_QUESTION' ? 'is-waiting' : 'is-queued'}`}><em>{item.position ? String(item.position).padStart(2, '0') : '·'}</em><span><strong>@{item.username}</strong><b>{item.status === 'WAITING_QUESTION' ? copyL.waitingQuestion : copyL.queued}</b></span></div>)}
  </section>;
}

function StageHexagramPanel({ snapshot }: { snapshot: BroadcastSnapshotV2 }) {
  const meihua = snapshot.reading?.meihua;
  if (!meihua) return null;
  // Keyed by the active cue so a fresh cast re-runs the once-only reveal animation.
  const revealKey = [snapshot.activeCue?.cueId, snapshot.activeCue?.revision, meihua?.primary?.number, snapshot.activeCue?.stage].join(':');
  return <section className="hexagrams-primary-only" aria-label="Primary hexagram" key={revealKey}>
    <Hexagram lines={meihua.primary.lines} />
  </section>;
}

function StageGiftBanner({ snapshot, copy }: { snapshot: BroadcastSnapshotV2; copy: StageCopy }) {
  const now = Date.now();
  const qualification = [...snapshot.sideCues].reverse().find((cue) => cue.stage === 'QUALIFIED' && (!cue.endsAt || cue.endsAt > now));
  if (!qualification) return null;
  const payload = qualification.payload as Record<string, unknown>;
  const result = payload.action === 'APPLIED_TO_QUEUE' ? copy.giftAppliedResult : copy.giftPendingResult;
  return <section className="stage-gift">
    <div><b>@{String(payload.username ?? '')}</b></div>
    <strong>{String(payload.message ?? result)}</strong>
  </section>;
}

function legacyComposition(): SceneComposition {
  const layer = (id: string, moduleId: Extract<SceneLayer, {kind:'MODULE'}>['moduleId'], x: number, y: number, width: number, height: number, zIndex: number): SceneLayer => ({ id, kind: 'MODULE', moduleId, name: moduleId, transform: { x, y, width, height, rotation: 0 }, visible: true, locked: false, opacity: 1, zIndex });
  return { width: 1080, height: 1920, layers: [
    layer('legacy-background','background',0,0,1080,1920,0), layer('legacy-effects','effects',0,0,1080,1920,5),
    layer('legacy-status','status',46,40,988,100,20), layer('legacy-gift','gift-alert',46,158,988,140,30),
    layer('legacy-avatar','avatar',40,310,520,870,20), layer('legacy-queue','queue',610,310,430,870,20),
    layer('legacy-hexagram','hexagram',80,1240,920,420,25), layer('legacy-disclaimer','disclaimer',80,1770,920,90,30),
  ] };
}

function StageLayerContent({ layer, snapshot }: { layer: SceneLayer; snapshot: BroadcastSnapshotV2 }) {
  if (layer.kind === 'TEXT') return <div className={`stage-free-text align-${layer.align.toLocaleLowerCase()}`} style={{ fontSize: layer.fontSize, color: layer.color, fontFamily: layer.fontFamily }}>{layer.text}</div>;
  if (layer.kind === 'ASSET') {
    if (!layer.assetId) return null;
    const asset = snapshot.mediaAssets?.find((item) => item.id === layer.assetId);
    const src = mediaAssetUrl(snapshot, layer.assetId);
    const objectFit = layer.fit.toLocaleLowerCase() as 'contain' | 'cover' | 'fill';
    return asset?.mimeType.startsWith('video/') ? <SynchronizedVideo className="stage-free-media" src={src} mediaEpoch={snapshot.mediaEpoch} style={{ objectFit }} /> : <img className="stage-free-media" src={src} alt="" style={{ objectFit }} />;
  }
  if (layer.moduleId === 'hexagram' && (!snapshot.reading?.meihua || !['SELECTED', 'CASTING', 'INTERPRETING', 'COMPOSING', 'SYNTHESIZING', 'SPEAKING', 'FINISH'].includes(snapshot.stage))) return null;
  if (layer.moduleId === 'lux3d') return <MaterialLux3DSource snapshot={snapshot} embedded />;
  return <SourceContent sourceId={layer.moduleId as ObsSourceId} snapshot={snapshot} serverNow={() => Date.now()} embeddedSize={{ width: layer.transform.width, height: layer.transform.height }} />;
}

export function StageSource({ snapshot }: { snapshot: BroadcastSnapshotV2 }) {
  const profile = snapshot.profileVersion.profile;
  const config = profile.sources['meihua-stage'];
  const composition = profile.composition;
  const copy = stageCopy.en;
  const stage = snapshot.stage;
  const live = Boolean(snapshot.session && snapshot.session.status === 'LIVE');
  const stageText = stage === 'IDLE' ? (config.idleText || labelFor(stage, 'en')) : labelFor(stage, 'en');
  const currentQuestion = snapshot.reading ? (snapshot.reading.normalizedQuestion ?? snapshot.reading.rawQuestion) : undefined;
  // 背景模式类名与配置同步：绿幕/透明时 obs-output 的去边框、去阴影规则才会生效
  const mode = resolveBackgroundMode(config).toLocaleLowerCase();
  // 视口自适应：无论浏览器窗口多大，整个舞台始终完整可见；OBS 1080×1920 下原生 1:1 不缩放。
  const [fit, setFit] = useState(1);
  const visibleLayers = composition?.layers.filter((layer) => layer.visible) ?? [];
  const hasLux3d = visibleLayers.some(
    (layer) => layer.kind === 'MODULE' && layer.moduleId === 'lux3d',
  );
  const renderLayers = visibleLayers.filter(
    (layer) => !(hasLux3d && layer.kind === 'MODULE' && layer.moduleId === 'hexagram'),
  );
  useEffect(() => {
    const resize = () => setFit(Math.min(window.innerWidth / 1080, window.innerHeight / 1920));
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return <main className={`source-root stage-root background-${mode} effect-smooth`} style={{ ...sourceStyle(config), width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden' }}>
    <div style={{ width: 1080, height: 1920, position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%, -50%) scale(${fit})`, transformOrigin: 'center center' }}>
      {composition ? <>
        {renderLayers.sort((a, b) => a.zIndex - b.zIndex).map((layer) => <div key={layer.id} className={`stage-composition-layer layer-${layer.kind.toLocaleLowerCase()}`} style={{ left: layer.transform.x, top: layer.transform.y, width: layer.transform.width, height: layer.transform.height, opacity: layer.opacity, zIndex: layer.zIndex, transform: `rotate(${layer.transform.rotation}deg)` }}><StageLayerContent layer={layer} snapshot={snapshot} /></div>)}
      </> : <>
        <StageBackground snapshot={snapshot} config={config} />
        <header className="stage-status"><div className="stage-brand"><i className={live ? 'is-live' : ''} /><b>{copy.brand}</b><span>{stageText}</span></div><div className="stage-now">{snapshot.reading ? <><b>@{snapshot.reading.username}</b><span>{currentQuestion}</span></> : <span>{copy.idleHint}</span>}</div></header>
        <div className="stage-person-zone"><StagePersonArea snapshot={snapshot} /></div>
        <div className="stage-queue-zone"><StageQueue snapshot={snapshot} config={config} copy={copy} /></div>
        <div className="stage-hex-zone"><StageHexagramPanel snapshot={snapshot} /></div>
        <div className="stage-gift-zone"><StageGiftBanner snapshot={snapshot} copy={copy} /></div>
        <footer className="stage-disclaimer">{profile.disclaimer}</footer>
      </>}
    </div>
  </main>;
}
