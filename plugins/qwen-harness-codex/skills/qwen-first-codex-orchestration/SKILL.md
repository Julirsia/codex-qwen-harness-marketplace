---
name: qwen-first-codex-orchestration
description: Use when the user wants a Codex-native Qwen harness run, including heavy hybrid-run orchestration or autonomous-lite mode where local Qwen implements, tests, and repairs while Codex validates compact evidence only.
---

# Qwen First Codex Orchestration

Use this skill when the user asks for `hybrid-run`, `qwen-first`, `autonomous-run`, `autonomous-lite`, local Qwen implementation, token-saving delegation, or Pi/Qwen-backed implementation.

For explicit mode selection, prefer the narrower skills:

- `qwen-autonomous-lite` for autonomous-run / Codex-judges-only / token-saving mode.
- `qwen-heavy-harness` for heavy hybrid-run / final-gate / assurance mode.

The plugin also exposes slash commands:

- `/autonomous-run`
- `/heavy-harness`

## Ownership Model

Codex native owns the parent hybrid-run state machine and all design/review/final gates.

Pi is only the transport used to launch local Qwen worker sessions.

Local Qwen workers perform scout, bounded implementation, test loops, repair loops, and evidence drafts.

Codex must not directly mutate product files during an active hybrid-run.

Codex should create implementation packages and correction packages, then invoke Qwen workers through the harness.

## Heavy Hybrid Flow

1. Run scout through a local Qwen worker via Pi.
2. Have Codex write requirements, design, design grill, decisions, and implementation packages in `.qwen-harness/`.
3. Have Codex review the plan. Only `READY` allows implementation.
4. Run each implementation package through a local Qwen worker.
5. Have Codex verify package evidence.
6. If verification fails, have Codex create a correction package and run a Qwen repair worker.
7. Repeat verification and correction until package evidence passes or escalation is required.
8. Run the final proof gate. Only Codex may decide `goalAchieved`.

## Autonomous Lite Flow

Use this mode when the priority is Codex token reduction and the task can be expressed as a clear executable contract.

1. Codex provides a concise task/spec and verification contract.
2. The harness creates `.qwen-autonomous/` in the target project.
3. Pi launches local Qwen with cwd fixed to the target project directory.
4. Qwen implements, runs tests, repairs internally, and writes compact `evidence.json`.
5. Codex validates only `evidence.json` plus the configured verification command output.
6. If validation fails, Qwen receives a compact validation summary for repair; Codex does not read full worker logs.
7. In MCP usage, run detached and poll compact job status so Codex does not wait on or ingest long worker output.

## Hard Rules

- Active state belongs in `.qwen-harness/`.
- Autonomous-lite state belongs in `.qwen-autonomous/`.
- Do not create `.codex-harness/` or use `.pi-harness/` as Codex-native active state.
- Do not let Pi own frontier design, package verification, final approval, or goal-achieved judgment.
- Do not treat smoke-only output as behavioral acceptance evidence.
- Do not accept worker self-report without source evidence, runtime evidence, adversarial probes, reentry probes where needed, and residual gap notes.
- Do not directly edit product source/test/config during an active hybrid-run.
- In autonomous-lite mode, use compact evidence, job status, and verification logs only.
- Prefer detached autonomous jobs and watchdog termination once compact evidence plus verification pass.
- Use the runner's compact Pi stdout summary; do not buffer full stdout into Codex context.
- Reject zero-test success and parent-package npm walkups.

## Commands

```bash
qwen-harness-codex hybrid-run --task "..." --verification-command npm test
qwen-harness-codex hybrid-status
qwen-harness-codex worker --package P001 --live
qwen-harness-codex verify-package --package P001
qwen-harness-codex create-correction --package P001 --review .qwen-harness/verification/P001-review.md
qwen-harness-codex final-gate

qwen-harness-codex autonomous-run \
  --project projects/example \
  --task-file task.md \
  --detached \
  --min-tests 20 \
  --verification-command npm test

qwen-harness-codex autonomous-status \
  --project projects/example

qwen-harness-codex autonomous-validate \
  --project projects/example \
  --min-tests 20 \
  --verification-command npm test
```
