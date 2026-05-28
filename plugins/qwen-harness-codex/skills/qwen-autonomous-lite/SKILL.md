---
name: qwen-autonomous-lite
description: Use when the user explicitly asks for autonomous-run, autonomous-lite, Qwen self-contained implementation, Codex judging only, local model token-saving implementation, or compact evidence validation.
---

# Qwen Autonomous Lite

Use this skill when the user wants local Qwen to do the implementation, testing, and repair loop while Codex only validates compact evidence.

Trigger phrases include:

- `autonomous-run`
- `autonomous-lite`
- `Qwen이 자체 완결`
- `Codex는 판정만`
- `로컬모델로 구현`
- `코덱스 토큰 절약`

## Architecture

Autonomous-lite is the token-saving mode.

1. Codex creates a short executable contract.
2. The harness stores state in `.qwen-autonomous/`.
3. Pi launches local Qwen with cwd fixed to the target project.
4. Qwen implements, tests, repairs internally, and writes `evidence.json`.
5. Codex validates `evidence.json` and the configured verification command.

Codex must not read `.qwen-autonomous/runs/*/pi.stdout.jsonl` during benchmark measurement.

## Preferred Invocation

Use the MCP tool `codex_harness_autonomous_run` when available.

CLI fallback:

```bash
qwen-harness-codex autonomous-run \
  --project PROJECT_PATH \
  --task-file TASK_FILE \
  --min-tests 20 \
  --verification-command npm test
```

For inline task text:

```bash
qwen-harness-codex autonomous-run \
  --project PROJECT_PATH \
  --task "TASK_TEXT" \
  --min-tests 20 \
  --verification-command npm test
```

## Validation

Use:

```bash
qwen-harness-codex autonomous-validate \
  --project PROJECT_PATH \
  --min-tests 20 \
  --verification-command npm test
```

Reject missing evidence, zero tests, failed verification, parent-package npm walkups, and files escaping the project directory.

## Output

Report the compact result:

- project path
- status
- `evidence.json` path
- test command and test count
- risks
- whether a repair attempt ran
