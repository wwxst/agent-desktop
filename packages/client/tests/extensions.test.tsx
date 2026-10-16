// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExtensionClientApi, ExtensionSnapshot } from '../src/api.js';
import { ExtensionsPage } from '../src/components/ExtensionsPage.js';

afterEach(cleanup);
// jsdom 没有原生对话框顶层；这里只替换浏览器能力，技能和组件状态仍真实运行。
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; });

function setup() {
  let snapshot: ExtensionSnapshot = { plugins: [], skills: [] };
  let changed: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const api: ExtensionClientApi = {
    manage: async () => snapshot,
    list: vi.fn(async () => snapshot), listSkills: async () => snapshot.skills,
    importLocal: async () => null, install: async () => snapshot, setEnabled: async () => snapshot,
    uninstall: async () => snapshot, readDetail: vi.fn(async () => 'plugin manifest'),
    readSkill: vi.fn(async () => 'skill instructions'), reconcile: vi.fn(async () => snapshot),
    onChanged: listener => { changed = listener; return unsubscribe; },
  };
  return { api, unsubscribe, update(next: ExtensionSnapshot) { snapshot = next; changed!(); } };
}

describe('extension catalog notifications and separate skill reading', () => {
  it('shows real model progress with shared feedback and keeps cancellation silent', async () => {
    const host = setup();
    const whisper = { id: 'plugin:whisper', kind: 'plugin' as const, name: 'Whisper', description: '本地转录', source: 'builtin' as const, installed: true, enabled: true };
    const model = { name: 'Whisper Small', size: 487601967, diskBytes: 0, downloadedBytes: 0, status: 'missing' as const };
    let finish!: (value: ExtensionSnapshot | null) => void;
    host.api.manage = vi.fn(() => new Promise<ExtensionSnapshot | null>(resolve => { finish = resolve; }));
    render(<ExtensionsPage api={host.api} view="plugins" requestedId="plugin:whisper" isProcessing={false} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [whisper], skills: [], whisperModel: model }));
    fireEvent.click(await screen.findByRole('button', { name: '安装模型' }));
    act(() => host.update({ plugins: [whisper], skills: [], whisperModel: { ...model, status: 'downloading', downloadedBytes: 243800983, diskBytes: 243800983 } }));
    expect((await screen.findByRole('progressbar', { name: 'Whisper 模型安装进度' })).getAttribute('value')).toBe('243800983');
    expect(screen.getByRole('status').textContent).toContain('正在下载模型');
    await act(async () => finish({ plugins: [whisper], skills: [], whisperModel: { ...model, status: 'ready', diskBytes: model.size, downloadedBytes: model.size } }));
    expect(screen.getByRole('status').textContent).toContain('Whisper Small 模型已安装');
    fireEvent.click(screen.getByRole('button', { name: '删除 Whisper 模型' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除模型' }));
    await act(async () => finish({ plugins: [whisper], skills: [], whisperModel: model }));
    fireEvent.click(screen.getByRole('button', { name: '选择本地 Whisper 模型' }));
    await act(async () => finish(null));
    expect(screen.queryByRole('status')).toBeNull();
    expect(host.api.manage).toHaveBeenCalledWith({ action: 'import-whisper-model' });
  });
  const plugin = { id: 'plugin:video', kind: 'plugin' as const, name: '视频', displayName: '语义视频剪辑', description: '剪辑', source: 'builtin' as const, installed: false, enabled: false };
  const skill = { id: 'plugin:video/edit', kind: 'skill' as const, name: 'edit', description: '剪辑', source: 'plugin' as const, pluginId: plugin.id, installed: true, enabled: true };

  it('shows installation on its row and only offers a confirmed usable skill on success', async () => {
    const host = setup(); const trial = vi.fn();
    let finish!: (next: ExtensionSnapshot) => void;
    host.api.install = vi.fn(() => new Promise<ExtensionSnapshot>(resolve => { finish = resolve; }));
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={false} onTrySkill={trial} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [plugin], skills: [] }));
    fireEvent.click(await screen.findByRole('button', { name: '安装 视频' }));
    expect(screen.getByRole('status').textContent).toBe('正在安装');
    expect(screen.queryByRole('button', { name: '安装 视频' })).toBeNull();
    expect(screen.queryByRole('button', { name: '立即试用' })).toBeNull();
    await act(async () => finish({ plugins: [{ ...plugin, installed: true, enabled: true }], skills: [skill] }));
    expect(await screen.findByText('语义视频剪辑 插件已安装')).toBeTruthy();
    expect(screen.queryByText('正在安装')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '立即试用' }));
    expect(trial).toHaveBeenCalledWith(skill);
    expect(screen.queryByText('语义视频剪辑 插件已安装')).toBeNull();
  });

  it.each(['no-skills', 'disabled-skill', 'disabled-plugin'] as const)('does not offer an unusable trial after %s installation', async mode => {
    const host = setup();
    host.api.install = async () => ({ plugins: [{ ...plugin, installed: true, enabled: mode !== 'disabled-plugin' }], skills: mode === 'no-skills' ? [] : [{ ...skill, enabled: mode !== 'disabled-skill' }] });
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={false} onTrySkill={vi.fn()} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [plugin], skills: [] }));
    fireEvent.click(await screen.findByRole('button', { name: '安装 视频' }));
    await screen.findByText('语义视频剪辑 插件已安装');
    expect(screen.queryByRole('button', { name: '立即试用' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a failed installation retryable and closes its error without reporting success', async () => {
    const host = setup();
    host.api.install = vi.fn().mockRejectedValueOnce(new Error('下载失败')).mockResolvedValue({ plugins: [{ ...plugin, installed: true, enabled: true }], skills: [skill] });
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={false} onTrySkill={vi.fn()} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [plugin], skills: [] }));
    fireEvent.click(await screen.findByRole('button', { name: '安装 视频' }));
    expect((await screen.findByRole('alert')).textContent).toContain('下载失败');
    expect(screen.queryByRole('button', { name: '立即试用' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '安装 视频' }));
    await screen.findByText('语义视频剪辑 插件已安装');
  });

  it('reports confirmed uninstall and does not offer a stale skill', async () => {
    const host = setup();
    host.api.uninstall = async () => ({ plugins: [plugin], skills: [] });
    render(<ExtensionsPage api={host.api} view="plugins" requestedId={plugin.id} isProcessing={false} onTrySkill={vi.fn()} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [{ ...plugin, installed: true, enabled: true }], skills: [skill] }));
    fireEvent.click(await screen.findByRole('button', { name: '插件操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '卸载' }));
    fireEvent.click(screen.getByRole('button', { name: '确认卸载' }));
    await screen.findByText('语义视频剪辑 插件已卸载');
    expect(screen.queryByRole('button', { name: '立即试用' })).toBeNull();
    expect(screen.getByRole('button', { name: '安装 视频' })).toBeTruthy();
  });

  it('shows the shared feedback inside a skill dialog and waits for explicit trial after installation', async () => {
    const host = setup(); const trial = vi.fn();
    const local = { ...skill, id: 'skill:edit', source: 'builtin' as const, pluginId: undefined, installed: false, enabled: false };
    const { pluginId: _pluginId, ...standalone } = local;
    host.api.install = async () => ({ plugins: [], skills: [{ ...standalone, installed: true, enabled: true }] });
    render(<ExtensionsPage api={host.api} view="skills" isProcessing={false} onTrySkill={trial} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [], skills: [standalone] }));
    fireEvent.click(await screen.findByRole('button', { name: '查看 edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: /^安装$/ }));
    await dialog.findByText('edit 技能已安装');
    expect(trial).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole('button', { name: '立即试用' }));
    expect(trial).toHaveBeenCalledWith(expect.objectContaining({ id: standalone.id, installed: true, enabled: true }));
  });

  it('keeps a canceled directory selection silent and makes all catalog errors dismissible', async () => {
    const host = setup();
    render(<ExtensionsPage api={host.api} view="skills" isProcessing={false} />);
    await screen.findByText('暂无已安装的扩展');
    fireEvent.click(screen.getByRole('button', { name: '添加技能' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '添加技能' })).toHaveProperty('disabled', false));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => host.update({ plugins: [], skills: [], errors: ['来源 A 加载失败', '来源 B 加载失败'] }));
    expect((await screen.findByRole('alert')).textContent).toContain('来源 A 加载失败\n来源 B 加载失败');
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not hide partial host failures behind a refresh success', async () => {
    const host = setup();
    host.api.reconcile = async () => { throw new Error('市场刷新失败，旧目录保留'); };
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={false} />);
    await screen.findByText('暂无已安装的扩展');
    fireEvent.click(screen.getByRole('button', { name: '刷新插件' }));
    expect((await screen.findByRole('alert')).textContent).toContain('市场刷新失败');
    expect(screen.queryByText('插件目录已刷新')).toBeNull();
  });

  it('preserves catalog dependency diagnostics after acknowledging a successful installation', async () => {
    const host = setup();
    host.api.install = async () => ({ plugins: [{ ...plugin, installed: true, enabled: true }], skills: [skill], errors: ['需要安装 FFmpeg 插件'] });
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={false} onTrySkill={vi.fn()} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [plugin], skills: [] }));
    fireEvent.click(await screen.findByRole('button', { name: '安装 视频' }));
    await screen.findByText('语义视频剪辑 插件已安装');
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect((await screen.findByRole('alert')).textContent).toContain('需要安装 FFmpeg');
    expect(screen.queryByRole('button', { name: '立即试用' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('updates an installed builtin plugin from its detail and disables the action during tasks', async () => {
    const host = setup();
    const plugin = { id: 'plugin:ffmpeg', kind: 'plugin' as const, name: 'FFmpeg', description: '本地媒体工具', source: 'builtin' as const, installed: true, enabled: true, version: '1.0.0', availableVersion: '1.1.0' };
    const { availableVersion: _availableVersion, ...updated } = plugin;
    host.api.manage = vi.fn(async () => ({ plugins: [{ ...updated, version: '1.1.0' }], skills: [] }));
    const view = render(<ExtensionsPage api={host.api} view="plugins" requestedId={plugin.id} isProcessing={true} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [plugin], skills: [] }));
    const update = await screen.findByRole('button', { name: '更新至 1.1.0' });
    expect(update).toHaveProperty('disabled', true);
    fireEvent.click(update);
    expect(host.api.manage).not.toHaveBeenCalled();
    view.rerender(<ExtensionsPage api={host.api} view="plugins" requestedId={plugin.id} isProcessing={false} />);
    fireEvent.click(screen.getByRole('button', { name: '更新至 1.1.0' }));
    await waitFor(() => expect(host.api.manage).toHaveBeenCalledWith({ action: 'update', id: plugin.id }));
    await screen.findByRole('button', { name: '检查更新' });
    expect(screen.getByRole('region', { name: '信息' }).textContent).toContain('1.1.0');
  });
  it('adds and edits a standalone MCP server through the reference menu without disclosing secrets', async () => {
    const host = setup();
    const server = { id: 'mcp:local', name: 'local-tools', transport: 'stdio' as const, command: 'node', args: ['script.mjs'], url: '', enabled: true, environmentNames: ['TOKEN'], headerNames: [], connected: false };
    host.api.manage = vi.fn(async () => ({ plugins: [], skills: [], mcpServers: [server] }));
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={false} onBrowse={() => undefined} />);
    await screen.findByText('暂无已安装的插件');
    fireEvent.click(screen.getByRole('button', { name: '添加插件' }));
    expect(screen.getByRole('menuitem', { name: '创建插件' })).toHaveProperty('disabled', true);
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['创建插件', '添加插件市场', '添加 MCP 服务器']);
    fireEvent.click(screen.getByRole('menuitem', { name: '添加 MCP 服务器' }));
    let editor = within(await screen.findByRole('dialog', { name: '添加 MCP 服务器' }));
    fireEvent.change(editor.getByLabelText('服务器名称'), { target: { value: server.name } });
    fireEvent.change(editor.getByLabelText('启动命令'), { target: { value: server.command } });
    fireEvent.change(editor.getByLabelText('启动参数（每行一个）'), { target: { value: 'script.mjs' } });
    fireEvent.click(editor.getByRole('button', { name: '添加环境变量' }));
    fireEvent.change(editor.getByLabelText('环境变量 1 名称'), { target: { value: 'TOKEN' } });
    fireEvent.change(editor.getByLabelText('环境变量 1 值'), { target: { value: 'secret-value' } });
    fireEvent.click(editor.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(host.api.manage).toHaveBeenCalledWith({ action: 'save-mcp-server', server: { name: server.name, transport: 'stdio', command: 'node', args: ['script.mjs'], url: '', environment: { TOKEN: 'secret-value' }, headers: {} } }));
    await screen.findByRole('button', { name: '配置 local-tools' });
    fireEvent.click(screen.getByRole('button', { name: '配置 local-tools' }));
    editor = within(await screen.findByRole('dialog', { name: '配置 MCP 服务器' }));
    expect(editor.getByLabelText('环境变量 1 值')).toHaveProperty('value', '');
    fireEvent.click(editor.getByRole('button', { name: '添加环境变量' }));
    fireEvent.click(editor.getByRole('button', { name: '保存' }));
    expect((await editor.findByRole('alert')).textContent).toContain('变量名称不能为空或重复');
    fireEvent.click(editor.getByRole('button', { name: '关闭提示' }));
    fireEvent.click(editor.getByRole('button', { name: '移除环境变量 2' }));
    fireEvent.click(editor.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(host.api.manage).toHaveBeenLastCalledWith({ action: 'save-mcp-server', server: { id: server.id, name: server.name, transport: 'stdio', command: 'node', args: ['script.mjs'], url: '', environment: { TOKEN: '' }, headers: {} } }));
  });
  it('manages installed plugins, MCP search and marketplace actions from settings', async () => {
    const host = setup();
    const browse = vi.fn();
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={false} onBrowse={browse} />);
    await screen.findByText('暂无已安装的插件');
    const plugin = { id: 'plugin:review', kind: 'plugin' as const, name: 'review', displayName: '代码审查', description: '检查代码', source: 'marketplace' as const, installed: true, enabled: true, marketplaceId: 'local', connections: [
      { name: 'node_repl', transport: 'stdio', connected: true }, { name: 'files', transport: 'stdio', connected: true }, { name: 'account', transport: 'app', connected: false },
    ] };
    act(() => host.update({ plugins: [plugin], skills: [], marketplaces: [{ id: 'local', name: '本地市场', source: 'D:/plugins' }] }));
    expect(await screen.findByRole('tab', { name: '插件 1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'MCP 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '市场 1' })).toBeTruthy();
    host.api.setEnabled = vi.fn(async (_id, enabled) => ({ ...(await host.api.list()), plugins: [{ ...plugin, enabled }] }));
    fireEvent.click(screen.getByRole('switch', { name: '启用 review' }));
    await waitFor(() => expect(host.api.setEnabled).toHaveBeenCalledWith(plugin.id, false));
    await waitFor(() => expect(screen.getByRole('switch', { name: '启用 review' })).toHaveProperty('checked', false));
    fireEvent.click(screen.getByRole('tab', { name: 'MCP 2' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索 MCP 服务器' }), { target: { value: 'node_repl' } });
    expect(screen.getByRole('button', { name: /代码审查\s*node_repl、files/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索 MCP 服务器' }), { target: { value: 'not-found' } });
    expect(screen.getByText('没有匹配结果')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '市场 1' }));
    expect(screen.getByText('1 个插件')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '升级' }));
    await waitFor(() => expect(host.api.reconcile).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: '升级' })).toHaveProperty('disabled', false));
    host.api.manage = vi.fn(async () => ({ plugins: [plugin], skills: [], marketplaces: [] }));
    fireEvent.click(screen.getByRole('button', { name: '移除 本地市场' }));
    await waitFor(() => expect(host.api.manage).toHaveBeenCalledWith({ action: 'remove-marketplace', id: 'local' }));
    await screen.findByText('暂无插件市场');
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }));
    expect(browse).toHaveBeenCalledWith('plugins');
  });
  it('opens a plugin skill dialog, renders its body and forwards file, toggle and trial actions', async () => {
    const host = setup(); const trial = vi.fn();
    host.api.readSkill = vi.fn(async () => '---\nname: drama\ndescription: metadata-only\n---\n\n## 剪辑步骤\n\n1. 检查素材\n2. 验收成片');
    host.api.manage = vi.fn(async () => host.api.list());
    host.api.setEnabled = vi.fn(async (id, enabled) => {
      const next = await host.api.list();
      const updated = { ...next, skills: next.skills.map(skill => skill.id === id ? { ...skill, enabled } : skill) };
      host.update(updated); return updated;
    });
    render(<ExtensionsPage api={host.api} view="plugins" requestedId="plugin:video" isProcessing={false} onTrySkill={trial} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [{ id: 'plugin:video', kind: 'plugin', name: '视频', displayName: '语义视频剪辑', description: '剪辑', longDescription: '按对白和画面完成剪辑。', developerName: 'Agent Desktop', category: 'Productivity', version: '1.1.0', capabilities: ['Local'], hasHooks: true, source: 'local', installed: true, enabled: true, skillNames: ['drama'] }],
      skills: [{ id: 'plugin:video/drama', kind: 'skill', name: 'drama', displayName: '短剧剪辑', description: '剪辑短剧素材', source: 'plugin', pluginId: 'plugin:video', installed: true, enabled: true }] }));
    expect(await screen.findByRole('heading', { name: /语义视频剪辑/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: '信息' }).textContent).toContain('Agent Desktop');
    expect(screen.getByRole('region', { name: '信息' }).textContent).toContain('Productivity');
    expect(screen.queryByText('事件钩子在运行前逐项请求授权。')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '查看 drama' }));
    const dialog = within(await screen.findByRole('dialog', { name: '短剧剪辑技能详情' }));
    await dialog.findByRole('heading', { name: '剪辑步骤' });
    expect(dialog.queryByText('metadata-only')).toBeNull();
    expect(dialog.getAllByRole('listitem')).toHaveLength(2);
    for (const [label, action] of [['打开', 'open-skill'], ['在文件资源管理器中显示', 'reveal-skill'], ['复制 Markdown', 'copy-skill']] as const) {
      fireEvent.click(dialog.getByRole('button', { name: '技能操作' }));
      fireEvent.click(dialog.getByRole('menuitem', { name: label }));
      await waitFor(() => expect(host.api.manage).toHaveBeenCalledWith({ action, id: 'plugin:video/drama' }));
      await waitFor(() => expect((dialog.getByRole('button', { name: '技能操作' }) as HTMLButtonElement).disabled).toBe(false));
    }
    fireEvent.click(dialog.getByRole('switch', { name: '启用 drama' }));
    await waitFor(() => expect((dialog.getByRole('switch', { name: '启用 drama' }) as HTMLInputElement).checked).toBe(false));
    expect((dialog.getByRole('button', { name: '使用' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog.getByRole('switch', { name: '启用 drama' }));
    await waitFor(() => expect((dialog.getByRole('button', { name: '使用' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(dialog.getByRole('button', { name: '使用' }));
    expect(trial).toHaveBeenCalledWith(expect.objectContaining({ name: 'drama', enabled: true }));
    fireEvent.click(dialog.getByRole('button', { name: '关闭技能详情' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '查看 drama' })).toBeTruthy();
  });
  it('refreshes after host invalidation and cleans up the subscription', async () => {
    const host = setup();
    const view = render(<ExtensionsPage api={host.api} view="skills" isProcessing={false} />);
    await screen.findByText('暂无已安装的扩展');
    act(() => host.update({ plugins: [], skills: [{ id: 'custom-id', kind: 'skill', name: 'review', description: '检查文件', source: 'local', installed: true, enabled: false }] }));
    await screen.findByRole('button', { name: '查看 review' });
    expect((screen.getByRole('switch', { name: '启用 review' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '查看 review' }));
    await screen.findByText('skill instructions');
    expect(host.api.readSkill).toHaveBeenCalledWith('custom-id');
    expect(host.api.readDetail).not.toHaveBeenCalled();
    view.unmount();
    expect(host.unsubscribe).toHaveBeenCalledOnce();
  });

  it('displays reconcile failure and keeps the current catalog visible', async () => {
    const host = setup();
    vi.mocked(host.api.reconcile).mockRejectedValueOnce(new Error('升级包损坏，保留旧版本'));
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={false} />);
    await screen.findByText('暂无已安装的扩展');
    fireEvent.click(screen.getByRole('button', { name: '刷新插件' }));
    expect((await screen.findByRole('alert')).textContent).toContain('保留旧版本');
    await waitFor(() => expect((screen.getByRole('button', { name: '刷新插件' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('does not start synchronization during an active task', async () => {
    const host = setup();
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={true} />);
    await screen.findByText('暂无已安装的扩展');
    const button = screen.getByRole('button', { name: '刷新插件' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(host.api.reconcile).not.toHaveBeenCalled();
  });

  it('keeps cancellation available while an account connection is waiting and releases busy controls', async () => {
    const host = setup(); let cancel: ((error: Error) => void) | undefined;
    const pending = new Promise<ExtensionSnapshot>((_resolve, reject) => { cancel = reject; });
    host.api.manage = vi.fn(async request => {
      if (request.action === 'connect') return pending;
      if (request.action === 'cancel-connect') cancel!(new Error('账户授权已取消。'));
      return host.api.list();
    });
    render(<ExtensionsPage api={host.api} view="plugins" isProcessing={false} />);
    await screen.findByText('暂无已安装的扩展');
    fireEvent.click(screen.getByRole('tab', { name: '个人' }));
    act(() => host.update({ plugins: [{ id: 'plugin:remote', name: 'remote', description: '账户连接', kind: 'plugin', source: 'local', installed: true, enabled: true, connections: [{ name: 'service', transport: 'http', connected: false, url: 'https://example.com/mcp' }] }], skills: [] }));
    fireEvent.click(await screen.findByRole('button', { name: '查看 remote' }));
    fireEvent.click(await screen.findByRole('button', { name: '连接账户' }));
    expect((screen.getByRole('button', { name: '插件操作' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: '取消连接' }));
    expect((await screen.findByRole('alert')).textContent).toContain('账户授权已取消');
    await waitFor(() => expect((screen.getByRole('button', { name: '插件操作' }) as HTMLButtonElement).disabled).toBe(false));
    expect(host.api.manage).toHaveBeenCalledWith({ action: 'cancel-connect', id: 'plugin:remote', server: 'service' });
  });
});
