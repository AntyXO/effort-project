# Architecture and next experiments

The first release has five small components: a deterministic policy, provider adapters, a verification-driven runner, a local metadata store, and two interfaces (CLI/dashboard and advisory MCP). No model is trained. There is no background watcher or global effort override.

1. Collect bounded metadata from the selected workspace without reading file contents or following symlinks. Prompt features stay local until a managed run sends the prompt to the chosen provider.
2. Recommend low/medium/high using visible rules. Unknown tasks start at medium. Respect explicit bounds and provider capabilities.
3. Start a provider turn with a real effort parameter. Capture completion and supported usage fields.
4. Run the user's explicit verification command, if any. Without one, label completion unverified.
5. Stop on access, permission, environment, timeout, or unknown failures. Recognized failed tests can prompt a focused retry. Repeated matching failures can increase effort on a resumed turn, within total-time and attempt limits.
6. Save decisions and coarse outcomes, never task text. A stopped turn is not automatically a successful task.

Retries are sequential and operate on the same workspace. Effort does not reset, clean, stash, commit, push or revert changes. A user should inspect the final diff, including after failed runs. The initial heuristic is English-oriented; uncertain or unsupported language/task phrasing falls back conservatively and is not a validated multilingual classifier.

The current mechanism is adaptive across managed attempts. It does not change a model request mid-generation. It does not classify every internal tool result in real time. Work toward finer control must use provider-supported boundaries and verified effort readback.

The experimental automatic layer adds a bounded, in-memory per-conversation router. It preserves effort on ambiguous continuations, requires two clearly simpler prompts before downgrading, and selects only supported levels within explicit bounds. No prompt is retained in routing history. Model switching requires an explicit effort-to-model table and is available only in the managed-chat and Codex terminal paths.

OpenCode hooks capture the user prompt and apply an existing model variant before provider execution. Managed chat reuses the current adapters and their provider session IDs. The Codex prototype transparently routes the official terminal's app-server messages and rewrites eligible `turn/start` requests after capability discovery. The WebSocket dependency and native terminal acceptance are pending; this route is not a desktop integration. The dashboard and MCP server keep their existing advisory/read-only boundaries. [Automatic integration details](automatic.md) describe permissions, session lifetime, evidence, and limitations.

## Evaluate before learning

Use fixed medium, fixed high, prompt-only rules, and medium-with-escalation as initial baselines. Use identical clean repository snapshots, fixed model/harness versions, independently assessed outcomes, random execution order, and repeated runs. Count the cost of failures and retries. Predefine the acceptable quality difference and report uncertainty; a small pilot cannot establish quality equivalence.

At matched failing states, compare continuing at the current effort with escalating. This tests whether a signal predicts benefit from more effort. Training should follow evidence from such comparisons. Do not turn a quick high-effort success into a label claiming lower effort would have worked, or a failed low-effort run into proof that more effort would fix it.

Roadmap: measured failure signatures; broader version compatibility; controlled benchmark corpus; supported finer-grained adapters; only then learned policies and optional personalization. All remain proposals until implemented and validated.
