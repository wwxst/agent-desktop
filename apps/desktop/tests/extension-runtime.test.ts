import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTurn } from '@agent-desktop/agent-loop';
import type { Model } from '@agent-desktop/model';
import { InMemorySession } from '@agent-desktop/session';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { prepareExtensions, selectSkills } from '../src/main/extension-runtime.js';
import { readPlugin, readSkill, type PluginFiles } from '../src/main/extensions.js';

const temporary: string[] = [];
async function temp() { const path = await mkdtemp(join(tmpdir(), 'extension-runtime-')); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function plugin(): Promise<PluginFiles> {
  const directory = await temp();
  await build({ entryPoints: [resolve('apps/desktop/tests/fixtures/extension-server.mjs')], outfile: join(directory, 'server.mjs'), bundle: true, platform: 'node', format: 'esm' });
  return { name: 'test', directory, skills: [], servers: [{ name: 'local', command: 'node', args: ['${PLUGIN_ROOT}/server.mjs', '${PLUGIN_ROOT}/waiting'] }],
    item: { id: 'plugin:test', kind: 'plugin', name: 'test', description: 'test', source: 'local', enabled: true, installed: true } };
}

describe('actual extension runtime tool chain', () => {
  it('discovers and loads the bundled short drama skill through a real turn', async () => {
    const bundled = await readPlugin(resolve('apps/desktop/resources/plugins/video-editing'), 'plugin:video-editing', 'builtin');
    const runtime = await prepareExtensions({ plugins: [bundled], skills: bundled.skills }, async () => true, undefined, '$short-drama-editing 剪辑冲突对白');
    const complete = vi.fn<Model['complete']>(async request => request.messages.some(message => message.role === 'tool')
      ? { text: '短剧技能已加载', toolCalls: [] }
      : { toolCalls: [{ id: 'short-drama' as never, name: 'load_skill', input: { id: 'plugin:video-editing/short-drama-editing' } }] });
    const tools = new InMemoryToolRegistry();
    runtime.tools.forEach(tool => tools.register(tool));
    try {
      await runTurn({ model: { complete }, tools, session: new InMemorySession(), systemPrompt: { build: () => runtime.instructions } }, '$short-drama-editing 剪辑冲突对白');
      expect(complete.mock.calls[0]?.[0].systemPrompt).toContain('short-drama-editing');
      expect(complete.mock.calls[0]?.[0].systemPrompt).not.toContain('开场钩子');
      const result = complete.mock.calls[1]?.[0].messages.find(message => message.role === 'tool')?.content;
      expect(result).toContain('开场钩子');
      expect(result).toContain('validate_video_candidate');
      expect(result).toContain('publish_video_output');
    } finally { await runtime.close(); }
  });

  it('ranks a bounded catalog while preserving explicit skill selection', async () => {
    const skills = await Promise.all(['alpha', 'short-drama-editing', 'other'].map(async name => {
      const directory = await temp();
      await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name === 'short-drama-editing' ? '短剧剪辑' : '普通任务'}\n---\nbody`);
      return readSkill(directory, `skill:${name}`, 'local');
    }));
    const selected = selectSkills(await Promise.all(skills), '$short-drama-editing', 2);
    expect(selected[0]?.item.name).toBe('short-drama-editing');
    expect(selected).toHaveLength(2);
  });

  it('keeps explicit-only skills out of automatic discovery but allows a named invocation', async () => {
    const directory = await temp();
    await writeFile(join(directory, 'SKILL.md'), '---\nname: review\ndescription: 检查文件\n---\nbody');
    const source = await readSkill(directory, 'skill:review', 'local');
    const skill = { ...source, item: { ...source.item, allowImplicitInvocation: false } };
    const automatic = await prepareExtensions({ plugins: [], skills: [skill] }, async () => true, undefined, '检查文件');
    const explicit = await prepareExtensions({ plugins: [], skills: [skill] }, async () => true, undefined, '$REVIEW 检查文件');
    try {
      expect(automatic.tools).toHaveLength(0);
      expect(automatic.instructions).toBe('');
      expect(explicit.tools[0]?.name).toBe('load_skill');
      expect(explicit.instructions).toContain('skill:review');
    } finally { await automatic.close(); await explicit.close(); }
  });

  it('matches explicit Unicode and spaced names without matching a longer skill name', async () => {
    const directory = await temp();
    await writeFile(join(directory, 'SKILL.md'), '---\nname: 文档 Review\ndescription: 检查文件\n---\nbody');
    const source = await readSkill(directory, 'skill:review', 'local');
    const skill = { ...source, item: { ...source.item, allowImplicitInvocation: false } };
    const named = await prepareExtensions({ plugins: [], skills: [skill] }, async () => true, undefined, '$文档 Review 检查');
    const longer = await prepareExtensions({ plugins: [], skills: [skill] }, async () => true, undefined, '$文档 Reviewer 检查');
    try { expect(named.tools).toHaveLength(1); expect(longer.tools).toHaveLength(0); }
    finally { await named.close(); await longer.close(); }
  });

  it('loads skill instructions through a real multi-step turn and omits disabled skills', async () => {
    const directory = await temp();
    await writeFile(join(directory, 'SKILL.md'), '---\nname: inspect\ndescription: 检查配置\n---\n\nOnly report real findings.');
    const skill = await readSkill(directory, 'skill:inspect', 'local');
    const runtime = await prepareExtensions({ plugins: [], skills: [skill] }, async () => true);
    const complete = vi.fn<Model['complete']>(async request => request.messages.some(message => message.role === 'tool')
      ? { text: 'verified', toolCalls: [] } : { toolCalls: [{ id: 'load' as never, name: 'load_skill', input: { id: skill.item.id } }] });
    const tools = new InMemoryToolRegistry();
    runtime.tools.forEach(tool => tools.register(tool));
    try {
      const result = await runTurn({ model: { complete }, tools, session: new InMemorySession(), systemPrompt: { build: () => runtime.instructions } }, '$inspect 检查配置');
      expect(result.stepCount).toBe(2);
      expect(complete.mock.calls[0]?.[0].systemPrompt).not.toContain('Only report real findings.');
      expect(complete.mock.calls[1]?.[0].messages.find(message => message.role === 'tool')?.content).toContain('Only report real findings.');
      const disabled = await prepareExtensions({ plugins: [], skills: [{ ...skill, item: { ...skill.item, enabled: false } }] }, async () => true);
      expect(disabled.tools).toHaveLength(0);
      expect(disabled.instructions).toBe('');
      await disabled.close();
    } finally { await runtime.close(); }
  });

  it('starts a real SDK server, approves each call and stops its process on close', async () => {
    const files = await plugin();
    const approve = vi.fn<Parameters<typeof prepareExtensions>[1]>(async () => true);
    const runtime = await prepareExtensions({ plugins: [files], skills: [] }, approve);
    let pid: number | undefined;
    try {
      const tool = runtime.tools.find(tool => tool.name === 'p_test_local_echo')!;
      const result = await tool.execute({ text: 'hello' }, { toolCallId: 'echo' as never, reportProgress: () => {} });
      expect(result.status).toBe('success');
      if (result.status !== 'success') throw new Error(result.message);
      const output = result.output as { content: { text: string }[] };
      const payload = JSON.parse(output.content[0]!.text) as { pid: number; text: string };
      expect(payload.text).toBe('hello');
      pid = payload.pid;
      expect(approve.mock.calls).toHaveLength(2);
      expect(approve.mock.calls[0]?.[0]).toMatchObject({ kind: 'plugin-start', workingDirectory: files.directory });
      expect(approve.mock.calls[1]?.[0]).toMatchObject({ kind: 'plugin-tool', toolName: 'echo', arguments: '{"text":"hello"}' });
    } finally { await runtime.close(); }
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it('runs an enabled standalone server through real SDK approvals and excludes disabled servers', async () => {
    const files = await plugin(); const server = files.servers[0]!;
    const disabled = await prepareExtensions({ plugins: [], skills: [], mcpServers: [{ id: 'mcp:test', enabled: false, directory: files.directory, server }] }, async () => true);
    expect(disabled.tools).toHaveLength(0); await disabled.close();
    const approve = vi.fn<Parameters<typeof prepareExtensions>[1]>(async () => true);
    const runtime = await prepareExtensions({ plugins: [], skills: [], mcpServers: [{ id: 'mcp:test', enabled: true, directory: files.directory, server }] }, approve);
    let pid = 0;
    try {
      const result = await runtime.tools[0]!.execute({ text: 'standalone-result' }, { toolCallId: 'standalone' as never, reportProgress: () => {} });
      if (result.status !== 'success') throw new Error(result.message);
      const value = JSON.parse((result.output as { content: { text: string }[] }).content[0]!.text) as { text: string; pid: number };
      expect(value.text).toBe('standalone-result'); pid = value.pid;
      expect(approve.mock.calls.map(([request]) => request.kind)).toEqual(['plugin-start', 'plugin-tool']);
    } finally { await runtime.close(); }
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('does not spawn a denied plugin and returns a denied tool without calling the server', async () => {
    const files = await plugin();
    const denied = await prepareExtensions({ plugins: [files], skills: [] }, async () => false);
    expect(denied.tools).toHaveLength(0);
    await denied.close();
    const runtime = await prepareExtensions({ plugins: [files], skills: [] }, async request => request.kind === 'plugin-start');
    try { expect(await runtime.tools[0]!.execute({}, { toolCallId: 'deny' as never, reportProgress: () => {} })).toMatchObject({ status: 'error', message: '用户拒绝了插件工具调用。' }); }
    finally { await runtime.close(); }
  });

  it('cancels an outstanding real MCP request and exits the process', async () => {
    const files = await plugin();
    const controller = new AbortController();
    const runtime = await prepareExtensions({ plugins: [files], skills: [] }, async () => true, controller.signal);
    try {
      const context = { signal: controller.signal, toolCallId: 'cancel' as never, reportProgress: () => {} };
      const echo = await runtime.tools[0]!.execute({}, context);
      if (echo.status !== 'success') throw new Error(echo.message);
      const pid = JSON.parse((echo.output as { content: { text: string }[] }).content[0]!.text).pid as number;
      const pending = runtime.tools.find(tool => tool.name.endsWith('_wait'))!.execute({}, context);
      await vi.waitFor(async () => expect(await readFile(join(files.directory, 'waiting'), 'utf8')).toBe('waiting'));
      controller.abort();
      await expect(pending).rejects.toThrow();
      await runtime.close();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await runtime.close(); }
  });
});
