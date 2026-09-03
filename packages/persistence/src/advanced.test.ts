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
});
