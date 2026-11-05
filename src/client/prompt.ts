/** Prompt for a password without echoing it on an interactive terminal. */
export async function readSecret(prompt: string): Promise<string> {
  if (!Deno.stdin.isTerminal()) return await readFirstLine();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let value = "";
  let raw = false;
  try {
    Deno.stdin.setRaw(true);
    raw = true;
    await Deno.stdout.write(encoder.encode(prompt));
    const buffer = new Uint8Array(256);
    while (true) {
      const read = await Deno.stdin.read(buffer);
      if (read === null) break;
      const chunk = decoder.decode(buffer.subarray(0, read), { stream: true });
      for (const character of chunk) {
        if (character === "\u0003") {
          throw new Error("Sign-in cancelled.");
        }
        if (character === "\r" || character === "\n") {
          return value;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    }
    return value;
  } finally {
    if (raw) {
      try {
        Deno.stdin.setRaw(false);
      } catch {
        // The terminal may already be gone.
      }
      await Deno.stdout.write(encoder.encode("\n")).catch(() => undefined);
    }
  }
}

async function readFirstLine(): Promise<string> {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1024);
  let text = "";
  while (!text.includes("\n") && !text.includes("\r")) {
    const read = await Deno.stdin.read(buffer);
    if (read === null) break;
    text += decoder.decode(buffer.subarray(0, read), { stream: true });
  }
  return text.split(/[\r\n]/, 1)[0] ?? "";
}
