import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  buildTimeline,
  computeLayout,
  helpRowCount,
  renderFrame,
  threadViewportHeight,
  type UiState,
} from "../src/ui/render.ts";
import { Theme } from "../src/ui/theme.ts";
import { stripAnsi, visibleWidth } from "../src/ui/text.ts";
import { FIXED_NOW, sampleUiState } from "./fixtures.ts";

const plain = new Theme("none", false);
const fancy = new Theme("truecolor", false);
const ascii = new Theme("none", true);

Deno.test("layout adapts to wide and narrow terminals", () => {
  const wide = computeLayout({ width: 100, height: 30 });
  strictEqual(wide.wide, true);
  strictEqual(wide.sidebarWidth >= 26 && wide.sidebarWidth <= 38, true);
  strictEqual(wide.mainWidth + wide.sidebarWidth + 1, 100);
  strictEqual(wide.headerHeight, 1);
  strictEqual(wide.statusHeight, 1);
  strictEqual(wide.composerHeight, 3);
  strictEqual(wide.bodyHeight, 25);

  const narrow = computeLayout({ width: 60, height: 20 });
  strictEqual(narrow.wide, false);
  strictEqual(narrow.sidebarWidth, 0);
  strictEqual(narrow.mainWidth, 60);

  const tiny = computeLayout({ width: 30, height: 4 });
  strictEqual(tiny.headerHeight, 1);
  strictEqual(tiny.statusHeight, 0);
  strictEqual(tiny.composerHeight, 0);
  strictEqual(tiny.bodyHeight, 3);
});

Deno.test("thread viewport leaves room for the thread title", () => {
  const layout = computeLayout({ width: 80, height: 24 });
  strictEqual(threadViewportHeight(layout), layout.bodyContentHeight - 1);
});

Deno.test("renderFrame always fills exactly the viewport", () => {
  const state = sampleUiState();
  for (
    const viewport of [
      { width: 80, height: 24 },
      { width: 100, height: 30 },
      { width: 60, height: 20 },
      { width: 40, height: 10 },
    ]
  ) {
    const lines = renderFrame(state, viewport, plain);
    strictEqual(lines.length, viewport.height);
    for (const line of lines) {
      strictEqual(
        visibleWidth(line) <= viewport.width,
        true,
        `line too wide: ${JSON.stringify(stripAnsi(line))}`,
      );
    }
  }
});

Deno.test("wide frame shows the conversation list, messages, composer, and demo badge", () => {
  const state = sampleUiState();
  const frame = renderFrame(state, { width: 100, height: 30 }, plain).join("\n");
  strictEqual(frame.includes("Pulsewire"), true);
  strictEqual(frame.includes("Juniper Studio"), true);
  strictEqual(frame.includes("DEMO"), true);
  strictEqual(frame.includes("Conversations"), true);
  strictEqual(frame.includes("Message"), true);
});

Deno.test("narrow frame shows one pane and can switch to the sidebar", () => {
  const state = sampleUiState();
  const main = renderFrame(state, { width: 60, height: 20 }, plain).join("\n");
  strictEqual(main.includes("Conversations"), false);

  const sidebarState: UiState = { ...state, focus: "sidebar" };
  const sidebar = renderFrame(sidebarState, { width: 60, height: 20 }, plain).join("\n");
  strictEqual(sidebar.includes("Conversations"), true);
});

Deno.test("help overlay renders shortcuts and closes with a footer hint", () => {
  const state = sampleUiState();
  state.overlay = { kind: "help", offset: 0 };
  const frame = renderFrame(state, { width: 100, height: 30 }, plain).join("\n");
  strictEqual(frame.includes("Help"), true);
  strictEqual(frame.includes("Keyboard shortcuts"), true);
  strictEqual(frame.includes("Ctrl+C"), true);
  strictEqual(frame.includes("Esc close"), true);
  strictEqual(helpRowCount(100) < helpRowCount(60), true);
});

Deno.test("search overlay shows query, result, and selected result", () => {
  const state = sampleUiState();
  const result = state.messages[0];
  if (!result) throw new Error("fixture has no messages");
  state.overlay = {
    kind: "search",
    state: {
      query: "composer",
      cursor: 8,
      results: [{
        message: result,
        conversation: state.conversations[0]!,
        snippet: "The composer border is the part I am least sure about.",
      }],
      index: 0,
      loading: false,
    },
  };
  const frame = renderFrame(state, { width: 100, height: 30 }, fancy).join("\n");
  strictEqual(frame.includes("Search"), true);
  strictEqual(frame.includes("composer"), true);
  strictEqual(frame.includes("The composer border"), true);
});

Deno.test("delete confirmation names the action and both choices", () => {
  const state = sampleUiState();
  const message = state.messages[0];
  if (!message) throw new Error("fixture has no messages");
  state.overlay = { kind: "confirm-delete", message };
  const frame = renderFrame(state, { width: 100, height: 30 }, plain).join("\n");
  strictEqual(frame.includes("Delete this message?"), true);
  strictEqual(frame.includes("cannot be undone"), true);
  strictEqual(frame.includes("confirm"), true);
  strictEqual(frame.includes("cancel"), true);
});

Deno.test("loading and error states stay inside the frame", () => {
  const base = sampleUiState();
  const loading: UiState = {
    ...base,
    phase: "loading",
    conversations: [],
    messages: [],
  };
  const loadingFrame = renderFrame(loading, { width: 80, height: 24 }, plain).join("\n");
  strictEqual(loadingFrame.includes("PULSEWIRE"), true);
  strictEqual(loadingFrame.includes("demo workspace"), true);

  const error: UiState = {
    ...base,
    phase: "error",
    error: "Google Chat needs credentials.",
    errorHint: "Run `pulsewire auth google`.",
  };
  const errorFrame = renderFrame(error, { width: 80, height: 24 }, plain).join("\n");
  strictEqual(errorFrame.includes("could not start"), true);
  strictEqual(errorFrame.includes("Google Chat needs credentials"), true);
  strictEqual(errorFrame.includes("r retry"), true);
});

Deno.test("timeline groups messages by day and marks replies", () => {
  const messages = sampleUiState().messages;
  const now = FIXED_NOW;
  const timeline = buildTimeline(messages, 60, plain, now);
  strictEqual(timeline.some((line) => line.kind === "day"), true);
  strictEqual(timeline.some((line) => line.kind === "message"), true);
  const headers = timeline.filter((line) => line.kind === "message");
  strictEqual(headers.length > 0, true);
  for (const line of timeline) {
    strictEqual(visibleWidth(line.text) <= 60, true);
  }
});

Deno.test("ASCII mode uses only ASCII glyphs in the frame", () => {
  const state = sampleUiState();
  const frame = renderFrame(state, { width: 80, height: 24 }, ascii).join("\n");
  strictEqual(/[^\x00-\x7f]/.test(stripAnsi(frame)), false);
  strictEqual(frame.includes("+"), true);
  strictEqual(frame.includes("|"), true);
});

Deno.test("color mode emits ANSI and strips back to the same visible text", () => {
  const state = sampleUiState();
  const colored = renderFrame(state, { width: 100, height: 30 }, fancy);
  strictEqual(colored.some((line) => line.includes("\x1b[")), true);
  const quiet = renderFrame(state, { width: 100, height: 30 }, plain);
  deepStrictEqual(colored.map(stripAnsi), quiet.map(stripAnsi));
});
