import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { SessionComputer } from '../src/main/computer-host.js';

// 此文件是真实交互桌面验收；普通 CI 不把没有桌面权限的 runner 伪装成已验收。
describe.skipIf(process.platform !== 'win32' || process.env.AGENT_DESKTOP_COMPUTER_ACCEPTANCE !== '1')('Windows real UI Automation acceptance', () => {
  it('uses real Notepad, Calculator and a file dialog with fresh references and task-owned cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-computer-'));
    const basename = `acceptance-${Date.now()}.txt`; const file = join(directory, basename);
    await writeFile(file, 'Initial acceptance content\n', 'utf8');
    const computer = new SessionComputer({ approve: async () => true, outputDirectory: () => directory });
    const tools = computer.tools(); const checkpoints: unknown[] = []; const owned = new Set<number>();
    const execute = async (name: string, input: Record<string, unknown>): Promise<Record<string, any>> => {
      const tool = tools.find(item => item.name === name)!;
      const result = await tool.execute(input, { toolCallId: name as never, reportProgress: () => {}, checkpoint: data => checkpoints.push(data) });
      if (result.status !== 'success') throw new Error(result.message);
      return result.output as Record<string, any>;
    };
    const kill = (pid: number) => new Promise<void>(resolve => {
      execFile(join(process.env.SystemRoot!, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
    try {
      const original = await execute('computer_window_list', {});
      const originalPids = new Set(original.windows.map((window: { processId: number }) => window.processId));
      // 真实交互验收需要可观察窗口；只显示本测试创建的应用，结束后按进程身份清理。
      const notepad = spawn(join(process.env.SystemRoot!, 'System32', 'notepad.exe'), [file], { windowsHide: false, stdio: 'ignore' });
      if (notepad.pid !== undefined) owned.add(notepad.pid);
      let notepadWindow: any;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const observed = await execute('computer_window_list', {});
        notepadWindow = observed.windows.find((window: any) => window.title.includes(basename) && !originalPids.has(window.processId));
        if (notepadWindow !== undefined) break;
        await delay(300);
      }
      expect(notepadWindow, 'task-owned real Notepad window must be observable').toBeDefined();
      owned.add(notepadWindow.processId);
      let snapshot = await execute('computer_snapshot', { windowId: notepadWindow.windowId });
      const document = snapshot.elements.find((element: any) => ['ControlType.Document', 'ControlType.Edit'].includes(element.role) && element.enabled && !element.offscreen && element.focusable);
      expect(document, 'real editable Notepad UI Automation element').toBeDefined();
      const previous = { windowId: notepadWindow.windowId, snapshotId: snapshot.snapshotId, ref: document.ref };
      await execute('computer_type', { ...previous, text: '真实 UI Automation 中文验证\nReal acceptance 731\n' });
      await expect(execute('computer_click', previous)).rejects.toMatchObject({ message: expect.stringContaining('stale reference') });
      snapshot = await execute('computer_snapshot', { windowId: notepadWindow.windowId });
      expect(snapshot.text).toContain('Real acceptance 731');
      const freshDocument = snapshot.elements.find((element: any) => ['ControlType.Document', 'ControlType.Edit'].includes(element.role) && element.enabled && !element.offscreen && element.focusable);
      await execute('computer_key', { windowId: notepadWindow.windowId, snapshotId: snapshot.snapshotId, ref: freshDocument.ref, key: 'CTRL+S' });
      await execute('computer_wait', { milliseconds: 300 });
      expect(await readFile(file, 'utf8')).toContain('Real acceptance 731');
      const screenshot = await execute('computer_screenshot', { windowId: notepadWindow.windowId });
      expect((await readFile(screenshot.path)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      snapshot = await execute('computer_snapshot', { windowId: notepadWindow.windowId });
      const opener = snapshot.elements.find((element: any) => ['ControlType.Document', 'ControlType.Edit'].includes(element.role) && element.enabled && !element.offscreen && element.focusable);
      await execute('computer_key', { windowId: notepadWindow.windowId, snapshotId: snapshot.snapshotId, ref: opener.ref, key: 'CTRL+O' });
      await delay(300);
      const dialogWindows = await execute('computer_window_list', {});
      const dialog = dialogWindows.windows.find((window: any) => window.processId === notepadWindow.processId && window.windowId !== notepadWindow.windowId && /打开|Open/i.test(window.title));
      const dialogSnapshot = await execute('computer_snapshot', { windowId: dialog?.windowId ?? notepadWindow.windowId });
      expect(dialogSnapshot.elements.some((element: any) => /文件名|File name/i.test(element.name))).toBe(true);
      const dialogWindow = dialogSnapshot.elements.find((element: any) => /打开|Open/i.test(element.name) && element.role === 'ControlType.Window');
      expect(dialogWindow).toBeDefined();
      await execute('computer_key', { windowId: dialog?.windowId ?? notepadWindow.windowId, snapshotId: dialogSnapshot.snapshotId, ref: dialogWindow.ref, key: 'ESC' });

      const calculator = spawn(join(process.env.SystemRoot!, 'System32', 'calc.exe'), [], { windowsHide: false, stdio: 'ignore' });
      if (calculator.pid !== undefined) owned.add(calculator.pid);
      let calculatorWindow: any;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const observed = await execute('computer_window_list', {});
        calculatorWindow = observed.windows.find((window: any) => /Calculator|计算器/.test(window.title) && !originalPids.has(window.processId));
        if (calculatorWindow !== undefined) break;
        await delay(300);
      }
      expect(calculatorWindow, 'task-owned real Calculator window must be observable').toBeDefined();
      owned.add(calculatorWindow.processId);
      let calculatorSnapshot = await execute('computer_snapshot', { windowId: calculatorWindow.windowId });
      const buttons = ['num7Button', 'plusButton', 'num3Button', 'equalButton'];
      for (const automationId of buttons) {
        const button = calculatorSnapshot.elements.find((element: any) => element.automationId === automationId);
        expect(button, automationId).toBeDefined();
        await execute('computer_click', { windowId: calculatorWindow.windowId, snapshotId: calculatorSnapshot.snapshotId, ref: button.ref });
        calculatorSnapshot = await execute('computer_snapshot', { windowId: calculatorWindow.windowId });
      }
      expect(calculatorSnapshot.elements.some((element: any) => element.automationId === 'CalculatorResults' && /10/.test(element.name))).toBe(true);
      expect(checkpoints.length).toBeGreaterThanOrEqual(9);
    } finally {
      await computer.close();
      await Promise.all([...owned].map(kill));
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
