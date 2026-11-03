const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function charWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (/\p{Mark}/u.test(char)) return 0;
  if (codePoint === 0x200d || codePoint === 0xfe0f) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function textWidth(value: string): number {
  let width = 0;
  for (const char of value) width += charWidth(char);
  return width;
}

export function visibleWidth(value: string): number {
  return textWidth(stripAnsi(value));
}

export function truncateText(value: string, width: number, ellipsis = "…"): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  if (textWidth(value) <= safeWidth) return value;
  const ellipsisWidth = textWidth(ellipsis);
  const budget = Math.max(0, safeWidth - ellipsisWidth);
  const chars: string[] = [];
  let used = 0;
  for (const char of value) {
    const charLength = charWidth(char);
    if (used + charLength > budget) break;
    chars.push(char);
    used += charLength;
  }
  if (ellipsisWidth > safeWidth) return ".".repeat(safeWidth);
  return `${chars.join("")}${ellipsis}`;
}

export function padRight(value: string, width: number): string {
  const missing = width - visibleWidth(value);
  return missing > 0 ? `${value}${" ".repeat(missing)}` : value;
}

export function padLeft(value: string, width: number): string {
  const missing = width - visibleWidth(value);
  return missing > 0 ? `${" ".repeat(missing)}${value}` : value;
}

export function wrapText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const output: string[] = [];
  const paragraphs = value.replace(/\r\n?/g, "\n").split("\n");

  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      output.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const word of words) {
      const wordLength = textWidth(word);
      if (wordLength <= safeWidth) {
        if (line.length === 0) {
          line = word;
          lineWidth = wordLength;
        } else if (lineWidth + 1 + wordLength <= safeWidth) {
          line += ` ${word}`;
          lineWidth += 1 + wordLength;
        } else {
          output.push(line);
          line = word;
          lineWidth = wordLength;
        }
        continue;
      }

      if (line.length > 0) {
        output.push(line);
        line = "";
        lineWidth = 0;
      }
      let chunk = "";
      let chunkWidth = 0;
      for (const char of word) {
        const charLength = charWidth(char);
        if (chunkWidth + charLength > safeWidth && chunk.length > 0) {
          output.push(chunk);
          chunk = "";
          chunkWidth = 0;
        }
        chunk += char;
        chunkWidth += charLength;
      }
      if (chunk.length > 0) {
        line = chunk;
        lineWidth = chunkWidth;
      }
    }
    if (line.length > 0) output.push(line);
  }

  return output.length > 0 ? output : [""];
}

/** Wrap a message body after an indent of `prefixWidth` columns. */
export function wrapWithIndent(value: string, width: number, indent: number): string[] {
  const bodyWidth = Math.max(1, width - indent);
  return wrapText(value, bodyWidth);
}

export interface InputWindow {
  visible: string;
  cursor: number;
  clippedLeft: boolean;
  clippedRight: boolean;
}

/**
 * Keep the insertion point visible in a single-line, horizontally clipped input.
 * Cursor is measured in code points.
 */
export function windowInput(text: string, cursor: number, width: number): InputWindow {
  const safeWidth = Math.max(1, Math.floor(width));
  const chars = Array.from(text);
  const safeCursor = Math.max(0, Math.min(cursor, chars.length));
  const totalWidth = textWidth(text);
  if (totalWidth <= safeWidth) {
    return { visible: text, cursor: safeCursor, clippedLeft: false, clippedRight: false };
  }

  let start = safeCursor;
  let used = 0;
  while (start > 0) {
    const previous = chars[start - 1];
    if (!previous) break;
    const charLength = charWidth(previous);
    if (used + charLength > safeWidth - 1) break;
    used += charLength;
    start--;
  }

  let end = start;
  let endWidth = 0;
  while (end < chars.length) {
    const char = chars[end];
    if (!char) break;
    const charLength = charWidth(char);
    if (endWidth + charLength > safeWidth) break;
    endWidth += charLength;
    end++;
  }

  const visible = chars.slice(start, end).join("");
  return {
    visible,
    cursor: safeCursor - start,
    clippedLeft: start > 0,
    clippedRight: end < chars.length,
  };
}

export function formatTime(iso: string, _now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${
    String(date.getMinutes()).padStart(2, "0")
  }`;
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Math.max(0, now.getTime() - date.getTime());
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = MONTHS_SHORT[date.getMonth()] ?? "";
  return sameYear
    ? `${month} ${date.getDate()}`
    : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const difference = dayDifference(date, now);
  if (difference === 0) return "Today";
  if (difference === 1) return "Yesterday";
  const month = MONTHS_SHORT[date.getMonth()] ?? "";
  if (date.getFullYear() === now.getFullYear()) {
    return `${WEEKDAYS[date.getDay()] ?? ""}, ${month} ${date.getDate()}`;
  }
  return `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${formatDayLabel(iso)} at ${formatTime(iso)}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return `${(parts[0] ?? "").charAt(0)}${(parts[parts.length - 1] ?? "").charAt(0)}`.toUpperCase();
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayDifference(date: Date, now: Date): number {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}
