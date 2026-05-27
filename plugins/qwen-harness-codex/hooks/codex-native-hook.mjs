#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bundledCli = join(pluginRoot, "scripts", "qwen-harness-codex.mjs");
const command = process.env.QWEN_HARNESS_CODEX_COMMAND || "node";
const argsPrefix = process.env.QWEN_HARNESS_CODEX_COMMAND
  ? []
  : [bundledCli];

if (!process.env.QWEN_HARNESS_CODEX_COMMAND && !existsSync(bundledCli)) {
  console.error(`[qwen-harness-codex] missing bundled CLI: ${bundledCli}`);
  process.exit(1);
}

const child = spawn(command, [...argsPrefix, "codex-native-hook"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, QWEN_HARNESS_CODEX_PLUGIN_ROOT: pluginRoot },
  shell: process.platform === "win32"
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on("error", (error) => {
  console.error(`[qwen-harness-codex] failed to launch native hook: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[qwen-harness-codex] native hook terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});
