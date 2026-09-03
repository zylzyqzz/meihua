import type { QueuePriority } from '@meihua/core-types';

export interface QueueItem {
  readingId: string;
  username: string;
  priority: QueuePriority;
  queuedAt: number;
  expiresAt?: number;
}

const priorityWeight: Record<QueuePriority, number> = {
  MANUAL: 3,
  HIGH: 2,
  NORMAL: 1,
};

export class ReadingQueue {
  private readonly items = new Map<string, QueueItem>();

  enqueue(item: QueueItem): void {
    if (this.items.has(item.readingId)) return;
    this.items.set(item.readingId, item);
  }

  remove(readingId: string): QueueItem | undefined {
    const item = this.items.get(readingId);
    this.items.delete(readingId);
    return item;
  }

  next(): QueueItem | undefined {
    const item = this.list()[0];
    if (item) this.items.delete(item.readingId);
    return item;
  }

  promote(readingId: string): boolean {
    const item = this.items.get(readingId);
    if (!item) return false;
    item.priority = 'MANUAL';
    item.queuedAt = Math.min(...[...this.items.values()].map((candidate) => candidate.queuedAt), item.queuedAt) - 1;
    return true;
  }

  setPriority(readingId: string, priority: QueuePriority): boolean {
    const item = this.items.get(readingId);
    if (!item) return false;
    item.priority = priority;
    return true;
  }

  setExpiresAt(readingId: string, expiresAt?: number): boolean {
    const item = this.items.get(readingId);
    if (!item) return false;
    item.expiresAt = expiresAt;
    return true;
  }

  clear(): QueueItem[] {
    const values = this.list();
    this.items.clear();
    return values;
  }

  has(readingId: string): boolean {
    return this.items.has(readingId);
  }

  hasUsername(username: string): boolean {
    const normalized = username.trim().toLocaleLowerCase();
    return [...this.items.values()].some((item) => item.username.trim().toLocaleLowerCase() === normalized);
  }

  get size(): number {
    return this.items.size;
  }

  list(): QueueItem[] {
    return [...this.items.values()].sort((left, right) => {
      const priorityDifference = priorityWeight[right.priority] - priorityWeight[left.priority];
      return priorityDifference || left.queuedAt - right.queuedAt;
    });
  }
}
