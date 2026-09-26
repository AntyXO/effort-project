const $ = (selector) => document.querySelector(selector);
const sessionKey = 'effort.dashboard.token';
const knownStatuses = new Set(['verified', 'unverified', 'blocked', 'failed', 'cancelled']);
let dashboard = null;
let dashboardFingerprint = null;
let refreshPending = false;
let lastRefresh = null;
let lastTaskTrigger = null;
let detailRequest = 0;
let recommendationRequest = 0;
let toastTimeout;

function readToken() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const incoming = fragment.get('token');
  if (fragment.has('token')) {
    fragment.delete('token');
    const rest = fragment.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
    try { sessionStorage.setItem(sessionKey, incoming); } catch { /* This page still works without persistent storage. */ }
    return incoming;
  }
  try { return sessionStorage.getItem(sessionKey); } catch { return null; }
}

const token = readToken();

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}

function present(value, fallback = 'Not recorded') {
  return value !== null && value !== undefined && value !== '' ? String(value) : fallback;
}

function label(value, fallback = 'Not recorded') {
  const text = present(value, fallback).replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replaceAll('-', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function providerName(value) {
  return ({ codex: 'Codex', claude: 'Claude', generic: 'Generic' })[value] || label(value, 'Unknown provider');
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString() : '—';
}

function dateLabel(value, full = false) {
  if (!value) return 'Time not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time not recorded';
  return new Intl.DateTimeFormat(undefined, full
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function shortId(value) {
  const id = present(value, 'Unknown ID');
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

function badge(status) {
  const className = knownStatuses.has(status) ? ` status-${status}` : '';
  return node('span', `status-badge${className}`, label(status, 'Unknown'));
}

function setConnection(state, text) {
  $('#connection').dataset.state = state;
  $('#connection-text').textContent = text;
}

function notice(message = '') {
  $('#status-notice').textContent = message;
  $('#status-notice').hidden = !message;
}

function announce(message) {
  $('#announcements').textContent = message;
}

function toast(message) {
  clearTimeout(toastTimeout);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

async function api(path, options = {}) {
  if (!token) throw new Error('Open the dashboard URL printed by “effort dashboard” to connect to this local session.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      ...options,
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('This local session is not authorized. Reopen the dashboard URL printed by “effort dashboard”.');
    }
    if (response.status === 404) throw new Error('This record is no longer available. Refresh the dashboard to read the current history.');
    if (!response.ok) throw new Error(`The local service could not complete this request (HTTP ${response.status}). Try again.`);
    try { return await response.json(); } catch { throw new Error('The local service returned an unreadable response. Restart the dashboard and try again.'); }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The local service took too long to respond. Check that “effort dashboard” is running, then try again.');
    if (error instanceof TypeError) throw new Error('Cannot reach the local service. Check that “effort dashboard” is running, then refresh.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function makeEmpty(title, description, actionLabel, onAction, symbol = '↳') {
  const empty = node('div', 'empty-state');
  const glyph = node('span', 'empty-symbol', symbol);
  glyph.setAttribute('aria-hidden', 'true');
  empty.append(glyph, node('h3', '', title), node('p', '', description));
  if (actionLabel) {
    const action = node('button', 'text-link', `${actionLabel}  ↗`);
    action.type = 'button';
    action.addEventListener('click', onAction);
    empty.append(action);
  }
  return empty;
}

function renderStats(data) {
  for (const key of ['tasks', 'verified', 'unverified', 'blocked']) {
    $(`#stat-${key}`).textContent = count(data.stats?.[key]);
    $(`#stat-${key}`).setAttribute('aria-label', typeof data.stats?.[key] === 'number' ? String(data.stats[key]) : 'Unavailable');
  }
  $('#stats').setAttribute('aria-busy', 'false');
}

function renderHistory() {
  const container = $('#history-content');
  const focusedRunId = document.activeElement?.dataset?.runId;
  container.setAttribute('aria-busy', 'false');
  container.replaceChildren();
  if (!Array.isArray(dashboard?.tasks)) {
    $('#history-count').textContent = 'Unavailable';
    $('#status-filter').disabled = true;
    container.append(makeEmpty('History is unavailable', 'The local service did not return a task history.', 'Try again', () => refresh()));
    return;
  }
  const tasks = dashboard.tasks;
  const filter = $('#status-filter').value;
  const visible = tasks.filter((task) => task && (filter === 'all' || task.status === filter));
  $('#status-filter').disabled = tasks.length === 0;
  $('#history-count').textContent = filter === 'all' ? `${tasks.length} ${tasks.length === 1 ? 'run' : 'runs'}` : `${visible.length} of ${tasks.length}`;
  if (tasks.length === 0) {
    container.append(makeEmpty('A clean slate.', 'Your managed runs will appear here, along with their effort decisions and verification results.', 'Set up your first run', () => {
      $('#setup').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      $('#command-doctor').parentElement.querySelector('button').focus({ preventScroll: true });
    }));
    return;
  }
  if (visible.length === 0) {
    container.append(makeEmpty('No matching runs', `No recorded runs have the “${label(filter).toLowerCase()}” outcome.`, 'Show all runs', () => {
      $('#status-filter').value = 'all';
      renderHistory();
      $('#status-filter').focus();
    }));
    return;
  }
  const list = node('ul', 'task-list');
  for (const task of visible) {
    const item = node('li', 'task-row');
    const button = node('button', 'task-button');
    button.type = 'button';
    button.dataset.runId = present(task.id, '');
    button.setAttribute('aria-label', `Inspect ${providerName(task.provider)} run ${present(task.id, 'unknown')}, ${label(task.status, 'unknown outcome')}`);
    const information = node('span', 'task-information');
    const name = node('span', 'task-name', providerName(task.provider));
    name.append(node('span', 'task-id', shortId(task.id)));
    const metadata = node('span', 'task-meta');
    const initial = label(task.initialEffort, 'Unknown');
    const current = label(task.effort, 'Unknown');
    metadata.append(node('span', '', initial === current ? current : `${initial} → ${current}`));
    metadata.append(node('span', '', Array.isArray(task.attempts) ? `${task.attempts.length} ${task.attempts.length === 1 ? 'attempt' : 'attempts'}` : 'Attempts unknown'));
    metadata.append(node('span', '', dateLabel(task.createdAt)));
    information.append(name, metadata);
    const outcome = node('span', 'task-outcome');
    outcome.append(badge(task.status), node('span', 'task-open', 'Inspect ↗'));
    button.append(information, outcome);
    button.addEventListener('click', () => openTask(task.id, button));
    item.append(button);
    list.append(item);
  }
  container.append(list);
  if (focusedRunId) {
    for (const button of list.querySelectorAll('button')) {
      if (button.dataset.runId === focusedRunId) {
        button.focus({ preventScroll: true });
        break;
      }
    }
  }
}

function renderCapabilities(capabilities) {
  const container = $('#compatibility-list');
  container.setAttribute('aria-busy', 'false');
  container.replaceChildren();
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    container.append(node('p', 'muted compatibility-loading', 'Provider capabilities are unavailable. Run “effort doctor” to inspect your environment.'));
    return;
  }
  for (const capability of capabilities) {
    if (!capability || typeof capability !== 'object') continue;
    const row = node('article', 'capability');
    const name = node('div', 'capability-name');
    const glyph = node('span', 'capability-icon', capability.id === 'codex' ? '>_' : capability.id === 'claude' ? '✳' : '↗');
    glyph.setAttribute('aria-hidden', 'true');
    name.append(glyph, node('span', '', present(capability.name, providerName(capability.id))));
    const control = node('div');
    control.append(node('p', 'capability-control', label(capability.control, 'Control not specified')));
    const levels = Array.isArray(capability.levels) && capability.levels.length ? capability.levels.map((level) => present(level)).join(' · ') : 'Levels not specified';
    control.append(node('p', 'capability-levels', levels));
    const notes = Array.isArray(capability.notes) ? capability.notes.join(' ') : present(capability.notes, 'No additional capability notes.');
    row.append(name, control, node('p', 'capability-notes', notes));
    container.append(row);
  }
}

async function refresh({ silent = false } = {}) {
  if (refreshPending) return;
  refreshPending = true;
  $('#refresh-button').disabled = true;
  $('#refresh-button').setAttribute('aria-busy', 'true');
  try {
    const result = await api('/api/status');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The local service returned an incomplete dashboard response. Try refreshing.');
    const fingerprint = JSON.stringify(result);
    const changed = fingerprint !== dashboardFingerprint;
    dashboard = result;
    lastRefresh = new Date();
    if (changed) {
      renderStats(result);
      renderHistory();
      renderCapabilities(result.capabilities);
      dashboardFingerprint = fingerprint;
    }
    $('#policy-label').textContent = result.policyVersion ? `Policy ${result.policyVersion}` : 'Policy version unavailable';
    $('#version-label').textContent = result.version ? `THE EFFORT PROJECT / v${result.version}` : 'THE EFFORT PROJECT / version unavailable';
    setConnection('connected', 'Local session');
    $('#connection').title = `Updated ${dateLabel(lastRefresh, true)}`;
    notice();
    if (!silent) announce(`Local history refreshed. ${Array.isArray(result.tasks) ? result.tasks.length : 'Unknown number of'} recent runs.`);
  } catch (error) {
    setConnection('error', token ? 'Disconnected' : 'Session needed');
    notice(`${error.message}${lastRefresh ? ` Showing the last successful update from ${dateLabel(lastRefresh, true)}.` : ''}`);
    if (!dashboard) {
      $('#stats').setAttribute('aria-busy', 'false');
      $('#history-count').textContent = 'Unavailable';
      $('#history-content').setAttribute('aria-busy', 'false');
      $('#history-content').replaceChildren(makeEmpty('Connect to your local session', 'Keep the dashboard process running, then open the local URL it prints in your terminal.', 'Try again', () => refresh(), '↗'));
      renderCapabilities(null);
    }
  } finally {
    refreshPending = false;
    $('#refresh-button').disabled = false;
    $('#refresh-button').setAttribute('aria-busy', 'false');
  }
}

function renderRecommendation(result) {
  const container = $('#recommendation');
  container.replaceChildren();
  if (!result || typeof result !== 'object' || !result.effort) throw new Error('The local policy returned an incomplete recommendation. Please try again.');
  const head = node('div', 'recommendation-head');
  const left = node('div');
  left.append(node('p', 'recommendation-kicker', 'Suggested starting effort'), node('p', 'effort-value', label(result.effort)));
  const confidence = node('span', 'confidence', result.confidence ? `${label(result.confidence)} confidence` : 'Confidence unavailable');
  head.append(left, confidence);
  container.append(head);
  const reasons = Array.isArray(result.reasons) ? result.reasons : [];
  if (reasons.length) {
    const list = node('ul', 'reasons-list');
    for (const reason of reasons) list.append(node('li', '', reason));
    container.append(list);
  } else {
    container.append(node('p', 'field-help', 'The policy did not supply a reason for this recommendation.'));
  }
  const control = result.control ? `${label(result.control)}. ` : '';
  const policy = result.policyVersion ? `Policy ${result.policyVersion}. ` : '';
  container.append(node('p', 'recommendation-note', `${control}${policy}This is a starting estimate, not a guarantee of difficulty or outcome.`));
  container.dataset.state = 'ready';
}

function resetRecommendation() {
  recommendationRequest += 1;
  if ($('#recommendation').dataset.state === 'idle') return;
  const idle = node('div', 'recommendation-idle');
  const glyph = node('span', 'idle-glyph', '↳');
  glyph.setAttribute('aria-hidden', 'true');
  const description = node('p', '', 'Ready to assess.');
  description.append(node('br'), node('span', '', 'Choose “Recommend effort” to see the reasoning.'));
  idle.append(glyph, description);
  $('#recommendation').replaceChildren(idle);
  $('#recommendation').dataset.state = 'idle';
}

$('#recommend-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const prompt = $('#task-prompt').value.trim();
  if (!prompt) {
    $('#task-prompt').setCustomValidity('Describe a task to get a recommendation.');
    $('#task-prompt').reportValidity();
    return;
  }
  const provider = new FormData(form).get('provider');
  const requestId = ++recommendationRequest;
  $('#recommend-button').disabled = true;
  $('#recommend-button-label').textContent = 'Assessing locally…';
  $('#recommendation').setAttribute('aria-busy', 'true');
  $('#recommendation').dataset.state = 'pending';
  $('#recommendation').replaceChildren(node('p', 'field-help', 'Reading the task against the local effort policy…'));
  try {
    const result = await api('/api/recommend', { method: 'POST', body: JSON.stringify({ prompt, provider }) });
    if (requestId !== recommendationRequest) return;
    renderRecommendation(result);
  } catch (error) {
    if (requestId !== recommendationRequest) return;
    const message = node('p', 'recommendation-error', error.message);
    message.setAttribute('role', 'alert');
    $('#recommendation').replaceChildren(message);
    $('#recommendation').dataset.state = 'error';
  } finally {
    $('#recommendation').setAttribute('aria-busy', 'false');
    $('#recommend-button').disabled = false;
    $('#recommend-button-label').textContent = 'Recommend effort';
  }
});

$('#task-prompt').addEventListener('input', () => {
  $('#task-prompt').setCustomValidity('');
  resetRecommendation();
});
for (const input of document.querySelectorAll('input[name="provider"]')) {
  input.addEventListener('change', resetRecommendation);
}

function addDefinition(list, term, value) {
  const group = node('div');
  group.append(node('dt', '', term));
  const description = node('dd');
  if (value instanceof Node) description.append(value);
  else description.textContent = value;
  group.append(description);
  list.append(group);
}

function usageLabel(value, suffix = 'tokens') {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value.toLocaleString()} ${suffix}` : 'Not reported';
}

function evidenceLabel(evidence) {
  if (typeof evidence === 'string') return evidence;
  if (!evidence || typeof evidence !== 'object') return 'Effort evidence was not recorded.';
  return Object.entries(evidence).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => `${label(key)}: ${value}`).join(' · ') || 'Effort evidence was not recorded.';
}

function renderTask(task) {
  const container = $('#task-dialog-content');
  container.replaceChildren();
  $('#task-dialog-title').textContent = `${providerName(task.provider)} run ${shortId(task.id)}`;
  const summary = node('dl', 'task-summary');
  addDefinition(summary, 'Outcome', badge(task.status));
  addDefinition(summary, 'Model', present(task.model));
  addDefinition(summary, 'Created', dateLabel(task.createdAt, true));
  addDefinition(summary, 'Initial effort', label(task.initialEffort));
  addDefinition(summary, 'Latest effort', label(task.effort));
  addDefinition(summary, 'Run ID', present(task.id));
  container.append(summary);
  container.append(node('p', 'detail-note', 'The history records decisions and outcomes. Task prompts, code, and command output are not shown here.'));
  container.append(node('h3', 'detail-heading', 'Effort decisions'));
  if (Array.isArray(task.decisions) && task.decisions.length) {
    const decisions = node('ol', 'decision-list');
    for (const decision of task.decisions) {
      const item = node('li');
      item.append(node('strong', '', `${label(decision.effort)}. `), document.createTextNode(present(decision.reason, 'No reason recorded.')));
      decisions.append(item);
    }
    container.append(decisions);
  } else {
    container.append(node('p', 'detail-note', 'No effort decisions were recorded.'));
  }
  container.append(node('h3', 'detail-heading', 'Attempts & verification'));
  if (Array.isArray(task.attempts) && task.attempts.length) {
    const attempts = node('ol', 'attempt-list');
    task.attempts.forEach((attempt, index) => {
      const item = node('li', 'attempt');
      const header = node('div', 'attempt-header');
      header.append(node('h4', '', `Attempt ${present(attempt.number, index + 1)} · ${label(attempt.effort, 'Effort not recorded')}`), badge(attempt.status));
      const details = node('dl', 'attempt-details');
      const verification = attempt.verification;
      addDefinition(details, 'Verification', verification ? `${label(verification.status, 'Not recorded')}${verification.kind ? ` · ${label(verification.kind)}` : ''}` : 'Not recorded');
      addDefinition(details, 'Verification exit code', typeof verification?.exitCode === 'number' ? String(verification.exitCode) : 'Not recorded');
      addDefinition(details, 'Input / output', `${usageLabel(attempt.usage?.inputTokens)} / ${usageLabel(attempt.usage?.outputTokens)}`);
      addDefinition(details, 'Cached input', usageLabel(attempt.usage?.cachedInputTokens));
      addDefinition(details, 'Reported cost', typeof attempt.usage?.costUsd === 'number' && Number.isFinite(attempt.usage.costUsd) && attempt.usage.costUsd >= 0 ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 5 }).format(attempt.usage.costUsd) : 'Not reported');
      addDefinition(details, 'Duration', typeof attempt.durationMs === 'number' && Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0 ? `${(attempt.durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} seconds` : 'Not recorded');
      item.append(header, details, node('p', 'attempt-evidence', evidenceLabel(attempt.effortEvidence)));
      attempts.append(item);
    });
    container.append(attempts);
  } else {
    container.append(node('p', 'detail-note', 'No attempts were recorded.'));
  }
  container.append(node('p', 'detail-note', 'A passing verification result applies only to the selected command. Missing token or cost data means it was not reported; it does not mean usage was free.'));
}

async function openTask(id, trigger) {
  const requestId = ++detailRequest;
  lastTaskTrigger = trigger;
  $('#task-dialog-title').textContent = `Run ${shortId(id)}`;
  $('#task-dialog-content').replaceChildren(node('p', '', 'Reading this run’s evidence…'));
  $('#task-dialog-content').setAttribute('aria-busy', 'true');
  $('#task-dialog').showModal();
  $('#dialog-close').focus();
  try {
    const task = await api(`/api/tasks/${encodeURIComponent(present(id, ''))}`);
    if (requestId !== detailRequest) return;
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('This task record could not be read.');
    renderTask(task);
  } catch (error) {
    if (requestId !== detailRequest) return;
    const errorText = node('p', 'recommendation-error', error.message);
    errorText.setAttribute('role', 'alert');
    $('#task-dialog-content').replaceChildren(errorText);
  } finally {
    if (requestId === detailRequest) $('#task-dialog-content').setAttribute('aria-busy', 'false');
  }
}

$('#dialog-close').addEventListener('click', () => $('#task-dialog').close());
$('#task-dialog').addEventListener('close', () => {
  detailRequest += 1;
  if (lastTaskTrigger?.isConnected) lastTaskTrigger.focus();
});
$('#status-filter').addEventListener('change', () => {
  renderHistory();
  announce(`Showing ${$('#status-filter').value === 'all' ? 'all outcomes' : `${$('#status-filter').value} runs`}.`);
});
$('#refresh-button').addEventListener('click', () => refresh());

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const command = document.getElementById(button.dataset.copy)?.textContent;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = 'Copied';
      toast('Command copied.');
      setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(button.dataset.copy));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      toast('Copy was unavailable. The command is selected for manual copying.');
    }
  });
}

function updateNavigation() {
  const links = [...document.querySelectorAll('.section-nav a')];
  const activeHash = links.some((link) => link.getAttribute('href') === location.hash) ? location.hash : '#history';
  for (const link of links) {
    const current = link.getAttribute('href') === activeHash;
    link.classList.toggle('nav-current', current);
    if (current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

window.addEventListener('hashchange', updateNavigation);
updateNavigation();
refresh();
setInterval(() => {
  if (document.visibilityState === 'visible' && !$('#task-dialog').open && token) refresh({ silent: true });
}, 20000);
