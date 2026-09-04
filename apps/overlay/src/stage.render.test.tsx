import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { BroadcastSnapshotV2, DirectorStage, HexagramLine, ObsSourceConfig, Reading, SceneProfile } from '@meihua/core-types';
import { qualificationLabel, sourceStyle } from './App.js';
import { StageSource } from './stage.js';

/**
 * Server-render smoke test for the V2.2 integrated stage. Each scenario is
 * rendered with the same component the browser source uses; the assertions
 * verify that every state shows real structured content and no placeholder or
 * undefined leakage. Visual layout itself still needs a browser (BROWSER_VERIFIED).
 */

function stageConfig(): ObsSourceConfig {
  return {
    sourceId: 'meihua-stage', enabled: true, width: 1080, height: 1920, fontScale: 1,
    backgroundOpacity: 1, backgroundMode: 'SOLID', borderless: false, chromaColor: '#00ff00',
    maxItems: 6, idleBehavior: 'KEEP_LAST', titleText: '', idleText: 'Waiting for the next viewer',
    showTitle: false, textColor: '#fff5d6', backgroundColor: '#0b0e13', accentColor: '#e9b86e',
    brightness: 1, glowIntensity: 0.65, animationStyle: 'smooth', contentTemplate: '',
  };
}

function profile(): SceneProfile {
  return {
    profileId: 'main', name: 'smoke', contentLanguage: 'en',
    disclaimer: 'Traditional cultural entertainment only.',
    effects: { accentColor: '#e9b86e', backgroundOpacity: 0.82, glowIntensity: 0.65, animationStyle: 'smooth', particles: false },
    sources: { 'meihua-stage': stageConfig() } as SceneProfile['sources'],
    avatar: {
      slots: {
        IDLE: { action: 'IDLE', mode: 'STATIC_FALLBACK', chromaColor: '#00ff00', playback: 'LOOP', minDurationMs: 500, maxDurationMs: 8000, transitionInMs: 180, transitionOutMs: 180, fallbackAction: 'IDLE' },
        QUESTION_RECEIVED: { action: 'QUESTION_RECEIVED', mode: 'STATIC_FALLBACK', chromaColor: '#00ff00', playback: 'ONCE', minDurationMs: 500, maxDurationMs: 8000, transitionInMs: 180, transitionOutMs: 180, fallbackAction: 'IDLE' },
        CASTING: { action: 'CASTING', mode: 'STATIC_FALLBACK', chromaColor: '#00ff00', playback: 'ONCE', minDurationMs: 500, maxDurationMs: 8000, transitionInMs: 180, transitionOutMs: 180, fallbackAction: 'IDLE' },
        THINKING: { action: 'THINKING', mode: 'STATIC_FALLBACK', chromaColor: '#00ff00', playback: 'ONCE', minDurationMs: 500, maxDurationMs: 8000, transitionInMs: 180, transitionOutMs: 180, fallbackAction: 'IDLE' },
        SPEAKING_NEUTRAL: { action: 'SPEAKING_NEUTRAL', mode: 'STATIC_FALLBACK', chromaColor: '#00ff00', playback: 'LOOP', minDurationMs: 500, maxDurationMs: 120000, transitionInMs: 180, transitionOutMs: 180, fallbackAction: 'IDLE' },
        SPEAKING_EMPHASIS: { action: 'SPEAKING_EMPHASIS', mode: 'STATIC_FALLBACK', chromaColor: '#00ff00', playback: 'LOOP', minDurationMs: 500, maxDurationMs: 120000, transitionInMs: 180, transitionOutMs: 180, fallbackAction: 'IDLE' },
        THANK_GIFT: { action: 'THANK_GIFT', mode: 'STATIC_FALLBACK', chromaColor: '#00ff00', playback: 'ONCE', minDurationMs: 500, maxDurationMs: 8000, transitionInMs: 180, transitionOutMs: 180, fallbackAction: 'IDLE' },
        FINISH: { action: 'FINISH', mode: 'STATIC_FALLBACK', chromaColor: '#00ff00', playback: 'ONCE', minDurationMs: 500, maxDurationMs: 8000, transitionInMs: 180, transitionOutMs: 180, fallbackAction: 'IDLE' },
        ERROR_RECOVER: { action: 'ERROR_RECOVER', mode: 'STATIC_FALLBACK', chromaColor: '#00ff00', playback: 'ONCE', minDurationMs: 500, maxDurationMs: 8000, transitionInMs: 180, transitionOutMs: 180, fallbackAction: 'IDLE' },
      },
    },
  };
}

function lines(moving: number) {
  return [1, 2, 3, 4, 5, 6].map((index): HexagramLine => ({ index: index as HexagramLine['index'], yinYang: index % 2 ? 'YANG' : 'YIN', moving: index === moving }));
}

function snapshotFor(stage: DirectorStage, options: { gift?: boolean; queue?: boolean; reading?: boolean; id?: string } = {}): BroadcastSnapshotV2 {
  const p = profile();
  const reading: Reading | undefined = options.reading !== false ? {
    id: 'smoke-reading', source: 'manual', createdAt: Date.now() - 60_000,
    username: 'SmokeViewer', rawQuestion: 'Should I move to the city next year?',
    normalizedQuestion: 'Should I move to the city next year?', status: 'SPEAKING', priority: 'HIGH',
      qualification: { kind: 'COMMENT_KEYWORD', ruleId: 'r1', label: 'Keyword comment' },
      answer: { opening: 'The pattern begins with patience.', speech: 'Keep the next step small and deliberate.', keywords: ['patience'], closing: 'Return when the path is clearer.', estimatedSeconds: 20 },
      pipeline: {
        readingId: 'smoke-reading', phase: 'SPEAKING', phaseLabel: '统一播报中', progress: 94,
        attempt: 1, maxAttempts: 3, stageStartedAt: Date.now() - 1000, updatedAt: Date.now(),
        artifacts: { hexagram: true, script: true, audio: true, lipSync: true, avatar: true },
      },
      meihua: {
      primary: { name: 'Water over Thunder', number: 3, upperTrigram: 'Kan', lowerTrigram: 'Zhen', lines: lines(3) },
      mutual: { name: 'Mountain over Fire', number: 22, upperTrigram: 'Gen', lowerTrigram: 'Li', lines: lines(0) },
      changed: { name: 'Water over Wind', number: 48, upperTrigram: 'Kan', lowerTrigram: 'Xun', lines: lines(0) },
      movingLines: [3], bodyTrigram: 'Kan', useTrigram: 'Zhen', interpretationFacts: [], engineVersion: 'smoke',
    },
  } : undefined;
  const sideCues = options.gift ? [{
    cueId: 'gift-1', sessionId: 's1', sequence: 9, stage: 'QUALIFIED' as const, track: 'GIFT' as const,
    startsAt: Date.now() - 500, endsAt: Date.now() + 5500, revision: 1,
    payload: { username: 'GiftViewer', giftName: 'Rose', action: 'APPLIED_TO_QUEUE', speechTargetSeconds: 40 }, createdAt: Date.now() - 500,
  }] : [];
  const qualificationQueue = options.queue ? [
    { id: 'q1', username: 'NextViewer', eventSource: 'MOCK' as const, source: 'GIFT' as const, status: 'QUEUED' as const, label: 'Rose', giftName: 'Rose', question: 'Should I move forward with this plan?', position: 1, priority: 'HIGH' as const, speechTargetSeconds: 30, createdAt: Date.now() - 42000 },
    { id: 'q2', username: 'GiftViewer', eventSource: 'MOCK' as const, source: 'GIFT' as const, status: 'WAITING_QUESTION' as const, label: 'Rose', giftName: 'Rose', speechTargetSeconds: 30, createdAt: Date.now() - 12000 },
  ] : [];
  return {
    protocolVersion: 2, sequence: 10, serverTime: Date.now(), stage,
    session: { sessionId: 's1', mode: 'REHEARSAL', status: 'LIVE', profileVersionId: 'v1', lastHeartbeatAt: Date.now() },
    activeCue: reading ? { cueId: 'cue-1', sessionId: 's1', sequence: 5, stage, track: 'MAIN', startsAt: Date.now() - 1000, revision: 1, payload: {}, createdAt: Date.now() - 1000 } : undefined,
    sideCues,
    reading,
    queue: [],
    qualificationQueue,
    giftRanking: [], engagementRanking: [], mediaAssets: [],
    profileVersion: { versionId: 'v1', profileId: 'main', version: 1, status: 'PUBLISHED', profile: p, createdAt: Date.now() },
    acceptingEvents: true, avatarRuntime: 'NONE',
  };
}

describe('integrated stage server render', () => {
  const scenarios: Array<[string, DirectorStage, { gift?: boolean; queue?: boolean; reading?: boolean }]> = [
    ['IDLE', 'IDLE', { reading: false }],
    ['CASTING', 'CASTING', {}],
    ['SPEAKING', 'SPEAKING', {}],
    ['GIFT', 'QUALIFIED', { gift: true, queue: true }],
    ['QUEUE', 'QUALIFIED', { queue: true, reading: false }],
    ['ERROR', 'ERROR', {}],
  ];
  for (const [name, stage, options] of scenarios) {
    it(`${name} renders structured content without placeholders`, () => {
      const html = renderToString(<StageSource snapshot={snapshotFor(stage, { ...options })} />);
      // React server rendering inserts <!-- --> comment markers between text
      // nodes; strip them so text-level assertions match the visible content.
      const text = html.replace(/<!--.*?-->/g, '');
      expect(html.length).toBeGreaterThan(400);
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('NaN');
      // disclaimer always present
      expect(text).toContain('Traditional cultural entertainment only.');
      // queue title and resident queue rendering
      expect(text).toContain('WAITING LIST');
      if (stage === 'IDLE' || (stage === 'QUALIFIED' && !options.queue)) expect(text).toContain('Waiting');
      if (options.reading !== false) {
        expect(text).toContain('@SmokeViewer');
        expect(text).toContain('Should I move to the city next year?');
        // Viewer, question and hexagram name are rendered once above. The
        // lower compass area contains only one uncluttered primary cast.
        expect((text.match(/class="hex-lines"/g) ?? [])).toHaveLength(1);
        expect(text).not.toContain('MUTUAL');
        expect(text).not.toContain('CHANGED');
        expect(text).not.toContain('Moving line');
        expect(text).not.toContain('Hexagram 22');
        expect(text).not.toContain('Hexagram 48');
        // The spoken script remains in the admin monitor/audio bus. It is
        // intentionally not burned into the OBS stage, which prevents tiny
        // duplicate text from competing with the visual reading.
        expect(text).not.toContain('The pattern begins with patience.');
        expect(text).not.toContain('Keep the next step small and deliberate.');
        expect(text).not.toContain('统一播报中');
        expect(text).not.toContain('stage-reading-script');
      }
      if (options.gift) {
        expect(text).toContain('@GiftViewer');
        expect(text).not.toContain('Rose');
        expect(text).toContain('Priority updated in the waiting list');
      }
      if (options.queue) {
        expect(text).toContain('@NextViewer');
        expect(text).toContain('@GiftViewer');
        expect(text).toContain('TO BE ASKED');
        expect(text).toContain('<strong>@GiftViewer</strong><b>TO BE ASKED</b>');
        expect(text).not.toContain('礼物资格');
        expect(text).toContain('QUEUED');
      }
    });
  }

  it('renders the locked prerecorded presentation without exposing a second audio source', () => {
    const snapshot = snapshotFor('SPEAKING');
    snapshot.presentationMode = 'VIDEO_ONCE';
    snapshot.presentationMedia = { kind: 'VIDEO_URL', url: '/api/media-assets/video-1/content', muted: true, playback: 'ONCE', fit: 'CONTAIN' };
    const html = renderToString(<StageSource snapshot={snapshot} />);
    expect(html).toContain('/api/media-assets/video-1/content');
    expect(html).toContain('muted');
    expect(html).not.toContain('<audio');
  });

  it('does not render a person layer in audio-only mode', () => {
    const snapshot = snapshotFor('SPEAKING');
    snapshot.presentationMode = 'AUDIO_ONLY';
    snapshot.presentationMedia = undefined;
    const html = renderToString(<StageSource snapshot={snapshot} />);
    expect(html).not.toContain('stage-person media');
    expect(html).not.toContain('stage-person-empty');
    expect(html).not.toContain('media-assets/video');
  });
});

describe('background mode semantics (一键透明/一键绿幕)', () => {
  it('transparent mode strips panels, borders and glow', () => {
    const style = sourceStyle({ ...stageConfig(), backgroundMode: 'TRANSPARENT' }) as Record<string, string | number | undefined>;
    expect(style['--panel']).toBe('transparent');
    expect(style['--source-bg']).toBe('transparent');
    expect(style['--panel-line']).toBe('transparent');
    expect(style['--glow']).toBe('0px');
    expect(style['--brightness']).toBe(1);
  });

  it('legacy chroma values render as transparent (绿幕已退役)', () => {
    const style = sourceStyle({ ...stageConfig(), backgroundMode: 'CHROMA', chromaColor: '#00ff00' }) as Record<string, string | number | undefined>;
    expect(style['--panel']).toBe('transparent');
    expect(style['--source-bg']).toBe('transparent');
    expect(style['--panel-line']).toBe('transparent');
  });

  it('solid mode keeps panel fill and border line', () => {
    const style = sourceStyle({ ...stageConfig(), backgroundMode: 'SOLID', backgroundColor: '#0b0e13' }) as Record<string, string | number | undefined>;
    expect(style['--panel']).toMatch(/^rgba\(/);
    expect(style['--source-bg']).toBe('#0b0e13');
    expect(style['--panel-line']).toContain('color-mix');
  });

  it('stage root defaults to transparent and honors explicit solid', () => {
    // 未显式配置 → 透明（新默认，OBS 直接透出）
    const defSnap = snapshotFor('IDLE', { reading: false });
    const bareStage: ObsSourceConfig = { ...stageConfig(), backgroundMode: undefined };
    defSnap.profileVersion.profile.sources['meihua-stage'] = bareStage;
    const defHtml = renderToString(<StageSource snapshot={defSnap} />);
    expect(defHtml).toContain('background-transparent');
    // 历史绿幕值同样按透明呈现
    const chromaSnap = snapshotFor('IDLE', { reading: false });
    chromaSnap.profileVersion.profile.sources['meihua-stage'] = { ...stageConfig(), backgroundMode: 'CHROMA', chromaColor: '#00ff00' };
    expect(renderToString(<StageSource snapshot={chromaSnap} />)).toContain('background-transparent');
    // 显式 SOLID 仍然生效
    const snap = snapshotFor('IDLE', { reading: false });
    snap.profileVersion.profile.sources['meihua-stage'] = { ...stageConfig(), backgroundMode: 'SOLID', backgroundColor: '#0b0e13' };
    expect(renderToString(<StageSource snapshot={snap} />)).toContain('background-solid');
  });
});

describe('qualification display copy', () => {
  it('keeps live-facing qualification copy English and hides gift names', () => {
    expect(qualificationLabel('LIKE', 'liked 100x')).toBe('100 LIKES');
    expect(qualificationLabel('GIFT', 'Rose', '玫瑰')).toBe('GIFT PRIORITY');
    expect(qualificationLabel('MANUAL', 'manual')).toBe('MANUALLY ADDED');
  });
});
