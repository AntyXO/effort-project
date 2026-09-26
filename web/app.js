const $ = (selector) => document.querySelector(selector);
const sessionKey = 'effort.dashboard.token';
const isLocalFile = window.location.protocol === 'file:';
const knownStatuses = new Set(['verified', 'unverified', 'blocked', 'failed', 'cancelled']);
let dashboard = null;
let dashboardFingerprint = null;
let refreshPending = false;
let refreshQueued = false;
let sessionRevision = 0;
let lastRefresh = null;
let lastTaskTrigger = null;
let detailRequest = 0;
let recommendationRequest = 0;
let toastTimeout;
let initialLayoutSet = false;
let userInteracted = false;

for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  document.addEventListener(event, () => { userInteracted = true; }, { once: true, capture: true, passive: true });
}

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

let token = readToken();

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
  return ({ codex: 'Codex', claude: 'Claude', generic: 'Other tools' })[value] || label(value, 'Unknown provider');
}

function effortTransition(task) {
  const initial = task.initialEffort ? label(task.initialEffort) : null;
  const latest = task.effort ? label(task.effort) : null;
  if (initial && latest) return initial === latest ? latest : `${initial} to ${latest}`;
  return latest || (initial ? `${initial} initially` : null);
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
  if (isLocalFile) throw new Error('Start the local dashboard with “npm start”, then open the HTTP URL it prints. This file preview cannot connect to local history.');
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

function makeEmpty(title, description, actionLabel, onAction) {
  const empty = node('div', 'empty-state');
  empty.append(node('h3', '', title), node('p', '', description));
  if (actionLabel) {
    const action = node('button', 'text-link', actionLabel);
    action.type = 'button';
    action.addEventListener('click', onAction);
    empty.append(action);
  }
  return empty;
}

function setHistoryState(tasks) {
  const state = Array.isArray(tasks) ? (tasks.length ? 'populated' : 'empty') : 'error';
  $('#main').dataset.historyState = state;
  if (initialLayoutSet || state === 'error') return;
  initialLayoutSet = true;
  if (userInteracted) return;
  const grid = $('#work-grid');
  const firstPanel = state === 'empty' ? $('#sandbox') : $('#history');
  if (grid && firstPanel?.parentElement === grid && grid.firstElementChild !== firstPanel) {
    grid.prepend(firstPanel);
  }
  if (![...document.querySelectorAll('.section-nav a')].some((link) => link.getAttribute('href') === location.hash)) {
    updateNavigation(`#${firstPanel.id}`);
  }
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
    container.append(makeEmpty('No managed runs yet', 'Runs started from the CLI will appear here with their effort decisions and verification results.', 'Set up your first run', () => {
      history.pushState(null, '', '#setup');
      navigationTarget = '#setup';
      updateNavigation('#setup');
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
    const provider = providerName(task.provider);
    const created = dateLabel(task.createdAt);
    button.setAttribute('aria-label', `Inspect ${provider}${task.model ? ` ${task.model}` : ''} run${created !== 'Time not recorded' ? ` from ${created}` : ''}, ${label(task.status, 'unknown outcome')}${task.id ? `, run ID ${shortId(task.id)}` : ''}`);
    const information = node('span', 'task-information');
    const name = node('span', 'task-name');
    if (task.model) name.append(node('span', 'task-model', task.model));
    name.append(node('span', 'task-provider', provider));
    const metadata = node('span', 'task-meta');
    if (created !== 'Time not recorded') metadata.append(node('span', 'task-time', created));
    const effort = effortTransition(task);
    if (effort) metadata.append(node('span', '', `Effort: ${effort}`));
    if (Array.isArray(task.attempts)) metadata.append(node('span', '', `${task.attempts.length} ${task.attempts.length === 1 ? 'attempt' : 'attempts'}`));
    information.append(name, metadata);
    if (task.id) information.append(node('span', 'task-id', `Run ${shortId(task.id)}`));
    const outcome = node('span', 'task-outcome');
    outcome.append(badge(task.status), node('span', 'task-open', 'Inspect'));
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
    name.append(node('span', '', present(capability.name, providerName(capability.id))));
    const control = node('div');
    const summary = capability.control === 'managed-turns'
      ? 'Managed CLI runs can set effort between attempts.'
      : capability.control === 'advisory'
        ? 'Offers advice only; host settings stay unchanged.'
        : label(capability.control, 'Control not specified');
    control.append(node('p', 'capability-summary', summary));
    const levels = Array.isArray(capability.levels) && capability.levels.length ? capability.levels.map((level) => present(level)).join(' · ') : 'Levels not specified';
    control.append(node('p', 'capability-levels', `Effort levels: ${levels}`));
    const notes = Array.isArray(capability.notes) ? capability.notes.join(' ') : present(capability.notes, 'No additional capability notes.');
    const details = node('details', 'capability-details');
    details.append(node('summary', '', 'Integration details'), node('p', 'capability-control', label(capability.control, 'Control not specified')), node('p', 'capability-notes', notes));
    row.append(name, control, details);
    container.append(row);
  }
}

async function refresh({ silent = false } = {}) {
  if (refreshPending) {
    if (!silent) refreshQueued = true;
    return;
  }
  refreshPending = true;
  const requestSession = sessionRevision;
  $('#refresh-button').disabled = true;
  $('#refresh-button').setAttribute('aria-busy', 'true');
  try {
    const result = await api('/api/status');
    if (requestSession !== sessionRevision) return;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The local service returned an incomplete dashboard response. Try refreshing.');
    const fingerprint = JSON.stringify(result);
    const changed = fingerprint !== dashboardFingerprint;
    const capabilitiesChanged = !dashboard || JSON.stringify(result.capabilities) !== JSON.stringify(dashboard.capabilities);
    dashboard = result;
    lastRefresh = new Date();
    setHistoryState(result.tasks);
    if (changed) {
      renderStats(result);
      renderHistory();
      if (capabilitiesChanged) renderCapabilities(result.capabilities);
      dashboardFingerprint = fingerprint;
    }
    $('#policy-label').textContent = result.policyVersion ? `Policy ${result.policyVersion}` : 'Policy version unavailable';
    $('#version-label').textContent = result.version ? `THE EFFORT PROJECT / v${result.version}` : 'THE EFFORT PROJECT / version unavailable';
    setConnection('connected', 'Local session');
    $('#connection').title = `Updated ${dateLabel(lastRefresh, true)}`;
    if ($('#last-updated')) $('#last-updated').textContent = `Updated ${dateLabel(lastRefresh, true)}`;
    notice();
    if (!silent) announce(`Local history refreshed. ${Array.isArray(result.tasks) ? result.tasks.length : 'Unknown number of'} recent runs.`);
  } catch (error) {
    if (requestSession !== sessionRevision) return;
    $('#main').dataset.historyState = 'error';
    setConnection('error', token ? 'Disconnected' : 'Session needed');
    notice(`${error.message}${lastRefresh ? ` Showing the last successful update from ${dateLabel(lastRefresh, true)}.` : ''}`);
    if (!dashboard) {
      $('#stats').setAttribute('aria-busy', 'false');
      $('#history-count').textContent = 'Unavailable';
      $('#history-content').setAttribute('aria-busy', 'false');
      $('#history-content').replaceChildren(makeEmpty('Connect to your local session', 'Keep the dashboard process running, then open the local URL it prints in your terminal.', 'Try again', () => refresh()));
      renderCapabilities(null);
    }
  } finally {
    refreshPending = false;
    $('#refresh-button').disabled = false;
    $('#refresh-button').setAttribute('aria-busy', 'false');
    if (refreshQueued) {
      refreshQueued = false;
      refresh();
    }
  }
}

function renderRecommendation(result, provider) {
  const container = $('#recommendation');
  container.replaceChildren();
  if (!result || typeof result !== 'object' || !result.effort) throw new Error('The local policy returned an incomplete recommendation. Please try again.');
  const head = node('div', 'recommendation-head');
  const left = node('div');
  left.append(node('h3', 'effort-value', `Start at ${label(result.effort)}`));
  const confidence = node('span', 'confidence', result.confidence ? `Rule estimate · ${label(result.confidence)} confidence` : 'Rule estimate · Confidence unavailable');
  head.append(left, confidence);
  container.append(head);
  container.append(node('p', 'confidence-note', 'This policy uses fixed rules, not a trained predictor. Confidence is uncalibrated; it does not estimate the chance of success.'));
  const reasons = Array.isArray(result.reasons) ? result.reasons : [];
  if (reasons.length) {
    const list = node('ul', 'reasons-list');
    for (const reason of reasons) list.append(node('li', '', reason));
    container.append(list);
  } else {
    container.append(node('p', 'field-help', 'The policy did not supply a reason for this recommendation.'));
  }
  const control = result.control ? `${label(result.control)} recommendation. ` : '';
  const policy = result.policyVersion ? `Policy ${result.policyVersion}. ` : '';
  container.append(node('p', 'recommendation-note', `${control}No settings changed. ${policy}This is a starting estimate, not a guarantee of difficulty or outcome.`));
  const supportedCLI = ['codex', 'claude'].includes(provider) && ['low', 'medium', 'high'].includes(result.effort);
  container.append(node('p', 'recommendation-handoff', supportedCLI
    ? `For desktop use, choose ${label(result.effort)} in your app’s effort selector, if supported. Effort cannot change that setting.`
    : 'Apply this advice manually only if your host supports the suggested level. Effort does not assume an effort mapping for other tools.'));
  if (supportedCLI) {
    const next = node('details', 'recommendation-next');
    next.append(node('summary', '', 'Use this recommendation'));
    next.append(node('p', '', 'Read-only CLI example: replace the task and repository path before running. Without an independent verification command, the run is unverified.'));
    const commandBox = node('div', 'command-box');
    const command = node('code', '', `effort run "YOUR TASK HERE" --provider ${provider} --cwd /path/to/repo --effort ${result.effort}`);
    command.id = 'recommendation-command';
    const copy = node('button', 'copy-button', 'Copy');
    copy.type = 'button';
    copy.dataset.copy = command.id;
    copy.setAttribute('aria-label', 'Copy read-only CLI recommendation example');
    commandBox.append(command, copy);
    next.append(commandBox);
    container.append(next);
  }
  container.dataset.state = 'ready';
}

function resetRecommendation() {
  recommendationRequest += 1;
  if ($('#recommendation').dataset.state === 'idle') return;
  const idle = node('div', 'recommendation-idle');
  const description = node('p', '', 'Ready to assess.');
  description.append(node('br'), node('span', '', 'Choose “Recommend effort” to see the reasoning.'));
  idle.append(description);
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
    renderRecommendation(result, provider);
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
  $('#task-dialog-title').textContent = `${providerName(task.provider)} run${task.model ? ` · ${task.model}` : ''}`;
  const summary = node('dl', 'task-summary');
  addDefinition(summary, 'Outcome', badge(task.status));
  addDefinition(summary, 'Model', present(task.model));
  addDefinition(summary, 'Created', dateLabel(task.createdAt, true));
  addDefinition(summary, 'Effort', effortTransition(task) || 'Not recorded');
  container.append(summary);
  container.append(node('p', 'detail-note', 'The history records decisions and outcomes. Task prompts, code, and command output are not shown here.'));
  container.append(node('h3', 'detail-heading', 'Attempts & verification'));
  if (Array.isArray(task.attempts) && task.attempts.length) {
    const attempts = node('ol', 'attempt-list');
    task.attempts.forEach((attempt, index) => {
      const item = node('li', 'attempt');
      const header = node('div', 'attempt-header');
      header.append(node('h4', '', `Attempt ${present(attempt.number, index + 1)} · ${label(attempt.effort, 'Effort not recorded')}`), badge(attempt.status));
      const verification = attempt.verification;
      const checkResult = verification ? `${label(verification.status, 'Not recorded')}${verification.kind ? ` · ${label(verification.kind)}` : ''}` : 'Not recorded';
      item.append(header, node('p', 'attempt-result', `Verification: ${checkResult}`));
      const telemetry = node('details', 'attempt-telemetry');
      telemetry.append(node('summary', '', 'Usage, timing, and evidence'));
      const details = node('dl', 'attempt-details');
      addDefinition(details, 'Verification exit code', typeof verification?.exitCode === 'number' ? String(verification.exitCode) : 'Not recorded');
      addDefinition(details, 'Input / output', `${usageLabel(attempt.usage?.inputTokens)} / ${usageLabel(attempt.usage?.outputTokens)}`);
      addDefinition(details, 'Cached input', usageLabel(attempt.usage?.cachedInputTokens));
      addDefinition(details, 'Reported cost', typeof attempt.usage?.costUsd === 'number' && Number.isFinite(attempt.usage.costUsd) && attempt.usage.costUsd >= 0 ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 5 }).format(attempt.usage.costUsd) : 'Not reported');
      addDefinition(details, 'Duration', typeof attempt.durationMs === 'number' && Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0 ? `${(attempt.durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} seconds` : 'Not recorded');
      telemetry.append(details, node('p', 'attempt-evidence', evidenceLabel(attempt.effortEvidence)));
      item.append(telemetry);
      attempts.append(item);
    });
    container.append(attempts);
  } else {
    container.append(node('p', 'detail-note', 'No attempts were recorded.'));
  }
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
  const record = node('details', 'run-record');
  record.append(node('summary', '', 'Run record details'));
  const identifiers = node('dl', 'attempt-details');
  addDefinition(identifiers, 'Run ID', present(task.id));
  addDefinition(identifiers, 'Initial effort', label(task.initialEffort));
  addDefinition(identifiers, 'Latest effort', label(task.effort));
  record.append(identifiers);
  container.append(record);
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

document.addEventListener('click', async (event) => {
  const button = event.target instanceof Element ? event.target.closest('button[data-copy]') : null;
  if (!button) return;
  const commandElement = document.getElementById(button.dataset.copy);
  const command = commandElement?.textContent;
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    button.textContent = 'Copied';
    toast('Command copied.');
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  } catch {
    if (!commandElement.isConnected) {
      toast('The example changed. Open the current command and try copying again.');
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(commandElement);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('Copy was unavailable. The command is selected for manual copying.');
  }
});

let activeSection = null;
let navigationTarget = null;

for (const event of ['wheel', 'touchstart']) {
  window.addEventListener(event, () => { navigationTarget = null; }, { passive: true });
}
window.addEventListener('keydown', (event) => {
  if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) navigationTarget = null;
});

function updateNavigation(hash = location.hash) {
  const links = [...document.querySelectorAll('.section-nav a')];
  const firstPanel = $('#work-grid')?.firstElementChild;
  const activeHash = links.some((link) => link.getAttribute('href') === hash) ? hash : `#${firstPanel?.id || 'sandbox'}`;
  activeSection = activeHash;
  for (const link of links) {
    const current = link.getAttribute('href') === activeHash;
    link.classList.toggle('nav-current', current);
    if (current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

for (const link of document.querySelectorAll('.section-nav a')) {
  link.addEventListener('click', () => {
    navigationTarget = link.getAttribute('href');
    updateNavigation(navigationTarget);
  });
}
window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).has('token')) {
    const nextToken = readToken();
    if (!isLocalFile) {
      if (nextToken !== token) {
        token = nextToken;
        sessionRevision += 1;
        resetRecommendation();
        detailRequest += 1;
        if ($('#task-dialog').open) $('#task-dialog').close();
      }
      refresh();
    }
  }
  navigationTarget = [...document.querySelectorAll('.section-nav a')].some((link) => link.getAttribute('href') === location.hash) ? location.hash : null;
  updateNavigation();
});
updateNavigation();
if ('IntersectionObserver' in window) {
  const visibleSections = new Set();
  const sections = [...document.querySelectorAll('.section-nav a')].map((link) => document.getElementById(link.getAttribute('href').slice(1))).filter(Boolean);
  const resetNavigationAtTop = () => {
    if (navigationTarget || visibleSections.size || window.scrollY > 0) return;
    const firstPanel = $('#work-grid')?.firstElementChild;
    if (firstPanel) updateNavigation(`#${firstPanel.id}`);
  };
  const updateVisibleNavigation = (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleSections.add(entry.target);
      else visibleSections.delete(entry.target);
    }
    const visible = sections.filter((section) => visibleSections.has(section));
    if (navigationTarget) {
      if (!visible.some((section) => `#${section.id}` === navigationTarget)) return;
      updateNavigation(navigationTarget);
      navigationTarget = null;
      return;
    }
    if (visible.some((section) => `#${section.id}` === activeSection)) return;
    visible.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    if (visible.length) updateNavigation(`#${visible[0].id}`);
    else resetNavigationAtTop();
  };
  let observer;
  let resizeFrame = 0;
  const observeSections = () => {
    observer?.disconnect();
    visibleSections.clear();
    const height = Math.max(1, document.documentElement.clientHeight);
    const topInset = Math.floor(height * .15);
    const bottomInset = Math.floor(height * .65);
    observer = new IntersectionObserver(updateVisibleNavigation, {
      rootMargin: `-${topInset}px 0px -${bottomInset}px 0px`,
      threshold: 0,
    });
    for (const section of sections) observer.observe(section);
  };
  window.addEventListener('resize', () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      observeSections();
    });
  }, { passive: true });
  window.addEventListener('scroll', resetNavigationAtTop, { passive: true });
  observeSections();
}
if (isLocalFile) {
  $('#main').dataset.historyState = 'preview';
  if ($('#local-file-help')) $('#local-file-help').hidden = false;
  setConnection('preview', 'Preview only');
  $('#refresh-button').disabled = true;
  $('#refresh-button').setAttribute('aria-busy', 'false');
  for (const control of $('#recommend-form').elements) control.disabled = true;
  $('#stats').setAttribute('aria-busy', 'false');
  $('#history-count').textContent = 'Not connected';
  $('#last-updated').textContent = 'Start the local dashboard to read history';
  $('#history-content').setAttribute('aria-busy', 'false');
  $('#history-content').replaceChildren(makeEmpty('History needs a local connection', 'Start the local dashboard from your terminal, then open the HTTP URL it prints to read your run history.'));
  $('#recommendation').dataset.state = 'preview';
  $('#recommendation').replaceChildren(node('p', 'recommendation-idle', 'Recommendations become available when you open the running local dashboard.'));
  $('#compatibility-list').setAttribute('aria-busy', 'false');
  $('#compatibility-list').replaceChildren(node('p', 'muted compatibility-loading', 'Provider capabilities appear when the local dashboard starts.'));
  $('#policy-label').textContent = 'Local server required';
} else {
  refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible' && !$('#task-dialog').open && token) refresh({ silent: true });
  }, 20000);
}
