# Codex Qwen Harness Marketplace

Local Codex plugin marketplace for `qwen-harness-codex`.

Current stable plugin version: `0.1.0+codex.20260528074840`.

This marketplace intentionally publishes the MCP-compatible stable bundle with
9 qwen harness tools. Run the verification script before pushing changes so a
broken bundle does not become the latest install target.

The plugin exposes two mode-selecting slash commands:

- `/autonomous-run` — token-saving mode. Local Qwen implements, tests, repairs,
  and writes compact evidence; Codex validates only evidence and tests.
- `/heavy-harness` — assurance-oriented mode. Codex owns design, package
  verification, corrections, and final gate while Qwen implements packages.

## Install

```bash
git clone https://github.com/Julirsia/codex-qwen-harness-marketplace.git
codex plugin marketplace add ./codex-qwen-harness-marketplace
codex plugin add qwen-harness-codex@julirsia
```

The marketplace manifest lives at `.agents/plugins/marketplace.json`, which is
the layout Codex expects for a marketplace root.

## Runtime Requirements

- Codex CLI and Codex desktop/plugin support.
- Node.js available as `node`.
- Pi CLI available as `pi` for live local-worker runs.
- llama-swap or an OpenAI-compatible local provider exposing the required Qwen models.

Default model routing:

- Implementation/correction: `llama-local/qwen36-27b-mtp-iq4xs`
- Scout/review: `llama-local/qwen36-35b-a3b-iq4xs`

Model switching is allowed by default so the role's intended model is used. Use
`--disallow-model-switch` only for diagnostic runs that must not evict the active model.

## Smoke Test

```bash
node scripts/verify-qwen-harness-marketplace.mjs

node plugins/qwen-harness-codex/scripts/qwen-harness-codex.mjs autonomous-run \
  --project /tmp/qwen-autonomous-demo \
  --task "Build a tiny Node project with npm test and compact evidence." \
  --dry-run \
  --verification-command npm test

node plugins/qwen-harness-codex/scripts/qwen-harness-codex.mjs model-health \
  --provider-url http://127.0.0.1:8080 \
  --model llama-local/qwen36-27b-mtp-iq4xs \
  --provider-probe
```
