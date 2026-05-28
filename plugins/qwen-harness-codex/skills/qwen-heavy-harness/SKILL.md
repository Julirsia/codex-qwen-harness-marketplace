---
name: qwen-heavy-harness
description: Use when the user explicitly asks for heavy harness, 헤비 하네스, hybrid-run, qwen-first orchestration, package verification, correction packages, or final-gate quality review.
---

# Qwen Heavy Harness

Use this skill when the user wants the original Codex-owned heavy hybrid harness. Treat it as assurance-oriented, not as the main Codex token-saving mode.

Trigger phrases include:

- `heavy harness`
- `헤비 하네스`
- `hybrid-run`
- `qwen-first`
- `final-gate`
- `Codex가 설계하고 Qwen이 구현`

## Architecture

Heavy harness is the assurance-oriented mode.

1. Codex initializes `.qwen-harness/`.
2. Qwen runs scout.
3. Codex writes requirements, design, plan review, and packages.
4. Qwen implements packages.
5. Codex verifies package evidence.
6. Codex writes correction packages when needed.
7. Qwen repairs.
8. Codex runs final gate.

Codex must not directly mutate product source/test/config during an active `.qwen-harness` run.
The runner writes Pi JSONL to disk, parses token usage from the file, and normalizes compact worker evidence aliases. If `acceptanceEvidence` is missing, raw source/runtime/adversarial/reentry fields can be converted into acceptance claims, but source plus runtime proof are still required.

## Preferred Invocation

Use MCP tools when available:

- `codex_harness_hybrid_run`
- `codex_harness_spawn_worker`
- `codex_harness_verify_package`
- `codex_harness_create_correction`
- `codex_harness_final_gate`

CLI fallback:

```bash
qwen-harness-codex hybrid-run \
  --task "TASK_TEXT" \
  --verification-command npm test
```

Then:

```bash
qwen-harness-codex worker --kind scout --live
qwen-harness-codex worker --package P001 --live
qwen-harness-codex verify-package --package P001
qwen-harness-codex final-gate
```

Create correction packages only when verification fails.

## Validation

Do not accept smoke-only evidence. Require source evidence, runtime evidence, adversarial probes, reentry/idempotency probes, and residual risk notes where applicable.

## Output

Report:

- project path
- package and correction count
- verification result
- final-gate result
- evidence paths
- residual risks
