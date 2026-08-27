import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { registerPlugin } from '@capacitor/core';
import { useToast } from '../components/ui/Toast';
import PrinterPicker from '../pages/orders/PrinterPicker';

const Printer = registerPlugin('Printer');

const PrinterContext = createContext(null);

export function PrinterProvider({ children }) {
  const { addToast } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [savedPrinter, setSavedPrinter] = useState(null);
  const [pendingPrint, setPendingPrint] = useState(null);

  // Load saved printer on mount
  const refreshSavedPrinter = useCallback(async () => {
    try {
      const p = await Printer.getSelectedPrinter();
      const current = p?.address ? p : null;
      setSavedPrinter(current);
      return current;
    } catch (_) {
      setSavedPrinter(null);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshSavedPrinter();
  }, [refreshSavedPrinter]);

  const openPicker = useCallback(async (onPrintAfterSave = null) => {
    setPendingPrint(() => (typeof onPrintAfterSave === 'function' ? onPrintAfterSave : null));
    setLoading(true);
    setPickerOpen(true);

    try {
      const current = await Printer.getSelectedPrinter();
      setSavedPrinter(current?.address ? current : null);
    } catch (_) {
      setSavedPrinter(null);
    }

    try {
      const result = await Printer.listPairedDevices();
      setDevices(result?.devices || []);
    } catch (_) {
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPendingPrint(null);
  }, []);

  const savePrinter = useCallback(async ({ type, address, port = 9100, name }) => {
    setPickerOpen(false);
    const printerObj = { type, address, port: Number(port) || 9100, name };
    try {
      await Printer.saveSelectedPrinter(printerObj);
      setSavedPrinter(printerObj);
    } catch (_) {}

    if (typeof pendingPrint === 'function') {
      try {
        await pendingPrint(printerObj);
      } catch (err) {
        addToast(`Print failed: ${err.message || 'unknown error'}`, 'error');
      }
    } else {
      addToast(`Printer set to ${name}.`, 'success');
    }
    setPendingPrint(null);
  }, [pendingPrint, addToast]);

  const scanWifi = useCallback(async () => {
    try {
      const result = await Printer.discoverWifiPrinters();
      return result?.devices || [];
    } catch (e) {
      addToast(e.message || 'Wi-Fi scan failed.', 'error');
      return [];
    }
  }, [addToast]);

  const testPrint = useCallback(async ({ type = 'wifi', address, port = 9100 }) => {
    const slip = [0x1b, 0x40] // ESC @ (init)
      .concat(Array.from(new TextEncoder().encode('Leyble Hub test print\n\n\n')))
      .concat([0x1d, 0x56, 0x00]); // GS V 0 (full cut)
    let bin = '';
    for (let i = 0; i < slip.length; i++) bin += String.fromCharCode(slip[i]);
    try {
      await Printer.printBytesTo({ type, address, port: Number(port) || 9100, data: btoa(bin) });
      addToast('Test slip sent.', 'success');
    } catch (e) {
      addToast(`Test print failed: ${e.message || 'unknown error'}`, 'error');
    }
  }, [addToast]);

  return (
    <PrinterContext.Provider
      value={{
        savedPrinter,
        refreshSavedPrinter,
        pickerOpen,
        openPicker,
        closePicker,
        savePrinter,
        scanWifi,
        testPrint,
        devices,
        loading,
      }}
    >
      {children}
      {pickerOpen && (
        <PrinterPicker
          devices={devices}
          loading={loading}
          current={savedPrinter}
          printPending={!!pendingPrint}
          onSave={savePrinter}
          onScanWifi={scanWifi}
          onTestPrint={testPrint}
          onClose={closePicker}
        />
      )}
    </PrinterContext.Provider>
  );
}

export function usePrinter() {
  const ctx = useContext(PrinterContext);
  if (!ctx) {
    throw new Error('usePrinter must be used within a PrinterProvider');
  }
  return ctx;
}
