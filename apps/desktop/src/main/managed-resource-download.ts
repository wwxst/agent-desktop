import { randomUUID } from 'node:crypto';
import { session } from 'electron';

export type ManagedDownloadAuthorization = (request: { readonly url: string; readonly method: string; readonly resourceType: string }) => Promise<boolean>;

/** 锁定媒体资源的 CDN 跳转也逐次准入，不能沿初始地址的授权自动访问其他来源。 */
export async function downloadManagedResource(url: string, resourceType: string, authorize: ManagedDownloadAuthorization, signal: AbortSignal): Promise<Response> {
  // Electron 的 manual fetch 会直接拒绝重定向；独立非持久分区可在每次真实请求前准入。
  const downloadSession = session.fromPartition(`media-download-${randomUUID()}`, { cache: false });
  let rejected: { error: unknown } | undefined;
  downloadSession.webRequest.onBeforeRequest((details, callback) => {
    void (async () => {
      signal.throwIfAborted();
      const target = new URL(details.url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('媒体资源下载地址无效。');
      if (!await authorize({ url: target.href, method: details.method, resourceType })) throw new Error('网络策略拒绝下载媒体资源。');
      signal.throwIfAborted();
      callback({ cancel: false });
    })().catch(error => { rejected = { error }; callback({ cancel: true }); });
  });
  try {
    // Chromium 负责标准重定向上限和流式下载；同一信号继续控制响应体读取。
    return await downloadSession.fetch(url, { signal, redirect: 'follow' });
  } catch (error) { throw rejected === undefined ? error : rejected.error; }
  finally { downloadSession.webRequest.onBeforeRequest(null); }
}
