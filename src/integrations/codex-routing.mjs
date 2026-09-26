import { createAutomaticRouter, validateModelMap } from '../automatic.mjs';
import { LEVELS } from '../policy.mjs';
import { repositoryFacts } from '../repository.mjs';

const MAX_THREADS = 128;
const MAX_PENDING = 256;
const MAX_MODELS = 512;
const MAX_CATALOG_PAGES = 10;
const MAX_INPUTS = 64;
const MAX_PROMPT_CHARACTERS = 100_000;
const CATALOG_TTL_MS = 60_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shortString = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const requestId = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

// Keep protocol state bounded and metadata-only. Requests and user prompts are
// never retained in these maps; only fields needed to route a later turn are.
function remember(map, key, value, maximum, onEvict = () => {}) {
  map.delete(key);
  map.set(key, value);
  if (map.size > maximum) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
    onEvict(oldest);
  }
}

function modeSettings(params) {
  const mode = params?.collaborationMode;
  if (mode == null) return undefined;
  if (!object(mode) || !['plan', 'default'].includes(mode.mode) || !object(mode.settings) || !shortString(mode.settings.model)) return null;
  return mode.settings;
}

function textPrompt(params) {
  if (params.toolOutput != null || !Array.isArray(params.input) || !params.input.length || params.input.length > MAX_INPUTS) return undefined;
  const parts = [];
  let length = 0;
  for (const input of params.input) {
    // Images, skills, attachments, and future input variants need a different
    // difficulty assessment. Forward them untouched instead of guessing.
    if (!object(input) || input.type !== 'text' || typeof input.text !== 'string') return undefined;
    length += input.text.length + (parts.length ? 1 : 0);
    if (length > MAX_PROMPT_CHARACTERS) return undefined;
    parts.push(input.text);
  }
  const prompt = parts.join('\n');
  return prompt.trim() ? prompt : undefined;
}

/**
 * Route an opted-in Codex app-server connection. An `apply` event records an
 * outgoing request rewrite, never a provider acknowledgement or quality claim.
 * Explicit launcher effort pins win over automatic selection; the launcher
 * model pin wins over an optional tier-to-model map. The normal TUI selection
 * supplies the model when neither launcher option requests model switching.
 */
export function createCodexRouting({ cwd, effort = 'auto', model, models, minEffort = 'low', maxEffort = 'high', onDecision = () => {}, request, repositoryFactsFn = repositoryFacts } = {}) {
  const router = createAutomaticRouter({ provider: 'codex', effort, minEffort, maxEffort });
  if (model != null) validateModelMap({ low: model });
  const modelMap = validateModelMap(models) ?? {};
  const threads = new Map();
  const pending = new Map();
  const catalog = new Map();
  let catalogLoadedAt = 0;
  let catalogRequest;

  function emit(event) {
    try { onDecision({ provider: 'codex', mode: effort === 'auto' ? 'automatic' : 'fixed', ...event }); } catch { /* Observers cannot prevent a user turn. */ }
  }

  function setThread(id, info) {
    if (!shortString(id)) return;
    const previous = threads.get(id) ?? {};
    const next = { ...previous };
    if (shortString(info?.model)) next.model = info.model;
    if (shortString(info?.cwd)) next.cwd = info.cwd;
    if (shortString(info?.reasoningEffort)) next.reasoningEffort = info.reasoningEffort;
    remember(threads, id, next, MAX_THREADS, old => router.forget(old));
  }

  function ingestCatalog(result, destination = catalog) {
    if (!object(result) || !Array.isArray(result.data) || result.data.length > MAX_MODELS) throw new Error('Invalid Codex model catalog.');
    for (const entry of result.data) {
      if (!object(entry) || !shortString(entry.model) || !Array.isArray(entry.supportedReasoningEfforts) || entry.supportedReasoningEfforts.length > 64) continue;
      const supportedEfforts = [...new Set(entry.supportedReasoningEfforts.map(item => object(item) ? item.reasoningEffort : undefined).filter(shortString))];
      if (!supportedEfforts.length) continue;
      remember(destination, entry.model, { model: entry.model, id: shortString(entry.id) ? entry.id : entry.model, supportedEfforts }, MAX_MODELS);
    }
  }

  const findModel = identifier => catalog.get(identifier) ?? [...catalog.values()].find(entry => entry.id === identifier);

  async function discoverModels() {
    if (catalogLoadedAt && Date.now() - catalogLoadedAt < CATALOG_TTL_MS) return;
    if (catalogRequest) return catalogRequest;
    if (typeof request !== 'function') return;
    catalogRequest = (async () => {
      const visited = new Set();
      const snapshot = new Map();
      let cursor;
      for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
        const response = await request('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) });
        const result = response?.result ?? response;
        ingestCatalog(result, snapshot);
        if (result.nextCursor == null) {
          // Replace only after a complete successful discovery. Removed models
          // must not retain stale capabilities from an earlier catalog.
          catalog.clear();
          for (const [key, value] of snapshot) catalog.set(key, value);
          catalogLoadedAt = Date.now();
          return;
        }
        if (!shortString(result.nextCursor) || visited.has(result.nextCursor)) throw new Error('Invalid Codex model catalog pagination.');
        visited.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new Error('Codex model catalog exceeds the discovery limit.');
    })();
    try { await catalogRequest; } finally { catalogRequest = undefined; }
  }

  function preserve(message, reason, extra = {}) {
    emit({ sessionId: shortString(message?.params?.threadId) ? message.params.threadId : undefined, action: 'preserve', evidence: 'unchanged', reasons: [reason], ...extra });
    return message;
  }

  async function routeTurn(message) {
    const params = message.params;
    if (!object(params) || !shortString(params.threadId)) return preserve(message, 'The turn does not identify a known Codex thread.');
    const prompt = textPrompt(params);
    if (prompt === undefined) return preserve(message, 'Only bounded text-only user turns can be assessed automatically.');
    const settings = modeSettings(params);
    if (settings === null) return preserve(message, 'The collaboration mode has an unsupported shape.');
    const thread = threads.get(params.threadId) ?? {};
    const previousModel = settings?.model ?? params.model ?? thread.model;
    const previousEffort = settings?.reasoning_effort ?? params.effort ?? thread.reasoningEffort;
    const workspace = params.cwd ?? thread.cwd ?? cwd;
    const metadata = { previousModel: shortString(previousModel) ? previousModel : undefined, previousEffort: shortString(previousEffort) ? previousEffort : undefined };
    if (!shortString(workspace)) return preserve(message, 'The workspace is unknown; the current selection is preserved.', metadata);
    if (!shortString(model ?? previousModel)) return preserve(message, 'The active model is unknown; the current selection is preserved.', metadata);
    try {
      const facts = await repositoryFactsFn(workspace, prompt);
      const desired = router.decide({ sessionId: params.threadId, model: model ?? previousModel, prompt, facts, supportedEfforts: LEVELS, preview: true });
      if (desired.action !== 'apply') return preserve(message, 'The router could not assess this turn.', metadata);
      const initialModel = model ?? modelMap[desired.effort] ?? previousModel;
      await discoverModels();
      const selected = findModel(initialModel);
      if (!selected) return preserve(message, 'The selected model has no discovered effort capabilities.', metadata);
      const decision = router.decide({ sessionId: params.threadId, model: selected.model, prompt, facts, supportedEfforts: selected.supportedEfforts });
      if (decision.action !== 'apply' || !selected.supportedEfforts.includes(decision.effort)) return preserve(message, 'The router could not choose a supported effort for this model.', { ...metadata, reasons: decision.reasons ?? ['No supported effort is available.'] });

      const modelSelection = model ? 'pinned' : modelMap[desired.effort] ? 'mapped' : 'unchanged';
      const nextParams = { ...params, effort: decision.effort };
      if (modelSelection !== 'unchanged') nextParams.model = selected.model;
      // Codex's experimental schema states that collaborationMode takes
      // precedence over top-level model/effort. Keep both carriers consistent.
      if (settings) nextParams.collaborationMode = { ...params.collaborationMode, settings: { ...settings, reasoning_effort: decision.effort, ...(modelSelection !== 'unchanged' ? { model: selected.model } : {}) } };
      const rewritten = { ...message, params: nextParams };
      emit({ sessionId: params.threadId, action: 'apply', evidence: 'turn-request-rewrite', effort: decision.effort, model: selected.model, modelSelection, reasons: decision.reasons, ...metadata });
      return rewritten;
    } catch {
      return preserve(message, 'Automatic routing could not complete; the current selection is preserved.', metadata);
    }
  }

  function recordRequest(message) {
    if (!object(message) || !requestId(message.id) || !object(message.params)) return;
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
      const params = message.params;
      const source = threads.get(params.threadId) ?? {};
      remember(pending, message.id, { method: message.method, model: shortString(params.model) ? params.model : source.model, cwd: shortString(params.cwd) ? params.cwd : source.cwd ?? cwd, reasoningEffort: shortString(params.config?.model_reasoning_effort) ? params.config.model_reasoning_effort : source.reasoningEffort }, MAX_PENDING);
    } else if (message.method === 'model/list') {
      remember(pending, message.id, { method: message.method }, MAX_PENDING);
    } else if (message.method === 'turn/start') {
      const settings = modeSettings(message.params);
      remember(pending, message.id, { method: message.method, threadId: message.params.threadId, model: settings?.model ?? message.params.model, cwd: message.params.cwd, reasoningEffort: settings?.reasoning_effort ?? message.params.effort }, MAX_PENDING);
    }
  }

  return {
    async fromClient(message) {
      const outgoing = object(message) && message.method === 'turn/start' ? await routeTurn(message) : message;
      recordRequest(outgoing);
      return outgoing;
    },
    fromServer(message) {
      if (!object(message)) return message;
      if (!message.method && requestId(message.id)) {
        const tracked = pending.get(message.id);
        pending.delete(message.id);
        if (tracked && object(message.result) && !message.error) {
          if (tracked.method === 'model/list') { try { ingestCatalog(message.result); } catch { /* Ignore malformed discovery; keep protocol untouched. */ } }
          else if (tracked.method === 'turn/start') setThread(tracked.threadId, tracked);
          else setThread(message.result.thread?.id, { ...tracked, ...message.result, cwd: message.result.cwd ?? message.result.thread?.cwd ?? tracked.cwd, reasoningEffort: message.result.reasoningEffort ?? tracked.reasoningEffort });
        }
      } else if (message.method === 'thread/settings/updated' && object(message.params?.threadSettings)) {
        const value = message.params.threadSettings;
        setThread(message.params.threadId, { cwd: value.cwd, model: value.collaborationMode?.settings?.model ?? value.model, reasoningEffort: value.collaborationMode?.settings?.reasoning_effort ?? value.effort });
      } else if (['thread/closed', 'thread/deleted', 'thread/archived'].includes(message.method) && shortString(message.params?.threadId)) {
        threads.delete(message.params.threadId);
        router.forget(message.params.threadId);
      }
      return message;
    },
  };
}
