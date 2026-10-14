import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { cp, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { randomUUID } from 'node:crypto';
import type { ExtensionItem, ExtensionSnapshot, McpServerUpdate } from '@agent-desktop/client';
import { readDesktopDocument, writeDesktopDocuments } from './desktop-database.js';
import { ExtensionMarketplaces, marketPath } from './extension-marketplaces.js';
import type { ExtensionConnections } from './extension-connections.js';
import { installFFmpegRuntime } from './ffmpeg-runtime.js';
import { installWhisperRuntime } from './whisper-runtime.js';
import { WhisperModels } from './whisper-models.js';
import { renameDirectory } from './rename-directory.js';

type Kind = 'plugin' | 'skill';
type Source = ExtensionItem['source'];
interface InstalledExtension { readonly id: string; readonly kind: Kind; readonly name: string; readonly source: 'builtin' | 'local' | 'marketplace'; readonly version?: string; readonly marketplaceId?: string }
interface ExtensionState { readonly installed: readonly InstalledExtension[]; readonly disabled: readonly string[] }
export interface SkillFile { readonly item: ExtensionItem; readonly content?: string; readonly directory: string; readonly toolDependencies?: readonly SkillDependency[]; readonly pluginRoot?: string }
export interface McpServerFile { readonly name: string; readonly command: string; readonly args: string[]; readonly type?: 'stdio' | 'http' | 'sse'; readonly url?: string; readonly env?: Readonly<Record<string, string>>; readonly headers?: Readonly<Record<string, string>> }
interface StandaloneMcpRecord extends McpServerUpdate { readonly id: string; readonly enabled: boolean }
export interface StandaloneMcpFile { readonly id: string; readonly enabled: boolean; readonly directory: string; readonly server: McpServerFile }
export interface SkillDependency { readonly type: string; readonly value: string; readonly url?: string; readonly transport?: string; readonly description?: string }
export interface PluginHook { readonly event: string; readonly matcher?: string; readonly command: string; readonly timeoutMs: number }
export interface PluginFiles { readonly name: string; readonly item: ExtensionItem; readonly skills: readonly SkillFile[]; readonly servers: readonly McpServerFile[]; readonly directory: string; readonly hooks?: readonly PluginHook[]; readonly appIds?: readonly string[] }
export interface ExtensionReconcileResult { readonly changed: readonly string[]; readonly failed: readonly { readonly id: string; readonly message: string }[] }

const catalog = [
  { id: 'plugin:video-editing', kind: 'plugin' as const, name: 'video-editing', directory: 'plugins/video-editing' },
  { id: 'plugin:ffmpeg', kind: 'plugin' as const, name: 'ffmpeg', directory: 'plugins/ffmpeg' },
  { id: 'plugin:whisper', kind: 'plugin' as const, name: 'whisper', directory: 'plugins/whisper' },
  { id: 'plugin:vision', kind: 'plugin' as const, name: 'vision', directory: 'plugins/vision' },
  { id: 'skill:local-file-review', kind: 'skill' as const, name: 'local-file-review', directory: 'skills/local-file-review' },
];
const MAX_SKILLS = 2000;
const MAX_DIRECTORIES = 10000;
const metadataCache = new Map<string, { signature: string; skill: SkillFile }>();
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown, label: string): string { if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}必须是非空文字。`); return value.trim(); }
/** IPC 和加密本地配置的入口只检查独立服务器实际使用的字段。 */
function parseMcpUpdate(value: unknown): McpServerUpdate {
  if (!record(value) || !['stdio', 'http', 'sse'].includes(String(value.transport))) throw new Error('MCP 传输类型无效。');
  const name = text(value.name, '服务器名称');
  if (typeof value.command !== 'string' || typeof value.url !== 'string' || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string')) throw new Error('MCP 命令、参数或地址无效。');
  const mapping = (input: unknown): Record<string, string> => {
    if (!record(input) || Object.entries(input).some(([key, entry]) => !key.trim() || typeof entry !== 'string')) throw new Error('环境变量和请求头需要名称与文字值。');
    return input as Record<string, string>;
  };
  const transport = value.transport as McpServerUpdate['transport'];
  if (transport === 'stdio') text(value.command, '启动命令');
  else if (!['http:', 'https:'].includes(new URL(text(value.url, '服务器地址')).protocol)) throw new Error('MCP 地址需要使用 HTTP 或 HTTPS。');
  return { ...(value.id === undefined ? {} : { id: text(value.id, '服务器标识') }), name, transport,
    command: transport === 'stdio' ? value.command.trim() : '', args: transport === 'stdio' ? value.args as string[] : [], url: transport === 'stdio' ? '' : value.url.trim(),
    environment: transport === 'stdio' ? mapping(value.environment) : {}, headers: transport === 'stdio' ? {} : mapping(value.headers) };
}
function extensionName(value: unknown): string { const name = text(value, '扩展名称'); if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name) || name.endsWith('.')) throw new Error('扩展名称只能包含小写字母、数字、点和连字符，最长 64 字符。'); return name; }
function missing(error: unknown): boolean { return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function stringList(value: unknown, label: string): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) throw new Error(`${label}必须是文字数组。`); return value.map(item => item.trim()); }
function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!record(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error(`${label}必须是文字映射。`);
  return value as Record<string, string>;
}
function pathList(value: unknown, fallback: string, label: string): string[] {
  if (value === undefined) return [fallback];
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  if (Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '')) return value.map(item => item.trim());
  throw new Error(`${label}必须是相对路径或路径数组。`);
}

/** 插件资源路径必须留在插件目录内，包括符号链接解析后的真实位置。 */
export async function pluginPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path)) throw new Error('插件资源必须使用相对路径。');
  const base = await realpath(root); const target = await realpath(resolve(base, path)); const difference = relative(base, target);
  if (difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) throw new Error('插件资源不能超出插件目录。');
  return target;
}

/** 图标以数据地址跨过隔离桥，渲染层不获得任意本机文件读取能力。 */
export async function interfaceAsset(root: string, value: unknown): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const path = text(value, '界面资源路径');
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
  if (types[extension] === undefined) throw new Error('界面资源需要使用图片文件。');
  return `data:${types[extension]};base64,${(await readFile(await pluginPath(root, path))).toString('base64')}`;
}

/** 完整消费 Codex interface；网站地址只允许由外部浏览器打开的协议。 */
export async function pluginInterface(root: string, value: unknown): Promise<Partial<ExtensionItem>> {
  if (value === undefined) return {};
  if (!record(value)) throw new Error('插件 interface 必须是对象。');
  const fields: Partial<ExtensionItem> = {};
  const strings = ['longDescription', 'developerName', 'category', 'brandColor'] as const;
  for (const key of strings) if (value[key] !== undefined) Object.assign(fields, { [key]: text(value[key], key) });
  for (const [key, alias] of [['websiteUrl', 'websiteURL'], ['privacyPolicyUrl', 'privacyPolicyURL'], ['termsOfServiceUrl', 'termsOfServiceURL']] as const) {
    const raw = value[key] ?? value[alias];
    if (raw !== undefined) { const url = new URL(text(raw, key)); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('网站链接必须是 HTTP 地址。'); Object.assign(fields, { [key]: url.href }); }
  }
  const defaultPrompts = typeof value.defaultPrompt === 'string' ? [value.defaultPrompt] : stringList(value.defaultPrompt, '建议指令');
  if (defaultPrompts.length > 0) Object.assign(fields, { defaultPrompts, defaultPrompt: defaultPrompts[0] });
  for (const key of ['logo', 'logoDark', 'composerIcon'] as const) { const asset = await interfaceAsset(root, value[key]); if (asset !== undefined) Object.assign(fields, { [key]: asset }); }
  const screenshots = await Promise.all(stringList(value.screenshots, '截图').map(path => interfaceAsset(root, path)));
  if (screenshots.length > 0) Object.assign(fields, { screenshots });
  return fields;
}

/** 与 Codex 一样优先读取 Agent Plugins v1 清单，com.openai 扩展承载界面、应用与钩子。 */
async function pluginManifest(directory: string): Promise<Record<string, unknown>> {
  let source: string;
  try { source = await readFile(join(directory, 'plugin.json'), 'utf8'); }
  catch (error) {
    if (!missing(error)) throw error;
    const legacy: unknown = JSON.parse(await readFile(join(directory, '.codex-plugin/plugin.json'), 'utf8'));
    if (!record(legacy)) throw new Error('插件清单必须是对象。'); return legacy;
  }
  const manifest: unknown = JSON.parse(source);
  if (!record(manifest)) throw new Error('插件清单必须是对象。');
  if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
    // 根目录可能是业务自己的 plugin.json；与 Codex 一样让有效的旧格式清单接管。
    try { const legacy: unknown = JSON.parse(await readFile(join(directory, '.codex-plugin/plugin.json'), 'utf8')); if (!record(legacy)) throw new Error('插件清单必须是对象。'); return legacy; }
    catch (error) { if (missing(error)) throw new Error('不支持的 Agent Plugins schema。'); throw error; }
  }
  const extensions = record(manifest.extensions) ? manifest.extensions : undefined;
  let overlay = record(extensions?.['com.openai']) ? extensions['com.openai'] : undefined;
  if (overlay === undefined) {
    try { const value: unknown = JSON.parse(await readFile(join(directory, '.codex-plugin/plugin.json'), 'utf8')); if (!record(value)) throw new Error('插件扩展清单必须是对象。'); overlay = value; }
    catch (error) { if (!missing(error)) throw error; }
  }
  const author = record(manifest.author) ? manifest.author : undefined;
  return { ...manifest, ...(overlay ?? {}), name: manifest.name, version: manifest.version, description: manifest.description,
    interface: overlay?.interface ?? { displayName: manifest.name, developerName: author?.name, websiteURL: manifest.homepage },
    // Agent Plugins 的约定文件不需要显式声明；只有真实存在的文件才成为必需资源。
    mcpServers: overlay?.mcpServers ?? await stat(join(directory, 'mcp.json')).then(() => './mcp.json').catch(error => { if (missing(error)) return undefined; throw error; }),
  };
}

/** 下载或复制时不展开可越过插件边界的链接，防止把本机外部文件带入安装包。 */
async function validatePackageLinks(root: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) await pluginPath(root, relative(root, path));
      else if (entry.isDirectory() && entry.name !== '.git') await walk(path);
    }
  }
  await walk(root);
}

function metadataFromSkill(content: string, directory: string, id: string, source: Source, pluginId?: string): SkillFile {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (frontmatter === null) throw new Error(`技能缺少 YAML 元数据：${directory}`);
  const metadata: unknown = parseYaml(frontmatter[1]!); if (!record(metadata)) throw new Error('技能元数据必须是对象。');
  const nested = record(metadata.metadata) ? metadata.metadata : undefined;
  // 技能名称是展示和调用信息，不是安装目录名；Codex 允许大小写及目录默认名称。
  const name = text(metadata.name ?? basename(directory), '技能名称').replace(/\s+/g, ' ');
  if (Array.from(name).length > 64) throw new Error('技能名称最长 64 字符。');
  const description = text(metadata.description, '技能描述').replace(/\s+/g, ' ');
  const shortDescriptionValue = metadata['short-description'] ?? nested?.['short-description']; const dependencies = nested?.dependencies ?? metadata.dependencies;
  const item: ExtensionItem = { id, kind: 'skill', name, description, source, installed: true, enabled: true, path: join(directory, 'SKILL.md'), sourceKind: 'host', authority: { kind: 'host', id: source },
    ...(typeof shortDescriptionValue === 'string' ? { shortDescription: shortDescriptionValue.trim() } : {}), ...(dependencies === undefined ? {} : { dependencies: stringList(dependencies, '技能依赖') }), ...(pluginId === undefined ? {} : { pluginId }) };
  return { directory, item };
}

/** Codex 的技能侧车文件保存展示信息和调用策略，不把它们写进 SKILL.md 正文。 */
async function withSkillInterface(skill: SkillFile): Promise<SkillFile> {
  let source: string;
  try { source = await readFile(join(skill.directory, 'agents/openai.yaml'), 'utf8'); }
  catch (error) { if (missing(error)) return skill; throw error; }
  const value: unknown = parseYaml(source);
  if (!record(value)) throw new Error('技能界面配置必须是对象。');
  const display = record(value.interface) ? value.interface : undefined;
  const policy = record(value.policy) ? value.policy : undefined;
  const implicit = policy?.allow_implicit_invocation;
  if (implicit !== undefined && typeof implicit !== 'boolean') throw new Error('技能自动调用策略必须是布尔值。');
  const dependencies = record(value.dependencies) ? value.dependencies.tools : undefined;
  const tools: string[] = [];
  const toolDependencies: SkillDependency[] = [];
  if (dependencies !== undefined) {
    if (!Array.isArray(dependencies)) throw new Error('技能工具依赖必须是数组。');
    for (const tool of dependencies) {
      if (!record(tool)) throw new Error('技能工具依赖必须是对象。');
      tools.push(`${text(tool.type, '依赖类型')}: ${text(tool.value, '依赖名称')}`);
      toolDependencies.push({ type: text(tool.type, '依赖类型'), value: text(tool.value, '依赖名称'),
        ...(typeof tool.url === 'string' ? { url: tool.url } : {}), ...(typeof tool.transport === 'string' ? { transport: tool.transport } : {}), ...(typeof tool.description === 'string' ? { description: tool.description } : {}) });
    }
  }
  const asset = (value: unknown) => skill.pluginRoot !== undefined && typeof value === 'string'
    ? interfaceAsset(skill.pluginRoot, relative(skill.pluginRoot, resolve(skill.directory, value))) : interfaceAsset(skill.directory, value);
  const icon = await asset(display?.icon_small ?? display?.icon_large);
  const largeIcon = await asset(display?.icon_large);
  return { ...skill, toolDependencies, item: { ...skill.item,
    ...(icon === undefined ? {} : { logo: icon }), ...(largeIcon === undefined ? {} : { composerIcon: largeIcon }),
    ...(display?.brand_color === undefined ? {} : { brandColor: text(display.brand_color, '品牌颜色') }),
    ...(display?.display_name === undefined ? {} : { displayName: text(display.display_name, '技能显示名称') }),
    ...(display?.short_description === undefined ? {} : { shortDescription: text(display.short_description, '技能简述') }),
    ...(display?.default_prompt === undefined ? {} : { defaultPrompt: text(display.default_prompt, '建议指令') }),
    ...(implicit === undefined ? {} : { allowImplicitInvocation: implicit }),
    ...(dependencies === undefined ? {} : { dependencies: tools }),
  } };
}

/** 扫描阶段只读取 frontmatter；正文由 load_skill 或详情页懒加载。 */
export async function readSkill(directory: string, id: string, source: Source, pluginId?: string, pluginRoot?: string): Promise<SkillFile> { const content = await readFile(join(directory, 'SKILL.md'), 'utf8'); return withSkillInterface({ ...metadataFromSkill(content, directory, id, source, pluginId), content, ...(pluginRoot === undefined ? {} : { pluginRoot }) }); }
async function readSkillMetadata(directory: string, id: string, source: Source, pluginId?: string, pluginRoot?: string): Promise<SkillFile> {
  const info = await stat(join(directory, 'SKILL.md'));
  let sidecar = '';
  try { const sidecarInfo = await stat(join(directory, 'agents/openai.yaml')); sidecar = `${sidecarInfo.mtimeMs}/${sidecarInfo.size}`; } catch (error) { if (!missing(error)) throw error; }
  const signature = `${info.mtimeMs}/${info.size}/${sidecar}`; const key = `${directory}:${id}`;
  const cached = metadataCache.get(key);
  if (cached?.signature === signature) return cached.skill;
  const stream = createReadStream(join(directory, 'SKILL.md'), { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const metadata: string[] = [];
  try {
    // 到第二个分隔符即停止读取，不把正文带入目录扫描或模型技能目录。
    for await (const line of lines) {
      metadata.push(line);
      if (metadata.length === 1 && line !== '---') break;
      if (metadata.length > 1 && line === '---') break;
    }
    const skill = await withSkillInterface({ ...metadataFromSkill(`${metadata.join('\n')}\n`, directory, id, source, pluginId), ...(pluginRoot === undefined ? {} : { pluginRoot }) });
    metadataCache.set(key, { signature, skill });
    if (metadataCache.size > MAX_SKILLS) metadataCache.delete(metadataCache.keys().next().value!);
    return skill;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Codex 的 recursive discovery：跳过隐藏目录，限制目录和条目数量，稳定排序。 */
async function scanSkills(directory: string, source: Source, prefix: string, pluginId?: string, pluginRoot?: string): Promise<SkillFile[]> {
  const skills: SkillFile[] = []; let directories = 0;
  async function walk(current: string, currentPrefix: string): Promise<void> {
    if (directories++ >= MAX_DIRECTORIES || skills.length >= MAX_SKILLS) return;
    let entries; try { entries = await readdir(current, { withFileTypes: true }); } catch (error) { if (missing(error)) return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue; const child = join(current, entry.name);
      if (entry.isDirectory()) {
        try { skills.push(await readSkillMetadata(child, `${currentPrefix}/${entry.name}`, source, pluginId, pluginRoot)); } catch (error) { if (!missing(error)) throw error; }
        await walk(child, `${currentPrefix}/${entry.name}`);
      }
      if (skills.length >= MAX_SKILLS) return;
    }
  }
  await walk(directory, prefix); return skills;
}
async function scanSkillPath(directory: string, source: Source, prefix: string, pluginId?: string, pluginRoot?: string): Promise<SkillFile[]> {
  try { return [await readSkillMetadata(directory, `${prefix}/${directory.split(/[\\/]/).pop()!}`, source, pluginId, pluginRoot)]; }
  catch (error) { if (!missing(error)) throw error; return scanSkills(directory, source, prefix, pluginId, pluginRoot); }
}

/** 读取插件清单与技能、工具、应用和钩子的真实执行配置。 */
export async function readPlugin(directory: string, id: string, source: Source): Promise<PluginFiles> {
  const value = await pluginManifest(directory);
  const name = extensionName(value.name); const skillsPaths = pathList(value.skills, './skills', '技能目录'); let skills: SkillFile[] = [];
  for (const skillsPath of skillsPaths) {
    try { skills.push(...await scanSkillPath(await pluginPath(directory, skillsPath), 'plugin', id, id, directory)); }
    catch (error) { if (!missing(error) || value.skills !== undefined) throw error; }
  }
  const servers: McpServerFile[] = [];
  try {
    let serverEntries: Record<string, unknown>;
    if (record(value.mcpServers) && !('type' in value.mcpServers)) serverEntries = value.mcpServers;
    else {
      const serverPath = await pluginPath(directory, value.mcpServers === undefined ? './.mcp.json' : text(value.mcpServers, 'MCP 配置路径')); const config: unknown = JSON.parse(await readFile(serverPath, 'utf8'));
      if (!record(config) || !record(config.mcpServers)) throw new Error('MCP 配置缺少 mcpServers 对象。');
      serverEntries = config.mcpServers;
    }
    for (const [serverName, server] of Object.entries(serverEntries)) {
      text(serverName, 'MCP 服务名称'); if (!record(server)) throw new Error('MCP 服务配置必须是对象。');
      if (server.url !== undefined) {
        const url = new URL(text(server.url, 'MCP 服务地址'));
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('MCP 服务需要使用 HTTP 地址。');
        if (server.type !== undefined && !['http', 'streamable_http', 'sse'].includes(String(server.type))) throw new Error('远程 MCP 传输类型无效。');
        servers.push({ name: serverName, command: '', args: [], type: server.type === 'sse' ? 'sse' : 'http', url: url.href, headers: stringMap(server.headers, 'MCP 请求头') });
        continue;
      }
      if (server.type !== undefined && server.type !== 'stdio') throw new Error('MCP 传输类型无效。');
      const command = text(server.command, 'MCP 启动程序'); const args = server.args ?? []; if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) throw new Error('MCP 参数必须是文字数组。'); servers.push({ name: serverName, command, args });
      servers[servers.length - 1] = { ...servers[servers.length - 1]!, env: stringMap(server.env, 'MCP 环境变量') };
    }
  } catch (error) { if (!missing(error) || value.mcpServers !== undefined) throw error; }
  const apps = value.apps !== undefined; const hooks = value.hooks !== undefined; const extensions = record(value.extensions) ? Object.keys(value.extensions) : [];
  if (skills.length === 0 && servers.length === 0 && !apps && !hooks && extensions.length === 0) throw new Error('插件需要至少包含一个已声明能力。');
  const interfaceValue = record(value.interface) ? value.interface : undefined; const display = typeof interfaceValue?.displayName === 'string' ? interfaceValue.displayName : name; const shortDescription = typeof interfaceValue?.shortDescription === 'string' ? interfaceValue.shortDescription : undefined; const capabilities = stringList(interfaceValue?.capabilities, '插件能力');
  const displayFields = await pluginInterface(directory, interfaceValue);
  const appIds: string[] = [];
  if (apps) {
    const config: unknown = typeof value.apps === 'string' ? JSON.parse(await readFile(await pluginPath(directory, value.apps), 'utf8')) : value.apps;
    if (!record(config) || !record(config.apps)) throw new Error('应用配置需要 apps 对象。');
    for (const app of Object.values(config.apps)) { if (!record(app)) throw new Error('应用连接配置无效。'); appIds.push(text(app.id, '应用连接标识')); }
  }
  const parsedHooks: PluginHook[] = [];
  if (hooks) {
    const sources = Array.isArray(value.hooks) ? value.hooks : [value.hooks];
    for (const sourceValue of sources) {
      const config: unknown = typeof sourceValue === 'string' ? JSON.parse(await readFile(await pluginPath(directory, sourceValue), 'utf8')) : sourceValue;
      if (!record(config) || !record(config.hooks)) throw new Error('事件钩子配置需要 hooks 对象。');
      for (const [event, groups] of Object.entries(config.hooks)) {
        if (!Array.isArray(groups)) throw new Error('事件钩子分组需要数组。');
        for (const group of groups) {
          if (!record(group) || !Array.isArray(group.hooks)) throw new Error('事件钩子分组无效。');
          for (const hook of group.hooks) {
            if (!record(hook) || hook.type !== 'command') throw new Error('本机事件钩子需要 command 类型。');
            const timeout = hook.timeout ?? 60;
            if (typeof timeout !== 'number' || timeout <= 0) throw new Error('钩子超时需要正数。');
            parsedHooks.push({ event, command: text(hook.command, '钩子命令'), timeoutMs: timeout * 1000, ...(group.matcher === undefined ? {} : { matcher: text(group.matcher, '钩子匹配规则') }) });
          }
        }
      }
    }
  }
  const item: ExtensionItem = { id, kind: 'plugin', name: display, description: text(value.description ?? shortDescription, '插件描述'), source, installed: true, enabled: true, path: directory, sourceKind: 'host', authority: { kind: 'host', id: source }, skillNames: skills.map(skill => skill.item.name), serverNames: servers.map(server => server.name),
    ...displayFields,
    ...(typeof value.version === 'string' ? { version: value.version } : {}), ...(shortDescription === undefined ? {} : { shortDescription }), ...(capabilities.length === 0 ? {} : { capabilities }), ...(apps ? { hasApps: true } : {}), ...(hooks ? { hasHooks: true } : {}), ...(extensions.length === 0 ? {} : { extensionNames: extensions }), ...(value.keywords === undefined ? {} : { keywords: stringList(value.keywords, '插件关键词') }) };
  return { name, directory, skills, servers, item, hooks: parsedHooks, appIds };
}

/** 固定本机安装目录由当前 userData 解析；数据库不保存原电脑的绝对安装路径。 */
export class DesktopExtensions {
  readonly whisperModels: WhisperModels;
  private marketStore: ExtensionMarketplaces | undefined;
  private watchedRoots: string[] = [];
  private watchers: FSWatcher[] = [];
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly databasePath: string, private readonly root: string, private readonly resources: string, private readonly connections?: ExtensionConnections, changed: () => void = () => {}) {
    this.whisperModels = new WhisperModels(join(root, 'models', 'whisper'), join(resources, 'plugins', 'whisper', 'models.lock.json'), changed);
  }
  /** 独立配置整体加密，一次提交；公开列表只投影变量名称。 */
  private mcpRecords(): StandaloneMcpRecord[] {
    const data = this.connections?.values('standalone-mcp', 'configuration').records;
    if (data === undefined) return [];
    const values: unknown = JSON.parse(data);
    if (!Array.isArray(values)) throw new Error('独立 MCP 配置无效。');
    return values.map((value: unknown) => {
      const config = parseMcpUpdate(value);
      if (!record(value) || typeof value.enabled !== 'boolean' || config.id === undefined) throw new Error('独立 MCP 状态无效。');
      return { ...config, id: config.id, enabled: value.enabled };
    });
  }
  private async writeMcpRecords(records: readonly StandaloneMcpRecord[]): Promise<void> {
    if (this.connections === undefined) throw new Error('凭据存储不可用。');
    await this.connections.configure('standalone-mcp', 'configuration', { records: JSON.stringify(records) });
  }
  async saveMcpServer(value: unknown): Promise<void> {
    const update = parseMcpUpdate(value); const records = this.mcpRecords();
    const previous = update.id === undefined ? undefined : records.find(server => server.id === update.id);
    if (update.id !== undefined && previous === undefined) throw new Error('找不到 MCP 服务器。');
    if (records.some(server => server.name === update.name && server.id !== update.id)) throw new Error('服务器名称已经存在。');
    // 编辑框不回显秘密；空值保留同名已保存值，省略键则移除该变量。
    const secrets = (next: Readonly<Record<string, string>>, old: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(next).map(([key, input]) => [key, input === '' && key in old ? old[key]! : input]));
    const next: StandaloneMcpRecord = { ...update, id: previous?.id ?? `mcp:${randomUUID()}`, enabled: previous?.enabled ?? true,
      environment: secrets(update.environment, previous?.environment ?? {}), headers: secrets(update.headers, previous?.headers ?? {}) };
    await this.writeMcpRecords([...records.filter(server => server.id !== next.id), next]);
  }
  async setMcpEnabled(id: string, enabled: boolean): Promise<void> {
    const records = this.mcpRecords();
    if (!records.some(server => server.id === id)) throw new Error('找不到 MCP 服务器。');
    await this.writeMcpRecords(records.map(server => server.id === id ? { ...server, enabled } : server));
  }
  async removeMcpServer(id: string): Promise<void> {
    const records = this.mcpRecords();
    if (!records.some(server => server.id === id)) throw new Error('找不到 MCP 服务器。');
    await this.writeMcpRecords(records.filter(server => server.id !== id));
  }
  private markets(): ExtensionMarketplaces { return this.marketStore ??= new ExtensionMarketplaces(this.databasePath, this.root); }
  /** 监视安装目录与当前项目；目录尚未创建时监视最近存在的父目录。 */
  async watchSkills(workingDirectory: string | undefined, changed: () => void, failed: (error: Error) => void): Promise<void> {
    await mkdir(this.root, { recursive: true });
    // Windows 短路径别名会触发 libuv 递归监视器的目录前缀断言，统一使用真实路径。
    const roots = [await realpath(this.root)];
    let projectIsWorkspaceRoot = false;
    if (workingDirectory !== undefined) {
      for (const candidate of [join(workingDirectory, '.agents/skills'), join(workingDirectory, '.agents'), workingDirectory]) {
        try { roots.push(await realpath(candidate)); projectIsWorkspaceRoot = candidate === workingDirectory; break; }
        catch (error) { if (!missing(error)) throw error; }
      }
    }
    if (JSON.stringify(roots) === JSON.stringify(this.watchedRoots)) return;
    this.stopWatching();
    this.watchedRoots = roots;
    try {
      for (const [index, path] of roots.entries()) this.watchers.push(watch(path, { recursive: index === 0 || !projectIsWorkspaceRoot }, (_event, filename) => {
        // 当 .agents 不存在时，只关心它的创建，避免项目普通文件改动刷新技能页。
        if (index > 0 && projectIsWorkspaceRoot && filename !== '.agents') return;
        if (this.changeTimer !== undefined) clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => { this.changeTimer = undefined; metadataCache.clear(); changed(); }, 50);
      }).on('error', error => { this.stopWatching(); failed(error); }));
    } catch (error) { this.stopWatching(); throw error; }
  }
  /** 窗口关闭时释放文件监视句柄，不让监视器阻止进程退出。 */
  stopWatching(): void {
    this.watchers.forEach(watcher => watcher.close());
    this.watchers = [];
    this.watchedRoots = [];
    if (this.changeTimer !== undefined) clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
  }
  private state(): ExtensionState {
    const value = readDesktopDocument(this.databasePath, 'extensions'); if (value === null) return { installed: [], disabled: [] }; if (!record(value) || !Array.isArray(value.installed) || !Array.isArray(value.disabled) || value.disabled.some(id => typeof id !== 'string')) throw new Error('扩展安装记录无效。');
    const installed = value.installed.map((entry: unknown): InstalledExtension => {
      if (!record(entry) || (entry.kind !== 'plugin' && entry.kind !== 'skill') || !['builtin', 'local', 'marketplace'].includes(String(entry.source))) throw new Error('扩展安装记录无效。');
      const name = extensionName(entry.name); const marketplaceId = entry.marketplaceId === undefined ? undefined : extensionName(entry.marketplaceId);
      if (entry.id !== `${entry.kind}:${name}${marketplaceId === undefined ? '' : `@${marketplaceId}`}`) throw new Error('扩展安装标识无效。');
      return { id: entry.id as string, kind: entry.kind, name, source: entry.source as InstalledExtension['source'], ...(typeof entry.version === 'string' ? { version: entry.version } : {}), ...(marketplaceId === undefined ? {} : { marketplaceId }) };
    });
    return { installed, disabled: value.disabled as string[] };
  }
  private save(state: ExtensionState): void { writeDesktopDocuments(this.databasePath, [{ name: 'extensions', value: state }]); }
  private directory(kind: Kind, name: string, marketplaceId?: string): string { return join(this.root, `${kind}s`, `${name}${marketplaceId === undefined ? '' : `@${marketplaceId}`}`); }
  async files(workingDirectory?: string): Promise<{ plugins: PluginFiles[]; skills: SkillFile[]; mcpServers: StandaloneMcpFile[] }> {
    const state = this.state(); const plugins: PluginFiles[] = []; const skills: SkillFile[] = [];
    for (const installed of state.installed) {
      const directory = this.directory(installed.kind, installed.name, installed.marketplaceId);
      if (installed.kind === 'plugin') { const plugin = await readPlugin(directory, installed.id, installed.source); plugins.push({ ...plugin, item: { ...plugin.item, enabled: !state.disabled.includes(installed.id), ...(installed.marketplaceId === undefined ? {} : { marketplaceId: installed.marketplaceId }), ...(installed.version === undefined ? {} : { version: installed.version }), versions: this.versions(installed.id) } }); skills.push(...plugin.skills); }
      else skills.push(await readSkillMetadata(directory, installed.id, installed.source));
    }
    if (workingDirectory !== undefined) skills.push(...await scanSkills(join(workingDirectory, '.agents', 'skills'), 'project', 'project'));
    const configured = plugins.map(plugin => {
      // 随包语音与视觉服务的运行资源、模型和密钥由宿主设置提供，不能改接远程 MCP。
      const managed = plugin.item.source === 'builtin' && ['plugin:whisper', 'plugin:vision'].includes(plugin.item.id);
      const servers = [...plugin.servers];
      for (const appId of plugin.appIds ?? []) {
        const config = this.connections?.values(plugin.item.id, appId);
        if (config?.url) servers.push({ name: appId, command: '', args: [], type: 'http', url: config.url });
      }
      const effectiveServers = servers.map(server => {
        const config = this.connections?.values(plugin.item.id, server.name) ?? {};
        const substitute = (value: string) => value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (original, name: string) => ['PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT'].includes(name) ? original
          : managed ? original : config[name] ?? original);
        const configuredUrl = managed ? undefined : config.url;
        return { ...server, ...(configuredUrl === undefined ? {} : { url: configuredUrl }), ...(server.env === undefined ? {} : { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, substitute(value)])) }),
          ...(server.headers === undefined ? {} : { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, substitute(value)])) }) };
      });
      return { ...plugin, servers: effectiveServers, item: { ...plugin.item, connections: [
        ...effectiveServers.map(server => ({ name: server.name, transport: server.type ?? 'stdio', connected: server.url === undefined || this.connections?.connected(plugin.item.id, server.name, server.url) === true,
          ...(server.url === undefined ? {} : { url: server.url }), variables: [...new Set([...Object.values(servers.find(original => original.name === server.name)?.env ?? {}), ...Object.values(servers.find(original => original.name === server.name)?.headers ?? {})].flatMap(value => [...value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map(match => match[1]!).filter(name => name !== 'PLUGIN_ROOT' && name !== 'CODEX_PLUGIN_ROOT' && !managed)))] })),
        ...(plugin.appIds ?? []).filter(id => !servers.some(server => server.name === id)).map(id => ({ name: id, transport: 'app', connected: false })),
      ] } };
    });
    return { plugins: configured, mcpServers: this.mcpRecords().map(server => ({ id: server.id, enabled: server.enabled, directory: workingDirectory ?? dirname(this.databasePath),
      server: { name: server.name, type: server.transport, command: server.command, args: [...server.args],
        ...(server.transport === 'stdio' ? { env: server.environment } : { url: server.url, headers: server.headers }) } })), skills: skills.map(skill => {
      const dependencies = (skill.toolDependencies ?? []).map(dependency => {
        const config = this.connections?.values(skill.item.id, dependency.value);
        return { ...dependency, ...(config?.url ? { url: config.url } : {}) };
      });
      return { ...skill, toolDependencies: dependencies, item: { ...skill.item,
        connections: dependencies.filter(dependency => dependency.type === 'mcp').map(dependency => ({ name: dependency.value, transport: dependency.url === undefined ? 'app' : dependency.transport ?? 'http', connected: dependency.url !== undefined && this.connections?.connected(skill.item.id, dependency.value, dependency.url) === true, ...(dependency.url === undefined ? {} : { url: dependency.url }) })),
        enabled: !state.disabled.includes(skill.item.id) && (skill.item.pluginId === undefined || !state.disabled.includes(skill.item.pluginId)) } };
    }) };
  }
  async list(workingDirectory?: string): Promise<ExtensionSnapshot> {
    const files = await this.files(workingDirectory); const plugins = files.plugins.map(plugin => plugin.item); const skills = files.skills.map(skill => skill.item);
    for (const entry of catalog) {
      const items = entry.kind === 'plugin' ? plugins : skills;
      const directory = join(this.resources, entry.directory);
      const current = items.find(item => item.id === entry.id);
      if (current !== undefined) {
        const available = entry.kind === 'plugin' ? (await readPlugin(directory, entry.id, 'builtin')).item : (await readSkillMetadata(directory, entry.id, 'builtin')).item;
        if (current.source === 'builtin' && available.version !== undefined && current.version !== available.version) items[items.indexOf(current)] = { ...current, availableVersion: available.version };
        continue;
      }
      if (entry.kind === 'plugin') {
        const plugin = await readPlugin(directory, entry.id, 'builtin');
        plugins.push({ ...plugin.item, installed: false, enabled: false });
        // 尚未安装的内置插件也能预览技能；安装动作仍由所属插件承担。
        skills.push(...plugin.skills.map(skill => ({ ...skill.item, installed: false, enabled: false })));
      } else skills.push({ ...(await readSkillMetadata(directory, entry.id, 'builtin')).item, installed: false, enabled: false });
    }
    const markets = this.markets(); const errors: string[] = [];
    if (plugins.some(item => item.id === 'plugin:video-editing' && item.installed)
      && !plugins.some(item => item.id === 'plugin:ffmpeg' && item.installed && item.enabled)) {
      errors.push('视频剪辑需要安装并启用独立 FFmpeg 插件；旧版内含的探测服务已停用，请升级视频剪辑技能。会话和文件保留。');
    }
    const remoteItems: ExtensionItem[] = [];
    for (const entry of await markets.entries()) {
      try {
        if (typeof entry.source === 'string' || entry.source.source === 'local') {
          const path = typeof entry.source === 'string' ? entry.source : text(entry.source.path, '插件来源路径');
          const directory = await marketPath(entry.root, path);
          const metadata = await pluginManifest(directory);
          const display = record(metadata.interface) ? metadata.interface : {};
          remoteItems.push({ id: entry.id, kind: 'plugin', name: typeof display.displayName === 'string' ? display.displayName : entry.name,
            description: text(metadata.description ?? display.shortDescription ?? entry.name, '插件描述'), source: 'marketplace', installed: false, enabled: false,
            marketplaceId: entry.marketplaceId, installable: entry.installable, ...await pluginInterface(directory, display),
            ...(entry.category === undefined ? {} : { category: entry.category }), ...(typeof display.shortDescription === 'string' ? { shortDescription: display.shortDescription } : {}),
            ...(typeof metadata.version === 'string' ? { version: metadata.version } : {}), hasApps: metadata.apps !== undefined, hasHooks: metadata.hooks !== undefined });
        } else {
          const display = record(entry.metadata.interface) ? entry.metadata.interface : {};
          remoteItems.push({ id: entry.id, kind: 'plugin', name: typeof display.displayName === 'string' ? display.displayName : entry.name, description: typeof entry.metadata.description === 'string' ? entry.metadata.description : entry.name,
            source: 'marketplace', installed: false, enabled: false, marketplaceId: entry.marketplaceId, installable: entry.installable, ...(entry.category === undefined ? {} : { category: entry.category }) });
        }
      } catch (error) { if (!(error instanceof Error)) throw error; errors.push(`${entry.name}：${error.message}`); }
    }
    // 只展示用户主动添加的市场，不把第三方目录当成已提供的应用能力。
    for (const item of remoteItems) {
      const current = plugins.find(plugin => plugin.id === item.id);
      if (current === undefined) plugins.push(item);
      else if (current.installed && item.version !== undefined && item.version !== current.version) plugins[plugins.indexOf(current)] = { ...current, availableVersion: item.version };
    }
    return { plugins, skills, whisperModel: await this.whisperModels.status(), marketplaces: markets.records().map(({ folder: _folder, ...market }) => market), errors,
      mcpServers: this.mcpRecords().map(({ environment, headers, ...server }) => ({ ...server, environmentNames: Object.keys(environment), headerNames: Object.keys(headers),
        connected: server.transport !== 'stdio' && this.connections?.connected(server.id, server.name, server.url) === true })) };
  }
  private async atomicCopy(source: string, destination: string, kind: Kind, id: string, origin: InstalledExtension['source']): Promise<ExtensionItem> {
    await validatePackageLinks(source);
    await mkdir(join(this.root, '.staging'), { recursive: true }); const staging = join(this.root, '.staging', `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`); await mkdir(join(this.root, `${kind}s`), { recursive: true });
    try { await cp(source, staging, { recursive: true, dereference: true });
      if (id === 'plugin:ffmpeg' && origin === 'builtin') await installFFmpegRuntime(staging, join(this.root, '.ffmpeg-archives'));
      if (id === 'plugin:whisper' && origin === 'builtin') await installWhisperRuntime(staging, join(this.root, '.whisper-archives'));
      const parsed = kind === 'plugin' ? await readPlugin(staging, id, origin) : await readSkill(staging, id, origin); await renameDirectory(staging, destination); return parsed.item; } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }
  /** 先完成暂存目录解析，再交换旧目录；新包解析失败时旧版本仍然保留。 */
  private async atomicReplace(source: string, destination: string, kind: Kind, id: string, origin: InstalledExtension['source']): Promise<ExtensionItem> {
    await validatePackageLinks(source);
    await mkdir(join(this.root, '.staging'), { recursive: true });
    await mkdir(join(this.root, `${kind}s`), { recursive: true });
    const token = `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const staging = join(this.root, '.staging', token);
    const backup = join(this.root, '.staging', `${token}-old`);
    let backedUp = false;
    try {
      await cp(source, staging, { recursive: true, dereference: true });
      if (id === 'plugin:ffmpeg' && origin === 'builtin') await installFFmpegRuntime(staging, join(this.root, '.ffmpeg-archives'));
      if (id === 'plugin:whisper' && origin === 'builtin') await installWhisperRuntime(staging, join(this.root, '.whisper-archives'));
      const parsed = kind === 'plugin' ? await readPlugin(staging, id, origin) : await readSkill(staging, id, origin);
      try { await renameDirectory(destination, backup); backedUp = true; } catch (error) { if (!missing(error)) throw error; }
      try {
        await renameDirectory(staging, destination);
      } catch (error) {
        // 只有发布新目录失败才恢复旧目录；删除备份失败不能触发删除新安装。
        if (backedUp) {
          try { await renameDirectory(backup, destination); }
          catch (restoreError) { throw new AggregateError([error, restoreError], `发布失败且无法恢复旧版本；旧目录保存在 ${backup}`); }
        }
        throw error;
      }
      if (backedUp) await rm(backup, { recursive: true, force: true });
      return parsed.item;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async importDirectory(kind: Kind, source: string, origin: 'builtin' | 'local' = 'local'): Promise<void> {
    const parsed = kind === 'plugin' ? await readPlugin(source, '', 'local') : await readSkill(source, '', 'local');
    const rawName = 'name' in parsed ? parsed.name : parsed.item.name.toLowerCase();
    const name = kind === 'skill' && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(rawName) ? extensionName(basename(source).toLowerCase()) : extensionName(rawName);
    const id = `${kind}:${name}`; const state = this.state();
    if (state.installed.some(item => item.id === id) || await (async () => { try { await realpath(this.directory(kind, name)); return true; } catch (error) { if (missing(error)) return false; throw error; } })()) throw new Error('同名扩展已经安装，请先卸载后重新导入。');
    const item = await this.atomicCopy(source, this.directory(kind, name), kind, id, origin); this.save({ installed: [...state.installed, { id, kind, name, source: origin, ...(item.version === undefined ? {} : { version: item.version }) }], disabled: state.disabled.filter(value => value !== id && !value.startsWith(`${id}/`)) });
  }
  async install(id: string): Promise<void> {
    const builtin = catalog.find(item => item.id === id);
    if (builtin !== undefined) { await this.importDirectory(builtin.kind, join(this.resources, builtin.directory), 'builtin'); return; }
    const entry = (await this.markets().entries()).find(item => item.id === id);
    if (entry === undefined) throw new Error('找不到市场插件。');
    if (!entry.installable) throw new Error('此插件不可安装。');
    const state = this.state(); if (state.installed.some(item => item.id === id)) throw new Error('插件已经安装。');
    const source = await this.markets().materialize(entry);
    try {
      const parsed = await readPlugin(source.directory, id, 'marketplace');
      if (parsed.name !== entry.name) throw new Error('插件清单与市场身份不一致。');
      const item = await this.atomicCopy(source.directory, this.directory('plugin', entry.name, entry.marketplaceId), 'plugin', id, 'marketplace');
      this.save({ ...state, installed: [...state.installed, { id, kind: 'plugin', name: entry.name, source: 'marketplace', marketplaceId: entry.marketplaceId, ...(item.version === undefined ? {} : { version: item.version }) }] });
    } finally { await source.cleanup(); }
  }
  async addMarketplace(source: string): Promise<void> { await this.markets().add(source); }
  async removeMarketplace(id: string): Promise<void> { await this.markets().remove(id); }
  async configure(id: string, server: string, values: Readonly<Record<string, string>>, workingDirectory?: string): Promise<void> {
    if (id === 'plugin:whisper') throw new Error('Whisper 的运行程序及模型由宿主管理，不能通过连接配置替换路径。');
    const files = await this.files(workingDirectory); const plugin = files.plugins.find(item => item.item.id === id); const skill = files.skills.find(item => item.item.id === id);
    if (plugin?.item.id === 'plugin:vision' && plugin.item.source === 'builtin') throw new Error('Vision 的模型及 API 密钥由运行时设置管理，不能通过插件连接配置替换。');
    if (!plugin?.servers.some(item => item.name === server) && !plugin?.appIds?.includes(server) && !skill?.toolDependencies?.some(dependency => dependency.value === server)) throw new Error('找不到插件连接。');
    if (values.url !== undefined) { const url = new URL(values.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('连接地址需要使用 HTTP。'); }
    if (this.connections === undefined) throw new Error('凭据存储不可用。');
    await this.connections.configure(id, server, values);
  }
  async connect(id: string, serverName: string, disconnect = false, workingDirectory?: string): Promise<void> {
    const files = await this.files(workingDirectory); const plugin = files.plugins.find(item => item.item.id === id);
    const server = plugin?.servers.find(item => item.name === serverName) ?? files.mcpServers.find(item => item.id === id && item.server.name === serverName)?.server ?? files.skills.find(item => item.item.id === id)?.toolDependencies?.find(dependency => dependency.value === serverName);
    if (server?.url === undefined || this.connections === undefined) throw new Error('请先配置远程连接地址。');
    if (disconnect) await this.connections.disconnect(id, serverName, server.url);
    else await this.connections.authorize(id, serverName, server.url);
  }
  versions(id: string): NonNullable<ExtensionItem['versions']> {
    const value = readDesktopDocument(this.databasePath, `extension-versions:${id}`);
    if (value === null) return [];
    if (!Array.isArray(value) || value.some(entry => !record(entry) || typeof entry.id !== 'string' || !/^[a-z0-9-]+$/.test(entry.id) || typeof entry.version !== 'string' || typeof entry.createdAt !== 'string')) throw new Error('插件版本历史无效。');
    return value as NonNullable<ExtensionItem['versions']>;
  }
  private versionDirectory(entry: InstalledExtension, versionId: string): string { return join(this.root, 'versions', `${entry.kind}-${entry.name}${entry.marketplaceId === undefined ? '' : `@${entry.marketplaceId}`}`, versionId); }
  /** 保存已验证旧安装，供详情页选择回滚；版本目录不参与技能扫描。 */
  private async preserveVersion(entry: InstalledExtension): Promise<void> {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`; const directory = this.versionDirectory(entry, id);
    await mkdir(resolve(directory, '..'), { recursive: true });
    await cp(this.directory(entry.kind, entry.name, entry.marketplaceId), directory, { recursive: true });
    writeDesktopDocuments(this.databasePath, [{ name: `extension-versions:${entry.id}`, value: [{ id, version: entry.version ?? '未标注版本', createdAt: new Date().toISOString() }, ...this.versions(entry.id)] }]);
  }
  async update(id: string): Promise<void> {
    const state = this.state(); const entry = state.installed.find(item => item.id === id);
    const builtin = catalog.find(item => item.id === id);
    if (entry?.source === 'builtin' && builtin !== undefined) {
      const source = join(this.resources, builtin.directory);
      const available = builtin.kind === 'plugin' ? (await readPlugin(source, id, 'builtin')).item : (await readSkillMetadata(source, id, 'builtin')).item;
      if (available.version === entry.version) return;
      await this.preserveVersion(entry);
      const item = await this.atomicReplace(source, this.directory(entry.kind, entry.name), entry.kind, id, 'builtin');
      this.save({ ...state, installed: state.installed.map(current => current.id === id ? { ...entry, ...(item.version === undefined ? {} : { version: item.version }) } : current) });
      return;
    }
    if (entry === undefined || entry.marketplaceId === undefined) throw new Error('此插件没有可更新的市场来源。');
    const market = this.markets().records().find(market => market.id === entry.marketplaceId);
    if (market === undefined) throw new Error('请先恢复插件的市场来源。');
    await this.markets().add(market.source, market.id);
    const sourceEntry = (await this.markets().entries()).find(item => item.id === id); if (sourceEntry === undefined) throw new Error('请先恢复插件的市场来源。');
    const source = await this.markets().materialize(sourceEntry);
    try {
      const parsed = await readPlugin(source.directory, id, 'marketplace'); if (parsed.name !== entry.name) throw new Error('插件身份发生变化。');
      if (parsed.item.version === entry.version) return;
      await this.preserveVersion(entry);
      const item = await this.atomicReplace(source.directory, this.directory(entry.kind, entry.name, entry.marketplaceId), entry.kind, id, 'marketplace');
      this.save({ ...state, installed: state.installed.map(current => current.id === id ? { ...entry, ...(item.version === undefined ? {} : { version: item.version }) } : current) });
    } finally { await source.cleanup(); }
  }
  async rollback(id: string, versionId: string): Promise<void> {
    const state = this.state(); const entry = state.installed.find(item => item.id === id);
    const version = this.versions(id).find(item => item.id === versionId); if (entry === undefined || version === undefined) throw new Error('找不到已缓存版本。');
    const source = this.versionDirectory(entry, version.id);
    await this.preserveVersion(entry);
    const item = await this.atomicReplace(source, this.directory(entry.kind, entry.name, entry.marketplaceId), entry.kind, id, entry.source);
    this.save({ ...state, installed: state.installed.map(current => current.id === id ? { ...entry, ...(item.version === undefined ? {} : { version: item.version }) } : current) });
  }
  /** 本机内置资源同步：失败项不覆盖当前安装；不包含 Codex 远程插件同步。 */
  async reconcile(): Promise<ExtensionReconcileResult> {
    const state = this.state(); const changed: string[] = []; const failed: { id: string; message: string }[] = [];
    const installed = [...state.installed];
    for (let index = 0; index < installed.length; index += 1) {
      const entry = installed[index]!;
      if (entry.source !== 'builtin') continue;
      const catalogEntry = catalog.find(item => item.id === entry.id);
      if (catalogEntry === undefined) continue;
      try {
        const source = join(this.resources, catalogEntry.directory);
        const sourceItem = catalogEntry.kind === 'plugin'
          ? (await readPlugin(source, entry.id, 'builtin')).item
          : (await readSkillMetadata(source, entry.id, 'builtin')).item;
        let destinationExists = true;
        try { await realpath(this.directory(entry.kind, entry.name)); } catch (error) { if (missing(error)) destinationExists = false; else throw error; }
        if (!destinationExists || sourceItem.version !== entry.version) {
          if (destinationExists) await this.preserveVersion(entry);
          const item = await this.atomicReplace(source, this.directory(entry.kind, entry.name), entry.kind, entry.id, 'builtin');
          installed[index] = { id: entry.id, kind: entry.kind, name: entry.name, source: entry.source, ...(item.version === undefined ? {} : { version: item.version }) };
          changed.push(entry.id);
        }
      } catch (error) {
        failed.push({ id: entry.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (changed.length > 0) this.save({ ...state, installed });
    for (const market of this.markets().records()) {
      try { await this.markets().add(market.source, market.id); }
      catch (error) { if (!(error instanceof Error)) throw error; failed.push({ id: market.id, message: error.message }); }
    }
    return { changed, failed };
  }
  async setEnabled(id: string, enabled: boolean, workingDirectory?: string): Promise<void> { const snapshot = await this.list(workingDirectory); const item = [...snapshot.plugins, ...snapshot.skills].find(item => item.id === id && item.installed); if (item === undefined) throw new Error('扩展尚未安装。'); if (enabled && item.pluginId !== undefined && snapshot.plugins.find(plugin => plugin.id === item.pluginId)?.enabled !== true) throw new Error('请先启用所属插件。'); const state = this.state(); this.save({ ...state, disabled: [...state.disabled.filter(value => value !== id), ...(enabled ? [] : [id])] }); }
  async uninstall(id: string): Promise<void> { const state = this.state(); const entry = state.installed.find(item => item.id === id); if (entry === undefined) throw new Error('项目技能和插件附带技能由其来源管理，不能单独卸载。'); await rm(this.directory(entry.kind, entry.name, entry.marketplaceId), { recursive: true, force: false }); this.save({ installed: state.installed.filter(item => item.id !== id), disabled: state.disabled.filter(value => value !== id && !value.startsWith(`${id}/`)) }); }
  async listSkills(workingDirectory?: string, forceReload = false): Promise<readonly ExtensionItem[]> {
    if (forceReload) metadataCache.clear();
    const snapshot = await this.list(workingDirectory);
    return snapshot.skills;
  }
  /** 正文、打开文件和定位文件共用技能身份解析，不接受渲染层传入任意路径。 */
  private async skillFile(id: string, workingDirectory?: string): Promise<SkillFile> {
    const files = await this.files(workingDirectory);
    const skill = files.skills.find(entry => entry.item.id === id);
    if (skill !== undefined) return skill;
    const entry = catalog.find(item => item.id === id && item.kind === 'skill');
    if (entry !== undefined) return readSkillMetadata(join(this.resources, entry.directory), entry.id, 'builtin');
    for (const plugin of catalog.filter(item => item.kind === 'plugin' && id.startsWith(`${item.id}/`))) {
      const preview = await readPlugin(join(this.resources, plugin.directory), plugin.id, 'builtin');
      const child = preview.skills.find(item => item.item.id === id);
      if (child !== undefined) return child;
    }
    throw new Error('找不到技能。');
  }
  async skillPath(id: string, workingDirectory?: string): Promise<string> {
    const skill = await this.skillFile(id, workingDirectory);
    return realpath(join(skill.directory, 'SKILL.md'));
  }
  async readSkill(id: string, workingDirectory?: string): Promise<string> {
    const skill = await this.skillFile(id, workingDirectory);
    return (await readSkill(skill.directory, skill.item.id, skill.item.source, skill.item.pluginId, skill.pluginRoot)).content!;
  }
  async readDetail(id: string, workingDirectory?: string): Promise<string> {
    const files = await this.files(workingDirectory); const skill = files.skills.find(skill => skill.item.id === id); if (skill !== undefined) return (await readSkill(skill.directory, skill.item.id, skill.item.source, skill.item.pluginId, skill.pluginRoot)).content!; const plugin = files.plugins.find(plugin => plugin.item.id === id); if (plugin !== undefined) return JSON.stringify(await pluginManifest(plugin.directory), null, 2); const entry = catalog.find(item => item.id === id);
    if (entry === undefined) { const item = (await this.list(workingDirectory)).plugins.find(item => item.id === id); if (item === undefined) throw new Error('找不到扩展。'); return JSON.stringify(item, null, 2); }
    return readFile(join(this.resources, entry.directory, entry.kind === 'skill' ? 'SKILL.md' : '.codex-plugin/plugin.json'), 'utf8');
  }
}
