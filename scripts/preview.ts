/**
 * Render a static preview of the Pulsewire interface without opening a terminal.
 *
 * Usage:
 *   deno task preview            # color preview at 100x30 and 60x20
 *   deno task preview --ascii    # ASCII-only preview
 *   deno task preview --plain    # no color
 */
import { join } from "node:path";
import { DemoProvider } from "../src/chat/demo-provider.ts";
import { computeLayout, renderFrame, type UiState } from "../src/ui/render.ts";
import { resolveColorMode, Theme } from "../src/ui/theme.ts";

const args = new Set(Deno.args);
const ascii = args.has("--ascii");
const plain = args.has("--plain");
const theme = new Theme(
  plain ? "none" : resolveColorMode("auto", Deno.env.toObject()),
  ascii,
);

const dir = await Deno.makeTempDir({ prefix: "pulsewire-preview-" });
try {
  const provider = new DemoProvider({
    dataPath: join(dir, "demo.json"),
    displayName: "Alex Rivera",
    simulateActivity: false,
    connectDelayMs: 0,
  });
  try {
    const workspace = await provider.connect();
    const conversations = await provider.listConversations();
    const first = conversations[0];
    const messages = first ? await provider.getMessages(first.id) : [];
    const now = new Date();

    const state: UiState = {
      phase: "ready",
      providerLabel: workspace.providerLabel,
      demo: workspace.demo,
      workspace,
      conversations,
      conversationIndex: 0,
      messages,
      messageIndex: messages.length - 1,
      messageOffset: 0,
      sidebarOffset: 0,
      focus: "messages",
      composer: "",
      composerCursor: 0,
      spinner: 0,
      clock: now,
      loadingConversation: false,
    };

    for (const viewport of [{ width: 100, height: 30 }, { width: 60, height: 20 }]) {
      const layout = computeLayout(viewport);
      console.log(
        `\nPulsewire preview ${viewport.width}x${viewport.height} ` +
          `(${layout.wide ? "wide" : "narrow"} layout)\n`,
      );
      console.log(renderFrame(state, viewport, theme).join("\n"));
    }
  } finally {
    await provider.dispose();
  }
} finally {
  await Deno.remove(dir, { recursive: true }).catch(() => undefined);
}
