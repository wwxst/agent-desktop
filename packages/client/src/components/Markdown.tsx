import type { ReactNode } from 'react';

/**
 * Agent 正文的 Markdown 渲染。
 *
 * 这里只实现视频 Agent 实际会输出的最小子集：段落、无序/有序列表、围栏代码块、
 * 行内代码、加粗和链接。工程基线要求保持最小依赖，`pnpm-lock.yaml` 又是安装契约，
 * 因此不引入第三方 Markdown 解析器；这一份实现覆盖当前真实输出，并且可以被单元测试固定。
 * 未支持的形式（标题、表格、引用、图片）保持原文展示，不猜测语义，也不生成额外结构。
 */

type MarkdownBlock =
  | { readonly kind: 'paragraph'; readonly lines: readonly string[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: 'code'; readonly code: string };

/** 围栏代码块的开始与结束标记；不解析语言标注，避免引入当前没有消费者的语法高亮。 */
const FENCE = /^\s*```/;

/** 列表项：`-`、`*`、`+` 为无序，`1.` 为有序；标记后必须有空格，避免把 `**加粗**` 当成列表。 */
const LIST_ITEM = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/;

/** 行内代码、链接和加粗；只匹配不跨行的最短形式，未闭合时保持原文。 */
const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^()\s]+)\)|\*\*([^*\n]+)\*\*/g;

/** 链接来自模型输出，只有明确的 web 协议才交给宿主打开，其余保持原文。 */
const EXTERNAL_HREF = /^(?:https?:\/\/|mailto:)/i;

/** 把正文切成块级结构：代码块优先于列表，空行结束当前段落。 */
function parseBlocks(text: string): readonly MarkdownBlock[] {
  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paragraph });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list !== null) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (FENCE.test(line)) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index += 1;
      // 围栏没有闭合时按到结尾处理：模型正在流式输出时不能丢掉已经到达的内容。
      while (index < lines.length && !FENCE.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      blocks.push({ kind: 'code', code: code.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      flushParagraph();
      const ordered = item[2] !== undefined;
      // 有序和无序混排时分开成两个列表，保持模型原本的分组。
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item[3]!);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** 渲染一行里的行内语法；未命中的片段原样输出。 */
function renderInline(text: string, keyPrefix: string): readonly ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;

  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [, code, linkText, href, bold] = match;
    const key = `${keyPrefix}-${matchIndex}`;
    matchIndex += 1;

    if (code !== undefined) {
      nodes.push(<code key={key} className="inline-code">{code}</code>);
    } else if (linkText !== undefined && href !== undefined && EXTERNAL_HREF.test(href)) {
      // 链接由宿主决定如何打开（桌面端交给系统浏览器），客户端只提供可识别的锚点。
      nodes.push(<a key={key} href={href} target="_blank" rel="noreferrer">{linkText}</a>);
    } else if (bold !== undefined) {
      nodes.push(<strong key={key}>{bold}</strong>);
    } else {
      nodes.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

interface MarkdownProps {
  readonly text: string;
}

/** 渲染 Agent 正文；段落内的换行沿用真实文本换行，不合并成空格。 */
export function Markdown({ text }: MarkdownProps) {
  return (
    <>
      {parseBlocks(text).map((block, index) => {
        if (block.kind === 'code') {
          return (
            <pre key={index} className="markdown-code">
              <code>{block.code}</code>
            </pre>
          );
        }

        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={index} className="markdown-list">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item, `${index}-${itemIndex}`)}</li>
              ))}
            </List>
          );
        }

        return (
          <p key={index} className="agent-response">
            {renderInline(block.lines.join('\n'), String(index))}
          </p>
        );
      })}
    </>
  );
}
