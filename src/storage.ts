import { dirname } from "node:path";

/**
 * Write a file atomically and with restrictive permissions where supported.
 * The destination's parent directory is created when missing.
 */
export async function writePrivateText(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(tempPath, content, { mode: 0o600 });
  try {
    await Deno.rename(tempPath, path);
  } catch (error) {
    if (Deno.build.os === "windows") {
      await Deno.remove(path).catch(() => undefined);
      await Deno.rename(tempPath, path);
    } else {
      await Deno.remove(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}
