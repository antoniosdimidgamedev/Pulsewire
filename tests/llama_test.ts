import { strictEqual } from "node:assert/strict";
import {
  DEFAULT_PORT,
  endpointPort,
  formatBytes,
  healthUrl,
  isLoopbackHost,
  LLAMA_MODEL,
  LLAMA_RELEASE,
  llamaAsset,
  llamaPaths,
  serverArgs,
  serverBinaryName,
} from "../scripts/llama.ts";
import { loadConfig } from "../src/config.ts";

Deno.test("pinned llama.cpp builds cover x86_64 Linux and Windows", () => {
  const linux = llamaAsset("linux", "x86_64");
  strictEqual(
    linux?.url,
    `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/` +
      `llama-${LLAMA_RELEASE}-bin-ubuntu-x64.tar.gz`,
  );
  strictEqual(linux?.archive, "tar.gz");
  strictEqual(/^[0-9a-f]{64}$/.test(linux?.sha256 ?? ""), true);

  const windows = llamaAsset("windows", "x86_64");
  strictEqual(
    windows?.url,
    `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/` +
      `llama-${LLAMA_RELEASE}-bin-win-cpu-x64.zip`,
  );
  strictEqual(windows?.archive, "zip");
  strictEqual(/^[0-9a-f]{64}$/.test(windows?.sha256 ?? ""), true);

  strictEqual(llamaAsset("linux", "aarch64"), null);
  strictEqual(llamaAsset("darwin", "x86_64"), null);
});

Deno.test("the pinned model is Qwen3 0.6B with a verified checksum", () => {
  strictEqual(LLAMA_MODEL.name, "qwen3:0.6b");
  strictEqual(LLAMA_MODEL.file, "Qwen3-0.6B-Q4_K_M.gguf");
  strictEqual(LLAMA_MODEL.bytes, 396_705_472);
  strictEqual(/^[0-9a-f]{64}$/.test(LLAMA_MODEL.sha256), true);
  strictEqual(LLAMA_MODEL.url.startsWith("https://huggingface.co/"), true);
  strictEqual(serverBinaryName("linux"), "llama-server");
  strictEqual(serverBinaryName("windows"), "llama-server.exe");
});

Deno.test("paths stay inside the data directory on both platforms", () => {
  const linux = llamaPaths("/home/alex/.local/share/pulsewire", "linux");
  strictEqual(linux.modelPath, "/home/alex/.local/share/pulsewire/models/Qwen3-0.6B-Q4_K_M.gguf");
  strictEqual(linux.logPath, "/home/alex/.local/share/pulsewire/llama-server.log");
  strictEqual(
    linux.markerPath,
    `/home/alex/.local/share/pulsewire/llama.cpp/${LLAMA_RELEASE}/install.json`,
  );

  const windows = llamaPaths("C:\\Users\\alex\\AppData\\Local\\Pulsewire", "windows");
  strictEqual(
    windows.modelPath,
    "C:\\Users\\alex\\AppData\\Local\\Pulsewire\\models\\Qwen3-0.6B-Q4_K_M.gguf",
  );
  strictEqual(
    windows.markerPath,
    `C:\\Users\\alex\\AppData\\Local\\Pulsewire\\llama.cpp\\${LLAMA_RELEASE}\\install.json`,
  );
});

Deno.test("server arguments are local, quiet, and deterministic", () => {
  const args = serverArgs({
    modelPath: "/models/qwen3.gguf",
    alias: "qwen3:0.6b",
    port: 9931,
  });
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  strictEqual(value("-m"), "/models/qwen3.gguf");
  strictEqual(value("-a"), "qwen3:0.6b");
  strictEqual(value("--host"), "127.0.0.1");
  strictEqual(value("--port"), "9931");
  strictEqual(value("-c"), "2048");
  strictEqual(args.includes("--no-webui"), true);
  strictEqual(value("--reasoning"), "on");
  strictEqual(value("--reasoning-budget"), "256");
});

Deno.test("only loopback endpoints are managed locally", () => {
  strictEqual(isLoopbackHost("http://127.0.0.1:9931/v1"), true);
  strictEqual(isLoopbackHost("http://localhost:8080/v1"), true);
  strictEqual(isLoopbackHost("http://[::1]:9931/v1"), true);
  strictEqual(isLoopbackHost("http://dev.localhost/v1"), true);
  strictEqual(isLoopbackHost("http://192.168.1.10:9931/v1"), false);
  strictEqual(isLoopbackHost("https://api.example.com/v1"), false);
  strictEqual(isLoopbackHost("not a url"), false);
});

Deno.test("the server port follows the configured base URL", () => {
  strictEqual(endpointPort("http://127.0.0.1:9931/v1"), 9931);
  strictEqual(endpointPort("http://127.0.0.1:8080"), 8080);
  strictEqual(endpointPort("http://127.0.0.1/v1"), DEFAULT_PORT);
  strictEqual(endpointPort("http://127.0.0.1:70000/v1"), null);
  strictEqual(endpointPort("nonsense"), null);
  strictEqual(healthUrl("http://127.0.0.1:9931/v1"), "http://127.0.0.1:9931/health");
  strictEqual(healthUrl("http://localhost:8080/v1/"), "http://localhost:8080/health");
});

Deno.test("byte sizes are human readable", () => {
  strictEqual(formatBytes(512), "512 B");
  strictEqual(formatBytes(2_048), "2 KB");
  strictEqual(formatBytes(396_705_472), "378 MB");
  strictEqual(formatBytes(5 * 1024 ** 3), "5 GB");
});

Deno.test("config defaults point at the managed llama.cpp endpoint", async () => {
  const config = await loadConfig({
    platform: "linux",
    env: {},
    home: "/home/alex",
    cwd: "/work",
    readTextFile: () => Promise.reject(new Deno.errors.NotFound("missing")),
  });
  strictEqual(config.demo.ai.model, LLAMA_MODEL.name);
  strictEqual(isLoopbackHost(config.demo.ai.baseUrl), true);
  strictEqual(endpointPort(config.demo.ai.baseUrl), DEFAULT_PORT);
});
