import { createAutomaticRouter } from '../automatic.mjs';
import { repositoryFacts } from '../repository.mjs';
import { LEVELS } from '../policy.mjs';

// OpenCode v1.18.32: chat.message captures a submitted task; chat.params runs
// after provider defaults and explicit variants have been merged, before send.
// https://github.com/anomalyco/opencode/blob/v1.18.32/packages/plugin/src/index.ts
const effortKeys = new Set([
  'reasoningEffort', 'reasoning_effort', 'effort', 'thinking', 'thinkingConfig',
  'reasoningConfig', 'reasoning', 'output_config', 'maxReasoningEffort', 'budgetTokens',
]);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
const effortSetting = value => plain(value) && Object.keys(value).some(key => effortKeys.has(key) && value[key] !== undefined);
const hasVariant = (...values) => values.some(value => value !== undefined);
const modelKey = model => identifier(model?.providerID) && identifier(model?.modelID ?? model?.id)
  ? `${model.providerID}/${model.modelID ?? model.id}` : null;
const cacheKey = (sessionId, messageId) => JSON.stringify([sessionId, messageId]);

// Build a fresh result before mutating the request. Never mutate native variants
// or shared nested provider options, and reject prototype keys at every depth.
function mergeVariant(base, patch) {
  let nodes = 0;
  function copy(value, depth) {
    if (++nodes > 2048 || depth > 12) throw new Error('Unsupported variant structure.');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))) return value;
    if (Array.isArray(value)) return value.map(item => copy(item, depth + 1));
    if (!plain(value)) throw new Error('Unsupported variant value.');
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (unsafeKeys.has(key)) throw new Error('Unsupported variant key.');
      if (item !== undefined) result[key] = copy(item, depth + 1);
    }
    return result;
  }
  function merge(target, source) {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
      result[key] = plain(value) && plain(target?.[key]) ? merge(target[key], value) : value;
    }
    return result;
  }
  return merge(base, copy(patch, 0));
}

/**
 * Make an OpenCode plugin initializer. Install the returned initializer once;
 * each project instance has isolated caches and router history.
 * repositoryFactsFn is injectable for offline contract tests.
 */
export function createEffortPlugin({
  minEffort = 'low', maxEffort = 'high', agents = ['build', 'plan'],
  maxCachedMessages = 128, pendingTtlMs = 60_000, metadataTimeoutMs = 1000, repositoryFactsFn = repositoryFacts,
} = {}) {
  if (!Array.isArray(agents) || !agents.length || agents.some(agent => !identifier(agent))) throw new TypeError('agents must contain agent names.');
  if (!Number.isInteger(maxCachedMessages) || maxCachedMessages < 1 || maxCachedMessages > 1024) throw new RangeError('maxCachedMessages must be from 1 to 1024.');
  if (!Number.isInteger(pendingTtlMs) || pendingTtlMs < 1 || pendingTtlMs > 300_000) throw new RangeError('pendingTtlMs must be from 1 to 300000.');
  if (!Number.isInteger(metadataTimeoutMs) || metadataTimeoutMs < 1 || metadataTimeoutMs > 30_000) throw new RangeError('metadataTimeoutMs must be from 1 to 30000.');
  if (typeof repositoryFactsFn !== 'function') throw new TypeError('repositoryFactsFn must be a function.');
  const allowedAgents = new Set(agents);

  return async function EffortPlugin({ directory, client } = {}) {
    const router = createAutomaticRouter({ minEffort, maxEffort });
    const messages = new Map();
    let configSeen = false;
    let disposed = false;
    let explicitProviders = new Set();
    let explicitModels = new Set();
    let explicitAgents = new Set();

    function log(action, entry, extra = {}) {
      try {
        const result = client?.app?.log?.({ body: {
          service: 'effort-project', level: 'info', message: `Automatic effort: ${action}.`,
          extra: { action, sessionId: entry.sessionId, messageId: entry.messageId,
            control: 'automatic', evidence: 'request-options', providerAccepted: null, ...extra },
        } });
        Promise.resolve(result).catch(() => {});
      } catch { /* Logging must never block a user's request. */ }
    }

    function remove(key) {
      const entry = messages.get(key);
      if (entry) {
        clearTimeout(entry.timer);
        delete entry.prompt;
        messages.delete(key);
      }
    }

    function clearSession(sessionId) {
      for (const [key, entry] of messages) if (entry.sessionId === sessionId) remove(key);
      router.forget(sessionId);
    }

    function explicit(input, entry) {
      return explicitAgents.has(entry.agent) || explicitProviders.has(input.model?.providerID) ||
        explicitModels.has(modelKey(input.model)) ||
        hasVariant(input.message?.variant, input.message?.model?.variant);
    }

    async function decide(input, entry) {
      const key = modelKey(input.model);
      let deadline;
      try {
        const facts = await Promise.race([
          Promise.resolve().then(() => repositoryFactsFn(directory, entry.prompt)),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Metadata timed out.')), metadataTimeoutMs); }),
        ]);
        if (disposed || messages.get(cacheKey(entry.sessionId, entry.messageId)) !== entry) return null;
        const supportedEfforts = Object.keys(input.model.variants)
          .filter(level => LEVELS.includes(level) && plain(input.model.variants[level]) && effortSetting(input.model.variants[level]));
        const decision = router.decide({ sessionId: entry.sessionId, model: key,
          prompt: entry.prompt, facts, supportedEfforts });
        return { ...decision, model: key };
      } catch {
        log('preserve', entry, { reason: 'recommendation-unavailable' });
        return null;
      } finally {
        delete entry.prompt;
        clearTimeout(deadline);
        clearTimeout(entry.timer);
      }
    }

    return {
      async config(config) {
        // Retain only override presence, never credentials or the full config.
        configSeen = false;
        const providers = new Set(), models = new Set(), configuredAgents = new Set();
        try {
          if (!plain(config)) return;
          for (const [providerId, provider] of Object.entries(config.provider ?? {})) {
            if (effortSetting(provider?.options)) providers.add(providerId);
            for (const [id, model] of Object.entries(provider?.models ?? {})) {
              if (effortSetting(model?.options)) models.add(`${providerId}/${id}`);
            }
          }
          for (const [name, agent] of Object.entries(config.agent ?? {})) {
            if (effortSetting(agent) || effortSetting(agent?.options) || hasVariant(agent?.variant)) configuredAgents.add(name);
          }
          explicitProviders = providers; explicitModels = models; explicitAgents = configuredAgents;
          configSeen = true;
        } catch { /* Unknown host configuration: keep native request settings. */ }
      },

      async 'chat.message'(input, output) {
        try {
          if (disposed || !configSeen || !identifier(input?.sessionID) || !identifier(output?.message?.id)) return;
          const message = output.message;
          const key = cacheKey(input.sessionID, message.id);
          remove(key);
          const agent = message.agent ?? input.agent;
          if (message.role !== 'user' || !allowedAgents.has(agent) ||
            hasVariant(input.variant, message.variant, message.model?.variant) || explicitAgents.has(agent)) return;
          if (!Array.isArray(output.parts)) return;
          let prompt = '';
          for (const part of output.parts) {
            if (part?.type !== 'text' || part.synthetic || part.ignored || typeof part.text !== 'string') continue;
            prompt += `${prompt ? '\n' : ''}${part.text}`;
            if (prompt.length > 100_000) return;
          }
          if (!prompt.trim()) return;
          while (messages.size >= maxCachedMessages) remove(messages.keys().next().value);
          const entry = { sessionId: input.sessionID, messageId: message.id, agent, prompt };
          entry.timer = setTimeout(() => remove(key), pendingTtlMs);
          entry.timer.unref?.();
          messages.set(key, entry);
        } catch { /* A malformed hook payload must not interrupt OpenCode. */ }
      },

      async 'chat.params'(input, output) {
        let entry;
        try {
          if (disposed || !configSeen || !identifier(input?.sessionID) || !identifier(input.message?.id)) return;
          const key = cacheKey(input.sessionID, input.message.id);
          entry = messages.get(key);
          if (!entry || input.agent !== entry.agent || !allowedAgents.has(input.agent)) return;
          if (explicit(input, entry)) {
            log('preserve', entry, { reason: 'explicit-effort' });
            remove(key); return;
          }
          if (input.model?.capabilities?.reasoning !== true ||
            !modelKey(input.model) || !plain(input.model.variants) || !plain(output?.options)) {
            log('preserve', entry, { reason: 'unsupported-request' });
            remove(key); return;
          }
          entry.pending ??= decide(input, entry);
          entry.decision = await entry.pending;
          if (disposed || messages.get(key) !== entry || !configSeen || explicit(input, entry)) return;
          const decision = entry.decision;
          if (!decision || decision.model !== modelKey(input.model)) return;
          if (decision.action !== 'apply') {
            if (!entry.logged) {
              entry.logged = true;
              log('preserve', entry, { reason: 'no-suitable-variant', model: decision.model });
            }
            return;
          }
          const variant = input.model.variants[decision.effort];
          if (!plain(variant) || !effortSetting(variant)) return;
          const options = mergeVariant(output.options, variant);
          output.options = options;
          if (!entry.logged) {
            entry.logged = true;
            log('apply', entry, { model: decision.model, effort: decision.effort,
              policyVersion: decision.policyVersion ?? null, confidence: decision.confidence ?? 'low' });
          }
        } catch {
          if (entry) log('preserve', entry, { reason: 'unsupported-request-options' });
        }
      },

      async event({ event } = {}) {
        const deletedId = event?.properties?.info?.id ?? event?.properties?.sessionID;
        if (event?.type === 'session.deleted' && identifier(deletedId)) clearSession(deletedId);
        // Idle keeps completed decisions for resume but discards unused prompts.
        const idle = event?.type === 'session.idle' || (event?.type === 'session.status' && event.properties?.status?.type === 'idle');
        if (idle && identifier(event.properties?.sessionID)) {
          for (const [key, entry] of messages) {
            if (entry.sessionId === event.properties.sessionID && !entry.pending) remove(key);
          }
        }
      },

      async dispose() {
        disposed = true;
        for (const entry of messages.values()) router.forget(entry.sessionId);
        for (const key of messages.keys()) remove(key);
        explicitProviders.clear(); explicitModels.clear(); explicitAgents.clear();
      },
    };
  };
}

export default createEffortPlugin();
