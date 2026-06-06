import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';

const FIELD = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const DEFAULT = { full_name: '', remarks: '', phone: '', license_number: '' };

export default function PersonnelFormModal({ onClose, onSaved }) {
  const { addToast } = useToast();
  const [form, setForm]     = useState(DEFAULT);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.full_name.trim()) errs.full_name = 'Full name is required.';
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    try {
      await api.post('/personnel', {
        full_name:      form.full_name.trim(),
        remarks:        form.remarks.trim() || null,
        phone:          form.phone.trim() || null,
        license_number: form.license_number.trim() || null,
      });
      addToast(`${form.full_name} added.`, 'success');
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to create personnel.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      role="dialog" aria-modal="true" aria-labelledby="create-personnel-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 shrink-0">
          <h2 id="create-personnel-title" className="text-xl font-bold text-slate-900">Add Personnel</h2>
          <button
            onClick={onClose} aria-label="Close"
            className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormField label="Full Name" required error={errors.full_name} className="sm:col-span-2">
            <input type="text" value={form.full_name} onChange={set('full_name')} autoFocus
              className={FIELD} placeholder="e.g. Juan dela Cruz" />
          </FormField>

          <FormField label="Remarks" hint="Optional — e.g. available on weekends only">
            <input type="text" value={form.remarks} onChange={set('remarks')}
              className={FIELD} placeholder="Optional remarks…" />
          </FormField>

          <FormField label="Phone" hint="Optional">
            <input type="tel" value={form.phone} onChange={set('phone')}
              className={FIELD} placeholder="09XX XXX XXXX" />
          </FormField>

          <FormField label="License / ID Number" hint="Optional" className="sm:col-span-2">
            <input type="text" value={form.license_number} onChange={set('license_number')}
              className={FIELD} placeholder="e.g. N01-23-456789" />
          </FormField>
        </form>

        <div className="flex gap-3 justify-end px-6 py-4 border-t border-slate-200 shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>Save</Button>
        </div>
      </div>
    </div>
  );
}
