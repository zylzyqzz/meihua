import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistence } from '@meihua/persistence';
import { LiveRuntime, splitDigitalHumanSentences } from './runtime.js';

const runtimes: LiveRuntime[] = [];
afterEach(() => { while (runtimes.length) runtimes.pop()?.close(); });

function createRuntime() {
  const runtime = new LiveRuntime(new SqlitePersistence(':memory:'));
  runtimes.push(runtime);
  return runtime;
}

describe('digital human sentence prebuffering', () => {
  it('splits English and Chinese speech deterministically and keeps short tails attached', () => {
    expect(splitDigitalHumanSentences('Welcome. Your reading is ready! 请稍候。现在开始起卦。')).toEqual([
      'Welcome. Your reading is ready!',
      '请稍候。 现在开始起卦。',
    ]);
    expect(splitDigitalHumanSentences('A'.repeat(450))).toHaveLength(3);
    expect(splitDigitalHumanSentences('   ')).toEqual([]);
  });
});

describe('LiveRuntime intake controls', () => {
  it('enforces dedupe, intake pause, blacklist, and external-provider readiness', async () => {
    const runtime = createRuntime();
    const now = Date.now();
    const base = { source: 'mock' as const, username: 'Viewer', message: 'Is it suitable to change my job?', timestamp: now, raw: {} };
    const first = await runtime.ingest({ ...base, eventId: 'one' });
    const duplicate = await runtime.ingest({ ...base, eventId: 'two', timestamp: now + 1 });
    runtime.setAcceptingQuestions(false);
    const paused = await runtime.ingest({ ...base, eventId: 'three', username: 'Other', timestamp: now + 2 });
    runtime.setAcceptingQuestions(true);
    runtime.blockUser({ userKey: 'blocked', username: 'Blocked', reason: 'test' });
    const blocked = await runtime.ingest({ ...base, eventId: 'four', username: 'Blocked', timestamp: now + 3 });
    runtime.updateSettings({ providers: { tts: { adapter: 'external' } } });

    expect(first.status).toBe('QUEUED');
    expect(duplicate.moderationReason).toBe('duplicate_within_window');
    expect(paused.moderationReason).toBe('intake_paused');
    expect(blocked.moderationReason).toBe('blocked_user');
    expect(runtime.resume()).toMatchObject({ ok: false });
  });

  it('keeps a qualifying gift pending and applies it to the viewer next question', async () => {
    const runtime = createRuntime();
    const gift = await runtime.ingestGift({
      source: 'mock', eventId: 'gift-before-question', userId: 'viewer-1', username: 'GiftViewer',
      giftId: '5655', giftName: 'Rose', repeatCount: 4, timestamp: Date.now(), raw: {},
    });
    const waiting = runtime.getQueueOverview();
    const reading = await runtime.ingest({
      source: 'mock', eventId: 'question-after-gift', userId: 'viewer-1', username: 'GiftViewer',
      message: 'Should I move forward with this plan?', timestamp: Date.now() + 1, raw: {},
    });

    expect(gift.action).toBe('PENDING_QUESTION');
    expect(waiting).toEqual([expect.objectContaining({ username: 'GiftViewer', status: 'WAITING_QUESTION', giftName: 'Rose' })]);
    expect(reading).toMatchObject({ status: 'QUEUED', priority: 'HIGH', speechTargetSeconds: 30, expiresAt: undefined });
    expect(reading.gift).toMatchObject({ giftName: 'Rose', ruleId: 'rose-four-reading' });
    expect(runtime.getGiftEntitlements()[0]).toMatchObject({ status: 'APPLIED', readingId: reading.id });
    expect(runtime.getQueueOverview()).toEqual([expect.objectContaining({ username: 'GiftViewer', status: 'QUEUED', question: 'Should I move forward with this plan?', position: 1 })]);
  });

  it('requires the full four-Rose streak before granting a reading', async () => {
    const runtime = createRuntime();
    const partial = await runtime.ingestGift({
      source: 'mock', eventId: 'three-roses', userId: 'viewer-partial', username: 'PartialViewer',
      giftId: '5655', giftName: 'Rose', repeatCount: 3, repeatEnd: true, timestamp: Date.now(), raw: {},
    });
    expect(partial.action).toBe('IGNORED');
    expect(runtime.getGiftEntitlements()).toHaveLength(0);
    expect(runtime.getQueueOverview()).toHaveLength(0);
  });

  it('keeps a gifted viewer pending through chatter and binds the next clear question', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    const gift = await runtime.ingestGift({
      source: 'tikfinity', eventId: 'real-gift-first', userId: 'viewer-gift', username: 'GiftViewer',
      giftId: '5655', giftName: 'Rose', repeatCount: 4, timestamp: Date.now(), raw: {},
    });
    const chatter = await runtime.ingestTikfinityChat({
      source: 'tikfinity', eventId: 'gift-chatter', userId: 'viewer-gift', username: 'GiftViewer',
      message: 'hello everyone', timestamp: Date.now() + 1, raw: {},
    });
    const reading = await runtime.ingestTikfinityChat({
      source: 'tikfinity', eventId: 'gift-question', userId: 'viewer-gift', username: 'GiftViewer',
      message: 'Should I move forward with this plan', timestamp: Date.now() + 2, raw: {},
    });

    expect(gift.action).toBe('PENDING_QUESTION');
    expect(chatter).toBeUndefined();
    expect(reading).toMatchObject({ status: 'QUEUED', priority: 'HIGH', speechTargetSeconds: 30, expiresAt: undefined });
    expect(runtime.getGiftEntitlements()[0]).toMatchObject({ status: 'APPLIED', readingId: reading?.id });
  });

  it('promotes an existing queued reading immediately when a matching gift arrives', async () => {
    const runtime = createRuntime();
    const reading = await runtime.ingest({
      source: 'mock', eventId: 'queued-question', username: 'VIPViewer',
      message: 'Should I continue preparing for the exam?', timestamp: Date.now(), raw: {},
    });
    const result = await runtime.ingestGift({
      source: 'mock', eventId: 'gift-after-question', username: 'VIPViewer',
      giftId: '5655', giftName: 'Rose', repeatCount: 4, timestamp: Date.now() + 1, raw: {},
    });

    expect(result).toMatchObject({ action: 'APPLIED_TO_QUEUE', readingId: reading.id });
    expect(runtime.getReading(reading.id)).toMatchObject({ priority: 'HIGH', speechTargetSeconds: 30, expiresAt: undefined });
    expect(runtime.getQueue()[0]).toMatchObject({ readingId: reading.id, priority: 'HIGH', giftName: 'Rose', speechTargetSeconds: 30, expiresAt: undefined });
  });

  it('treats source events as idempotent', async () => {
    const runtime = createRuntime();
    const event = { source: 'mock' as const, eventId: 'same-source-event', username: 'Viewer', message: '现在适合推进这个计划吗？', timestamp: Date.now(), raw: {} };
    const first = await runtime.ingest(event);
    const duplicate = await runtime.ingest(event);
    expect(duplicate.id).toBe(first.id);
    expect(runtime.getQueue()).toHaveLength(1);

    const giftEvent = { source: 'mock' as const, eventId: 'same-gift-event', username: 'GiftViewer', giftId: '5655', giftName: 'Rose', repeatCount: 4, timestamp: Date.now(), raw: {} };
    const gift = await runtime.ingestGift(giftEvent);
    const duplicateGift = await runtime.ingestGift(giftEvent);
    expect(duplicateGift.entitlement?.id).toBe(gift.entitlement?.id);
    expect(runtime.getGiftEntitlements().filter((item) => item.sourceEventId === giftEvent.eventId)).toHaveLength(1);
  });

  it('accepts a 100-event burst without crossing the configured queue limit', async () => {
    const runtime = createRuntime();
    runtime.updateSettings({ queue: { maxTotal: 100, sameUserCooldownMinutes: 0 } });
    const now = Date.now();
    const readings = await Promise.all(Array.from({ length: 100 }, (_, index) => runtime.ingest({
      source: 'mock', eventId: `burst-${index}`, userId: `viewer-${index}`, username: `观众${index}🌸`,
      message: `现在是否适合推进第${index}个计划？`, timestamp: now + index, raw: {},
    })));
    expect(readings.every((reading) => reading.status === 'QUEUED')).toBe(true);
    expect(runtime.getQueue()).toHaveLength(100);
    const overflow = await runtime.ingest({ source: 'mock', eventId: 'burst-overflow', username: '额外观众', message: '现在是否适合推进额外计划？', timestamp: now + 101, raw: {} });
    expect(overflow).toMatchObject({ status: 'SKIPPED', errorCode: 'QUEUE_FULL' });
    expect(runtime.getQueue()).toHaveLength(100);
  });

  it('grants one free reading after the configured like threshold', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    const grant = await runtime.ingestLike({ source: 'tikfinity', eventId: 'like-1', userId: 'liked-user', username: 'LikedViewer', likeCount: 100, timestamp: Date.now(), raw: {} });
    const reading = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-after-like', userId: 'liked-user', username: 'LikedViewer', message: 'Should I take this opportunity now?', timestamp: Date.now() + 1, raw: {} });
    expect(grant.granted).toBe(true);
    expect(reading).toMatchObject({ status: 'QUEUED', qualification: { kind: 'LIKE', ruleId: 'likes-100' } });
  });

  it('accepts configured topic keywords as questions after the viewer is qualified', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();

    await runtime.ingestLike({ source: 'tikfinity', eventId: 'like-career', userId: 'keyword-career', username: 'CareerViewer', likeCount: 100, timestamp: Date.now(), raw: {} });
    const career = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-career', userId: 'keyword-career', username: 'CareerViewer', message: 'career', timestamp: Date.now() + 1, raw: {} });

    await runtime.ingestLike({ source: 'tikfinity', eventId: 'like-cn', userId: 'keyword-cn', username: 'ChineseViewer', likeCount: 100, timestamp: Date.now() + 2, raw: {} });
    const chinese = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-cn', userId: 'keyword-cn', username: 'ChineseViewer', message: '帮我测一下财运', timestamp: Date.now() + 3, raw: {} });

    await runtime.ingestLike({ source: 'tikfinity', eventId: 'like-reading', userId: 'keyword-reading', username: 'ReadingViewer', likeCount: 100, timestamp: Date.now() + 4, raw: {} });
    const reading = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-reading', userId: 'keyword-reading', username: 'ReadingViewer', message: 'reading', timestamp: Date.now() + 5, raw: {} });

    expect(career).toMatchObject({ status: 'QUEUED', rawQuestion: 'career', normalizedQuestion: 'career?' });
    expect(chinese).toMatchObject({ status: 'QUEUED', rawQuestion: '帮我测一下财运', normalizedQuestion: '帮我测一下财运?' });
    expect(reading).toMatchObject({
      status: 'QUEUED',
      rawQuestion: 'reading',
      normalizedQuestion: 'What is the most important guidance for my current overall situation?',
    });
  });

  it.each([
    ['english', "I'd like to know whether my new job will work out"],
    ['spanish', 'Quisiera saber si encontraré un trabajo mejor'],
    ['french', "J’aimerais savoir si cette relation va durer"],
    ['german', 'Habe ich mit diesem Projekt Erfolg'],
    ['japanese', 'この仕事を続けるべきかな'],
    ['korean', '이 관계가 앞으로 어떻게 될까요'],
    ['portuguese', 'Gostaria de saber se devo mudar de trabalho'],
    ['russian', 'Можно ли мне сейчас менять работу'],
  ])('queues a qualified %s question without requiring English punctuation', async (language, message) => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    const userId = `multilingual-${language}`;
    await runtime.ingestLike({ source: 'tikfinity', eventId: `like-${language}`, userId, username: language, likeCount: 100, timestamp: Date.now(), raw: {} });
    const reading = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: `chat-${language}`, userId, username: language, message, timestamp: Date.now() + 1, raw: {} });
    expect(reading).toMatchObject({ status: 'QUEUED', rawQuestion: message });
  });

  it.each([
    ['english-love', 'I love your voice'],
    ['english-work', 'Nice work everyone'],
    ['spanish', 'amor para todos'],
    ['japanese', '仕事が好きです'],
    ['korean', '연애 노래 좋아요'],
  ])('keeps a qualified viewer pending after multilingual chatter: %s', async (name, message) => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    await runtime.ingestLike({ source: 'tikfinity', eventId: `like-chat-${name}`, userId: name, username: name, likeCount: 100, timestamp: Date.now(), raw: {} });
    const reading = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: `chat-noise-${name}`, userId: name, username: name, message, timestamp: Date.now() + 1, raw: {} });
    expect(reading).toBeUndefined();
    expect(runtime.getPendingQualifications()).toEqual(expect.arrayContaining([expect.objectContaining({ username: name, kind: 'LIKE' })]));
    expect(runtime.getQueue()).toHaveLength(0);
  });

  it('does not let keyword recognition bypass empty or advertising safety checks', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();

    await runtime.ingestLike({ source: 'tikfinity', eventId: 'like-symbol', userId: 'symbol-user', username: 'SymbolViewer', likeCount: 100, timestamp: Date.now(), raw: {} });
    const symbol = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-symbol', userId: 'symbol-user', username: 'SymbolViewer', message: '?', timestamp: Date.now() + 1, raw: {} });

    await runtime.ingestLike({ source: 'tikfinity', eventId: 'like-ad', userId: 'ad-user', username: 'AdViewer', likeCount: 100, timestamp: Date.now() + 2, raw: {} });
    const advertising = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-ad', userId: 'ad-user', username: 'AdViewer', message: 'career https://spam.example', timestamp: Date.now() + 3, raw: {} });

    expect(symbol).toBeUndefined();
    expect(advertising).toBeUndefined();
    expect(runtime.getPendingQualifications()).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: 'SymbolViewer', kind: 'LIKE' }),
      expect.objectContaining({ username: 'AdViewer', kind: 'LIKE' }),
    ]));
    expect(runtime.getQueue()).toHaveLength(0);
  });

  it('requires a like or gift entitlement before a clear comment can enter the queue', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    const ignored = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-ignore', username: 'ViewerA', message: 'hello everyone', timestamp: Date.now(), raw: {} });
    const accepted = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-match', username: 'ViewerB', message: 'reading: Is a job change suitable?', timestamp: Date.now() + 1, raw: {} });
    expect(ignored).toBeUndefined();
    expect(accepted).toBeUndefined();
    expect(runtime.getQueue()).toHaveLength(0);
  });

  it('does not create qualification from a keyword-only comment', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    const keyword = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'keyword-only', userId: 'keyword-user', username: 'KeywordViewer', message: 'reading', timestamp: Date.now(), raw: {} });
    expect(keyword).toBeUndefined();
    expect(runtime.getPendingQualifications()).toHaveLength(0);
    const reading = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'question-after-keyword', userId: 'keyword-user', username: 'KeywordViewer', message: 'Can I change jobs this year', timestamp: Date.now() + 1, raw: {} });
    expect(reading).toBeUndefined();
    expect(runtime.getPendingQualifications()).toHaveLength(0);
  });
});

describe('operational data recalculation', () => {
  it('rebuilds queue and rankings from durable session records without deleting source data', () => {
    const persistence = new SqlitePersistence(':memory:');
    const now = Date.now();
    persistence.saveLiveSession({
      sessionId: 'recalc-session', mode: 'LIVE', status: 'ENDED', profileVersionId: 'profile-v1',
      startedAt: now - 1_000, endedAt: now, lastHeartbeatAt: now,
    });
    persistence.saveReading({
      id: 'queued-reading', sessionId: 'recalc-session', sourceEventId: 'chat-1', source: 'tikfinity',
      userId: 'viewer-1', username: 'ViewerOne', rawQuestion: 'Will my new project progress?',
      normalizedQuestion: 'Will my new project progress?', moderationDecision: 'ALLOW',
      status: 'QUEUED', priority: 'NORMAL', createdAt: now - 820, expiresAt: now + 60_000,
    });
    persistence.saveReading({
      id: 'completed-reading', sessionId: 'recalc-session', sourceEventId: 'chat-2', source: 'tikfinity',
      userId: 'viewer-2', username: 'ViewerTwo', rawQuestion: 'Should I make this change?',
      normalizedQuestion: 'Should I make this change?', moderationDecision: 'ALLOW',
      status: 'COMPLETED', priority: 'NORMAL', createdAt: now - 810, completedAt: now - 300,
    });
    const likeInbox = persistence.enqueueLiveEvent({
      source: 'tikfinity', eventId: 'like-1', kind: 'like', receivedAt: now - 850,
      payload: { source: 'tikfinity', eventId: 'like-1', userId: 'viewer-1', username: 'ViewerOne', likeCount: 100, timestamp: now - 850, raw: {} },
    });
    const giftInbox = persistence.enqueueLiveEvent({
      source: 'tikfinity', eventId: 'gift-1', kind: 'gift', receivedAt: now - 840,
      payload: { source: 'tikfinity', eventId: 'gift-1', userId: 'viewer-3', username: 'GiftViewer', giftId: '5655', giftName: 'Rose', repeatCount: 4, timestamp: now - 840, raw: {} },
    });
    persistence.completeLiveEvent(likeInbox!.id);
    persistence.completeLiveEvent(giftInbox!.id);
    persistence.setSessionEngagementStats({ sessionId: 'recalc-session', userKey: 'stale', username: 'Stale', likeCount: 999, validCommentCount: 0, points: 999 });

    const runtime = new LiveRuntime(persistence);
    runtimes.push(runtime);
    const preview = runtime.getOperationalDataRecalculationPreview();
    expect(preview).toMatchObject({
      canApply: true,
      applied: false,
      scanned: { liveEvents: 2, likes: 1, gifts: 1, readings: 2 },
      rebuilt: { queueItems: 1, engagementUsers: 2, giftUsers: 1 },
      preserved: { rawEvents: 2, completedReadings: 1 },
    });

    const report = runtime.recalculateOperationalData();
    expect(report).toMatchObject({ applied: true, rebuilt: { queueItems: 1 } });
    expect(runtime.getQueue()).toEqual([expect.objectContaining({ readingId: 'queued-reading' })]);
    expect(persistence.getSessionEngagementRanking('recalc-session')).not.toEqual(expect.arrayContaining([expect.objectContaining({ userKey: 'stale' })]));
    expect(persistence.getSessionEngagementRanking('recalc-session')).toEqual(expect.arrayContaining([
      expect.objectContaining({ userKey: 'viewer-1', likeCount: 100, validCommentCount: 1 }),
      expect.objectContaining({ userKey: 'viewer-2', validCommentCount: 1 }),
    ]));
    expect(persistence.getSessionGiftRanking('recalc-session')).toEqual([expect.objectContaining({ userKey: 'viewer-3', giftCount: 4 })]);
    expect(persistence.listLiveEventInboxByRange(now - 1_000, now)).toHaveLength(2);
    expect(persistence.listReadingsForSession('recalc-session')).toHaveLength(2);
  });
});
