import { describe, expect, it } from 'vitest';
import type { Reading } from '@meihua/core-types';
import { SqlitePersistence } from './index.js';

describe('SqlitePersistence', () => {
  it('persists and recovers digital-human jobs', () => {
    const persistence = new SqlitePersistence(':memory:');
    persistence.saveDigitalHumanJob({ id: 'job-1', kind: 'AVATAR_PREP', profileId: 'avatar-1', status: 'PROCESSING', stage: 'PREPROCESSING', progress: 40, createdAt: 100, updatedAt: 200, startedAt: 150 });
    expect(persistence.getDigitalHumanJob('job-1')).toMatchObject({ kind: 'AVATAR_PREP', status: 'PROCESSING', progress: 40 });
    expect(persistence.recoverDigitalHumanJobs()).toBe(1);
    expect(persistence.getDigitalHumanJob('job-1')).toMatchObject({ status: 'QUEUED', stage: 'RECOVERED_AFTER_RESTART' });
    persistence.close();
  });

  it('stores and restores queued readings', () => {
    const persistence = new SqlitePersistence(':memory:');
    const reading: Reading = {
      id: 'db-reading-1',
      source: 'mock',
      username: 'David',
      rawQuestion: '今年适不适合换工作？',
      normalizedQuestion: '今年适不适合换工作？',
      status: 'QUEUED',
      priority: 'NORMAL',
      createdAt: 100,
    };
    persistence.saveReading(reading);
    expect(persistence.listQueued()).toEqual([reading]);
    persistence.close();
  });

  it('stores and restores the immutable presentation snapshot with a reading', () => {
    const persistence = new SqlitePersistence(':memory:');
    const reading: Reading = {
      id: 'snapshot-reading-1', source: 'mock', username: 'SnapshotUser',
      rawQuestion: 'Should this use the selected video?', status: 'QUEUED', priority: 'HIGH', createdAt: 100,
      presentationSnapshot: {
        mode: 'VIDEO_ONCE', videoProfileId: 'video-profile-1', avatarProfileId: 'avatar-profile-1',
        fallbackApplied: false, selectedAt: 120,
      },
    };
    persistence.saveReading(reading);
    expect(persistence.getReading(reading.id)).toMatchObject({ presentationSnapshot: reading.presentationSnapshot });
    persistence.close();
  });

  it('persists pipeline checkpoints and can requeue a restarted reading', () => {
    const persistence = new SqlitePersistence(':memory:');
    persistence.saveReading({
      id: 'checkpoint-reading',
      source: 'mock',
      username: 'CheckpointUser',
      rawQuestion: 'Will this pipeline resume safely?',
      status: 'SPEAKING',
      priority: 'NORMAL',
      createdAt: 100,
      pipeline: {
        readingId: 'checkpoint-reading', phase: 'VOICE_READY', phaseLabel: '声音已生成', progress: 72,
        attempt: 1, maxAttempts: 3, stageStartedAt: 200, updatedAt: 300,
        artifacts: { hexagram: true, script: true, audio: true, lipSync: true, avatar: false },
      },
    });
    expect(persistence.getReading('checkpoint-reading')?.pipeline).toMatchObject({ phase: 'VOICE_READY', progress: 72 });
    expect(persistence.recoverInFlightReadings()).toBe(1);
    expect(persistence.requeueRestartedReadings()).toBe(1);
    expect(persistence.listQueued()).toEqual([expect.objectContaining({
      id: 'checkpoint-reading', status: 'QUEUED', errorCode: 'PROCESS_RESTART_RECOVERED',
    })]);
    persistence.close();
  });

  it('marks in-flight work as aborted after a restart', () => {
    const persistence = new SqlitePersistence(':memory:');
    persistence.saveReading({
      id: 'active-reading',
      source: 'mock',
      username: 'David',
      rawQuestion: '今年适不适合换工作？',
      status: 'SPEAKING',
      priority: 'NORMAL',
      createdAt: 100,
    });
    expect(persistence.recoverInFlightReadings()).toBe(1);
    expect(persistence.getReading('active-reading')).toMatchObject({ status: 'ABORTED', errorCode: 'PROCESS_RESTART' });
    persistence.close();
  });

  it('stores, selects, applies, and lists gift entitlements', () => {
    const persistence = new SqlitePersistence(':memory:');
    persistence.saveGiftEntitlement({
      id: 'gift-entitlement-1', sourceEventId: 'gift-event-1', userKey: 'viewer', username: 'Viewer',
      ruleId: 'rose-priority', giftId: 'rose', giftName: 'Rose', repeatCount: 1,
      priority: 'HIGH', speechTargetSeconds: 40, receivedAt: 100, status: 'PENDING',
      createdAt: 100, expiresAt: 10_000,
    });
    expect(persistence.findBestPendingGiftEntitlement('viewer', 200)).toMatchObject({ id: 'gift-entitlement-1', status: 'PENDING' });
    persistence.markGiftEntitlementApplied('gift-entitlement-1', 'reading-1', 300);
    expect(persistence.listGiftEntitlements()).toEqual([
      expect.objectContaining({ id: 'gift-entitlement-1', status: 'APPLIED', readingId: 'reading-1', appliedAt: 300 }),
    ]);
    persistence.saveGiftEntitlement({
      id: 'gift-entitlement-2', sourceEventId: 'gift-event-2', userKey: 'viewer-2', username: 'Viewer2',
      ruleId: 'rose-priority', giftId: 'rose', giftName: 'Rose', repeatCount: 1,
      priority: 'HIGH', speechTargetSeconds: 40, receivedAt: 200, status: 'PENDING',
      createdAt: 200, expiresAt: 10_000,
    });
    expect(persistence.listGiftEntitlements({ from: 150, to: 250 })).toEqual([
      expect.objectContaining({ id: 'gift-entitlement-2', createdAt: 200 }),
    ]);
    persistence.close();
  });

  it('persists and consumes a free qualification grant', () => {
    const persistence = new SqlitePersistence(':memory:');
    persistence.saveQualificationGrant({
      id: 'grant-1', sourceEventId: 'like-event-1', sessionId: 'session-1', userKey: 'viewer', username: 'Viewer',
      kind: 'LIKE', ruleId: 'likes-100', label: '100 likes', priority: 'NORMAL', speechTargetSeconds: 28,
      status: 'PENDING', createdAt: 100, expiresAt: 10_000,
    });
    expect(persistence.findBestPendingQualificationGrant('viewer', 200)).toMatchObject({ id: 'grant-1', kind: 'LIKE', status: 'PENDING' });
    persistence.markQualificationGrantApplied('grant-1', 'reading-1', 300);
    expect(persistence.listQualificationGrants()).toEqual([expect.objectContaining({ id: 'grant-1', status: 'APPLIED', readingId: 'reading-1', appliedAt: 300 })]);
    persistence.close();
  });
});
