---
description: Run Qwen autonomous-lite mode so local Qwen implements, tests, repairs, and Codex validates compact evidence only.
---

# Qwen Autonomous Run

Run the requested implementation through Qwen autonomous-lite mode.

Use this command when the user wants maximum Codex token savings and says things like:

- `autonomous-run`
- `autonomous-lite`
- `Qwen이 자체 완결`
- `Codex는 판정만`
- `로컬모델이 구현하고 테스트까지`

## Arguments

- `project`: target project directory. Required unless the user clearly names one.
- `task` or `task_file`: natural-language task/spec. Required unless the current user prompt is itself the task.
- `verification_command`: default `npm test`.
- `min_tests`: default `1`; ask or choose a sensible threshold for benchmark work.
- `model`: optional local model override.

## Preflight

1. Confirm the target project path.
2. Confirm there is no active `.qwen-harness/` heavy hybrid run in the same target project unless the user explicitly wants to reuse that directory.
3. Check that `pi` is available before a live run.
4. If `verification_command` starts with `npm`, require a local `package.json` after Qwen runs; parent-package npm walkup is failure.
5. Do not read or summarize `.qwen-autonomous/runs/*/pi.stdout.jsonl`.

## Plan

State that this will use autonomous-lite:

- Codex writes a compact task/verification contract.
- Local Qwen runs inside the target project cwd.
- Qwen implements, tests, and repairs internally.
- Codex validates only `evidence.json` and the verification command.

## Commands

Prefer the MCP tool when available:

```text
codex_harness_autonomous_run
```

Use parameters equivalent to:

```json
{
  "project": "PROJECT_PATH",
  "task": "TASK_TEXT",
  "taskFile": "TASK_FILE",
  "verificationCommand": ["npm", "test"],
  "minTests": 20
}
```

If MCP is not available, use CLI fallback:

```bash
qwen-harness-codex autonomous-run \
  --project PROJECT_PATH \
  --task-file TASK_FILE \
  --min-tests 20 \
  --verification-command npm test
```

For an inline task:

```bash
qwen-harness-codex autonomous-run \
  --project PROJECT_PATH \
  --task "TASK_TEXT" \
  --min-tests 20 \
  --verification-command npm test
```

## Verification

After the run:

1. Read only:
   - `PROJECT_PATH/evidence.json`
   - `PROJECT_PATH/.qwen-autonomous/latest.json`
   - verification stdout/stderr logs if needed
2. Run or rely on `autonomous-validate`:

```bash
qwen-harness-codex autonomous-validate \
  --project PROJECT_PATH \
  --min-tests 20 \
  --verification-command npm test
```

3. Reject:
   - missing `evidence.json`
   - `status` not `passed`
   - zero tests
   - failed verification command
   - changed files outside target project

## Summary

Report:

- project path
- status
- verification command
- parsed test count
- evidence path
- whether repair attempts were used
- remaining risks

## Next Steps

If validation fails, run one autonomous repair if available. If it still fails or output quality is weak, recommend switching to `/heavy-harness`.
