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
      giftId: 'rose', giftName: 'Rose', repeatCount: 1, timestamp: Date.now(), raw: {},
    });
    const waiting = runtime.getQueueOverview();
    const reading = await runtime.ingest({
      source: 'mock', eventId: 'question-after-gift', userId: 'viewer-1', username: 'GiftViewer',
      message: 'Should I move forward with this plan?', timestamp: Date.now() + 1, raw: {},
    });

    expect(gift.action).toBe('PENDING_QUESTION');
    expect(waiting).toEqual([expect.objectContaining({ username: 'GiftViewer', status: 'WAITING_QUESTION', giftName: 'Rose' })]);
    expect(reading).toMatchObject({ status: 'QUEUED', priority: 'HIGH', speechTargetSeconds: 30, expiresAt: undefined });
    expect(reading.gift).toMatchObject({ giftName: 'Rose', ruleId: 'rose-priority' });
    expect(runtime.getGiftEntitlements()[0]).toMatchObject({ status: 'APPLIED', readingId: reading.id });
    expect(runtime.getQueueOverview()).toEqual([expect.objectContaining({ username: 'GiftViewer', status: 'QUEUED', question: 'Should I move forward with this plan?', position: 1 })]);
  });

  it('binds a gifted viewer next valid TikFinity comment without requiring a keyword', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    const gift = await runtime.ingestGift({
      source: 'tikfinity', eventId: 'real-gift-first', userId: 'viewer-gift', username: 'GiftViewer',
      giftId: '5655', giftName: 'Rose', repeatCount: 1, timestamp: Date.now(), raw: {},
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
    // V7.2 新口径（treatAnyCommentAsQuestion）：任何评论都算提问——第一条闲聊即入队并绑定礼物资格
    expect(chatter).toMatchObject({ status: 'QUEUED', priority: 'HIGH', speechTargetSeconds: 30, expiresAt: undefined });
    expect(runtime.getGiftEntitlements()[0]).toMatchObject({ status: 'APPLIED', readingId: chatter?.id });
    // 后续重复评论因“已有未完成任务”被拒，不重复占队
    expect(reading).toBeUndefined();
  });

  it('promotes an existing queued reading immediately when a matching gift arrives', async () => {
    const runtime = createRuntime();
    const reading = await runtime.ingest({
      source: 'mock', eventId: 'queued-question', username: 'VIPViewer',
      message: 'Should I continue preparing for the exam?', timestamp: Date.now(), raw: {},
    });
    const result = await runtime.ingestGift({
      source: 'mock', eventId: 'gift-after-question', username: 'VIPViewer',
      giftId: 'perfume', giftName: 'Perfume', repeatCount: 1, timestamp: Date.now() + 1, raw: {},
    });

    expect(result).toMatchObject({ action: 'APPLIED_TO_QUEUE', readingId: reading.id });
    expect(runtime.getReading(reading.id)).toMatchObject({ priority: 'MANUAL', speechTargetSeconds: 60, expiresAt: undefined });
    expect(runtime.getQueue()[0]).toMatchObject({ readingId: reading.id, priority: 'MANUAL', giftName: 'Perfume', speechTargetSeconds: 60, expiresAt: undefined });
  });

  it('treats source events as idempotent', async () => {
    const runtime = createRuntime();
    const event = { source: 'mock' as const, eventId: 'same-source-event', username: 'Viewer', message: '现在适合推进这个计划吗？', timestamp: Date.now(), raw: {} };
    const first = await runtime.ingest(event);
    const duplicate = await runtime.ingest(event);
    expect(duplicate.id).toBe(first.id);
    expect(runtime.getQueue()).toHaveLength(1);

    const giftEvent = { source: 'mock' as const, eventId: 'same-gift-event', username: 'GiftViewer', giftId: 'rose', giftName: 'Rose', repeatCount: 1, timestamp: Date.now(), raw: {} };
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

  it('queues a matching comment rule and ignores unrelated TikFinity chat', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    const ignored = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-ignore', username: 'ViewerA', message: 'hello everyone', timestamp: Date.now(), raw: {} });
    const accepted = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'chat-match', username: 'ViewerB', message: 'reading: Is a job change suitable?', timestamp: Date.now() + 1, raw: {} });
    expect(ignored).toBeUndefined();
    expect(accepted).toMatchObject({ status: 'QUEUED', qualification: { kind: 'COMMENT_KEYWORD' } });
    expect(accepted?.rawQuestion).toBe('Is a job change suitable?');
  });

  it('keeps a keyword-only comment as a pending qualification and binds the next valid question', async () => {
    const runtime = createRuntime();
    runtime.startSession({ mode: 'REHEARSAL' });
    runtime.pause();
    const keyword = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'keyword-only', userId: 'keyword-user', username: 'KeywordViewer', message: 'reading', timestamp: Date.now(), raw: {} });
    expect(keyword).toBeUndefined();
    expect(runtime.getPendingQualifications()).toEqual([expect.objectContaining({ username: 'KeywordViewer', kind: 'COMMENT_KEYWORD' })]);
    const reading = await runtime.ingestTikfinityChat({ source: 'tikfinity', eventId: 'question-after-keyword', userId: 'keyword-user', username: 'KeywordViewer', message: 'Can I change jobs this year', timestamp: Date.now() + 1, raw: {} });
    expect(reading).toMatchObject({ status: 'QUEUED', qualification: { kind: 'COMMENT_KEYWORD' } });
    expect(runtime.getPendingQualifications()).toHaveLength(0);
  });
});
