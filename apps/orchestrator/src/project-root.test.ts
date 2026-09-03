import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProjectRoot } from './project-root.js';

describe('resolveProjectRoot', () => {
  it('uses the workspace root when started inside apps/orchestrator', () => {
    const root = mkdtempSync(join(tmpdir(), 'meihua-root-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []');
    const app = join(root, 'apps', 'orchestrator');
    mkdirSync(app, { recursive: true });
    expect(resolveProjectRoot(app, '')).toBe(root);
  });

  it('honors an explicit portable data root', () => {
    const root = mkdtempSync(join(tmpdir(), 'meihua-override-'));
    expect(resolveProjectRoot('C:\\ignored', root)).toBe(root);
  });
});
