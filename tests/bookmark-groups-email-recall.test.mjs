import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import {
  createProfileScopedStorage,
  createBookmarksRepo,
  createEmailAddressesRepo,
  createAddressProfilesRepo,
  createFormFieldValuesRepo
} from '../packages/shared-ui/src/services/profileStorage.js';
import { setupDomShim } from './dom-shim.mjs';

function makeStorage() {
  const values = new Map();
  const backing = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
  let activeProfile = 'personal';
  return {
    backing,
    setProfile: (profileId) => { activeProfile = profileId; },
    storage: createProfileScopedStorage({ backing, getProfileId: () => activeProfile })
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

setupDomShim();

test('address profiles are normalized, profile-scoped, defaulted, editable and removable', async () => {
  const { storage, setProfile } = makeStorage();
  const repo = createAddressProfilesRepo(storage);
  const home = await repo.addAddress({
    label: '  Home  ', fullName: ' Ama Mensah ', addressLine1: '  12 Lake Road ', city: 'Kumasi',
    country: 'Ghana', postalCode: 'AK-039-5028', phone: '+233 24 000 0000', email: 'ama@example.com', isDefault: true
  });
  assert.match(home.id, /^addr-/);
  assert.equal(home.label, 'Home');
  assert.equal(home.fullName, 'Ama Mensah');
  assert.equal((await repo.getAllAddresses())[0].isDefault, true);

  const work = await repo.addAddress({ label: 'Work', addressLine1: '2 Market Street', city: 'Accra' });
  assert.equal((await repo.setDefaultAddress(work.id)), true);
  assert.equal((await repo.getAllAddresses()).find((item) => item.id === work.id).isDefault, true);
  assert.equal((await repo.getAllAddresses()).find((item) => item.id === home.id).isDefault, false);
  assert.equal(await repo.addAddress({ addressLine1: 'Bad', email: 'not-an-email' }), null);
  assert.deepEqual(await repo.touchAddress(home.id), (await repo.getAllAddresses()).find((item) => item.id === home.id));

  setProfile('work-profile');
  assert.deepEqual(await repo.getAllAddresses(), []);
  const profileRepo = createAddressProfilesRepo(storage);
  await profileRepo.addAddress({ label: 'Office', addressLine1: '4 High Street' });
  setProfile('personal');
  assert.equal((await repo.getAllAddresses()).length, 2);
  await repo.removeAddress(home.id);
  assert.equal((await repo.getAllAddresses()).length, 1);
  await repo.clearAddresses();
  assert.deepEqual(await repo.getAllAddresses(), []);
});


test('previously entered form values are deduplicated, field-matched, removable and profile-scoped', async () => {
  const { storage, setProfile } = makeStorage();
  const repo = createFormFieldValuesRepo(storage);
  const first = await repo.addValue({ fieldKey: 'field:referralcode', label: 'Referral code', value: ' YAYRA-123 ' });
  const duplicate = await repo.addValue({ fieldKey: 'FIELD:REFERRALCODE', label: 'Referral code', value: 'yayra-123' });
  await repo.addValue({ fieldKey: 'field:companyname', label: 'Company', value: 'Yayra' });
  assert.equal(duplicate.id, first.id);
  assert.deepEqual((await repo.getValuesForField('field:referralcode')).map((item) => item.value), ['yayra-123']);
  assert.equal(await repo.addValue({ fieldKey: '', value: 'orphan' }), null);
  setProfile('other-profile');
  assert.deepEqual(await repo.getAllValues(), []);
  setProfile('personal');
  await repo.removeValue(first.id);
  assert.deepEqual((await repo.getValuesForField('field:referralcode')), []);
  await repo.clearValues();
  assert.deepEqual(await repo.getAllValues(), []);
});

test('Bookmarks page creates/selects groups, sets the default and moves bookmarks', async () => {
  const { storage } = makeStorage();
  const repo = createBookmarksRepo(storage);
  const created = await repo.createGroup('Work');
  assert.equal(created.ok, true);
  const workBookmark = await repo.addBookmark({ url: 'https://work.example/', title: 'Work site', groupId: created.group.id });
  const barBookmark = await repo.addBookmark({ url: 'https://bar.example/', title: 'Pinned' });

  const shell = new BrowserShell({
    container: document.createElement('div'),
    bookmarksRepo: repo,
    tabs: [{ id: 'bookmarks-tab', url: 'yayra://bookmarks', title: 'Bookmarks' }]
  });
  shell.state.bookmarksItems = await repo.getAllBookmarks();
  shell.state.bookmarkGroups = await repo.getGroups();
  shell.state.bookmarkDefaultGroupId = await repo.getDefaultGroupId();
  shell.state.bookmarksActiveGroupId = created.group.id;
  let renderCalls = 0;
  shell.render = () => { renderCalls += 1; };
  shell.showTransientNotice = () => {};

  const viewport = document.createElement('div');
  shell.renderInternalBookmarksPage(viewport);
  assert.equal(viewport.querySelectorAll('.fb-folder-pill').length, 4, 'the built-in folders and custom group are clickable');
  assert.equal(viewport.querySelectorAll('.fb-library-card').length, 1, 'the selected group filters its cards');
  assert.equal(viewport.querySelector('.fb-library-card').dataset.id, workBookmark.id);
  assert.match(viewport.querySelector('.fb-bookmark-default-label').textContent, /Bookmarks Bar/);

  const searchInput = viewport.querySelector('#fb-in-bm-search');
  const searchCard = viewport.querySelector('.fb-library-card');
  const emptyState = viewport.querySelector('.fb-bookmarks-empty-state');
  searchInput.value = 'work';
  searchInput.dispatchEvent({ type: 'input', target: searchInput });
  assert.equal(searchCard.style.display, '', 'matching bookmarks stay visible while typing');
  assert.equal(renderCalls, 0, 'search filters the list without rebuilding the page and losing focus');
  searchInput.value = 'not found';
  searchInput.dispatchEvent({ type: 'input', target: searchInput });
  assert.equal(searchCard.style.display, 'none');
  assert.equal(emptyState.style.display, '', 'the empty message appears when no bookmark matches');
  searchInput.value = '';
  searchInput.dispatchEvent({ type: 'input', target: searchInput });
  assert.equal(searchCard.style.display, '');
  assert.equal(emptyState.style.display, 'none');

  viewport.querySelector('.fb-in-bm-set-default').click();
  await nextTurn();
  assert.equal(await repo.getDefaultGroupId(), created.group.id, 'the selected folder becomes the default for new bookmarks');
  const defaultedBookmark = await repo.addBookmark({ url: 'https://default.example/', title: 'Uses the selected default' });
  assert.equal(defaultedBookmark.groupId, created.group.id, 'new bookmarks use the selected default group');

  const moveSelect = viewport.querySelector('.fb-in-bm-move');
  moveSelect.value = 'bookmarks-bar';
  moveSelect.dispatchEvent({ type: 'change', target: moveSelect });
  await nextTurn();
  assert.equal((await repo.getAllBookmarks()).find((item) => item.id === workBookmark.id).groupId, 'bookmarks-bar');

  shell._textPromptDialog = async () => 'Research';
  viewport.querySelector('.fb-in-bm-new-group').click();
  await nextTurn();
  assert.ok((await repo.getGroups()).some((group) => group.name === 'Research'), 'new groups persist');
  assert.notEqual(barBookmark.groupId, created.group.id, 'the default group applies to newly-created bookmarks without moving existing ones');
  shell.destroy();
});


test('email recall: shell suggests and remembers addresses for normal tabs, never Incognito tabs', async () => {
  const { storage } = makeStorage();
  const emailRepo = createEmailAddressesRepo(storage);
  await emailRepo.addEmail('saved@example.com');
  const suggestions = [];
  globalThis.window.yayra = {
    webview: {
      onEvent: () => () => {},
      ensure: async () => ({ ok: true }),
      setBounds: () => {},
      setVisible: async () => {},
      setPointerTheme: async () => {},
      suggestEmailAddresses: async (tabId, emails) => { suggestions.push({ tabId, emails }); return { suggested: true }; }
    }
  };
  const shell = new BrowserShell({
    container: document.createElement('div'),
    emailAddressesRepo: emailRepo,
    tabs: [
      { id: 'normal-tab', url: 'https://example.com/login', isPrivate: false },
      { id: 'private-tab', url: 'https://example.com/login', isPrivate: true }
    ]
  });
  shell.handleNativeWebviewEvent({
    tabId: 'normal-tab', type: 'email-field-focused', url: 'https://example.com/login'
  });
  await nextTurn();
  assert.deepEqual(suggestions, [{ tabId: 'normal-tab', emails: ['saved@example.com'] }]);

  shell.handleNativeWebviewEvent({
    tabId: 'normal-tab', type: 'email-address-captured', email: 'new@example.org', url: 'https://example.com/register'
  });
  await nextTurn();
  assert.deepEqual((await emailRepo.getAllEmails()).map((item) => item.email), ['new@example.org', 'saved@example.com']);
  assert.equal(suggestions.length, 2, 'a newly remembered address refreshes open normal tabs');
  assert.ok(suggestions.every((entry) => entry.tabId === 'normal-tab'));

  shell.handleNativeWebviewEvent({
    tabId: 'private-tab', type: 'email-address-captured', email: 'private@example.net', url: 'https://example.com/register'
  });
  shell.handleNativeWebviewEvent({
    tabId: 'private-tab', type: 'email-field-focused', url: 'https://example.com/login'
  });
  await nextTurn();
  assert.deepEqual((await emailRepo.getAllEmails()).map((item) => item.email), ['new@example.org', 'saved@example.com']);
  assert.equal(suggestions.length, 2, 'Incognito fields never receive saved addresses or refreshed lists');
  assert.ok(suggestions.every((entry) => entry.tabId !== 'private-tab'));
  shell.destroy();
});


test('Passwords & Keys page lists saved emails and lets the user remove or clear them', async () => {
  const { storage } = makeStorage();
  const emailRepo = createEmailAddressesRepo(storage);
  const first = await emailRepo.addEmail('first@example.com');
  await emailRepo.addEmail('second@example.org');
  const shell = new BrowserShell({
    container: document.createElement('div'),
    emailAddressesRepo: emailRepo,
    tabs: [{ id: 'vault-tab', url: 'yayra://passwords' }]
  });
  shell.state.rememberedEmails = await emailRepo.getAllEmails();
  shell.render = () => {};
  shell.showTransientNotice = () => {};

  const viewport = document.createElement('div');
  shell.renderInternalPasswordsPage(viewport);
  assert.match(viewport.textContent, /Remembered email addresses/);
  assert.equal(viewport.querySelectorAll('.fb-saved-email-row').length, 2);
  const removeButton = viewport.querySelectorAll('.fb-in-email-remove').find((button) => button.dataset.emailId === first.id);
  assert.ok(removeButton, 'saved email has a per-address Remove control');
  removeButton.click();
  await nextTurn();
  assert.deepEqual((await emailRepo.getAllEmails()).map((item) => item.email), ['second@example.org']);

  const clearButton = viewport.querySelector('.fb-in-email-clear');
  clearButton.click();
  await nextTurn();
  assert.deepEqual(await emailRepo.getAllEmails(), []);
  shell.destroy();
});

test('address profiles stay profile-scoped, avoid private tabs, and render management controls', async () => {
  const { storage } = makeStorage();
  const repo = createAddressProfilesRepo(storage);
  const formValuesRepo = createFormFieldValuesRepo(storage);
  const saved = await repo.addAddress({ label: 'Home', fullName: 'Ama Mensah', addressLine1: '12 Lake Road', city: 'Kumasi', country: 'Ghana', isDefault: true });
  const suggestions = [];
  const shell = new BrowserShell({
    container: document.createElement('div'),
    addressProfilesRepo: repo,
    formFieldValuesRepo: formValuesRepo,
    tabs: [
      { id: 'checkout', url: 'https://shop.example/checkout' },
      { id: 'private-checkout', url: 'https://shop.example/checkout', isPrivate: true }
    ]
  });
  Object.defineProperty(shell, 'nativeWebview', {
    configurable: true,
    value: {
      suggestAutofillAddresses: async (tabId, payload) => suggestions.push({ tabId, payload }),
      suggestFormFieldValues: async (tabId, payload) => suggestions.push({ tabId, payload, generic: true })
    }
  });
  shell.state.addressProfiles = await repo.getAllAddresses();
  shell.state.passwordsActiveSection = 'addresses';
  shell.render = () => {};
  shell.showTransientNotice = () => {};
  await shell.handleAddressFieldFocused(shell.state.tabs[0], { url: 'https://shop.example/checkout', field: 'addressLine1' });
  await shell.handleAddressFieldFocused(shell.state.tabs[1], { url: 'https://shop.example/checkout', field: 'addressLine1' });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].payload.addresses[0].id, saved.id);
  await shell.handleFormFieldCaptured(shell.state.tabs[0], {
    url: 'https://shop.example/checkout', fieldKey: 'field:referralcode', label: 'Referral code', value: 'YAYRA-123'
  });
  await shell.handleFormFieldCaptured(shell.state.tabs[1], {
    url: 'https://shop.example/checkout', fieldKey: 'field:referralcode', label: 'Referral code', value: 'PRIVATE'
  });
  await shell.handleFormFieldFocused(shell.state.tabs[0], {
    url: 'https://shop.example/checkout', fieldKey: 'field:referralcode'
  });
  assert.equal(suggestions.filter((item) => item.generic).length, 1);
  assert.equal(suggestions.find((item) => item.generic).payload.values[0].value, 'YAYRA-123');

  const viewport = document.createElement('div');
  shell.renderInternalPasswordsPage(viewport);
  assert.match(viewport.textContent, /Addresses &amp; Autofill/);
  assert.match(viewport.textContent, /12 Lake Road/);
  assert.equal(viewport.querySelectorAll('.fb-address-edit').length, 1);
  assert.equal(viewport.querySelectorAll('.fb-address-remove').length, 1);
  viewport.querySelector('.fb-in-add-address-btn').click();
  assert.ok(shell.state.addressFormOpen);
  shell.destroy();
});

class IsolatedPageElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.style = { cssText: '', display: '', width: '', left: '', top: '' };
    this.className = '';
    this.type = '';
    this.name = '';
    this.id = '';
    this.disabled = false;
    this.form = null;
    this._value = '';
    this._text = '';
    this._innerHTML = '';
  }

  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    if (this.tagName === 'SHADOWROOT' && this._innerHTML.includes('class="menu"')) {
      const menu = new IsolatedPageElement('div');
      menu.className = 'menu';
      this.appendChild(menu);
    }
  }
  get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join('') : this._text; }
  set textContent(value) { this._text = String(value); this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) || null; }
  attachShadow({ mode } = {}) {
    this.shadowMode = mode;
    this._shadowRoot = new IsolatedPageElement('shadowroot');
    return this._shadowRoot;
  }
  matches(selector) {
    if (selector === 'input[type="password"]') return this.tagName === 'INPUT' && this.type === 'password';
    if (selector === 'input[type="submit"]') return this.tagName === 'INPUT' && this.type === 'submit';
    return false;
  }
  querySelector(selector) {
    if (selector === '.menu' && this.tagName === 'SHADOWROOT') return this.children.find((child) => child.className === 'menu') || null;
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    if (selector === 'input[type="password"]') return [];
    const results = [];
    const visit = (element) => {
      const matches = selector === 'input' ? element.tagName === 'INPUT'
        : selector === 'input, textarea, select' ? ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
          : selector === '.item' ? element.className.split(' ').includes('item')
            : selector === '.address-option' ? element.className.split(' ').includes('address-option')
              : false;
      if (matches) results.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return results;
  }
  getBoundingClientRect() {
    if (this.style.display === 'none') return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    if (this.tagName === 'INPUT') return { left: 32, right: 232, top: 80, bottom: 112, width: 200, height: 32 };
    return { left: 0, right: 240, top: 0, bottom: 40, width: 240, height: this.children.length ? 40 : 0 };
  }
}


test('address autofill preload requires a picker choice before filling matching checkout fields', () => {
  const source = readFileSync(new URL('../electron/autofillPreload.cjs', import.meta.url), 'utf8');
  const pageEvents = new Map();
  const ipcEvents = new Map();
  const sent = [];
  const html = new IsolatedPageElement('html');
  const document = {
    documentElement: html,
    readyState: 'complete',
    addEventListener(type, listener) {
      if (!pageEvents.has(type)) pageEvents.set(type, []);
      pageEvents.get(type).push(listener);
    },
    createElement: (tagName) => new IsolatedPageElement(tagName),
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null
  };
  const form = new IsolatedPageElement('form');
  const makeField = (name, value = '') => {
    const field = new IsolatedPageElement('input');
    field.type = 'text'; field.name = name; field.value = value; field.form = form;
    form.appendChild(field);
    return field;
  };
  const street = makeField('addressLine1');
  const city = makeField('city');
  const fullName = makeField('fullName');
  const ipcRenderer = {
    send: (channel, payload) => sent.push({ channel, payload }),
    on(channel, listener) {
      if (!ipcEvents.has(channel)) ipcEvents.set(channel, []);
      ipcEvents.get(channel).push(listener);
    },
    emit(channel, payload) { for (const listener of ipcEvents.get(channel) || []) listener({}, payload); }
  };
  const window = { innerWidth: 1024, innerHeight: 768, addEventListener: () => {} };
  runInNewContext(source, {
    require: (name) => name === 'electron' ? { ipcRenderer } : {}, document, window,
    location: { href: 'https://shop.example/checkout', origin: 'https://shop.example' },
    HTMLInputElement: IsolatedPageElement, HTMLTextAreaElement: IsolatedPageElement, HTMLSelectElement: IsolatedPageElement,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    Event: class { constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles; } },
    setTimeout: () => 1, setInterval: () => 1, clearInterval: () => {}, console
  });

  for (const listener of pageEvents.get('focusin') || []) listener({ target: street });
  assert.equal(street.value, '', 'focusing a checkout field never fills it automatically');
  assert.ok(sent.some((message) => message.channel === 'yayra:address-field-focused'));
  ipcRenderer.emit('yayra:address-suggestions', { addresses: [{
    id: 'addr-123-saved', label: 'Home', fullName: 'Ama Mensah', addressLine1: '12 Lake Road', city: 'Kumasi', isDefault: true
  }] });
  const host = html.children[0];
  assert.equal(host.shadowMode, 'closed');
  const picker = host._shadowRoot.children[0];
  const choice = picker.children.find((child) => child.className.includes('address-option'));
  assert.ok(choice, 'the browser-owned menu offers a saved profile');
  choice.dispatchEvent({ type: 'click', target: choice });
  assert.equal(street.value, '12 Lake Road');
  assert.equal(city.value, 'Kumasi');
  assert.equal(fullName.value, 'Ama Mensah');
  assert.equal(host.style.display, 'none');
  assert.ok(sent.some((message) => message.channel === 'yayra:address-profile-selected'
    && message.payload.addressId === 'addr-123-saved'));

  const referral = makeField('referralCode');
  for (const listener of pageEvents.get('focusin') || []) listener({ target: referral });
  assert.ok(sent.some((message) => message.channel === 'yayra:form-field-focused'
    && message.payload.fieldKey === 'field:referralcode'));
  ipcRenderer.emit('yayra:form-suggestions', { fieldKey: 'field:referralcode', values: [
    { id: 'formval-123-saved', fieldKey: 'field:referralcode', label: 'Referral code', value: 'YAYRA-123' }
  ] });
  const formHost = html.children.find((child) => child !== host);
  assert.equal(formHost.shadowMode, 'closed');
  const formMenu = formHost._shadowRoot.children[0];
  const remembered = formMenu.children.find((child) => child.tagName === 'BUTTON' && child.textContent === 'YAYRA-123');
  assert.ok(remembered);
  remembered.dispatchEvent({ type: 'click', target: remembered });
  assert.equal(referral.value, 'YAYRA-123');
  assert.ok(sent.some((message) => message.channel === 'yayra:form-value-selected'
    && message.payload.valueId === 'formval-123-saved'));
});

test('autofill preload shows saved email suggestions in a closed picker and captures submitted addresses', () => {
  const source = readFileSync(new URL('../electron/autofillPreload.cjs', import.meta.url), 'utf8');
  const pageEvents = new Map();
  const ipcEvents = new Map();
  const sent = [];
  const html = new IsolatedPageElement('html');
  const document = {
    documentElement: html,
    readyState: 'complete',
    addEventListener(type, listener) {
      if (!pageEvents.has(type)) pageEvents.set(type, []);
      pageEvents.get(type).push(listener);
    },
    createElement: (tagName) => new IsolatedPageElement(tagName),
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null
  };
  const input = new IsolatedPageElement('input');
  input.type = 'email';
  input.name = 'email';
  input.value = '';
  const form = new IsolatedPageElement('form');
  form.appendChild(input);
  input.form = form;
  const ipcRenderer = {
    send: (channel, payload) => sent.push({ channel, payload }),
    on(channel, listener) {
      if (!ipcEvents.has(channel)) ipcEvents.set(channel, []);
      ipcEvents.get(channel).push(listener);
    },
    emit(channel, payload) {
      for (const listener of ipcEvents.get(channel) || []) listener({}, payload);
    }
  };
  const window = { innerWidth: 1024, innerHeight: 768, addEventListener: () => {} };
  runInNewContext(source, {
    require: (name) => name === 'electron' ? { ipcRenderer } : {},
    document,
    window,
    location: { href: 'https://example.com/register', origin: 'https://example.com' },
    HTMLInputElement: IsolatedPageElement,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    Event: class { constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles; } },
    setTimeout: () => 1,
    setInterval: () => 1,
    clearInterval: () => {},
    console
  });

  for (const listener of pageEvents.get('focusin') || []) listener({ target: input });
  assert.equal(sent[0].channel, 'yayra:email-field-focused', 'field focus requests saved profile suggestions');
  ipcRenderer.emit('yayra:email-suggestions', { emails: ['ada@example.com'] });
  const host = html.children[0];
  assert.equal(host.shadowMode, 'closed', 'the page cannot inspect saved values inside the browser picker');
  assert.equal(host.style.display, 'block');

  let prevented = false;
  for (const listener of pageEvents.get('keydown') || []) {
    listener({ key: 'Enter', target: input, preventDefault: () => { prevented = true; } });
  }
  assert.equal(prevented, true, 'Enter selects the focused saved address');
  assert.equal(input.value, 'ada@example.com');
  assert.equal(host.style.display, 'none');

  input.value = 'submitted@example.org';
  for (const listener of pageEvents.get('submit') || []) listener({ target: form });
  assert.ok(sent.some((message) => message.channel === 'yayra:email-address-captured'
    && message.payload.email === 'submitted@example.org'), 'a submitted address is sent to profile storage');
  const preloadBridge = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preloadBridge, /suggestEmailAddresses:\s*\(tabId, emails = \[\]\)\s*=> ipcRenderer\.invoke\('yayra:webview-suggest-email-addresses'/);
});
