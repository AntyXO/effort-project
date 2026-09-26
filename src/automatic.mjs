import { recommend, LEVELS, validateLevel } from './policy.mjs';

const rank = (value) => LEVELS.indexOf(value);
const MAX_SESSIONS = 256;

/** Per-conversation routing state contains decisions only, never submitted text. */
export function createAutomaticRouter({ minEffort = 'low', maxEffort = 'high', provider = 'generic', effort = 'auto' } = {}) {
  validateLevel(minEffort);
  validateLevel(maxEffort);
  if (rank(minEffort) > rank(maxEffort)) throw new Error('Minimum effort exceeds maximum.');
  if (effort !== 'auto') {
    validateLevel(effort);
    if (rank(effort) < rank(minEffort) || rank(effort) > rank(maxEffort)) throw new Error('Fixed effort is outside the configured bounds.');
  }
  const sessions = new Map();
  const keep = (id, state) => {
    sessions.delete(id);
    sessions.set(id, state);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  };
  return {
    forget(sessionId) { sessions.delete(sessionId); },
    decide({ sessionId, model, prompt, facts = {}, supportedEfforts = [], preview = false } = {}) {
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new Error('A bounded conversation ID is required.');
      const supported = LEVELS.filter((level) => supportedEfforts.includes(level) && rank(level) >= rank(minEffort) && rank(level) <= rank(maxEffort));
      const base = recommend({ prompt, provider, minEffort, maxEffort });
      // A multilingual checkout does not make a spelling correction complicated.
      // A broad edit still uses the repository scope signal from the existing policy.
      const scopedFacts = base.features.mechanical && !base.features.critical && !base.features.complex
        ? { ...facts, languages: [] } : facts;
      const recommendation = recommend({ prompt, provider, facts: scopedFacts, minEffort, maxEffort });
      const reasons = [...recommendation.reasons];
      const previous = sessions.get(sessionId);
      let desired = effort === 'auto' ? recommendation.effort : effort;
      let lowerCount = 0;
      if (effort !== 'auto') reasons.push('Using the fixed effort selected for this automatic session.');
      else if (previous && rank(desired) < rank(previous.effort)) {
        // Bare assent and short references are continuations, not fresh easy tasks.
        const ambiguous = !base.features.mechanical && (prompt.trim().length < 160 || /^(?:yes|ok(?:ay)?|continue|go ahead|do (?:it|that)|try again|same\b|fix (?:it|that)|what about\b)/i.test(prompt.trim()));
        lowerCount = ambiguous ? 0 : previous.lowerCount + 1;
        if (ambiguous || lowerCount < 2) {
          desired = previous.effort;
          reasons.push(ambiguous
            ? 'Keeping the previous effort because this may continue the same task.'
            : 'Waiting for a second simpler request before lowering effort; changing settings can disrupt provider caching.');
        } else {
          reasons.push('Two consecutive simpler requests allow a lower effort.');
          lowerCount = 0;
        }
      }
      // Never silently map a hard request down to the model's only low setting.
      const selected = effort !== 'auto'
        ? supported.find((level) => level === desired)
        : supported.find((level) => rank(level) >= rank(desired));
      if (!selected) return {
        action: 'preserve', effort: null, model: model ?? null, recommendation, reasons: [...reasons, 'This model advertises no suitable effort within the configured bounds; preserve its request.'],
        policyVersion: 'automatic-0.1', confidence: 'low',
      };
      if (selected !== desired) reasons.push(`The model supports ${selected} as its next available effort above ${desired}.`);
      if (!preview) keep(sessionId, { effort: selected, lowerCount });
      return { action: 'apply', effort: selected, model: model ?? null, recommendation, reasons,
        policyVersion: 'automatic-0.1', confidence: 'low' };
    },
  };
}

/** Model switching is opt-in and restricted to a user-supplied table. */
export function validateModelMap(models) {
  if (models === undefined) return undefined;
  if (!models || typeof models !== 'object' || Array.isArray(models) || Object.getPrototypeOf(models) !== Object.prototype) throw new Error('models must be an object mapping effort levels to model IDs.');
  const result = {};
  for (const [level, model] of Object.entries(models)) {
    validateLevel(level);
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,199}$/.test(model)) throw new Error('A routing model must be an exact model ID without whitespace or options.');
    result[level] = model;
  }
  return result;
}
