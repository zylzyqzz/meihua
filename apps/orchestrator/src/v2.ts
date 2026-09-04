import type {
  AnswerContent,
  AppSettings,
  AvatarActionName,
  MediaAvatarProfile,
  ObsSourceConfig,
  ObsSourceId,
  SceneComposition,
  SceneLayer,
  SceneModuleId,
  SceneProfile,
  SpeechPlan,
} from '@meihua/core-types';

const sourceLayout: Record<ObsSourceId, Pick<ObsSourceConfig, 'width' | 'height' | 'titleText' | 'idleText' | 'idleBehavior' | 'showTitle' | 'maxItems'>> = {
  avatar: { width: 720, height: 1280, titleText: '', idleText: '', idleBehavior: 'KEEP_LAST', showTitle: false, maxItems: 1 },
  background: { width: 1080, height: 1920, titleText: '', idleText: '', idleBehavior: 'KEEP_LAST', showTitle: false, maxItems: 1 },
  'current-viewer': { width: 900, height: 220, titleText: 'CURRENT VIEWER', idleText: 'Waiting for the next viewer', idleBehavior: 'HIDE', showTitle: true, maxItems: 1 },
  hexagram: { width: 1040, height: 720, titleText: 'MEIHUA CAST', idleText: 'Waiting to cast', idleBehavior: 'HIDE', showTitle: false, maxItems: 3 },
  subtitles: { width: 900, height: 180, titleText: '', idleText: '', idleBehavior: 'HIDE', showTitle: false, maxItems: 1 },
  queue: { width: 520, height: 500, titleText: 'WAITING LIST', idleText: 'Waiting list is empty', idleBehavior: 'HIDE', showTitle: true, maxItems: 6 },
  'gift-alert': { width: 760, height: 180, titleText: 'GIFT PRIORITY', idleText: 'Choose a gift option to unlock a reading', idleBehavior: 'PREVIEW', showTitle: true, maxItems: 1 },
  'gift-ranking': { width: 520, height: 560, titleText: 'GIFT RANKING', idleText: 'No gifts yet', idleBehavior: 'HIDE', showTitle: true, maxItems: 5 },
  'engagement-ranking': { width: 520, height: 560, titleText: 'ENGAGEMENT RANKING', idleText: 'No engagement yet', idleBehavior: 'HIDE', showTitle: true, maxItems: 5 },
  status: { width: 900, height: 120, titleText: '', idleText: 'Waiting for the next viewer', idleBehavior: 'PREVIEW', showTitle: false, maxItems: 1 },
  effects: { width: 1080, height: 1920, titleText: '', idleText: '', idleBehavior: 'HIDE', showTitle: false, maxItems: 1 },
  disclaimer: { width: 900, height: 60, titleText: '', idleText: '', idleBehavior: 'PREVIEW', showTitle: false, maxItems: 1 },
  audio: { width: 160, height: 80, titleText: '', idleText: '', idleBehavior: 'HIDE', showTitle: false, maxItems: 1 },
  sticker: { width: 320, height: 320, titleText: '', idleText: '', idleBehavior: 'PREVIEW', showTitle: false, maxItems: 1 },
  'meihua-stage': { width: 1080, height: 1920, titleText: '', idleText: '', idleBehavior: 'KEEP_LAST', showTitle: false, maxItems: 6 },
  'full-preview': { width: 1080, height: 1920, titleText: '', idleText: '', idleBehavior: 'PREVIEW', showTitle: false, maxItems: 20 },
};

export const sceneModuleIds: SceneModuleId[] = [
  'background', 'effects', 'status', 'current-viewer', 'gift-alert', 'avatar', 'queue',
  'lux3d', 'hexagram', 'subtitles', 'gift-ranking', 'engagement-ranking', 'sticker', 'disclaimer',
];

const defaultCompositionLayout: Record<SceneModuleId, { x: number; y: number; width: number; height: number; zIndex: number }> = {
  background: { x: 0, y: 0, width: 1080, height: 1920, zIndex: 0 },
  effects: { x: 0, y: 0, width: 1080, height: 1920, zIndex: 5 },
  status: { x: 40, y: 34, width: 1000, height: 106, zIndex: 20 },
  'current-viewer': { x: 60, y: 150, width: 960, height: 170, zIndex: 21 },
  'gift-alert': { x: 40, y: 160, width: 1000, height: 150, zIndex: 30 },
  avatar: { x: 40, y: 320, width: 500, height: 830, zIndex: 20 },
  queue: { x: 580, y: 320, width: 460, height: 830, zIndex: 20 },
  lux3d: { x: 350, y: 760, width: 380, height: 380, zIndex: 24 },
  hexagram: { x: 60, y: 1210, width: 960, height: 470, zIndex: 25 },
  subtitles: { x: 80, y: 1690, width: 920, height: 70, zIndex: 30 },
  'gift-ranking': { x: 40, y: 360, width: 480, height: 600, zIndex: 18 },
  'engagement-ranking': { x: 560, y: 360, width: 480, height: 600, zIndex: 18 },
  sticker: { x: 780, y: 50, width: 240, height: 240, zIndex: 35 },
  disclaimer: { x: 80, y: 1780, width: 920, height: 86, zIndex: 30 },
};

const moduleNames: Record<SceneModuleId, string> = {
  background: '直播背景', effects: '画面特效', status: '直播状态', 'current-viewer': '当前用户 · 问题 · 卦名',
  'gift-alert': '礼物窗口', avatar: '播报画面（视频 / 数字人）', queue: '资格与排队名单', lux3d: '玄金罗盘',
  hexagram: '卦象与当前测算', subtitles: '口播字幕', 'gift-ranking': '礼物榜',
  'engagement-ranking': '互动榜', sticker: '自定义贴纸', disclaimer: '免责声明',
};

export function createDefaultSceneComposition(profile?: Pick<SceneProfile, 'sources'>): SceneComposition {
  const layers: SceneLayer[] = sceneModuleIds.map((moduleId) => {
    const layout = defaultCompositionLayout[moduleId];
    const source = moduleId === 'lux3d' ? undefined : profile?.sources[moduleId];
    const defaultVisible = !['gift-ranking', 'engagement-ranking', 'sticker'].includes(moduleId);
    return {
      id: `module-${moduleId}`,
      kind: 'MODULE' as const,
      moduleId,
      name: moduleNames[moduleId],
      transform: { x: layout.x, y: layout.y, width: layout.width, height: layout.height, rotation: 0 },
      visible: source?.enabled ?? defaultVisible,
      locked: moduleId === 'background' || moduleId === 'effects',
      opacity: 1,
      zIndex: layout.zIndex,
    };
  });
  return normalizeSceneLayerOrder({ width: 1080, height: 1920, layers });
}

/** Keep every layer on a deterministic, unique plane. Array order breaks old z-index ties. */
export function normalizeSceneLayerOrder(composition: SceneComposition): SceneComposition {
  const ordered = composition.layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => a.layer.zIndex - b.layer.zIndex || a.index - b.index);
  const zIndexById = new Map(ordered.map(({ layer }, index) => [layer.id, index * 10]));
  return { ...composition, layers: composition.layers.map((layer) => ({ ...layer, zIndex: zIndexById.get(layer.id) ?? layer.zIndex })) };
}

/** Idempotently promotes legacy preview boxes/elements into the authoritative composition. */
export function migrateSceneComposition(profile: SceneProfile): SceneProfile {
  const normalizedProfile = structuredClone(profile);
  for (const [sourceId, source] of Object.entries(normalizedProfile.sources)) {
    if (!['background', 'sticker'].includes(sourceId) && source.backgroundAssetId && !source.decorationAssetId) {
      source.decorationAssetId = source.backgroundAssetId;
      source.backgroundAssetId = undefined;
    }
    if (source.contentOnly === undefined && source.backgroundMode === 'TRANSPARENT' && source.borderless) source.contentOnly = true;
    if (sourceId === 'gift-alert' && !source.giftOffers?.length && source.selectedGiftId) {
      source.giftOffers = [{
        id: `gift-offer-${source.selectedGiftId}`,
        giftId: source.selectedGiftId,
        giftName: source.selectedGiftName ?? source.selectedGiftId,
        coins: source.selectedGiftCoins,
        speechTargetSeconds: source.selectedGiftSpeechSeconds ?? 30,
        message: source.giftMessage ?? source.idleText,
      }];
    }
  }
  for (const layer of normalizedProfile.composition?.layers ?? []) {
    if (layer.kind === 'MODULE' && moduleNames[layer.moduleId]) layer.name = moduleNames[layer.moduleId];
  }
  if (normalizedProfile.composition?.width === 1080 && normalizedProfile.composition.height === 1920 && Array.isArray(normalizedProfile.composition.layers)) {
    normalizedProfile.composition = normalizeSceneLayerOrder(normalizedProfile.composition);
    return normalizedProfile;
  }
  const composition = createDefaultSceneComposition(normalizedProfile);
  for (const layer of composition.layers) {
    if (layer.kind !== 'MODULE' || layer.moduleId === 'lux3d') continue;
    const legacy = normalizedProfile.canvasPreviewLayout?.[layer.moduleId];
    if (legacy) layer.transform = { ...legacy, rotation: 0 };
  }
  const legacyLayers: SceneLayer[] = (normalizedProfile.elements ?? []).map((element, index) => {
    const hiddenExample = element.text === '双击右侧属性面板编辑文字' || element.text === '今日卦象 · 大吉';
    const base = {
      id: element.id,
      name: hiddenExample ? `示例文字 ${index + 1}` : element.kind === 'text' ? `文字 ${index + 1}` : `素材 ${index + 1}`,
      transform: { x: element.x, y: element.y, width: element.width, height: element.height, rotation: element.rotation ?? 0 },
      visible: !hiddenExample,
      locked: false,
      opacity: element.opacity ?? 1,
      zIndex: element.zIndex ?? 50 + index,
    };
    return element.kind === 'text'
      ? { ...base, kind: 'TEXT' as const, text: hiddenExample ? '等待下一位有缘人' : element.text ?? '', fontSize: element.fontSize ?? 36, color: element.color ?? '#fff5d6', align: 'CENTER' as const }
      : { ...base, kind: 'ASSET' as const, assetId: element.assetId, fit: 'CONTAIN' as const };
  });
  return { ...normalizedProfile, composition: normalizeSceneLayerOrder({ ...composition, layers: [...composition.layers, ...legacyLayers] }) };
}

const avatarActions: AvatarActionName[] = [
  'IDLE', 'QUESTION_RECEIVED', 'CASTING', 'THINKING', 'SPEAKING_NEUTRAL',
  'SPEAKING_EMPHASIS', 'THANK_GIFT', 'FINISH', 'ERROR_RECOVER',
];

export function createDefaultAvatarProfile(): MediaAvatarProfile {
  const slots = Object.fromEntries(avatarActions.map((action) => [action, {
    action,
    mode: 'STATIC_FALLBACK' as const,
    chromaColor: '#00ff00',
    playback: action === 'IDLE' || action.startsWith('SPEAKING') ? 'LOOP' as const : 'ONCE' as const,
    minDurationMs: 500,
    maxDurationMs: action.startsWith('SPEAKING') ? 120_000 : 8_000,
    transitionInMs: 180,
    transitionOutMs: 180,
    fallbackAction: action === 'IDLE' ? 'IDLE' as const : 'IDLE' as const,
  }])) as MediaAvatarProfile['slots'];
  return { slots };
}

export function createDefaultSceneProfile(settings: AppSettings): SceneProfile {
  const oldAliases: Partial<Record<ObsSourceId, keyof AppSettings['overlay']['modules']>> = {
    status: 'status',
    'current-viewer': 'current',
    hexagram: 'hexagram',
    subtitles: 'subtitles',
    queue: 'queue',
    'gift-alert': 'gift',
    disclaimer: 'disclaimer',
    audio: 'audio',
  };
  const sources = Object.fromEntries((Object.keys(sourceLayout) as ObsSourceId[]).map((sourceId) => {
    const layout = sourceLayout[sourceId];
    const old = oldAliases[sourceId] ? settings.overlay.modules[oldAliases[sourceId]!] : undefined;
    const fullScreenComposition = sourceId === 'background' || sourceId === 'meihua-stage' || sourceId === 'full-preview';
    return [sourceId, {
      sourceId,
      enabled: sourceId === 'audio' || sourceId === 'current-viewer' ? false : old?.enabled ?? sourceId !== 'background',
      width: old?.width ?? layout.width,
      height: old?.height ?? layout.height,
      fontScale: old?.fontScale ?? 1,
      backgroundOpacity: old?.backgroundOpacity ?? (fullScreenComposition ? 1 : 0.82),
      backgroundMode: fullScreenComposition ? 'SOLID' : sourceId === 'audio' ? 'TRANSPARENT' : 'CHROMA',
      borderless: !fullScreenComposition,
      contentOnly: !fullScreenComposition,
      chromaColor: '#00ff00',
      maxItems: old?.maxItems ?? layout.maxItems,
      idleBehavior: old?.idleBehavior ?? layout.idleBehavior,
      titleText: old?.titleText ?? layout.titleText,
      idleText: old?.idleText ?? layout.idleText,
      showTitle: old?.showTitle ?? layout.showTitle,
      textColor: old?.textColor ?? '#fff5d6',
      backgroundColor: old?.backgroundColor ?? '#0d0d11',
      accentColor: old?.accentColor ?? settings.overlay.effects.accentColor,
      brightness: old?.brightness ?? 1,
      glowIntensity: old?.glowIntensity ?? settings.overlay.effects.glowIntensity,
      animationStyle: old?.animationStyle ?? settings.overlay.effects.animationStyle,
      contentTemplate: '',
      selectedGiftId: sourceId === 'gift-alert' ? settings.gifts.rules.find((rule) => rule.enabled)?.giftId : undefined,
      selectedGiftName: sourceId === 'gift-alert' ? settings.gifts.rules.find((rule) => rule.enabled)?.giftName : undefined,
      selectedGiftSpeechSeconds: sourceId === 'gift-alert' ? settings.gifts.rules.find((rule) => rule.enabled)?.speechTargetSeconds : undefined,
      giftMessage: sourceId === 'gift-alert' ? '100 likes or 4 Roses unlock a reading. Then ask one clear question.' : undefined,
      giftOffers: sourceId === 'gift-alert' ? settings.gifts.rules.filter((rule) => rule.enabled && rule.giftId).slice(0, 2).map((rule) => ({ id: `gift-offer-${rule.giftId}`, giftId: rule.giftId!, giftName: rule.giftName, speechTargetSeconds: rule.speechTargetSeconds, message: `${rule.minRepeatCount}× ${rule.giftName} · ${rule.speechTargetSeconds}-second reading` })) : undefined,
    } satisfies ObsSourceConfig];
  })) as Record<ObsSourceId, ObsSourceConfig>;
  const profile: SceneProfile = {
    profileId: 'main',
    name: '默认直播场景',
    // Live-facing copy is English-first; the admin application remains localized.
    contentLanguage: 'en',
    disclaimer: settings.overlay.disclaimer,
    effects: settings.overlay.effects,
    sources,
    avatar: createDefaultAvatarProfile(),
  };
  profile.composition = createDefaultSceneComposition(profile);
  return profile;
}

function splitSentences(parts: string[], maxCharacters: number): string[] {
  const result: string[] = [];
  for (const part of parts) {
    const normalized = part.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const sentences = normalized.match(/[^.!?。！？；;：:]+[.!?。！？；;：:]?/gu) ?? [normalized];
    for (const raw of sentences) {
      let sentence = raw.trim();
      while (sentence.length > maxCharacters) {
        let cut = sentence.lastIndexOf(' ', maxCharacters);
        if (cut < Math.floor(maxCharacters * 0.55)) cut = maxCharacters;
        result.push(sentence.slice(0, cut).trim());
        sentence = sentence.slice(cut).trim();
      }
      if (sentence) result.push(sentence);
    }
  }
  return result;
}

function mergeForMinimumDuration(sentences: string[], durationMs: number): string[] {
  const maximumCount = Math.max(1, Math.floor(durationMs / 900));
  if (sentences.length <= maximumCount) return sentences;
  const merged = [...sentences];
  while (merged.length > maximumCount) {
    let shortestIndex = 0;
    for (let index = 1; index < merged.length; index++) {
      if (merged[index].length < merged[shortestIndex].length) shortestIndex = index;
    }
    const target = shortestIndex === merged.length - 1 ? shortestIndex - 1 : shortestIndex;
    merged.splice(target, 2, `${merged[target]} ${merged[target + 1]}`.trim());
  }
  return merged;
}

export function buildSpeechPlan(readingId: string, answer: AnswerContent, wavDurationMs: number): SpeechPlan {
  const totalDurationMs = Math.max(900, Math.round(wavDurationMs));
  const maxCharacters = /[\u3400-\u9fff]/u.test(`${answer.opening}${answer.speech}${answer.closing}`) ? 34 : 76;
  const raw = splitSentences([answer.opening, answer.speech, answer.closing], maxCharacters);
  const sentences = mergeForMinimumDuration(raw.length ? raw : [answer.speech], totalDurationMs);
  const punctuationWeight = (text: string) => /[.!?。！？]$/u.test(text) ? 7 : /[;；:：]$/u.test(text) ? 4 : 1;
  const weights = sentences.map((text) => Math.max(1, text.length) + punctuationWeight(text));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const minimumTotal = sentences.length * 900;
  const flexible = Math.max(0, totalDurationMs - minimumTotal);
  let offsetMs = 0;
  const segments = sentences.map((text, index) => {
    const isLast = index === sentences.length - 1;
    const durationMs = isLast ? totalDurationMs - offsetMs : 900 + Math.floor(flexible * weights[index] / weightTotal);
    const keyword = answer.keywords.find((item) => text.toLocaleLowerCase().includes(item.toLocaleLowerCase()));
    const emphasis = Boolean(keyword) || /(?:important|key|注意|关键|重点)/iu.test(text);
    const avatarAction: AvatarActionName = emphasis ? 'SPEAKING_EMPHASIS' : 'SPEAKING_NEUTRAL';
    const segment = {
      segmentId: `${readingId}-segment-${index + 1}`,
      text,
      offsetMs,
      durationMs,
      avatarAction,
      emphasis,
      hexagramFocus: index < Math.max(1, Math.ceil(sentences.length / 3))
        ? 'PRIMARY' as const
        : index < Math.max(2, Math.ceil(sentences.length * 2 / 3))
          ? 'MUTUAL' as const
          : 'CHANGED' as const,
      keywords: keyword ? [keyword] : [],
    };
    offsetMs += durationMs;
    return segment;
  });
  return { readingId, totalDurationMs, segments, createdAt: Date.now(), revision: 1 };
}

/** V7: default config for the custom sticker source (additive, idempotent migration). */
export function createDefaultStickerSourceConfig(): ObsSourceConfig {
  const layout = sourceLayout['sticker'];
  return {
    sourceId: 'sticker',
    enabled: true,
    width: layout.width,
    height: layout.height,
    fontScale: 1,
    backgroundOpacity: 1,
    backgroundMode: 'TRANSPARENT',
    borderless: false,
    chromaColor: '#00ff00',
    maxItems: 1,
    idleBehavior: 'PREVIEW',
    titleText: '',
    idleText: '',
    showTitle: false,
    textColor: '#fff5d6',
    backgroundColor: '#0d0d11',
    accentColor: '#e9b86e',
    brightness: 1,
    glowIntensity: 0.4,
    animationStyle: 'smooth',
    contentTemplate: '',
  };
}

/**
 * Default config for the official integrated stage source. It is injected into
 * persisted scene profiles created before V2.2 (additive, idempotent migration).
 */
export function createDefaultStageSourceConfig(settings: AppSettings): ObsSourceConfig {
  const layout = sourceLayout['meihua-stage'];
  return {
    sourceId: 'meihua-stage',
    enabled: true,
    width: layout.width,
    height: layout.height,
    fontScale: 1,
    backgroundOpacity: 1,
    backgroundMode: 'SOLID',
    borderless: false,
    chromaColor: '#00ff00',
    maxItems: layout.maxItems,
    idleBehavior: 'KEEP_LAST',
    titleText: '',
    idleText: '',
    showTitle: false,
    textColor: '#fff5d6',
    backgroundColor: '#0b0e13',
    accentColor: settings.overlay.effects.accentColor,
    brightness: 1,
    glowIntensity: settings.overlay.effects.glowIntensity,
    animationStyle: settings.overlay.effects.animationStyle,
    contentTemplate: '',
  };
}
