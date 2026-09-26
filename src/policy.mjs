export const POLICY_VERSION = 'rules-0.1';
export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function validateLevel(level) {
  if (!LEVELS.includes(level)) throw new Error(`Unsupported effort: ${level}`);
  return level;
}

export function recommend({ prompt, provider = 'generic', facts = {}, maxEffort = 'high', minEffort = 'low' }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000) throw new Error('Prompt must contain 1–100,000 characters.');
  if (!['codex', 'claude', 'generic'].includes(provider)) throw new Error('Provider must be codex, claude, or generic.');
  validateLevel(maxEffort); validateLevel(minEffort);
  if (LEVELS.indexOf(minEffort) > LEVELS.indexOf(maxEffort)) throw new Error('Minimum effort exceeds maximum.');
  const critical = /\b(auth(?:entication|orization)?|permission|cryptograph\w*|encrypt\w*|payment|migration|race condition|deadlock|data loss|security|vulnerability)\b/i.test(prompt);
  const complex = /\b(architect\w*|investigate|diagnos\w*|refactor|concurren\w*|intermittent|distributed|across|root cause|regression|debug)\b/i.test(prompt);
  const mechanical = /\b(rename|typo|spelling|format|translate|summarize|capitaliz\w*)\b/i.test(prompt) && prompt.length < 350;
  const repoComplex = Number(facts.languages?.length) >= 3 || Number(facts.mentionedFiles) >= 5;
  let effort = critical || complex ? 'high' : mechanical && !repoComplex ? 'low' : 'medium';
  const reasons = [];
  if (critical) reasons.push('The request touches behavior where an incorrect change can be costly.');
  if (complex) reasons.push('The request suggests investigation or changes with interacting parts.');
  if (mechanical && !critical && !complex) reasons.push('The request appears short and mechanical; verify the result before accepting it.');
  if (repoComplex) { effort = 'high'; reasons.push('Available repository metadata suggests several languages or affected files.'); }
  if (!reasons.length) reasons.push('Difficulty is uncertain; start at medium and use an independent check.');
  const unclamped = effort;
  const index = Math.max(LEVELS.indexOf(minEffort), Math.min(LEVELS.indexOf(maxEffort), LEVELS.indexOf(effort)));
  effort = LEVELS[index];
  if (effort !== unclamped) reasons.push(`Your configured effort bounds changed ${unclamped} to ${effort}.`);
  return { effort, reasons, policyVersion: POLICY_VERSION, confidence: 'low',
    features: { promptCharacters: prompt.length, critical, complex, mechanical, repositoryComplex: repoComplex },
    control: provider === 'generic' ? 'advisory' : 'managed-turns',
    caveat: 'A transparent heuristic, not a trained difficulty model or a measured quality guarantee.' };
}

export function classifyFailure(text = '', { timedOut = false } = {}) {
  if (timedOut) return 'timeout';
  const value = String(text).slice(0, 50_000);
  if (/unauthorized|authentication|invalid.api.key|not.logged.in|login.required|rate.limit|quota|insufficient.credit|usage.limit|out.of.extra.usage/i.test(value)) return 'access';
  if (/permission.denied|operation.not.permitted|EACCES|EPERM|approval.required|permission.request/i.test(value)) return 'permission';
  if (/command.not.found|MODULE_NOT_FOUND|cannot.find.module|ModuleNotFoundError|No module named|ENOENT|ECONNREFUSED|ENOTFOUND|network.unreachable|connection.refused/i.test(value)) return 'environment';
  if (/AssertionError|assertion|ERR_ASSERTION|\bFAIL(?:ED)?\b|\bnot ok\b|expected[\s\S]{0,100}(?:actual|received|but)/i.test(value)) return 'test';
  return 'unknown';
}

export function nextDecision({ effort, kind, repeatCount = 1, maxEffort = 'high', supportedLevels = ['low', 'medium', 'high'] }) {
  validateLevel(effort); validateLevel(maxEffort);
  if (!Array.isArray(supportedLevels) || !supportedLevels.length || supportedLevels.some(x => !LEVELS.includes(x))) throw new Error('Invalid supported effort levels.');
  if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 100) throw new Error('repeatCount must be an integer from 1 to 100.');
  if (!['test','access','permission','environment','timeout','unknown'].includes(kind)) throw new Error('Unknown failure kind.');
  if (kind !== 'test') return { action: 'stop', effort, reason: `${kind} failure: more reasoning is not an established remedy.` };
  if (repeatCount < 2) return { action: 'retry', effort, reason: 'One failed check: retry with the concrete test evidence at the current effort.' };
  const candidate = LEVELS.find(x => supportedLevels.includes(x) && LEVELS.indexOf(x) > LEVELS.indexOf(effort) && LEVELS.indexOf(x) <= LEVELS.indexOf(maxEffort));
  if (!candidate) return { action: 'stop', effort, reason: 'Repeated check failure at the configured effort ceiling; stop for review.' };
  return { action: 'escalate', effort: candidate, reason: 'The same check failed repeatedly; test a higher effort on the next managed turn.' };
}
