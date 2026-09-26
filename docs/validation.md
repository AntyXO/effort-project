# Validation record

Release: **0.1.0 experimental**, checked September 26, 2026. Development host: macOS, Node 24.16.0. This is a functional acceptance record, not a study of coding quality or cost savings.

## Deterministic acceptance

The release suite covers the policy and its uncertainty, effort caps, repeated-failure recovery, environment/authentication stops, session preservation, unsupported models, approval denial, malformed and excessive provider output, subprocess timeout/abort cleanup, usage accounting, private metadata boundaries, MCP negotiation/calls/termination, and dashboard authentication/Host/Origin checks.

On the development host, **70 tests passed, with zero failures or skips**. The JavaScript syntax check also passed.

Run `npm test` and `npm run check`. Ordinary tests use fake providers and temporary fixtures, make no paid model calls, and do not modify provider configuration. The public [CI workflow](https://github.com/AntyXO/effort-project/actions/workflows/ci.yml) runs Node 22 and 24 on Linux, macOS, and Windows; refer to the actual run for platform results. POSIX-only process-group assertions are explicitly skipped on Windows.

Independent review found and corrected four defects before publication: surviving verifier descendants; unstable failure signatures caused by test timing output; swallowed MCP termination signals; and hidden provider diagnostics. Real repeated failing Node tests now produce the same signature. Verification removes node:test's inherited nesting marker so the requested child tests actually execute.

## Live provider checks

| Check | Version/model | Evidence and limit |
| --- | --- | --- |
| Codex new turn at low, resume at high | CLI 0.153.4, gpt-6-astra | Both completed in the same thread and recalled a marker. The app-server accepted explicit effort and thread readback matched low/high. This confirms configuration, not internal reasoning quality. |
| Claude new turn at low, resume at high | CLI 2.1.282, claude-opus-5-5[1m] | Both completed in the same session and recalled a marker. Launch flag plus child environment requested low/high. Applied internal effort is not observable; organization caps can apply. |
| Codex constrained file repair | Same Codex version/model, low | Corrected addition in a disposable sum module on the first attempt. Independent positive/negative/zero checks passed. The verifier file stayed byte-identical. |
| Claude restricted file repair | Same Claude version/model, low | Corrected addition in a disposable sum module. Independent positive/negative/zero checks passed. The verifier file stayed byte-identical. |

An unadvertised Codex model was rejected before a model task, as intended. Initial integration tests also exposed two Claude compatibility issues: a native built-in plugin descriptor and missing OS identity environment variables needed for macOS Keychain. Both were corrected with regression tests. No credentials were printed or published.

The first Codex edit check stopped at an approval request. Explicitly authorized write runs now use the provider's workspace-write sandbox with its on-request approval policy; approval requests themselves are still denied. The revised edit check passed within the disposable workspace, with network access disabled.

Provider tests used disposable workspaces. Codex used a separate local runtime directory. The user's existing Codex config.toml and Claude settings.json retained their original hashes. Claude retains its own normal transcripts for session resume; Effort's metadata store does not retain task prompts or responses.

## Interface checks

The actual local dashboard was inspected in a browser: real empty/history states, high and low recommendations, keyboard submit, copy buttons, reload/session retention, 390px layout without horizontal overflow, dialogs and focus return, filtering, zero versus missing usage, untrusted strings rendered as text, and authentication/offline behavior. No browser console errors were observed. Full screen-reader testing was not performed.

MCP was tested through the packaged command entry point with initialization, tool discovery and calls. This establishes stdio protocol behavior. It does not establish installation into every desktop app, nor automatic effort control of a host conversation.

A 10,000-call microbenchmark of the local rules on two short prompts measured p95 below 0.001 ms and maximum below 0.5 ms on this host. It excludes process startup, repository metadata scanning, provider startup and inference. It is not an end-to-end latency guarantee.

## What remains unproven

- Equal coding quality at lower total cost, or reduced user intervention.
- A calibrated difficulty predictor, multilingual task classification, or personalization.
- Native in-flight effort changes inside Codex/Claude desktop chats.
- Live provider compatibility on Windows/Linux, other provider/CLI versions, or every account/organization policy.
- A universal spending cap. Unknown/cumulative usage is not treated as zero or summed as per-turn usage.

The next research step is a controlled held-out task benchmark, described in [architecture.md](architecture.md). These limitations are visible in the product and README; no savings percentage is advertised.
