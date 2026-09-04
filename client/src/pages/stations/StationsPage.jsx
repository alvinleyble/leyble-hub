import React, { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import {
  getStation, assignStationSlot, getStationSlots, getReceiptIdentity, receiptSeries,
} from '../../offline/station.js';
import { formatReceiptNumber } from '../../offline/receiptNumbers.js';

// ADR 0017 — receipt numbers no longer come from anything on this screen.
//
// A receipt number is `<person><device letter>-<sequence>`: the person is the signed-in
// account and the letter is allocated to this device for that person on their first
// online sign-in here. A replacement device signs in and takes a fresh letter, so there
// is nothing left to assign and no admin action to take. The block this screen now leads
// with says which numbers THIS device is actually printing for whoever is signed in.
//
// Everything below that block is the ADR 0016 slot scheme, kept only while tablets are
// still being updated one at a time (ADR 0014): an un-updated tablet is still numbering
// from a slot, and this is the only place a slot can be moved onto a replacement for it.
// Both it and this screen go once every tablet is on the letter build.
//
// ADR 0016 — the Devices screen.
//
// This store runs exactly three tablets, one per person, so receipt numbers come off
// three fixed slots: 1 is Alvin's, 2 is Josie's, 3 is Luis's, permanently. Which
// physical tablet currently holds each slot is the only thing that ever changes, and
// this screen is the one place it changes — when a tablet is replaced, its slot is
// moved onto the new one so that person's numbering carries on instead of a fourth
// number space appearing on a customer's receipt.
//
// Back-office V1 UI (light), same page chrome as Personnel. Nothing here is offline-
// capable on purpose: assigning a slot is a decision about which device the SERVER
// treats as authoritative, so it is meaningless without the server.

function shortKey(key) {
  return key ? `${String(key).slice(0, 8)}…` : '—';
}

function stamp(value) {
  if (!value) return null;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// The confirmation. Reassignment is not undoable from a customer's point of view — the
// receipts are already printed — so the two facts that decide whether it is safe are
// stated before the button, not after: the old tablet stops issuing, and anything it
// has not synced yet needs to go up first.
function AssignConfirmModal({ slot, target, onCancel, onConfirm, busy }) {
  const replacing = Boolean(slot?.device);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl" role="dialog" aria-modal="true" aria-labelledby="assign-slot-title" data-testid="devices-assign-modal">
        <div className="border-b border-slate-200 px-6 py-5">
          <h2 id="assign-slot-title" className="text-xl font-bold text-slate-900">
            Give Slot {slot.slot_number} ({slot.owner_name}) to this {target.self ? 'tablet' : 'device'}?
          </h2>
        </div>

        <div className="space-y-4 px-6 py-5 text-base text-slate-700">
          <p>
            Receipts from {target.self ? 'this tablet' : `device ${shortKey(target.device_key)}`} will
            be numbered <strong className="tabular-nums">{formatReceiptNumber(slot.slot_number, slot.next_sequence)}</strong> onwards,
            continuing {slot.owner_name}&rsquo;s numbering.
          </p>

          {replacing && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
              <p className="font-semibold text-amber-900">The tablet holding this slot now will stop issuing receipts.</p>
              <p className="mt-1 text-amber-900">
                Before you continue, make sure that tablet shows no orders waiting to sync. Orders
                it has saved but not sent yet still carry their own numbers, and they can only
                reach the system from that tablet.
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-slate-200 px-6 py-4 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm} loading={busy}>
            {replacing ? 'Move the slot' : 'Assign the slot'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function StationsPage() {
  const { addToast } = useToast();

  const [slots, setSlots]           = useState([]);
  const [unassigned, setUnassigned] = useState([]);
  const [thisDevice, setThisDevice] = useState(null);
  const [loading, setLoading]       = useState(true);
  const [pending, setPending]       = useState(null);   // { slot, target }
  const [busy, setBusy]             = useState(false);
  const [pickFor, setPickFor]       = useState(null);   // device_key awaiting a slot choice
  const [identity, setIdentity]     = useState(null);   // ADR 0017 { person, letter, ... }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [roster, local, mine] = await Promise.all([
        getStationSlots(), getStation(), getReceiptIdentity(),
      ]);
      setSlots(roster.slots || []);
      setUnassigned(roster.unassigned || []);
      setThisDevice(local || null);
      setIdentity(mine);
    } catch {
      // The letter is held locally, so it is still worth showing when the roster below
      // it cannot be read at all.
      setIdentity(await getReceiptIdentity().catch(() => null));
      addToast('Could not read the device list — this screen needs a connection.', 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  const confirmAssign = async () => {
    setBusy(true);
    try {
      const { slot, target } = pending;
      await assignStationSlot(slot.slot_number, target.self ? {} : { deviceKey: target.device_key });
      addToast(`Slot ${slot.slot_number} (${slot.owner_name}) assigned.`, 'success');
      setPending(null);
      setPickFor(null);
      await load();
    } catch (err) {
      addToast(err.message || 'Could not assign that slot.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const myKey = thisDevice?.device_key || null;
  const mySlot = slots.find((s) => s.device?.device_key && s.device.device_key === myKey) || null;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Devices</h1>
        <p className="mt-1 text-base text-slate-600">
          Receipt numbers are set up by signing in — there is nothing to assign here.
          Each person has their own number, and each of their devices gets its own letter
          after it. The slots further down are the old scheme, kept only until every
          tablet has been updated.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <>
          {/* ── ADR 0017: what this device prints for whoever is signed in ── */}
          <section className="mb-8 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-bold text-slate-900">Your receipt numbers on this device</h2>
            {identity ? (
              <>
                <p className="mt-2 text-2xl font-bold tabular-nums text-slate-900">
                  {receiptSeries(identity)}
                </p>
                <p className="mt-1 text-base text-slate-600">
                  Every receipt {identity.seller_name ? `${identity.seller_name} writes` : 'you write'}{' '}
                  on this device starts with this, counting up from{' '}
                  <strong className="tabular-nums">
                    {formatReceiptNumber(identity.person, 1, identity.letter)}
                  </strong>. Another person signing in on this same device gets their own
                  number and their own letter — the two never mix.
                </p>
              </>
            ) : (
              <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-base text-amber-900">
                This device has not been set up for your account yet. Connect to the
                internet once while signed in and it will set itself up — there is nothing
                to press.
              </p>
            )}
          </section>

          {/* ── This tablet ─────────────────────────────────────────────── */}
          <section className="mb-8 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-bold text-slate-900">This tablet</h2>
            <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-slate-500">Device ID</dt>
                <dd className="text-base text-slate-900 tabular-nums">{shortKey(myKey)}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-slate-500">Slot</dt>
                <dd className="text-base font-semibold text-slate-900">
                  {mySlot
                    ? `Slot ${mySlot.slot_number} — ${mySlot.owner_name}`
                    : 'Not assigned — this tablet cannot issue receipt numbers yet'}
                </dd>
              </div>
            </dl>
            {!mySlot && (
              <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-base text-amber-900">
                Pick the slot below that belongs to whoever uses this tablet, then choose
                &ldquo;Use this tablet&rdquo;.
              </p>
            )}
          </section>

          {/* ── The three slots ─────────────────────────────────────────── */}
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-bold text-slate-900">Receipt number slots</h2>
            <ul className="space-y-3" data-testid="devices-slots-list">
              {slots.map((slot) => {
                const isMine = slot.device?.device_key && slot.device.device_key === myKey;
                return (
                  <li key={slot.slot_number} data-testid="devices-slot-item" className="rounded-xl border border-slate-200 bg-white p-5">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-lg font-bold text-slate-900">
                          Slot {slot.slot_number} — {slot.owner_name}
                        </p>
                        <p className="mt-1 text-base text-slate-700">
                          {slot.device
                            ? <>Held by device <span className="tabular-nums">{shortKey(slot.device.device_key)}</span>{isMine && <span className="ml-2 rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-sm font-semibold text-blue-800">this tablet</span>}</>
                            : <span className="text-slate-500">No tablet assigned</span>}
                        </p>
                        <p className="mt-1 text-sm text-slate-500 tabular-nums">
                          Next receipt: {formatReceiptNumber(slot.slot_number, slot.next_sequence)}
                          {slot.last_sequence > 0 && ` · last issued ${formatReceiptNumber(slot.slot_number, slot.last_sequence)}`}
                        </p>
                        {slot.device?.slot_assigned_at && (
                          <p className="mt-1 text-sm text-slate-500">
                            Assigned {stamp(slot.device.slot_assigned_at)}
                            {slot.device.slot_assigned_by ? ` by ${slot.device.slot_assigned_by}` : ''}
                          </p>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                        {!isMine && (
                          <Button
                            variant={slot.device ? 'secondary' : 'primary'}
                            onClick={() => setPending({ slot, target: { self: true, device_key: myKey } })}
                            disabled={!myKey}
                            data-testid="devices-slot-assign-button"
                          >
                            Use this tablet
                          </Button>
                        )}
                        {pickFor && !isMine && (
                          <Button
                            variant="secondary"
                            onClick={() => setPending({ slot, target: { self: false, device_key: pickFor } })}
                          >
                            Give to {shortKey(pickFor)}
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ── Registered devices with no slot ─────────────────────────── */}
          <section>
            <h2 className="mb-1 text-lg font-bold text-slate-900">Devices without a slot</h2>
            <p className="mb-3 text-base text-slate-600">
              These have signed in but cannot issue receipt numbers. A replacement tablet appears
              here after its first sign-in — pick it, then choose which slot it takes.
            </p>
            {unassigned.length === 0 ? (
              <p className="rounded-xl border border-slate-200 bg-white px-5 py-4 text-base text-slate-500">
                None. Every registered device holds a slot.
              </p>
            ) : (
              <ul className="space-y-2">
                {unassigned.map((d) => (
                  <li
                    key={d.device_key}
                    className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-base font-semibold text-slate-900 tabular-nums">
                        {shortKey(d.device_key)}
                        {d.device_key === myKey && <span className="ml-2 rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-sm font-semibold text-blue-800">this tablet</span>}
                      </p>
                      <p className="text-sm text-slate-500">
                        {d.label ? `${d.label} · ` : ''}Last seen {stamp(d.last_seen_at) || stamp(d.registered_at) || 'never'}
                      </p>
                    </div>
                    <Button
                      variant={pickFor === d.device_key ? 'primary' : 'secondary'}
                      onClick={() => setPickFor(pickFor === d.device_key ? null : d.device_key)}
                    >
                      {pickFor === d.device_key ? 'Picked — choose a slot above' : 'Assign to a slot'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {pending && (
        <AssignConfirmModal
          slot={pending.slot}
          target={pending.target}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={confirmAssign}
        />
      )}
    </div>
  );
}
