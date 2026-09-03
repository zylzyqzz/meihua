import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/** Minimal production SPA server; development remains Vite-only. */
export async function startStaticServer(input: { directory: string; port: number; host: string; controlToken?: string }): Promise<Server> {
  const root = resolve(input.directory);
  if (!existsSync(join(root, 'index.html'))) throw new Error(`PRODUCTION_BUILD_MISSING:${root}`);
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
      const candidate = resolve(root, `.${normalize(pathname)}`);
      const allowed = candidate === root || candidate.startsWith(`${root}\\`) || candidate.startsWith(`${root}/`);
      const filePath = allowed && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, 'index.html');
      if (filePath.endsWith('index.html')) {
        const html = readFileSync(filePath, 'utf8');
        const tokenMeta = input.controlToken
          ? `<meta name="meihua-production" content="true"><meta name="meihua-control-token" content="${input.controlToken.replace(/[&<>"']/g, '')}">`
          : '';
        response.writeHead(200, { 'content-type': mimeTypes['.html'], 'cache-control': 'no-store' });
        response.end(html.replace('</head>', `${tokenMeta}</head>`));
        return;
      }
      response.writeHead(200, { 'content-type': mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream', 'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
      response.end(readFileSync(filePath));
    } catch (error) {
      const malformed = error instanceof URIError;
      response.writeHead(malformed ? 400 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: malformed ? 'MALFORMED_URL' : 'STATIC_FILE_NOT_FOUND' }));
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(input.port, input.host, () => { server.off('error', reject); resolvePromise(); });
  });
  return server;
}

export async function closeStaticServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}
