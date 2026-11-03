import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { type Key, KeyParser } from "../src/ui/keys.ts";

function collect(parser: KeyParser, chunks: string[]): Key[] {
  const keys: Key[] = [];
  for (const chunk of chunks) keys.push(...parser.push(chunk));
  return keys;
}

Deno.test("plain text, enter, tab, and control keys are parsed", () => {
  const parser = new KeyParser();
  const keys = collect(parser, ["hi", "\r", "\t", "\x03", "\x7f"]);
  deepStrictEqual(keys, [
    { type: "text", text: "h" },
    { type: "text", text: "i" },
    { type: "enter" },
    { type: "tab", shift: false },
    { type: "ctrl", key: "c" },
    { type: "backspace" },
  ]);
});

Deno.test("escape sequences split across reads are reassembled", () => {
  const parser = new KeyParser();
  deepStrictEqual(parser.push("\x1b"), []);
  deepStrictEqual(parser.push("[A"), [{ type: "arrow", direction: "up" }]);
  deepStrictEqual(parser.push("\x1b[Z"), [{ type: "tab", shift: true }]);
  deepStrictEqual(parser.push("\x1b[5~"), [{ type: "pageup" }]);
  deepStrictEqual(parser.push("\x1b[6~"), [{ type: "pagedown" }]);
  deepStrictEqual(parser.push("\x1bOP"), [{ type: "f", number: 1 }]);
});

Deno.test("modified and application cursor keys navigate", () => {
  const parser = new KeyParser();
  deepStrictEqual(parser.push("\x1b[1;2B"), [{ type: "arrow", direction: "down" }]);
  deepStrictEqual(parser.push("\x1bOB"), [{ type: "arrow", direction: "down" }]);
  deepStrictEqual(parser.push("\x1b[H"), [{ type: "home" }]);
  deepStrictEqual(parser.push("\x1b[4~"), [{ type: "end" }]);
  deepStrictEqual(parser.push("\x1b[3~"), [{ type: "delete" }]);
});

Deno.test("a lone escape can be flushed without waiting forever", () => {
  const parser = new KeyParser();
  strictEqual(parser.hasPendingEscape(), false);
  parser.push("\x1b");
  strictEqual(parser.hasPendingEscape(), true);
  deepStrictEqual(parser.flushPendingEscape(), [{ type: "escape" }]);
  strictEqual(parser.hasPendingEscape(), false);
  deepStrictEqual(parser.flushPendingEscape(), []);
});

Deno.test("alt keys are distinguished from escape and control bytes", () => {
  const parser = new KeyParser();
  deepStrictEqual(parser.push("\x1bb"), [{ type: "alt", key: "b" }]);
  deepStrictEqual(parser.push("\x1b\x03"), [
    { type: "escape" },
    { type: "ctrl", key: "c" },
  ]);
});

Deno.test("bracketed paste is delivered as one key and split chunks are supported", () => {
  const parser = new KeyParser();
  deepStrictEqual(parser.push("\x1b[200~hello"), []);
  deepStrictEqual(parser.push(" world\x1b[201~"), [
    { type: "paste", text: "hello world" },
  ]);
  deepStrictEqual(parser.push("plain"), [
    { type: "text", text: "p" },
    { type: "text", text: "l" },
    { type: "text", text: "a" },
    { type: "text", text: "i" },
    { type: "text", text: "n" },
  ]);
});

Deno.test("unicode input is emitted as complete code points", () => {
  const parser = new KeyParser();
  deepStrictEqual(parser.push("界🙂"), [
    { type: "text", text: "界" },
    { type: "text", text: "🙂" },
  ]);
});

Deno.test("unknown CSI sequences are ignored rather than typed", () => {
  const parser = new KeyParser();
  deepStrictEqual(parser.push("\x1b[999~"), [{ type: "unknown", raw: "\x1b[999~" }]);
  deepStrictEqual(parser.push("\x1b[<0;10;5M"), [{ type: "unknown", raw: "\x1b[<0;10;5M" }]);
});
