# Codex adapter

This adapter controls new turns in a Codex conversation that Effort Project manages. It launches the installed `codex app-server --listen stdio://`, sends newline-delimited JSON on stdin, and reads the protocol on stdout. It does not control an active Codex desktop conversation or change an already-running model request.

## Effort and conversation control

Each call to `run` performs the initialization handshake, starts or resumes a thread, checks the resolved model against `model/list`, and submits `turn/start` with an explicit `effort`. The adapter exposes `low`, `medium`, and `high`; it also checks that the chosen model advertises the requested level. Unsupported levels, unknown model capabilities, and an explicitly requested model resolving to a different model stop execution before a model turn starts. A reported service-side model reroute blocks the run.

Omitting `model` uses Codex's resolved model for the new or resumed thread. There is no fallback model. The adapter's `sessionId` is the provider's **thread ID** (`thread.id`), used by `thread/resume`; it is deliberately not the newer provider `thread.sessionId`, which can identify a tree of conversations. Resume excludes old turns from its response to avoid loading the transcript into this process.

`effortEvidence.accepted` becomes true only after the server acknowledges `turn/start`. It establishes that the explicit effort request was accepted, not how much internal reasoning occurred. A metadata read after successful completion records `configuredEffort` when available and rejects a mismatching value. Older servers may omit this readback. `requestedEffort` remains the requested value even if the request failed.

## Permissions and lifecycle

- The default is Codex's `read-only` sandbox. `allowWrite: true` explicitly selects `workspace-write`; the turn's writable roots contain the canonical working directory, automatic temporary-directory write roots are excluded, and sandboxed network access remains disabled.
- Both thread and turn use `untrusted` for read-only runs. Explicit `allowWrite: true` uses `on-request` inside the constrained workspace sandbox so ordinary authorized workspace edits can proceed. Both modes retain the `user` reviewer, and the thread response must confirm the requested policy and sandbox type. The adapter does not grant any approval request, session-wide permissions, policy amendment, or additional filesystem/network permission. Any actual approval, escalation, or user-input request returns `blocked`; review the task in Codex before proceeding.
- These are the provider's native sandbox and approval controls, not a sandbox around the entire CLI or arbitrary configured external integrations. Existing provider authentication and configuration remain under the user's control.
- Prompts are sent through stdin with `shell: false`, never through shell interpolation or command-line arguments. The adapter does not edit provider configuration or write transcripts. Codex itself persists its normal session and runtime data; users should account for their Codex configuration and logging policy.
- Programmatic callers can provide an explicit executable shim with `executable: process.execPath` and `executableArgs: ['/absolute/path/to/codex-entry.mjs']`. The argument array is validated and passed literally before the app-server arguments. Its default is empty, so normal CLI invocation is unchanged. This also lets deterministic tests run Node fixtures without POSIX shebang execution.
- Timeout and abort request `turn/interrupt` when a managed turn ID is available, close stdin, and terminate the owned process group on POSIX. Windows has a `taskkill /T` cleanup path but has not been runtime-tested here. The adapter never sends an interrupt for a different observed thread or turn.
- Raw provider error text and stderr are not forwarded because they can contain credentials. Fixed diagnostics distinguish missing CLI, protocol errors, permission blocks, timeouts, and model/effort mismatches.
- Retained message text is bounded at 256 KiB, individual protocol frames at 2 MiB, and the stdout stream at 32 MiB. Exceeding a limit stops the run. Diagnostic callbacks are capped at 2,000 events per call; exceptions in an observer do not strand the child process.

## Usage accounting

`costUsd` is null: this protocol does not supply a reliable per-turn dollar charge. Token fields use the difference between provider thread totals before and after the managed turn. The baseline is zero for a new thread. For a resumed thread, the adapter uses a token-usage notification delivered before submitting the new turn. If no trustworthy pre-turn baseline arrives, token fields remain null and a diagnostic explains why. The last model-response usage is not treated as total turn usage, and cumulative session tokens are not charged to a single resumed turn.

Final messages are assembled from completed `agentMessage` items, deduplicated by item ID. When phase metadata is present, `final_answer` messages are preferred over commentary. Completion and usage notifications must match both the managed thread and turn IDs.

## Verification and compatibility boundary

Implementation references checked on 2026-09-26:

- Local `codex-cli 0.153.4` help and schemas generated by `codex app-server generate-json-schema`. In that version, thread sandbox values are `read-only` / `workspace-write`, the turn sandbox uses `readOnly` / `workspaceWrite`, and supported approval policies include `untrusted` and `on-request`. The implementation follows these generated values; documentation examples can differ.
- [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server), including initialization, model discovery, thread resume, turn effort overrides, approvals, and interruption.

The deterministic test suite uses temporary JSONL fixtures launched through the current Node executable without provider credentials. It checks effort and sandbox requests, model capability pagination, resume, token baselines, event identity and ordering, approval denial, malformed and excessive output, error redaction, timeouts, cancellation, executable-argument validation, and POSIX descendant cleanup. These tests validate the client and its protocol handling; they do not establish live account access, model quality, cost savings, or compatibility with every Codex version. Implementation verification used Node 24; the source targets Node 22+ built-in APIs. No third-party runtime dependencies are required.

Run the adapter tests with `node --test test/codex.test.mjs` from the package directory.

## Bounded live acceptance test for a maintainer

Use a disposable repository and an isolated Codex runtime prepared through normal provider authentication. Do not copy credentials into repository fixtures or record them in artifacts. Keep the model fixed and use an available model whose advertised levels include both low and high.

1. Run a short read-only turn at `low` asking it to remember a unique marker and return one short sentence. Record the returned thread ID, effort evidence, outcome, and reported usage.
2. Resume that exact ID at `high` and ask for the marker. Confirm the ID is preserved, the response recalls the marker, and effort evidence identifies the second turn and requested level.
3. In a separate disposable directory, test an intentional write request with the default `allowWrite: false`, checking that the file is absent after the run. Repeat with explicit `allowWrite: true`; the native approval policy can still require user review, in which case the correct result is `blocked` rather than an automatic approval.
4. Start a bounded task and abort it; verify that the owned CLI and any child tools have exited. Hash protected fixtures and the provider configuration before and after if checking isolation.

Record CLI version, Node version, OS, model, request fields, response evidence, and observable outcomes. A successful run supports that particular compatibility combination. It does not prove that higher effort improved reasoning or that routing reduced cost. The open-source app can be free while provider model access remains governed by the user's existing subscription or API billing.
