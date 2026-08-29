import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import FormField from '../../components/ui/FormField';
import Spinner from '../../components/ui/Spinner';
import DangerZoneDelete from '../../components/ui/DangerZoneDelete';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

const ORDER_STATUS = {
  pending:    { label: 'Pending',    color: 'bg-blue-100 text-blue-800 border-blue-300' },
  in_transit: { label: 'In Transit', color: 'bg-amber-100 text-amber-800 border-amber-300' },
  completed:  { label: 'Delivered',  color: 'bg-green-100 text-green-800 border-green-300' },
  done:       { label: 'Closed',     color: 'bg-slate-100 text-slate-600 border-slate-200' },
  cancelled:  { label: 'Cancelled',  color: 'bg-red-100 text-red-700 border-red-300' },
};

const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

export default function PersonnelDetailPanel({ personnelId, onClose, onSaved }) {
  const { addToast } = useToast();
  const fileInputRef = useRef(null);

  const [person, setPerson]           = useState(null);
  const [orderHistory, setOrderHistory] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [form, setForm]               = useState(null);
  const [formErrors, setFormErrors]   = useState({});
  const [saving, setSaving]           = useState(false);

  // Image upload state — separate from form so we only send if changed
  const [imageUpload, setImageUpload] = useState(null); // { b64, mime }
  const [imagePreview, setImagePreview] = useState(null); // data URL

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/personnel/${personnelId}`)
      .then((data) => {
        setPerson(data);
        setOrderHistory(data.order_history ?? []);
        setForm({
          full_name:      data.full_name,
          remarks:        data.remarks ?? '',
          phone:          data.phone ?? '',
          license_number: data.license_number ?? '',
          is_active:      data.is_active,
        });
        // Reset any pending upload when reloading
        setImageUpload(null);
        setImagePreview(null);
      })
      .catch(() => addToast('Failed to load personnel.', 'error'))
      .finally(() => setLoading(false));
  }, [personnelId, addToast]);

  useEffect(() => { load(); }, [load]);

  const set = (field) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: val }));
  };

  const handleImageChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_SIZE_BYTES) {
      addToast('Image must be under 2 MB.', 'error');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const b64 = dataUrl.split(',')[1];
      setImageUpload({ b64, mime: file.type });
      setImagePreview(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.full_name.trim()) errs.full_name = 'Required.';
    if (Object.keys(errs).length) { setFormErrors(errs); return; }

    const body = {
      full_name:      form.full_name.trim(),
      remarks:        form.remarks.trim() || null,
      phone:          form.phone.trim() || null,
      license_number: form.license_number.trim() || null,
      is_active:      form.is_active,
    };

    if (imageUpload) {
      body.id_image_base64    = imageUpload.b64;
      body.id_image_mime_type = imageUpload.mime;
    }

    setSaving(true);
    try {
      await api.patch(`/personnel/${personnelId}`, body);
      addToast('Personnel updated.', 'success');
      onSaved();
      load();
    } catch (err) {
      addToast(err.message || 'Failed to update.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const existingImageSrc = person?.id_image_base64
    ? `data:${person.id_image_mime_type || 'image/jpeg'};base64,${person.id_image_base64}`
    : null;

  const displayImageSrc = imagePreview ?? existingImageSrc;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} aria-hidden="true" />

      <div
        className="fixed top-0 right-0 z-50 h-full w-full max-w-xl bg-white shadow-2xl flex flex-col"
        role="dialog" aria-modal="true" aria-labelledby="personnel-detail-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-400 shrink-0">
          <h2 id="personnel-detail-title" className="text-xl font-bold text-slate-900 truncate pr-4">
            {loading ? 'Loading…' : person?.full_name}
          </h2>
          <button
            onClick={onClose} aria-label="Close panel"
            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>
        ) : (
          <div className="flex-1 overflow-y-auto">

            {/* ── Summary bar ───────────────────────────────────── */}
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-400 flex items-center gap-3 flex-wrap">
              {!person.is_active && (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold
                                  bg-red-100 text-red-700 border border-red-300">
                  Inactive
                </span>
              )}
              <span className="text-sm text-slate-400 ml-auto">
                {orderHistory.length} order{orderHistory.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* ── Edit form ─────────────────────────────────────── */}
            <form onSubmit={handleSave} noValidate>
              <div className="px-6 py-5 border-b border-slate-400">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

                  <FormField label="Full Name" required error={formErrors.full_name} className="sm:col-span-2">
                    <input type="text" value={form.full_name} onChange={set('full_name')} className={INPUT} />
                  </FormField>

                  <FormField label="Remarks" hint="Optional notes">
                    <input type="text" value={form.remarks} onChange={set('remarks')}
                      className={INPUT} placeholder="e.g. available on weekends only" />
                  </FormField>

                  <FormField label="Phone" hint="Optional">
                    <input type="tel" value={form.phone} onChange={set('phone')}
                      className={INPUT} placeholder="09XX XXX XXXX" />
                  </FormField>

                  <FormField label="License / ID Number" hint="Optional" className="sm:col-span-2">
                    <input type="text" value={form.license_number} onChange={set('license_number')} className={INPUT} />
                  </FormField>

                  <div className="sm:col-span-2 flex items-center gap-3 min-h-[48px]">
                    <input type="checkbox" id="pers_active" checked={form.is_active}
                      onChange={set('is_active')} className="w-6 h-6 accent-blue-700" />
                    <label htmlFor="pers_active" className="text-base font-medium text-slate-700 cursor-pointer">
                      Active (can be assigned to orders)
                    </label>
                  </div>
                </div>
              </div>

              {/* ── ID Photo ──────────────────────────────────────── */}
              <div className="px-6 py-5 border-b border-slate-400">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">ID Photo</p>

                {displayImageSrc ? (
                  <div className="mb-4">
                    <img
                      src={displayImageSrc}
                      alt="ID document"
                      className="w-full max-h-64 object-contain rounded-lg border border-slate-200 bg-slate-50"
                    />
                    {imageUpload && (
                      <p className="text-xs text-amber-700 mt-2 font-medium">
                        New image ready — will be saved when you click Save Changes.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400 mb-4">No ID photo uploaded yet.</p>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  className="hidden"
                  aria-label="Upload ID photo"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {displayImageSrc ? 'Replace Photo' : 'Upload Photo'}
                </Button>
                <p className="text-xs text-slate-400 mt-2">JPEG, PNG, or WebP — max 2 MB</p>
              </div>

              <div className="px-6 py-4 flex justify-end border-b border-slate-400">
                <Button type="submit" loading={saving}>Save Changes</Button>
              </div>
            </form>

            {/* ── Order History ─────────────────────────────────── */}
            <div className="px-6 py-5">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">
                Order History ({orderHistory.length})
              </p>
              {orderHistory.length === 0 ? (
                <p className="text-sm text-slate-400">No orders assigned yet.</p>
              ) : (
                <ol className="space-y-3">
                  {orderHistory.map((o) => {
                    const st = ORDER_STATUS[o.status] ?? {
                      label: o.status,
                      color: 'bg-slate-100 text-slate-600 border-slate-200',
                    };
                    return (
                      <li key={o.id}
                        className="flex items-start justify-between gap-4 p-3 rounded-lg border border-slate-200 bg-white">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${st.color}`}>
                              {st.label}
                            </span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border
                              ${o.role_on_order === 'Driver'
                                ? 'bg-purple-100 text-purple-800 border-purple-300'
                                : 'bg-teal-100 text-teal-800 border-teal-300'}`}>
                              {o.role_on_order}
                            </span>
                          </div>
                          <p className="text-sm font-medium text-slate-700 mt-1">{o.customer_name}</p>
                          <p className="text-xs text-slate-400">
                            {new Date(o.created_at).toLocaleDateString('en-PH', {
                              month: 'short', day: 'numeric', year: 'numeric',
                            })}
                          </p>
                        </div>
                        <p className="font-bold text-slate-900 tabular-nums text-base shrink-0">
                          {PHP(o.total_amount)}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            {/* ── Danger Zone ───────────────────────────────────── */}
            <DangerZoneDelete
              endpoint={`/personnel/${personnelId}`}
              entityLabel="personnel"
              onDeleted={() => { onSaved(); onClose(); }}
            />

          </div>
        )}
      </div>
    </>
  );
}
