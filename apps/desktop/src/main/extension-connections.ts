import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { readDesktopDocument, writeDesktopDocuments } from './desktop-database.js';

interface SecretStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
interface Credentials { readonly values?: Readonly<Record<string, string>>; readonly client?: OAuthClientInformationMixed; readonly tokens?: OAuthTokens }

/** 凭据只存在主进程和操作系统加密存储中；Renderer 只收到配置/连接状态。 */
export class ExtensionConnections {
  private readonly pending = new Map<string, AbortController>();
  constructor(private readonly database: string, private readonly storage: SecretStorage, private readonly openUrl: (url: string) => Promise<unknown>) {}
  private read(key: string): Credentials {
    const data = readDesktopDocument(this.database, `extension-secret:${key}`);
    if (data === null) return {};
    if (typeof data !== 'object' || data === null || !('ciphertext' in data) || typeof data.ciphertext !== 'string') throw new Error('插件凭据存储无效。');
    return JSON.parse(this.storage.decryptString(Buffer.from(data.ciphertext, 'base64'))) as Credentials;
  }
  private save(key: string, value: Credentials): void {
    if (!this.storage.isEncryptionAvailable()) throw new Error('操作系统凭据加密不可用，无法保存插件密钥。');
    writeDesktopDocuments(this.database, [{ name: `extension-secret:${key}`, value: { ciphertext: this.storage.encryptString(JSON.stringify(value)).toString('base64') } }]);
  }
  values(id: string, server: string): Readonly<Record<string, string>> { return this.read(`${id}/${server}`).values ?? {}; }
  configure(id: string, server: string, values: Readonly<Record<string, string>>): void { const key = `${id}/${server}`; this.save(key, { values: { ...this.read(key).values, ...values } }); }
  connected(id: string, server: string, url: string): boolean { return this.read(`${id}/${server}/${url}`).tokens !== undefined; }
  disconnect(id: string, server: string, url: string): void { this.save(`${id}/${server}/${url}`, {}); }
  cancel(id: string, server: string): void { this.pending.get(`${id}/${server}`)?.abort(new Error('账户授权已取消。')); }
  cancelAll(): void { for (const controller of this.pending.values()) controller.abort(new Error('账户授权已取消。')); }
  /** 执行中只读取或刷新现有授权；新授权由详情页显式发起。 */
  provider(id: string, server: string, url: string, redirectUrl = 'http://127.0.0.1/callback', redirect?: (url: URL) => Promise<void>): OAuthClientProvider {
    const key = `${id}/${server}/${url}`; const state = randomUUID(); let verifier: string | undefined;
    return {
      redirectUrl, clientMetadata: { client_name: 'Agent Desktop', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      state: () => state,
      clientInformation: () => this.read(key).client,
      saveClientInformation: client => { this.save(key, { ...this.read(key), client }); },
      tokens: () => this.read(key).tokens,
      saveTokens: tokens => { this.save(key, { ...this.read(key), tokens }); },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => { if (verifier === undefined) throw new Error('授权校验值已失效。'); return verifier; },
      redirectToAuthorization: async authorizationUrl => { if (redirect === undefined) throw new Error(`请在插件详情中连接 ${server} 的账户。`); await redirect(authorizationUrl); },
      invalidateCredentials: scope => {
        const previous = this.read(key);
        if (scope === 'all') this.save(key, {});
        else if (scope === 'tokens') { const { tokens: _tokens, ...next } = previous; this.save(key, next); }
        else if (scope === 'client') { const { client: _client, ...next } = previous; this.save(key, next); }
        else if (scope === 'verifier') verifier = undefined;
      },
    };
  }
  /** 使用 SDK 的资源发现、动态注册和 PKCE；回调仅监听本机，验证 state 后交换令牌。 */
  async authorize(id: string, service: string, url: string): Promise<void> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('无法创建授权回调。');
    const redirectUrl = `http://127.0.0.1:${address.port}/callback`;
    const controller = new AbortController(); const key = `${id}/${service}`;
    this.pending.set(key, controller);
    // 发现、注册、令牌交换和等待回调都受同一次取消约束。
    const fetchFn: typeof fetch = (input, init) => fetch(input, { ...init, signal: controller.signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCode: ((error: Error) => void) | undefined;
    let expectedState: string | null = null;
    const code = new Promise<string>((resolve, reject) => {
      rejectCode = reject;
      timer = setTimeout(() => controller.abort(new Error('账户授权等待超时，请重新连接。')), 120_000);
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      server.on('request', (request, response) => {
        const callback = new URL(request.url ?? '/', redirectUrl);
        if (callback.pathname !== '/callback' || expectedState === null || callback.searchParams.get('state') !== expectedState) { response.writeHead(400).end('Invalid authorization state'); return; }
        const authCode = callback.searchParams.get('code'); const error = callback.searchParams.get('error');
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error === null ? '授权已完成，可以返回 Agent Desktop。' : '授权被拒绝，可以返回 Agent Desktop。');
        if (authCode === null || error !== null) reject(new Error(`账户授权未完成：${error ?? '缺少授权码'}`)); else resolve(authCode);
      });
    });
    // 捕获提前失败时尚未被等待的回调 Promise，实际错误仍由 authorize 抛出。
    void code.catch(() => undefined);
    try {
      const provider = this.provider(id, service, url, redirectUrl, async authorizationUrl => { expectedState = authorizationUrl.searchParams.get('state'); await this.openUrl(authorizationUrl.href); });
      const result = await auth(provider, { serverUrl: url, fetchFn });
      if (result === 'REDIRECT') await auth(provider, { serverUrl: url, authorizationCode: await code, fetchFn });
    } catch (error) { rejectCode?.(error as Error); throw error; }
    finally { this.pending.delete(key); if (timer !== undefined) clearTimeout(timer); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
