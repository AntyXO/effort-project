import { isAbsolute } from 'node:path';
import { createAutomaticRouter } from '../automatic.mjs';
import { LEVELS } from '../policy.mjs';
import { repositoryFacts } from '../repository.mjs';

const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,199}$/;
const SESSION_ID = /^[a-zA-Z0-9_-]{1,256}$/;

function validateModel(model) {
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    throw new TypeError('Models must be literal model identifiers without whitespace or options.');
  }
  return model;
}

function modelTable(models) {
  if (models === undefined) return Object.freeze({});
  if (!models || typeof models !== 'object' || Array.isArray(models) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(models))) {
    throw new TypeError('models must be an object mapping effort levels to model identifiers.');
  }
  const table = {};
  for (const [level, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(models))) {
    if (!LEVELS.includes(level) || !('value' in descriptor)) {
      throw new TypeError('models accepts only literal low, medium, high, xhigh, or max entries.');
    }
    table[level] = validateModel(descriptor.value);
  }
  return Object.freeze(table);
}

/** Local routing over isolated adapter turns; provider transcripts stay with the provider. */
export function createManagedChat({ adapter, cwd, model, models, effort = 'auto',
  minEffort = 'low', maxEffort = 'high', allowWrite = false, timeoutMs = 120_000,
  onEvent = () => {}, signal, env, executable, executableArgs, maxTurns, maxBudgetUsd } = {}) {
  if (!adapter || typeof adapter.run !== 'function' || typeof adapter.capabilities?.id !== 'string' ||
      !Array.isArray(adapter.capabilities.levels) || adapter.capabilities.levels.some((level) => !LEVELS.includes(level))) {
    throw new TypeError('A managed adapter with declared effort levels is required.');
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) {
    throw new TypeError('cwd must be an absolute directory path.');
  }
  if (!LEVELS.includes(minEffort) || !LEVELS.includes(maxEffort) || LEVELS.indexOf(minEffort) > LEVELS.indexOf(maxEffort)) {
    throw new RangeError('Effort bounds must be supported levels with minimum no higher than maximum.');
  }
  if (effort !== 'auto' && !LEVELS.includes(effort)) throw new RangeError('effort must be auto or a supported effort level.');
  if (model !== undefined) validateModel(model);
  const table = modelTable(models);
  if (typeof allowWrite !== 'boolean') throw new TypeError('allowWrite must be a boolean.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) {
    throw new RangeError('timeoutMs must be an integer between 1 and 1800000.');
  }
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function.');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');

  const provider = adapter.capabilities.id;
  const supportedEfforts = [...adapter.capabilities.levels];
  const router = createAutomaticRouter({ minEffort, maxEffort,
    provider: ['codex', 'claude'].includes(provider) ? provider : 'generic' });
  const routingSessionId = 'local-conversation';
  let sessionId;
  let currentModel = model;
  let observedModel = null;
  let turn = 0;
  let busy = false;
  let requiresReset = false;

  function envelope({ status = 'blocked', decision = null, result = null, text,
    requestedModel = null, requestedEffort = null, facts = null, code = null } = {}) {
    const evidence = result?.effortEvidence;
    return {
      status, provider, sessionId: sessionId ?? null, turn, decision, result,
      text: text ?? result?.text ?? '', code, requiresReset,
      requestedModel, observedModel, requestedEffort,
      observedEffort: evidence?.observedEffort ?? evidence?.configuredEffort ?? null,
      effortEvidence: evidence ?? null, repository: facts,
      verification: { status: 'not-run', note: 'No independent quality check was run; provider completion is not verified correctness.' },
    };
  }

  async function submit(prompt) {
    if (busy) throw new Error('A managed conversation can process only one prompt at a time.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000 || prompt.includes('\0')) {
      throw new TypeError('prompt must contain 1–100,000 characters without NUL bytes.');
    }
    if (requiresReset) return envelope({ code: 'reset_required', text: 'The previous turn did not finish with confirmed conversation continuity. Reset explicitly before starting a new conversation.' });
    if (signal?.aborted) return envelope({ status: 'cancelled', code: 'aborted', text: 'The conversation was cancelled before submitting this prompt.' });
    busy = true;
    let launched = false;
    let decision = null;
    let requestedModel = null;
    let requestedEffort = null;
    let facts = null;
    let routingInput = null;
    try {
      facts = await repositoryFacts(cwd, prompt);
      if (signal?.aborted) return envelope({ status: 'cancelled', code: 'aborted', text: 'The conversation was cancelled before submitting this prompt.', facts });
      if (effort === 'auto') {
        routingInput = { sessionId: routingSessionId, model: currentModel ?? 'default', prompt, facts, supportedEfforts };
        decision = router.decide({ ...routingInput, preview: true });
        requestedEffort = decision.effort;
      } else {
        requestedEffort = effort;
        decision = { action: 'apply', effort, reasons: ['Explicit user effort selection.'], recommendation: null };
      }
      if (!supportedEfforts.includes(requestedEffort) || LEVELS.indexOf(requestedEffort) < LEVELS.indexOf(minEffort) ||
          LEVELS.indexOf(requestedEffort) > LEVELS.indexOf(maxEffort)) {
        return envelope({ decision, requestedEffort, facts, code: 'unsupported_effort',
          text: 'No supported effort can be selected within the configured bounds. No provider turn was started.' });
      }
      requestedModel = model ?? table[requestedEffort] ?? currentModel ?? null;
      onEvent({ type: 'routing', provider, decision, requestedModel, requestedEffort, resumed: Boolean(sessionId) });
      if (signal?.aborted) return envelope({ status: 'cancelled', decision, requestedModel, requestedEffort, facts, code: 'aborted', text: 'The conversation was cancelled before submitting this prompt.' });
      if (routingInput) router.decide(routingInput);
      launched = true;
      turn += 1;
      const result = await adapter.run({ prompt, cwd, effort: requestedEffort, model: requestedModel ?? undefined,
        sessionId, allowWrite, timeoutMs, signal, onEvent, env, executable, executableArgs, maxTurns, maxBudgetUsd });
      const reportedModel = result?.effortEvidence?.observedModel ?? result?.effortEvidence?.model ?? null;
      if (typeof reportedModel === 'string' && MODEL_ID.test(reportedModel)) observedModel = reportedModel;
      else observedModel = null;
      const metadata = { decision, result, requestedModel, requestedEffort, facts };
      if (!result || !['completed', 'blocked', 'failed', 'cancelled'].includes(result.status)) {
        requiresReset = true;
        return envelope({ ...metadata, code: 'unknown_result', text: 'The provider returned an unknown result. Conversation continuity is uncertain; reset before continuing.' });
      }
      if (result.status !== 'completed' || signal?.aborted) {
        requiresReset = true;
        return envelope({ ...metadata, status: result.status === 'cancelled' || signal?.aborted ? 'cancelled' : 'blocked', code: 'provider_incomplete',
          text: result.text || 'The provider did not complete this turn. No retry was attempted; reset before continuing.' });
      }
      if (typeof result.sessionId !== 'string' || !SESSION_ID.test(result.sessionId) ||
          (sessionId && sessionId.toLowerCase() !== result.sessionId.toLowerCase())) {
        requiresReset = true;
        return envelope({ ...metadata, code: 'session_unconfirmed',
          text: 'The provider did not confirm the same resumable conversation. Reset explicitly before submitting another prompt.' });
      }
      sessionId = result.sessionId;
      currentModel = model ?? observedModel ?? requestedModel ?? undefined;
      return envelope({ ...metadata, status: 'unverified' });
    } catch {
      // A thrown provider error may occur after input reached it. Never replay the
      // prompt or silently start a replacement conversation, and do not echo errors
      // that might contain a prompt or credentials.
      requiresReset ||= launched;
      return envelope({ decision, requestedModel, requestedEffort, facts,
        status: signal?.aborted ? 'cancelled' : 'blocked', code: launched ? 'provider_error' : 'preparation_error',
        text: launched ? 'The provider turn failed. No retry was attempted; reset explicitly before continuing.' : 'The prompt could not be prepared. Check the workspace and routing configuration; no provider turn was started.' });
    } finally {
      busy = false;
    }
  }

  function reset() {
    if (busy) throw new Error('Wait for the current turn to stop before resetting the conversation.');
    router.forget(routingSessionId);
    sessionId = undefined;
    currentModel = model;
    observedModel = null;
    turn = 0;
    requiresReset = false;
  }

  return Object.freeze({ submit, reset });
}
