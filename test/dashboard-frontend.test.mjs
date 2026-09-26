import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const emptyDashboard = { tasks: [], stats: { tasks: 0, verified: 0, unverified: 0, blocked: 0 }, capabilities: [], version: 'test', policyVersion: 'test' };
const response = (status = 200, value = emptyDashboard) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
const settled = () => new Promise((resolve) => setImmediate(resolve));

// Execute the shipped classic script; this small DOM covers bootstrap and session
// behavior only. Layout, native controls, and accessibility need browser checks.
function dashboard({ url = 'http://127.0.0.1:43210/', storage = new Map(), fetchResponse = async () => response() } = {}) {
  class Element {
    constructor(tag = 'div', id = '') {
      this.tagName = tag;
      this.id = id;
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.listeners = new Map();
      this.classList = { toggle() {} };
      this.disabled = false;
      this.hidden = false;
      this.value = '';
      this.open = false;
    }
    get firstElementChild() { return this.children[0]; }
    get textContent() { return this.text ?? this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.text = String(value); this.children = []; }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    prepend(child) { this.children = this.children.filter((item) => item !== child); child.parentElement = this; this.children.unshift(child); }
    replaceChildren(...children) { this.text = undefined; this.children = []; this.append(...children); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    querySelectorAll() { return []; }
  }
  const ids = ['main', 'work-grid', 'sandbox', 'history', 'compatibility', 'setup', 'refresh-button', 'connection', 'connection-text', 'stats', 'stat-tasks', 'stat-verified', 'stat-unverified', 'stat-blocked', 'history-count', 'history-content', 'status-filter', 'status-notice', 'last-updated', 'policy-label', 'version-label', 'announcements', 'recommend-form', 'recommend-button', 'recommend-button-label', 'task-prompt', 'recommendation', 'compatibility-list', 'task-dialog', 'dialog-close', 'local-file-help'];
  const elements = new Map(ids.map((id) => [id, new Element('div', id)]));
  elements.get('work-grid').append(elements.get('sandbox'), elements.get('history'));
  elements.get('recommendation').dataset.state = 'idle';
  elements.get('connection-text').textContent = 'Connecting';
  elements.get('stat-tasks').textContent = '—';
  elements.get('local-file-help').hidden = true;
  elements.get('status-filter').value = 'all';
  const providers = ['codex', 'claude', 'generic'].map((provider) => Object.assign(new Element('input'), { value: provider }));
  elements.get('recommend-form').elements = [...providers, elements.get('task-prompt'), elements.get('recommend-button')];
  const links = ['sandbox', 'history', 'compatibility', 'setup'].map((id) => { const link = new Element('a'); link.setAttribute('href', `#${id}`); return link; });
  const location = new URL(url);
  const listeners = new Map();
  const requests = [];
  const intervals = [];
  const context = vm.createContext({
    URLSearchParams, AbortController, Intl, Date, Element, Node: Element,
    location,
    window: { location, addEventListener: (event, callback) => listeners.set(event, callback) },
    document: {
      visibilityState: 'visible', activeElement: null,
      querySelector: (selector) => elements.get(selector.slice(1)) ?? null,
      querySelectorAll: (selector) => selector === '.section-nav a' ? links : selector === 'input[name="provider"]' ? providers : [],
      getElementById: (id) => elements.get(id),
      createElement: (tag) => new Element(tag),
      addEventListener() {},
    },
    history: { replaceState: (_state, _title, path) => { location.href = new URL(path, location).href; } },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    fetch: (path, options) => { requests.push({ path, options }); return fetchResponse(path, options); },
    setTimeout: () => 1, clearTimeout() {},
    setInterval: (callback) => { intervals.push(callback); return intervals.length; },
  });
  new vm.Script(source, { filename: 'web/app.js' }).runInContext(context);
  return { elements, requests, intervals, storage, location, context, navigateHash(hash) { location.hash = hash; listeners.get('hashchange')(); } };
}

test('the HTML loads sibling assets and a deferred classic script from a file URL', async () => {
  const indexURL = new URL('../web/index.html', import.meta.url);
  const markup = await readFile(indexURL, 'utf8');
  const stylesheet = markup.match(/<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+)"[^>]*>/);
  const script = markup.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/);
  assert.ok(stylesheet, 'stylesheet reference exists');
  assert.ok(script, 'script reference exists');
  assert.equal(new URL(stylesheet[1], indexURL).href, new URL('../web/style.css', import.meta.url).href);
  assert.equal(new URL(script[1], indexURL).href, new URL('../web/app.js', import.meta.url).href);
  assert.match(script[0], /\bdefer(?:\s|>|=)/);
  assert.doesNotMatch(script[0], /\btype=["']module["']/);
  await Promise.all([readFile(new URL(stylesheet[1], indexURL)), readFile(new URL(script[1], indexURL))]);
});

test('file preview has no API requests or polling and clearly disables server actions', async () => {
  const app = dashboard({ url: 'file:///example/effort-project/web/index.html' });
  await settled();
  assert.equal(app.requests.length, 0);
  assert.equal(app.intervals.length, 0);
  assert.equal(app.elements.get('main').dataset.historyState, 'preview');
  assert.equal(app.elements.get('local-file-help').hidden, false);
  assert.equal(app.elements.get('connection-text').textContent, 'Preview only');
  assert.equal(app.elements.get('refresh-button').disabled, true);
  assert.ok(app.elements.get('recommend-form').elements.every((element) => element.disabled));
  assert.equal(app.elements.get('stats').getAttribute('aria-busy'), 'false');
  assert.equal(app.elements.get('history-content').getAttribute('aria-busy'), 'false');
  assert.match(app.elements.get('history-content').textContent, /History needs a local connection/);
  app.navigateHash('#token=unused-in-file-preview');
  await settled();
  assert.equal(app.requests.length, 0);
  assert.equal(app.elements.get('recommendation').dataset.state, 'preview');
});

test('HTTP bootstrap consumes the token and an ordinary reload retains its session', async () => {
  const first = dashboard({ url: 'http://127.0.0.1:43210/#token=first-session' });
  await settled();
  assert.equal(first.location.hash, '');
  assert.equal(first.requests[0].options.headers.Authorization, 'Bearer first-session');
  const reloaded = dashboard({ storage: first.storage });
  await settled();
  assert.equal(reloaded.requests[0].options.headers.Authorization, 'Bearer first-session');
  assert.equal(reloaded.elements.get('connection-text').textContent, 'Local session');
});

test('opening an access URL in an existing unauthenticated tab reconnects without losing its draft', async () => {
  const app = dashboard();
  await settled();
  assert.equal(app.elements.get('connection-text').textContent, 'Session needed');
  app.elements.get('task-prompt').value = 'Keep this draft';
  app.navigateHash('#token=new-session');
  await settled();
  assert.equal(app.requests.at(-1).options.headers.Authorization, 'Bearer new-session');
  assert.equal(app.location.hash, '');
  assert.equal(app.elements.get('connection-text').textContent, 'Local session');
  assert.equal(app.elements.get('task-prompt').value, 'Keep this draft');
  assert.equal(app.storage.get('effort.dashboard.token'), 'new-session');
});

test('a new token queues a fresh request and ignores the previous session response', async () => {
  const pending = [];
  const app = dashboard({ url: 'http://127.0.0.1:43210/#token=expired-session', fetchResponse: () => new Promise((resolve) => pending.push(resolve)) });
  assert.equal(app.requests.length, 1);
  app.navigateHash('#token=current-session');
  pending.shift()(response(401));
  await settled();
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].options.headers.Authorization, 'Bearer current-session');
  assert.equal(app.elements.get('connection-text').textContent, 'Connecting');
  pending.shift()(response());
  await settled();
  assert.equal(app.elements.get('connection-text').textContent, 'Local session');
  assert.equal(app.elements.get('status-notice').hidden, true);
});
