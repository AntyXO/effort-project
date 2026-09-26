# Internal adapter contract

Node.js 22+, native ESM, no runtime dependencies. Each module exports `capabilities` and `run(options)`.

`capabilities = { id, name, levels: ['low','medium','high'], control: 'managed-turns', notes: string }`.

`run({ prompt, cwd, effort, model, sessionId, allowWrite = false, timeoutMs = 120000, signal, onEvent = () => {}, env = process.env, executable, executableArgs = [] })` returns `{ provider, sessionId, requestedEffort, effortEvidence, text, usage, status }`. An explicit Node-backed shim can use `executable: process.execPath` and `executableArgs: [absoluteCliScript]`; no shell is used.

`status` is `completed`, `failed`, `blocked`, or `cancelled`. `effortEvidence` describes observable control (for example `launch-flag`, `turn-request`); never claim to measure internal reasoning. `usage` has `inputTokens`, `outputTokens`, `cachedInputTokens`, `costUsd` when reported, otherwise null. Do not silently substitute models or unsupported effort levels. Validate effort. Use spawn with `shell: false` and provide prompts over stdin where possible. Bound retained output, clean up on timeout/abort, propagate errors without leaking credentials.

Use read-only operation by default. Explicit `allowWrite` may enable the provider's normal constrained coding mode; never disable its sandbox or bypass permission checks. Do not rewrite the user's provider configuration. Existing account login is handled by the provider CLI. Do not run paid/live calls while implementing; the coordinator will run bounded live tests in isolated fixtures.

Each `run` is a complete provider turn. The coordinator verifies the result and may resume `sessionId` at a different effort for the next turn. Do not pretend this changes a request already in flight, or controls another desktop application's active chat.

`onEvent` receives provider-neutral diagnostic objects `{type, ...}`. Do not log raw text to disk. Tests should mock CLI processes/protocol using temporary executables with no provider credentials.
