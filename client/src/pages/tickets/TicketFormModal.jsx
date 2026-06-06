import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';

const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

export default function TicketFormModal({ onClose, onSaved }) {
  const { addToast } = useToast();

  const [personnel, setPersonnel] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);

  const [title, setTitle]                     = useState('');
  const [description, setDescription]         = useState('');
  const [amount, setAmount]                   = useState('');
  const [relatedOrderId, setRelatedOrderId]   = useState('');
  const [relatedPersonnelId, setRelatedPersonnelId] = useState('');
  const [errors, setErrors]                   = useState({});

  useEffect(() => {
    api.get('/personnel')
      .then((p) => setPersonnel(p.filter((x) => x.is_active)))
      .catch(() => addToast('Failed to load personnel.', 'error'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const validate = () => {
    const e = {};
    if (!title.trim()) e.title = 'Title is required.';
    if (!description.trim()) e.description = 'Description is required.';
    if (relatedOrderId && isNaN(Number(relatedOrderId))) e.relatedOrderId = 'Must be a valid order number.';
    return e;
  };

  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    try {
      await api.post('/tickets', {
        title:                title.trim(),
        description:          description.trim(),
        amount:               amount !== '' ? Number(amount) : undefined,
        related_order_id:     relatedOrderId ? Number(relatedOrderId) : undefined,
        related_personnel_id: relatedPersonnelId ? Number(relatedPersonnelId) : undefined,
      });
      addToast('Ticket created.', 'success');
      onSaved();
    } catch (err) {
      addToast(err.message || 'Failed to create ticket.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50"
      role="dialog" aria-modal="true" aria-labelledby="ticket-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white w-full sm:rounded-xl sm:max-w-lg h-[95vh] sm:h-auto sm:max-h-[95vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 shrink-0">
          <h2 id="ticket-modal-title" className="text-xl font-bold text-slate-900">New Ticket</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

              <FormField label="Title" error={errors.title} required>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={INPUT}
                  placeholder="e.g. Short delivery on Order #42"
                  autoFocus
                />
              </FormField>

              <FormField label="Description" error={errors.description} required>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg text-base text-slate-900
                             focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
                  placeholder="Describe the discrepancy or issue…"
                />
              </FormField>

              <FormField
                label="Amount (₱)"
                hint="Optional — use negative for shortfalls (e.g. −500), positive for advances"
              >
                <input
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={INPUT}
                  placeholder="e.g. -500 or 200"
                />
              </FormField>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  label="Related Order #"
                  hint="Optional"
                  error={errors.relatedOrderId}
                >
                  <input
                    type="number"
                    min="1" step="1"
                    value={relatedOrderId}
                    onChange={(e) => setRelatedOrderId(e.target.value)}
                    className={INPUT}
                    placeholder="Order ID"
                  />
                </FormField>

                <FormField label="Related Personnel" hint="Optional">
                  <select
                    value={relatedPersonnelId}
                    onChange={(e) => setRelatedPersonnelId(e.target.value)}
                    className={INPUT}
                  >
                    <option value="">— None —</option>
                    {personnel.map((p) => (
                      <option key={p.id} value={p.id}>{p.full_name}</option>
                    ))}
                  </select>
                </FormField>
              </div>

            </div>

            {/* Footer */}
            <div className="flex gap-3 justify-end px-6 py-4 border-t border-slate-200 shrink-0 bg-white">
              <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button onClick={handleSubmit} loading={saving}>Create Ticket</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
