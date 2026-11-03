import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  charWidth,
  formatDayLabel,
  formatRelativeTime,
  formatTime,
  initials,
  padLeft,
  padRight,
  plural,
  stripAnsi,
  textWidth,
  truncateText,
  visibleWidth,
  windowInput,
  wrapText,
} from "../src/ui/text.ts";

Deno.test("stripAnsi removes color sequences but keeps visible text", () => {
  strictEqual(stripAnsi("\x1b[31mred\x1b[0m and \x1b[1;38;5;42mgreen\x1b[0m"), "red and green");
  strictEqual(visibleWidth("\x1b[31mred\x1b[0m"), 3);
});

Deno.test("charWidth treats CJK and emoji as wide and combining marks as zero", () => {
  strictEqual(charWidth("a"), 1);
  strictEqual(charWidth("界"), 2);
  strictEqual(charWidth("🙂"), 2);
  strictEqual(charWidth("\u0301"), 0);
  strictEqual(charWidth("\x1b"), 0);
  strictEqual(textWidth("a界🙂"), 5);
});

Deno.test("truncateText respects display width and appends an ellipsis", () => {
  strictEqual(truncateText("hello", 10), "hello");
  strictEqual(truncateText("hello", 4), "hel…");
  strictEqual(truncateText("hello", 1, "."), ".");
  strictEqual(truncateText("界界界", 4), "界…");
  strictEqual(truncateText("hello", 0), "");
});

Deno.test("pad helpers account for ANSI and wide characters", () => {
  strictEqual(padRight("ab", 5), "ab   ");
  strictEqual(padLeft("ab", 5), "   ab");
  strictEqual(padRight("\x1b[31mab\x1b[0m", 4), "\x1b[31mab\x1b[0m  ");
  strictEqual(padLeft("界", 3), " 界");
});

Deno.test("wrapText wraps words, preserves blank lines, and splits long words", () => {
  deepStrictEqual(wrapText("one two three", 7), ["one two", "three"]);
  deepStrictEqual(wrapText("a\n\nb", 10), ["a", "", "b"]);
  deepStrictEqual(wrapText("abcdefgh", 3), ["abc", "def", "gh"]);
  deepStrictEqual(wrapText("", 5), [""]);
});

Deno.test("windowInput keeps the cursor visible in clipped input", () => {
  const full = windowInput("hello", 5, 10);
  strictEqual(full.visible, "hello");
  strictEqual(full.cursor, 5);
  strictEqual(full.clippedLeft, false);
  strictEqual(full.clippedRight, false);

  const clipped = windowInput("abcdefghij", 10, 4);
  strictEqual(clipped.clippedLeft, true);
  strictEqual(clipped.clippedRight, false);
  strictEqual(textWidth(clipped.visible) <= 4, true);

  const middle = windowInput("abcdefghij", 4, 4);
  strictEqual(middle.clippedLeft, true);
  strictEqual(middle.clippedRight, true);
  strictEqual(middle.cursor >= 0 && middle.cursor <= Array.from(middle.visible).length, true);
});

Deno.test("relative time and day labels are stable", () => {
  const now = new Date("2026-11-03T15:00:00.000Z");
  strictEqual(formatRelativeTime("2026-11-03T14:59:30.000Z", now), "now");
  strictEqual(formatRelativeTime("2026-11-03T14:30:00.000Z", now), "30m");
  strictEqual(formatRelativeTime("2026-11-03T12:00:00.000Z", now), "3h");
  strictEqual(formatRelativeTime("2026-10-31T15:00:00.000Z", now), "3d");
  strictEqual(formatRelativeTime("not-a-date", now), "");

  strictEqual(formatDayLabel("2026-11-03T09:00:00.000Z", now), "Today");
  strictEqual(formatDayLabel("2026-11-02T09:00:00.000Z", now), "Yesterday");
  strictEqual(formatDayLabel("2026-10-01T09:00:00.000Z", now).includes("Oct"), true);
  strictEqual(formatTime("2026-11-03T14:05:00.000Z").includes(":"), true);
});

Deno.test("initials and plural helpers handle edge cases", () => {
  strictEqual(initials("Alex Rivera"), "AR");
  strictEqual(initials("alex"), "AL");
  strictEqual(initials("   "), "?");
  strictEqual(plural(1, "message"), "1 message");
  strictEqual(plural(2, "message"), "2 messages");
  strictEqual(plural(2, "match", "matches"), "2 matches");
});
