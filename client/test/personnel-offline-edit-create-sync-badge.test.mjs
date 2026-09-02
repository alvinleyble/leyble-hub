// G3 (docs/offline-accessibility-acceptance-criteria.md) — captain decision 2026-09-02
// reversing the 2026-08-29 "let it be for now" deferral. Personnel used to compute one
// `mutationsBlocked` gate that disabled Save, photo upload, delete AND + Add Personnel
// alike whenever offline. This pins down the fix: the rest of the personnel edit form
// and + Add Personnel now queue via the outbox (updatePersonnelLocalFirst /
// queuedPersonnel.js, mirroring updateCustomerLocalFirst and createProductLocalFirst),
// while the active/inactive toggle, the ID photo, and Delete stay online-only
// (rules 9.0/9.1/9.2, unchanged). Mirrors client/test/customer-offline-edit-sync-badge
// .test.mjs's exact shape — the newest version of this pattern (PR #69).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { PERSONNEL_KEY } from '../src/offline/keys.js';
import { __clearOutbox, listRecords, enqueue, drainOutbox } from '../src/offline/outbox.js';
import {
  updatePersonnelLocalFirst, pendingPersonnelEditIds, queuedPersonnelFromOutbox,
} from '../src/offline/queuedPersonnel.js';
import { applyCatalogueDelta } from '../src/offline/catalogue.js';

const PersonnelPage        = (await import('../src/pages/personnel/PersonnelPage.jsx')).default;
const PersonnelFormModal   = (await import('../src/pages/personnel/PersonnelFormModal.jsx')).default;
const PersonnelDetailPanel = (await import('../src/pages/personnel/PersonnelDetailPanel.jsx')).default;

const PERSON = {
  id: 7, full_name: 'Juan dela Cruz', remarks: '', phone: '09171234567',
  license_number: 'N01-23-456789', is_active: true,
};

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  await __clearOutbox();
  localStorage.clear();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

const offline = () => { throw new TypeError('Failed to fetch'); };
const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function changeInput(input, value) {
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor.set.call(input, value);
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (key && input[key]?.onChange) {
    input[key].onChange({ target: { value, type: input.type || 'text', checked: input.checked } });
  }
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

// ── pendingPersonnelEditIds() ────────────────────────────────────────────────

test('pendingPersonnelEditIds: nothing pending to begin with', async () => {
  assert.equal((await pendingPersonnelEditIds()).size, 0);
});

test('pendingPersonnelEditIds: a queued personnel_update is reported by id', async () => {
  api.request = async () => offline();
  await applyCatalogueDelta('personnel', [PERSON]);

  await updatePersonnelLocalFirst(PERSON.id, { phone: '09990001111' }, { profileKey: 'josie' });

  const pending = await pendingPersonnelEditIds();
  assert.ok(pending.has(String(PERSON.id)), 'the person just edited says so');
});

test('pendingPersonnelEditIds: a queued CREATE is not reported as a pending edit — it has no row to badge', async () => {
  api.request = async () => offline();
  await enqueue({
    entityType: 'personnel', endpoint: '/personnel', method: 'POST',
    payload: { full_name: 'Bagong Driver' }, profileKey: 'josie',
  });

  assert.equal((await pendingPersonnelEditIds()).size, 0);
  assert.equal((await listRecords()).filter((r) => r.entity_type === 'personnel').length, 1);
});

test('pendingPersonnelEditIds: the badge clears itself once the edit drains', async () => {
  api.request = async () => offline();
  await applyCatalogueDelta('personnel', [PERSON]);

  await updatePersonnelLocalFirst(PERSON.id, { phone: '09990001111' }, { profileKey: 'josie' });
  assert.equal((await pendingPersonnelEditIds()).size, 1);

  api.request = async () => ({ ...PERSON, phone: '09990001111' });
  await drainOutbox();

  assert.equal((await pendingPersonnelEditIds()).size, 0, 'nothing is still waiting');
});

// ── queuedPersonnelFromOutbox() ──────────────────────────────────────────────

test('queuedPersonnelFromOutbox: a queued CREATE surfaces as a local- row', async () => {
  api.request = async () => offline();
  await enqueue({
    entityType: 'personnel', endpoint: '/personnel', method: 'POST',
    payload: { full_name: 'Bagong Driver', phone: '09995556666' }, profileKey: 'josie',
  });

  const rows = await queuedPersonnelFromOutbox();
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^local-/);
  assert.equal(rows[0].full_name, 'Bagong Driver');
  assert.equal(rows[0]._unsynced, true);
});

// ── PersonnelPage: the row badge itself ──────────────────────────────────────

test('PersonnelPage: an offline-edited personnel row shows Waiting to sync', async () => {
  await nativeStore.setJson(PERSONNEL_KEY, [PERSON]);
  api.get = async () => offline();
  api.request = async () => offline();

  const r = render(React.createElement(ToastProvider, null, React.createElement(PersonnelPage)));
  await settle();

  assert.match(r.text(), /Juan dela Cruz/);
  assert.doesNotMatch(r.text(), /Waiting to sync/, 'nothing queued yet');

  await act(async () => {
    await updatePersonnelLocalFirst(PERSON.id, { phone: '09990001111' }, { profileKey: 'josie' });
  });
  await settle();

  assert.match(r.text(), /Waiting to sync/, 'the edited row now shows the sync badge');
  r.unmount();
});

test('PersonnelPage: an offline-created personnel row is merged in and shows Waiting to sync', async () => {
  await nativeStore.setJson(PERSONNEL_KEY, [PERSON]);
  api.get = async () => offline();
  api.request = async () => offline();

  await enqueue({
    entityType: 'personnel', endpoint: '/personnel', method: 'POST',
    payload: { full_name: 'Bagong Driver' }, profileKey: 'josie',
  });

  const r = render(React.createElement(ToastProvider, null, React.createElement(PersonnelPage)));
  await settle();

  assert.match(r.text(), /Bagong Driver/, 'the queued create is merged into the roster');
  assert.match(r.text(), /Waiting to sync/);
  r.unmount();
});

// ── PersonnelFormModal: + Add Personnel offline ──────────────────────────────

test('PersonnelFormModal queues a new personnel record in the outbox instead of a bare POST that fails offline', async () => {
  let posted = false;
  api.post = async () => { posted = true; throw new Error('Failed to fetch'); };
  api.request = async () => offline();

  let savedCalled = false;
  const r = render(React.createElement(ToastProvider, null,
    React.createElement(PersonnelFormModal, { onClose() {}, onSaved() { savedCalled = true; } })));
  await settle(20);

  const nameInput = r.all('input').find((i) => i.type === 'text');
  act(() => { changeInput(nameInput, 'Bagong Driver'); });
  const saveBtn = r.all('button').find((b) => b.textContent.includes('Save'));
  await act(async () => {
    saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 60));
  });

  const queued = (await listRecords()).filter((rec) => rec.entity_type === 'personnel');
  assert.equal(queued.length, 1, 'the new hire must be queued, not lost to a failed fetch');
  assert.equal(queued[0].payload.full_name, 'Bagong Driver');
  assert.equal(queued[0].profile_key, 'josie');
  assert.equal(posted, false, 'and it never goes out as a direct api.post');
  assert.equal(savedCalled, true, 'the modal still closes cleanly — the operator is not blocked');

  r.unmount();
});

// ── PersonnelDetailPanel: rest-of-form saves offline; toggle + photo stay blocked ──

test('PersonnelDetailPanel: editing the phone/remarks offline queues via the outbox', async () => {
  api.get = async () => offline();
  api.request = async () => offline();

  const r = render(React.createElement(ToastProvider, null, React.createElement(PersonnelDetailPanel, {
    personnelId: PERSON.id, onClose() {}, onSaved() {}, cachedPerson: PERSON,
  })));
  await settle(20);

  const phoneInput = r.all('input[type="tel"]')[0];
  act(() => { changeInput(phoneInput, '09990001111'); });
  const saveBtn = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  assert.equal(saveBtn.disabled, false, 'Save is not gated offline any more');

  await act(async () => {
    saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 60));
  });

  const queued = (await listRecords()).filter((rec) => rec.entity_type === 'personnel_update');
  assert.equal(queued.length, 1, 'the edit must be queued, not lost to a failed fetch');
  assert.equal(queued[0].payload.phone, '09990001111');
  assert.equal(queued[0].payload.is_active, undefined, 'the blocked toggle never rides on a blind save');

  r.unmount();
});

test('PersonnelDetailPanel: the active toggle and photo upload stay disabled offline', async () => {
  api.get = async () => offline();
  api.request = async () => offline();

  const r = render(React.createElement(ToastProvider, null, React.createElement(PersonnelDetailPanel, {
    personnelId: PERSON.id, onClose() {}, onSaved() {}, cachedPerson: PERSON,
  })));
  await settle(20);

  const toggle = r.container.querySelector('#pers_active');
  assert.equal(toggle.disabled, true, 'rule 9.2 — deactivating needs a connection');
  assert.match(r.text(), /Deactivating or restoring personnel needs a connection/);

  const photoBtn = r.all('button').find((b) => /Upload Photo|Replace Photo/.test(b.textContent));
  assert.equal(photoBtn.disabled, true, 'rule 9.1 — the photo needs a connection');

  r.unmount();
});
