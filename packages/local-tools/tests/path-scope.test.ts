import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCreatablePath, resolveScopedPath } from '../src/index.js';

/**
 * 用真实目录做范围边界：范围判断的错误几乎都来自真实路径与字符串路径的差别，
 * 用 mock 伪造路径等于把要验证的东西替换掉。
 */
let base: string;
let root: string;
let outside: string;

/** realpath 会把 Windows 临时目录的 8.3 短名归一化成长名，期望值必须用同一个真实路径。 */
const real = (path: string) => realpath(path);

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-desktop-scope-'));
  root = join(base, 'work');
  outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'note.txt'), 'note');
  await writeFile(join(root, 'sub', 'inner.txt'), 'inner');
  await writeFile(join(outside, 'secret.txt'), 'secret');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('resolveScopedPath', () => {
  it('resolves a relative path against the confirmed directory', async () => {
    await expect(resolveScopedPath(await real(root), 'sub/inner.txt'))
      .resolves.toEqual({ ok: true, path: await real(join(root, 'sub', 'inner.txt')) });
  });

  it('resolves the confirmed directory itself when no path is requested', async () => {
    await expect(resolveScopedPath(await real(root), undefined))
      .resolves.toEqual({ ok: true, path: await real(root) });
  });

  it('accepts an absolute path inside the confirmed directory', async () => {
    const target = join(root, 'note.txt');
    await expect(resolveScopedPath(await real(root), target))
      .resolves.toEqual({ ok: true, path: await real(target) });
  });

  it('refuses a parent segment that leaves the confirmed directory', async () => {
    const result = await resolveScopedPath(await real(root), '../outside/secret.txt');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('不在当前会话的工作目录内');
  });

  it('refuses a sibling whose path merely shares a string prefix', async () => {
    // `work-evil` 以 `work` 为前缀，但完全在范围外：字符串前缀判断会在这里放行。
    // 目标路径必须用 realpath 归一化：Windows 临时目录的 8.3 短名会让「前缀」对不上，
    // 于是这条用例会以「形式不同」而不是「前缀判断错」通过，失去证明力。
    const evil = join(base, 'work-evil');
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, 'loot.txt'), 'loot');

    const result = await resolveScopedPath(await real(root), await real(join(evil, 'loot.txt')));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('不在当前会话的工作目录内');
  });

  it('refuses a link that points outside the confirmed directory', async () => {
    // 目录联接没有任何可疑前缀：只有真实路径能发现它指向范围之外。
    const link = join(root, 'link-out');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await resolveScopedPath(await real(root), join('link-out', 'secret.txt'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('不在当前会话的工作目录内');
  });

  it('refuses an absolute path when the session has no working directory', async () => {
    const result = await resolveScopedPath(undefined, join(root, 'note.txt'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('请先用 set_working_directory');
  });

  it('refuses a relative path when the session has no working directory', async () => {
    const result = await resolveScopedPath(undefined, 'note.txt');

    expect(result.ok).toBe(false);
    // 不能猜用户主目录或应用安装目录。
    expect(result.ok === false && result.message).toContain('无法解析相对路径');
  });

  it('reports a path that does not exist instead of pretending it is usable', async () => {
    const result = await resolveScopedPath(await real(root), 'missing.txt');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('ENOENT');
  });

  it('reports an unusable working directory instead of guessing another one', async () => {
    const result = await resolveScopedPath(join(base, 'gone'), undefined);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('工作目录不可用');
  });
});

describe('resolveCreatablePath', () => {
  it('resolves a new file inside the confirmed directory', async () => {
    await expect(resolveCreatablePath(await real(root), join(root, 'new.txt')))
      .resolves.toEqual({ ok: true, path: join(await real(root), 'new.txt') });
  });

  it('resolves a relative new file against the confirmed directory', async () => {
    await expect(resolveCreatablePath(await real(root), 'sub/new.txt'))
      .resolves.toEqual({ ok: true, path: join(await real(root), 'sub', 'new.txt') });
  });

  it('refuses a target whose parent is outside the confirmed directory', async () => {
    const result = await resolveCreatablePath(await real(root), join(outside, 'new.txt'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('不在当前会话的工作目录内');
  });

  it('refuses to escape the confirmed directory with a parent segment', async () => {
    const result = await resolveCreatablePath(await real(root), '../outside/new.txt');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('不在当前会话的工作目录内');
  });

  it('refuses a parent directory that does not exist instead of creating it', async () => {
    const result = await resolveCreatablePath(await real(root), 'missing/new.txt');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('ENOENT');
  });

  it('refuses a link that points outside the confirmed directory', async () => {
    const link = join(root, 'link-out');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await resolveCreatablePath(await real(root), join('link-out', 'new.txt'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('不在当前会话的工作目录内');
  });
});
