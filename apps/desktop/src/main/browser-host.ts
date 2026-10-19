import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Download, type ElementHandle, type Page } from 'playwright';
import { createFileArtifact, resolveScopedPath, type WorkspacePort } from '@agent-desktop/local-tools';
import type { FileArtifact } from '@agent-desktop/model';
import { SessionPersistenceError } from '@agent-desktop/session';
import { executePreparedAction, ToolExecutionError, type Tool, type ToolExecutionContext, type ToolPreparation } from '@agent-desktop/tools';

const TIMEOUT_MS = 15_000;
const MAX_ELEMENTS = 128;
const MAX_TEXT = 12_000;

export interface BrowserNetworkRequest {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
}
export interface BrowserApproval {
  readonly action: string;
  readonly pageId?: string;
  readonly url?: string;
  readonly snapshotId?: string;
  readonly ref?: string;
  readonly text?: string;
  readonly key?: string;
  readonly filePath?: string;
  readonly target?: string;
  readonly destination?: string;
}
export interface SessionBrowserOptions {
  readonly networkAccess: (request: BrowserNetworkRequest, signal?: AbortSignal) => Promise<boolean>;
  readonly approve: (action: BrowserApproval, signal?: AbortSignal) => Promise<boolean>;
  readonly workspace?: WorkspacePort;
  /** 宿主给出的已授权现有目录，模型不能选择截图或下载的写入位置。 */
  readonly outputDirectory?: () => string | undefined;
  readonly headless?: boolean;
}
interface PageState {
  readonly page: Page;
  /** 页面请求只使用页面自身的生命周期信号，不能借用后续 Turn 的信号。 */
  readonly networkController: AbortController;
  snapshot?: { readonly id: string; readonly revision: number; readonly elements: ReadonlyMap<string, ElementHandle>;
    readonly descriptions: ReadonlyMap<string, { readonly name: string; readonly destination?: string }> };
}
type Input = Record<string, unknown>;
type BrowserOutput = Record<string, unknown> & { readonly artifacts?: readonly FileArtifact[] };
type BrowserOperation = { readonly approval?: BrowserApproval; execute(): Promise<BrowserOutput> };

function text(input: Input, field: string, limit = 8192): string {
  const value = input[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) throw new ToolExecutionError(`${field} 必须是 1 至 ${limit} 字的字符串。`, 'permanent');
  return value;
}
function webUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ToolExecutionError('浏览器只允许不含凭据的 HTTP/HTTPS 地址。', 'denied');
  return url.href;
}
function schema(properties: Record<string, unknown>, required: readonly string[]) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 正式 Windows 包把 Chromium 放入 resources；开发和测试继续使用 Playwright 默认缓存。 */
function packagedChromiumPath(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  if (resourcesPath === undefined) return undefined;
  const path = join(resourcesPath, 'playwright', 'chromium', 'chrome-win64', 'chrome.exe');
  return existsSync(path) ? path : undefined;
}
const string = { type: 'string' };
const pageProperties = { pageId: string };
const refProperties = { ...pageProperties, snapshotId: string, ref: string };

/** 每个 Agent Session 的浏览器活资源，跨轮保留，退出后不保存或重连上下文。 */
export class SessionBrowser {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private readonly pages = new Map<string, PageState>();
  private readonly revisionKey = `__agent_revision_${randomUUID().replaceAll('-', '')}`;
  private permittedDownload: Page | undefined;
  private readonly blockedRequests: string[] = [];

  constructor(private readonly options: SessionBrowserOptions) {}

  tools(): readonly Tool[] {
    const refRequired = ['pageId', 'snapshotId', 'ref'];
    return [
      this.tool('browser_open', '打开 HTTP/HTTPS 页面并返回页面标识；后续先 snapshot 再使用元素引用。', schema({ url: string }, ['url']), 'external', async (input, execution) => {
        const url = webUrl(text(input, 'url'));
        return { approval: { action: 'open', url }, execute: async () => {
          execution.checkpoint?.({ kind: 'browser', action: 'open', url });
          const context = await this.getContext(execution.signal);
          const page = await context.newPage();
          const pageId = await this.remember(page);
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
            const state = this.pageState(pageId);
            return this.pageInfo(pageId, state);
          } catch (error) {
            await page.close();
            throw error;
          }
        } };
      }),
      this.tool('browser_snapshot', '读取主文档的有界文本和可交互元素，返回 snapshotId 与元素 ref。页面变化后必须重新读取。', schema(pageProperties, ['pageId']), 'read', async input => {
        const pageId = text(input, 'pageId'); this.pageState(pageId);
        return { execute: () => this.snapshot(pageId) };
      }),
      this.tool('browser_click', '点击当前快照中确切的元素；可能提交表单或产生外部副作用，执行前由宿主审批。', schema(refProperties, refRequired), 'external', async (input, execution) => {
        const target = await this.element(input);
        return { approval: this.action('click', input, target), execute: async () => {
          await this.recheck(input);
          execution.checkpoint?.(this.action('click', input, target));
          await target.element.click({ timeout: TIMEOUT_MS });
          delete target.state.snapshot;
          return this.pageInfo(text(input, 'pageId'), target.state);
        } };
      }),
      this.tool('browser_type', '在快照指定的输入元素中填写完整文本，不接受选择器或脚本。', schema({ ...refProperties, text: string }, [...refRequired, 'text']), 'external', async (input, execution) => {
        const target = await this.element(input);
        const value = typeof input.text === 'string' && input.text.length <= 16_000 ? input.text : undefined;
        if (value === undefined) throw new ToolExecutionError('text 必须是不超过 16000 字的字符串。', 'permanent');
        return { approval: { ...this.action('type', input, target), text: value }, execute: async () => {
          await this.recheck(input);
          execution.checkpoint?.(this.action('type', input, target));
          await target.element.fill(value, { timeout: TIMEOUT_MS });
          delete target.state.snapshot;
          return this.pageInfo(text(input, 'pageId'), target.state);
        } };
      }),
      this.tool('browser_press', '向快照指定元素发送一个按键或组合键，执行前审批。', schema({ ...refProperties, key: string }, [...refRequired, 'key']), 'external', async (input, execution) => {
        const target = await this.element(input); const key = text(input, 'key', 80);
        return { approval: { ...this.action('press', input, target), key }, execute: async () => {
          await this.recheck(input);
          execution.checkpoint?.(this.action('press', input, target));
          await target.element.press(key, { timeout: TIMEOUT_MS });
          delete target.state.snapshot;
          return this.pageInfo(text(input, 'pageId'), target.state);
        } };
      }),
      this.tool('browser_scroll', '在页面视口内滚动指定像素，单次每轴最多 2000。', schema({ ...pageProperties, x: { type: 'integer' }, y: { type: 'integer' } }, ['pageId', 'x', 'y']), 'external', async (input, execution) => {
        const state = this.pageState(text(input, 'pageId'));
        const x = input.x; const y = input.y;
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > 2000 || Math.abs(y) > 2000) throw new ToolExecutionError('滚动量必须是每轴不超过 2000 的整数。', 'permanent');
        return { approval: { action: 'scroll', pageId: text(input, 'pageId'), url: state.page.url(), text: `${x},${y}` }, execute: async () => {
          execution.checkpoint?.({ kind: 'browser', action: 'scroll', pageId: input.pageId, x, y });
          await state.page.mouse.wheel(x, y);
          delete state.snapshot;
          return this.pageInfo(text(input, 'pageId'), state);
        } };
      }),
      this.tool('browser_wait', '等待页面在 0 至 5000 毫秒内继续加载，随后重新 snapshot 查看真实结果。', schema({ ...pageProperties, milliseconds: { type: 'integer', minimum: 0, maximum: 5000 } }, ['pageId', 'milliseconds']), 'read', async input => {
        const state = this.pageState(text(input, 'pageId')); const duration = input.milliseconds;
        if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0 || duration > 5000) throw new ToolExecutionError('milliseconds 必须是 0 至 5000 的整数。', 'permanent');
        return { execute: async () => {
          await state.page.waitForTimeout(duration);
          return this.pageInfo(text(input, 'pageId'), state);
        } };
      }),
      this.tool('browser_screenshot', '把当前视口保存为宿主授权目录内的 PNG 文件。', schema(pageProperties, ['pageId']), 'external', async (input, execution) => {
        const state = this.pageState(text(input, 'pageId')); const filePath = await this.outputPath('screenshot', '.png');
        return { approval: { action: 'screenshot', pageId: text(input, 'pageId'), url: state.page.url(), filePath }, execute: async () => {
          execution.checkpoint?.({ kind: 'browser', action: 'screenshot', filePath });
          await state.page.screenshot({ path: filePath, timeout: TIMEOUT_MS, fullPage: false });
          return { filePath, artifacts: [await createFileArtifact(filePath, 'browser_screenshot', execution.signal)] };
        } };
      }),
      this.tool('browser_upload', '仅把工作区已授权的现有文件发送到快照指定的文件输入元素；展示确切本地路径审批。', schema({ ...refProperties, filePath: string }, [...refRequired, 'filePath']), 'external', async (input, execution) => {
        const target = await this.element(input); const workspace = this.options.workspace;
        if (workspace === undefined) throw new ToolExecutionError('当前会话未提供文件上传授权范围。', 'denied');
        const scoped = await resolveScopedPath(workspace.confirmedDirectory(), text(input, 'filePath'), workspace.fileAccess === 'all');
        if (!scoped.ok) throw new ToolExecutionError(scoped.message, 'denied');
        if (!(await stat(scoped.path)).isFile()) throw new ToolExecutionError('上传路径不是文件。', 'permanent');
        const preparedBytes = await readFile(scoped.path);
        const preparedSha256 = sha256(preparedBytes);
        return { approval: { ...this.action('upload', input, target), filePath: scoped.path }, execute: async () => {
          await this.recheck(input);
          const currentBytes = await readFile(scoped.path);
          if (sha256(currentBytes) !== preparedSha256) {
            throw new ToolExecutionError('审批等待期间上传文件内容已变化，操作未执行。', 'permanent');
          }
          execution.checkpoint?.({ kind: 'browser', action: 'upload', filePath: scoped.path, pageId: input.pageId });
          await target.element.setInputFiles({ name: basename(scoped.path), mimeType: 'application/octet-stream', buffer: currentBytes }, { timeout: TIMEOUT_MS });
          delete target.state.snapshot;
          return { uploadedFile: scoped.path, pageId: input.pageId };
        } };
      }),
      this.tool('browser_download', '点击快照中的下载元素，明确批准后把单个下载保存到宿主授权输出目录；其它下载自动取消。', schema(refProperties, refRequired), 'external', async (input, execution) => {
        const target = await this.element(input); const filePath = await this.outputPath('download', '.bin');
        return { approval: { ...this.action('download', input, target), filePath }, execute: async () => {
          await this.recheck(input);
          execution.checkpoint?.({ kind: 'browser', action: 'download', pageId: input.pageId, filePath });
          this.permittedDownload = target.state.page;
          try {
            const [download] = await Promise.all([target.state.page.waitForEvent('download', { timeout: TIMEOUT_MS }), target.element.click({ timeout: TIMEOUT_MS })]);
            await download.saveAs(filePath);
            const failure = await download.failure();
            if (failure !== null) throw new Error(failure);
            return { filePath, suggestedFilename: basename(download.suggestedFilename()).slice(0, 240),
              artifacts: [await createFileArtifact(filePath, 'browser_download', execution.signal)] };
          } finally { this.permittedDownload = undefined; delete target.state.snapshot; }
        } };
      }),
      this.tool('browser_close', '关闭本会话全部浏览器页面并释放上下文，不保存或重连 cookies 和页面。', schema({}, []), 'external', async (_input, execution) => {
        return { approval: { action: 'close' }, execute: async () => {
          execution.checkpoint?.({ kind: 'browser', action: 'close' });
          await this.close(); return { closed: true };
        } };
      }),
    ];
  }

  async close(): Promise<void> {
    const browser = this.browser;
    for (const state of this.pages.values()) state.networkController.abort(new DOMException('Browser session closed', 'AbortError'));
    this.browser = undefined; this.context = undefined; this.pages.clear();
    this.permittedDownload = undefined;
    if (browser !== undefined) await browser.close();
  }

  private tool(name: string, description: string, inputSchema: unknown, risk: 'read' | 'external',
    operation: (input: Input, execution: ToolExecutionContext) => Promise<BrowserOperation>): Tool {
    const prepare = async (input: unknown, execution: ToolExecutionContext): Promise<ToolPreparation> => {
      execution.signal?.throwIfAborted();
      if (typeof input !== 'object' || input === null || Array.isArray(input)) return { status: 'error', failureKind: 'permanent', message: '浏览器工具参数必须是对象。' };
      // 仅复制本次模型边界的数据；闭包使用已解析的引用和值，等待审批时不再读取调用方对象。
      const normalized = { ...input };
      let effectStarted = false;
      const context = { ...execution, checkpoint: (data: unknown) => {
        execution.checkpoint?.(data);
        effectStarted = true;
      } };
      const run = async <T>(execute: () => Promise<T>): Promise<T> => {
        const abort = () => { void this.close(); };
        execution.signal?.addEventListener('abort', abort, { once: true });
        try {
          const output = await execute();
          execution.signal?.throwIfAborted();
          return output;
        } catch (error) {
          execution.signal?.throwIfAborted();
          if (error instanceof SessionPersistenceError || error instanceof ToolExecutionError || !(error instanceof Error)) throw error;
          throw new ToolExecutionError(error.message, effectStarted ? 'unknown-outcome' : 'permanent', { cause: error });
        } finally { execution.signal?.removeEventListener('abort', abort); }
      };
      const prepared = await run(() => operation(normalized, context));
      const execute = async () => {
        const { artifacts, ...output } = await run(prepared.execute);
        return { status: 'success' as const, output, ...(artifacts === undefined ? {} : { artifacts }) };
      };
      // 无审批观察同样等待执行闭包，让外层 hooks 包住真实操作。
      const approval = prepared.approval;
      if (approval === undefined) return { requestApproval: async () => true, execute };
      return { requestApproval: async () => { await run(() => this.approve(approval, execution)); return true; }, execute };
    };
    return { name, description, inputSchema, executionBoundary: risk === 'read' ? 'read-only' : 'checkpointed',
      contract: { capability: 'browser', riskLevel: risk, parallelSafety: 'serial', workspaceScope: 'session',
        approvalRequirement: risk === 'read' ? 'none' : 'policy', timeoutMs: TIMEOUT_MS + 2000, cancellation: 'signal' },
      prepare,
      execute: async (input, execution) => executePreparedAction(await prepare(input, execution), execution) };
  }

  private async approve(action: BrowserApproval, execution: ToolExecutionContext): Promise<void> {
    if (!await this.options.approve(action, execution.signal)) throw new ToolExecutionError('用户拒绝浏览器操作，操作未执行。', 'denied');
    execution.signal?.throwIfAborted();
  }

  private async getContext(signal?: AbortSignal): Promise<BrowserContext> {
    if (this.context !== undefined) return this.context;
    const executablePath = packagedChromiumPath();
    const browser = await chromium.launch({ headless: this.options.headless ?? true, timeout: TIMEOUT_MS,
      ...(executablePath === undefined ? {} : { executablePath }) });
    if (signal?.aborted) { await browser.close(); signal.throwIfAborted(); }
    this.browser = browser;
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true, serviceWorkers: 'block' });
    context.setDefaultTimeout(TIMEOUT_MS);
    await context.addInitScript((key) => {
      let revision = 0;
      Object.defineProperty(globalThis, key, { get: () => revision, configurable: false });
      new MutationObserver(() => { revision += 1; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }, this.revisionKey);
    // 未由 browser_open 建立网络边界的弹出页不能发出请求。
    // 已登记页面由下方 CDP Fetch 逐跳拦截；Playwright route 本身不会重复拦截 HTTP 跳转。
    await context.route('**/*', async route => {
      const knownPage = [...this.pages.values()].some(state => state.page === route.request().frame().page());
      if (knownPage) await route.continue();
      else await route.abort('blockedbyclient');
    });
    // WebSocket 不属于本轮 HTTP/HTTPS 能力；不能绕过 route 的网络策略。
    await context.routeWebSocket('**/*', socket => { socket.close(); });
    this.context = context;
    return context;
  }

  private async remember(page: Page): Promise<string> {
    const existing = [...this.pages].find(([, state]) => state.page === page);
    if (existing !== undefined) return existing[0];
    const id = randomUUID(); const state: PageState = { page, networkController: new AbortController() };
    this.pages.set(id, state);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) delete state.snapshot; });
    page.on('close', () => {
      state.networkController.abort(new DOMException('Browser page closed', 'AbortError'));
      this.pages.delete(id);
    });
    page.on('download', download => {
      if (this.permittedDownload === page) this.permittedDownload = undefined;
      else void this.rejectDownload(download);
    });
    page.on('dialog', dialog => { void dialog.dismiss(); });
    const transport = await page.context().newCDPSession(page);
    transport.on('Fetch.requestPaused', event => {
      void this.networkRequest(transport, page, event.requestId, {
        url: event.request.url, method: event.request.method, resourceType: String(event.resourceType).toLowerCase(),
      });
    });
    await transport.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    return id;
  }

  private async networkRequest(transport: CDPSession, page: Page, requestId: string, request: BrowserNetworkRequest): Promise<void> {
    try {
      const pageEntry = [...this.pages].find(([, candidate]) => candidate.page === page);
      const pageId = pageEntry?.[0];
      const state = pageEntry?.[1];
      const signal = state?.networkController.signal;
      let allowed = false;
      try {
        allowed = ['http:', 'https:'].includes(new URL(request.url).protocol)
          && state !== undefined && signal?.aborted !== true
          && await this.options.networkAccess(request, signal);
        allowed = allowed && pageId !== undefined && this.pages.get(pageId) === state
          && signal?.aborted !== true;
      }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        if (this.blockedRequests.length < 8) this.blockedRequests.push(error.message.slice(0, 256));
      }
      if (allowed) await transport.send('Fetch.continueRequest', { requestId });
      else {
        if (this.blockedRequests.length < 8) this.blockedRequests.push(request.url.slice(0, 256));
        await transport.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    } catch (error) {
      // 取消或关闭会销毁 CDP 句柄，此时已没有能够继续的请求；其它传输故障关闭上下文。
      if (page.isClosed() || this.browser === undefined) return;
      if (!(error instanceof Error)) throw error;
      if (this.blockedRequests.length < 8) this.blockedRequests.push(error.message.slice(0, 256));
      await this.close();
    }
  }

  private async rejectDownload(download: Download): Promise<void> {
    await download.cancel();
    // 取消后的下载没有完整文件可 delete；临时下载目录由 context.close 统一回收。
  }

  private pageState(id: string): PageState {
    const state = this.pages.get(id);
    if (state === undefined || state.page.isClosed()) throw new ToolExecutionError('页面不存在或已关闭，请重新 browser_open。', 'permanent');
    return state;
  }

  private async pageInfo(pageId: string, state: PageState) {
    return { pageId, url: state.page.url().slice(0, 4096), title: (await state.page.title()).slice(0, 512),
      ...(this.blockedRequests.length === 0 ? {} : { blockedRequests: this.blockedRequests.splice(0, 8) }) };
  }

  private revision(page: Page): Promise<number> {
    return page.evaluate(key => (globalThis as unknown as Record<string, number>)[key]!, this.revisionKey);
  }

  private async snapshot(pageId: string) {
    const state = this.pageState(pageId);
    const revision = await this.revision(state.page);
    const locator = state.page.locator('a,button,input,textarea,select,summary,[role],[tabindex]');
    const count = await locator.count();
    const elements = new Map<string, ElementHandle>();
    const descriptions = new Map<string, { name: string; destination?: string }>();
    const entries: { ref: string; role: string; name: string; destination?: string; truncated: boolean }[] = [];
    let elementBytes = 0;
    for (let index = 0; index < Math.min(count, MAX_ELEMENTS); index += 1) {
      const handle = await locator.nth(index).elementHandle();
      if (handle === null) continue;
      const entry = await handle.evaluate(element => {
        const rectangle = element.getBoundingClientRect();
        if (rectangle.width === 0 || rectangle.height === 0) return null;
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role') ?? (tag === 'a' ? 'link' : tag === 'input' ? (element.getAttribute('type') ?? 'textbox') : tag === 'textarea' ? 'textbox' : tag);
        const name = (element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ');
        const destination = element instanceof HTMLAnchorElement ? element.href : undefined;
        return { role: role.slice(0, 64), name: name.slice(0, 160), ...(destination === undefined ? {} : { destination: destination.slice(0, 4096) }),
          truncated: role.length > 64 || name.length > 160 || (destination?.length ?? 0) > 4096 };
      });
      if (entry === null) { await handle.dispose(); continue; }
      const ref = `e${entries.length + 1}`;
      const next = { ref, ...entry };
      elementBytes += Buffer.byteLength(JSON.stringify(next), 'utf8');
      if (elementBytes > 4000) { await handle.dispose(); break; }
      elements.set(ref, handle); descriptions.set(ref, entry); entries.push(next);
    }
    if (revision !== await this.revision(state.page)) {
      await Promise.all([...elements.values()].map(handle => handle.dispose()));
      throw new ToolExecutionError('stale reference：生成快照期间页面已变化，请重新 browser_snapshot。', 'permanent');
    }
    if (state.snapshot !== undefined) await Promise.all([...state.snapshot.elements.values()].map(handle => handle.dispose()));
    const id = randomUUID(); state.snapshot = { id, revision, elements, descriptions };
    const content = await state.page.locator('body').evaluate((element, limit) => (element as HTMLElement).innerText.slice(0, limit), MAX_TEXT);
    const output = { ...await this.pageInfo(pageId, state), snapshotId: id, mainDocumentOnly: true, elements: entries };
    const textBudget = Math.max(0, 7000 - Buffer.byteLength(JSON.stringify(output), 'utf8') - 200);
    const encoded = Buffer.from(content, 'utf8');
    let end = Math.min(encoded.length, textBudget);
    while (end > 0 && end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end -= 1;
    return { ...output, text: encoded.subarray(0, end).toString('utf8'),
      truncated: count > entries.length || end < encoded.length || content.length === MAX_TEXT || entries.some(entry => entry.truncated) };
  }

  private async element(input: Input) {
    const state = this.pageState(text(input, 'pageId')); const snapshot = state.snapshot;
    const id = text(input, 'snapshotId'); const ref = text(input, 'ref', 32);
    if (snapshot?.id !== id || snapshot.revision !== await this.revision(state.page)) throw new ToolExecutionError('stale reference：页面或快照已变化，请重新 browser_snapshot。', 'permanent');
    const element = snapshot.elements.get(ref);
    if (element === undefined || !await element.evaluate(node => node.isConnected)) throw new ToolExecutionError('stale reference：元素已失效，请重新 browser_snapshot。', 'permanent');
    const destination = await element.evaluate(node => {
      if (node instanceof HTMLAnchorElement) return node.href;
      if (node instanceof HTMLInputElement || node instanceof HTMLButtonElement) return node.formAction || node.form?.action;
      return undefined;
    });
    return { state, element, ...(destination === undefined || destination === '' ? {} : { destination: webUrl(destination) }) };
  }
  private async recheck(input: Input): Promise<void> { await this.element(input); }
  private action(action: string, input: Input, target: { readonly state: PageState; readonly destination?: string }): BrowserApproval {
    const { state, destination } = target;
    const description = state.snapshot?.descriptions.get(text(input, 'ref', 32));
    return { action, pageId: text(input, 'pageId'), snapshotId: text(input, 'snapshotId'), ref: text(input, 'ref', 32), url: state.page.url(),
      ...(description === undefined ? {} : { target: description.name }), ...(destination === undefined ? {} : { destination }) };
  }
  private async outputPath(kind: string, suffix: string): Promise<string> {
    const directory = this.options.outputDirectory?.();
    if (directory === undefined) throw new ToolExecutionError('尚未配置浏览器授权输出目录。', 'denied');
    const resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory()) throw new ToolExecutionError('浏览器输出路径不是目录。', 'permanent');
    return join(resolved, `${kind}-${randomUUID()}${suffix}`);
  }
}
