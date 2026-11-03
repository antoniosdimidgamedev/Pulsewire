/**
 * Manage the pinned llama.cpp build used by the demo's local AI replies.
 *
 *   deno task ai:setup   # download llama.cpp and Qwen3 0.6B
 *   deno task ai         # install if needed, start the server, open Pulsewire
 *   deno task ai:serve   # run the llama.cpp server on its own
 *
 * Everything is stored under the Pulsewire data directory, never in the
 * repository. Downloads are pinned to a release and verified with SHA-256.
 */
import { dirname, join } from "node:path";
import { type AppConfig, loadConfig, pathFor } from "../src/config.ts";
import { main as runPulsewire } from "../src/main.ts";

/** llama.cpp publishes rolling builds; pin one so checksums stay valid. */
export const LLAMA_RELEASE = "b12078";

/** The tiny model the demo is tuned for. */
export const LLAMA_MODEL = {
  name: "qwen3:0.6b",
  file: "Qwen3-0.6B-Q4_K_M.gguf",
  url: "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
  sha256: "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a",
  bytes: 396_705_472,
} as const;

/** llama-server's default port in current builds. */
export const DEFAULT_PORT = 9931;

const RELEASES = "https://github.com/ggml-org/llama.cpp/releases/download";
const HEALTH_TIMEOUT_MS = 120_000;

export interface LlamaAsset {
  url: string;
  sha256: string;
  archive: "tar.gz" | "zip";
}

/**
 * Only x86_64 Linux and Windows builds are pinned. Other platforms can run
 * llama.cpp themselves and point `demo.ai.baseUrl` at it.
 */
export function llamaAsset(platform: string, arch: string): LlamaAsset | null {
  if (arch !== "x86_64") return null;
  if (platform === "linux") {
    return {
      url: `${RELEASES}/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-ubuntu-x64.tar.gz`,
      sha256: "600059b6d20ece89e19a20c4e9ab8d23c54cc33e9132a692dffbcc10ed226003",
      archive: "tar.gz",
    };
  }
  if (platform === "windows") {
    return {
      url: `${RELEASES}/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-win-cpu-x64.zip`,
      sha256: "923baa2c55b45c7b312daf340e923d80f66faab36721aaf53313bb21c21baadd",
      archive: "zip",
    };
  }
  return null;
}

export function serverBinaryName(platform: string): string {
  return platform === "windows" ? "llama-server.exe" : "llama-server";
}

export interface LlamaPaths {
  root: string;
  releaseDir: string;
  downloadsDir: string;
  modelDir: string;
  modelPath: string;
  logPath: string;
  markerPath: string;
}

export function llamaPaths(dataDir: string, platform: string): LlamaPaths {
  const path = pathFor(platform);
  const root = path.join(dataDir, "llama.cpp");
  const modelDir = path.join(dataDir, "models");
  return {
    root,
    releaseDir: path.join(root, LLAMA_RELEASE),
    downloadsDir: path.join(root, "downloads"),
    modelDir,
    modelPath: path.join(modelDir, LLAMA_MODEL.file),
    logPath: path.join(dataDir, "llama-server.log"),
    markerPath: path.join(root, LLAMA_RELEASE, "install.json"),
  };
}

export interface ServerArgsOptions {
  modelPath: string;
  alias: string;
  host?: string;
  port?: number;
  contextSize?: number;
}

/** Arguments chosen for a fast, quiet, single-user local server. */
export function serverArgs(options: ServerArgsOptions): string[] {
  return [
    "-m",
    options.modelPath,
    "-a",
    options.alias,
    "--host",
    options.host ?? "127.0.0.1",
    "--port",
    String(options.port ?? DEFAULT_PORT),
    "-c",
    String(options.contextSize ?? 2048),
    "-np",
    "1",
    "--no-webui",
    "--reasoning",
    "on",
    "--reasoning-budget",
    "256",
  ];
}

export function isLoopbackHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    host.endsWith(".localhost");
}

/** Resolve the port to serve on from the configured OpenAI-compatible base URL. */
export function endpointPort(baseUrl: string): number | null {
  try {
    const url = new URL(baseUrl);
    if (!url.port) return DEFAULT_PORT;
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

export function healthUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

interface InstallMarker {
  release: string;
  model: string;
  serverPath: string;
  installedAt: string;
}

export interface InstallResult {
  serverPath: string;
  modelPath: string;
  dataDir: string;
}

export interface SetupOptions {
  dataDir: string;
  platform?: string;
  arch?: string;
  force?: boolean;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Download, verify, and unpack llama.cpp plus the Qwen3 0.6B weights.
 * A marker makes repeat runs cheap; `force` re-installs from scratch.
 */
export async function setupLlama(options: SetupOptions): Promise<InstallResult> {
  const platform = options.platform ?? Deno.build.os;
  const arch = options.arch ?? Deno.build.arch;
  const log = options.log ?? ((line: string) => console.log(line));
  const fetchImpl = options.fetchImpl ?? fetch;
  const paths = llamaPaths(options.dataDir, platform);

  if (!options.force) {
    const ready = await installedServer(paths, platform);
    if (ready) return { serverPath: ready, modelPath: paths.modelPath, dataDir: options.dataDir };
  }

  const asset = llamaAsset(platform, arch);
  if (!asset) {
    throw new Error(
      `No pinned llama.cpp build for ${platform}/${arch}. ` +
        "Install llama.cpp yourself and point demo.ai.baseUrl at its /v1 endpoint.",
    );
  }

  await Deno.mkdir(paths.downloadsDir, { recursive: true });
  await Deno.mkdir(paths.releaseDir, { recursive: true });
  await Deno.mkdir(paths.modelDir, { recursive: true });

  const modelStat = await statOrNull(paths.modelPath);
  if (modelStat?.size === LLAMA_MODEL.bytes && !options.force) {
    log(`Model already present: ${paths.modelPath}`);
  } else {
    log(`Downloading ${LLAMA_MODEL.name} (${formatBytes(LLAMA_MODEL.bytes)})…`);
    const partial = `${paths.modelPath}.part`;
    await download(LLAMA_MODEL.url, partial, fetchImpl);
    const hash = await sha256File(partial);
    if (hash !== LLAMA_MODEL.sha256) {
      await Deno.remove(partial).catch(() => undefined);
      throw new Error(
        `The model download failed verification (expected ${LLAMA_MODEL.sha256}, got ${hash}).`,
      );
    }
    await Deno.rename(partial, paths.modelPath);
    log(`Model ready: ${paths.modelPath}`);
  }

  const archivePath = join(
    paths.downloadsDir,
    `llama-${LLAMA_RELEASE}.${asset.archive}`,
  );
  const cached = await statOrNull(archivePath);
  if (!cached || options.force) {
    log(`Downloading llama.cpp ${LLAMA_RELEASE}…`);
    await download(asset.url, archivePath, fetchImpl);
  }
  const archiveHash = await sha256File(archivePath);
  if (archiveHash !== asset.sha256) {
    await Deno.remove(archivePath).catch(() => undefined);
    throw new Error(
      `The llama.cpp download failed verification (expected ${asset.sha256}, got ${archiveHash}).`,
    );
  }

  log("Unpacking llama.cpp…");
  const extract = new Deno.Command("tar", {
    args: ["-xf", archivePath, "-C", paths.releaseDir],
    stdout: "null",
    stderr: "piped",
  });
  const result = await extract.output();
  if (!result.success) {
    throw new Error(
      `Could not unpack the llama.cpp archive: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }

  const serverPath = await findFile(paths.releaseDir, serverBinaryName(platform), 4);
  if (!serverPath) {
    throw new Error("The llama.cpp archive did not contain llama-server.");
  }
  await chmodExecutable(serverPath, platform);
  await ensureLinuxSsl(serverPath, paths.releaseDir, platform, log);

  const marker: InstallMarker = {
    release: LLAMA_RELEASE,
    model: LLAMA_MODEL.file,
    serverPath,
    installedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(paths.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  log(`llama.cpp ready: ${serverPath}`);
  return { serverPath, modelPath: paths.modelPath, dataDir: options.dataDir };
}

async function installedServer(paths: LlamaPaths, platform: string): Promise<string | null> {
  try {
    const marker = JSON.parse(await Deno.readTextFile(paths.markerPath)) as Partial<InstallMarker>;
    if (marker.release !== LLAMA_RELEASE || marker.model !== LLAMA_MODEL.file) return null;
    if (typeof marker.serverPath !== "string") return null;
    const model = await Deno.stat(paths.modelPath);
    if (model.size !== LLAMA_MODEL.bytes) return null;
    const server = await Deno.stat(marker.serverPath);
    if (!server.isFile) return null;
    await chmodExecutable(marker.serverPath, platform);
    return marker.serverPath;
  } catch {
    return null;
  }
}

async function chmodExecutable(path: string, platform: string): Promise<void> {
  if (platform === "windows") return;
  const stat = await Deno.stat(path);
  if ((stat.mode ?? 0) & 0o111) return;
  await Deno.chmod(path, (stat.mode ?? 0o644) | 0o755);
}

async function download(url: string, destination: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${url} returned HTTP ${response.status}.`);
  }
  const file = await Deno.open(destination, { create: true, write: true, truncate: true });
  try {
    for await (const chunk of response.body) await file.write(chunk);
  } finally {
    file.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function findFile(root: string, name: string, depth: number): Promise<string | null> {
  if (depth < 0) return null;
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile && entry.name === name) return join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const found = await findFile(join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch {
    return null;
  }
}

export interface LocalServer {
  url: string;
  started: boolean;
  stop(): Promise<void>;
}

export interface ServerOptions {
  dataDir: string;
  baseUrl: string;
  alias?: string;
  platform?: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
}

/**
 * Reuse a healthy server on the configured port, or start the installed one.
 * The server writes to `<dataDir>/llama-server.log` so it never disturbs the TUI.
 */
export async function ensureLlamaServer(options: ServerOptions): Promise<LocalServer> {
  const platform = options.platform ?? Deno.build.os;
  const log = options.log ?? ((line: string) => console.log(line));
  const fetchImpl = options.fetchImpl ?? fetch;
  const paths = llamaPaths(options.dataDir, platform);
  const port = endpointPort(options.baseUrl);
  if (port === null) throw new Error(`Unsupported AI endpoint: ${options.baseUrl}`);
  const health = healthUrl(options.baseUrl);

  if (await isHealthy(health, fetchImpl)) {
    log(`Using the llama.cpp server already listening on port ${port}.`);
    return { url: options.baseUrl, started: false, stop: () => Promise.resolve() };
  }

  const { serverPath, modelPath } = await setupLlama({ dataDir: options.dataDir, platform });
  const sslDir = await ensureLinuxSsl(serverPath, paths.releaseDir, platform, log);
  const args = serverArgs({
    modelPath,
    alias: options.alias ?? LLAMA_MODEL.name,
    port,
  });

  log(`Starting llama.cpp on http://127.0.0.1:${port}…`);
  const logFile = await Deno.open(paths.logPath, {
    create: true,
    write: true,
    append: true,
  });
  const child = new Deno.Command(serverPath, {
    args,
    cwd: dirname(serverPath),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: childEnv(sslDir),
  }).spawn();
  void pump(child.stdout, logFile);
  void pump(child.stderr, logFile);

  const stop = async () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    const force = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, 3_000);
    await child.status.catch(() => undefined);
    clearTimeout(force);
    try {
      logFile.close();
    } catch {
      // Already closed.
    }
  };

  try {
    await waitForHealth(health, child, fetchImpl, options.healthTimeoutMs);
  } catch (error) {
    await stop();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `See ${paths.logPath}.`,
    );
  }

  return { url: options.baseUrl, started: true, stop };
}

function childEnv(sslDir: string | null): Record<string, string> {
  const env = Deno.env.toObject();
  if (!sslDir) return env;
  const existing = env.LD_LIBRARY_PATH;
  env.LD_LIBRARY_PATH = existing ? `${sslDir}:${existing}` : sslDir;
  return env;
}

/**
 * Ubuntu 26.10+ ships OpenSSL 4, while current llama.cpp builds link against
 * libssl.so.3. Fetch a private copy of the OpenSSL 3 runtime when needed; no
 * system packages or root access are touched.
 */
async function ensureLinuxSsl(
  serverPath: string,
  releaseDir: string,
  platform: string,
  log: (line: string) => void,
): Promise<string | null> {
  if (platform !== "linux") return null;
  const sslDir = join(releaseDir, "openssl3");
  if (await statOrNull(join(sslDir, "libssl.so.3"))) return sslDir;

  const probe = await probeServer(serverPath);
  if (probe.ok || !probe.stderr.includes("libssl.so.3")) return null;

  log("llama.cpp needs the OpenSSL 3 runtime; fetching a private copy…");
  const temp = await Deno.makeTempDir({ dir: releaseDir });
  try {
    let debPath: string | null = null;
    for (const pkg of ["libssl3t64", "libssl3"]) {
      const result = await new Deno.Command("apt-get", {
        args: ["download", pkg],
        cwd: temp,
        stdout: "null",
        stderr: "null",
      }).output().catch(() => null);
      if (!result?.success) continue;
      for await (const entry of Deno.readDir(temp)) {
        if (entry.isFile && entry.name.endsWith(".deb")) {
          debPath = join(temp, entry.name);
          break;
        }
      }
      if (debPath) break;
    }
    if (!debPath) {
      throw new Error(
        "llama.cpp needs libssl.so.3. Install the OpenSSL 3 runtime " +
          "(libssl3t64 on Ubuntu) and retry.",
      );
    }

    const root = join(temp, "root");
    const extract = await new Deno.Command("dpkg-deb", {
      args: ["-x", debPath, root],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!extract.success) {
      throw new Error(
        `Could not unpack the OpenSSL runtime: ${new TextDecoder().decode(extract.stderr).trim()}`,
      );
    }

    await Deno.mkdir(sslDir, { recursive: true });
    for (const name of ["libssl.so.3", "libcrypto.so.3"]) {
      const found = await findFile(root, name, 8);
      if (!found) throw new Error(`The OpenSSL package did not contain ${name}.`);
      await Deno.copyFile(found, join(sslDir, name));
    }
    log(`OpenSSL 3 runtime ready: ${sslDir}`);
    return sslDir;
  } finally {
    await Deno.remove(temp, { recursive: true }).catch(() => undefined);
  }
}

async function probeServer(
  serverPath: string,
): Promise<{ ok: boolean; stderr: string }> {
  try {
    const result = await new Deno.Command(serverPath, {
      args: ["--version"],
      stdout: "null",
      stderr: "piped",
    }).output();
    return { ok: result.success, stderr: new TextDecoder().decode(result.stderr) };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function pump(stream: ReadableStream<Uint8Array>, file: Deno.FsFile): Promise<void> {
  try {
    for await (const chunk of stream) await file.write(chunk);
  } catch {
    // The log file or the child closed first.
  }
}

async function isHealthy(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(1_500) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(
  url: string,
  child: Deno.ChildProcess,
  fetchImpl: typeof fetch,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exited(child)) {
      throw new Error("llama.cpp stopped before it became ready.");
    }
    if (await isHealthy(url, fetchImpl)) return;
    await delay(250);
  }
  throw new Error("llama.cpp did not become ready in time.");
}

async function exited(child: Deno.ChildProcess): Promise<boolean> {
  // `status` resolves on exit; a resolved promise means the process is gone.
  const status = await Promise.race([
    child.status.then(() => true),
    delay(0).then(() => false),
  ]);
  return status;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve the config the same way the app does, so paths never drift. */
async function loadAppConfig(): Promise<AppConfig> {
  return await loadConfig({ env: Deno.env.toObject() });
}

function printSetupSummary(result: InstallResult): void {
  console.log("");
  console.log("Local AI is ready.");
  console.log(`  model   ${LLAMA_MODEL.name} (${LLAMA_MODEL.file})`);
  console.log(`  weights ${result.modelPath}`);
  console.log(`  runtime ${result.serverPath}`);
  console.log("");
  console.log("Run `make ai` or `./run.sh --ai` to start Pulsewire.");
}

async function commandSetup(force: boolean): Promise<number> {
  const config = await loadAppConfig();
  console.log(`Installing llama.cpp ${LLAMA_RELEASE} and ${LLAMA_MODEL.name}.`);
  console.log(`Data directory: ${config.dataDir}`);
  console.log("");
  const result = await setupLlama({ dataDir: config.dataDir, force });
  printSetupSummary(result);
  return 0;
}

async function commandServe(): Promise<number> {
  const config = await loadAppConfig();
  const server = await ensureLlamaServer({
    dataDir: config.dataDir,
    baseUrl: config.demo.ai.baseUrl,
    alias: config.demo.ai.model,
  });
  console.log(`llama.cpp is serving ${config.demo.ai.model} at ${server.url}`);
  console.log("Press Ctrl+C to stop.");
  await new Promise<void>((resolve) => {
    Deno.addSignalListener("SIGINT", () => resolve());
  });
  await server.stop();
  return 0;
}

async function commandRun(): Promise<number> {
  const config = await loadAppConfig();
  if (!isLoopbackHost(config.demo.ai.baseUrl)) {
    console.log(`Using the configured AI endpoint at ${config.demo.ai.baseUrl}.`);
    return await runPulsewire(["--demo", "--ai"]);
  }

  const server = await ensureLlamaServer({
    dataDir: config.dataDir,
    baseUrl: config.demo.ai.baseUrl,
    alias: config.demo.ai.model,
  });
  try {
    return await runPulsewire(["--demo", "--ai"]);
  } finally {
    if (server.started) await server.stop();
  }
}

async function commandClean(yes: boolean): Promise<number> {
  const config = await loadAppConfig();
  const paths = llamaPaths(config.dataDir, Deno.build.os);
  const runtime = await statOrNull(paths.root);
  const model = await statOrNull(paths.modelPath);
  if (!runtime && !model) {
    console.log("No local AI runtime or model to remove.");
    return 0;
  }

  console.log("This removes:");
  if (runtime) console.log(`  ${paths.root}`);
  if (model) console.log(`  ${paths.modelPath}`);
  if (!yes) {
    if (!Deno.stdin.isTerminal()) {
      console.error("Refusing to delete without confirmation. Re-run with --yes.");
      return 2;
    }
    const answer = await promptLine("Delete these files? [y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Cancelled.");
      return 0;
    }
  }

  await Deno.remove(paths.root, { recursive: true }).catch(() => undefined);
  await Deno.remove(paths.modelPath).catch(() => undefined);
  // Only remove the models directory when nothing else lives there.
  await Deno.remove(paths.modelDir).catch(() => undefined);
  console.log("Removed the local AI runtime and model.");
  return 0;
}

async function promptLine(prompt: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(prompt));
  const buffer = new Uint8Array(64);
  const read = await Deno.stdin.read(buffer);
  return read ? new TextDecoder().decode(buffer.subarray(0, read)) : "";
}

async function commandStatus(): Promise<number> {
  const config = await loadAppConfig();
  const paths = llamaPaths(config.dataDir, Deno.build.os);
  const serverPath = await installedServer(paths, Deno.build.os);
  const model = await statOrNull(paths.modelPath);
  console.log(`Data directory: ${config.dataDir}`);
  console.log(`Runtime:        ${serverPath ?? "not installed"}`);
  console.log(
    `Model:          ${
      model ? `${LLAMA_MODEL.file} (${formatBytes(model.size)})` : "not downloaded"
    }`,
  );
  console.log(`Endpoint:       ${config.demo.ai.baseUrl}`);
  console.log(`Server log:     ${paths.logPath}`);
  return 0;
}

const USAGE = `Pulsewire local AI (llama.cpp)

Usage: deno task ai[:command] [--force|--yes]

  run      Install if needed, start llama.cpp, and open Pulsewire (default)
  setup    Download and verify llama.cpp and ${LLAMA_MODEL.name}
  serve    Start the llama.cpp server without the TUI
  status   Show the installed runtime, model, and endpoint
  clean    Delete the downloaded runtime and model

Options:
  --force     Re-install the pinned llama.cpp build and model
  --yes       Skip the confirmation prompt for "clean"
  -h, --help  Show this help

The release is pinned to llama.cpp ${LLAMA_RELEASE} and
${LLAMA_MODEL.file}, stored under the Pulsewire data directory.
`;

export async function cli(argv: string[]): Promise<number> {
  const [command = "run", ...rest] = argv;
  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  const force = rest.includes("--force");
  const yes = rest.includes("--yes");
  switch (command) {
    case "run":
      return await commandRun();
    case "setup":
      return await commandSetup(force);
    case "serve":
      return await commandServe();
    case "status":
      return await commandStatus();
    case "clean":
      return await commandClean(yes);
    default:
      console.error(`llama: unknown command "${command}".`);
      console.error(USAGE);
      return 2;
  }
}

if (import.meta.main) {
  try {
    Deno.exitCode = await cli(Deno.args);
  } catch (error) {
    console.error(`llama: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exitCode = 1;
  }
}
