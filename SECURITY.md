# Security boundaries

Effort is an experimental local controller. Use a disposable checkout for initial managed runs. It does not establish that model-generated code is correct or safe.

- No unrestricted shell execution endpoint is exposed by the dashboard or MCP server.
- The browser API has a random per-process bearer token, loopback binding, Host/Origin checks, restrictive CSP, and no external resources. Treat its printed URL as private. Other processes running as your user can access local files and credentials; this is not an isolation boundary against them.
- Provider calls use argument arrays and stdin, not shell interpolation. Managed adapters preserve their documented sandbox/permission restrictions. Requests needing approval stop rather than automatically approving.
- The explicitly supplied verification program is trusted executable code and is NOT sandboxed by Effort. A project's test scripts can have arbitrary side effects. Inspect them first.
- Tool and test output is untrusted data. Only bounded excerpts are passed back to the provider; normal provider protections remain necessary against prompt injection.
- Effort metadata is local, but provider programs maintain their own authentication, transcript, logging, hooks and tool behavior. Adapter docs describe which customizations are disabled. Do not publish provider logs, auth files, dashboard tokens, private prompts, or `.env` files.
- Time and attempt limits reduce runaway execution but do not impose a universal billing cap. Usage can be unavailable or cumulative; unknown values remain null.
- Local MCP tools are advice only. They cannot reduce your app's effort setting or silently change permission settings.
- Automatic integrations are opt-in. The OpenCode plugin changes provider request options and preserves explicit variants/configuration. Managed automatic chat retains the existing adapter restrictions. The Codex terminal prototype passes native approval and sandbox messages through; it does not auto-approve them. Its proposed WebSocket listener binds only to loopback and requires a random token, rejects browser origins, and accepts one client.
- Automatic decisions use local rules, not verified difficulty estimates. A user-supplied model routing table may change provider costs. Unsupported host controls preserve native requests or stop managed execution; they are never represented as confirmed internal model behavior.

For a suspected vulnerability, use GitHub's private vulnerability reporting when available, or contact the repository owner privately. Do not include credentials or private code in a public issue.
