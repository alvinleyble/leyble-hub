import React, { useState } from 'react';
import { registerPlugin } from '@capacitor/core';
import Spinner from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';

const Printer = registerPlugin('Printer');

// Two-tab printer picker: Bluetooth (paired devices) | Wi-Fi (scan + manual IP).
// Props:
//   devices       - paired Bluetooth devices [{name, address}]
//   loading       - Bluetooth list loading
//   current       - currently-saved printer {type, address, port, name} | null (for pre-fill)
//   printPending  - true if a receipt prints right after the printer is saved
//   onSave({type, address, port, name}) - save (and print if pending)
//   onScanWifi()  - async → returns [{address}] of hosts listening on the print port
//   onTestPrint({type, address, port}) - async → fires a tiny slip to verify a target
//   onClose       - dismiss without saving
export default function PrinterPicker({
  devices,
  loading,
  current,
  printPending,
  onSave,
  onScanWifi,
  onTestPrint,
  onClose,
}) {
  const { addToast } = useToast();
  const [tab, setTab] = useState(current?.type === 'wifi' ? 'wifi' : 'bluetooth');

  // Wi-Fi tab state
  const [scanning,   setScanning]   = useState(false);
  const [scanned,    setScanned]    = useState([]);   // [{address}]
  const [scanDone,   setScanDone]   = useState(false);
  const [wifiIp,     setWifiIp]     = useState(current?.type === 'wifi' ? current.address : '');
  const [wifiPort,   setWifiPort]   = useState(current?.type === 'wifi' ? String(current.port || 9100) : '9100');
  const [wifiName,   setWifiName]   = useState(current?.type === 'wifi' ? current.name : 'VOZY G80 (Wi-Fi)');
  const [testing,    setTesting]    = useState(false);
  const [fixing,     setFixing]     = useState(false);

  const inputClass =
    'w-full h-12 px-3 rounded-xl border border-slate-300 text-base text-slate-900 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600';
  const labelClass = 'block text-sm font-semibold text-slate-700 mb-1';

  const tabClass = (active) =>
    'flex-1 h-12 text-base font-semibold transition-colors focus-visible:outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-blue-600 ' +
    (active
      ? 'text-blue-700 border-b-2 border-blue-600'
      : 'text-slate-500 border-b-2 border-transparent hover:text-slate-700');

  const handleScan = async () => {
    setScanning(true);
    setScanDone(false);
    setScanned([]);
    try {
      const list = await onScanWifi();
      setScanned(list || []);
    } catch (_) {
      setScanned([]);
    } finally {
      setScanning(false);
      setScanDone(true);
    }
  };

  const handleTest = async () => {
    if (!wifiIp.trim()) return;
    setTesting(true);
    try {
      await onTestPrint({ type: 'wifi', address: wifiIp.trim(), port: Number(wifiPort) || 9100 });
    } finally {
      setTesting(false);
    }
  };

  // One-time fix: tell the printer's WiFi module to stop printing "+EVENT=SOCKA_ON/OFF"
  // connection notices on every print (AT+EVENT=off over the module's UDP config channel).
  const handleDisableNotices = async () => {
    if (!wifiIp.trim()) return;
    setFixing(true);
    try {
      const res = await Printer.disableWifiEventNotice({ address: wifiIp.trim() });
      addToast(res?.message || (res?.ok ? 'Done.' : 'Could not reach the printer.'),
        res?.ok ? 'success' : 'error');
    } catch (e) {
      addToast(`Fix failed: ${e.message || 'unknown error'}`, 'error');
    } finally {
      setFixing(false);
    }
  };

  const handleSaveWifi = () => {
    if (!wifiIp.trim()) return;
    onSave({
      type: 'wifi',
      address: wifiIp.trim(),
      port: Number(wifiPort) || 9100,
      name: wifiName.trim() || 'Wi-Fi printer',
    });
  };

  const saveLabel = printPending ? 'Save & Print' : 'Save';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl flex flex-col max-h-[90vh]">

        <div className="p-5 pb-0">
          <h2 className="text-lg font-bold text-slate-900">Select printer</h2>
        </div>

        {/* Tabs */}
        <div className="flex px-5 mt-3 border-b border-slate-400">
          <button onClick={() => setTab('bluetooth')} className={tabClass(tab === 'bluetooth')}>
            Bluetooth
          </button>
          <button onClick={() => setTab('wifi')} className={tabClass(tab === 'wifi')}>
            Wi-Fi
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          {tab === 'bluetooth' ? (
            <>
              <p className="text-sm text-slate-500 mb-3 leading-snug">
                Turn on the VOZY G80 and make sure it is paired in Android Bluetooth settings first.
              </p>
              {loading ? (
                <div className="flex justify-center py-10"><Spinner size="lg" /></div>
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
                        onClick={() => onSave({ type: 'bluetooth', address: d.address, name: d.name })}
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
            </>
          ) : (
            <>
              {/* Scan */}
              <button
                onClick={handleScan}
                disabled={scanning}
                className="w-full h-12 rounded-xl bg-blue-600 text-white font-semibold text-base
                           hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-60
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
                           flex items-center justify-center gap-2"
              >
                {scanning ? (<><Spinner size="sm" className="text-white" /> Scanning…</>) : 'Scan network'}
              </button>

              {scanned.length > 0 && (
                <ul className="space-y-1.5 mt-3">
                  {scanned.map((d) => (
                    <li key={d.address}>
                      <button
                        onClick={() => setWifiIp(d.address)}
                        className="w-full text-left px-4 py-3 rounded-xl border border-slate-200
                                   hover:bg-blue-50 hover:border-blue-300 active:bg-blue-100
                                   transition-colors focus-visible:outline-none
                                   focus-visible:ring-2 focus-visible:ring-blue-600 font-mono text-base
                                   text-slate-900"
                      >
                        {d.address}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {scanDone && scanned.length === 0 && (
                <p className="text-sm text-slate-500 text-center py-4 px-2 leading-snug">
                  No printers found on the network. Enter the printer's IP manually below
                  (see its self-test page or the router).
                </p>
              )}

              {/* Manual entry */}
              <div className="mt-4 space-y-3">
                <div>
                  <label className={labelClass} htmlFor="wifi-ip">IP address</label>
                  <input
                    id="wifi-ip"
                    className={inputClass}
                    inputMode="decimal"
                    placeholder="192.168.1.39"
                    value={wifiIp}
                    onChange={(e) => setWifiIp(e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="wifi-port">Port</label>
                  <input
                    id="wifi-port"
                    className={inputClass}
                    inputMode="numeric"
                    placeholder="9100"
                    value={wifiPort}
                    onChange={(e) => setWifiPort(e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="wifi-name">Name</label>
                  <input
                    id="wifi-name"
                    className={inputClass}
                    value={wifiName}
                    onChange={(e) => setWifiName(e.target.value)}
                  />
                </div>

                <button
                  onClick={handleTest}
                  disabled={testing || !wifiIp.trim()}
                  className="w-full h-12 rounded-xl bg-slate-100 text-slate-700 font-semibold text-base
                             hover:bg-slate-200 active:bg-slate-300 transition-colors disabled:opacity-60
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400
                             flex items-center justify-center gap-2"
                >
                  {testing ? (<><Spinner size="sm" /> Testing…</>) : 'Test print'}
                </button>
                <button
                  onClick={handleSaveWifi}
                  disabled={!wifiIp.trim()}
                  className="w-full h-12 rounded-xl bg-blue-600 text-white font-semibold text-base
                             hover:bg-blue-700 active:bg-blue-800 transition-colors disabled:opacity-60
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                >
                  {saveLabel}
                </button>
              </div>

              {/* One-time maintenance: stop the printer printing "+EVENT" connection notices */}
              <div className="mt-4 pt-4 border-t border-slate-400">
                <p className="text-sm font-semibold text-slate-700">
                  Printer prints “+EVENT” lines?
                </p>
                <p className="text-xs text-slate-500 mt-0.5 mb-2 leading-snug">
                  One-time fix — tells the printer to stop printing connection notices, then
                  reboots it (~15s). Needs the printer’s IP filled in above.
                </p>
                <button
                  onClick={handleDisableNotices}
                  disabled={fixing || !wifiIp.trim()}
                  className="w-full h-12 rounded-xl bg-slate-100 text-slate-700 font-semibold text-base
                             hover:bg-slate-200 active:bg-slate-300 transition-colors disabled:opacity-60
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400
                             flex items-center justify-center gap-2"
                >
                  {fixing ? (<><Spinner size="sm" /> Fixing…</>) : 'Disable notices & reboot printer'}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t border-slate-400">
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
