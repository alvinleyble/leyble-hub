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
    try {
      const result = await Printer.listPairedDevices();
      setPickerDevices(result.devices || []);
    } catch (e) {
      addToast('Could not list Bluetooth devices. Is Bluetooth on?', 'error');
      setPickerVisible(false);
      setPendingData(null);
    } finally {
      setPickerLoading(false);
    }
  }, [addToast]);

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

  const handlePrinterSelected = useCallback(async (device) => {
    setPickerVisible(false);
    try {
      await Printer.saveSelectedPrinter({ address: device.address, name: device.name });
    } catch (_) {}
    if (pendingData) await sendToPrinter(pendingData);
  }, [pendingData, sendToPrinter]);

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
    handlePrinterSelected,
    closePicker,
  };
}
