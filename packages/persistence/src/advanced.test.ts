import { describe, expect, it } from 'vitest';
import { SqlitePersistence } from './index.js';

describe('persistence operations', () => {
  it('persists settings, blocklist entries, and audit events', () => {
    const persistence = new SqlitePersistence(':memory:');
    persistence.setSetting('settings', { queue: { maxTotal: 30 } });
    persistence.blockUser({ userKey: 'viewer-1', username: 'Viewer', reason: 'spam' });
    persistence.recordEvent('SETTINGS_UPDATED', { source: 'test' });
    expect(persistence.getSetting('settings', {})).toEqual({ queue: { maxTotal: 30 } });
    expect(persistence.isBlocked('viewer-1')).toBe(true);
    expect(persistence.listBlockedUsers()).toHaveLength(1);
    expect(persistence.listEvents()).toMatchObject([{ type: 'SETTINGS_UPDATED' }]);
    persistence.close();
  });

  it('rebuilds session projections atomically while preserving durable source rows', () => {
    const persistence = new SqlitePersistence(':memory:');
    persistence.saveReading({
      id: 'session-reading', sessionId: 'session-rebuild', sourceEventId: 'chat-source', source: 'tikfinity',
      username: 'Viewer', userId: 'viewer-1', rawQuestion: 'Will this plan work?', normalizedQuestion: 'Will this plan work?',
      moderationDecision: 'ALLOW', status: 'QUEUED', priority: 'NORMAL', createdAt: 120,
    });
    const inbox = persistence.enqueueLiveEvent({
      source: 'tikfinity', eventId: 'like-source', kind: 'like', receivedAt: 110,
      payload: { source: 'tikfinity', eventId: 'like-source', userId: 'viewer-1', username: 'Viewer', likeCount: 100, timestamp: 110, raw: {} },
    });
    persistence.completeLiveEvent(inbox!.id);

    persistence.replaceSessionDerivedStats({
      sessionId: 'session-rebuild',
      engagement: [{ userKey: 'viewer-1', username: 'Viewer', likeCount: 100, validCommentCount: 1, points: 5, reachedAt: 120 }],
      gifts: [{ userKey: 'gift-viewer', username: 'GiftViewer', points: 12, giftCount: 4, reachedAt: 115 }],
    });

    expect(persistence.listReadingsForSession('session-rebuild')).toEqual([expect.objectContaining({ id: 'session-reading' })]);
    expect(persistence.listLiveEventInboxByRange(100, 130)).toEqual([expect.objectContaining({ eventId: 'like-source', status: 'DONE' })]);
    expect(persistence.getSessionEngagementRanking('session-rebuild')).toEqual([expect.objectContaining({ userKey: 'viewer-1', points: 5 })]);
    expect(persistence.getSessionGiftRanking('session-rebuild')).toEqual([expect.objectContaining({ userKey: 'gift-viewer', points: 12 })]);
    persistence.close();
  });

  it('removes legacy duplicate intake audits while preserving business events', () => {
    const persistence = new SqlitePersistence(':memory:');
    persistence.recordEvent('TIKFINITY_INBOX_RECEIVED', { eventId: 'chat-1' });
    persistence.recordEvent('TIKFINITY_INBOX_DUPLICATE', { eventId: 'chat-1' });
    persistence.recordEvent('LIKE_RECEIVED', { eventId: 'like-1' });
    persistence.recordEvent('READING_STATE_CHANGED', { status: 'QUEUED' }, 'reading-1');

    const pruned = persistence.pruneOperationalData({ rawEventBefore: 0, auditBefore: 0 });

    expect(pruned.audit).toBe(3);
    expect(persistence.listEvents()).toEqual([expect.objectContaining({ type: 'READING_STATE_CHANGED' })]);
    persistence.close();
  });
});
