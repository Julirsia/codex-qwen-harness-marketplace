---
name: qwen-first-codex-orchestration
description: Use when the user wants a Codex-native hybrid run where Codex owns design/review/final gates and Pi launches local Qwen workers for scout, implementation, tests, repairs, and evidence drafts.
---

# Qwen First Codex Orchestration

Use this skill when the user asks for `hybrid-run`, `qwen-first`, local Qwen implementation, token-saving delegation, or Pi/Qwen-backed implementation.

## Ownership Model

Codex native owns the parent hybrid-run state machine and all design/review/final gates.

Pi is only the transport used to launch local Qwen worker sessions.

Local Qwen workers perform scout, bounded implementation, test loops, repair loops, and evidence drafts.

Codex must not directly mutate product files during an active hybrid-run.

Codex should create implementation packages and correction packages, then invoke Qwen workers through the harness.

## Required Flow

1. Run scout through a local Qwen worker via Pi.
2. Have Codex write requirements, design, design grill, decisions, and implementation packages in `.qwen-harness/`.
3. Have Codex review the plan. Only `READY` allows implementation.
4. Run each implementation package through a local Qwen worker.
5. Have Codex verify package evidence.
6. If verification fails, have Codex create a correction package and run a Qwen repair worker.
7. Repeat verification and correction until package evidence passes or escalation is required.
8. Run the final proof gate. Only Codex may decide `goalAchieved`.

## Hard Rules

- Active state belongs in `.qwen-harness/`.
- Do not create `.codex-harness/` or use `.pi-harness/` as Codex-native active state.
- Do not let Pi own frontier design, package verification, final approval, or goal-achieved judgment.
- Do not treat smoke-only output as behavioral acceptance evidence.
- Do not accept worker self-report without source evidence, runtime evidence, adversarial probes, reentry probes where needed, and residual gap notes.
- Do not directly edit product source/test/config during an active hybrid-run.

## Commands

```bash
qwen-harness-codex hybrid-run --task "..." --verification-command npm test
qwen-harness-codex hybrid-status
qwen-harness-codex worker --package P001 --live
qwen-harness-codex verify-package --package P001
qwen-harness-codex create-correction --package P001 --review .qwen-harness/verification/P001-review.md
qwen-harness-codex final-gate
```
