import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopExtensions, readPlugin } from '../src/main/extensions.js';
import { readDesktopDocument } from '../src/main/desktop-database.js';

// 只替换真实文件系统边界的 rename，其他读写与数据库保持真实。
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const temporary: string[] = [];
const resources = resolve('apps/desktop/resources');
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agent-extensions-'));
  temporary.push(root);
  const database = join(root, 'agent-desktop.sqlite');
  return { root, database, store: new DesktopExtensions(database, join(root, 'extensions'), resources) };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('Desktop extensions persisted local packages', () => {
  it('separates media tools from skills and upgrades old skills without losing history or disabled policy', async () => {
    const { root, database, store } = await setup();
    await store.install('plugin:video-editing');
    await store.setEnabled('plugin:video-editing/short-drama-editing', false);
    const manifest = join(root, 'extensions/plugins/video-editing/.codex-plugin/plugin.json');
    const old = JSON.parse(await readFile(manifest, 'utf8'));
    await writeFile(manifest, JSON.stringify({ ...old, version: '1.2.0', mcpServers: './.mcp.json' }));
    await writeFile(join(root, 'extensions/plugins/video-editing/.mcp.json'), JSON.stringify({ mcpServers: { 'ffmpeg-probe': { command: 'node', args: ['legacy.cjs'] } } }));
    const state = readDesktopDocument(database, 'extensions') as { installed: { id: string; version: string }[]; disabled: string[] };
    const { writeDesktopDocuments } = await import('../src/main/desktop-database.js');
    writeDesktopDocuments(database, [{ name: 'extensions', value: { ...state, installed: state.installed.map(entry => ({ ...entry, version: '1.2.0' })) } }, { name: 'runtime-settings', value: { text: 'keep settings' } }]);
    expect((await store.list()).plugins.find(item => item.id === 'plugin:video-editing')?.availableVersion).toBe('1.3.0');
    await store.update('plugin:video-editing');
    expect((await store.files()).plugins[0]?.servers).toEqual([]);
    expect((await store.list()).skills.find(item => item.name === 'short-drama-editing')?.enabled).toBe(false);
    expect(store.versions('plugin:video-editing')[0]?.version).toBe('1.2.0');
    expect(readDesktopDocument(database, 'runtime-settings')).toEqual({ text: 'keep settings' });
    const ffmpeg = await readPlugin(join(resources, 'plugins/ffmpeg'), 'plugin:ffmpeg', 'builtin');
    expect(ffmpeg.skills).toEqual([]);
    expect(ffmpeg.servers[0]?.name).toBe('ffmpeg');
    const restored = new DesktopExtensions(database, join(root, 'extensions'), resources);
    expect((await restored.list()).errors?.join(' ')).toContain('独立 FFmpeg');
  });
  it('notifies when an installed skill is edited outside the application and closes the watcher', async () => {
    const { root, store } = await setup();
    await store.install('skill:local-file-review');
    const changed = vi.fn();
    const failed = vi.fn();
    try {
      await store.watchSkills(undefined, changed, failed);
      const path = join(root, 'extensions/skills/local-file-review/SKILL.md');
      await writeFile(path, '---\nname: local-file-review\ndescription: 外部修改\n---\nnew body');
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      expect((await store.listSkills())[0]?.description).toBe('外部修改');
      expect(failed).not.toHaveBeenCalled();
    } finally { store.stopWatching(); }
  });

  it('watches creation of project skill roots and rebinds when the workspace changes', async () => {
    const { root, store } = await setup();
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    const changed = vi.fn();
    try {
      await store.watchSkills(first, changed, error => { throw error; });
      await mkdir(join(first, '.agents/skills/review'), { recursive: true });
      await writeFile(join(first, '.agents/skills/review/SKILL.md'), '---\nname: review\ndescription: 项目技能\n---\nbody');
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      await store.watchSkills(first, changed, error => { throw error; });
      await store.watchSkills(second, changed, error => { throw error; });
      changed.mockClear();
      await writeFile(join(first, '.agents/skills/review/SKILL.md'), '---\nname: review\ndescription: 旧项目修改\n---\nbody');
      await mkdir(join(second, '.agents'));
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    } finally { store.stopWatching(); }
  });
  it('installs bundled packages, restores disabled state and removes child skills on uninstall', async () => {
    const { root, database, store } = await setup();
    const initial = await store.list();
    expect(initial.plugins.map(item => item.id)).toEqual(['plugin:video-editing', 'plugin:ffmpeg']);
    expect(initial.plugins[0]?.installed).toBe(false);
    expect(initial.marketplaces).toEqual([]);
    const preview = initial.skills.find(item => item.name === 'short-drama-editing')!;
    expect(preview).toMatchObject({ installed: false, enabled: false, pluginId: 'plugin:video-editing' });
    expect(await store.readSkill(preview.id)).toContain('开场钩子');
    expect(await store.skillPath(preview.id)).toContain('SKILL.md');
    await expect(store.skillPath('D:/private/SKILL.md')).rejects.toThrow('找不到技能');
    await store.install('plugin:video-editing');
    await store.install('skill:local-file-review');
    let snapshot = await store.list();
    expect(snapshot.skills.find(item => item.pluginId !== undefined)?.enabled).toBe(true);
    expect(snapshot.plugins.find(item => item.id === 'plugin:video-editing')?.skillNames).toEqual(['semantic-editing', 'short-drama-editing']);
    expect((await store.files()).plugins[0]?.servers).toEqual([]);
    expect(snapshot.errors?.join(' ')).toContain('独立 FFmpeg');
    expect(snapshot.skills.find(item => item.name === 'short-drama-editing')?.description).toContain('短剧');
    expect(await store.skillPath(preview.id)).toBe(join(root, 'extensions/plugins/video-editing/skills/short-drama-editing/SKILL.md'));
    await store.setEnabled('plugin:video-editing', false);
    const restored = new DesktopExtensions(database, join(root, 'extensions'), resources);
    snapshot = await restored.list();
    expect(snapshot.plugins[0]?.enabled).toBe(false);
    expect(snapshot.skills.find(item => item.pluginId !== undefined)?.enabled).toBe(false);
    await expect(restored.setEnabled('plugin:video-editing/semantic-editing', true)).rejects.toThrow('所属插件');
    await restored.uninstall('plugin:video-editing');
    expect((await restored.files()).skills.some(item => item.item.pluginId !== undefined)).toBe(false);
    expect(await restored.readDetail('skill:local-file-review')).toContain('delegate_tasks');
  });

  it('copies imported resources and resolves installations relative to the current computer', async () => {
    const { root, database, store } = await setup();
    const source = join(root, 'source');
    await cp(join(resources, 'skills/local-file-review'), source, { recursive: true });
    await store.importDirectory('skill', source);
    expect((await store.list()).skills.find(item => item.id === 'skill:local-file-review')?.source).toBe('local');
    await rm(source, { recursive: true });
    const state = JSON.stringify(readDesktopDocument(database, 'extensions'));
    expect(state).not.toContain(root);
    const relocated = join(root, 'relocated');
    await cp(join(root, 'extensions'), relocated, { recursive: true });
    const moved = new DesktopExtensions(database, relocated, resources);
    expect((await moved.files()).skills[0]?.directory).toBe(join(relocated, 'skills/local-file-review'));
    expect(await moved.readDetail('skill:local-file-review')).toContain('本地文件检查');
  });

  it('discovers project skills and persists their own enabled state without copying them', async () => {
    const { root, store } = await setup();
    const directory = join(root, '.agents/skills/review');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), '---\nname: review\ndescription: "检查: 文件"\n---\n\nproject instructions');
    expect((await store.list(root)).skills.find(item => item.id === 'project/review')?.description).toBe('检查: 文件');
    await store.setEnabled('project/review', false, root);
    expect((await store.files(root)).skills[0]?.item.enabled).toBe(false);
    await expect(store.uninstall('project/review')).rejects.toThrow('不能单独卸载');
  });

  it('recursively discovers nested skills, skips hidden directories and keeps bodies lazy', async () => {
    const { root, store } = await setup();
    const nested = join(root, '.agents/skills/series/episode-one');
    const hidden = join(root, '.agents/skills/.private');
    await mkdir(nested, { recursive: true });
    await mkdir(hidden, { recursive: true });
    await writeFile(join(nested, 'SKILL.md'), '---\nname: episode-one\ndescription: "短剧分集整理"\nmetadata:\n  short-description: "分集整理"\n---\n\nlong instructions');
    await writeFile(join(hidden, 'SKILL.md'), '---\nname: hidden\ndescription: hidden\n---\nsecret');
    const files = await store.files(root);
    const skill = files.skills.find(item => item.item.id === 'project/series/episode-one');
    expect(skill?.item.shortDescription).toBe('分集整理');
    expect(skill?.content).toBeUndefined();
    expect(files.skills.some(item => item.item.name === 'hidden')).toBe(false);
    expect(await store.readDetail('project/series/episode-one', root)).toContain('long instructions');
  });

  it('does not delete an existing destination on failed import and rejects invalid metadata', async () => {
    const { root, store } = await setup();
    const destination = join(root, 'extensions/skills/local-file-review');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'keep.txt'), 'keep');
    await expect(store.install('skill:local-file-review')).rejects.toThrow();
    expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('keep');
    const invalid = join(root, 'invalid');
    await mkdir(invalid);
    await writeFile(join(invalid, 'SKILL.md'), `---\nname: ${'a'.repeat(65)}\ndescription: bad\n---\nbody`);
    await expect(store.importDirectory('skill', invalid)).rejects.toThrow('名称');
  });

  it('lists metadata separately and reads the current skill body only when requested', async () => {
    const { root, store } = await setup();
    const directory = join(root, '.agents/skills/read-test');
    await mkdir(directory, { recursive: true });
    const metadata = '---\nname: read-test\ndescription: 本文读取测试\n---\n';
    await writeFile(join(directory, 'SKILL.md'), `${metadata}first body`);
    const listed = await store.listSkills(root);
    expect(listed.find(item => item.id === 'project/read-test')).toMatchObject({ name: 'read-test', description: '本文读取测试' });
    expect(JSON.stringify(listed)).not.toContain('first body');
    await writeFile(join(directory, 'SKILL.md'), `${metadata}changed body`);
    expect(await store.readSkill('project/read-test', root)).toContain('changed body');
    await expect(store.readSkill('project/missing', root)).rejects.toThrow('找不到技能');
  });

  it('reads Codex sidecar display metadata, invocation policy and tool dependency declarations', async () => {
    const { root, store } = await setup();
    const directory = join(root, '.agents/skills/review');
    await mkdir(join(directory, 'agents'), { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), '---\ndescription: |\n  检查文件\n  并报告证据\n---\nbody');
    await writeFile(join(directory, 'agents/openai.yaml'), 'interface:\n  display_name: 文件检查\n  short_description: 简短说明\n  default_prompt: 使用 $review 检查项目\npolicy:\n  allow_implicit_invocation: false\ndependencies:\n  tools:\n    - type: mcp\n      value: file-service\n      transport: streamable_http\n');
    expect((await store.listSkills(root)).find(item => item.id === 'project/review')).toMatchObject({
      name: 'review', description: '检查文件 并报告证据', displayName: '文件检查', shortDescription: '简短说明',
      defaultPrompt: '使用 $review 检查项目', allowImplicitInvocation: false, dependencies: ['mcp: file-service'],
    });
    expect(await store.readSkill('project/review', root)).toContain('body');
  });

  it('imports a Codex skill with a display-like name using a separate safe installation directory', async () => {
    const { root, store } = await setup();
    const directory = join(root, 'presentation-helper');
    await mkdir(directory);
    await writeFile(join(directory, 'SKILL.md'), '---\nname: Presentation Helper\ndescription: 准备幻灯片\n---\nbody');
    await store.importDirectory('skill', directory);
    expect((await store.listSkills()).find(item => item.id === 'skill:presentation-helper')).toMatchObject({ name: 'Presentation Helper', installed: true });
    expect(await store.readSkill('skill:presentation-helper')).toContain('body');
  });

  it('reconciles a new bundle version and preserves disabled plugin and skill state', async () => {
    const { root, database } = await setup();
    const bundles = join(root, 'bundles');
    await cp(resources, bundles, { recursive: true });
    const store = new DesktopExtensions(database, join(root, 'extensions'), bundles);
    await store.install('plugin:video-editing');
    await store.setEnabled('plugin:video-editing/short-drama-editing', false);
    await store.setEnabled('plugin:video-editing', false);
    const manifest = join(bundles, 'plugins/video-editing/.codex-plugin/plugin.json');
    const value = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>;
    value.version = '2.0.0';
    await writeFile(manifest, JSON.stringify(value));
    await writeFile(join(bundles, 'plugins/video-editing/skills/short-drama-editing/SKILL.md'), '---\nname: short-drama-editing\ndescription: 新短剧版本\n---\nupdated instructions');
    expect(await store.reconcile()).toEqual({ changed: ['plugin:video-editing'], failed: [] });
    expect((await store.list()).plugins[0]).toMatchObject({ version: '2.0.0', enabled: false });
    expect((await store.listSkills()).find(item => item.name === 'short-drama-editing')?.enabled).toBe(false);
    expect(await store.readSkill('plugin:video-editing/short-drama-editing')).toContain('updated instructions');
    expect(await store.reconcile()).toEqual({ changed: [], failed: [] });
  });

  it('keeps the installed version and database record when a new bundle fails validation', async () => {
    const { root, database } = await setup();
    const bundles = join(root, 'bundles');
    await cp(resources, bundles, { recursive: true });
    const store = new DesktopExtensions(database, join(root, 'extensions'), bundles);
    await store.install('plugin:video-editing');
    const previous = await store.readDetail('plugin:video-editing');
    const state = readDesktopDocument(database, 'extensions');
    await writeFile(join(bundles, 'plugins/video-editing/.codex-plugin/plugin.json'), '{invalid');
    const result = await store.reconcile();
    expect(result.changed).toEqual([]);
    expect(result.failed[0]?.id).toBe('plugin:video-editing');
    expect(await store.readDetail('plugin:video-editing')).toBe(previous);
    expect(readDesktopDocument(database, 'extensions')).toEqual(state);
  });

  it('restores the previous directory if publishing the staged bundle fails', async () => {
    const { root, database } = await setup();
    const bundles = join(root, 'bundles');
    await cp(resources, bundles, { recursive: true });
    const store = new DesktopExtensions(database, join(root, 'extensions'), bundles);
    await store.install('plugin:video-editing');
    const previous = await store.readDetail('plugin:video-editing');
    const manifest = join(bundles, 'plugins/video-editing/.codex-plugin/plugin.json');
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(previous), version: '2.0.0' }));
    const { rename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const publish = vi.mocked(filesystem.rename).mockImplementation(async (source, target) => {
      if (String(source).includes('.staging') && !String(source).endsWith('-old') && String(target).endsWith('video-editing')) throw new Error('发布被拒绝');
      await rename(source, target);
    });
    const result = await store.reconcile();
    publish.mockImplementation(rename);
    expect(result.failed).toEqual([{ id: 'plugin:video-editing', message: '发布被拒绝' }]);
    expect(await store.readDetail('plugin:video-editing')).toBe(previous);
    expect((await store.list()).plugins[0]?.version).toBe((JSON.parse(previous) as { version: string }).version);
  });

  it('repairs a missing bundled directory and clears a removed version field', async () => {
    const { root, database } = await setup();
    const bundles = join(root, 'bundles');
    await cp(resources, bundles, { recursive: true });
    const store = new DesktopExtensions(database, join(root, 'extensions'), bundles);
    await store.install('plugin:video-editing');
    await rm(join(root, 'extensions/plugins/video-editing'), { recursive: true });
    const manifest = join(bundles, 'plugins/video-editing/.codex-plugin/plugin.json');
    const value = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>;
    delete value.version;
    await writeFile(manifest, JSON.stringify(value));
    expect(await store.reconcile()).toEqual({ changed: ['plugin:video-editing'], failed: [] });
    expect((await store.list()).plugins[0]?.version).toBeUndefined();
    expect(await store.reconcile()).toEqual({ changed: [], failed: [] });
  });

  it('rejects escaping resources and accepts HTTP MCP and environment configuration', async () => {
    const { root } = await setup();
    const plugin = join(root, 'plugin');
    await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
    const manifest = { name: 'test', description: 'test', skills: '../outside' };
    await mkdir(join(root, 'outside'));
    await writeFile(join(plugin, '.codex-plugin/plugin.json'), JSON.stringify(manifest));
    await expect(readPlugin(plugin, 'plugin:test', 'local')).rejects.toThrow('超出');
    await writeFile(join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'test', description: 'test' }));
    for (const config of [{ type: 'http', url: 'https://example.com' }, { command: 'node', env: { TOKEN: 'test' } }]) {
      await writeFile(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { test: config } }));
      const parsed = await readPlugin(plugin, 'plugin:test', 'local');
      expect(parsed.servers[0]).toMatchObject('url' in config ? { ...config, url: new URL(config.url!).href } : config);
    }
  });

  it('accepts Codex manifest path arrays and inline MCP declarations', async () => {
    const { root } = await setup();
    const plugin = join(root, 'plugin-array');
    await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
    await mkdir(join(plugin, 'skills/one'), { recursive: true });
    await mkdir(join(plugin, 'skills/two'), { recursive: true });
    const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nbody`;
    await writeFile(join(plugin, 'skills/one/SKILL.md'), skill('one'));
    await writeFile(join(plugin, 'skills/two/SKILL.md'), skill('two'));
    await writeFile(join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'array-plugin', description: 'array', skills: ['./skills/one', './skills/two'], mcpServers: { inline: { type: 'stdio', command: 'node', args: [] } } }));
    const parsed = await readPlugin(plugin, 'plugin:array-plugin', 'local');
    expect(parsed.skills.map(item => item.item.name)).toEqual(['one', 'two']);
    expect(parsed.servers.map(item => item.name)).toEqual(['inline']);
  });
});
