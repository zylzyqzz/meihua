import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolve the portable project root independently of the process working
 * directory. Package-level dev commands start inside apps/orchestrator, while
 * production starts in the workspace root; both must use the same data store.
 */
export function resolveProjectRoot(cwd = process.cwd(), override = process.env.MEIHUA_PROJECT_ROOT): string {
  if (override?.trim()) return resolve(override);
  const current = resolve(cwd);
  if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
  const workspace = resolve(current, '..', '..');
  if (existsSync(resolve(workspace, 'pnpm-workspace.yaml'))) return workspace;
  return current;
}
