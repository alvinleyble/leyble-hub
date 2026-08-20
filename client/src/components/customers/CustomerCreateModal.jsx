import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';

const FIELD = `w-full h-12 rounded-lg border border-v2-border bg-v2-bg px-4 text-base text-v2-text
               placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

const LABEL = 'block text-sm font-bold uppercase tracking-wide text-v2-muted mb-1';

const DEFAULT_FORM = {
  name: '',
  customer_type: 'regular',
  phone: '',
  address: '',
  notes: '',
};

// V2 dark-themed Add Customer modal for tablet POS overhaul.
export default function CustomerCreateModal({ onClose, onSaved }) {
  const { addToast } = useToast();
  const [form, setForm]     = useState(DEFAULT_FORM);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const validate = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Customer name is required.';
    return errs;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    try {
      const created = await api.post('/customers', {
        name:          form.name.trim(),
        customer_type: form.customer_type,
        phone:         form.phone.trim() || null,
        address:       form.address.trim() || null,
        notes:         form.notes.trim() || null,
      });
      addToast(`${created.name} added.`, 'success');
      onSaved(created);
    } catch (err) {
      addToast(err.message || 'Failed to create customer.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      role="dialog" aria-modal="true" aria-labelledby="create-customer-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="my-8 flex w-full max-w-lg flex-col rounded-2xl border border-v2-border bg-v2-surface shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-v2-border px-6 py-5">
          <h2 id="create-customer-title" className="text-xl font-bold text-v2-text">Add Customer</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-12 w-12 items-center justify-center rounded-lg text-2xl text-v2-muted
                       hover:bg-v2-raised hover:text-v2-text
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 gap-5 px-6 py-5 sm:grid-cols-2">

            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="cc-name">Customer Name *</label>
              <input
                id="cc-name"
                type="text"
                value={form.name}
                onChange={set('name')}
                autoFocus
                className={FIELD}
                placeholder="e.g. Mang Toto Store"
              />
              {errors.name && <p role="alert" className="mt-1 text-sm font-semibold text-red-300">{errors.name}</p>}
            </div>

            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="cc-type">Customer Type *</label>
              <select
                id="cc-type"
                value={form.customer_type}
                onChange={set('customer_type')}
                className={FIELD}
              >
                <option value="regular">Regular Customer — Without Custom Prices</option>
                <option value="wholesaler">Wholesalers — With Custom Prices</option>
              </select>
            </div>

            <div>
              <label className={LABEL} htmlFor="cc-phone">Phone</label>
              <input
                id="cc-phone"
                type="tel"
                value={form.phone}
                onChange={set('phone')}
                className={FIELD}
                placeholder="09XX XXX XXXX"
              />
            </div>

            <div>
              <label className={LABEL} htmlFor="cc-address">Address</label>
              <input
                id="cc-address"
                type="text"
                value={form.address}
                onChange={set('address')}
                className={FIELD}
                placeholder="Street / Barangay"
              />
            </div>

            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="cc-notes">Notes</label>
              <textarea
                id="cc-notes"
                value={form.notes}
                onChange={set('notes')}
                rows={3}
                className="w-full rounded-lg border border-v2-border bg-v2-bg px-4 py-3 text-base text-v2-text
                           placeholder:text-slate-500 focus:outline-none focus-visible:ring-2
                           focus-visible:ring-v2-accent resize-none"
                placeholder="Any notes about this customer…"
              />
            </div>

          </div>
        </form>

        <div className="flex shrink-0 justify-end gap-3 border-t border-v2-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-raised px-5 text-base
                       font-bold text-v2-text hover:bg-v2-border disabled:opacity-50
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="flex min-h-tablet items-center justify-center rounded-xl bg-v2-accent-strong px-5 text-base
                       font-bold text-white hover:bg-sky-500 disabled:opacity-50
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            {saving ? 'Saving…' : 'Save Customer'}
          </button>
        </div>
      </div>
    </div>
  );
}
