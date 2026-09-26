# The Effort Project

**Spend reasoning where it helps. Understand every decision.**

Effort is a free, local tool that recommends reasoning levels, runs coding tasks through supported agent CLIs, checks their results, and can raise effort on a later attempt when the same check keeps failing. A local dashboard shows what happened. MCP tools bring recommendations into compatible desktop apps.

**Status: experimental 0.1.0.** This is a transparent rules controller, not a trained predictor. It has not demonstrated lower cost at equivalent coding quality. See [validation](docs/validation.md) for what was actually tested. Provider subscriptions or API usage are separate; the software is free.

## What works where

| Surface | Effort can do | Boundary |
| --- | --- | --- |
| Codex CLI | Launch/resume managed tasks with explicit effort per turn | Changes apply at managed turn boundaries; no control of unrelated sessions |
| Claude Code CLI | Launch/resume with explicit effort per invocation | Provider policy can constrain effort; no measurement of internal reasoning |
| Codex desktop app | Offer recommendations via local MCP | Cannot automatically change the active conversation's effort |
| Claude desktop / Code app | Offer recommendations if that surface supports local MCP | Host setup and capability vary; no claim of universal native control |
| Other AI tools | Portable advisory MCP tools | Requires a local stdio MCP host; no adapter or effort mapping is assumed |

The controller does not modify provider settings files, inject `think harder` as a substitute for a real effort parameter, or interrupt an in-flight model request to change effort. It does not learn required effort from noisy success/failure labels.

## Try it

Requires Node.js 22 or later. There are **zero npm dependencies** and no install hooks. Managed runs additionally require an installed and signed-in Codex or Claude Code CLI.

```sh
git clone https://github.com/AntyXO/effort-project.git
cd effort-project
node bin/effort.mjs doctor
node bin/effort.mjs recommend "Investigate an intermittent race condition" --provider codex
node bin/effort.mjs dashboard
```

Open the local URL printed by `dashboard`. Its fragment contains an access token. The dashboard only recommends effort and reads local run metadata; it cannot launch commands. Empty history is intentional until you run a task.

Optional command installation from the downloaded source:

```sh
npm install --global .
effort --help
```

Uninstall with `npm uninstall --global @antyxo/effort-project`. Local metadata stays in `~/.effort-project` unless `EFFORT_DATA_DIR` changes it. Remove that directory yourself if you want to delete your history. Remove any MCP entry you added separately.

## Run a task

Start with a disposable project or a reviewed working tree. Without `--allow-write`, the adapter operates in its documented read-only mode.

```sh
effort run "Explain the queue implementation" --provider codex --cwd /path/to/project
```

This is marked **unverified** because no independent check was provided. Effort does not equate a model's completion message with correctness.

To permit constrained code edits and check a Node project:

```sh
effort run "Fix the failing sum test" --provider codex --cwd /path/to/project \
  --allow-write --verify '["node","--test"]' --max-attempts 3 --timeout 180
```

Use `--provider claude` for Claude Code. Its adapter allows restricted file edits; it does not give the model a general shell. The verification command runs separately.

**Verification is a local executable and argument array, not a shell string. It runs with your normal user privileges, outside the provider sandbox. Only supply commands you trust.** On shells with different quoting rules, pass the JSON array with that shell's standard quoting. `--prompt-file path` avoids long prompt arguments. `--dry-run` prints a plan without starting a provider.

The defaults are three attempts, 120 seconds total, and a `high` ceiling. Use `--effort low` to override the initial recommendation, `--max-effort medium` to set a lower ceiling, or `--model` to choose a model explicitly. Supported levels are checked by adapters; an unsupported model/effort is not silently replaced. There is no universal dollar cap: timeout, attempt, and effort bounds limit activity, but do not guarantee a final bill.

The first recognized test failure can trigger another attempt at the same effort. Repeated matching failures can raise effort for the next managed turn. Access, permission, missing dependency, timeout, and unclassified failures stop instead. Passing the selected check means **that check passed**, not that all requirements are satisfied. Exit status is 0 for completed verified/unverified tasks, 2 for blocked/failed/cancelled tasks, and 1 for invalid CLI input.

## Desktop apps and MCP

Generate an entry containing the correct absolute Node and script paths:

```sh
effort config codex
effort config claude
```

Merge the printed entry into your host's MCP settings. Do not overwrite your existing configuration. For Codex CLI, registration can also use `codex mcp add effort -- node /absolute/path/effort-project/bin/effort.mjs mcp`. Consult your app's current MCP setup UI; local stdio is not supported on every web or remote surface.

The server exposes three read-only, stateless tools:

- `effort_recommend`: explain a proposed starting level without retaining the prompt.
- `effort_observe`: recommend retry, escalation, or stopping based on a reported check failure.
- `effort_capabilities`: show the integration boundaries.

Try: “Use Effort to recommend a reasoning level for this task and explain why.” Apply the level using your host's own selector if you agree. **These tools cannot change the host's active effort.** See [desktop setup](docs/desktop.md).

## Privacy and safety

Effort has no cloud service, telemetry, update checks, or external classifier. Recommendation and MCP requests are processed locally. It does not save prompts, file contents, responses, or verification output. Managed-run metadata includes task UUID, model identifier, effort decisions, coarse repository features, timings, check outcomes, and usage when reliably reported. Metadata files are created with owner-only permissions on POSIX; Windows ACL behavior depends on your account configuration.

Provider CLIs send prompts and task context to their providers and can retain their own transcripts. Effort does not change those policies. The dashboard listens on `127.0.0.1`, validates Host/Origin, and requires its random token for API calls. [Security boundaries](SECURITY.md) cover the remaining limitations.

## Development and contributions

```sh
npm test
npm run check
npm run smoke:package
```

Deterministic tests use fake provider processes and do not consume model credits. Live tests are separately documented and never run in ordinary CI. CI targets Node 22/24 on Linux, macOS, and Windows; consult its actual result before claiming platform coverage.

The package smoke check builds the downloadable archive, installs it offline in a temporary directory, and checks its CLI, MCP tools, dashboard assets and authenticated local API. It does not change your global installation.

Read [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), and the [adapter contract](docs/adapter-contract.md). Contributions that verify a real integration or improve evaluation are especially welcome. Please don't add adapters that merely print an effort label without setting a supported provider parameter.

MIT licensed. Independent project; not affiliated with OpenAI or Anthropic.
