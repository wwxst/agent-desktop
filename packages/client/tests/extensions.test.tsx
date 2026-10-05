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
