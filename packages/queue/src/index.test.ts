import { describe, expect, it } from 'vitest';
import { ReadingQueue } from './index.js';

describe('ReadingQueue', () => {
  it('keeps FIFO order within a priority and puts manual items first', () => {
    const queue = new ReadingQueue();
    queue.enqueue({ readingId: 'a', username: 'A', priority: 'NORMAL', queuedAt: 10 });
    queue.enqueue({ readingId: 'b', username: 'B', priority: 'NORMAL', queuedAt: 20 });
    queue.enqueue({ readingId: 'c', username: 'C', priority: 'MANUAL', queuedAt: 30 });
    expect(queue.list().map((item) => item.readingId)).toEqual(['c', 'a', 'b']);
  });

  it('does not insert a reading twice', () => {
    const queue = new ReadingQueue();
    queue.enqueue({ readingId: 'a', username: 'A', priority: 'NORMAL', queuedAt: 10 });
    queue.enqueue({ readingId: 'a', username: 'A', priority: 'MANUAL', queuedAt: 1 });
    expect(queue.size).toBe(1);
  });

  it('can remove the expiry when a free viewer becomes a gift viewer', () => {
    const queue = new ReadingQueue();
    queue.enqueue({ readingId: 'paid', username: 'Paid', priority: 'NORMAL', queuedAt: 10, expiresAt: 20 });
    expect(queue.setExpiresAt('paid', undefined)).toBe(true);
    expect(queue.list()[0].expiresAt).toBeUndefined();
  });
});
