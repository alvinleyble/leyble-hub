import React, { useState } from 'react';
import { api } from '../../api/client';
import { useToast } from './Toast';
import Button from './Button';

// Two-step inline "Danger Zone" delete used in entity detail panels.
// Calls DELETE on `endpoint`; the backend does a "smart delete" returning
// { outcome: 'deleted' | 'deactivated' }. `entityLabel` is a lowercase noun
// (e.g. 'customer') used in the confirmation copy and toasts. `onDeleted`
// fires after success so the caller can refresh its list and close the panel.
export default function DangerZoneDelete({ endpoint, entityLabel, onDeleted }) {
  const { addToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await api.del(endpoint);
      if (result?.outcome === 'deactivated') {
        addToast(
          `This ${entityLabel} has history and can't be permanently deleted, so it was hidden (deactivated) instead.`,
          'success'
        );
      } else {
        addToast(`${entityLabel[0].toUpperCase()}${entityLabel.slice(1)} permanently deleted.`, 'success');
      }
      onDeleted();
    } catch (err) {
      addToast(err.message || `Failed to delete ${entityLabel}.`, 'error');
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="px-6 py-5 border-t border-slate-200">
      <p className="text-xs font-bold text-red-400 uppercase tracking-widest mb-3">Danger Zone</p>

      {!confirming ? (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Delete {entityLabel}
        </Button>
      ) : (
        <div className="p-4 bg-red-50 rounded-lg border border-red-200">
          <p className="text-base font-semibold text-red-900 mb-1">
            Delete this {entityLabel}?
          </p>
          <p className="text-sm text-red-800 mb-4">
            This can't be undone. If it has order or stock history it will be hidden
            (deactivated) instead of permanently removed.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={deleting} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleting} onClick={handleDelete}>
              Yes, delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
