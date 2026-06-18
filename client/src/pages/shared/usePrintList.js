import { useCallback, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { useToast } from '../../components/ui/Toast';

const Printer = registerPlugin('Printer');

// Lean print flow for the Product/Customer lists.
// Web: window.print() via a popup. Native Android: direct Bluetooth ESC/POS,
// reusing the same saved-printer + paired-device picker as receipt printing.
// (No "tag as printed" flow — that's receipt-only.)
export function usePrintList() {
  const { addToast } = useToast();

  const [printing,      setPrinting]      = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerDevices, setPickerDevices] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerCurrent, setPickerCurrent] = useState(null); // currently-saved printer (pre-fill)
  const [pendingData,   setPendingData]   = useState(null); // base64 ESC/POS awaiting a printer pick

  const sendToPrinter = useCallback(async (data) => {
    setPrinting(true);
    try {
      await Printer.printBytes({ data });
      addToast('Printed successfully.', 'success');
    } catch (e) {
      addToast(`Print failed: ${e.message || 'unknown error'}`, 'error');
    } finally {
      setPrinting(false);
      setPendingData(null);
    }
  }, [addToast]);

  const openPicker = useCallback(async (data) => {
    setPendingData(data);
    setPickerLoading(true);
    setPickerVisible(true);
    try { setPickerCurrent(await Printer.getSelectedPrinter()); } catch (_) { setPickerCurrent(null); }
    // Don't abort the picker if the Bluetooth list fails — the Wi-Fi tab must still work.
    try {
      const result = await Printer.listPairedDevices();
      setPickerDevices(result.devices || []);
    } catch (e) {
      setPickerDevices([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  // html: string for web; escPosBytes: Uint8Array for native.
  const printList = useCallback(async (html, escPosBytes) => {
    if (printing) return;

    if (!Capacitor.isNativePlatform()) {
      const win = window.open('', '_blank', 'width=360,height=700');
      if (!win) { addToast('Allow pop-ups to print.', 'error'); return; }
      win.document.write(html);
      win.document.close();
      win.focus();
      win.print();
      return;
    }

    let bin = '';
    for (let i = 0; i < escPosBytes.length; i++) bin += String.fromCharCode(escPosBytes[i]);
    const data = btoa(bin);

    let savedPrinter = null;
    try { savedPrinter = await Printer.getSelectedPrinter(); } catch (_) {}

    if (savedPrinter?.address) await sendToPrinter(data);
    else await openPicker(data);
  }, [printing, addToast, sendToPrinter, openPicker]);

  // Unified save for both transports: {type, address, port?, name}
  const savePrinter = useCallback(async ({ type, address, port = 9100, name }) => {
    setPickerVisible(false);
    try {
      await Printer.saveSelectedPrinter({ type, address, port, name });
    } catch (_) {}
    if (pendingData) await sendToPrinter(pendingData);
    else addToast(`Printer set to ${name}.`, 'success');
  }, [pendingData, sendToPrinter, addToast]);

  // Wi-Fi: parallel TCP sweep of the local subnet on port 9100.
  const scanWifi = useCallback(async () => {
    try {
      const result = await Printer.discoverWifiPrinters();
      return result.devices || [];
    } catch (e) {
      addToast(e.message || 'Wi-Fi scan failed.', 'error');
      return [];
    }
  }, [addToast]);

  // Fire a tiny slip to an explicit target so the user can verify before committing.
  const testPrint = useCallback(async ({ type, address, port = 9100 }) => {
    const slip = [0x1b, 0x40]
      .concat(Array.from(new TextEncoder().encode('Leyble Hub test print\n\n\n')))
      .concat([0x1d, 0x56, 0x00]);
    let bin = '';
    for (let i = 0; i < slip.length; i++) bin += String.fromCharCode(slip[i]);
    try {
      await Printer.printBytesTo({ type, address, port, data: btoa(bin) });
      addToast('Test slip sent.', 'success');
    } catch (e) {
      addToast(`Test print failed: ${e.message || 'unknown error'}`, 'error');
    }
  }, [addToast]);

  const closePicker = useCallback(() => {
    setPickerVisible(false);
    setPendingData(null);
  }, []);

  return {
    printList,
    printing,
    pickerVisible,
    pickerDevices,
    pickerLoading,
    pickerCurrent,
    printPending: !!pendingData,
    savePrinter,
    scanWifi,
    testPrint,
    closePicker,
  };
}
