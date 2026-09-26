# Desktop integration

Effort's local MCP server uses newline-delimited JSON-RPC over stdio. The host launches `node /absolute/path/effort-project/bin/effort.mjs mcp`. There is no HTTP MCP server and no remote account.

Use `effort config codex` for a TOML entry or `effort config claude` for a JSON entry. The output uses the current Node executable and installed script's absolute path. Review and merge that entry using your host's documented MCP configuration. No command in Effort writes to global app settings. If you move the installation, regenerate the entry.

Codex CLI's local MCP configuration is documented at https://developers.openai.com/codex/mcp . Codex desktop availability depends on the installed app/version. Claude desktop and Claude Code use distinct configuration surfaces; see https://code.claude.com/docs/en/mcp and your desktop app's current local MCP settings. A browser-only connector that expects a hosted URL cannot use this stdio server directly.

The tools can recommend effort and explain observations. They have no supported access to the effort selector of an arbitrary active host chat. To apply a recommendation, use the host's selector. Automatic adaptation is available only when launching a managed CLI task with `effort run`.

Protocol tests prove initialization, tool discovery and calls. They do not prove installation in every desktop app, every app version, or a native effort change. The validation report names the surfaces actually tested.
