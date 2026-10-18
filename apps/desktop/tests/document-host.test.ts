import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import type { ToolExecutionContext } from '@agent-desktop/tools';
import type { ToolResult } from '@agent-desktop/model';
import { SessionPersistenceError } from '@agent-desktop/session';
import { DocumentTool, type DocumentToolName } from '../src/main/document-host.js';

let root: string;
const approvals: unknown[] = [];
const context: ToolExecutionContext = { toolCallId: 'document-test' as ToolExecutionContext['toolCallId'], reportProgress: () => {} };
function workspace(): WorkspacePort {
  return { confirmedDirectory: () => root, confirmDirectory: () => {}, requestApproval: async target => { approvals.push(target); return true; } };
}
function output(result: ToolResult): Record<string, unknown> {
  if (result.status !== 'success') throw new Error(result.message);
  return result.output as Record<string, unknown>;
}
function tool(name: DocumentToolName): DocumentTool { return new DocumentTool(name, workspace()); }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-documents-')));
  approvals.length = 0;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** 完整有效的双页 PDF：xref 偏移由真实字节计算，第二字体覆盖中文。 */
function pdfFixture(): Buffer {
  const stream = (value: string) => `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;
  const resources = '/Resources << /Font << /F1 7 0 R /F2 8 0 R >> >>';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ${resources} /Contents 4 0 R >>`,
    stream('BT /F1 18 Tf 20 150 Td (English page one) Tj 0 -30 Td /F2 18 Tf <4e2d658768079898> Tj ET'),
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ${resources} /Contents 6 0 R >>`,
    stream('BT /F1 18 Tf 20 150 Td (Second page) Tj 0 -30 Td (Name     Amount) Tj 0 -25 Td (Alice      42) Tj ET'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [9 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 10 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>',
  ];
  let result = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

describe('document capability', () => {
  it('reads actual multi-page English/Chinese PDF text and renders an approved PNG', async () => {
    await writeFile(join(root, '中文 report.pdf'), pdfFixture());
    const read = output(await tool('read_pdf').execute({ filePath: '中文 report.pdf' }, context));
    expect(read.pageCount).toBe(2);
    expect(read.pages).toEqual([expect.objectContaining({ pageNumber: 1, text: expect.stringContaining('English page one') }),
      expect.objectContaining({ pageNumber: 2, text: expect.stringContaining('Second page') })]);
    expect(JSON.stringify(read.pages)).toContain('中文标题');
    expect(approvals).toEqual([]);
    const checkpoints: unknown[] = [];
    const rendered = await tool('render_pdf_page').execute({ filePath: '中文 report.pdf', pageNumber: 1, outputPath: 'page.png' },
      { ...context, checkpoint: value => checkpoints.push(value) });
    const info = output(rendered).renderedPage as { path: string; size: number; sha256: string };
    expect(info.size).toBeGreaterThan(100); expect(info.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(info.path)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(rendered.status === 'success' && rendered.artifacts).toMatchObject([{ path: join(root, 'page.png'), mimeType: 'image/png' }]);
    expect(checkpoints).toHaveLength(1); expect(approvals).toEqual([{ kind: 'create-file', path: join(root, 'page.png') }]);
    const previous = await readFile(info.path);
    expect((await tool('render_pdf_page').execute({ filePath: '中文 report.pdf', pageNumber: 2, outputPath: 'page.png' }, context)).status).toBe('error');
    expect(await readFile(info.path)).toEqual(previous);
    expect((await readdir(root)).sort()).toEqual(['page.png', '中文 report.pdf'].sort());
  });

  it('parses actual OOXML headings, paragraphs and table cells without losing run order', async () => {
    const doc = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:pPr><w:pStyle w:val="CustomHeading"/></w:pPr><w:r><w:t>中文标题 English Heading</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t xml:space="preserve">中文段落 </w:t></w:r><w:r><w:t>English paragraph</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '</w:body></w:document>';
    const styles = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="CustomHeading"><w:name w:val="heading 2"/></w:style></w:styles>';
    await writeFile(join(root, '文档.docx'), zipSync({ 'word/document.xml': strToU8(doc), 'word/styles.xml': strToU8(styles),
      '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') }));
    const result = output(await tool('read_docx').execute({ filePath: '文档.docx' }, context));
    expect(result.blockCount).toBe(3);
    expect(result.blocks).toEqual([
      { index: 1, type: 'heading', level: 2, style: 'CustomHeading', text: '中文标题 English Heading' },
      { index: 2, type: 'paragraph', text: '中文段落 English paragraph' },
      { index: 3, type: 'table', rows: [['姓名', 'Amount'], ['Alice', '42']] },
    ]);
    const bounded = output(await tool('read_docx').execute({ filePath: '文档.docx', maxBlocks: 1 }, context));
    expect(bounded.nextStartBlock).toBe(2); expect((bounded.blocks as unknown[])).toHaveLength(1);
  });

  it('reads real XLSX cells, headers, sheets and cached formula results', async () => {
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('数据');
    sheet.addRow(['姓名', 'Amount', 'Formula']); sheet.addRow(['中文 Alice', 4, { formula: 'B2*2', result: 8 }]);
    sheet.addRow(['Bob', 7, { formula: 'B3*2' }]); workbook.addWorksheet('Other');
    await workbook.xlsx.writeFile(join(root, '数据.xlsx'));
    const result = output(await tool('read_xlsx').execute({ filePath: '数据.xlsx', sheet: '数据', range: 'A1:C3' }, context));
    expect(result.sheets).toEqual([expect.objectContaining({ name: '数据' }), expect.objectContaining({ name: 'Other' })]);
    expect(result.headers).toEqual([undefined, '姓名', 'Amount', 'Formula']);
    expect(result.cells).toContainEqual({ address: 'A2', value: '中文 Alice' });
    expect(result.cells).toContainEqual({ address: 'C2', formula: 'B2*2', cachedResultAvailable: true, result: 8 });
    expect(result.cells).toContainEqual({ address: 'C3', formula: 'B3*2', cachedResultAvailable: false });
    expect((await tool('read_xlsx').execute({ filePath: '数据.xlsx', range: 'A1:ZZ999' }, context)).status).toBe('error');
  });

  it('uses CSV quoting semantics for Chinese, commas, embedded newlines, range, search and statistics', async () => {
    await writeFile(join(root, '数据.csv'), '\uFEFFName,Amount,Note\r\n"中文,Alice",4,"line one\n第二行"\r\nBob,6,"quoted ""value"""\r\n');
    const result = output(await tool('read_csv').execute({ filePath: '数据.csv', maxRows: 1 }, context));
    expect(result.columns).toEqual(['Name', 'Amount', 'Note']); expect(result.totalRows).toBe(2);
    expect(result.rows).toEqual([{ rowNumber: 1, values: ['中文,Alice', '4', 'line one\n第二行'] }]);
    expect(result.nextStartRow).toBe(2);
    expect(result.statistics).toContainEqual({ column: 'Amount', columnIndex: 2, numericCount: 2, sum: 10, min: 4, max: 6, mean: 5 });
    const search = output(await tool('read_csv').execute({ filePath: '数据.csv', startRow: 2, search: 'Bob' }, context));
    expect(search.rows).toEqual([{ rowNumber: 2, values: ['Bob', '6', 'quoted "value"'] }]);
  });

  it('keeps parser errors, size and workspace boundaries explicit instead of returning empty success', async () => {
    for (const [name, fileName, bytes] of [
      ['read_pdf', 'bad.pdf', Buffer.from('not PDF')], ['read_docx', 'bad.docx', Buffer.from('not ZIP')],
      ['read_xlsx', 'bad.xlsx', Buffer.from('not ZIP')], ['read_csv', 'bad.csv', Buffer.from('Name,Value\n"unclosed,1')],
    ] as const) {
      await writeFile(join(root, fileName), bytes);
      expect((await tool(name).execute({ filePath: fileName }, context)).status).toBe('error');
    }
    await writeFile(join(root, 'too-large.csv'), Buffer.alloc(20 * 1024 * 1024 + 1));
    const large = await tool('read_csv').execute({ filePath: 'too-large.csv' }, context);
    expect(large.status === 'error' && large.message).toContain('20 MiB');
    expect((await tool('read_csv').execute({ filePath: '..' }, context)).status).toBe('error');
    expect(approvals).toEqual([]);
  });

  it('rejects malformed DOCX structure and compressed Office expansion beyond the actual budget', async () => {
    await writeFile(join(root, 'missing.docx'), zipSync({ 'word/document.xml': strToU8('<document><missing/></document>') }));
    expect((await tool('read_docx').execute({ filePath: 'missing.docx' }, context)).status).toBe('error');
    await writeFile(join(root, 'expanded.docx'), zipSync({ 'word/document.xml': new Uint8Array(8 * 1024 * 1024 + 1) }));
    const result = await tool('read_docx').execute({ filePath: 'expanded.docx' }, context);
    expect(result.status === 'error' && result.message).toContain('8 MiB');
  });

  it('cancels before reading and does not produce an output or approval', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(tool('read_csv').execute({ filePath: 'not-opened.csv' }, { ...context, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
    expect(approvals).toEqual([]); expect(await readdir(root)).toEqual([]);
  });

  it('preserves rendering refusal, cancellation and persistence failure without creating partial images', async () => {
    await writeFile(join(root, 'source.pdf'), pdfFixture());
    const input = { filePath: 'source.pdf', pageNumber: 1, outputPath: 'not-created.png' };
    const denied = new DocumentTool('render_pdf_page', { ...workspace(), requestApproval: async () => false });
    expect(await denied.execute(input, context)).toEqual(expect.objectContaining({ status: 'error', failureKind: 'denied' }));
    const controller = new AbortController();
    const cancelling = new DocumentTool('render_pdf_page', { ...workspace(), requestApproval: async () => { controller.abort(); return true; } });
    await expect(cancelling.execute(input, { ...context, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
    const failure = new SessionPersistenceError(new Error('unavailable storage'));
    await expect(tool('render_pdf_page').execute(input, { ...context, checkpoint: () => { throw failure; } })).rejects.toBe(failure);
    expect(await readdir(root)).toEqual(['source.pdf']);
  });
});
