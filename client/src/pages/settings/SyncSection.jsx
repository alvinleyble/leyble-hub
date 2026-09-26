import React, { useEffect, useState } from 'react';
import { listWaitingItems } from '../../offline/waitingItems';
import { getLastSynced, subscribeLastSynced } from '../../offline/lastSynced';
import { subscribeOutbox } from '../../offline/outbox';
import SettingsSection, { SettingRow } from './SettingsSection';

const timeOf = (d) => d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// "Today, 3:42 PM" / "Yesterday, 9:05 AM" / "Sep 25, 3:42 PM" — or "Never".
export function formatSyncedAt(at, now = new Date()) {
  if (!at) return 'Never';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'Never';
  if (sameDay(d, now)) return `Today, ${timeOf(d)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday, ${timeOf(d)}`;
  const date = d.toLocaleDateString('en-PH', {
    month: 'short', day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${timeOf(d)}`;
}

// Sync, view-only (captain decision #4): when this device last reached the server, and
// what is still waiting to send. No button — sync runs by itself and pull-to-refresh
// already forces it — and no "clear offline data".
export default function SyncSection() {
  const [lastSynced, setLastSynced] = useState(undefined);
  const [items, setItems] = useState(null);

  useEffect(() => {
    let alive = true;
    const loadItems = () => {
      listWaitingItems()
        .then((list) => { if (alive) setItems(list); })
        .catch(() => { if (alive) setItems([]); });
    };
    getLastSynced().then((at) => { if (alive) setLastSynced(at); });
    loadItems();
    const offOutbox = subscribeOutbox(loadItems);
    const offSynced = subscribeLastSynced((at) => { if (alive) setLastSynced(at); });
    return () => { alive = false; offOutbox(); offSynced(); };
  }, []);

  return (
    <SettingsSection id="sync" title="Sync">
      <dl>
        <SettingRow label="Last synced" testId="settings-sync-last">
          {lastSynced === undefined ? '…' : formatSyncedAt(lastSynced)}
        </SettingRow>
      </dl>
      <p className="mt-1 text-base text-slate-600">
        This device syncs by itself whenever it is online. Pull down on any screen to sync now.
      </p>

      <h3 className="mt-5 text-base font-semibold text-slate-900">
        Waiting to send
        {items && items.length > 0 && (
          <span className="ml-2 font-normal text-slate-600" data-testid="settings-sync-count">
            ({items.length})
          </span>
        )}
      </h3>
      {items === null ? (
        <p className="mt-2 text-base text-slate-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-base text-slate-700" data-testid="settings-sync-empty">
          Nothing waiting. Everything on this device has been sent.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200" data-testid="settings-sync-list">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid="settings-sync-item"
            >
              <div className="min-w-0">
                <p className="text-base font-semibold text-slate-900">{item.kind}</p>
                {item.label && <p className="text-base text-slate-700 break-words">{item.label}</p>}
              </div>
              <span
                className={`inline-flex w-fit shrink-0 items-center rounded-full border px-3 py-1 text-sm font-semibold ${
                  item.needsAttention
                    ? 'border-red-300 bg-red-100 text-red-800'
                    : 'border-amber-300 bg-amber-100 text-amber-800'
                }`}
              >
                {item.needsAttention ? 'Needs attention' : 'Waiting'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
