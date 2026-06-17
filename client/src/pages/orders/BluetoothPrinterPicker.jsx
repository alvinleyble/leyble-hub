import React from 'react';
import Spinner from '../../components/ui/Spinner';

export default function BluetoothPrinterPicker({ devices, loading, onSelect, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl">

        <div className="p-5 border-b border-slate-200">
          <h2 className="text-lg font-bold text-slate-900">Select Bluetooth Printer</h2>
          <p className="text-sm text-slate-500 mt-1 leading-snug">
            Turn on the VOZY G80 and make sure it is paired in Android Bluetooth settings first.
          </p>
        </div>

        <div className="p-3 max-h-64 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-10">
              <Spinner size="lg" />
            </div>
          ) : devices.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-10 px-4">
              No paired Bluetooth devices found.{'\n'}
              Pair the VOZY G80 in Android Settings → Bluetooth first, then try again.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {devices.map((d) => (
                <li key={d.address}>
                  <button
                    onClick={() => onSelect(d)}
                    className="w-full text-left px-4 py-3.5 rounded-xl border border-slate-200
                               hover:bg-blue-50 hover:border-blue-300 active:bg-blue-100
                               transition-colors focus-visible:outline-none
                               focus-visible:ring-2 focus-visible:ring-blue-600"
                  >
                    <p className="font-semibold text-slate-900 text-base">{d.name}</p>
                    <p className="text-xs text-slate-400 mt-0.5 font-mono">{d.address}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="p-4 border-t border-slate-200">
          <button
            onClick={onClose}
            className="w-full h-12 rounded-xl bg-slate-100 text-slate-700 font-semibold text-base
                       hover:bg-slate-200 active:bg-slate-300 transition-colors
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            Cancel
          </button>
        </div>

      </div>
    </div>
  );
}
