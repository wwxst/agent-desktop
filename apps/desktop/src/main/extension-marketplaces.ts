import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionMarketplace } from '@agent-desktop/client';
import { readDesktopDocument, writeDesktopDocuments } from './desktop-database.js';

const run = promisify(execFile);
const layouts = ['.agents/plugins/marketplace.json', '.agents/plugins/api_marketplace.json', '.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json'];
interface MarketRecord extends ExtensionMarketplace { readonly folder: string }
export interface MarketplaceEntry { readonly id: string; readonly name: string; readonly marketplaceId: string; readonly root: string; readonly source: string | Record<string, unknown>; readonly metadata: Record<string, unknown>; readonly category?: string; readonly installable: boolean }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function required(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`); return value.trim(); }
function safeName(value: unknown): string { const name = required(value, '市场或插件名称'); if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name) || name.endsWith('.')) throw new Error('市场或插件名称格式无效。'); return name; }
function gitUrl(source: string): string {
  if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+$/.test(source)) return source;
  const normalized = /^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}.git` : source;
  const url = new URL(normalized);
  if (!['https:', 'ssh:'].includes(url.protocol) && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('远程仓库需要 HTTPS 或 SSH 地址。');
  if (url.password || (url.username && url.protocol !== 'ssh:')) throw new Error('仓库地址不能包含凭据，请使用 Git 的本机凭据管理。');
  return url.href;
}
/** 第三方市场的资源只能取自该市场根目录，包含符号链接的真实路径也需要核对。 */
export async function marketPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path)) throw new Error('市场资源必须使用相对路径。');
  const base = await realpath(root); const target = await realpath(resolve(base, path)); const diff = relative(base, target);
  if (diff === '..' || diff.startsWith(`..${sep}`) || isAbsolute(diff)) throw new Error('市场资源不能超出仓库。');
  return target;
}
async function manifest(root: string): Promise<Record<string, unknown>> {
  for (const layout of layouts) {
    let source: string;
    try { source = await readFile(join(root, layout), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const data: unknown = JSON.parse(source);
    if (!object(data) || !Array.isArray(data.plugins)) throw new Error('市场清单需要 name 和 plugins。');
    safeName(data.name); return data;
  }
  throw new Error('该来源没有 Codex 市场清单。');
}

/** Desktop 使用的市场来源、检出与目录；安装包激活仍由 DesktopExtensions 负责。 */
export class ExtensionMarketplaces {
  constructor(private readonly database: string, private readonly root: string) {}
  records(): MarketRecord[] {
    const value = readDesktopDocument(this.database, 'extension-marketplaces');
    if (value === null) return [];
    if (!Array.isArray(value)) throw new Error('市场来源记录无效。');
    return value.map((entry: unknown) => {
      if (!object(entry)) throw new Error('市场来源记录无效。');
      return { id: safeName(entry.id), name: required(entry.name, '显示名称'), source: required(entry.source, '来源'), folder: safeName(entry.folder), ...(typeof entry.revision === 'string' ? { revision: entry.revision } : {}) };
    });
  }
  private save(records: readonly MarketRecord[]): void { writeDesktopDocuments(this.database, [{ name: 'extension-marketplaces', value: records }]); }
  async entries(): Promise<MarketplaceEntry[]> {
    const entries: MarketplaceEntry[] = [];
    for (const market of this.records()) {
      const root = join(this.root, 'marketplaces', market.folder); const data = await manifest(root);
      for (const raw of data.plugins as unknown[]) {
        if (!object(raw)) throw new Error('市场插件条目无效。');
        const name = safeName(raw.name);
        if (typeof raw.source !== 'string' && !object(raw.source)) throw new Error('市场插件 source 无效。');
        const policy = object(raw.policy) ? raw.policy : undefined;
        entries.push({ id: `plugin:${name}@${market.id}`, name, marketplaceId: market.id, root, source: raw.source, metadata: raw,
          installable: policy?.installation !== 'NOT_AVAILABLE', ...(typeof raw.category === 'string' ? { category: raw.category } : {}) });
      }
    }
    return entries;
  }
  /** 先检出和验证完整市场；网络或清单失败不会替换正在使用的目录。 */
  async add(source: string, replaceId?: string): Promise<void> {
    source = required(source, '市场来源');
    await mkdir(join(this.root, '.staging'), { recursive: true });
    const staging = join(this.root, '.staging', `market-${randomUUID()}`);
    let revision: string | undefined;
    try {
      if (isAbsolute(source)) await cp(source, staging, { recursive: true });
      else {
        source = gitUrl(source);
        await run('git', ['-c', 'core.hooksPath=NUL', '-c', 'core.longpaths=true', 'clone', '--depth', '1', '--', source, staging], { timeout: 120_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        revision = (await run('git', ['-C', staging, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim();
      }
      const data = await manifest(staging); const id = safeName(data.name);
      const records = this.records();
      if (replaceId !== undefined && replaceId !== id) throw new Error('刷新后的市场身份发生变化。');
      if (replaceId === undefined && records.some(record => record.id === id)) throw new Error('此市场已经添加。');
      const folder = `market-${randomUUID()}`; const destination = join(this.root, 'marketplaces', folder);
      await mkdir(join(this.root, 'marketplaces'), { recursive: true });
      await rename(staging, destination);
      const display = object(data.interface) ? data.interface.displayName : undefined;
      const next = { id, name: typeof display === 'string' ? display : id, source, folder, ...(revision === undefined ? {} : { revision }) };
      const previous = records.find(record => record.id === id);
      this.save([...records.filter(record => record.id !== id), next]);
      if (previous !== undefined) await rm(join(this.root, 'marketplaces', previous.folder), { recursive: true, force: true });
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async remove(id: string): Promise<void> {
    const records = this.records(); const record = records.find(record => record.id === id);
    if (record === undefined) throw new Error('找不到市场来源。');
    this.save(records.filter(record => record.id !== id));
    await rm(join(this.root, 'marketplaces', record.folder), { recursive: true, force: true });
  }
  /** git-subdir 与 url 只下载选定来源，不执行仓库中的安装脚本。 */
  async materialize(entry: MarketplaceEntry): Promise<{ directory: string; cleanup(): Promise<void> }> {
    const source = entry.source;
    if (typeof source === 'string' || source.source === 'local') {
      const path = typeof source === 'string' ? source : required(source.path, '插件路径');
      return { directory: await marketPath(entry.root, path), cleanup: async () => undefined };
    }
    await mkdir(join(this.root, '.staging'), { recursive: true });
    const staging = join(this.root, '.staging', `plugin-${randomUUID()}`);
    const cleanup = () => rm(staging, { recursive: true, force: true });
    try {
      if (source.source === 'url' || source.source === 'git-subdir') {
        const ref = typeof source.ref === 'string' ? source.ref : undefined;
        if (ref?.startsWith('-')) throw new Error('Git 引用不能以连字符开头。');
        await run('git', ['-c', 'core.hooksPath=NUL', '-c', 'core.longpaths=true', 'clone', ...(source.sha === undefined ? ['--depth', '1'] : []), ...(ref === undefined ? [] : ['--branch', ref]), '--', gitUrl(required(source.url, '仓库地址')), staging], { timeout: 120_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        if (typeof source.sha === 'string') { if (!/^[a-f0-9]{7,40}$/i.test(source.sha)) throw new Error('Git SHA 格式无效。'); await run('git', ['-C', staging, '-c', 'core.hooksPath=NUL', 'checkout', '--detach', source.sha], { windowsHide: true }); }
        return { directory: typeof source.path === 'string' ? await marketPath(staging, source.path) : staging, cleanup };
      }
      if (source.source === 'npm') {
        const packageName = required(source.package, 'npm 包名'); const registry = new URL(typeof source.registry === 'string' ? source.registry : 'https://registry.npmjs.org/');
        if (registry.protocol !== 'https:') throw new Error('npm 仓库需要 HTTPS。');
        const response = await fetch(new URL(encodeURIComponent(packageName), registry), { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`npm 查询失败：${response.status}`);
        const metadata: unknown = await response.json();
        if (!object(metadata) || !object(metadata.versions) || !object(metadata['dist-tags'])) throw new Error('npm 元数据无效。');
        const version = typeof source.version === 'string' ? source.version : required(metadata['dist-tags'].latest, 'npm 版本');
        const selected = metadata.versions[version]; if (!object(selected) || !object(selected.dist)) throw new Error('找不到 npm 版本。');
        const tarball = new URL(required(selected.dist.tarball, 'npm 下载地址')); if (tarball.protocol !== 'https:') throw new Error('npm 下载需要 HTTPS。');
        const download = await fetch(tarball, { signal: AbortSignal.timeout(60_000) }); if (!download.ok) throw new Error(`npm 下载失败：${download.status}`);
        await mkdir(staging); const archive = join(staging, 'package.tgz'); const bytes = Buffer.from(await download.arrayBuffer());
        if (typeof selected.dist.integrity === 'string') {
          const integrity = /^sha512-([A-Za-z0-9+/=]+)$/.exec(selected.dist.integrity);
          if (integrity === null || createHash('sha512').update(bytes).digest('base64') !== integrity[1]) throw new Error('npm 包完整性校验失败。');
        }
        await writeFile(archive, bytes);
        // OS tar 只用于无脚本的解包；预先拒绝越界路径与链接文件。
        const listing = (await run('tar', ['-tzvf', archive], { windowsHide: true })).stdout;
        if (listing.split(/\r?\n/).some(line => /^[lh]/.test(line) || /(?:^|[ /\\])\.\.(?:[ /\\]|$)/.test(line))) throw new Error('npm 包含越界路径或链接。');
        const paths = (await run('tar', ['-tzf', archive], { windowsHide: true })).stdout.trim().split(/\r?\n/);
        if (paths.some(path => !path.startsWith('package/') || path.includes(':') || path.includes('\\') || path.split('/').includes('..'))) throw new Error('npm 文件必须位于 package 目录。');
        await run('tar', ['-xzf', archive, '-C', staging], { windowsHide: true });
        return { directory: join(staging, 'package'), cleanup };
      }
      throw new Error('不支持的市场插件来源。');
    } catch (error) { await cleanup(); throw error; }
  }
}
