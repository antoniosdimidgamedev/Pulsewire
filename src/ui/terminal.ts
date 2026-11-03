import type { Viewport } from "./render.ts";

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J\x1b[H";
const EXIT_SCREEN = "\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

export class TerminalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalUnavailableError";
  }
}

export interface TerminalHandlers {
  onInput(chunk: string): void;
  onResize(): void;
}

/**
 * Thin raw-mode terminal wrapper.
 *
 * Rendering is deliberately line based: every frame is a full-screen redraw
 * with the cursor hidden. That keeps scrolling and resize behavior predictable
 * on Linux and Windows terminals alike.
 */
export class Terminal {
  private readonly encoder = new TextEncoder();
  private active = false;
  private stopped = false;
  private stopSignal?: PromiseWithResolvers<void>;
  private resizeListener?: () => void;
  private resizeFallback?: ReturnType<typeof setInterval>;

  static isSupported(): boolean {
    try {
      return Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
    } catch {
      return false;
    }
  }

  size(): Viewport {
    try {
      const size = Deno.consoleSize();
      return { width: Math.max(1, size.columns), height: Math.max(1, size.rows) };
    } catch {
      return { width: 80, height: 24 };
    }
  }

  async run(handlers: TerminalHandlers): Promise<void> {
    if (!Terminal.isSupported()) {
      throw new TerminalUnavailableError(
        "Pulsewire needs an interactive terminal. Run it directly in your terminal, not through a pipe.",
      );
    }

    this.enter();
    const stop = Promise.withResolvers<void>();
    this.stopSignal = stop;

    try {
      handlers.onResize();
      this.resizeListener = () => handlers.onResize();
      if (Deno.build.os !== "windows") {
        try {
          Deno.addSignalListener("SIGWINCH", this.resizeListener);
        } catch {
          this.resizeListener = undefined;
        }
      }
      let last = this.size();
      this.resizeFallback = setInterval(() => {
        const current = this.size();
        if (current.width !== last.width || current.height !== last.height) {
          last = current;
          handlers.onResize();
        }
      }, 500);

      const reader = this.readLoop(handlers);
      await Promise.race([reader, stop.promise]);
    } finally {
      this.cleanup();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopSignal?.resolve();
    try {
      Deno.stdin.close();
    } catch {
      // Stdin may already be closed; cleanup still runs.
    }
  }

  draw(lines: string[]): void {
    if (!this.active) return;
    const { height } = this.size();
    let frame = "\x1b[H";
    for (let row = 0; row < height; row++) {
      frame += lines[row] ?? "";
      frame += "\x1b[0m\x1b[K";
      if (row < height - 1) frame += "\r\n";
    }
    frame += "\x1b[J";
    try {
      Deno.stdout.writeSync(this.encoder.encode(frame));
    } catch (error) {
      if (!this.stopped) throw error;
    }
  }

  private async readLoop(handlers: TerminalHandlers): Promise<void> {
    const buffer = new Uint8Array(4096);
    const decoder = new TextDecoder();
    while (!this.stopped) {
      let read: number | null;
      try {
        read = await Deno.stdin.read(buffer);
      } catch (error) {
        if (this.stopped || error instanceof Deno.errors.BadResource) return;
        throw error;
      }
      if (read === null) return;
      if (read === 0) continue;
      handlers.onInput(decoder.decode(buffer.subarray(0, read), { stream: true }));
    }
  }

  private enter(): void {
    this.active = true;
    this.stopped = false;
    try {
      Deno.stdin.setRaw(true);
    } catch (error) {
      throw new TerminalUnavailableError(
        `Pulsewire could not switch the terminal to raw mode: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    this.write(ENTER_SCREEN);
  }

  private cleanup(): void {
    if (this.resizeFallback !== undefined) clearInterval(this.resizeFallback);
    this.resizeFallback = undefined;
    if (this.resizeListener) {
      try {
        Deno.removeSignalListener("SIGWINCH", this.resizeListener);
      } catch {
        // Signal support differs on Windows; nothing to remove there.
      }
      this.resizeListener = undefined;
    }
    if (this.active) {
      this.write(EXIT_SCREEN);
      try {
        Deno.stdin.setRaw(false);
      } catch {
        // Restoring raw mode can fail if stdin is already gone.
      }
    }
    this.active = false;
  }

  private write(value: string): void {
    try {
      Deno.stdout.writeSync(this.encoder.encode(value));
    } catch {
      // A disconnected terminal cannot receive cleanup codes.
    }
  }

  /** Show the hardware cursor again without leaving the alternate screen. */
  showCursor(): void {
    this.write(SHOW_CURSOR);
  }
}
