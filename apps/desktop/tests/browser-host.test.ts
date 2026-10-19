import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '@agent-desktop/tools';
import { SessionBrowser, type BrowserApproval, type BrowserNetworkRequest } from '../src/main/browser-host.js';
import { SessionPersistenceError } from '@agent-desktop/session';

const browsers: SessionBrowser[] = [];
const servers: Server[] = [];
const directories: string[] = [];
const execution: ToolExecutionContext = { toolCallId: 'browser-test' as never, reportProgress: () => {} };
async function call(browser: SessionBrowser, name: string, input: Record<string, unknown>, context = execution): Promise<Record<string, unknown>> {
  const result = await browser.tools().find(tool => tool.name === name)!.execute(input, context);
  if (result.status !== 'success') throw new Error(result.message);
  return { ...result.output as Record<string, unknown>, ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }) };
}
async function fixture(onRequest?: (url: string, response: ServerResponse) => boolean) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '/'; requests.push(`${request.method} ${url}`);
    if (onRequest?.(url, response)) return;
    if (url === '/redirect') { response.writeHead(302, { Location: '/blocked' }); response.end(); return; }
    if (url === '/download') { response.writeHead(200, { 'Content-Disposition': 'attachment; filename="evidence.txt"' }); response.end('download evidence'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><body>
      <h1>Browser acceptance</h1><input aria-label="Name" name="name"><button onclick="document.getElementById('result').textContent='Clicked'">Apply</button>
      <input aria-label="Upload" type="file" onchange="document.getElementById('result').textContent=this.files[0].name+':'+this.files[0].type">
      <a href="/download">Download evidence</a><form method="post" action="/submitted"><input name="message" aria-label="Message"><button>Send form</button></form>
      <a href="javascript:document.getElementById('result').textContent='unsafe'">Unsafe link</a>
      <div id="result">Ready</div><img src="/blocked-resource" alt="blocked">
      <script>document.cookie='session=retained';</script></body></html>`);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Missing fixture address');
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-acceptance-')); directories.push(directory);
  const decisions: BrowserApproval[] = []; const network: BrowserNetworkRequest[] = []; const networkSignals: (AbortSignal | undefined)[] = [];
  const browser = new SessionBrowser({
    outputDirectory: () => directory,
    workspace: { confirmedDirectory: () => directory, requestApproval: async () => true, confirmDirectory: () => {} },
    approve: async action => { decisions.push(action); return true; },
    networkAccess: async (request, signal) => { network.push(request); networkSignals.push(signal); return !new URL(request.url).pathname.startsWith('/blocked'); },
  });
  browsers.push(browser);
  return { browser, directory, requests, decisions, network, networkSignals, url: `http://127.0.0.1:${address.port}` };
}
function element(snapshot: Record<string, unknown>, name: string): Record<string, unknown> {
  const found = (snapshot.elements as { ref: string; name: string }[]).find(entry => entry.name === name);
  if (found === undefined) throw new Error(`Missing element ${name}`);
  return { pageId: snapshot.pageId, snapshotId: snapshot.snapshotId, ref: found.ref };
}
afterEach(async () => {
  await Promise.all(browsers.splice(0).map(browser => browser.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('real session browser runtime', () => {
  it('retains context across tool invocations and acts only on current snapshot references', async () => {
    const { browser, url, decisions, network, requests } = await fixture();
    const opened = await call(browser, 'browser_open', { url });
    const snapshot = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    expect(snapshot.text).toContain('Browser acceptance');
    const name = element(snapshot, 'Name');
    await expect(call(browser, 'browser_click', element(snapshot, 'Unsafe link'))).rejects.toThrow('HTTP/HTTPS');
    await call(browser, 'browser_type', { ...name, text: 'Alice' });
    await expect(call(browser, 'browser_click', element(snapshot, 'Apply'))).rejects.toThrow('stale reference');
    const second = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    await call(browser, 'browser_press', { ...element(second, 'Name'), key: 'Tab' });
    const third = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    await call(browser, 'browser_click', element(third, 'Apply'));
    expect((await call(browser, 'browser_snapshot', { pageId: opened.pageId })).text).toContain('Clicked');
    const next = await call(browser, 'browser_open', { url });
    expect(next.pageId).not.toBe(opened.pageId);
    expect((await call(browser, 'browser_snapshot', { pageId: opened.pageId })).text).toContain('Clicked');
    expect(decisions.map(action => action.action)).toEqual(['open', 'type', 'press', 'click', 'open']);
    expect(network).toContainEqual(expect.objectContaining({ url: `${url}/blocked-resource`, method: 'GET', resourceType: 'image' }));
    expect(requests).not.toContain('GET /blocked-resource');
    await call(browser, 'browser_close', {});
    await expect(call(browser, 'browser_snapshot', { pageId: opened.pageId })).rejects.toThrow('页面不存在');
  }, 30_000);

  it('denies unsupported URLs and redirected requests before reaching the server', async () => {
    let origin = '';
    const { browser, url, network, requests } = await fixture((path, response) => {
      if (path === '/iframe-page') {
        response.setHeader('Content-Type', 'text/html');
        response.end(`<body>frame<iframe src="${origin.replace('127.0.0.1', 'localhost')}/redirect"></iframe></body>`); return true;
      }
      if (path === '/worker-page') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<body>worker<script>new Worker("/worker.js")</script></body>'); return true;
      }
      if (path === '/worker.js') {
        response.setHeader('Content-Type', 'application/javascript');
        response.end('fetch("/redirect").catch(()=>{})'); return true;
      }
      return false;
    });
    origin = url;
    for (const target of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'chrome://settings', 'https://user:secret@example.com']) {
      await expect(call(browser, 'browser_open', { url: target })).rejects.toThrow('HTTP/HTTPS');
    }
    expect(network).toHaveLength(0);
    await expect(call(browser, 'browser_open', { url: `${url}/redirect` })).rejects.toThrow();
    expect(network).toContainEqual(expect.objectContaining({ url: `${url}/blocked` }));
    expect(requests).toContain('GET /redirect');
    expect(requests).not.toContain('GET /blocked');
    const framed = await call(browser, 'browser_open', { url: `${url}/iframe-page` });
    await call(browser, 'browser_wait', { pageId: framed.pageId, milliseconds: 200 });
    expect(requests).not.toContain('GET /blocked');
    const worker = await call(browser, 'browser_open', { url: `${url}/worker-page` });
    await call(browser, 'browser_wait', { pageId: worker.pageId, milliseconds: 200 });
    expect(requests).not.toContain('GET /blocked');
    expect(requests).toContain('GET /worker.js');
    expect(network.filter(request => new URL(request.url).pathname === '/blocked')).toHaveLength(3);
  }, 30_000);

  it('requires exact approval, checkpoints and workspace containment for uploads, screenshots and downloads', async () => {
    const { browser, url, directory, decisions } = await fixture();
    const opened = await call(browser, 'browser_open', { url });
    const snapshot = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    await expect(call(browser, 'browser_upload', { ...element(snapshot, 'Upload'), filePath: '../outside.txt' })).rejects.toThrow();
    const outside = await mkdtemp(join(tmpdir(), 'agent-browser-outside-')); directories.push(outside);
    await writeFile(join(outside, 'outside.txt'), 'must stay outside');
    await expect(call(browser, 'browser_upload', { ...element(snapshot, 'Upload'), filePath: join(outside, 'outside.txt') })).rejects.toMatchObject({ failureKind: 'denied' });
    await writeFile(join(directory, 'upload.txt'), 'local upload evidence');
    const checkpoint = vi.fn();
    await call(browser, 'browser_upload', { ...element(snapshot, 'Upload'), filePath: 'upload.txt' }, { ...execution, checkpoint });
    expect((await call(browser, 'browser_snapshot', { pageId: opened.pageId })).text).toContain('upload.txt');
    expect(decisions).toContainEqual(expect.objectContaining({ action: 'upload', filePath: await realpath(join(directory, 'upload.txt')) }));
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ kind: 'browser', action: 'upload' }));
    const failedSave = new SessionPersistenceError(new Error('disk full'));
    await expect(call(browser, 'browser_screenshot', { pageId: opened.pageId }, { ...execution, checkpoint: () => { throw failedSave; } })).rejects.toBe(failedSave);
    expect((await readdir(directory)).filter(name => name.endsWith('.png'))).toEqual([]);
    const shot = await call(browser, 'browser_screenshot', { pageId: opened.pageId }, { ...execution, checkpoint });
    expect((await readFile(shot.filePath as string)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const ready = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    // 普通点击不会授权把页面触发的下载写进输出目录。
    await call(browser, 'browser_click', element(ready, 'Download evidence'));
    expect((await readdir(directory)).filter(name => name.startsWith('download-'))).toEqual([]);
    const authorized = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    const downloaded = await call(browser, 'browser_download', element(authorized, 'Download evidence'), { ...execution, checkpoint });
    expect(await readFile(downloaded.filePath as string, 'utf8')).toBe('download evidence');
    expect(decisions).toContainEqual(expect.objectContaining({ action: 'download', filePath: downloaded.filePath }));
    expect(downloaded.artifacts).toMatchObject([{ path: downloaded.filePath, mimeType: 'application/octet-stream' }]);
  }, 30_000);

  it('preserves upload MIME types in the actual browser File object', async () => {
    const { browser, url, directory } = await fixture();
    const opened = await call(browser, 'browser_open', { url });
    for (const [name, mime] of [ ['picture.PNG', 'image/png'], ['document.pdf', 'application/pdf'],
      ['clip.mp4', 'video/mp4'], ['data.unknown', 'application/octet-stream'] ]) {
      await writeFile(join(directory, name!), 'upload bytes');
      const snapshot = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
      await call(browser, 'browser_upload', { ...element(snapshot, 'Upload'), filePath: name });
      expect((await call(browser, 'browser_snapshot', { pageId: opened.pageId })).text).toContain(`${name}:${mime}`);
    }
  }, 30_000);

  it('rejects an oversized file before requesting upload approval', async () => {
    const { browser, url, directory, decisions } = await fixture();
    const path = join(directory, 'large.mp4');
    await writeFile(path, '');
    await truncate(path, 20 * 1024 * 1024 + 1);
    const opened = await call(browser, 'browser_open', { url });
    const snapshot = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    await expect(call(browser, 'browser_upload', { ...element(snapshot, 'Upload'), filePath: path })).rejects.toThrow('20 MiB');
    expect(decisions.filter(action => action.action === 'upload')).toHaveLength(0);
  }, 30_000);

  it.each(['changed contents', 'oversized replacement'])('rejects %s while upload approval is pending', async replacement => {
    const { url, directory } = await fixture();
    const uploadPath = join(directory, 'approval-race.txt');
    await writeFile(uploadPath, 'approved bytes');
    let releaseApproval!: () => void;
    const approvalReady = new Promise<void>(resolve => { releaseApproval = resolve; });
    let approvalEntered!: () => void;
    const approvalStarted = new Promise<void>(resolve => { approvalEntered = resolve; });
    const browser = new SessionBrowser({
      outputDirectory: () => directory,
      workspace: { confirmedDirectory: () => directory, requestApproval: async () => true, confirmDirectory: () => {} },
      approve: async action => {
        if (action.action === 'upload') {
          approvalEntered();
          await approvalReady;
        }
        return true;
      },
      networkAccess: async () => true,
    });
    browsers.push(browser);
    const opened = await call(browser, 'browser_open', { url });
    const snapshot = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    const upload = call(browser, 'browser_upload', { ...element(snapshot, 'Upload'), filePath: uploadPath });
    await approvalStarted;
    if (replacement === 'changed contents') await writeFile(uploadPath, 'changed bytes');
    else await truncate(uploadPath, 20 * 1024 * 1024 + 1);
    releaseApproval();
    await expect(upload).rejects.toThrow(replacement === 'changed contents' ? '内容已变化' : '20 MiB');
    expect((await call(browser, 'browser_snapshot', { pageId: opened.pageId })).text).toContain('Ready');
  }, 30_000);

  it('closes real in-flight browser activity on cancellation and rejects stale document references', async () => {
    const { browser, url } = await fixture((path, response) => {
      if (path === '/slow') return true;
      if (path === '/mutate') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<body><button aria-label="Original">Original</button><script>setTimeout(()=>document.body.innerHTML="<button>Replacement</button>",500)</script></body>');
        return true;
      }
      return false;
    });
    const opened = await call(browser, 'browser_open', { url: `${url}/mutate` });
    const snapshot = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    await call(browser, 'browser_wait', { pageId: opened.pageId, milliseconds: 700 });
    await expect(call(browser, 'browser_click', element(snapshot, 'Original'))).rejects.toThrow('stale reference');
    const controller = new AbortController();
    const loading = call(browser, 'browser_open', { url: `${url}/slow` }, { ...execution, signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 150);
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    await expect(call(browser, 'browser_snapshot', { pageId: opened.pageId })).rejects.toThrow('页面不存在');
    expect(await call(browser, 'browser_open', { url })).toHaveProperty('pageId');
  }, 30_000);

  it('binds delayed page requests to the page lifecycle instead of a later turn signal', async () => {
    const { browser, url, requests, network, networkSignals } = await fixture((path, response) => {
      if (path !== '/background-page') return false;
      response.setHeader('Content-Type', 'text/html');
      response.end('<body><script>setTimeout(() => fetch("/background-request").catch(() => {}), 500)</script>page</body>');
      return true;
    });
    const firstTurn = new AbortController();
    const opened = await call(browser, 'browser_open', { url: `${url}/background-page` }, { ...execution, signal: firstTurn.signal });
    const nextTurn = new AbortController();
    await call(browser, 'browser_snapshot', { pageId: opened.pageId }, { ...execution, signal: nextTurn.signal });
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(requests).toContain('GET /background-request');
    const requestIndex = network.findIndex(request => request.url === `${url}/background-request`);
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(networkSignals[requestIndex]).not.toBe(firstTurn.signal);
    expect(networkSignals[requestIndex]).not.toBe(nextTurn.signal);
  }, 30_000);

  it('bounds snapshot output and never executes a denied action', async () => {
    const { browser, url } = await fixture((path, response) => {
      if (path !== '/large') return false;
      response.setHeader('Content-Type', 'text/html');
      response.end(`<body>${'<button>item</button>'.repeat(200)}${'long text '.repeat(3000)}</body>`); return true;
    });
    const opened = await call(browser, 'browser_open', { url: `${url}/large` });
    const snapshot = await call(browser, 'browser_snapshot', { pageId: opened.pageId });
    expect((snapshot.elements as unknown[]).length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(7000);
    expect(snapshot.truncated).toBe(true);
    const denied = new SessionBrowser({ networkAccess: async () => true, approve: async () => false }); browsers.push(denied);
    await expect(call(denied, 'browser_open', { url })).rejects.toMatchObject({ failureKind: 'denied' });
    await expect(call(denied, 'browser_snapshot', { pageId: 'invented' })).rejects.toThrow('页面不存在');
  }, 30_000);
});
