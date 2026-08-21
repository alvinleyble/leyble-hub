import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';

const FIELD = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const DEFAULT = {
  name: '', customer_type: 'regular', phone: '', address: '', notes: '',
};

export default function CustomerFormModal({ onClose, onSaved }) {
  const { addToast } = useToast();
  const [form, setForm]     = useState(DEFAULT);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.name.trim()) errs.name = 'Customer name is required.';
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    try {
      await api.post('/customers', {
        name:          form.name.trim(),
        customer_type: form.customer_type,
        phone:         form.phone.trim() || null,
        address:       form.address.trim() || null,
        notes:         form.notes.trim() || null,
      });
      addToast(`${form.name} added.`, 'success');
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to create customer.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      role="dialog" aria-modal="true" aria-labelledby="create-customer-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-400 shrink-0">
          <h2 id="create-customer-title" className="text-xl font-bold text-slate-900">Add Customer</h2>
          <button
            onClick={onClose} aria-label="Close"
            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormField label="Customer Name" required error={errors.name} className="sm:col-span-2">
            <input type="text" value={form.name} onChange={set('name')} autoFocus
              className={FIELD} placeholder="e.g. Mang Toto Store" />
          </FormField>

          <FormField label="Customer Type" required className="sm:col-span-2">
            <select value={form.customer_type} onChange={set('customer_type')} className={FIELD}>
              <option value="regular">Regular</option>
              <option value="discounted">Discounted</option>
              <option value="wholesaler">Wholesaler</option>
              <option value="markup">Markup</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </FormField>

          <FormField label="Phone" hint="Optional">
            <input type="tel" value={form.phone} onChange={set('phone')}
              className={FIELD} placeholder="09XX XXX XXXX" />
          </FormField>

          <FormField label="Address" hint="Optional">
            <input type="text" value={form.address} onChange={set('address')}
              className={FIELD} placeholder="Street / Barangay" />
          </FormField>

          <FormField label="Notes" hint="Optional" className="sm:col-span-2">
            <textarea value={form.notes} onChange={set('notes')} rows={3}
              className="w-full px-4 py-3 border border-slate-300 rounded-lg text-base text-slate-900
                         focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
              placeholder="Any notes about this customer…" />
          </FormField>
        </form>

        <div className="flex gap-3 justify-end px-6 py-4 border-t border-slate-400 shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>Save Customer</Button>
        </div>
      </div>
    </div>
  );
}
