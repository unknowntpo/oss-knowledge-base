/**
 * The subset of Markdown that docs/feature-map.md, docs/gardening.md and the specs' first lines use
 * (Spec 020): headings, pipe tables, lists, fenced code, quotes, paragraphs; inline code, bold and
 * links. Anything else is kept as text. No dependency, so the generator runs before `bun install`.
 */

export interface Table {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface ListItem {
  readonly depth: number;
  readonly ordered: boolean;
  readonly text: string;
}

export type Block =
  | { readonly type: "paragraph"; readonly text: string }
  | ({ readonly type: "table" } & Table)
  | { readonly type: "code"; readonly lang: string; readonly text: string }
  | { readonly type: "list"; readonly items: readonly ListItem[] }
  | { readonly type: "quote"; readonly text: string };

/** A heading and the blocks up to the next heading. Text before the first heading is level 0 with an empty title. */
export interface Section {
  readonly level: number;
  readonly title: string;
  /** The anchor GitHub gives the heading, so a link can point at the source. */
  readonly anchor: string;
  readonly blocks: readonly Block[];
}

/** Cells of one table row: split on `|`, except `\|`, which is a literal pipe. */
export function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/u, "").replace(/(?<!\\)\|$/u, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === "\\" && body[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

const isSeparatorRow = (line: string) => line.includes("-") && splitRow(line).every((cell) => /^:?-+:?$/u.test(cell));
const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/u;
const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u;

function anchorOf(title: string, used: Map<string, number>): string {
  const base = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/gu, "-");
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

export function parseMarkdown(markdown: string): Section[] {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const sections: Section[] = [];
  const anchors = new Map<string, number>();
  let current = { level: 0, title: "", anchor: "", blocks: [] as Block[] };
  let paragraph: string[] = [];
  let quote: string[] = [];
  let items: { depth: number; ordered: boolean; text: string }[] = [];

  const flush = () => {
    if (paragraph.length > 0) current.blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    if (quote.length > 0) current.blocks.push({ type: "quote", text: quote.join(" ") });
    if (items.length > 0) current.blocks.push({ type: "list", items });
    paragraph = [];
    quote = [];
    items = [];
  };
  const close = () => {
    flush();
    if (current.level > 0 || current.blocks.length > 0) sections.push(current);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenced = fence.exec(line);
    if (fenced !== null) {
      flush();
      const body: string[] = [];
      const indent = line.length - line.trimStart().length;
      for (index += 1; index < lines.length && !lines[index]!.trim().startsWith(fenced[1]!); index += 1) {
        body.push(lines[index]!.slice(Math.min(indent, lines[index]!.length - lines[index]!.trimStart().length)));
      }
      current.blocks.push({ type: "code", lang: fenced[2]!, text: body.join("\n") });
      continue;
    }
    const headed = heading.exec(line);
    if (headed !== null) {
      close();
      const title = headed[2]!;
      current = { level: headed[1]!.length, title, anchor: anchorOf(title, anchors), blocks: [] };
      continue;
    }
    if (line.trim() === "") {
      // A blank line ends a paragraph or a quote; a list goes on if the next line continues it.
      const next = lines[index + 1] ?? "";
      if (items.length === 0 || !listItem.test(next) && !/^\s+\S/u.test(next)) flush();
      continue;
    }
    if (/^\s*<!--.*-->\s*$/u.test(line)) continue;
    if (line.trimStart().startsWith("|") && isSeparatorRow(lines[index + 1] ?? "")) {
      flush();
      const headers = splitRow(line);
      const rows: string[][] = [];
      for (index += 2; index < lines.length && lines[index]!.trimStart().startsWith("|"); index += 1) {
        const cells = splitRow(lines[index]!).slice(0, headers.length);
        while (cells.length < headers.length) cells.push("");
        rows.push(cells);
      }
      index -= 1;
      current.blocks.push({ type: "table", headers, rows });
      continue;
    }
    const item = listItem.exec(line);
    if (item !== null && paragraph.length === 0) {
      if (quote.length > 0) flush();
      items.push({ depth: Math.floor(item[1]!.length / 2), ordered: /\d/u.test(item[2]!), text: item[3]!.trim() });
      continue;
    }
    if (items.length > 0 && /^\s/u.test(line)) {
      const last = items[items.length - 1]!;
      last.text = `${last.text} ${line.trim()}`;
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      if (paragraph.length > 0 || items.length > 0) flush();
      const text = line.trimStart().replace(/^>\s?/u, "").trim();
      if (text !== "") quote.push(text);
      continue;
    }
    if (items.length > 0 || quote.length > 0) flush();
    paragraph.push(line.trim());
  }
  close();
  return sections;
}

export const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const inlineToken = /`([^`]+)`|\[((?:[^\]`]|`[^`]*`)+)\]\(([^)\s]+)\)|\*\*((?:[^*`]|`[^`]*`)+)\*\*|(https?:\/\/[^\s<>()[\]`]+)/gu;

/**
 * Inline Markdown as HTML. `resolve` turns a link target into the address to use, or null to drop
 * the link and keep its text (a scheme the page must not link to).
 */
export function renderInline(text: string, resolve: (url: string) => string | null): string {
  let html = "";
  let position = 0;
  const link = (url: string, label: string) => {
    const target = resolve(url);
    return target === null ? label : `<a href="${escapeHtml(target)}">${label}</a>`;
  };
  for (const match of text.matchAll(inlineToken)) {
    html += escapeHtml(text.slice(position, match.index));
    position = match.index + match[0].length;
    if (match[1] !== undefined) html += `<code>${escapeHtml(match[1])}</code>`;
    else if (match[2] !== undefined) html += link(match[3]!, renderInline(match[2], () => null));
    else if (match[4] !== undefined) html += `<strong>${renderInline(match[4], resolve)}</strong>`;
    else {
      const url = match[5]!.replace(/[.,;:!?'"]+$/u, "");
      html += link(url, escapeHtml(url));
      position -= match[5]!.length - url.length;
    }
  }
  return html + escapeHtml(text.slice(position));
}

/** The text a reader sees, without the Markdown marks: for teasers and counts. */
export function plainText(text: string): string {
  return text.replace(/\[((?:[^\]`]|`[^`]*`)+)\]\([^)\s]+\)/gu, "$1").replace(/\*\*|`/gu, "");
}
