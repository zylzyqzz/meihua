export const apiBase = import.meta.env.VITE_ORCHESTRATOR_HTTP ?? 'http://127.0.0.1:3210';
export const overlayBase = import.meta.env.VITE_OVERLAY_HTTP ?? 'http://127.0.0.1:5173';
export const controlToken = document.querySelector<HTMLMetaElement>('meta[name="meihua-control-token"]')?.content ?? '';
export const productionMode = document.querySelector<HTMLMetaElement>('meta[name="meihua-production"]')?.content === 'true';

export const authenticatedMediaUrl = (assetId: string) => `${apiBase}/api/media-assets/${assetId}/content${controlToken ? `?token=${encodeURIComponent(controlToken)}` : ''}`;
export const authenticatedAudioUrl = (path: string) => `${apiBase}${path}${controlToken ? `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(controlToken)}` : ''}`;
export const authenticatedMediaThumbnailUrl = (assetId: string, revision?: string) => {
  const params = new URLSearchParams();
  if (revision) params.set('v', revision);
  if (controlToken) params.set('token', controlToken);
  const query = params.toString();
  return `${apiBase}/api/media-assets/${assetId}/thumbnail${query ? `?${query}` : ''}`;
};

export async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (controlToken) headers.set('x-meihua-token', controlToken);
  const send = () => fetch(`${apiBase}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
  let response: Response;
  try { response = await send(); }
  catch {
    try { response = await send(); }
    catch { throw new Error('无法连接控制服务，请刷新中控页面后重试'); }
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && body.error === 'LOCAL_CONTROL_AUTH_REQUIRED') window.dispatchEvent(new CustomEvent('meihua-auth-expired'));
  if (!response.ok) {
    const failedChecks = Array.isArray(body.preflight?.checks)
      ? body.preflight.checks.filter((item: { status?: string }) => item.status === 'FAIL').map((item: { label?: string; message?: string }) => `${item.label ?? '检查项'}：${item.message ?? '未通过'}`)
      : [];
    const reason = body.reason === 'LIVE_PREFLIGHT_FAILED'
      ? `无法开播：${failedChecks.join('；') || '开播预检未通过'}`
      : body.reason === 'PRESENTATION_VIDEO_NOT_READY'
        ? `无法开播：预录视频尚未就绪${failedChecks.length ? `；${failedChecks.join('；')}` : ''}`
        : body.reason === 'DIGITAL_HUMAN_NOT_READY'
          ? `无法开播：数字人服务尚未就绪${failedChecks.length ? `；${failedChecks.join('；')}` : ''}`
          : body.reason ?? body.error ?? `HTTP ${response.status}`;
    const error = new Error(reason) as Error & { usages?: string[] };
    if (Array.isArray(body.usages)) error.usages = body.usages;
    throw error;
  }
  return body as T;
}
