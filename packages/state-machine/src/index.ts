import type { Reading, ReadingStatus } from '@meihua/core-types';

const terminalStates = new Set<ReadingStatus>([
  'REJECTED',
  'COMPLETED',
  'SKIPPED',
  'ABORTED',
]);

const processingStates = new Set<ReadingStatus>([
  'SELECTED',
  'CASTING',
  'INTERPRETING',
  'COMPOSING_SPEECH',
  'SYNTHESIZING',
  'SPEAKING',
  'RETRYING',
]);

const transitions: Record<ReadingStatus, ReadonlySet<ReadingStatus>> = {
  RECEIVED: new Set(['REJECTED', 'ACCEPTED', 'FAILED']),
  REJECTED: new Set(),
  ACCEPTED: new Set(['QUEUED', 'FAILED']),
  QUEUED: new Set(['SELECTED', 'SKIPPED', 'FAILED']),
  SELECTED: new Set(['CASTING', 'FAILED']),
  CASTING: new Set(['INTERPRETING', 'FAILED']),
  INTERPRETING: new Set(['COMPOSING_SPEECH', 'FAILED']),
  COMPOSING_SPEECH: new Set(['SYNTHESIZING', 'FAILED']),
  SYNTHESIZING: new Set(['SPEAKING', 'FAILED']),
  SPEAKING: new Set(['COMPLETED', 'FAILED']),
  COMPLETED: new Set(),
  FAILED: new Set(['RETRYING', 'SKIPPED']),
  RETRYING: new Set(['SELECTED', 'FAILED', 'SKIPPED']),
  SKIPPED: new Set(),
  ABORTED: new Set(),
  FAILED_TIMEOUT: new Set(['RETRYING', 'SKIPPED']),
};

export class InvalidReadingTransitionError extends Error {
  constructor(from: ReadingStatus, to: ReadingStatus) {
    super(`Invalid reading transition: ${from} -> ${to}`);
    this.name = 'InvalidReadingTransitionError';
  }
}

export function isTerminal(status: ReadingStatus): boolean {
  return terminalStates.has(status);
}

export function isProcessing(status: ReadingStatus): boolean {
  return processingStates.has(status);
}

export function canTransition(from: ReadingStatus, to: ReadingStatus): boolean {
  if (from === to || isTerminal(from)) return false;
  // An administrator can interrupt any live processing state.
  if (to === 'ABORTED' && (isProcessing(from) || from === 'QUEUED')) return true;
  if (to === 'FAILED_TIMEOUT' && isProcessing(from)) return true;
  return transitions[from].has(to);
}

export function transitionReading(
  reading: Reading,
  nextStatus: ReadingStatus,
  patch: Partial<Omit<Reading, 'id' | 'status' | 'createdAt'>> = {},
): Reading {
  if (!canTransition(reading.status, nextStatus)) {
    throw new InvalidReadingTransitionError(reading.status, nextStatus);
  }

  const now = Date.now();
  return {
    ...reading,
    ...patch,
    status: nextStatus,
    selectedAt: nextStatus === 'SELECTED' ? now : reading.selectedAt,
    completedAt: isTerminal(nextStatus) ? now : reading.completedAt,
  };
}
