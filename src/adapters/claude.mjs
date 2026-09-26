import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const capabilities = Object.freeze({
  id: 'claude',
  name: 'Claude Code',
  levels: Object.freeze(['low', 'medium', 'high']),
  control: 'managed-turns',
  notes: 'Launches isolated CLI turns with --effort; resumes by session ID. Applied effort is not reported by the CLI and policy caps can apply.',
});

const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_EVENTS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_TOOLS = ['Read', 'Grep', 'Glob'];
// Claude Code 2.1.282 reports this built-in even in safe mode. Do not accept
// arbitrary plugins or a filesystem plugin with the same name.
const isKnownBuiltinPlugin = (plugin) => plugin?.name === 'agents-md' && plugin?.path === 'builtin';
const REQUIRED_FLAGS = [
  '--print', '--output-format', '--verbose', '--effort', '--resume',
  '--restricted', '--safe-mode', '--permission-mode', '--permission-prompts',
  '--tools', '--allowedTools', '--disallowedTools', '--strict-mcp-config', '--mcp-config',
  '--settings', '--setting-sources', '--disable-slash-commands', '--no-chrome',
];
const SAFE_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USER', 'LOGNAME', 'USERNAME', 'USERDOMAIN',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'TZ', 'TERM',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
]);

function emptyUsage() {
  return { inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null };
}

function validate(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Claude options must be an object.');
  }
  const { prompt, cwd, effort, model, sessionId, allowWrite = false,
    timeoutMs = 120_000, signal, onEvent = () => {}, env = process.env,
    executable = 'claude', executableArgs = [], maxTurns = 12, maxBudgetUsd } = options;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) {
    throw new TypeError('prompt must be a nonempty string without NUL bytes.');
  }
  if (/^\s*\//.test(prompt)) throw new TypeError('Leading slash commands are not supported in managed prompts.');
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new RangeError('prompt exceeds 1 MiB.');
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) {
    throw new TypeError('cwd must be an absolute directory path.');
  }
  if (!capabilities.levels.includes(effort)) throw new RangeError('Claude effort must be low, medium, or high.');
  if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,199}$/.test(model))) {
    throw new TypeError('model must be a model name or identifier, without whitespace or options.');
  }
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !UUID.test(sessionId))) {
    throw new TypeError('sessionId must be a UUID, not a session name or transcript path.');
  }
  if (typeof allowWrite !== 'boolean') throw new TypeError('allowWrite must be a boolean.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) {
    throw new RangeError('timeoutMs must be an integer between 1 and 1800000.');
  }
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) {
    throw new RangeError('maxTurns must be an integer between 1 and 50.');
  }
  if (maxBudgetUsd !== undefined && (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 100)) {
    throw new RangeError('maxBudgetUsd must be greater than zero and at most 100.');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function.');
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new TypeError('env must be an object.');
  if (typeof executable !== 'string' || !executable || executable.length > 4096 || /[\0\r\n]/.test(executable)) {
    throw new TypeError('executable must be one executable path or name.');
  }
  if (!Array.isArray(executableArgs) || executableArgs.length > 16 || executableArgs.some((arg) => typeof arg !== 'string' || arg.length > 4096 || /[\0\r\n]/.test(arg))) {
    throw new TypeError('executableArgs must contain at most 16 bounded strings without NULs or newlines.');
  }
  return { prompt, cwd, effort, model, sessionId, allowWrite, timeoutMs, signal, onEvent, env, executable, executableArgs: [...executableArgs], maxTurns, maxBudgetUsd };
}

// Inherit authentication and routing, not arbitrary runtime injection or Claude
// customization variables. This changes only this child's environment.
function childEnvironment(source, effort) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (!SAFE_ENV_NAMES.has(key.toUpperCase()) && !/^(?:ANTHROPIC_|AWS_|AZURE_|GOOGLE_|GCLOUD_|VERTEX_|BEDROCK_|FOUNDRY_|LC_)/.test(key)) continue;
    if (typeof value !== 'string' || key.includes('\0') || value.includes('\0')) {
      throw new TypeError('Environment entries must be strings without NUL bytes.');
    }
    result[key] = value;
  }
  return {
    ...result,
    CLAUDE_CODE_EFFORT_LEVEL: effort,
    CLAUDE_CODE_SAFE_MODE: '1',
    CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    NO_COLOR: '1',
  };
}

function launchArgs(options) {
  const tools = options.allowWrite ? [...READ_TOOLS, 'Edit', 'Write'] : READ_TOOLS;
  const deny = ['Bash', 'PowerShell', 'REPL', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'mcp__*', 'NotebookEdit'];
  if (!options.allowWrite) deny.push('Edit', 'Write');
  const args = [
    '--print', '--output-format', 'stream-json', '--verbose',
    '--effort', options.effort,
    '--restricted', '--safe-mode', '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false,
      fallbackModel: [], switchModelsOnFlag: false, ultracode: false,
      disableClaudeAiConnectors: true, permissions: { additionalDirectories: [] } }),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-chrome',
    '--tools', tools.join(','), '--allowedTools', READ_TOOLS.join(','),
    '--disallowedTools', deny.join(','),
    '--permission-mode', options.allowWrite ? 'acceptEdits' : 'dontAsk',
    '--permission-prompts', 'none', '--max-turns', String(options.maxTurns),
  ];
  if (options.model) args.push('--model', options.model);
  if (options.sessionId) args.push('--resume', options.sessionId);
  if (options.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(options.maxBudgetUsd));
  return args;
}

function killTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // No shell; taskkill is the Windows process-tree primitive. Restricted mode
    // prevents model-created command trees, but CLI-owned children still exist.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(signal); } catch {} });
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch {}
  }
}

function execute({ executable, executableArgs, args, cwd, env, signal, timeoutMs, input = '', onStdout, maxBytes = MAX_OUTPUT_BYTES }) {
  return new Promise((resolve) => {
    let child;
    let ended = false;
    let stopped = null;
    let spawnError = null;
    let stderr = '';
    let bytes = 0;
    let timer;
    let forceTimer;
    let reapTimer;
    const finish = (code, exitSignal) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(reapTimer);
      signal?.removeEventListener('abort', abort);
      if (stopped && child) killTree(child, 'SIGKILL');
      resolve({ code, signal: exitSignal, stopped, spawnError, stderr });
    };
    const stop = (reason) => {
      if (ended || stopped) return;
      stopped = reason;
      child.stdin.destroy();
      killTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => killTree(child, 'SIGKILL'), 500);
      reapTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null, 'SIGKILL');
      }, 2000);
    };
    const abort = () => stop('aborted');
    if (signal?.aborted) { resolve({ code: null, stopped: 'aborted', stderr: '' }); return; }
    try {
      child = spawn(executable, [...executableArgs, ...args], { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, spawnError: error.code || 'SPAWN_ERROR', stderr: '' });
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.on('error', (error) => { spawnError = error.code || 'SPAWN_ERROR'; });
    child.on('close', finish);
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop('stdin_error'); });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { stop('output_limit'); return; }
      try { onStdout(chunk, stop); } catch { stop('protocol_error'); }
    });
    child.stderr.on('data', (chunk) => {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { stop('output_limit'); return; }
      if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) {
        stderr = Buffer.from(stderr + chunk).subarray(0, MAX_STDERR_BYTES).toString('utf8');
      }
    });
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}

function reportedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function reportedUsage(event, resumed) {
  const usage = event.usage ?? {};
  if (resumed) {
    return { ...emptyUsage(), conversationCostUsd: reportedNumber(event.total_cost_usd),
      costScope: 'conversation', tokenScope: 'unverified-on-resume' };
  }
  return {
    inputTokens: reportedNumber(usage.input_tokens),
    outputTokens: reportedNumber(usage.output_tokens),
    cachedInputTokens: reportedNumber(usage.cache_read_input_tokens),
    costUsd: reportedNumber(event.total_cost_usd),
  };
}

function knownUnsupportedModel(model) {
  if (!model) return false;
  return /haiku|opusplan/i.test(model) || /claude-(?:3(?:[.-]|$)|(?:sonnet|opus)-4(?:[.-](?:0|1|5)(?:[^0-9]|$)|$))/.test(model);
}

function modelMatches(requested, observed) {
  if (!requested || requested === 'default') return true;
  const base = requested.replace(/\[(?:1m|200k)\]$/i, '');
  const actual = observed.replace(/\[(?:1m|200k)\]$/i, '');
  if (['opus', 'sonnet', 'fable'].includes(base)) return new RegExp(`(?:^|[./-])(?:claude-)?${base}(?:[-.]|$)`, 'i').test(observed);
  return actual === base;
}

function failureFromText(value) {
  if (/not logged in|please (?:run|use).*login|authentication[_ ](?:failed|error)|invalid[_ ](?:api[_ ]key|authentication)|oauth.*(?:expired|invalid)|unauthorized|\b401\b/i.test(value)) return 'authentication_required';
  if (/billing[_ ]error|credit balance|account_on_hold|payment required/i.test(value)) return 'account_blocked';
  if (/rate[_ ]limit|usage limit|\b429\b/i.test(value)) return 'rate_limited';
  if (/permission[_ ]denied|permission denied|not permitted|oauth_org_not_allowed/i.test(value)) return 'permission_denied';
  if (/model_not_found|model.*(?:not found|not available|not supported)/i.test(value)) return 'model_unavailable';
  if (/unknown option|unknown argument|unrecognized option/i.test(value)) return 'unsupported_cli';
  return null;
}

const ERRORS = {
  authentication_required: ['blocked', 'Claude authentication failed in the managed environment. Check the existing CLI login and credential environment.'],
  account_blocked: ['blocked', 'Claude reported an account or billing restriction.'],
  rate_limited: ['blocked', 'Claude reported a rate or usage limit.'],
  permission_denied: ['blocked', 'Claude denied one or more tool permissions; this turn is not verified complete.'],
  model_unavailable: ['blocked', 'The requested Claude model is unavailable. No replacement model was selected by this adapter.'],
  unsupported_effort_model: ['blocked', 'This Claude model does not support the adapter’s effort control. Select an effort-capable model.'],
  unsupported_cli: ['blocked', 'Claude CLI lacks required managed-mode flags. Update the CLI; the adapter will not weaken isolation.'],
  missing_cli: ['blocked', 'Claude CLI executable was not found. Install Claude Code or provide its executable path.'],
  invalid_cwd: ['blocked', 'The working directory does not exist or is not accessible.'],
  isolation_mismatch: ['blocked', 'Claude reported tools, customizations, or permissions outside the managed configuration. The process was stopped.'],
  model_mismatch: ['blocked', 'Claude reported an unexpected model or a model switch. The process was stopped.'],
  session_mismatch: ['failed', 'Claude reported a different session ID while resuming.'],
  output_limit: ['failed', 'Claude exceeded the adapter’s output bound and was stopped.'],
  timeout: ['failed', 'Claude exceeded the turn timeout and was stopped.'],
  aborted: ['cancelled', 'Claude turn cancelled.'],
  callback_error: ['failed', 'The event callback failed; Claude was stopped.'],
  protocol_error: ['failed', 'Claude returned invalid or incomplete stream-json output.'],
  max_turns: ['blocked', 'Claude reached the managed turn limit.'],
  budget_limit: ['blocked', 'Claude reached the configured budget limit.'],
  cli_error: ['failed', 'Claude exited unsuccessfully. Raw diagnostics were withheld to avoid exposing credentials.'],
};

/** One bounded CLI turn. Nothing here changes another running conversation. */
export async function run(inputOptions) {
  const options = validate(inputOptions);
  const deadline = Date.now() + options.timeoutMs;
  const env = childEnvironment(options.env, options.effort);
  let sessionId = options.sessionId ?? null;
  let initialized = false;
  let text = '';
  let usage = emptyUsage();
  let resultEvent = null;
  let eventCount = 0;
  let callbackFailed = false;
  let streamFailure = null;
  let permissionDenied = false;
  let observedModel = null;
  let isolationDiagnostic = null;
  const evidence = {
    type: 'launch-flag', flag: '--effort', requested: options.effort,
    environment: 'CLAUDE_CODE_EFFORT_LEVEL', launchAccepted: false,
    observedEffort: null, verified: false, observedModel: null,
    note: 'The flag and child environment request effort. Stream JSON does not confirm applied effort; provider or organization caps may silently lower it. This is not a measure of internal reasoning.',
  };
  const emit = (event) => {
    if (callbackFailed) return false;
    try { options.onEvent({ provider: 'claude', ...event }); return true; }
    catch { callbackFailed = true; return false; }
  };
  const outcome = (status, failure) => {
    if (failure) {
      const info = ERRORS[failure] ?? ERRORS.cli_error;
      status = info[0];
      // Never include raw stderr or provider error bodies in diagnostics.
      text = info[1];
      emit({ type: 'error', code: failure, message: info[1], ...(isolationDiagnostic && failure === 'isolation_mismatch' ? { details: isolationDiagnostic } : {}) });
    }
    evidence.launchAccepted = initialized;
    evidence.observedModel = observedModel;
    return { provider: 'claude', sessionId, requestedEffort: options.effort, effortEvidence: evidence, text, usage, status };
  };
  if (options.signal?.aborted) return outcome(null, 'aborted');
  if (knownUnsupportedModel(options.model)) return outcome(null, 'unsupported_effort_model');
  try {
    options.cwd = await realpath(options.cwd);
    if (!(await stat(options.cwd)).isDirectory()) return outcome(null, 'invalid_cwd');
  } catch { return outcome(null, 'invalid_cwd'); }
  const remaining = () => Math.max(1, deadline - Date.now());
  let help = '';
  const preflight = await execute({ ...options, env, args: ['--help'], timeoutMs: Math.min(5000, remaining()),
    maxBytes: 256 * 1024, onStdout: (chunk) => { help += chunk; } });
  if (preflight.stopped) return outcome(null, preflight.stopped);
  if (preflight.spawnError) return outcome(null, preflight.spawnError === 'ENOENT' ? 'missing_cli' : 'cli_error');
  if (preflight.code !== 0 || REQUIRED_FLAGS.some((flag) => !help.includes(flag))) return outcome(null, 'unsupported_cli');
  if (Date.now() >= deadline) return outcome(null, 'timeout');
  if (!emit({ type: 'launch', requestedEffort: options.effort, model: options.model ?? null,
    resumed: Boolean(options.sessionId), mode: options.allowWrite ? 'workspace-edits' : 'read-only', effortEvidence: { ...evidence } })) {
    return outcome(null, 'callback_error');
  }
  const allowed = new Set([...READ_TOOLS, ...(options.allowWrite ? ['Edit', 'Write'] : []), 'EndConversation']);
  let pending = '';
  const consume = (line, stop) => {
    if (!line.trim()) return;
    if (++eventCount > MAX_EVENTS || Buffer.byteLength(line) > MAX_LINE_BYTES) { stop('output_limit'); return; }
    let event;
    try { event = JSON.parse(line); } catch {
      streamFailure = failureFromText(line) ?? 'protocol_error'; stop(streamFailure); return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') { stop('protocol_error'); return; }
    if (event.session_id !== undefined) {
      if (typeof event.session_id !== 'string' || !UUID.test(event.session_id)) { stop('protocol_error'); return; }
      if (sessionId && sessionId.toLowerCase() !== event.session_id.toLowerCase()) { stop('session_mismatch'); return; }
      sessionId = event.session_id;
    }
    if (event.type === 'system' && /^hook_|^plugin_install$/.test(event.subtype ?? '')) { stop('isolation_mismatch'); return; }
    if (event.type === 'system' && event.subtype === 'init') {
      if (initialized || !Array.isArray(event.tools) || event.tools.some((tool) => !allowed.has(tool)) ||
        (event.mcp_servers?.length ?? 0) > 0 ||
        (event.plugins !== undefined && (!Array.isArray(event.plugins) || event.plugins.some((plugin) => !isKnownBuiltinPlugin(plugin)))) ||
        (event.permissionMode && event.permissionMode !== (options.allowWrite ? 'acceptEdits' : 'dontAsk'))) {
        isolationDiagnostic = {
          duplicateInit: initialized,
          unexpectedTools: Array.isArray(event.tools) ? event.tools.filter((tool) => !allowed.has(tool)).slice(0, 32).map((tool) => typeof tool === 'string' && /^[A-Za-z0-9_*-]{1,80}$/.test(tool) ? tool : '[invalid-tool-name]') : ['[missing-tool-list]'],
          mcpServerCount: Array.isArray(event.mcp_servers) ? event.mcp_servers.length : 0,
          pluginCount: Array.isArray(event.plugins) ? event.plugins.length : 0,
          plugins: Array.isArray(event.plugins) ? event.plugins.slice(0, 16).map((plugin) => ({
            name: typeof plugin?.name === 'string' && /^[A-Za-z0-9_@./-]{1,120}$/.test(plugin.name) ? plugin.name : '[invalid-name]',
            location: typeof plugin?.path === 'string' && /^(?:built-?in|<built-?in>)(?::|\/|$)/i.test(plugin.path) ? plugin.path.slice(0, 120) : '[external-or-unspecified]',
          })) : [],
          reportedPermissionMode: ['default', 'manual', 'plan', 'auto', 'dontAsk', 'acceptEdits', 'bypassPermissions'].includes(event.permissionMode) ? event.permissionMode : '[not-reported]',
        };
        stop('isolation_mismatch'); return;
      }
      if (typeof event.model !== 'string' || event.model.length > 200 || !sessionId) { stop('protocol_error'); return; }
      observedModel = event.model;
      if (knownUnsupportedModel(observedModel)) { stop('unsupported_effort_model'); return; }
      if (!modelMatches(options.model, observedModel)) { stop('model_mismatch'); return; }
      initialized = true;
      if (!emit({ type: 'session', sessionId, model: observedModel, requestedEffort: options.effort, observedEffort: null })) stop('callback_error');
    } else if (event.type === 'system' && event.subtype === 'permission_denied') {
      permissionDenied = true;
      if (!emit({ type: 'permission-denied' })) stop('callback_error');
    } else if (event.type === 'system' && /fallback|model_switch|model_change/.test(event.subtype ?? '')) {
      stop('model_mismatch');
    } else if (event.type === 'system' && event.subtype === 'api_retry') {
      if (['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error', 'model_not_found'].includes(event.error)) {
        streamFailure = failureFromText(event.error) ?? 'cli_error'; stop(streamFailure); return;
      }
      if (!emit({ type: 'retry', attempt: reportedNumber(event.attempt), delayMs: reportedNumber(event.retry_delay_ms) })) stop('callback_error');
    } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
      if (event.message?.model && event.message.model !== '<synthetic>' && !modelMatches(observedModel, event.message.model)) { stop('model_mismatch'); return; }
      const blocks = event.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === 'tool_use' && !allowed.has(block.name)) { stop('isolation_mismatch'); return; }
          if (block.type === 'tool_use' && !emit({ type: 'tool', name: block.name })) { stop('callback_error'); return; }
        }
        const assistantText = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
        if (Buffer.byteLength(assistantText) > MAX_TEXT_BYTES) { stop('output_limit'); return; }
        // Only a terminal result can make the turn completed.
        if (!event.error) text = assistantText;
      }
      if (event.error) streamFailure = failureFromText(String(event.error)) ?? 'cli_error';
    } else if (event.type === 'result') {
      if (resultEvent) { stop('protocol_error'); return; }
      resultEvent = event;
      usage = reportedUsage(event, Boolean(options.sessionId));
      permissionDenied ||= Array.isArray(event.permission_denials) && event.permission_denials.length > 0;
      if (typeof event.result === 'string' && !event.is_error) {
        if (Buffer.byteLength(event.result) > MAX_TEXT_BYTES) { stop('output_limit'); return; }
        text = event.result;
      }
      if (event.is_error || event.subtype !== 'success') {
        const errorText = [event.result, ...(Array.isArray(event.errors) ? event.errors.filter((x) => typeof x === 'string') : [])].join('\n');
        streamFailure = failureFromText(errorText) ?? (event.subtype === 'error_max_turns' ? 'max_turns' : event.subtype === 'error_max_budget_usd' ? 'budget_limit' : 'cli_error');
      }
    }
  };
  const execution = await execute({ ...options, env, args: launchArgs(options), input: options.prompt, timeoutMs: remaining(),
    onStdout: (chunk, stop) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        consume(line, stop);
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) stop('output_limit');
    },
  });
  if (!execution.stopped && pending.trim()) consume(pending, (reason) => { streamFailure = reason; });
  if (execution.stopped) return outcome(null, execution.stopped);
  if (execution.spawnError) return outcome(null, execution.spawnError === 'ENOENT' ? 'missing_cli' : 'cli_error');
  if (streamFailure) return outcome(null, streamFailure);
  if (execution.code !== 0 || execution.signal) return outcome(null, failureFromText(execution.stderr) ?? 'cli_error');
  if (!initialized || !resultEvent || resultEvent.subtype !== 'success' || typeof resultEvent.result !== 'string') return outcome(null, failureFromText(execution.stderr) ?? 'protocol_error');
  if (permissionDenied) return outcome(null, 'permission_denied');
  return outcome('completed');
}
