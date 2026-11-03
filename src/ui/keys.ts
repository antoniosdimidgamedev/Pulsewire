/** Terminal key parsing, including bracketed paste and split escape sequences. */

export type Key =
  | { type: "text"; text: string }
  | { type: "enter" }
  | { type: "escape" }
  | { type: "tab"; shift: boolean }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "insert" }
  | { type: "arrow"; direction: "up" | "down" | "left" | "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "ctrl"; key: string }
  | { type: "alt"; key: string }
  | { type: "f"; number: number }
  | { type: "paste"; text: string }
  | { type: "unknown"; raw: string };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Stateful parser. Reads can split escape sequences or paste bodies, so callers
 * should feed every chunk into the same instance.
 */
export class KeyParser {
  private buffer = "";
  private inPaste = false;
  private paste = "";

  push(chunk: string): Key[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const keys: Key[] = [];
    this.drain(keys);
    return keys;
  }

  /** Resolve a lone Escape without waiting for a longer sequence. */
  flushPendingEscape(): Key[] {
    if (this.inPaste || this.buffer !== "\x1b") return [];
    this.buffer = "";
    return [{ type: "escape" }];
  }

  hasPendingEscape(): boolean {
    return !this.inPaste && this.buffer === "\x1b";
  }

  private drain(keys: Key[]): void {
    while (this.buffer.length > 0) {
      if (this.inPaste) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end < 0) {
          this.paste += this.buffer;
          this.buffer = "";
          return;
        }
        this.paste += this.buffer.slice(0, end);
        keys.push({ type: "paste", text: this.paste });
        this.paste = "";
        this.inPaste = false;
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        continue;
      }

      const start = this.buffer.indexOf(PASTE_START);
      if (start === 0) {
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.inPaste = true;
        continue;
      }
      if (start > 0) {
        // A complete paste marker appears later; consume everything before it.
        const before = this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start);
        const consumed = parsePlain(before, keys);
        if (consumed < before.length) {
          this.buffer = before.slice(consumed) + this.buffer;
          return;
        }
        continue;
      }

      const keep = trailingPrefixLength(this.buffer, PASTE_START);
      if (keep === this.buffer.length) return;
      const process = this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      const consumed = parsePlain(process, keys);
      if (consumed < process.length) {
        this.buffer = process.slice(consumed) + this.buffer;
        return;
      }
      if (keep === 0) return;
    }
  }
}

function parsePlain(text: string, keys: Key[]): number {
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;

    if (char === "\x1b") {
      const match = matchEscape(text.slice(index));
      if (!match) return index;
      if (match.key) keys.push(match.key);
      index += match.length;
      continue;
    }

    if (char === "\r") {
      if (text[index + 1] === "\n") index++;
      keys.push({ type: "enter" });
      index++;
      continue;
    }
    if (char === "\n") {
      keys.push({ type: "enter" });
      index++;
      continue;
    }
    if (char === "\t") {
      keys.push({ type: "tab", shift: false });
      index++;
      continue;
    }
    if (char === "\x7f" || char === "\b") {
      keys.push({ type: "backspace" });
      index++;
      continue;
    }

    const code = char.charCodeAt(0);
    if (code === 0) {
      index++;
      continue;
    }
    if (code > 0 && code < 32) {
      keys.push({ type: "ctrl", key: String.fromCharCode(code + 96) });
      index++;
      continue;
    }

    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    keys.push({ type: "text", text: value });
    index += value.length;
  }
  return index;
}

interface EscapeMatch {
  length: number;
  key?: Key;
}

function matchEscape(rest: string): EscapeMatch | null {
  if (rest.length < 2) return null;

  if (rest[1] === "[") {
    let end = 2;
    while (end < rest.length) {
      const code = rest.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) break;
      end++;
    }
    if (end >= rest.length) return null;
    const sequence = rest.slice(0, end + 1);
    return { length: sequence.length, key: mapCsi(sequence) };
  }

  if (rest[1] === "O") {
    if (rest.length < 3) return null;
    const code = rest[2];
    const length = 3;
    switch (code) {
      case "A":
        return { length, key: { type: "arrow", direction: "up" } };
      case "B":
        return { length, key: { type: "arrow", direction: "down" } };
      case "C":
        return { length, key: { type: "arrow", direction: "right" } };
      case "D":
        return { length, key: { type: "arrow", direction: "left" } };
      case "H":
        return { length, key: { type: "home" } };
      case "F":
        return { length, key: { type: "end" } };
      case "P":
        return { length, key: { type: "f", number: 1 } };
      case "Q":
        return { length, key: { type: "f", number: 2 } };
      case "R":
        return { length, key: { type: "f", number: 3 } };
      case "S":
        return { length, key: { type: "f", number: 4 } };
      default:
        return { length, key: { type: "unknown", raw: rest.slice(0, length) } };
    }
  }

  // A bare Escape followed by another control byte is just Escape, not Alt.
  const next = rest.codePointAt(1);
  if (next === undefined) return null;
  if (next < 32 || next === 0x7f) {
    return { length: 1, key: { type: "escape" } };
  }
  const char = String.fromCodePoint(next);
  return { length: 1 + char.length, key: { type: "alt", key: char } };
}

function mapCsi(sequence: string): Key {
  if (sequence === "\x1b[Z") return { type: "tab", shift: true };

  const simple: Record<string, Key> = {
    "\x1b[A": { type: "arrow", direction: "up" },
    "\x1b[B": { type: "arrow", direction: "down" },
    "\x1b[C": { type: "arrow", direction: "right" },
    "\x1b[D": { type: "arrow", direction: "left" },
    "\x1b[H": { type: "home" },
    "\x1b[F": { type: "end" },
  };
  const direct = simple[sequence];
  if (direct) return direct;

  const tilde = /^\x1b\[(\d+)(?:;(\d+))?~$/.exec(sequence);
  if (tilde) {
    const number = Number(tilde[1]);
    switch (number) {
      case 1:
      case 7:
        return { type: "home" };
      case 2:
        return { type: "insert" };
      case 3:
        return { type: "delete" };
      case 4:
      case 8:
        return { type: "end" };
      case 5:
        return { type: "pageup" };
      case 6:
        return { type: "pagedown" };
      case 11:
        return { type: "f", number: 1 };
      case 12:
        return { type: "f", number: 2 };
      case 13:
        return { type: "f", number: 3 };
      case 14:
        return { type: "f", number: 4 };
      case 15:
        return { type: "f", number: 5 };
      case 17:
        return { type: "f", number: 6 };
      case 18:
        return { type: "f", number: 7 };
      case 19:
        return { type: "f", number: 8 };
      case 20:
        return { type: "f", number: 9 };
      case 21:
        return { type: "f", number: 10 };
      case 23:
        return { type: "f", number: 11 };
      case 24:
        return { type: "f", number: 12 };
      default:
        return { type: "unknown", raw: sequence };
    }
  }

  // Modified cursor keys (for example Shift+Up) still navigate the same way.
  const modified = /^\x1b\[1;(\d+)([ABCDHF])$/.exec(sequence);
  if (modified) {
    const code = modified[2];
    switch (code) {
      case "A":
        return { type: "arrow", direction: "up" };
      case "B":
        return { type: "arrow", direction: "down" };
      case "C":
        return { type: "arrow", direction: "right" };
      case "D":
        return { type: "arrow", direction: "left" };
      case "H":
        return { type: "home" };
      case "F":
        return { type: "end" };
    }
  }

  // Ignore mouse reports rather than typing their payload into the composer.
  if (sequence.startsWith("\x1b[<")) {
    return { type: "unknown", raw: sequence };
  }

  return { type: "unknown", raw: sequence };
}

function trailingPrefixLength(value: string, marker: string): number {
  const longest = Math.min(value.length, marker.length - 1);
  for (let length = longest; length > 0; length--) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}
