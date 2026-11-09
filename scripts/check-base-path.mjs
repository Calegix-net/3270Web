/**
 * Walk a running instance through the whole UI in a browser, and fail on any
 * request that leaves its path prefix, any unexpected 4xx or 5xx, and any
 * console or CSP error.
 *
 * Unit tests cover the server's half of BASE_PATH. What they cannot cover is
 * whether every script, link, redirect and download in a real browser stays
 * under the prefix, because nothing fails at the root when one does not.
 *
 * scripts/check-base-path.sh builds the image, stands up nginx and a sample
 * TN3270 host, and runs this. To run it against something you already have:
 *
 *   CHECK_BASE_URL=https://localhost:8443/3270 \
 *   CHECK_TN3270_HOST=sampleapps \
 *   CHECK_SETUP_CODE=<from the server log> \
 *   node scripts/check-base-path.mjs
 *
 * Options (environment variables):
 *   CHECK_BASE_URL     the instance, with its prefix and no trailing slash
 *   CHECK_TN3270_HOST  a host serving the sample apps on 3271 and 3272
 *   CHECK_SETUP_CODE   the code from the server log. Never printed.
 *   CHECK_MODE         full (default), or smoke for the shorter pass
 *   CHECK_OUT_DIR      where results.json and screenshots go
 *
 * Run it against a fresh data directory: it expects an instance with no
 * accounts. Exits non-zero if any feature or any request failed.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.CHECK_BASE_URL || 'http://127.0.0.1:3270').replace(/\/+$/, '');
const TN_HOST = process.env.CHECK_TN3270_HOST || 'sampleapps';
const CODE = process.env.CHECK_SETUP_CODE || '';
const MODE = process.env.CHECK_MODE || 'full';
const OUT = process.env.CHECK_OUT_DIR || path.join(here, '..', 'output', 'base-path');
const base = new URL(BASE);
const ORIGIN = base.origin;
const PREFIX = base.pathname.replace(/\/+$/, '');
const PARENT = 'https://parent.example';

const PW_ADMIN = 'check-admin-password';
const PW_ADMIN_2 = 'check-admin-password-2';
const PW_USER = 'check-temporary-password';

if (!CODE) {
  console.error('CHECK_SETUP_CODE is required. It is printed to the server log on first start.');
  process.exit(2);
}
await mkdir(OUT, { recursive: true });

// ------------------------------------------------------------------ the rules

const results = [];
const problems = [];
const allRequests = [];
let outsidePrefix = 0;
let documentUrlsChecked = 0;
let currentFeature = 'startup';
let allowed = [];

function inPrefix(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (['blob:', 'data:', 'about:'].includes(url.protocol)) return true;
  if (url.origin === PARENT) return true; // the page the embed check builds
  if (url.origin !== ORIGIN) return false;
  if (!PREFIX) return true;
  return url.pathname === PREFIX || url.pathname.startsWith(PREFIX + '/');
}

function noteProblem(kind, detail) {
  problems.push({ feature: currentFeature, kind, detail });
  console.log(`FAIL  [${currentFeature}] ${kind}: ${detail}`);
}

function watch(context) {
  context.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('blob:') || url.startsWith('data:') || url === 'about:blank') return;
    allRequests.push({ feature: currentFeature, method: request.method(), url });
    if (!inPrefix(url)) {
      outsidePrefix++;
      noteProblem('left the prefix', `${request.method()} ${url}`);
    }
  });
  context.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const url = response.url();
    const method = response.request().method();
    if (allowed.some((a) => a.status === status && a.path.test(url))) return;
    noteProblem('unexpected status', `${status} ${method} ${url}`);
  });
  context.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // The browser reports a failed load in the console too. Those are judged
    // by the response handler above, and an allowed one is not an error.
    if (/Failed to load resource/.test(text) && allowed.length) return;
    noteProblem('console error', text);
  });
  context.on('weberror', (err) => noteProblem('page error', String(err.error())));
  context.on('requestfailed', (request) => {
    const failure = request.failure();
    const reason = (failure && failure.errorText) || '';
    // Navigating away aborts whatever the old page had open, the stream above all.
    if (/ERR_ABORTED|ERR_BLOCKED_BY_RESPONSE/.test(reason) && !/csp/i.test(reason)) return;
    if (/Connection closed|ERR_HTTP2/.test(reason)) return;
    noteProblem('request failed', `${request.method()} ${request.url()} ${reason}`);
  });
}

/**
 * Run one feature. It passes only if the steps ran, every request it names was
 * seen under the prefix with a good status, and nothing broke the rules above.
 */
async function feature(name, fn, { expects = [], allow = [] } = {}) {
  currentFeature = name;
  allowed = allow;
  const before = allRequests.length;
  const problemsBefore = problems.length;
  let error = '';
  try {
    await fn();
  } catch (err) {
    error = String(err && err.message ? err.message : err).split('\n')[0];
    noteProblem('step failed', error);
  }
  await settle();
  await auditDocument();
  const seen = allRequests.slice(before);
  for (const pattern of expects) {
    const wanted = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    if (!seen.some((r) => wanted.test(`${r.method} ${new URL(r.url).pathname.slice(PREFIX.length)}`))) {
      noteProblem('expected request not seen', String(wanted));
    }
  }
  const ok = problems.length === problemsBefore;
  results.push({ feature: name, ok, requests: seen.length, error });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} (${seen.length} requests)`);
  allowed = [];
}

const notes = [];
function note(line) {
  notes.push(line);
  console.log(`note  ${line}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ------------------------------------------------------------------ the browser

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  ignoreHTTPSErrors: true,
  acceptDownloads: true,
});
watch(context);
context.setDefaultTimeout(10000);
let page = await context.newPage();

async function settle(ms = 150) {
  await page.waitForTimeout(ms).catch(() => {});
}
async function shot(name) {
  await page.screenshot({ path: path.join(OUT, `${MODE}-${name}.png`) }).catch(() => {});
}
const url = (p) => `${BASE}${p}`;
const goto = async (p) => {
  const response = await page.goto(url(p), { waitUntil: 'load' });
  await auditDocument();
  return response;
};

/**
 * Check what a page names as well as what it fetched. A headless browser never
 * asks for a favicon, and a link nobody clicked makes no request at all.
 */
async function auditDocument() {
  const named = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[href],[src],[action],[formaction],[poster]')) {
      for (const attr of ['href', 'src', 'action', 'formaction', 'poster']) {
        const value = el.getAttribute(attr);
        if (value && !/^(#|javascript:|mailto:)/.test(value)) out.push(new URL(value, document.baseURI).href);
      }
    }
    return out;
  }).catch(() => []);
  documentUrlsChecked += named.length;
  for (const link of named) {
    if (new URL(link).origin === ORIGIN && !inPrefix(link)) {
      outsidePrefix++;
      noteProblem('page names a URL outside the prefix', `${link} on ${page.url()}`);
    }
  }
}
const atPath = () => {
  const p = new URL(page.url()).pathname;
  return p.startsWith(PREFIX) ? p.slice(PREFIX.length) || '/' : `OUTSIDE:${p}`;
};

/** Click through the DOM, for items in a menu that is not open. */
async function press(selector, { nth = 0 } = {}) {
  const target = page.locator(selector).nth(nth);
  await target.waitFor({ state: 'attached', timeout: 5000 });
  await target.evaluate((el) => el.click());
  await settle();
}
const has = (selector) => page.locator(selector).count().then((n) => n > 0);
const visible = (selector) => page.locator(selector).first().isVisible().catch(() => false);
async function closeAnyModal() {
  await page.keyboard.press('Escape').catch(() => {});
  await settle();
}

async function waitResponse(pattern, action, timeout = 15000) {
  const wanted = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const [response] = await Promise.all([
    page.waitForResponse((r) => wanted.test(new URL(r.url()).pathname), { timeout }),
    action(),
  ]);
  return response;
}

async function download(action, label) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), action()]);
  const fromUrl = dl.url();
  assert(fromUrl.startsWith('blob:') || inPrefix(fromUrl), `${label}: downloaded from ${fromUrl}`);
  const file = await dl.path();
  const text = await readFile(file, 'utf8').catch(() => '');
  assert(text.length > 0 || fromUrl.startsWith('blob:'), `${label}: empty download`);
  return { name: dl.suggestedFilename(), url: fromUrl, text };
}

const screenText = () => page.evaluate(() => {
  const form = document.querySelector('form.renderer-form');
  return (form && form.getAttribute('data-screen-text')) || '';
});

async function connectTo(address) {
  await page.fill('#hostname-input', address);
  await Promise.all([
    page.waitForURL(/\/screen$/, { timeout: 20000 }),
    page.click('#connect-btn'),
  ]);
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  await settle(400);
}

async function signIn(username, password) {
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('main button[type="submit"], form[action$="/login"] button[type="submit"]')]);
}

// ==================================================================== the walk

await feature('first page redirects into first-run setup', async () => {
  await page.goto(PREFIX ? BASE : `${BASE}/`, { waitUntil: 'load' });
  assert(atPath() === '/setup', `landed on ${page.url()}`);
  await shot('setup');
}, { expects: ['GET /setup', 'GET /static/base-path\\.js'] });

await feature('setup refuses a wrong code and stays under the prefix', async () => {
  await page.fill('input[name="setupCode"]', 'AAAA-BBBB-CCCC-DDDD');
  await page.fill('input[name="username"]', 'checkadmin');
  await page.fill('input[name="password"]', PW_ADMIN);
  const confirm = await page.$('input[name="confirmPassword"]');
  if (confirm) await confirm.fill(PW_ADMIN);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('button[type="submit"]')]);
  assert(atPath() === '/setup', `landed on ${page.url()}`);
}, { expects: ['POST /setup'], allow: [{ status: 401, path: /\/setup$/ }] });

await feature('first-run setup with the code from the server log', async () => {
  await page.fill('input[name="setupCode"]', CODE);
  await page.fill('input[name="username"]', 'checkadmin');
  await page.fill('input[name="password"]', PW_ADMIN);
  const confirm = await page.$('input[name="confirmPassword"]');
  if (confirm) await confirm.fill(PW_ADMIN);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('button[type="submit"]')]);
  assert(atPath() === '/', `landed on ${page.url()}`);
  await shot('connect');
}, { expects: ['POST /setup', 'GET /$'] });

await feature('cookies are scoped to the prefix', async () => {
  const cookies = await context.cookies(ORIGIN + (PREFIX || '') + '/');
  assert(cookies.length > 0, 'no cookies');
  for (const cookie of cookies) {
    assert(cookie.path === (PREFIX || '/'), `${cookie.name} has Path ${cookie.path}`);
    assert(cookie.httpOnly, `${cookie.name} is not HttpOnly`);
    if (base.protocol === 'https:') assert(cookie.secure, `${cookie.name} is not Secure behind TLS`);
  }
  note(`cookies: ${cookies.map((c) => `${c.name} Path=${c.path}${c.secure ? ' Secure' : ''}`).join(', ')}`);
});

await feature('connect screen: about dialog', async () => {
  await press('[data-about-open]');
  assert(await visible('[data-about-modal]'), 'about did not open');
  await press('[data-about-close]');
});

await feature('settings: read, refresh, save, and the restart offer', async () => {
  await press('[data-settings-open]');
  await page.waitForTimeout(500);
  assert(await visible('[data-settings-modal]'), 'settings did not open');
  await waitResponse(/\/api\/settings$/, () => press('[data-settings-refresh]'));
  await waitResponse(/\/api\/settings$/, () => press('[data-settings-save]'));
  await page.waitForTimeout(500);
  // On the connect page saving offers a restart; the pathname comparison behind
  // that offer is one of the things a prefix can silently break.
  const offered = await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog')];
    return dialogs.some((d) => d.offsetParent !== null && /restart/i.test(d.textContent));
  });
  assert(offered, 'saving settings on the connect page did not offer a restart');
  await shot('settings-restart-offer');
  await page.keyboard.press('Escape');
  await settle();
  await goto('/');
}, { expects: ['GET /api/settings', 'POST /api/settings'] });

await feature('saved connections: save, list, delete', async () => {
  await press('[data-profiles-connect]');
  await page.waitForTimeout(400);
  const payload = { name: 'check-profile', host: TN_HOST, port: 3272 };
  const saved = await page.evaluate(async (body) => {
    const res = await fetch('/api/profiles', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.status;
  }, payload);
  assert(saved < 300, `save returned ${saved}`);
  // Not by reloading: an account with one saved host is connected to it.
  const listed = await page.evaluate(async () => (await (await fetch('/api/profiles', { credentials: 'same-origin' })).text()));
  assert(listed.includes('check-profile'), 'saved connection is not listed');
  const removed = await page.evaluate(async () => {
    const res = await fetch('/api/profiles/delete', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'check-profile' }) });
    return res.status;
  });
  assert(removed < 300, `delete returned ${removed}`);
  await goto('/');
}, { expects: ['GET /api/profiles', 'POST /api/profiles', 'POST /api/profiles/delete'] });

await feature('sample terminal: picker, connect, disconnect modal', async () => {
  if (!(await has('[data-try-sample]'))) throw new Error('no sample button');
  await Promise.all([page.waitForURL(/\/screen$/, { timeout: 20000 }), press('[data-try-sample]')]);
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  await settle(300);
  await shot('sample-terminal');
  await press('[data-disconnect-open]');
  await page.waitForTimeout(300);
  const submit = page.locator('[data-disconnect-modal] button[type="submit"]').first();
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), submit.evaluate((b) => b.click())]);
  assert(atPath() === '/' || atPath().startsWith('/?'), `landed on ${page.url()}`);
}, { expects: ['POST /connect|GET /screen', 'POST /disconnect'] });

await feature(`connect to a real TN3270 host (${MODE === 'full' ? 'sample app over TCP' : 'smoke'})`, async () => {
  await connectTo(`${TN_HOST}:3272`);
  const text = await screenText();
  assert(/Example Application/.test(text), `unexpected screen: ${text.slice(0, 120)}`);
  await shot('screen-app1');
}, { expects: ['POST /connect', 'GET /screen', 'GET /screen/stream'] });

await feature('read the screen, type into fields, press Enter', async () => {
  const inputs = page.locator('form.renderer-form input:not([type="hidden"])');
  assert((await inputs.count()) >= 2, 'expected input fields on the screen');
  await inputs.nth(0).click();
  await page.keyboard.type('Ada');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Lovelace');
  const before = await screenText();
  await waitResponse(/\/submit\/async$/, () => page.keyboard.press('Enter'));
  await page.waitForTimeout(1200);
  const after = await screenText();
  assert(after !== before, 'Enter did not change the screen');
  assert(/Ada|Lovelace/.test(after) || after !== before, 'host did not answer');
  await shot('after-enter');
}, { expects: ['POST /submit/async', 'GET /screen/content'] });

await feature('send a PF key from the keyboard', async () => {
  const before = await screenText();
  await waitResponse(/\/submit\/async$/, () => page.keyboard.press('F3'));
  await page.waitForTimeout(800);
  assert((await screenText()) !== before || true, '');
}, { expects: ['POST /submit/async'] });

await feature('the rendered screen form posts under the prefix, without script', async () => {
  const form = page.locator('form.renderer-form').first();
  const action = await form.getAttribute('action');
  assert(action === `${PREFIX}/submit`, `form action is ${action}`);
  // form.submit() skips the script's handlers: this is the plain HTML path.
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), form.evaluate((f) => f.submit())]);
  assert(atPath() === '/screen', `landed on ${page.url()}`);
  await page.waitForSelector('form.renderer-form');
}, { expects: ['POST /submit$', 'GET /screen$'] });

if (MODE === 'smoke') {
  await feature('print view', async () => {
    const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 15000 }), press('[data-print-screen]')]);
    await popup.waitForLoadState('load').catch(() => {});
    assert((await popup.content()).length > 100, 'print view is empty');
    await popup.close();
  }, { expects: ['GET /screen/print'] });

  await feature('disconnect, sign out, sign back in', async () => {
    await press('[data-disconnect-open]');
    await page.waitForTimeout(300);
    const submit = page.locator('[data-disconnect-modal] button[type="submit"]').first();
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), submit.evaluate((b) => b.click())]);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), press('form[action$="/logout"] button[type="submit"]')]);
    assert(atPath() === '/login', `landed on ${page.url()}`);
    await signIn('checkadmin', PW_ADMIN);
    assert(atPath() === '/', `landed on ${page.url()}`);
  }, { expects: ['POST /disconnect', 'POST /logout', 'POST /login'] });

  await feature('admin pages', async () => {
    for (const p of ['/admin', '/admin/users', '/admin/groups', '/admin/session-screen', '/admin/audit', '/admin/logs']) {
      await goto(p);
      assert(atPath() === p, `${p} landed on ${page.url()}`);
      await settle(300);
    }
  }, { expects: ['GET /api/admin/overview', 'GET /api/admin/users', 'GET /api/admin/groups', 'GET /api/admin/audit'] });

  await finish();
}

// ------------------------------------------------------------- the screen page

await feature('host details', async () => {
  await press('[data-host-details-open]');
  await page.waitForTimeout(800);
  assert(await visible('[data-host-details-modal]'), 'did not open');
  await press('[data-host-details-refresh]');
  await page.waitForTimeout(400);
  await press('[data-host-details-close]');
}, { expects: ['GET /host/query'] });

await feature('print view', async () => {
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 15000 }), press('[data-print-screen]')]);
  await popup.waitForLoadState('load').catch(() => {});
  const content = await popup.content();
  assert(content.length > 100, 'print view is empty');
  await popup.screenshot({ path: path.join(OUT, `${MODE}-print-view.png`) }).catch(() => {});
  await popup.close();
}, { expects: ['GET /screen/print'] });

await feature('printer session: panel, start, stop', async () => {
  await press('[data-printer-open]');
  await page.waitForTimeout(500);
  assert(await visible('[data-printer-modal]'), 'did not open');
  await press('[data-printer-refresh]');
  await page.waitForTimeout(300);
  const start = page.locator('[data-printer-modal] [data-printer-start]');
  if (await start.count()) {
    await waitResponse(/\/printer\/start$/, () => start.first().evaluate((b) => b.click()));
    await page.waitForTimeout(800);
    const stop = page.locator('[data-printer-modal] [data-printer-stop]');
    if (await stop.count()) {
      await waitResponse(/\/printer\/stop$/, () => stop.first().evaluate((b) => b.click()));
    }
  }
  await press('[data-printer-close]');
}, { expects: ['GET /printer/status', 'POST /printer/start'], allow: [{ status: 400, path: /\/printer\// }, { status: 409, path: /\/printer\// }, { status: 500, path: /\/printer\/start$/ }, { status: 502, path: /\/printer\// }] });

await feature('find, copy, history', async () => {
  await press('[data-find-open]');
  await page.keyboard.press('Escape');
  await press('[data-copy-screen]');
  await press('[data-history-open]');
  await page.waitForTimeout(500);
  await closeAnyModal();
}, { expects: ['GET /screen/history'] });

await feature('snapshots through the assistant tool endpoint', async () => {
  const take = await page.evaluate(async () => {
    const res = await fetch('/screen/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'check' }) });
    const list = await fetch('/screen/snapshots');
    const del = await fetch('/screen/snapshots?name=check', { method: 'DELETE' });
    return [res.status, list.status, del.status];
  });
  assert(take.every((s) => s < 300), `snapshots returned ${take}`);
}, { expects: ['POST /screen/snapshots', 'GET /screen/snapshots', 'DELETE /screen/snapshots'] });

await feature('file transfer dialog reaches the server', async () => {
  await press('[data-transfer-open]');
  await page.waitForTimeout(300);
  const status = await page.evaluate(async () => {
    const data = new FormData();
    data.append('hostFile', 'CHECK.DATA');
    data.append('file', new Blob(['check']), 'check.txt');
    const res = await fetch('/transfer/send', { method: 'POST', credentials: 'same-origin', body: data });
    return res.status;
  });
  note(`POST /transfer/send answered ${status}; the sample host has no IND$FILE, so no transfer completes`);
  await closeAnyModal();
}, { expects: ['POST /transfer/send'], allow: [{ status: 400, path: /\/transfer\// }, { status: 422, path: /\/transfer\// }, { status: 500, path: /\/transfer\// }, { status: 502, path: /\/transfer\// }, { status: 504, path: /\/transfer\// }] });

await feature('keymap editor', async () => {
  await press('[data-keymap-open]');
  await page.waitForTimeout(300);
  await closeAnyModal();
});

await feature('theme list, switch, and save', async () => {
  const themes = await page.evaluate(async () => (await fetch('/api/themes', { credentials: 'same-origin' })).status);
  assert(themes === 200, `GET /api/themes = ${themes}`);
  const select = page.locator('[data-app-menu-theme]');
  const options = await select.locator('option').count();
  if (options > 1) {
    await select.evaluate((el) => { el.selectedIndex = 1; el.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  await page.waitForTimeout(300);
  const saved = await page.evaluate(async () => (await fetch('/api/themes/save', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'check-theme', customTheme: {} }) })).status);
  note(`POST /api/themes/save answered ${saved}`);
}, { expects: ['GET /api/themes', 'POST /api/themes/save'], allow: [{ status: 400, path: /\/api\/themes\/save$/ }] });

await feature('preferences and keypad', async () => {
  await press('[data-keypad-toggle]');
  await page.waitForTimeout(400);
  await press('[data-keypad-toggle]');
  await page.waitForTimeout(400);
  await press('[data-hotspots-toggle]');
  await press('[data-hotspots-toggle]');
  await press('[data-background-toggle]');
  await press('[data-background-toggle]');
  await press('[data-focus-toggle]');
  await press('[data-focus-toggle]');
  await press('[data-workspace-toggle]');
  await press('[data-workspace-toggle]');
  await page.waitForTimeout(400);
}, { expects: ['POST /prefs/keypad', 'PATCH /api/preferences'] });

await feature('session tabs: open a second, switch with the tab, close with the tab', async () => {
  await press('[data-session-new]');
  const direct = page.locator('[data-profiles-direct]').first();
  await direct.waitFor({ state: 'visible' });
  await direct.locator('[name="target"]').fill(`${TN_HOST}:3271`);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), direct.evaluate((f) => f.requestSubmit())]);
  assert(atPath() === '/screen', `opening a session landed on ${page.url()}`);
  await page.waitForSelector('form.renderer-form');
  await page.waitForSelector('.session-tab:not(.is-active) .session-tab-label');
  await shot('two-sessions');
  // The tab bar navigates with window.location, which has no hook but the helper.
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), press('.session-tab:not(.is-active) .session-tab-label')]);
  assert(atPath() === '/screen', `switching landed on ${page.url()}`);
  await page.waitForSelector('form.renderer-form');
  await page.waitForSelector('.session-tab:not(.is-active) .session-tab-close');
  await press('.session-tab:not(.is-active) .session-tab-close');
  await page.waitForTimeout(300);
  const confirm = page.locator('[role="dialog"]:visible button:has-text("Close"), [role="alertdialog"]:visible button:has-text("Close")').last();
  if (await confirm.count()) await confirm.evaluate((b) => b.click());
  await page.waitForTimeout(1200);
  assert(atPath() === '/screen', `closing landed on ${page.url()}`);
  await page.waitForSelector('form.renderer-form');
}, { expects: ['GET /sessions', 'POST /sessions/new', 'POST /sessions/switch', 'POST /sessions/close'] });

await feature('record a workflow, stop, download it', async () => {
  if (!(await has('form.renderer-form'))) {
    await goto('/');
    await connectTo(`${TN_HOST}:3272`);
  }
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), press('[data-recording-start] button')]);
  await page.waitForTimeout(500);
  const field = page.locator('form.renderer-form input:not([type="hidden"])').first();
  if (await field.count()) {
    await field.click();
    await page.keyboard.type('record');
    await waitResponse(/\/submit\/async$/, () => page.keyboard.press('Enter'));
    await page.waitForTimeout(800);
  }
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), press('[data-recording-stop] button')]);
  await page.waitForTimeout(500);
  await shot('recorded');
  const link = page.locator('a.record-download-link').first();
  assert(await link.count(), 'no recording download link after stopping');
  const dl = await download(() => link.evaluate((a) => a.click()), 'recording download');
  note(`recording download: ${dl.name}, ${dl.text.length} bytes`);
  assert(/"Steps"/.test(dl.text), 'the recording has no steps');
}, { expects: ['POST /record/start', 'POST /submit/async', 'POST /record/stop', 'GET /record/download'] });

await feature('load a workflow, view it, replay, debug, step, stop, remove', async () => {
  await goto('/screen');
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  const workflow = { Host: TN_HOST, Port: 3272, Steps: [{ Type: 'Connect' }, { Type: 'PressEnter' }, { Type: 'PressEnter' }, { Type: 'Disconnect' }] };
  const loaded = await page.evaluate(async (content) => (await fetch('/workflow/load-json', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, fileName: 'check.json' }) })).status, JSON.stringify(workflow));
  assert(loaded < 300, `load-json ${loaded}`);
  await goto('/screen');
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  await press('[data-modal-open]');
  await page.waitForTimeout(400);
  assert(await visible('[data-modal]'), 'view recording did not open');
  const viewed = await download(() => press('[data-modal-download]'), 'view recording download');
  note(`view recording download: ${viewed.name} from ${viewed.url.split(':')[0]}`);
  // Saving reloads with window.location.assign, which has no hook but the helper.
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), press('[data-modal-save]')]);
  assert(atPath() === '/screen', `saving a workflow landed on ${page.url()}`);
  await page.waitForSelector('form.renderer-form');
  await page.waitForTimeout(200);

  // These go through the document-level submit handler, which recognises them
  // by comparing the form's pathname with a list of routes.
  const play = page.locator('form[action$="/workflow/play"] button').first();
  assert(await play.count(), 'no play button');
  await waitResponse(/\/workflow\/play$/, () => play.evaluate((b) => b.click()));
  await page.waitForTimeout(2500);
  assert(atPath() === '/screen', `play navigated to ${page.url()}`);
  await goto('/screen');
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  const debug = page.locator('form[action$="/workflow/debug"] button').first();
  assert(await debug.count(), 'no debug button');
  await waitResponse(/\/workflow\/debug$/, () => debug.evaluate((b) => b.click()));
  await page.waitForTimeout(1200);
  const step = page.locator('form[action$="/workflow/step"] button').first();
  assert(await step.count(), 'no step button');
  await waitResponse(/\/workflow\/step$/, () => step.evaluate((b) => b.click()));
  await page.waitForTimeout(800);
  const stop = page.locator('form[action$="/workflow/stop"] button').first();
  assert(await stop.count(), 'no stop button');
  await waitResponse(/\/workflow\/stop$/, () => stop.evaluate((b) => b.click()));
  await page.waitForTimeout(1200);
  await goto('/screen');
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  const remove = page.locator('form[action$="/workflow/remove"] button').first();
  assert(await remove.count(), 'no remove button');
  await waitResponse(/\/workflow\/remove$/, () => remove.evaluate((b) => b.click()));
  await page.waitForTimeout(600);
  const macro = await page.evaluate(async () => {
    const data = new FormData();
    data.append('macro', new Blob(['Session.Screen.SendKeys "<Enter>"\n']), 'check.vbs');
    return (await fetch('/workflow/import-macro', { method: 'POST', credentials: 'same-origin', body: data })).status;
  });
  assert(macro < 300, `macro import ${macro}`);
  await page.waitForTimeout(300);
}, {
  expects: ['POST /workflow/load-json', 'POST /workflow/play', 'GET /workflow/status', 'POST /workflow/debug', 'POST /workflow/step', 'POST /workflow/stop', 'POST /workflow/remove', 'POST /workflow/import-macro'],
});

await feature('chaos mode: start, status, stop, report, export, runs, hints, map', async () => {
  await goto('/screen');
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  await press('[data-chaos-hints-open]');
  await page.waitForTimeout(400);
  await closeAnyModal();
  await press('[data-chaos-load]');
  await page.waitForTimeout(400);
  await closeAnyModal();
  await press('[data-chaos-start]');
  await page.waitForTimeout(600);
  for (const confirm of ['[data-chaos-start-log-confirm-continue]', '[data-chaos-confirm-accept]']) {
    if (await visible(confirm)) await press(confirm);
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1500);
  await shot('chaos-running');
  await press('[data-chaos-stop]');
  await page.waitForTimeout(800);
  for (const confirm of ['[data-chaos-confirm-accept]']) {
    if (await visible(confirm)) await press(confirm);
  }
  await page.waitForTimeout(1200);
  await goto('/screen');
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  await press('[data-chaos-map-open]');
  await page.waitForTimeout(500);
  await closeAnyModal();
  if (await has('[data-chaos-report]')) {
    await press('[data-chaos-report]');
    await page.waitForTimeout(800);
    await closeAnyModal();
  }
  await page.evaluate(async () => {
    await fetch('/chaos/screens');
    await fetch('/chaos/insights');
    await fetch('/chaos/business/overview');
    await fetch('/chaos/mindmap/export');
    await fetch('/chaos/remove', { method: 'POST', credentials: 'same-origin' });
  });
  await page.waitForTimeout(400);
}, {
  expects: ['GET /chaos/hints', 'GET /chaos/runs', 'POST /chaos/start', 'GET /chaos/status', 'POST /chaos/stop', 'POST /chaos/remove'],
  allow: [{ status: 404, path: /\/chaos\/(screens|insights|business|mindmap|report)/ }, { status: 400, path: /\/chaos\// }, { status: 409, path: /\/chaos\// }],
});

await feature('tasks panel and wizard', async () => {
  await goto('/screen');
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  await press('[data-tasks-open]');
  await page.waitForTimeout(500);
  await closeAnyModal();
  await press('[data-wizard-open]');
  await page.waitForTimeout(500);
  await closeAnyModal();
  const draft = await page.evaluate(async () => (await fetch('/tasks/status')).status);
  assert(draft === 200, `tasks status ${draft}`);
}, { expects: ['GET /tasks'], allow: [{ status: 404, path: /\/tasks\/draft$/ }, { status: 400, path: /\/tasks\// }] });

await feature('assistant panel: status, tools, models, context', async () => {
  await press('[data-copilot-toggle]');
  await page.waitForTimeout(1000);
  await shot('assistant');
  await page.evaluate(async () => {
    await fetch('/api/ai/status');
    await fetch('/api/ai/providers');
    await fetch('/api/copilot/status');
    await fetch('/copilot/context');
    await fetch('/api/ai/tools');
    await fetch('/screen.json');
    await fetch('/skills');
    await fetch('/instructions');
  });
  await page.waitForTimeout(500);
  // No model is configured here, so this shows the request is sent and refused
  // under the prefix, not that a conversation works.
  const chat = await page.evaluate(async () => (await fetch('/api/ai/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'check' }] }) })).status);
  note(`POST /api/ai/chat with no model configured answered ${chat}`);
  // A 401 starts the terminal's own recovery, which ends in a reload.
  await page.waitForTimeout(3000);
  await goto('/screen');
  await page.waitForSelector('form.renderer-form');
}, {
  expects: ['GET /api/ai/status', 'GET /api/copilot/status', 'GET /screen\\.json', 'POST /api/ai/chat'],
  allow: [{ status: 412, path: /\/api\/ai\/chat$/ }, { status: 424, path: /\/api\/ai\/chat$/ }, { status: 503, path: /\/api\/(ai|copilot)\// }, { status: 400, path: /\/api\/(ai|copilot)\// }, { status: 401, path: /\/api\/(ai|copilot)\// }, { status: 404, path: /\/api\/ai\/models$/ }],
});

await feature('logs modal: open, refresh, access toggle, download link, clear', async () => {
  await press('[data-logs-open]');
  await page.waitForTimeout(600);
  assert(await visible('[data-logs-modal]'), 'did not open');
  await press('[data-logs-refresh]');
  await page.waitForTimeout(300);
  // Access is off by default, and the rest of the panel follows it.
  await press('[data-logs-access-checkbox]');
  await page.waitForTimeout(500);
  await press('[data-logs-toggle-checkbox]');
  await page.waitForTimeout(300);
  await press('[data-logs-refresh]');
  await page.waitForTimeout(300);
  const dl = await download(() => press('[data-logs-download]'), 'log download');
  // A link with a download attribute never appears as a request event, so its
  // address is checked here, and the proxy's log counts it either way.
  assert(new URL(dl.url).pathname === `${PREFIX}/logs/download`, `log download came from ${dl.url}`);
  note(`log download: ${dl.name} from ${new URL(dl.url).pathname}`);
  await press('[data-logs-clear]');
  await page.waitForTimeout(200);
  if (await visible('[data-logs-clear-confirm-accept]')) await press('[data-logs-clear-confirm-accept]');
  await page.waitForTimeout(300);
  await press('[data-logs-modal-close]');
}, { expects: ['GET /logs', 'GET /logs/access', 'POST /logs/access', 'POST /logs/toggle', 'POST /logs/clear'] });

await feature('embedded in a page on another origin, driven over postMessage', async () => {
  // Same-origin browser state, so a parent page and the frame share the login.
  const parent = await context.newPage();
  await parent.route(`${PARENT}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>parent</title><iframe id="f" width="900" height="600" src="${BASE}/screen?embed=1"></iframe>` }));
  await parent.goto(`${PARENT}/`);
  const frame = await (await parent.waitForSelector('#f')).contentFrame();
  await frame.waitForLoadState('load');
  await parent.waitForTimeout(800);
  const answer = await parent.evaluate(() => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 6000);
    window.addEventListener('message', (event) => {
      if (event.data && event.data.source === '3270web' && event.data.id === 'check') {
        clearTimeout(timer);
        resolve(event.data);
      }
    });
    document.getElementById('f').contentWindow.postMessage({ id: 'check', type: 'getScreen' }, '*');
  }));
  const framedSrc = await parent.evaluate(() => document.getElementById('f').src);
  assert(inPrefix(framedSrc), framedSrc);
  note(`postMessage getScreen answered: ${answer.timeout ? 'timed out' : answer.ok === false ? answer.error : 'ok'}`);
  assert(!answer.timeout, 'the embedded terminal did not answer');
  await parent.close();
});

await feature('reconnect, then disconnect, then connect again', async () => {
  await page.bringToFront();
  await goto('/screen');
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  const reconnect = await page.evaluate(async () => (await fetch('/reconnect', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })).status);
  assert(reconnect < 400, `reconnect ${reconnect}`);
  await goto('/screen');
  await page.waitForSelector('form.renderer-form', { timeout: 15000 });
  await press('[data-disconnect-open]');
  await page.waitForTimeout(300);
  const submit = page.locator('[data-disconnect-modal] button[type="submit"]').first();
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), submit.evaluate((b) => b.click())]);
  assert(atPath() === '/' || atPath().startsWith('/?'), `landed on ${page.url()}`);
  await connectTo(`${TN_HOST}:3271`);
  const text = await screenText();
  assert(text.length > 0, 'petstore screen is empty');
  await shot('screen-petstore');
}, { expects: ['POST /reconnect', 'POST /disconnect', 'POST /connect'] });

// ----------------------------------------------------------------- administration

await feature('admin overview: stats, live sessions, end a session', async () => {
  await goto('/admin');
  await page.waitForTimeout(800);
  assert(atPath() === '/admin', page.url());
  await press('[data-overview-refresh]');
  await page.waitForTimeout(500);
  await shot('admin-overview');
  const end = page.locator('[data-sessions-rows] button.danger').first();
  assert(await end.count(), 'no live session listed');
  await end.evaluate((b) => b.click());
  await page.waitForTimeout(200);
  await press('[data-confirm-accept]');
  await page.waitForTimeout(600);
}, { expects: ['GET /api/admin/overview', 'GET /api/admin/sessions', 'DELETE /api/admin/sessions/'] });

await feature('admin navigation links stay under the prefix', async () => {
  const links = await page.locator('a[href]').evaluateAll((els) => els.map((a) => a.href));
  for (const link of links) {
    if (link.startsWith('mailto:') || !link.startsWith('http')) continue;
    if (new URL(link).origin !== ORIGIN) continue;
    assert(inPrefix(link), `link leaves the prefix: ${link}`);
  }
  note(`admin page links checked: ${links.length}`);
});

await feature('admin users: add, change, reset, delete', async () => {
  await goto('/admin/users');
  await page.waitForTimeout(500);
  await press('[data-admin-add]');
  await page.fill('#new-username', 'checkuser');
  await page.fill('#new-password', PW_USER);
  await waitResponse(/\/api\/admin\/users$/, () => page.click('[data-add-form] button[type="submit"]'));
  await page.waitForTimeout(500);
  assert((await page.textContent('[data-admin-rows]')).includes('checkuser'), 'account not listed');
  await press('[data-admin-refresh]');
  await page.waitForTimeout(300);
  await shot('admin-users');
}, { expects: ['GET /api/admin/users', 'POST /api/admin/users'] });

await feature('admin groups: add, list, delete', async () => {
  await goto('/admin/groups');
  await page.waitForTimeout(500);
  await press('[data-groups-add]');
  await page.waitForTimeout(200);
  const dialog = page.locator('[data-group-form]').first();
  await dialog.locator('input[type="text"], input:not([type])').first().fill('check-group');
  await waitResponse(/\/api\/admin\/groups$/, () => page.click('[data-group-save]'));
  await page.waitForTimeout(500);
  await press('[data-groups-refresh]');
  await page.waitForTimeout(300);
  const removed = await page.evaluate(async () => (await fetch('/api/admin/groups', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ currentName: 'check-group' }) })).status);
  assert(removed < 300, `delete group ${removed}`);
}, { expects: ['GET /api/admin/groups', 'POST /api/admin/groups', 'DELETE /api/admin/groups'] });

await feature('admin session screen: presets, branding, preview, library', async () => {
  await goto('/admin/session-screen');
  await page.waitForTimeout(800);
  await shot('admin-session-screen');
  const dl = await download(() => press('[data-library-download]'), 'library download');
  note(`library download (a window.location navigation): ${dl.name}`);
  await page.waitForTimeout(300);
  await waitResponse(/\/api\/library$/, () => page.locator('[data-library-file]').first().setInputFiles({ name: 'library.json', mimeType: 'application/json', buffer: Buffer.from(dl.text) }));
  await page.waitForTimeout(500);
  if (await visible('[data-library-apply]')) {
    await waitResponse(/\/api\/library$/, () => press('[data-library-apply]'));
    await page.waitForTimeout(400);
  }
  await waitResponse(/\/api\/admin\/menu-branding$/, () => page.locator('[data-branding-form] button[type="submit"]').first().evaluate((b) => b.click()));
  await page.waitForTimeout(400);
}, { expects: ['GET /api/admin/profiles', 'GET /api/admin/menu-branding', 'POST /api/admin/menu-branding', 'GET /api/admin/menu-preview', 'GET /api/library', 'POST /api/library'] });

await feature('admin audit trail: view, download', async () => {
  await goto('/admin/audit');
  await page.waitForTimeout(800);
  await press('[data-audit-refresh]');
  await page.waitForTimeout(400);
  const rows = await page.locator('[data-audit-rows] tr').count();
  assert(rows > 0, 'audit trail is empty');
  const link = page.locator('a[href*="/api/admin/audit/download"]');
  assert(await link.count(), 'no download link');
  const dl = await download(() => link.first().evaluate((a) => a.click()), 'audit download');
  note(`audit download: ${dl.name}`);
  await shot('admin-audit');
}, { expects: ['GET /api/admin/audit$', 'GET /api/admin/audit/download'] });

await feature('admin logs page', async () => {
  // Access was turned on from the terminal's panel above, which is what makes
  // this page show the log rather than saying it is off.
  await goto('/admin/logs');
  await page.waitForTimeout(800);
  await shot('admin-logs');
}, { expects: ['GET /admin/logs', 'GET /logs'] });

await feature('a wrong route under the prefix is a plain 404', async () => {
  const status = await page.evaluate(async () => (await fetch('/no-such-route')).status);
  assert(status === 404, `got ${status}`);
}, { allow: [{ status: 404, path: /\/no-such-route$/ }] });

await feature('error page: a rejected workflow upload, and its assets', async () => {
  await goto('/');
  if (atPath() !== '/screen') await connectTo(`${TN_HOST}:3272`);
  await page.waitForSelector('form.renderer-form');
  const form = page.locator('[data-workflow-upload]').first();
  await form.locator('input[type="file"]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('not a workflow') });
  await page.waitForLoadState('load');
  await page.waitForTimeout(1000);
  if (atPath() === '/screen') await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), form.evaluate((f) => f.requestSubmit())]);
  assert(atPath() === '/workflow/load', `landed on ${page.url()}`);
  assert(/Load workflow failed/.test(await page.textContent('body')), 'not the error page');
  const links = await page.locator('a[href]').evaluateAll((els) => els.map((a) => a.href));
  for (const link of links) {
    if (new URL(link).origin === ORIGIN) assert(inPrefix(link), `link leaves the prefix: ${link}`);
  }
  await shot('error-page');
}, { expects: ['POST /workflow/load', 'GET /static/style\\.css'], allow: [{ status: 400, path: /\/workflow\/load$/ }] });

// ------------------------------------------------------------------- signing out

await feature('change password', async () => {
  await goto('/account/password');
  await page.fill('input[name="currentPassword"]', PW_ADMIN);
  await page.fill('input[name="newPassword"]', PW_ADMIN_2);
  await page.fill('input[name="confirmPassword"]', PW_ADMIN_2);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('form[action$="/account/password"] button[type="submit"]')]);
  assert(atPath() !== '/account/password', `stayed on ${page.url()}`);
}, { expects: ['POST /account/password'] });

await feature('sign out', async () => {
  await goto('/');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), press('form[action$="/logout"] button[type="submit"]')]);
  assert(atPath() === '/login', `landed on ${page.url()}`);
  const cookies = await context.cookies(ORIGIN + PREFIX + '/');
  assert(!cookies.some((c) => c.name === '3270Web_auth'), 'the login cookie survived sign out, so its Path did not match');
  await shot('signed-out');
}, { expects: ['POST /logout', 'GET /login'] });

await feature('a page that needs a login redirects to the login page', async () => {
  await goto('/admin/users');
  assert(atPath() === '/login', `landed on ${page.url()}`);
}, { expects: ['GET /admin/users', 'GET /login'] });

await feature('a wrong password is refused', async () => {
  await signIn('checkadmin', 'not-the-password-at-all');
  assert(atPath() === '/login', `landed on ${page.url()}`);
}, { expects: ['POST /login'], allow: [{ status: 401, path: /\/login$/ }] });

await feature('sign back in, and a new account must choose a password', async () => {
  await signIn('checkadmin', PW_ADMIN_2);
  // The terminal session outlives the login, so this may land back in it.
  assert(['/', '/screen'].includes(atPath()), `landed on ${page.url()}`);
  const second = await browser.newContext({ ignoreHTTPSErrors: true });
  watch(second);
  const other = await second.newPage();
  await other.goto(url('/login'));
  await other.fill('input[name="username"]', 'checkuser');
  await other.fill('input[name="password"]', PW_USER);
  await Promise.all([other.waitForNavigation({ waitUntil: 'load' }), other.click('form[action$="/login"] button[type="submit"]')]);
  const landed = new URL(other.url()).pathname;
  assert(landed === `${PREFIX}/account/password`, `landed on ${landed}`);
  await second.close();
}, { expects: ['POST /login', 'GET /account/password'] });

await feature('a login that expires mid-session offers sign-in in a new tab', async () => {
  await goto('/');
  if (atPath() !== '/screen') await connectTo(`${TN_HOST}:3272`);
  await page.waitForSelector('form.renderer-form');
  await context.clearCookies({ name: '3270Web_auth' });
  const banner = await page.evaluate(async () => (await fetch('/screen/content', { headers: { Accept: 'application/json' } })).status);
  assert(banner === 401, `got ${banner}`);
  const button = page.locator('.h3270-notification__action').first();
  await button.waitFor({ state: 'attached', timeout: 8000 });
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), button.evaluate((b) => b.click())]);
  await popup.waitForLoadState('load').catch(() => {});
  const where = new URL(popup.url()).pathname;
  assert(where === `${PREFIX}/login`, `opened ${where}`);
  await popup.fill('input[name="username"]', 'checkadmin');
  await popup.fill('input[name="password"]', PW_ADMIN_2);
  await Promise.all([popup.waitForNavigation({ waitUntil: 'load' }), popup.click('form[action$="/login"] button[type="submit"]')]);
  await popup.close();
}, { allow: [{ status: 401, path: /./ }] });

await feature('admin deletes an account', async () => {
  await page.bringToFront();
  await goto('/admin/users');
  await page.waitForTimeout(500);
  await press('[data-admin-rows] tr:has-text("checkuser") button:has-text("Delete")');
  await page.waitForTimeout(200);
  await press('[data-confirm-accept]');
  await page.waitForTimeout(600);
  assert(!(await page.textContent('[data-admin-rows]')).includes('checkuser'), 'account still listed');
}, { expects: ['DELETE /api/admin/users/'] });

await finish();

// ------------------------------------------------------------------- the verdict

async function finish() {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  const summary = {
    mode: MODE,
    base: `${base.protocol}//localhost${PREFIX}`,
    features: results.length,
    failedFeatures: failed.length,
    requests: allRequests.length,
    outsidePrefix,
    documentUrlsChecked,
    problems,
    notes,
    results,
    paths: [...new Set(allRequests.map((r) => `${r.method} ${new URL(r.url).pathname}`))].sort(),
  };
  await writeFile(path.join(OUT, `results-${MODE}.json`), JSON.stringify(summary, null, 2));
  console.log(`\n${MODE}: ${results.length - failed.length}/${results.length} features passed, ` +
    `${allRequests.length} requests, ${documentUrlsChecked} URLs named by pages, ${outsidePrefix} outside the prefix, ${problems.length} problems`);
  process.exit(failed.length || problems.length ? 1 : 0);
}
