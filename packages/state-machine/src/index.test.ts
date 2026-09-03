import { describe, expect, it } from 'vitest';
import type { Reading } from '@meihua/core-types';
import { InvalidReadingTransitionError, transitionReading } from './index.js';

const reading: Reading = {
  id: 'reading-1',
  source: 'mock',
  username: 'David',
  rawQuestion: '今年适不适合换工作？',
  status: 'RECEIVED',
  priority: 'NORMAL',
  createdAt: 1,
};

describe('reading state machine', () => {
  it('permits the normal intake sequence', () => {
    const accepted = transitionReading(reading, 'ACCEPTED');
    const queued = transitionReading(accepted, 'QUEUED');
    const selected = transitionReading(queued, 'SELECTED');
    expect(selected.status).toBe('SELECTED');
    expect(selected.selectedAt).toBeTypeOf('number');
  });

  it('rejects skipped transitions', () => {
    expect(() => transitionReading(reading, 'SPEAKING')).toThrow(InvalidReadingTransitionError);
  });

  it('allows an administrator to abort a processing task', () => {
    const accepted = transitionReading(reading, 'ACCEPTED');
    const queued = transitionReading(accepted, 'QUEUED');
    const selected = transitionReading(queued, 'SELECTED');
    expect(transitionReading(selected, 'ABORTED').status).toBe('ABORTED');
  });
});
