import React from 'react';
import { useProfile } from '../../context/ProfileContext';

const COLORS = ['bg-blue-600', 'bg-emerald-600', 'bg-amber-600'];

// Netflix-style "who's using this" picker — mandatory (no dismiss), shown once per cold
// start (ProfileContext only sets needsPick when nothing is persisted) or on demand via
// the "Switch profile" trigger in Sidebar.
export default function ProfilePickerModal() {
  const { profiles, chooseProfile } = useProfile();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      role="dialog" aria-modal="true" aria-labelledby="profile-picker-title"
      data-testid="profile-picker"
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-8">
        <h2 id="profile-picker-title" className="text-xl font-bold text-slate-900 text-center mb-8">
          Who's using this?
        </h2>
        <div className="flex items-center justify-center gap-6">
          {profiles.map((p, i) => (
            <button
              key={p.profile_key}
              type="button"
              onClick={() => chooseProfile(p.profile_key)}
              data-testid={`profile-picker-${p.profile_key}`}
              className="flex flex-col items-center gap-2 group focus-visible:outline-none"
            >
              <span
                className={`w-16 h-16 rounded-full ${COLORS[i % COLORS.length]} text-white
                            flex items-center justify-center text-2xl font-bold
                            group-hover:opacity-80 group-focus-visible:ring-4 group-focus-visible:ring-blue-300
                            transition-opacity`}
                aria-hidden="true"
              >
                {p.full_name.charAt(0).toUpperCase()}
              </span>
              <span className="text-base font-medium text-slate-700">{p.full_name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
