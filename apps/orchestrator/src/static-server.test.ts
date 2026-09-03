import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeStaticServer, startStaticServer } from './static-server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

describe('production static server', () => {
  it('injects the local control token and survives malformed URLs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meihua-static-'));
    await writeFile(join(directory, 'index.html'), '<html><head></head><body>ready</body></html>');
    const server = await startStaticServer({ directory, host: '127.0.0.1', port: 0, controlToken: 'static-test-token' });
    cleanups.push(async () => { await closeStaticServer(server); await rm(directory, { recursive: true, force: true }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const base = `http://127.0.0.1:${address.port}`;

    const index = await fetch(base);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<meta name="meihua-control-token" content="static-test-token">');

    const malformed = await fetch(`${base}/%E0%A4%A`);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'MALFORMED_URL' });
    expect((await fetch(base)).status).toBe(200);
  });
});
