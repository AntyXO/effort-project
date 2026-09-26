# Automatic routing handoff

Checkpoint: September 26, 2026. The owner requested publishing this prototype so another developer can continue. This is unfinished integration work, not a release claiming universal automatic control.

## Implemented

- `src/automatic.mjs`: local prompt/repository rules, per-conversation context, supported-effort bounds, fixed pins, and two-request downgrade hysteresis. No prompt history is saved.
- `src/integrations/opencode.mjs`: native OpenCode hooks apply advertised effort variants before requests, preserve explicit settings, and reuse decisions across tool steps. `effort config opencode` prints the installation wrapper.
- `src/integrations/managed-chat.mjs`: automatic resumable conversations using existing adapters. `effort auto claude` exposes a text interface with `/new` and `/quit`; it is not the native Claude UI.
- `src/integrations/codex-routing.mjs`: capability-aware `turn/start` rewriting, including collaboration-mode precedence and optional explicit model tables.
- `src/integrations/codex-remote.mjs`: experimental private loopback transport for the official Codex terminal. The `ws` dependency is intentionally not installed or declared yet; the launcher reports this and stops before starting a provider.

The default keeps the selected model. Managed Claude and the Codex prototype accept an explicit effort-to-model table. Existing desktop conversations remain outside the automatic integrations. The website and MCP tools remain advisory.

## Verified checkpoint

- `npm test`: 154 passed locally, zero failures or skips, on macOS / Node 24.16.0.
- `npm run check`: 30 JavaScript files passed syntax checks.
- `npm run smoke:package`: temporary offline package installation, CLI, automatic dry-run, OpenCode import, MCP, and dashboard checks passed.
- Capability-reporting changes subsequently passed the four interface tests and syntax checks.
- No billed provider calls were made for the new automatic integrations. Codex transport tests use real loopback HTTP and fixture subprocesses but **mock WebSocket framing**. Historical live adapter tests are separate evidence.

## Continue here

1. Decide whether to add `ws` for the Codex transport. The local working agreement required approval for a new dependency; that approval was not received before this handoff. Publishing this checkpoint did not authorize installing it.
2. If adding it, update `package.json`, a lockfile, CI dependency installation, the offline package smoke procedure, and the zero-dependency wording together. The smoke test currently asserts zero dependencies and uses a fresh empty npm cache. Keep offline reproducibility meaningful rather than silently fetching packages during that check.
3. Test actual WebSocket framing and an official Codex terminal handshake without submitting a model task first. Check authentication, protocol ordering, collaboration modes, cancellation during startup/discovery, and cleanup. Mock transport tests do not replace this acceptance step.
4. Perform explicit, bounded live acceptance for each supported integration in disposable projects. OpenCode hook behavior and the Claude text session still need native acceptance. Distinguish request settings from provider-confirmed settings and from answer quality.
5. Update the pending statements in `README.md`, `docs/automatic.md`, `docs/architecture.md`, `docs/validation.md`, and the transport's missing-dependency message only when supported by evidence. Do not claim desktop attachment or proven token/cost savings.

Run commands from the repository root with Node 22 or later. Ordinary tests use fake providers; no account credentials or global provider configuration should be needed. See [automatic setup](automatic.md) for usage, boundaries, and upstream source links.
