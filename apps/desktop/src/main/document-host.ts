import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { link, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { createFileArtifact, resolveCreatablePath, resolveScopedPath, type WorkspacePort } from '@agent-desktop/local-tools';
import type { ToolResult } from '@agent-desktop/model';
import { SessionPersistenceError } from '@agent-desktop/session';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';

export type DocumentToolName = 'read_pdf' | 'render_pdf_page' | 'read_docx' | 'read_xlsx' | 'read_csv';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 100_000;
type Input = Record<string, unknown>;
interface XmlNode { [key: string]: unknown }

function integer(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${label} 必须是 1 至 ${maximum} 的整数。`);
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
  return value;
}

/** 文件范围来自真实宿主，解析器只收到已经授权且有大小上限的字节。 */
async function documentBytes(input: Input, workspace: WorkspacePort, signal?: AbortSignal): Promise<{ filePath: string; bytes: Buffer }> {
  const filePath = optionalString(input.filePath, 'filePath');
  if (filePath === undefined) throw new Error('需要 filePath。');
  const scoped = await resolveScopedPath(workspace.confirmedDirectory(), filePath, workspace.fileAccess === 'all');
  if (!scoped.ok) throw new Error(scoped.message);
  const info = await stat(scoped.path);
  if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) throw new Error('文档必须是非空文件且不超过 20 MiB；请拆分大文件。');
  signal?.throwIfAborted();
  const bytes = await readFile(scoped.path, signal === undefined ? undefined : { signal });
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('文档读取期间超过 20 MiB。');
  return { filePath: scoped.path, bytes };
}

/** 同步解析前核对压缩目录；只解压所需 DOCX XML，XLSX 只用此步骤检查展开体积。 */
async function officeEntries(bytes: Buffer, selected: readonly string[], signal?: AbortSignal): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate');
  let expanded = 0;
  const entries = unzipSync(bytes, { filter(entry) {
    signal?.throwIfAborted();
    expanded += entry.originalSize;
    if (expanded > 64 * 1024 * 1024) throw new Error('Office 文档解压后超过 64 MiB，不能完整解析。');
    if (selected.includes(entry.name) && entry.originalSize > 8 * 1024 * 1024) throw new Error('DOCX 正文或样式 XML 超过 8 MiB。');
    return selected.includes(entry.name);
  } });
  signal?.throwIfAborted();
  return entries;
}

const nested = (nodes: readonly XmlNode[], key: string): XmlNode[] => nodes.flatMap(node => Array.isArray(node[key]) ? node[key] as XmlNode[] : []);
const attribute = (node: XmlNode | undefined, key: string): string | undefined => {
  const attrs = node?.[':@'];
  return typeof attrs === 'object' && attrs !== null && typeof (attrs as Input)[key] === 'string' ? (attrs as Record<string, string>)[key] : undefined;
};
function xmlText(nodes: readonly XmlNode[]): string {
  let text = '';
  for (const node of nodes) for (const [key, value] of Object.entries(node)) {
    if (key === 't' && Array.isArray(value)) text += (value as XmlNode[]).map(item => typeof item['#text'] === 'string' ? item['#text'] : '').join('');
    else if (key === 'tab') text += '\t';
    else if (key === 'br' || key === 'cr') text += '\n';
    else if (key !== ':@' && key !== 'del' && Array.isArray(value)) text += xmlText(value as XmlNode[]);
  }
  return text;
}

async function readDocx(bytes: Buffer, input: Input, context: ToolExecutionContext): Promise<unknown> {
  const entries = await officeEntries(bytes, ['word/document.xml', 'word/styles.xml'], context.signal);
  if (entries['word/document.xml'] === undefined) throw new Error('DOCX 缺少 word/document.xml。');
  const { XMLParser, XMLValidator } = await import('fast-xml-parser');
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, parseTagValue: false, trimValues: false });
  const parse = (value: Uint8Array): XmlNode[] => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    if (XMLValidator.validate(text) !== true) throw new Error('DOCX XML 结构损坏。');
    return parser.parse(text) as XmlNode[];
  };
  const styleLevels = new Map<string, number>();
  if (entries['word/styles.xml'] !== undefined) for (const style of nested(parse(entries['word/styles.xml']), 'styles')) {
    const items = style.style as XmlNode[] | undefined;
    if (items === undefined) continue;
    const id = attribute(style, 'styleId');
    const name = items.find(node => node.name !== undefined);
    const nameValue = attribute(name, 'val') ?? id;
    const heading = nameValue?.match(/^heading\s*([1-9])$/i);
    const outline = nested(items, 'pPr').find(node => node.outlineLvl !== undefined);
    const level = attribute(outline, 'val');
    if (id !== undefined && (heading !== undefined || level !== undefined)) styleLevels.set(id, heading ? Number(heading[1]) : Number(level) + 1);
  }
  const body = nested(nested(parse(entries['word/document.xml']), 'document'), 'body');
  if (body.length === 0) throw new Error('DOCX 没有有效 document/body。');
  const blocks: unknown[] = [];
  for (const node of body) {
    context.signal?.throwIfAborted();
    if (Array.isArray(node.p)) {
      const children = node.p as XmlNode[];
      const props = nested(children, 'pPr');
      const style = attribute(props.find(item => item.pStyle !== undefined), 'val');
      const outline = attribute(props.find(item => item.outlineLvl !== undefined), 'val');
      const level = outline === undefined ? styleLevels.get(style ?? '') ?? Number(style?.match(/^Heading([1-9])$/i)?.[1] ?? 0) : Number(outline) + 1;
      blocks.push({ type: level > 0 ? 'heading' : 'paragraph', text: xmlText(children), ...(level > 0 ? { level } : {}), ...(style === undefined ? {} : { style }) });
    } else if (Array.isArray(node.tbl)) {
      const rows = (node.tbl as XmlNode[]).filter(item => Array.isArray(item.tr)).map(row => (row.tr as XmlNode[])
        .filter(cell => Array.isArray(cell.tc)).map(cell => (cell.tc as XmlNode[]).filter(item => Array.isArray(item.p))
          .map(paragraph => xmlText(paragraph.p as XmlNode[])).join('\n')));
      blocks.push({ type: 'table', rows });
    }
    if (blocks.length > 20_000) throw new Error('DOCX 超过 20000 个内容块，请拆分文件。');
  }
  const start = integer(input.startBlock, 1, Math.max(1, blocks.length), 'startBlock');
  const maximum = integer(input.maxBlocks, 100, 200, 'maxBlocks');
  return { blockCount: blocks.length, blocks: blocks.slice(start - 1, start - 1 + maximum).map((block, index) => ({ index: start + index, ...(block as object) })),
    ...(start - 1 + maximum < blocks.length ? { nextStartBlock: start + maximum, truncated: true } : {}) };
}

/** 只返回 XLSX 存储的公式与缓存值，不把没有计算过的公式伪装成已求值。 */
async function readXlsx(bytes: Buffer, input: Input, context: ToolExecutionContext): Promise<unknown> {
  await officeEntries(bytes, [], context.signal);
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  context.signal?.throwIfAborted();
  if (workbook.worksheets.length === 0) throw new Error('XLSX 没有工作表。');
  const sheetName = optionalString(input.sheet, 'sheet');
  const sheet = sheetName === undefined ? workbook.worksheets[0]! : workbook.getWorksheet(sheetName);
  if (sheet === undefined) throw new Error(`找不到工作表：${sheetName}`);
  let startRow = integer(input.startRow, 1, 1_048_576, 'startRow');
  let endRow = startRow + integer(input.maxRows, 100, 200, 'maxRows') - 1;
  let startColumn = 1; let endColumn = Math.min(sheet.columnCount, 50);
  const range = optionalString(input.range, 'range');
  if (range !== undefined) {
    const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/i.exec(range);
    if (match === null) throw new Error('range 必须是 A1:C20 格式。');
    const column = (letters: string) => [...letters.toUpperCase()].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
    startColumn = column(match[1]!); startRow = Number(match[2]); endColumn = column(match[3]!); endRow = Number(match[4]);
    if (endRow < startRow || endColumn < startColumn || endRow > 1_048_576 || endColumn > 16_384
      || endRow - startRow >= 200 || endColumn - startColumn >= 50) throw new Error('range 超出 XLSX 边界或 200 行、50 列输出预算。');
  }
  const cells: unknown[] = [];
  for (let row = startRow; row <= Math.min(endRow, sheet.rowCount); row += 1) {
    if (row % 25 === 0) { await setImmediate(); context.signal?.throwIfAborted(); }
    for (let column = startColumn; column <= endColumn; column += 1) {
      const cell = sheet.getCell(row, column);
      const value = cell.value;
      if (value === null) continue;
      if (typeof value === 'object' && 'formula' in value || typeof value === 'object' && value !== null && 'sharedFormula' in value) {
        cells.push({ address: cell.address, formula: cell.formula, cachedResultAvailable: cell.result !== undefined,
          ...(cell.result === undefined ? {} : { result: cell.result }) });
      } else cells.push({ address: cell.address, value: value instanceof Date ? value.toISOString()
        : typeof value === 'object' && 'richText' in value ? value.richText.map(part => part.text).join('')
          : typeof value === 'object' && 'hyperlink' in value ? value.text : value });
    }
  }
  return { sheets: workbook.worksheets.map(item => ({ name: item.name, rowCount: item.rowCount, columnCount: item.columnCount })),
    sheet: sheet.name, range: { startRow, endRow: Math.min(endRow, sheet.rowCount), startColumn, endColumn },
    headers: sheet.getRow(1).values, cells, ...(endRow < sheet.rowCount ? { nextStartRow: endRow + 1, truncated: true } : {}) };
}

async function readCsv(bytes: Buffer, input: Input, context: ToolExecutionContext): Promise<unknown> {
  const { parse } = await import('csv-parse/sync');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('CSV 不能包含二进制 NUL 字节。');
  const records = parse(text, { bom: true, skip_empty_lines: true, max_record_size: 256 * 1024 }) as string[][];
  if (records.length === 0) throw new Error('CSV 没有列名。');
  if (records.length > 100_001 || records[0]!.length > 1000) throw new Error('CSV 超过 100000 行或 1000 列解析预算。');
  const columns = records[0]!;
  const start = integer(input.startRow, 1, Math.max(1, records.length - 1), 'startRow');
  const maximum = integer(input.maxRows, 100, 200, 'maxRows');
  const search = optionalString(input.search, 'search');
  const statistics = columns.map((column, index) => ({ column, columnIndex: index + 1, numericCount: 0, sum: 0, min: Infinity, max: -Infinity }));
  const rows: unknown[] = []; let matchedRows = 0; let nextStartRow: number | undefined;
  for (let index = 1; index < records.length; index += 1) {
    if (index % 1000 === 0) { await setImmediate(); context.signal?.throwIfAborted(); }
    const values = records[index]!;
    for (let column = 0; column < values.length; column += 1) {
      const raw = values[column]!.trim(); const number = Number(raw);
      if (raw === '' || !Number.isFinite(number)) continue;
      const item = statistics[column]!; item.numericCount += 1; item.sum += number;
      if (!Number.isFinite(item.sum)) throw new Error('CSV 数字列累计值超出有限数字范围，不能报告伪造统计。');
      item.min = Math.min(item.min, number); item.max = Math.max(item.max, number);
    }
    if (index < start || search !== undefined && !values.some(value => value.includes(search))) continue;
    matchedRows += 1;
    if (rows.length < maximum) rows.push({ rowNumber: index, values });
    else nextStartRow ??= index;
  }
  return { columns, totalRows: records.length - 1, matchedRows, rows,
    statistics: statistics.map(item => ({ ...item, min: item.numericCount === 0 ? null : item.min, max: item.numericCount === 0 ? null : item.max,
      mean: item.numericCount === 0 ? null : item.sum / item.numericCount })), ...(nextStartRow === undefined ? {} : { nextStartRow, truncated: true }) };
}

async function readPdf(bytes: Buffer, input: Input, workspace: WorkspacePort, context: ToolExecutionContext): Promise<ToolResult> {
  // 官方 ESM 和字体/CMap/worker 均从正式 npm 依赖读取，不能依赖开发机 Office 或 Python。
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  context.signal?.throwIfAborted();
  const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, stopAtErrors: true,
    cMapUrl: join(root, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(root, 'standard_fonts') + '/',
    wasmUrl: join(root, 'wasm') + '/' });
  const abort = () => { void loading.destroy(); };
  context.signal?.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await loading.promise;
    context.signal?.throwIfAborted();
    const start = integer(input.startPage, 1, pdf.numPages, 'startPage');
    const end = input.endPage === undefined ? Math.min(start + 4, pdf.numPages) : integer(input.endPage, start, pdf.numPages, 'endPage');
    if (end < start || end - start >= 20) throw new Error('一次最多读取连续二十页。');
    const pages: Array<{ pageNumber: number; text: string }> = [];
    let characters = 0;
    for (let number = start; number <= end; number += 1) {
      context.signal?.throwIfAborted();
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      characters += text.length;
      if (characters > MAX_OUTPUT_CHARACTERS) throw new Error('PDF 文本超过 100000 字符输出预算，请缩小页范围。');
      pages.push({ pageNumber: number, text }); page.cleanup();
    }
    let rendered: { path: string; mimeType: string; sha256: string; size: number; pageNumber: number } | undefined;
    if (input.renderPage !== undefined) {
      const number = integer(input.renderPage, 1, pdf.numPages, 'renderPage');
      const outputPath = optionalString(input.outputPath, 'outputPath');
      if (outputPath === undefined) throw new Error('渲染 PDF 页需要已授权范围内的 outputPath。');
      const scoped = await resolveCreatablePath(workspace.confirmedDirectory(), outputPath, workspace.fileAccess === 'all');
      if (!scoped.ok) throw new Error(scoped.message);
      const approved = await workspace.requestApproval({ kind: 'create-file', path: scoped.path }, context.signal);
      context.signal?.throwIfAborted();
      if (!approved) return { status: 'error', failureKind: 'denied', message: '用户拒绝创建 PDF 页面图片。' };
      const page = await pdf.getPage(number);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, 2000 / Math.max(original.width, original.height)) });
      const { createCanvas } = await import('@napi-rs/canvas');
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const task = page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport });
      const cancelRender = () => task.cancel();
      context.signal?.addEventListener('abort', cancelRender, { once: true });
      try { await task.promise; } finally { context.signal?.removeEventListener('abort', cancelRender); }
      context.signal?.throwIfAborted();
      const image = await canvas.encode('png');
      const sha256 = createHash('sha256').update(image).digest('hex');
      context.checkpoint?.({ kind: 'document-render', path: scoped.path, expectedAfterSha256: sha256, expectedBytes: image.byteLength });
      const temporary = await mkdtemp(join(dirname(scoped.path), '.document-render-'));
      let committed = false;
      try {
        try {
          const staged = join(temporary, 'page.png');
          await writeFile(staged, image, { flag: 'wx' }); context.signal?.throwIfAborted();
          await link(staged, scoped.path); committed = true;
        } finally { await rm(temporary, { recursive: true, force: true }); }
      } catch (error) {
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        return { status: 'error', failureKind: committed ? 'unknown-outcome' : 'permanent', message: error.message };
      }
      rendered = { path: scoped.path, mimeType: 'image/png', sha256, size: image.byteLength, pageNumber: number };
      page.cleanup();
    }
    return { status: 'success', output: { pageCount: pdf.numPages, pages, ...(end < pdf.numPages ? { nextStartPage: end + 1, truncated: true } : {}),
      ...(rendered === undefined ? {} : { renderedPage: rendered }) },
    ...(rendered === undefined ? {} : { artifacts: [await createFileArtifact(rendered.path, 'render_pdf_page', context.signal)] }) };
  } finally {
    context.signal?.removeEventListener('abort', abort);
    await loading.destroy();
  }
}

const properties = {
  filePath: { type: 'string' }, startPage: { type: 'integer' }, endPage: { type: 'integer' }, pageNumber: { type: 'integer' }, outputPath: { type: 'string' },
  startBlock: { type: 'integer' }, maxBlocks: { type: 'integer' }, sheet: { type: 'string' }, range: { type: 'string' },
  startRow: { type: 'integer' }, maxRows: { type: 'integer' }, search: { type: 'string' },
};
const fields = { read_pdf: ['filePath', 'startPage', 'endPage'], render_pdf_page: ['filePath', 'pageNumber', 'outputPath'], read_docx: ['filePath', 'startBlock', 'maxBlocks'],
  read_xlsx: ['filePath', 'sheet', 'range', 'startRow', 'maxRows'], read_csv: ['filePath', 'startRow', 'maxRows', 'search'] };

/** Desktop 的正式文档能力；格式实现不会进入 Agent Core。 */
export class DocumentTool implements Tool {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly executionBoundary: 'read-only' | 'checkpointed';
  readonly contract;
  constructor(readonly name: DocumentToolName, private readonly workspace: WorkspacePort) {
    this.description = { read_pdf: '读取本地 PDF 页数及逐页文本，支持 startPage/endPage 范围；复杂页面可用 render_pdf_page 渲染图片供视觉观察。',
      render_pdf_page: '将本地 PDF 的 pageNumber 页经宿主审批渲染到 outputPath PNG；范围有界，不覆盖已有文件。',
      read_docx: '读取本地 DOCX 的段落、标题和表格；按内容块分页。', read_xlsx: '读取本地 XLSX 工作表、表头和单元格范围；公式只返回文件已有缓存结果，不运行公式。',
      read_csv: '读取本地 UTF-8 CSV 列名、行范围、字面搜索与数字列基本统计，保留带引号逗号和跨行字段。' }[name];
    this.inputSchema = { type: 'object', properties: Object.fromEntries(fields[name].map(key => [key, properties[key as keyof typeof properties]])),
      required: name === 'render_pdf_page' ? ['filePath', 'pageNumber', 'outputPath'] : ['filePath'], additionalProperties: false };
    this.executionBoundary = name === 'render_pdf_page' ? 'checkpointed' : 'read-only';
    this.contract = { capability: 'document', riskLevel: name === 'render_pdf_page' ? 'write' as const : 'read' as const,
      parallelSafety: name === 'render_pdf_page' ? 'serial' as const : 'safe' as const, timeoutMs: 120_000, workspaceScope: 'session' as const };
  }
  async execute(value: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      context.signal?.throwIfAborted();
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('文档工具需要对象参数。');
      const input = value as Input;
      if (Object.keys(input).some(key => !fields[this.name].includes(key))) throw new Error('文档工具收到未声明的参数。');
      const { filePath, bytes } = await documentBytes(input, this.workspace, context.signal);
      if (this.name === 'read_pdf' || this.name === 'render_pdf_page') {
        const pdfInput = this.name === 'read_pdf' ? input : { startPage: input.pageNumber, endPage: input.pageNumber, renderPage: input.pageNumber, outputPath: input.outputPath };
        if (this.name === 'render_pdf_page' && input.pageNumber === undefined) throw new Error('渲染需要 pageNumber。');
        const result = await readPdf(bytes, pdfInput, this.workspace, context);
        return result.status === 'error' ? result : { ...result, output: { filePath, ...(result.output as object) } };
      }
      const result = this.name === 'read_docx' ? await readDocx(bytes, input, context)
        : this.name === 'read_xlsx' ? await readXlsx(bytes, input, context) : await readCsv(bytes, input, context);
      context.signal?.throwIfAborted();
      if (JSON.stringify(result).length > MAX_OUTPUT_CHARACTERS) throw new Error('文档结果超过 100000 字符预算，请缩小范围。');
      return { status: 'success', output: { filePath, ...(result as object) } };
    } catch (error) {
      if (error instanceof SessionPersistenceError) throw error;
      context.signal?.throwIfAborted();
      if (!(error instanceof Error) || error.name === 'AbortError') throw error;
      return { status: 'error', failureKind: 'permanent', message: error.message };
    }
  }
}
