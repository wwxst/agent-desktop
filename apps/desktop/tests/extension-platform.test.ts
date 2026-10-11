import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { DesktopExtensions, readPlugin } from '../src/main/extensions.js';
import { ExtensionConnections } from '../src/main/extension-connections.js';
import { prepareExtensions, skillCatalog, selectSkills } from '../src/main/extension-runtime.js';
import { readDesktopDocument } from '../src/main/desktop-database.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temp() { const root = await mkdtemp(join(tmpdir(), 'extension-platform-')); directories.push(root); return root; }
async function market(root: string, name = 'test-market') {
  await mkdir(join(root, '.agents/plugins'), { recursive: true });
  await cp(resolve('apps/desktop/resources/plugins/video-editing'), join(root, 'plugins/video-editing'), { recursive: true });
  await writeFile(join(root, '.agents/plugins/marketplace.json'), JSON.stringify({ name, plugins: [{ name: 'video-editing', source: './plugins/video-editing', category: 'Creativity' }] }));
}
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('服务地址无效');
  return `http://127.0.0.1:${address.port}`;
}
const secureStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')), decryptString: (value: Buffer) => value.toString().split('').reverse().join('') };

describe('Desktop plugin platform boundaries', () => {
  it('persists standalone MCP servers with encrypted secrets, edits without disclosure and removes them', async () => {
    const root = await temp(); const database = join(root, 'db.sqlite');
    const connections = new ExtensionConnections(database, secureStorage, async () => undefined);
    const store = new DesktopExtensions(database, join(root, 'extensions'), resolve('apps/desktop/resources'), connections);
    const config = { name: 'local-tools', transport: 'stdio' as const, command: 'node', args: ['server.mjs'], url: '', environment: { TOKEN: 'standalone-secret-value' }, headers: {} };
    store.saveMcpServer(config);
    const snapshot = await store.list(); const saved = snapshot.mcpServers![0]!;
    expect(saved).toMatchObject({ name: 'local-tools', enabled: true, environmentNames: ['TOKEN'] });
    expect(snapshot.plugins.every(plugin => plugin.id !== saved.id)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('standalone-secret-value');
    expect((await readFile(database)).includes(Buffer.from('standalone-secret-value'))).toBe(false);
    const restored = new DesktopExtensions(database, join(root, 'extensions'), resolve('apps/desktop/resources'), connections);
    restored.saveMcpServer({ ...config, id: saved.id, command: 'npx', environment: { TOKEN: '' } });
    expect((await restored.files(root)).mcpServers[0]).toMatchObject({ directory: root, server: { command: 'npx', env: { TOKEN: 'standalone-secret-value' } } });
    expect(() => restored.saveMcpServer(config)).toThrow('已经存在');
    expect(() => restored.saveMcpServer({ ...config, transport: 'http', url: 'file:///tmp/mcp' })).toThrow('HTTP');
    restored.setMcpEnabled(saved.id, false);
    expect((await restored.files()).mcpServers[0]?.enabled).toBe(false);
    restored.saveMcpServer({ ...config, id: saved.id, transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer header-secret-value' } });
    expect((await restored.list()).mcpServers![0]).toMatchObject({ enabled: false, transport: 'http', headerNames: ['Authorization'], environmentNames: [] });
    expect(JSON.stringify(await restored.list())).not.toContain('header-secret-value');
    expect((await restored.files()).mcpServers[0]?.server.headers).toEqual({ Authorization: 'Bearer header-secret-value' });
    restored.removeMcpServer(saved.id);
    expect((await restored.list()).mcpServers).toEqual([]);
    expect((await restored.files()).mcpServers).toEqual([]);
  });
  it('uses real market copies, updates and rolls back versions while preserving enabled policy', async () => {
    const root = await temp(); const source = join(root, 'source'); await market(source);
    const store = new DesktopExtensions(join(root, 'db.sqlite'), join(root, 'extensions'), resolve('apps/desktop/resources'));
    await store.addMarketplace(source);
    const id = 'plugin:video-editing@test-market';
    expect((await store.list()).plugins.find(plugin => plugin.id === id)).toMatchObject({ installed: false, category: 'Creativity' });
    await store.install(id); await store.setEnabled(id, false);
    const manifest = join(source, 'plugins/video-editing/.codex-plugin/plugin.json');
    const previous = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>; await writeFile(manifest, JSON.stringify({ ...previous, version: '2.0.0' }));
    // 详情的检查更新必须自己刷新来源，不能要求用户先点击全局刷新。
    await store.update(id);
    expect((await store.list()).plugins.find(plugin => plugin.id === id)).toMatchObject({ version: '2.0.0', enabled: false });
    const version = store.versions(id)[0]!;
    await store.rollback(id, version.id);
    expect((await store.list()).plugins.find(plugin => plugin.id === id)).toMatchObject({ version: '1.2.0', enabled: false });
    await store.removeMarketplace('test-market');
    expect((await store.files()).plugins[0]?.item.installed).toBe(true);
    await store.uninstall(id);
    expect((await store.files()).plugins).toHaveLength(0);
  });

  it('preserves a usable install on malformed updates and keeps same-name plugins from two markets distinct', async () => {
    const root = await temp(); const first = join(root, 'first'); const second = join(root, 'second');
    await market(first, 'first'); await market(second, 'second');
    const store = new DesktopExtensions(join(root, 'db.sqlite'), join(root, 'extensions'), resolve('apps/desktop/resources'));
    await store.addMarketplace(first); await store.addMarketplace(second);
    await store.install('plugin:video-editing@first'); await store.install('plugin:video-editing@second');
    await writeFile(join(first, 'plugins/video-editing/.mcp.json'), '{invalid');
    await store.reconcile();
    await expect(store.update('plugin:video-editing@first')).rejects.toThrow();
    expect((await store.files()).plugins).toHaveLength(2);
    expect(store.versions('plugin:video-editing@first')).toHaveLength(0);
  });

  it('consumes full interface assets and keeps secrets out of the renderer snapshot', async () => {
    const root = await temp(); const source = join(root, 'plugin');
    await mkdir(join(source, '.codex-plugin'), { recursive: true }); await mkdir(join(source, 'assets'));
    await writeFile(join(source, 'assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(source, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'interface-test', description: 'test', interface: { displayName: '测试', developerName: '作者', category: 'Creativity', longDescription: '完整描述', brandColor: '#334455', logo: './assets/logo.svg', screenshots: ['./assets/logo.svg'], websiteURL: 'https://example.com', defaultPrompt: ['指令一', '指令二'] }, mcpServers: { local: { command: 'node', env: { TOKEN: '${TEST_TOKEN}' } } } }));
    const database = join(root, 'db.sqlite'); const connections = new ExtensionConnections(database, secureStorage, async () => undefined);
    const store = new DesktopExtensions(database, join(root, 'extensions'), resolve('apps/desktop/resources'), connections);
    await store.importDirectory('plugin', source);
    await store.configure('plugin:interface-test', 'local', { TEST_TOKEN: 'never-in-renderer' });
    const snapshot = await store.list(); const item = snapshot.plugins.find(plugin => plugin.id === 'plugin:interface-test')!;
    expect(item).toMatchObject({ developerName: '作者', longDescription: '完整描述', category: 'Creativity', defaultPrompts: ['指令一', '指令二'] });
    expect(item.logo).toContain('data:image/svg+xml;base64,');
    expect(JSON.stringify(snapshot)).not.toContain('never-in-renderer');
    expect(JSON.stringify(readDesktopDocument(database, 'extension-secret:plugin:interface-test/local'))).not.toContain('never-in-renderer');
    expect((await store.files()).plugins[0]?.servers[0]?.env?.TOKEN).toBe('never-in-renderer');
    expect(item.connections?.[0]?.variables).toEqual(['TEST_TOKEN']);
  });

  it('keeps an explicitly named skill first within the character budget', () => {
    const skills = Array.from({ length: 30 }, (_, index) => ({ directory: 'unused', item: { id: `skill:${index}`, name: `skill-${index}`, description: 'x'.repeat(600), kind: 'skill' as const, source: 'local' as const, installed: true, enabled: true } }));
    const rendered = skillCatalog(selectSkills(skills, '$skill-29'));
    expect(rendered.length).toBeLessThanOrEqual(8000); expect(JSON.parse(rendered.split('\n')[0]!).id).toBe('skill:29');
  });

  it('reads Agent Plugins v1, shared skill icons and an unrelated root manifest with a valid legacy overlay', async () => {
    const root = await temp(); const source = join(root, 'standard');
    await mkdir(join(source, 'skills/review/agents'), { recursive: true }); await mkdir(join(source, 'assets'));
    await writeFile(join(source, 'assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(source, 'skills/review/SKILL.md'), '---\nname: review\ndescription: review files\n---\nshared-icon-body');
    await writeFile(join(source, 'skills/review/agents/openai.yaml'), 'interface:\n  icon_small: ../../assets/logo.svg\n');
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'com.example.review', version: '1.0', description: 'standard', author: { name: '作者' } }));
    await writeFile(join(source, 'mcp.json'), JSON.stringify({ mcpServers: { remote: { url: 'https://example.com/mcp' } } }));
    const store = new DesktopExtensions(join(root, 'db.sqlite'), join(root, 'extensions'), resolve('apps/desktop/resources'));
    await store.importDirectory('plugin', source);
    expect((await store.list()).skills[0]?.logo).toContain('data:image/svg+xml');
    expect(await store.readSkill('plugin:com.example.review/review')).toContain('shared-icon-body');
    expect(await store.readDetail('plugin:com.example.review/review')).toContain('shared-icon-body');
    expect((await store.files()).plugins[0]?.servers[0]?.type).toBe('http');
    await mkdir(join(source, '.codex-plugin'));
    await writeFile(join(source, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'legacy', description: 'legacy', skills: './skills' }));
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ name: 'business-config' }));
    expect((await readPlugin(source, 'plugin:legacy', 'local')).name).toBe('legacy');
  });

  it('configures and disconnects project skill dependencies using the active working directory', async () => {
    const root = await temp(); const project = join(root, 'project'); const skill = join(project, '.agents/skills/review');
    await mkdir(join(skill, 'agents'), { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: review\ndescription: review files\n---\nbody');
    await writeFile(join(skill, 'agents/openai.yaml'), 'dependencies:\n  tools:\n    - type: mcp\n      value: remote\n      url: https://example.com/mcp\n      transport: streamable_http\n');
    const database = join(root, 'db.sqlite'); const connections = new ExtensionConnections(database, secureStorage, async () => undefined);
    const store = new DesktopExtensions(database, join(root, 'extensions'), resolve('apps/desktop/resources'), connections);
    await store.configure('project/review', 'remote', { url: 'https://example.net/mcp' }, project);
    expect((await store.files(project)).skills[0]?.toolDependencies?.[0]?.url).toBe('https://example.net/mcp');
    await store.connect('project/review', 'remote', true, project);
    expect((await store.list(project)).skills[0]?.connections?.[0]).toMatchObject({ connected: false, url: 'https://example.net/mcp' });
  });

  it('only recommends user-added marketplace packages and keeps installs when that source is removed', async () => {
    const root = await temp(); const source = join(root, 'market'); const resources = join(root, 'resources');
    await cp(resolve('apps/desktop/resources'), resources, { recursive: true }); await market(source, 'openai-curated');
    const store = new DesktopExtensions(join(root, 'db.sqlite'), join(root, 'extensions'), resources);
    expect((await store.list()).plugins.map(item => item.id)).toEqual(['plugin:video-editing']);
    await store.addMarketplace(source);
    expect((await store.list()).plugins.some(item => item.id === 'plugin:video-editing@openai-curated' && !item.installed)).toBe(true);
    await store.install('plugin:video-editing@openai-curated');
    expect((await store.list()).plugins.find(item => item.id === 'plugin:video-editing@openai-curated')?.availableVersion).toBeUndefined();
    await store.removeMarketplace('openai-curated');
    expect((await store.list()).plugins.find(item => item.id === 'plugin:video-editing@openai-curated')?.installed).toBe(true);
  });

  for (const protocol of ['http', 'sse'] as const) for (const source of ['plugin', 'standalone'] as const) it(`runs real ${protocol} MCP tools from ${source} with independent approvals and shutdown`, async () => {
    const root = await temp(); const sdk = new McpServer({ name: 'remote-test', version: '1.0.0' });
    sdk.registerTool('echo', {}, async () => ({ content: [{ type: 'text', text: 'real-remote-result' }] }));
    let transport: StreamableHTTPServerTransport | SSEServerTransport;
    const server = createServer(async (request, response) => {
      try {
        if (protocol === 'sse' && request.method === 'GET') { transport = new SSEServerTransport('/messages', response); await sdk.connect(transport); return; }
        if (protocol === 'sse') { await (transport as SSEServerTransport).handlePostMessage(request, response); return; }
        let body = ''; for await (const chunk of request) body += String(chunk);
        await (transport as StreamableHTTPServerTransport).handleRequest(request, response, body ? JSON.parse(body) : undefined);
      } catch (error) { response.writeHead(500).end(String(error)); }
    });
    const base = await listen(server);
    if (protocol === 'http') { transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'test-session' }); await sdk.connect(transport as Parameters<McpServer['connect']>[0]); }
    const plugin = { name: 'remote', directory: root, skills: [], servers: [{ name: 'service', type: protocol, url: `${base}/${protocol === 'sse' ? 'sse' : 'mcp'}`, command: '', args: [] }], item: { id: 'plugin:remote', name: 'remote', description: 'test', kind: 'plugin' as const, source: 'local' as const, enabled: true, installed: true } };
    const approvals = vi.fn(async () => true); let runtime: Awaited<ReturnType<typeof prepareExtensions>> | undefined;
    try {
      runtime = await prepareExtensions({ plugins: source === 'plugin' ? [plugin] : [], skills: [], mcpServers: source === 'standalone' ? [{ id: 'mcp:remote', enabled: true, directory: root, server: plugin.servers[0]! }] : [] }, approvals);
      const result = await runtime.tools[0]!.execute({}, { toolCallId: 'remote' as never, reportProgress: () => undefined });
      expect(JSON.stringify(result)).toContain('real-remote-result');
      expect(approvals.mock.calls).toHaveLength(2);
    } finally { await runtime?.close(); await sdk.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('executes trusted lifecycle hooks and never executes a rejected hook', async () => {
    const root = await temp(); const script = join(root, 'hook.cjs'); const output = join(root, 'events.jsonl');
    await writeFile(script, `const fs = require('node:fs'); let data = ''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => fs.appendFileSync(${JSON.stringify(output)}, data + '\\n'));`);
    const plugin = { name: 'hooks', directory: root, skills: [], servers: [], item: { id: 'plugin:hooks', kind: 'plugin' as const, name: 'hooks', description: 'hooks', source: 'local' as const, enabled: true, installed: true }, hooks: [{ event: 'UserPromptSubmit', command: `"${process.execPath}" "${script}"`, timeoutMs: 10_000 }, { event: 'SessionStart', matcher: '^startup$', command: `"${process.execPath}" "${script}"`, timeoutMs: 10_000 }] };
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => true);
    const denied = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => false);
    try {
      await runtime.runHooks('UserPromptSubmit', { prompt: 'real-hook' });
      await denied.runHooks('UserPromptSubmit', { prompt: 'rejected' });
      await runtime.runHooks('SessionStart', { source: 'startup' });
      await runtime.runHooks('SessionStart', { source: 'resume' });
      const events = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(events).toEqual([
        expect.objectContaining({ hook_event_name: 'UserPromptSubmit', prompt: 'real-hook' }),
        expect.objectContaining({ hook_event_name: 'SessionStart', source: 'startup' }),
      ]);
    }
    finally { await runtime.close(); await denied.close(); }
  });

  for (const mode of ['cancel', 'timeout'] as const) it(`cleans up the real hook shell and its descendants on ${mode}`, async () => {
    const root = await temp(); const script = join(root, 'parent.cjs'); const pidPath = join(root, 'child.pid');
    await writeFile(script, `const {spawn} = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e','setInterval(() => {}, 1000)'], {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); setInterval(() => {}, 1000);`);
    const plugin = { name: 'hook-tree', directory: root, skills: [], servers: [], item: { id: 'plugin:hook-tree', kind: 'plugin' as const, name: 'hook-tree', description: 'hooks', source: 'local' as const, enabled: true, installed: true }, hooks: [{ event: 'Stop', command: `"${process.execPath}" "${script}"`, timeoutMs: mode === 'timeout' ? 1500 : 10_000 }] };
    const controller = new AbortController(); const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => true, controller.signal);
    const running = runtime.runHooks('Stop', {}); void running.catch(() => undefined); let pid: number | undefined;
    try {
      await vi.waitFor(async () => { pid = Number(await readFile(pidPath, 'utf8')); expect(pid).toBeGreaterThan(0); });
      if (mode === 'cancel') controller.abort(new Error('test-hook-cancel'));
      await expect(running).rejects.toThrow(mode === 'cancel' ? 'test-hook-cancel' : '超时');
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
    } finally {
      controller.abort(); await runtime.close();
      if (pid !== undefined) { try { process.kill(pid, 0); if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else process.kill(pid, 'SIGKILL'); } catch {} }
    }
  });

  it('completes SDK OAuth discovery, registration and PKCE with encrypted persistent tokens', async () => {
    const root = await temp(); let base = ''; let challenge = ''; let exchanged = false;
    const server = createServer(async (request, response) => {
      const path = request.url!; let body = ''; for await (const chunk of request) body += String(chunk);
      response.setHeader('Content-Type', 'application/json');
      if (path.startsWith('/.well-known/oauth-protected-resource')) response.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
      else if (path.startsWith('/.well-known/oauth-authorization-server')) response.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'] }));
      else if (path === '/register') response.end(JSON.stringify({ ...JSON.parse(body), client_id: 'test-client' }));
      else if (path === '/token') {
        const params = new URLSearchParams(body); expect(params.get('code')).toBe('test-code'); expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(challenge); exchanged = true;
        response.end(JSON.stringify({ access_token: 'persistent-secret-token', token_type: 'Bearer', refresh_token: 'refresh-secret-token', expires_in: 3600 }));
      } else response.writeHead(404).end('{}');
    });
    base = await listen(server);
    const database = join(root, 'db.sqlite'); const connections = new ExtensionConnections(database, secureStorage, async authorization => {
      const url = new URL(authorization); challenge = url.searchParams.get('code_challenge')!;
      const callback = new URL(url.searchParams.get('redirect_uri')!); callback.searchParams.set('code', 'test-code'); callback.searchParams.set('state', url.searchParams.get('state')!);
      expect((await fetch(callback)).ok).toBe(true);
    });
    try {
      await connections.authorize('plugin:test', 'service', `${base}/mcp`);
      expect(exchanged).toBe(true); expect(connections.connected('plugin:test', 'service', `${base}/mcp`)).toBe(true);
      const restored = new ExtensionConnections(database, secureStorage, async () => undefined);
      expect(await restored.provider('plugin:test', 'service', `${base}/mcp`).tokens()).toMatchObject({ access_token: 'persistent-secret-token' });
      expect(JSON.stringify(readDesktopDocument(database, `extension-secret:plugin:test/service/${base}/mcp`))).not.toContain('persistent-secret-token');
      restored.disconnect('plugin:test', 'service', `${base}/mcp`); expect(restored.connected('plugin:test', 'service', `${base}/mcp`)).toBe(false);
      let callbackUrl = '';
      const waiting = new ExtensionConnections(database, secureStorage, async authorization => {
        callbackUrl = new URL(authorization).searchParams.get('redirect_uri')!;
        waiting.cancel('plugin:waiting', 'service');
      });
      await expect(waiting.authorize('plugin:waiting', 'service', `${base}/mcp`)).rejects.toThrow('账户授权已取消');
      expect(waiting.connected('plugin:waiting', 'service', `${base}/mcp`)).toBe(false);
      // 取消后回调端口真实关闭，不留下等待中的本地服务器。
      await expect(fetch(callbackUrl)).rejects.toThrow();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
