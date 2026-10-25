/**
 * Browser Profiles - the Chrome-style "keep your browsing separate" feature.
 *
 * Covers:
 *  - ProfileService decision table (evaluateSignIn): adopt / none /
 *    suggest-switch / suggest-create, email normalization, non-email
 *    usernames ignored, "No thanks" remembered forever per account.
 *  - Persistence across service instances (same storage).
 *  - Profile CRUD guards (can't delete last profile; deleting the current
 *    profile falls back cleanly).
 *  - BrowserShell integration: autofill-captured and Yayra account
 *    sign-ins raise the suggestion card; accept creates+switches (fresh
 *    tabs); decline is remembered; dropdown lists profiles and switches.
 *  - Electron bridge: per-profile persistent session partitions; default
 *    profile keeps the legacy partition; incognito unchanged; a tab's
 *    view is recreated when ensured under a different profile.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { ProfileService, DEFAULT_PROFILE_ID } from '../packages/shared-ui/src/services/profileService.js';
import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, val) { this.map.set(key, String(val)); }
  removeItem(key) { this.map.delete(key); }
}

/* --------------------------- ProfileService --------------------------- */

test('Profiles: fresh install has a single default profile with no email', () => {
  const svc = new ProfileService({ storage: new MemoryStorage() });
  const profiles = svc.list();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, DEFAULT_PROFILE_ID);
  assert.equal(profiles[0].email, null);
  assert.equal(svc.current().id, DEFAULT_PROFILE_ID);
});

test('Profiles: first email sign-in silently ADOPTS the current profile (no prompt)', () => {
  const svc = new ProfileService({ storage: new MemoryStorage() });
  const verdict = svc.evaluateSignIn('Ada@Example.COM ');
  assert.equal(verdict.action, 'adopted');
  assert.equal(svc.current().email, 'ada@example.com');
  assert.equal(svc.current().name, 'Ada', 'default name upgraded from the email');
  // Same account again -> nothing to do.
  assert.equal(svc.evaluateSignIn('ada@example.com').action, 'none');
});

test('Profiles: non-email usernames never trigger profile logic', () => {
  const svc = new ProfileService({ storage: new MemoryStorage() });
  assert.equal(svc.evaluateSignIn('jess92').action, 'none');
  assert.equal(svc.evaluateSignIn('not an email@').action, 'none');
  assert.equal(svc.evaluateSignIn('').action, 'none');
  assert.equal(svc.current().email, null, 'profile must stay unbound');
});

test('Profiles: a DIFFERENT email suggests creating a separate profile', () => {
  const svc = new ProfileService({ storage: new MemoryStorage() });
  svc.evaluateSignIn('ada@example.com');
  const verdict = svc.evaluateSignIn('grace@example.com');
  assert.equal(verdict.action, 'suggest-create');
  assert.equal(verdict.email, 'grace@example.com');
});

test('Profiles: an email that already owns a profile suggests SWITCHING to it', () => {
  const svc = new ProfileService({ storage: new MemoryStorage() });
  svc.evaluateSignIn('ada@example.com');
  const grace = svc.createProfile({ email: 'grace@example.com' });
  const verdict = svc.evaluateSignIn('grace@example.com');
  assert.equal(verdict.action, 'suggest-switch');
  assert.equal(verdict.profile.id, grace.id);
});

test('Profiles: "No thanks" is remembered forever per account - never a nag', () => {
  const storage = new MemoryStorage();
  const svc = new ProfileService({ storage });
  svc.evaluateSignIn('ada@example.com');
  assert.equal(svc.evaluateSignIn('grace@example.com').action, 'suggest-create');
  svc.dismissAccount('grace@example.com');
  assert.equal(svc.evaluateSignIn('grace@example.com').action, 'none');
  // Survives a restart (new instance, same storage).
  const svc2 = new ProfileService({ storage });
  assert.equal(svc2.evaluateSignIn('grace@example.com').action, 'none');
});

test('Profiles: state persists across instances via storage', () => {
  const storage = new MemoryStorage();
  const svc = new ProfileService({ storage });
  svc.evaluateSignIn('ada@example.com');
  const grace = svc.createProfile({ email: 'grace@example.com' });
  svc.switchTo(grace.id);

  const svc2 = new ProfileService({ storage });
  assert.equal(svc2.list().length, 2);
  assert.equal(svc2.current().id, grace.id);
  assert.equal(svc2.current().email, 'grace@example.com');
});

test('Profiles: binding a second window does not rewrite the shared persisted current profile', () => {
  const storage = new MemoryStorage();
  const seed = new ProfileService({ storage });
  const work = seed.createProfile({ name: 'Work' });
  assert.equal(seed.current().id, DEFAULT_PROFILE_ID);

  const workWindow = new ProfileService({ storage });
  assert.equal(workWindow.bindToWindow(work.id).id, work.id);
  assert.equal(workWindow.current().id, work.id, 'this window is bound to Work');

  // Persist unrelated profile metadata from the bound window. currentId must
  // remain the original/default identity rather than leaking Work globally.
  workWindow.renameProfile(work.id, 'Work account');
  const restartedMain = new ProfileService({ storage });
  assert.equal(restartedMain.current().id, DEFAULT_PROFILE_ID);
  assert.equal(restartedMain.list().find((profile) => profile.id === work.id).name, 'Work account');
});

test('Profiles: the last profile can never be deleted; deleting current falls back', () => {
  const svc = new ProfileService({ storage: new MemoryStorage() });
  assert.equal(svc.deleteProfile(DEFAULT_PROFILE_ID), false, 'last profile is undeletable');
  const extra = svc.createProfile({ name: 'Work' });
  svc.switchTo(extra.id);
  assert.equal(svc.deleteProfile(extra.id), true);
  assert.equal(svc.current().id, DEFAULT_PROFILE_ID, 'falls back to remaining profile');
});

test('Profiles: corrupted storage falls back to a clean default profile', () => {
  const storage = new MemoryStorage();
  storage.setItem('yayra:profiles', '{not json');
  const svc = new ProfileService({ storage });
  assert.equal(svc.list().length, 1);
  assert.equal(svc.current().id, DEFAULT_PROFILE_ID);
});

/* ------------------------ BrowserShell integration ------------------------ */

function makeShell({ storage = new MemoryStorage() } = {}) {
  const container = document.createElement('div');
  const profileService = new ProfileService({ storage });
  const shell = new BrowserShell({ container, isMobile: false, profileService });
  shell.render(container);
  return { shell, container, profileService, storage };
}

test('Shell: site sign-in with a second account raises the "keep separate" card', async () => {
  const { shell, container } = makeShell();
  // First account adopts silently - no card.
  shell.handleAccountSignal('ada@example.com', { source: 'site-signin' });
  assert.equal(shell.state.profileSuggestion, null, 'first sign-in adopts silently');

  shell.handleAccountSignal('grace@example.com', { source: 'site-signin' });
  assert.ok(shell.state.profileSuggestion, 'second account must raise a suggestion');
  assert.equal(shell.state.profileSuggestion.action, 'suggest-create');
  assert.equal(shell.state.profileSuggestion.email, 'grace@example.com');

  shell.render(container);
  const card = container.querySelector('.fb-profile-suggestion-card');
  assert.ok(card, 'suggestion card must render');
  assert.ok(card.querySelector('.fb-profile-suggestion-accept'), 'has accept button');
  assert.ok(card.querySelector('.fb-profile-suggestion-decline'), 'has decline button');
});

test('Shell: accepting the suggestion creates the profile, switches, and resets tabs', () => {
  const { shell, profileService } = makeShell();
  shell.handleAccountSignal('ada@example.com');
  shell.handleAccountSignal('grace@example.com');
  assert.ok(shell.state.profileSuggestion);

  shell.acceptProfileSuggestion();

  assert.equal(shell.state.profileSuggestion, null);
  assert.equal(profileService.list().length, 2);
  assert.equal(profileService.current().email, 'grace@example.com');
  assert.equal(shell.state.tabs.length, 1, 'fresh slate for the new profile');
  assert.equal(shell.state.tabs[0].url, 'yayra://newtab');
});

test('Shell: declining is remembered - the same account never prompts again', () => {
  const storage = new MemoryStorage();
  const { shell } = makeShell({ storage });
  shell.handleAccountSignal('ada@example.com');
  shell.handleAccountSignal('grace@example.com');
  shell.declineProfileSuggestion();
  assert.equal(shell.state.profileSuggestion, null);

  // Same session, fresh signal set - still no prompt.
  shell._profileSignalsSeen.clear();
  shell.handleAccountSignal('grace@example.com');
  assert.equal(shell.state.profileSuggestion, null, 'dismissed account must stay quiet');

  // And after a "restart" with the same storage.
  const { shell: shell2 } = makeShell({ storage });
  shell2.handleAccountSignal('grace@example.com');
  assert.equal(shell2.state.profileSuggestion, null, 'dismissal persists across restarts');
});

test('Shell: suggestion offers SWITCH when the account already owns a profile', () => {
  const { shell, profileService } = makeShell();
  shell.handleAccountSignal('ada@example.com');
  const grace = profileService.createProfile({ email: 'grace@example.com' });
  shell.handleAccountSignal('grace@example.com');
  assert.equal(shell.state.profileSuggestion.action, 'suggest-switch');
  assert.equal(shell.state.profileSuggestion.profileId, grace.id);

  shell.acceptProfileSuggestion();
  assert.equal(profileService.current().id, grace.id);
  assert.equal(profileService.list().length, 2, 'no duplicate profile created');
});

test('Shell: account dropdown lists profiles and switching works from it', () => {
  const { shell, container, profileService } = makeShell();
  const work = profileService.createProfile({ name: 'Work' });

  shell.state.isAccountMenuOpen = true;
  shell.render(container);

  const rows = container.querySelectorAll('.fb-profile-row');
  // 2 profiles + the "Add profile" row.
  assert.equal(rows.length, 3, 'two profiles plus Add profile');
  const workRow = rows.find((r) => r.getAttribute('data-profile-id') === work.id);
  assert.ok(workRow, 'work profile row present');

  workRow.click();
  assert.equal(profileService.current().id, work.id, 'clicking a row switches profile');
  assert.equal(shell.state.isAccountMenuOpen, false, 'menu closes after switching');
});

test('account dropdown keeps Google services and a separate Google shortcut directly together', () => {
  const { shell, container } = makeShell();
  try {
    shell.state.isAccountMenuOpen = true;
    shell.render(container);
    const services = container.querySelector('.fb-account-services-btn');
    const google = container.querySelector('.fb-account-google-btn');
    assert.ok(services);
    assert.ok(google);
    assert.equal(services.parentElement, google.parentElement, 'both shortcuts belong to the same account action group');
    assert.ok(services.parentElement.children.indexOf(google) === services.parentElement.children.indexOf(services) + 1,
      'Google sits directly below Open Google services');
    google.click();
    assert.equal(shell.getActiveTab().url, 'https://www.google.com/');
    assert.equal(shell.state.isAccountMenuOpen, false);
  } finally { shell.destroy(); container.remove(); }
});

test('Shell: "Add profile" creates and switches to a brand-new profile', () => {
  const { shell, container, profileService } = makeShell();
  shell.state.isAccountMenuOpen = true;
  shell.render(container);

  const addBtn = container.querySelector('.fb-profile-add-btn');
  assert.ok(addBtn, 'Add profile row present');
  addBtn.click();

  assert.equal(profileService.list().length, 2);
  assert.notEqual(profileService.current().id, DEFAULT_PROFILE_ID);
});

test('Shell: Yayra Google sign-in feeds the same smart profile logic', () => {
  const { shell } = makeShell();
  shell.handleAccountSignal('me@gmail.com', { source: 'yayra-account' });
  assert.equal(shell.profileService.current().email, 'me@gmail.com', 'adopted');
  shell.handleAccountSignal('other@gmail.com', { source: 'yayra-account' });
  assert.equal(shell.state.profileSuggestion.action, 'suggest-create');
});

test('Shell: each account only prompts once per session even without dismissal', () => {
  const { shell } = makeShell();
  shell.handleAccountSignal('ada@example.com');
  shell.handleAccountSignal('grace@example.com');
  shell.state.profileSuggestion = null; // user ignored the card (e.g. navigated)
  shell.handleAccountSignal('grace@example.com');
  assert.equal(shell.state.profileSuggestion, null, 'no repeat prompt in-session');
});

/* ------------------------- Electron bridge partitions ------------------------- */

async function makeBridgeHarness() {
  const { createWebviewBridge } = await import('../electron/webviewBridge.cjs');
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {}
  };
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { send: () => {} },
    contentView: {
      children: [],
      addChildView(view) { this.children.push(view); },
      removeChildView(view) { this.children = this.children.filter((v) => v !== view); }
    }
  };
  const views = [];
  const WebContentsView = function FakeWebContentsView(opts) {
    let destroyed = false;
    const listeners = new Map();
    const view = {
      __options: opts || null,
      webContents: {
        loadURL: async () => {},
        isDestroyed: () => destroyed,
        close: () => { destroyed = true; },
        stop: () => {},
        setUserAgent: () => {},
        setWindowOpenHandler: () => {},
        on: (event, fn) => {
          if (!listeners.has(event)) listeners.set(event, []);
          listeners.get(event).push(fn);
        },
        send: () => {}
      },
      setBounds: () => {},
      setBackgroundColor: () => {}
    };
    views.push(view);
    return view;
  };
  const bridge = createWebviewBridge({
    WebContentsView,
    ipcMain,
    shell: { openExternal: async () => {} },
    Menu: { buildFromTemplate: (template) => ({ template, popup: () => {} }) },
    clipboard: { writeText: () => {} },
    getMainWindow: () => fakeWin,
    logger: { error: () => {} }
  });
  return { bridge, handlers, views, fakeWin };
}

test('Bridge: profiles map to separate persistent session partitions', async () => {
  const { handlers, views } = await makeBridgeHarness();
  const ensure = handlers.get('yayra:webview-ensure');

  // Default profile keeps the LEGACY partition (existing users keep sessions).
  await ensure(null, { tabId: 'tab-1', url: 'https://a.dev/', profileId: 'default' });
  assert.equal(views.at(-1).__options.webPreferences.partition, 'persist:yayra-webview');

  // Omitted profileId behaves as default too (older renderers).
  await ensure(null, { tabId: 'tab-2', url: 'https://a.dev/' });
  assert.equal(views.at(-1).__options.webPreferences.partition, 'persist:yayra-webview');

  // A second profile gets its own persist partition.
  await ensure(null, { tabId: 'tab-3', url: 'https://a.dev/', profileId: 'profile-123-9' });
  assert.equal(views.at(-1).__options.webPreferences.partition, 'persist:yayra-profile-profile-123-9');

  // Incognito is untouched by profiles - still per-tab, non-persistent.
  await ensure(null, { tabId: 'tab-4', url: 'https://a.dev/', isPrivate: true, profileId: 'profile-123-9' });
  assert.equal(views.at(-1).__options.webPreferences.partition, 'incognito-tab-4');
});

test('Bridge: re-ensuring a tab under a DIFFERENT profile recreates the view', async () => {
  const { handlers, views, fakeWin } = await makeBridgeHarness();
  const ensure = handlers.get('yayra:webview-ensure');

  await ensure(null, { tabId: 'tab-x', url: 'https://a.dev/', profileId: 'default' });
  const first = views.at(-1);

  // Same profile again -> same view reused, nothing recreated.
  const countBefore = views.length;
  await ensure(null, { tabId: 'tab-x', url: 'https://a.dev/', profileId: 'default' });
  assert.equal(views.length, countBefore, 'same profile reuses the view');

  // Different profile -> old view destroyed, new one in the new partition.
  await ensure(null, { tabId: 'tab-x', url: 'https://a.dev/', profileId: 'p2' });
  const second = views.at(-1);
  assert.notEqual(second, first, 'view must be recreated');
  assert.equal(second.__options.webPreferences.partition, 'persist:yayra-profile-p2');
  assert.ok(!fakeWin.contentView.children.includes(first), 'old view detached from the window');
});
