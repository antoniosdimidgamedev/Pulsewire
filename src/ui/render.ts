import type { Conversation, Message, SearchResult, User, WorkspaceInfo } from "../chat/types.ts";
import { Theme } from "./theme.ts";
import {
  formatDayLabel,
  formatRelativeTime,
  formatTime,
  padRight,
  stripAnsi,
  truncateText,
  visibleWidth,
  windowInput,
  wrapText,
} from "./text.ts";

export interface Viewport {
  width: number;
  height: number;
}

export type FocusArea = "sidebar" | "messages" | "composer";
export type ToastTone = "info" | "success" | "error";

export interface Toast {
  text: string;
  tone: ToastTone;
}

export interface SearchState {
  query: string;
  cursor: number;
  results: SearchResult[];
  index: number;
  loading: boolean;
  error?: string;
}

export interface ThreadState {
  rootId: string;
  title: string;
  messages: Message[];
  index: number;
  offset: number;
  loading: boolean;
  error?: string;
}

export type Overlay =
  | { kind: "help"; offset: number }
  | { kind: "search"; state: SearchState }
  | { kind: "thread"; state: ThreadState }
  | { kind: "confirm-delete"; message: Message };

export interface UiState {
  phase: "loading" | "ready" | "error";
  providerLabel: string;
  demo: boolean;
  ai?: boolean;
  error?: string;
  errorHint?: string;
  workspace?: WorkspaceInfo;
  conversations: Conversation[];
  conversationIndex: number;
  messages: Message[];
  messageIndex: number;
  messageOffset: number;
  sidebarOffset: number;
  focus: FocusArea;
  composer: string;
  composerCursor: number;
  replyTo?: Message;
  editing?: Message;
  overlay?: Overlay;
  toast?: Toast;
  status?: string;
  spinner: number;
  clock: Date;
  loadingConversation: boolean;
  typing?: User;
}

export interface Layout {
  width: number;
  height: number;
  wide: boolean;
  headerHeight: number;
  statusHeight: number;
  composerHeight: number;
  bodyHeight: number;
  bodyTop: number;
  sidebarWidth: number;
  mainWidth: number;
  bodyContentHeight: number;
  mainContentWidth: number;
}

export interface TimelineLine {
  text: string;
  messageId?: string;
  kind: "day" | "message" | "spacer" | "notice";
}

export function computeLayout(viewport: Viewport): Layout {
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const headerHeight = height >= 3 ? 1 : 0;
  const statusHeight = height >= 5 ? 1 : 0;
  const composerHeight = height >= 10 ? 3 : 0;
  const bodyHeight = Math.max(1, height - headerHeight - statusHeight - composerHeight);
  const wide = width >= 74;
  const sidebarWidth = wide ? clamp(Math.floor(width * 0.3), 26, 38) : 0;
  const mainWidth = wide ? Math.max(1, width - sidebarWidth - 1) : width;
  return {
    width,
    height,
    wide,
    headerHeight,
    statusHeight,
    composerHeight,
    bodyHeight,
    bodyTop: headerHeight,
    sidebarWidth,
    mainWidth,
    bodyContentHeight: Math.max(1, bodyHeight - 2),
    mainContentWidth: Math.max(1, mainWidth - 4),
  };
}

export function threadViewportHeight(layout: Layout): number {
  return Math.max(1, layout.bodyContentHeight - 1);
}

export function selectedConversation(state: UiState): Conversation | undefined {
  return state.conversations[state.conversationIndex];
}

export function selectedMessage(state: UiState): Message | undefined {
  return state.messages[state.messageIndex];
}

export function buildTimeline(
  messages: Message[],
  width: number,
  theme: Theme,
  now: Date,
): TimelineLine[] {
  const lines: TimelineLine[] = [];
  let lastDay = "";
  let first = true;

  for (const message of messages) {
    const day = formatDayLabel(message.createdAt, now);
    if (day !== lastDay) {
      if (!first) lines.push({ text: "", kind: "spacer" });
      lines.push({ text: dayRule(day, width, theme), kind: "day" });
      lastDay = day;
    } else if (!first) {
      lines.push({ text: "", kind: "spacer" });
    }
    first = false;

    const reply = Boolean(message.replyToId);
    const prefix = reply ? `${theme.g.branch} ` : "";
    const prefixWidth = visibleWidth(prefix);
    const time = formatTime(message.createdAt);
    let meta = time;
    if (message.editedAt) meta += " · edited";
    if (message.deletedAt) meta += " · deleted";

    const own = message.author.id === "u-self";
    const rawName = own ? `${message.author.displayName} (you)` : message.author.displayName;
    const metaWidth = visibleWidth(meta);
    const nameBudget = Math.max(4, width - prefixWidth - metaWidth - 3);
    const name = truncateText(rawName, nameBudget);
    const header = theme.dim(prefix) + theme.author(message.author.id, name) +
      "  " + theme.dim(meta);
    lines.push({ text: header, messageId: message.id, kind: "message" });

    const bodyIndent = reply ? 4 : 2;
    const bodyWidth = Math.max(1, width - bodyIndent);
    if (message.deletedAt) {
      lines.push({
        text: " ".repeat(bodyIndent) + theme.dim("Message deleted"),
        messageId: message.id,
        kind: "message",
      });
    } else {
      const body = message.body.trim() ? message.body : "(empty message)";
      for (const row of wrapText(body, bodyWidth)) {
        lines.push({
          text: " ".repeat(bodyIndent) + theme.fg("text", row),
          messageId: message.id,
          kind: "message",
        });
      }
    }
  }

  return lines;
}

export function renderFrame(state: UiState, viewport: Viewport, theme: Theme): string[] {
  const layout = computeLayout(viewport);
  const lines: string[] = [];

  if (layout.headerHeight > 0) lines.push(headerLine(state, layout.width, theme));
  if (layout.bodyHeight > 0) {
    if (layout.wide) {
      const sidebar = renderSidebar(state, layout.sidebarWidth, layout.bodyHeight, theme);
      const main = renderMain(state, layout.mainWidth, layout.bodyHeight, theme);
      for (let index = 0; index < layout.bodyHeight; index++) {
        const left = sidebar[index] ?? " ".repeat(layout.sidebarWidth);
        const right = main[index] ?? " ".repeat(layout.mainWidth);
        lines.push(fitLine(`${left} ${right}`, layout.width));
      }
    } else {
      const pane = state.focus === "sidebar" && !state.overlay
        ? renderSidebar(state, layout.width, layout.bodyHeight, theme)
        : renderMain(state, layout.mainWidth, layout.bodyHeight, theme);
      for (const line of pane) lines.push(fitLine(line, layout.width));
    }
  }
  if (layout.composerHeight > 0) {
    lines.push(...renderComposer(state, layout.width, theme));
  }
  if (layout.statusHeight > 0) lines.push(statusLine(state, layout.width, theme));

  while (lines.length < layout.height) lines.push(" ".repeat(layout.width));
  return lines.slice(0, layout.height).map((line) =>
    fitLine(theme.ascii ? asciiSafe(line) : line, layout.width, theme.g.ellipsis)
  );
}

const ASCII_REPLACEMENTS: Record<string, string> = {
  "…": "...",
  "·": "-",
  "—": "-",
  "–": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "↑": "^",
  "↓": "v",
  "→": "->",
  "←": "<-",
  "✓": "x",
  "✕": "x",
  "↳": "->",
  "↩": "<-",
  "▌": ">",
  "●": "*",
  "◆": "*",
  "◫": "=",
};

/** Keep ASCII mode honest even when a literal string slips past the glyph table. */
function asciiSafe(value: string): string {
  let output = "";
  for (const char of value) {
    if (char.codePointAt(0)! < 0x80) {
      output += char;
      continue;
    }
    output += ASCII_REPLACEMENTS[char] ?? "?";
  }
  return output;
}

function headerLine(state: UiState, width: number, theme: Theme): string {
  const brand = theme.fg("brand", `${theme.g.brand} Pulsewire`);
  let left = brand;
  if (state.workspace) {
    left += theme.dim("  ·  ") + theme.fg("text", state.workspace.name);
  }

  const badge = state.demo
    ? theme.paint(state.ai ? " DEMO · AI " : " DEMO ", {
      fg: "#0f172a",
      bg: "#fbbf24",
      bold: true,
    })
    : theme.paint(` ${state.providerLabel.toUpperCase()} `, {
      fg: "#0f172a",
      bg: "#5eead4",
      bold: true,
    });

  const rightParts: string[] = [];
  if (state.workspace) rightParts.push(theme.muted(`@${state.workspace.currentUser.handle}`));
  rightParts.push(badge);
  rightParts.push(theme.dim(clockText(state.clock)));
  rightParts.push(theme.dim("? help"));
  let right = rightParts.join(theme.dim("  ·  "));

  if (visibleWidth(left) + visibleWidth(right) + 1 > width) {
    left = brand;
  }
  if (visibleWidth(left) + visibleWidth(right) + 1 > width) {
    right = theme.dim(clockText(state.clock));
  }
  if (visibleWidth(left) + visibleWidth(right) + 1 > width) {
    right = "";
  }
  return composeLine(left, right, width);
}

function statusLine(state: UiState, width: number, theme: Theme): string {
  let left: string;
  if (state.toast) {
    const tone = state.toast.tone === "error"
      ? "danger"
      : state.toast.tone === "success"
      ? "success"
      : "muted";
    left = theme.fg(tone, state.toast.text);
  } else if (state.typing) {
    left = theme.fg("accent", `${state.typing.displayName} is typing…`);
  } else if (state.status) {
    left = theme.muted(state.status);
  } else {
    left = theme.dim(defaultHint(state));
  }

  const right = theme.dim("? help · Ctrl+C quit");
  let output = composeLine(left, right, width);
  if (visibleWidth(output) > width) output = fitLine(left, width);
  return fitLine(output, width);
}

function defaultHint(state: UiState): string {
  if (state.phase === "loading") return "Connecting — press Ctrl+C to cancel";
  if (state.phase === "error") return "Press r to retry · q to quit";
  if (state.overlay) return "Esc closes this view";
  switch (state.focus) {
    case "sidebar":
      return "↑↓ browse · Enter open · Tab next · s search";
    case "messages":
      return "↑↓ scroll · Enter reply · r reply · t thread · e edit · d delete";
    case "composer":
      return "Enter send · Esc finish · Tab next";
  }
}

function renderSidebar(
  state: UiState,
  width: number,
  height: number,
  theme: Theme,
): string[] {
  const focused = state.focus === "sidebar" && !state.overlay;
  const content = Math.max(1, height - 2);
  const inner = Math.max(1, width - 4);
  const rows: string[] = [];

  const start = clamp(state.sidebarOffset, 0, Math.max(0, state.conversations.length - content));
  const visible = state.conversations.slice(start, start + content);
  for (let index = 0; index < visible.length; index++) {
    const conversation = visible[index];
    if (!conversation) continue;
    const selected = start + index === state.conversationIndex;
    rows.push(sidebarRow(conversation, inner, selected, theme, state.clock));
  }

  if (rows.length === 0) {
    rows.push(theme.dim(state.phase === "loading" ? "Connecting…" : "No conversations"));
  }

  const top = panelTop(
    theme,
    width,
    "Conversations",
    state.conversations.length > 0 ? `${state.conversations.length}` : undefined,
    focused,
  );
  const bottom = panelBottom(
    theme,
    width,
    state.conversations.length > 0 ? "Tab" : undefined,
    focused,
  );
  const body: string[] = [];
  for (let index = 0; index < content; index++) {
    body.push(panelRow(theme, width, rows[index] ?? "", focused));
  }
  return [top, ...body, bottom];
}

function sidebarRow(
  conversation: Conversation,
  width: number,
  selected: boolean,
  theme: Theme,
  now: Date,
): string {
  const glyphTone = conversation.kind === "dm"
    ? "accent2"
    : conversation.kind === "group"
    ? "accent"
    : "brand";
  const glyph = conversation.kind === "dm"
    ? theme.g.dm
    : conversation.kind === "group"
    ? theme.g.group
    : theme.g.space;
  const unread = conversation.unreadCount > 0;
  const dot = unread ? theme.fg("unread", theme.g.unread) : " ";
  const time = formatRelativeTime(conversation.lastActivityAt, now);
  const fixed = 4 + (time ? time.length + 1 : 0);
  const nameWidth = Math.max(3, width - fixed);
  const name = truncateText(conversation.name, nameWidth);
  const styledName = unread ? theme.bold(theme.fg("white", name)) : theme.fg("text", name);

  const left = `${dot} ${theme.fg(glyphTone, glyph)} ${styledName}`;
  const gap = Math.max(0, width - visibleWidth(left) - visibleWidth(time));
  const row = `${left}${" ".repeat(gap)}${theme.dim(time)}`;
  if (selected) return theme.selectedLine(row, width, "sidebar");
  return row;
}

function renderMain(
  state: UiState,
  width: number,
  height: number,
  theme: Theme,
): string[] {
  const content = Math.max(1, height - 2);
  const inner = Math.max(1, width - 4);
  const focused = (state.focus === "messages" || state.focus === "composer") && !state.overlay;

  let label = "Pulsewire";
  let topHint: string | undefined;
  let bottomHint: string | undefined;
  let rows: string[];

  if (state.overlay) {
    const overlay = renderOverlay(state, state.overlay, inner, content, theme);
    label = overlay.label;
    topHint = overlay.topHint;
    bottomHint = overlay.bottomHint;
    rows = overlay.rows;
  } else if (state.phase === "loading") {
    rows = loadingRows(state, inner, content, theme);
    bottomHint = "Ctrl+C quit";
  } else if (state.phase === "error") {
    rows = errorRows(state, inner, content, theme);
    label = "Could not start";
    bottomHint = "r retry · q quit";
  } else {
    const conversation = selectedConversation(state);
    if (!conversation) {
      rows = centered(inner, content, [
        theme.fg("muted", "No conversations yet"),
        "",
        theme.dim("Your account is not a member of any chats Pulsewire can read."),
      ]);
      label = "Pulsewire";
    } else {
      label = conversation.kind === "space" ? `# ${conversation.name}` : conversation.name;
      const topic = conversation.topic?.trim();
      if (topic && inner > 44) topHint = truncateText(topic, Math.min(36, Math.floor(inner / 3)));
      rows = conversationRows(state, conversation, inner, content, theme);
      bottomHint = conversationFooter(state, inner, content, theme);
    }
  }

  const top = panelTop(theme, width, label, topHint, focused);
  const bottom = panelBottom(theme, width, bottomHint, focused);
  const body: string[] = [];
  for (let index = 0; index < content; index++) {
    body.push(panelRow(theme, width, rows[index] ?? "", focused));
  }
  return [top, ...body, bottom];
}

function conversationRows(
  state: UiState,
  conversation: Conversation,
  width: number,
  content: number,
  theme: Theme,
): string[] {
  if (state.loadingConversation) {
    return centered(width, content, [
      `${spinner(state, theme)}  ${theme.dim("Loading messages…")}`,
    ]);
  }

  const timeline = buildTimeline(state.messages, width, theme, state.clock);
  if (timeline.length === 0) {
    const members = conversation.members
      .filter((member) => member.id !== state.workspace?.currentUser.id)
      .slice(0, 5)
      .map((member) => member.displayName);
    return centered(width, content, [
      theme.fg("muted", "No messages here yet."),
      "",
      theme.dim("Start the conversation."),
      "",
      members.length > 0
        ? theme.dim(`With ${members.join(", ")}${conversation.members.length > 6 ? ", …" : ""}`)
        : "",
      "",
      theme.fg("accent", "Press Enter to write"),
    ]);
  }

  const offset = clamp(state.messageOffset, 0, Math.max(0, timeline.length - content));
  const selectedId = selectedMessage(state)?.id;
  const highlight = state.focus === "messages";
  return timeline.slice(offset, offset + content).map((line) => {
    if (highlight && line.messageId && line.messageId === selectedId) {
      return theme.selectedLine(stripAnsi(line.text), width, "message");
    }
    return line.text;
  });
}

function conversationFooter(
  state: UiState,
  width: number,
  content: number,
  theme: Theme,
): string | undefined {
  const parts: string[] = [];
  const timelineLength = state.messages.length > 0
    ? buildTimeline(state.messages, width, theme, state.clock).length
    : 0;
  if (timelineLength > 0) parts.push(`${state.messages.length} messages`);
  if (state.messageOffset > 0) parts.push(theme.g.arrowUp);
  if (state.replyTo) parts.push("replying");
  if (state.editing) parts.push("editing");
  if (state.messageOffset + content < timelineLength) parts.push(theme.g.arrowDown);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function renderComposer(state: UiState, width: number, theme: Theme): string[] {
  const focused = state.focus === "composer";
  const conversation = selectedConversation(state);
  let label = "New message";
  if (state.editing) label = "Edit message";
  else if (state.replyTo) label = `Reply to ${state.replyTo.author.displayName}`;
  else if (conversation) {
    label = conversation.kind === "space"
      ? `Message # ${conversation.name}`
      : `Message ${conversation.name}`;
  }

  let hint = focused ? "Enter send · Esc cancel · Tab next" : "Enter to write";
  if (state.editing) hint = focused ? "Enter save · Esc cancel" : "Enter to edit";
  if (state.composer.length > 0) {
    hint = `${state.composer.length} chars · ${hint}`;
  }

  const top = panelTop(theme, width, label, hint, focused);
  const inner = Math.max(1, width - 4);
  const input = state.editing || state.replyTo || focused
    ? inputRow(state.composer, state.composerCursor, inner, focused, theme, placeholderFor(state))
    : theme.dim(truncateText(placeholderFor(state), inner));
  const bottom = panelBottom(theme, width, focused ? "Esc finish" : undefined, focused);
  return [top, panelRow(theme, width, input, focused), bottom];
}

function placeholderFor(state: UiState): string {
  if (state.editing) return "Update your message…";
  if (state.replyTo) return `Reply to ${state.replyTo.author.displayName}…`;
  return "Write a message…";
}

function inputRow(
  text: string,
  cursor: number,
  width: number,
  focused: boolean,
  theme: Theme,
  placeholder: string,
): string {
  const prompt = theme.fg("accent", "> ");
  const budget = Math.max(1, width - 2);
  const chars = Array.from(text);
  if (chars.length === 0 && !focused) {
    return prompt + theme.dim(truncateText(placeholder, budget));
  }
  if (chars.length === 0) {
    return prompt + cursorCell(theme, " ");
  }

  const window = windowInput(text, cursor, Math.max(1, budget - 1));
  const visible = Array.from(window.visible);
  const localCursor = clamp(window.cursor, 0, visible.length);
  const before = visible.slice(0, localCursor).join("");
  const at = visible[localCursor];
  const after = visible.slice(localCursor + (at ? 1 : 0)).join("");
  const cursorChar = cursorCell(theme, at ?? " ");
  const leftClip = window.clippedLeft ? theme.dim(theme.g.ellipsis) : "";
  return prompt + leftClip + before + (focused ? cursorChar : at ?? "") + after;
}

function cursorCell(theme: Theme, value: string): string {
  if (!theme.colorEnabled) return value === " " ? "_" : value;
  return theme.paint(value, { reverse: true });
}

interface OverlayRender {
  label: string;
  topHint?: string;
  bottomHint?: string;
  rows: string[];
}

function renderOverlay(
  state: UiState,
  overlay: Overlay,
  width: number,
  content: number,
  theme: Theme,
): OverlayRender {
  switch (overlay.kind) {
    case "help":
      return renderHelp(overlay.offset, width, content, theme);
    case "search":
      return renderSearch(overlay.state, width, content, theme, state.spinner, state.clock);
    case "thread":
      return renderThread(overlay.state, width, content, theme, state.spinner, state.clock);
    case "confirm-delete":
      return renderConfirmDelete(overlay.message, width, content, theme);
  }
}

function renderHelp(offset: number, width: number, content: number, theme: Theme): OverlayRender {
  const entries = helpEntries();
  const rows: string[] = [];
  const twoColumns = width >= 76;
  const half = twoColumns ? Math.ceil(entries.length / 2) : entries.length;
  const columns = twoColumns ? [entries.slice(0, half), entries.slice(half)] : [entries];
  const columnWidth = twoColumns ? Math.floor((width - 2) / 2) : width;

  for (let index = 0; index < half; index++) {
    const parts: string[] = [];
    for (const column of columns) {
      const entry = column[index];
      parts.push(entry ? helpLine(entry, columnWidth, theme) : " ".repeat(columnWidth));
    }
    rows.push(parts.join("  "));
  }

  const safeOffset = clamp(offset, 0, Math.max(0, rows.length - content));
  const visible = rows.slice(safeOffset, safeOffset + content);
  const more: string[] = [];
  if (safeOffset > 0) more.push("↑ more");
  if (safeOffset + content < rows.length) more.push("↓ more");
  return {
    label: "Help",
    topHint: theme.dim("Keyboard shortcuts"),
    bottomHint: ["Esc close", ...more].join(" · "),
    rows: fitRows(visible, content, width),
  };
}

type HelpEntry = { header: string } | { key: string; description: string };

export function helpRowCount(width: number): number {
  const entries = helpEntries();
  return width >= 76 ? Math.ceil(entries.length / 2) : entries.length;
}

function helpEntries(): HelpEntry[] {
  return [
    { header: "General" },
    { key: "Tab / Shift+Tab", description: "Move focus between panes" },
    { key: "? / F1", description: "Show or close this help" },
    { key: "Ctrl+C", description: "Quit Pulsewire" },
    { key: "q", description: "Quit when not writing" },
    { header: "Conversations" },
    { key: "↑ / ↓", description: "Browse conversations" },
    { key: "Enter", description: "Open conversation" },
    { key: "[ / ]", description: "Previous / next conversation" },
    { header: "Messages" },
    { key: "↑ / ↓", description: "Select messages" },
    { key: "PgUp / PgDn", description: "Scroll a page" },
    { key: "g / G", description: "Jump to top / bottom" },
    { key: "r", description: "Reply in a thread" },
    { key: "t", description: "Open the selected thread" },
    { key: "e", description: "Edit your message" },
    { key: "d", description: "Delete your message" },
    { key: "s / /", description: "Search the workspace" },
    { header: "Writing" },
    { key: "Enter", description: "Send or save" },
    { key: "Esc", description: "Cancel reply or edit" },
    { key: "Ctrl+W", description: "Delete previous word" },
    { key: "Ctrl+U", description: "Clear the line" },
    { header: "Search" },
    { key: "↑ / ↓", description: "Move between results" },
    { key: "Enter", description: "Open the selected result" },
    { key: "Esc", description: "Close search" },
  ];
}

function helpLine(entry: HelpEntry, width: number, theme: Theme): string {
  if ("header" in entry) {
    return theme.fg("accent", truncateText(entry.header.toUpperCase(), width));
  }
  const keyWidth = Math.min(16, Math.max(6, Math.floor(width * 0.36)));
  const key = padRight(truncateText(entry.key, keyWidth), keyWidth);
  const descriptionWidth = Math.max(1, width - keyWidth - 2);
  return `  ${theme.fg("brand", key)}${
    theme.muted(truncateText(entry.description, descriptionWidth))
  }`;
}

function renderSearch(
  search: SearchState,
  width: number,
  content: number,
  theme: Theme,
  spinner: number,
  now: Date,
): OverlayRender {
  const rows: string[] = [];
  rows.push(
    inputRow(search.query, search.cursor, width, true, theme, "Search messages, people, spaces…"),
  );
  rows.push("");

  const available = Math.max(0, content - 2);
  if (search.error) {
    rows.push(theme.fg("danger", wrapText(search.error, width)[0] ?? search.error));
    rows.push(theme.dim("Esc closes search."));
  } else if (!search.query.trim()) {
    rows.push(theme.dim("Type to search messages you have loaded from this workspace."));
    rows.push(theme.dim("Search covers message text, author names, and conversation names."));
  } else if (search.loading && search.results.length === 0) {
    rows.push(`${spinnerAt(theme, spinner)}  ${theme.dim("Searching…")}`);
  } else if (search.results.length === 0) {
    rows.push(theme.dim("No matches."));
    rows.push(theme.dim("Try a shorter phrase or a different spelling."));
  } else {
    const visibleCount = Math.max(1, Math.floor(available / 2));
    const maxOffset = Math.max(0, search.results.length - visibleCount);
    const offset = clamp(search.index - Math.floor(visibleCount / 2), 0, maxOffset);
    const visible = search.results.slice(offset, offset + visibleCount);
    for (let index = 0; index < visible.length; index++) {
      const result = visible[index];
      if (!result) continue;
      const selected = offset + index === search.index;
      const title = `${
        result.conversation.kind === "space" ? "# " : ""
      }${result.conversation.name}`;
      const header = `${theme.fg("accent", truncateText(title, Math.max(8, width / 2)))} ` +
        theme.dim("·") +
        ` ${theme.author(result.message.author.id, result.message.author.displayName)} ` +
        theme.dim(`· ${formatRelativeTime(result.message.createdAt, now)}`);
      const snippet = theme.muted(truncateText(result.snippet, width));
      if (selected) {
        rows.push(theme.selectedLine(stripAnsi(header), width, "message"));
        rows.push(theme.selectedLine(stripAnsi(snippet), width, "message"));
      } else {
        rows.push(header);
        rows.push(snippet);
      }
    }
  }

  const footer = search.loading
    ? "Searching…"
    : `${search.results.length} result${
      search.results.length === 1 ? "" : "s"
    } · Enter jump · ↑↓ results · Esc close`;
  return {
    label: "Search",
    topHint: theme.dim("Messages, people, conversations"),
    bottomHint: footer,
    rows: fitRows(rows, content, width),
  };
}

function renderThread(
  thread: ThreadState,
  width: number,
  content: number,
  theme: Theme,
  spinner: number,
  now: Date,
): OverlayRender {
  const rows: string[] = [];
  const title = theme.fg("muted", truncateText(thread.title, width));
  rows.push(title);

  if (thread.loading) {
    rows.push("");
    rows.push(`${spinnerAt(theme, spinner)}  ${theme.dim("Loading thread…")}`);
  } else if (thread.error) {
    rows.push("");
    for (const line of wrapText(thread.error, width)) {
      rows.push(theme.fg("danger", line));
    }
  } else {
    const visibleHeight = Math.max(1, content - 1);
    const timeline = buildTimeline(thread.messages, width, theme, now);
    const offset = clamp(thread.offset, 0, Math.max(0, timeline.length - visibleHeight));
    const selectedId = thread.messages[thread.index]?.id;
    for (const line of timeline.slice(offset, offset + visibleHeight)) {
      if (line.messageId && line.messageId === selectedId) {
        rows.push(theme.selectedLine(stripAnsi(line.text), width, "message"));
      } else {
        rows.push(line.text);
      }
    }
  }

  return {
    label: "Thread",
    topHint: `${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"}`,
    bottomHint: "↑↓ scroll · r reply · Esc close",
    rows: fitRows(rows, content, width),
  };
}

function renderConfirmDelete(
  message: Message,
  width: number,
  content: number,
  theme: Theme,
): OverlayRender {
  const body = message.body.trim() ? message.body : "(empty message)";
  const quoted = wrapText(body, Math.max(8, Math.min(width - 6, 64))).slice(0, 4);
  const rows = [
    theme.fg("danger", theme.bold("Delete this message?")),
    "",
    ...quoted.map((line) => theme.dim(`“${line}”`)),
    "",
    theme.muted("This cannot be undone."),
    "",
    theme.fg("success", "y") + theme.dim(" delete") + theme.dim("   ·   ") +
    theme.fg("accent", "n") + theme.dim(" cancel"),
  ];
  return {
    label: "Delete message",
    topHint: message.author.displayName,
    bottomHint: "y confirm · n cancel · Esc close",
    rows: centered(width, content, rows),
  };
}

function loadingRows(state: UiState, width: number, content: number, theme: Theme): string[] {
  const target = state.demo
    ? "Connecting to the local demo workspace"
    : `Connecting to ${state.providerLabel}`;
  return centered(width, content, [
    "",
    `${spinner(state, theme)}  ${theme.fg("brand", theme.bold("PULSEWIRE"))}`,
    "",
    theme.muted(target),
    state.demo
      ? theme.dim("Entirely local · no network · no credentials")
      : theme.dim("Reading spaces and recent messages…"),
    "",
    ...(state.demo ? [theme.dim("Press Ctrl+C to quit.")] : [theme.dim("Press Ctrl+C to quit.")]),
  ]);
}

function errorRows(state: UiState, width: number, content: number, theme: Theme): string[] {
  const rows: string[] = [
    theme.fg("danger", theme.bold("Pulsewire could not start.")),
    "",
  ];
  for (const line of wrapText(state.error ?? "An unexpected error occurred.", width)) {
    rows.push(theme.fg("text", line));
  }
  if (state.errorHint) {
    rows.push("");
    for (const line of wrapText(state.errorHint, width)) rows.push(theme.dim(line));
  }
  rows.push("");
  rows.push(theme.dim("r retry · q quit"));
  return centered(width, content, rows);
}

function spinner(state: UiState, theme: Theme): string {
  return spinnerAt(theme, state.spinner);
}

function spinnerAt(theme: Theme, spinner: number): string {
  const frames = theme.g.spinner;
  return theme.fg("accent", frames[spinner % frames.length] ?? frames[0] ?? "*");
}

function panelTop(
  theme: Theme,
  width: number,
  label: string,
  hint: string | undefined,
  focused: boolean,
): string {
  const clipped = clipBoxText(width, label, hint);
  return theme.boxLine(Math.max(0, width - 2), {
    label: clipped.label,
    hint: clipped.hint,
    focused,
  });
}

function panelBottom(
  theme: Theme,
  width: number,
  hint: string | undefined,
  focused: boolean,
): string {
  const clipped = clipBoxText(width, "", hint);
  return theme.bottomLine(Math.max(0, width - 2), {
    ...(clipped.hint ? { hint: clipped.hint } : {}),
    focused,
  });
}

function clipBoxText(
  width: number,
  label: string,
  hint: string | undefined,
): { label?: string; hint?: string } {
  const budget = Math.max(0, width - 5);
  let labelText = label;
  let hintText = hint ?? "";
  if (visibleWidth(labelText) + visibleWidth(hintText) > budget) {
    hintText = truncateText(hintText, Math.max(0, budget - visibleWidth(labelText) - 1));
  }
  if (visibleWidth(labelText) + visibleWidth(hintText) > budget) {
    labelText = truncateText(labelText, Math.max(0, budget - visibleWidth(hintText)));
  }
  return {
    ...(labelText ? { label: labelText } : {}),
    ...(hintText ? { hint: hintText } : {}),
  };
}

function panelRow(theme: Theme, width: number, content: string, focused: boolean): string {
  const inner = Math.max(0, width - 4);
  const border = theme.fg(focused ? "borderFocus" : "border", theme.g.vertical);
  const value = fitLine(content, inner);
  return `${border} ${value} ${border}`;
}

function composeLine(left: string, right: string, width: number): string {
  const used = visibleWidth(left) + visibleWidth(right);
  const fill = Math.max(0, width - used);
  return fitLine(`${left}${" ".repeat(fill)}${right}`, width);
}

function dayRule(label: string, width: number, theme: Theme): string {
  const text = ` ${label} `;
  const remaining = Math.max(0, width - visibleWidth(text) - 2);
  return theme.dim(`${theme.g.horizontal.repeat(2)}${text}${theme.g.horizontal.repeat(remaining)}`);
}

function centered(width: number, height: number, rows: string[]): string[] {
  const top = Math.max(0, Math.floor((height - rows.length) / 2));
  const output: string[] = [];
  for (let index = 0; index < top; index++) output.push("");
  for (const row of rows) {
    const plain = stripAnsi(row);
    const pad = Math.max(0, Math.floor((width - visibleWidth(plain)) / 2));
    output.push(`${" ".repeat(pad)}${row}`);
  }
  return fitRows(output, height, width);
}

function fitRows(rows: string[], height: number, width: number): string[] {
  const output = rows.slice(0, height).map((row) => fitLine(row, width));
  while (output.length < height) output.push("");
  return output;
}

function fitLine(value: string, width: number, ellipsis = "…"): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  if (visibleWidth(value) > safeWidth) {
    return truncateText(stripAnsi(value), safeWidth, ellipsis);
  }
  return padRight(value, safeWidth);
}

function clockText(now: Date): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
