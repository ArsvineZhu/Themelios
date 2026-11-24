import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { ArtifactRef, Selection } from "@themelios/core";

export interface TextBlock {
  kind:
    | "heading"
    | "paragraph"
    | "list"
    | "code"
    | "quote"
    | "table"
    | "thematic-break";
  depth?: number;
  selection: Selection;
  text: string;
}

type BlockKind = TextBlock["kind"];
interface CachedBlock {
  kind: BlockKind;
  start: number;
  end: number;
  text: string;
  depth?: number;
}

const blockKinds: Readonly<Record<string, BlockKind>> = {
  heading: "heading",
  paragraph: "paragraph",
  list: "list",
  code: "code",
  blockquote: "quote",
  table: "table",
  thematicBreak: "thematic-break",
};
const parser = unified().use(remarkParse).use(remarkGfm);

function bytePositions(text: string): Uint32Array | Float64Array {
  const offsets =
    text.length < 0x40000000
      ? new Uint32Array(text.length + 1)
      : new Float64Array(text.length + 1);
  let index = 0;
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    index += char.length;
    offsets[index] = bytes;
  }
  return offsets;
}

type MakeBlock = (
  kind: BlockKind,
  start: number,
  end: number,
  depth?: number,
) => CachedBlock;

function computeBlocks(text: string, markdown: boolean): CachedBlock[] {
  const byteOffsets = bytePositions(text);
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  const source = text.slice(bom);
  const block: MakeBlock = (kind, start, end, depth) => ({
    kind,
    start: byteOffsets[start + bom]!,
    end: byteOffsets[end + bom]!,
    text: source.slice(start, end),
    ...(depth === undefined ? {} : { depth }),
  });
  return markdown
    ? markdownBlocks(source, block)
    : paragraphBlocks(source, block);
}

export function structureText(
  ref: ArtifactRef,
  text: string,
  markdown: boolean,
): TextBlock[] {
  return computeBlocks(text, markdown).map(
    ({ kind, start, end, text: snippet, depth }) => ({
      kind,
      selection: {
        ref,
        range: { kind: "text", start, end },
      },
      text: snippet,
      ...(depth === undefined ? {} : { depth }),
    }),
  );
}

function markdownBlocks(source: string, block: MakeBlock): CachedBlock[] {
  const blocks: CachedBlock[] = [];
  for (const node of parser.parse(source).children) {
    const kind = blockKinds[node.type];
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (kind && start !== undefined && end !== undefined) {
      blocks.push(
        block(
          kind,
          start,
          end,
          node.type === "heading" ? node.depth : undefined,
        ),
      );
    }
  }
  return blocks;
}

function paragraphBlocks(source: string, block: MakeBlock): CachedBlock[] {
  const blocks: CachedBlock[] = [];
  let start: number | undefined;
  let end = 0;
  for (const line of source.matchAll(/([^\r\n]*)(?:\r\n|\n|\r|$)/g)) {
    const content = line[1]!;
    if (content.trim()) {
      start ??= line.index;
      end = line.index + content.length;
    } else if (start !== undefined) {
      blocks.push(block("paragraph", start, end));
      start = undefined;
    }
  }
  if (start !== undefined) blocks.push(block("paragraph", start, end));
  return blocks;
}
