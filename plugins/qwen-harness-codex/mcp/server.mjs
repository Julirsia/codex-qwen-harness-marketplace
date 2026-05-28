#!/usr/bin/env node
import {
  checkLlamaSwapProvider,
  createCorrectionPackage,
  initHybridRun,
  loadHybridStatus,
  runAutonomous,
  runFinalGate,
  spawnWorker,
  summarizeEvaluation,
  verifyPackage
} from "../scripts/qwen-harness-codex.mjs";

const tools = [
  {
    name: "codex_harness_hybrid_run",
    description: "Run the Codex-native hybrid state initialization and create .qwen-harness state.",
    inputSchema: objectSchema({
      cwd: { type: "string" },
      task: { type: "string" },
      verificationCommand: { type: "array", items: { type: "string" } }
    }, ["task"])
  },
  {
    name: "codex_harness_hybrid_status",
    description: "Summarize the current .qwen-harness Codex-native hybrid state.",
    inputSchema: objectSchema({ cwd: { type: "string" } })
  },
  {
    name: "codex_harness_spawn_worker",
    description: "Prepare or launch a Pi/local Qwen worker for scout, package implementation, or correction.",
    inputSchema: objectSchema({
      cwd: { type: "string" },
      package: { type: "string" },
      correction: { type: "string" },
      kind: { type: "string" },
      live: { type: "boolean" }
    })
  },
  {
    name: "codex_harness_model_health",
    description: "Check llama-swap model listing, running model state, and optional tiny completion probe before launching a worker.",
    inputSchema: objectSchema({
      providerUrl: { type: "string" },
      llamaSwapUrl: { type: "string" },
      model: { type: "string" },
      probe: { type: "boolean" },
      providerProbe: { type: "boolean" },
      allowModelSwitch: { type: "boolean" },
      providerTimeoutMs: { type: "number" }
    })
  },
  {
    name: "codex_harness_verify_package",
    description: "Create a Codex package verification review from worker evidence.",
    inputSchema: objectSchema({
      cwd: { type: "string" },
      package: { type: "string" },
      packageId: { type: "string" }
    })
  },
  {
    name: "codex_harness_evaluation_report",
    description: "Summarize local worker metrics, token usage, package verdicts, final gates, and model-routing observations for one or more .qwen-harness projects.",
    inputSchema: objectSchema({
      cwd: { type: "string" },
      scanRoot: { type: "string" },
      maxDepth: { type: "number" }
    })
  },
  {
    name: "codex_harness_autonomous_run",
    description: "Run autonomous-lite mode: local Qwen implements, tests, repairs internally, and Codex validates compact evidence only.",
    inputSchema: objectSchema({
      project: { type: "string" },
      cwd: { type: "string" },
      task: { type: "string" },
      taskFile: { type: "string" },
      model: { type: "string" },
      verificationCommand: { type: "array", items: { type: "string" } },
      minTests: { type: "number" },
      repairAttempts: { type: "number" },
      maxInternalLoops: { type: "number" },
      evidenceFile: { type: "string" },
      allowExisting: { type: "boolean" },
      dryRun: { type: "boolean" },
      validateOnly: { type: "boolean" },
      timeoutMs: { type: "number" },
      verifyTimeoutMs: { type: "number" }
    })
  },
  {
    name: "codex_harness_create_correction",
    description: "Create a Codex-authored correction package for a failed package review.",
    inputSchema: objectSchema({
      cwd: { type: "string" },
      package: { type: "string" },
      packageId: { type: "string" },
      review: { type: "string" }
    })
  },
  {
    name: "codex_harness_final_gate",
    description: "Run the Codex-owned final proof gate.",
    inputSchema: objectSchema({ cwd: { type: "string" } })
  }
];

const handlers = {
  codex_harness_hybrid_run: initHybridRun,
  codex_harness_hybrid_status: loadHybridStatus,
  codex_harness_spawn_worker: spawnWorker,
  codex_harness_model_health: checkLlamaSwapProvider,
  codex_harness_verify_package: verifyPackage,
  codex_harness_evaluation_report: summarizeEvaluation,
  codex_harness_autonomous_run: runAutonomous,
  codex_harness_create_correction: createCorrectionPackage,
  codex_harness_final_gate: runFinalGate
};

let byteBuffer = Buffer.alloc(0);
let outputMode = "jsonl";
process.stdin.on("data", (chunk) => {
  byteBuffer = Buffer.concat([byteBuffer, Buffer.from(chunk)]);
  drainMessages();
});

function drainMessages() {
  while (byteBuffer.length > 0) {
    const headerEnd = findHeaderEnd(byteBuffer);
    if (headerEnd) {
      outputMode = "content-length";
      const header = byteBuffer.slice(0, headerEnd.index).toString("utf8");
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      if (!match) throw new Error("MCP message is missing Content-Length.");
      const length = Number(match[1]);
      const messageStart = headerEnd.end;
      const messageEnd = messageStart + length;
      if (byteBuffer.length < messageEnd) return;
      handleMessageText(byteBuffer.slice(messageStart, messageEnd).toString("utf8"));
      byteBuffer = byteBuffer.slice(messageEnd);
      continue;
    }

    const newline = byteBuffer.indexOf(0x0a);
    if (newline < 0) return;
    const line = byteBuffer.slice(0, newline).toString("utf8").trim();
    byteBuffer = byteBuffer.slice(newline + 1);
    if (line) {
      outputMode = "jsonl";
      handleMessageText(line);
    }
  }
}

function handleMessageText(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  try {
    if (message.method === "initialize") {
      respond(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "qwen-harness-codex", version: "0.1.0" }
      });
      return;
    }
    if (message.method === "tools/list") {
      respond(message.id, { tools });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const handler = handlers[name];
      if (!handler) throw new Error(`unknown tool: ${name}`);
      const result = handler(args);
      respond(message.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      });
      return;
    }
    respond(message.id, {});
  } catch (error) {
    writeJsonRpc({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } });
  }
}

function respond(id, result) {
  writeJsonRpc({ jsonrpc: "2.0", id, result });
}

function writeJsonRpc(payload) {
  const body = JSON.stringify(payload);
  if (outputMode === "content-length") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    return;
  }
  process.stdout.write(`${body}\n`);
}

function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { index: crlf, end: crlf + 4 };
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return { index: lf, end: lf + 2 };
  return null;
}

function objectSchema(properties = {}, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: true
  };
}
