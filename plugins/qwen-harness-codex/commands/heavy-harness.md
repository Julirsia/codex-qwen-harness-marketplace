---
description: Run the heavy Qwen hybrid harness where Codex designs/verifies and local Qwen implements packages.
---

# Qwen Heavy Harness

Run the requested implementation through the original heavy hybrid harness. This is the assurance mode, not the primary Codex token-saving path.

Use this command when the user wants stronger orchestration, design gates, package verification, correction packages, or final proof gate, and says things like:

- `heavy harness`
- `헤비 하네스`
- `hybrid-run`
- `qwen-first`
- `Codex가 설계하고 Qwen이 구현`
- `final-gate까지`

## Arguments

- `task`: project/task request. Required.
- `cwd`: target repo/project directory. Default current workspace.
- `verification_command`: default `npm test` when appropriate.
- `model`: optional local implementation model override.

## Preflight

1. Check the target directory and current git status.
2. Check whether `.qwen-harness/state.json` already exists.
3. If an active heavy run exists, resume/status it instead of creating a duplicate unless the user explicitly wants a new run.
4. Check that `pi` is available before live worker runs.
5. Do not edit product source directly during an active `.qwen-harness` run; use packages/corrections and Qwen workers.

## Plan

State that this will use heavy hybrid mode:

- Codex initializes `.qwen-harness/`.
- Qwen performs scout and package implementation.
- Codex owns requirements, design, package verification, correction packages, and final gate.
- Evidence must include source/runtime/adversarial/reentry claims; smoke-only evidence is not enough.
- Worker stdout is summarized while streaming rather than retained as a raw log.
- Worker evidence aliases such as `pass`, `passed`, `success`, and `ok` are normalized to completed.

## Commands

Prefer MCP tools when available:

```text
codex_harness_hybrid_run
codex_harness_spawn_worker
codex_harness_verify_package
codex_harness_create_correction
codex_harness_final_gate
```

Use CLI fallback:

```bash
qwen-harness-codex hybrid-run \
  --task "TASK_TEXT" \
  --verification-command npm test
```

Then continue the heavy flow:

```bash
qwen-harness-codex worker --kind scout --live
qwen-harness-codex worker --package P001 --live
qwen-harness-codex verify-package --package P001
qwen-harness-codex create-correction --package P001 --review .qwen-harness/verification/P001-review.md
qwen-harness-codex final-gate
```

Only create correction packages when verification fails.

## Verification

Accept the run only when:

1. package verification passes,
2. the configured verification command passes,
3. final gate approves,
4. evidence is behavioral and not smoke-only,
5. residual risks are explicitly noted.

Evidence may be compact raw JSON. If `acceptanceEvidence` is absent, source/runtime/adversarial/reentry fields are normalized into acceptance claims, but source plus runtime proof are still required for approval.

## Summary

Report:

- project path
- final gate status
- packages/corrections run
- verification command result
- test count where available
- evidence and final-gate paths
- remaining risks

## Next Steps

If Codex fresh-token efficiency is the priority, use `/autonomous-run`. Keep `/heavy-harness` for riskier work where assurance is worth extra Codex orchestration.
