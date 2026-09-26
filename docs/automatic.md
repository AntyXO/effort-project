# Automatic effort routing

This experimental integration chooses effort locally before each submitted user prompt. It uses the prompt, bounded repository metadata, the previous routing decision, and the host's supported controls. It makes no classifier API call and writes no prompt history. It does not establish the minimum effort needed for a correct answer or promise token savings.

## Supported surfaces

| Surface | Automatic behavior | Limit |
| --- | --- | --- |
| OpenCode native plugin | Applies an advertised model variant before sending requests; reuses the choice across that prompt's tool steps | Explicit variants/configuration win. Only supported reasoning models and configured primary agents are routed. Model stays unchanged. |
| Claude Code through `effort auto claude` | Chooses effort for each prompt and resumes the same Claude conversation | Uses Effort's text interface and the existing restricted CLI adapter. Does not attach to the stock Claude terminal or desktop UI. Applied internal effort is not observable. |
| Codex through `effort auto codex` | Routes `turn/start` through a local connection to the normal Codex terminal UI | Experimental source transport requires the `ws` package; dependency installation and actual terminal acceptance remain pending. Does not attach to Codex desktop. |
| Other MCP hosts | Recommendations through the existing MCP tools | MCP tools do not control the host's active model or effort. |

The ordinary website remains a local recommendation and run-history dashboard. Opening it does not enable background access to other applications.

## Claude Code

With an installed, signed-in Claude Code CLI:

```sh
node bin/effort.mjs auto claude --cwd /path/to/project
```

Enter one prompt per line. `/new` starts a fresh conversation and resets routing history; `/quit` exits; Ctrl+C cancels the session. Each subsequent prompt resumes the same provider session. Failed, cancelled, or discontinuous turns require `/new`; no prompt is automatically replayed. Responses are marked **unverified** because no independent acceptance check is run by this interface.

The adapter defaults to read-only access, a 120-second limit per prompt, and low/medium/high effort. `--allow-write` permits the adapter's restricted file-edit tools; it does not grant a general shell. Existing managed-adapter isolation applies, including disabled custom hooks/MCP connections. See [Claude adapter](claude-adapter.md). This is not a replacement for every native Claude Code feature.

Use `--effort medium` to pin effort, `--model YOUR_MODEL_ID` to pin the model, or `--max-effort medium` to cap automatic effort. `--timeout 180` changes the per-prompt time limit. `--dry-run` validates and prints configuration without opening a provider session.

## OpenCode plugin

Generate a local module using the installed Effort path:

```sh
node bin/effort.mjs config opencode
```

Create a new `.opencode/plugins/effort.mjs` in the chosen project and paste the printed single export. Preserve existing plugins and config. OpenCode loads this project plugin on the next session. Effort does not write global settings. Regenerate the module if you move the Effort installation; remove that one module to disable the integration.

For custom bounds, use a wrapper exporting only one initializer:

```js
import { createEffortPlugin } from 'file:///absolute/path/effort-project/src/integrations/opencode.mjs';
export default createEffortPlugin({
  minEffort: 'low',
  maxEffort: 'high',
  agents: ['build', 'plan'],
});
```

Do not point OpenCode directly at the implementation module containing both the factory and default export: some plugin loaders call every exported function. The generated wrapper avoids that ambiguity.

Clear any explicitly selected variant to let automatic routing operate. A manual variant or explicit effort setting in model, provider, or agent configuration takes precedence. The plugin uses actual `model.variants` option objects, including nested provider controls, rather than guessing provider parameter names. Unsupported or unknown shapes remain unchanged. Internal/title/compaction agents are skipped. Errors leave the original request intact.

OpenCode's local structured log identifies request-option changes with `service: effort-project`, the model and selected effort. `providerAccepted: null` means acceptance was not independently observed. Pending prompt text is bounded, held only until the matching request hook or expiry, then discarded; session state contains decisions only.

## Codex terminal prototype

The source launcher connects the official terminal UI to a private, single-client WebSocket router on `127.0.0.1`. A random bearer token is passed through the child environment. Browser origins, other hosts, unauthenticated connections, and extra clients are rejected. App-server messages use local stdio behind the router. Tokens, prompts, and provider stderr are not logged.

```sh
node bin/effort.mjs auto codex --cwd /path/to/project --dry-run
# After the WebSocket dependency and terminal integration are enabled:
node bin/effort.mjs auto codex --cwd /path/to/project
```

The router discovers `model/list` capabilities and sets `turn/start.effort`, including the effort field inside collaboration-mode settings when present. Only bounded text-only prompts are classified. Attachments, unknown protocol shapes, unavailable capability discovery, or unsupported settings preserve the native request and report why. The native selected effort is overridden in automatic mode; launch with `--effort high` for a fixed pin, or start ordinary Codex to disable Effort.

The chosen model stays unchanged unless `--model` or an explicit routing table requests a change. Approval requests, approval responses, sandbox policies, and unrelated protocol messages pass through. The official terminal UI owns permissions and cancellation; `--allow-write` and Effort's managed timeout flag are rejected for this mode. The router never approves requests on the user's behalf.

## Optional model routing

Automatic model switching is disabled by default. For managed Claude sessions or the Codex terminal prototype, create a JSON file with exact model IDs you intend to use:

```json
{
  "minEffort": "low",
  "maxEffort": "high",
  "models": {
    "low": "YOUR_SMALL_MODEL_ID",
    "medium": "YOUR_DEFAULT_MODEL_ID",
    "high": "YOUR_COMPLEX_TASK_MODEL_ID"
  }
}
```

Pass `--routing-config /path/to/routing.json`. CLI bounds override file bounds. A fixed `--model` overrides the table. Missing table entries retain the current model. The table selects within the same host/provider workflow; it does not move conversations between companies or choose paid accounts. Codex checks discovered capabilities; Claude validates through the existing adapter and can reject an unavailable/unsupported model without substituting one.

Model IDs are configuration, not executable commands. Effort does not download models or edit account settings. Changing models can change billing and invalidate caches. Use a routing table only for models you have deliberately chosen.

## Policy and evidence

Short mechanical requests can start at low, uncertain tasks at medium, and investigation or costly error risks at high. Broad affected-file metadata can raise effort. A narrow spelling correction is not raised solely because its repository contains several languages. Short ambiguous followups preserve the previous level. Two successive clearly simpler requests allow a downgrade, reducing setting churn. Explicit pins and bounds win over recommendations; bounds can therefore limit effort even for complex work.

This is an English-oriented rules policy. It does not read the entire conversation, inspect repository source contents, route every internal tool result, or learn from provider outputs. Lower settings, fewer output tokens, and successful protocol tests do not prove equal quality or lower total cost. Most Claude models can lose conversation cache reuse when effort changes, and model changes have separate caches; the conservative downgrade rule is a mitigation, not a cost model.

Offline tests cover policy decisions, continuation handling, overrides, native-shaped host contracts, session separation, resumed managed turns, request-option application, malformed inputs, and configuration generation. OpenCode native execution and the new Claude interactive workflow have not been tested with billed model requests. Older adapter live tests do not establish acceptance of these new integrations. See [validation](validation.md).

Source contracts checked on September 26, 2026: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks#userpromptsubmit-decision-control), [Claude runtime configuration](https://code.claude.com/docs/en/agent-sdk/configuration#change-configuration-mid-session), [Claude prompt caching](https://code.claude.com/docs/en/prompt-caching#changing-effort-level), and [OpenCode v1.18.32 plugin contract](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/plugin/src/index.ts).
