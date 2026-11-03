import { padRight, stripAnsi, truncateText, visibleWidth } from "./text.ts";

export type ColorMode = "auto" | "truecolor" | "ansi256" | "none";

export type Tone =
  | "text"
  | "muted"
  | "dim"
  | "accent"
  | "accent2"
  | "brand"
  | "danger"
  | "warning"
  | "success"
  | "own"
  | "border"
  | "borderFocus"
  | "white"
  | "unread"
  | "author0"
  | "author1"
  | "author2"
  | "author3"
  | "author4"
  | "author5";

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
}

export interface Glyphs {
  brand: string;
  dm: string;
  group: string;
  space: string;
  selected: string;
  unread: string;
  branch: string;
  reply: string;
  edit: string;
  bullet: string;
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  ellipsis: string;
  spinner: string[];
  check: string;
  cross: string;
  arrowUp: string;
  arrowDown: string;
  search: string;
  thread: string;
  pin: string;
  deliveryPending: string;
  deliverySent: string;
  deliveryDelivered: string;
  deliveryRead: string;
  deliveryFailed: string;
}

const UNICODE_GLYPHS: Glyphs = {
  brand: "◆",
  dm: "@",
  group: "◫",
  space: "#",
  selected: "▌",
  unread: "●",
  branch: "↳",
  reply: "↩",
  edit: "✎",
  bullet: "·",
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  ellipsis: "…",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  check: "✓",
  cross: "✕",
  arrowUp: "↑",
  arrowDown: "↓",
  search: "⌕",
  thread: "≡",
  pin: "●",
  deliveryPending: "◌",
  deliverySent: "✓",
  deliveryDelivered: "✓✓",
  deliveryRead: "✓✓",
  deliveryFailed: "✕",
};

const ASCII_GLYPHS: Glyphs = {
  brand: "*",
  dm: "@",
  group: "=",
  space: "#",
  selected: ">",
  unread: "*",
  branch: "->",
  reply: "<-",
  edit: "~",
  bullet: "-",
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  ellipsis: "...",
  spinner: ["|", "/", "-", "\\"],
  check: "x",
  cross: "x",
  arrowUp: "^",
  arrowDown: "v",
  search: "?",
  thread: "=",
  pin: "*",
  deliveryPending: "...",
  deliverySent: "v",
  deliveryDelivered: "vv",
  deliveryRead: "vv",
  deliveryFailed: "x",
};

const COLORS: Record<Tone, string> = {
  text: "#e2e8f0",
  muted: "#94a3b8",
  dim: "#64748b",
  accent: "#5eead4",
  accent2: "#c4b5fd",
  brand: "#99f6e4",
  danger: "#fb7185",
  warning: "#fbbf24",
  success: "#86efac",
  own: "#7dd3fc",
  border: "#334155",
  borderFocus: "#2dd4bf",
  white: "#f8fafc",
  unread: "#fbbf24",
  author0: "#f0abfc",
  author1: "#fcd34d",
  author2: "#a7f3d0",
  author3: "#fdba74",
  author4: "#93c5fd",
  author5: "#d8b4fe",
};

const SELECTED_BG = "#134e4a";
const MESSAGE_SELECTED_BG = "#1e293b";

export class Theme {
  readonly g: Glyphs;

  constructor(readonly colorMode: ColorMode, readonly ascii: boolean) {
    this.g = ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
  }

  get colorEnabled(): boolean {
    return this.colorMode !== "none";
  }

  fg(tone: Tone, text: string): string {
    return this.paint(text, { fg: COLORS[tone] });
  }

  bold(text: string): string {
    return this.paint(text, { bold: true });
  }

  dim(text: string): string {
    return this.paint(text, { fg: COLORS.dim });
  }

  muted(text: string): string {
    return this.paint(text, { fg: COLORS.muted });
  }

  paint(text: string, style: Style): string {
    if (!this.colorEnabled) return text;
    const codes: string[] = [];
    if (style.bold) codes.push("1");
    if (style.dim) codes.push("2");
    if (style.italic) codes.push("3");
    if (style.underline) codes.push("4");
    if (style.reverse) codes.push("7");
    if (style.fg) codes.push(this.colorCode(style.fg, false));
    if (style.bg) codes.push(this.colorCode(style.bg, true));
    if (codes.length === 0) return text;
    return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
  }

  author(authorId: string, text: string): string {
    return this.fg(authorTone(authorId), text);
  }

  selectedLine(text: string, width: number, kind: "sidebar" | "message" = "sidebar"): string {
    const plain = padRight(stripAnsi(text), width);
    if (!this.colorEnabled) return plain;
    const background = kind === "sidebar" ? SELECTED_BG : MESSAGE_SELECTED_BG;
    return this.paint(plain, { fg: "#f0fdfa", bg: background, bold: true });
  }

  truncate(value: string, width: number): string {
    return truncateText(value, width, this.g.ellipsis);
  }

  boxLine(
    innerWidth: number,
    options: { label?: string; tone?: Tone; focused?: boolean; hint?: string } = {},
  ): string {
    const tone = options.tone ?? (options.focused ? "borderFocus" : "border");
    const label = options.label ? ` ${options.label} ` : "";
    const hint = options.hint ? ` ${options.hint} ` : "";
    const fixed = 2 + textWidthSafe(label) + textWidthSafe(hint);
    const fill = Math.max(0, innerWidth - fixed);
    return this.fg(tone, `${this.g.topLeft}${this.g.horizontal}${label}`) +
      this.fg(tone, this.g.horizontal.repeat(fill)) +
      this.fg(tone, `${hint}${this.g.topRight}`);
  }

  bottomLine(innerWidth: number, options: { hint?: string; focused?: boolean } = {}): string {
    const tone = options.focused ? "borderFocus" : "border";
    const hint = options.hint ? ` ${options.hint} ` : "";
    const fill = Math.max(0, innerWidth - textWidthSafe(hint));
    return this.fg(
      tone,
      `${this.g.bottomLeft}${this.g.horizontal.repeat(fill)}${hint}${this.g.bottomRight}`,
    );
  }

  colorCode(color: string, background: boolean): string {
    const rgb = parseHex(color);
    if (this.colorMode === "ansi256") {
      const code = rgbToAnsi256(rgb);
      return `${background ? 48 : 38};5;${code}`;
    }
    return `${background ? 48 : 38};2;${rgb.r};${rgb.g};${rgb.b}`;
  }
}

export function authorTone(authorId: string): Tone {
  const tones: Tone[] = ["author0", "author1", "author2", "author3", "author4", "author5"];
  let hash = 0;
  for (const char of authorId) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return tones[hash % tones.length] ?? "author0";
}

export function resolveColorMode(
  configured: ColorMode,
  env: Record<string, string | undefined>,
): ColorMode {
  if (configured !== "auto") return configured;
  if (env.NO_COLOR !== undefined) return "none";
  if (env.TERM === "dumb") return "none";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  if (Deno.build.os === "windows") return "truecolor";
  return "ansi256";
}

function textWidthSafe(value: string): number {
  return visibleWidth(value);
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(
    normalized.length === 3 ? normalized.split("").map((char) => char + char).join("") : normalized,
    16,
  );
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function rgbToAnsi256(rgb: { r: number; g: number; b: number }): number {
  if (rgb.r === rgb.g && rgb.g === rgb.b) {
    if (rgb.r < 8) return 16;
    if (rgb.r > 248) return 231;
    return Math.round(((rgb.r - 8) / 247) * 24) + 232;
  }
  const toCube = (value: number) => Math.round((value / 255) * 5);
  return 16 + (36 * toCube(rgb.r)) + (6 * toCube(rgb.g)) + toCube(rgb.b);
}
