#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "plugins", "qwen-harness-codex");
const expectedVersion = "0.1.0+codex.20260527143033";
const expectedTools = [
  "codex_harness_hybrid_run",
  "codex_harness_hybrid_status",
  "codex_harness_spawn_worker",
  "codex_harness_model_health",
  "codex_harness_verify_package",
  "codex_harness_evaluation_report",
  "codex_harness_create_correction",
  "codex_harness_final_gate",
];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  assertManifest();
  assertNoBrokenBundleArtifacts();
  await assertMcpToolsList();
  console.log(`qwen-harness-codex marketplace verification passed (${expectedVersion})`);
}

function assertManifest() {
  const pluginJson = readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));
  if (pluginJson.name !== "qwen-harness-codex") {
    throw new Error(`Unexpected plugin name: ${pluginJson.name}`);
  }
  if (pluginJson.version !== expectedVersion) {
    throw new Error(`Expected plugin version ${expectedVersion}, found ${pluginJson.version}`);
  }
  if (pluginJson.mcpServers !== "./.mcp.json") {
    throw new Error(`Expected mcpServers to be ./.mcp.json, found ${pluginJson.mcpServers}`);
  }

  const mcpConfig = readJson(join(pluginRoot, ".mcp.json"));
  const server = mcpConfig.mcpServers?.["qwen-harness-codex"];
  if (!server) {
    throw new Error("Missing qwen-harness-codex MCP server entry");
  }
  assertEqual(server.command, "node", "MCP command");
  assertArrayEqual(server.args, ["./mcp/server.mjs"], "MCP args");
  assertEqual(server.cwd, ".", "MCP cwd");
}

function assertNoBrokenBundleArtifacts() {
  const forbiddenPaths = [
    "bin/qwen-harness-codex.js",
    "package.json",
    "src/mcp-tools.mjs",
    "src/pi-runner.mjs",
  ];
  for (const relativePath of forbiddenPaths) {
    const fullPath = join(pluginRoot, relativePath);
    if (existsSync(fullPath)) {
      throw new Error(`Forbidden broken-bundle artifact is present: ${relativePath}`);
    }
  }

  const forbiddenText = [
    "0.1.0+codex.20260527172500",
    "@modelcontextprotocol/sdk",
    "codex_harness_scout",
    "codex_harness_delegate",
  ];
  const searchableFiles = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "mcp/server.mjs",
    "scripts/qwen-harness-codex.mjs",
    "skills/qwen-first-codex-orchestration/SKILL.md",
  ];
  for (const relativePath of searchableFiles) {
    const text = readFileSync(join(pluginRoot, relativePath), "utf8");
    for (const forbidden of forbiddenText) {
      if (text.includes(forbidden)) {
        throw new Error(`Forbidden text ${forbidden} found in ${relativePath}`);
      }
    }
  }
}

async function assertMcpToolsList() {
  const responses = await runMcpSmoke();
  const tools = responses.find((message) => message.id === 2)?.result?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  assertArrayEqual(names, expectedTools, "MCP tools/list names");
}

function runMcpSmoke() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", ["./mcp/server.mjs"], {
      cwd: pluginRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = [];
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for MCP tools/list response"));
    }, 3000);

    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      try {
        drainResponses();
      } catch (error) {
        finish(error);
      }
      if (responses.some((message) => message.id === 2)) {
        finish();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!finished && code !== 0) {
        finish(new Error(`MCP server exited with ${code}: ${stderr}`));
      }
    });

    send(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "marketplace-smoke", version: "1" },
    });
    send(2, "tools/list");

    function send(id, method, params = {}) {
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }

    function drainResponses() {
      while (true) {
        const headerEnd = stdout.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = stdout.subarray(0, headerEnd).toString("utf8");
        const match = /^Content-Length:\s*(\d+)$/im.exec(header);
        if (!match) {
          throw new Error(`Malformed MCP response header: ${header}`);
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(match[1]);
        if (stdout.length < bodyEnd) return;
        responses.push(JSON.parse(stdout.subarray(bodyStart, bodyEnd).toString("utf8")));
        stdout = stdout.subarray(bodyEnd);
      }
    }

    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child.kill();
      if (error) {
        reject(error);
      } else {
        resolvePromise(responses);
      }
    }
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, found ${actual}`);
  }
}

function assertArrayEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}
