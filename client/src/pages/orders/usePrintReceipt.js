import { useCallback, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import { generateReceiptHtml, printPhaseForStatus } from './receiptTemplate';
import { generateEscPos } from './escposReceipt';

const Printer = registerPlugin('Printer');

// Shared print flow for OrderDetailPage and ReviewQueueModal.
// On native Android: direct Bluetooth ESC/POS (no dialog, no PrintHand).
// On web: window.print() via a popup.
// `onTagged(updatedOrder)` fires after the user confirms the "tag as printed" prompt.
export function usePrintReceipt(order, returnCounts, onTagged, liveAdjustment) {
  const { addToast } = useToast();

  const [printing,      setPrinting]      = useState(false);
  const [printPrompt,   setPrintPrompt]   = useState(null);
  const [taggingPrint,  setTaggingPrint]  = useState(false);

  // Bluetooth printer picker state
  const [pickerVisible,  setPickerVisible]  = useState(false);
  const [pickerDevices,  setPickerDevices]  = useState([]);
  const [pickerLoading,  setPickerLoading]  = useState(false);
  // ESC/POS bytes + phase queued while the user picks a printer
  const [pendingPrint,   setPendingPrint]   = useState(null); // {data: base64, phase} | null

  // ── Core Bluetooth send ─────────────────────────────────────────────────────

  const sendToPrinter = useCallback(async (data, phase) => {
    setPrinting(true);
    try {
      await Printer.printBytes({ data });
      addToast('Printed successfully.', 'success');
      if (phase && order) setPrintPrompt({ orderId: order.id, phase });
    } catch (e) {
      addToast(`Print failed: ${e.message || 'unknown error'}`, 'error');
    } finally {
      setPrinting(false);
      setPendingPrint(null);
    }
  }, [order, addToast]);

  // ── Open paired-device picker ───────────────────────────────────────────────

  const openPicker = useCallback(async (pendingData) => {
    setPendingPrint(pendingData); // null = change-only (no print after selection)
    setPickerLoading(true);
    setPickerVisible(true);
    try {
      const result = await Printer.listPairedDevices();
      setPickerDevices(result.devices || []);
    } catch (e) {
      addToast('Could not list Bluetooth devices. Is Bluetooth on?', 'error');
      setPickerVisible(false);
      setPendingPrint(null);
    } finally {
      setPickerLoading(false);
    }
  }, [addToast]);

  // ── handlePrint (called by Print Receipt button) ────────────────────────────

  const handlePrint = useCallback(async () => {
    if (!order || printing) return;
    const phase = printPhaseForStatus(order.status);

    if (!Capacitor.isNativePlatform()) {
      // Web: open a popup and use window.print()
      const html = generateReceiptHtml(order, returnCounts, liveAdjustment || {});
      const win  = window.open('', '_blank', 'width=360,height=700');
      win.document.write(html);
      win.document.close();
      win.focus();
      win.print();
      if (phase) {
        let settled = false;
        let poller;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearInterval(poller);
          win.removeEventListener('afterprint', finish);
          setPrintPrompt({ orderId: order.id, phase });
        };
        win.addEventListener('afterprint', finish);
        poller = setInterval(() => { if (win.closed) finish(); }, 400);
      }
      return;
    }

    // Native: generate ESC/POS bytes
    const escposBytes = generateEscPos(order, returnCounts, liveAdjustment || {});
    let bin = '';
    for (let i = 0; i < escposBytes.length; i++) bin += String.fromCharCode(escposBytes[i]);
    const data = btoa(bin);

    // Check if a printer is already saved
    let savedPrinter = null;
    try { savedPrinter = await Printer.getSelectedPrinter(); } catch (_) {}

    if (savedPrinter?.address) {
      await sendToPrinter(data, phase);
    } else {
      await openPicker({ data, phase });
    }
  }, [order, returnCounts, liveAdjustment, printing, sendToPrinter, openPicker]);

  // ── Picker callbacks ────────────────────────────────────────────────────────

  const handlePrinterSelected = useCallback(async (device) => {
    setPickerVisible(false);
    try {
      await Printer.saveSelectedPrinter({ address: device.address, name: device.name });
    } catch (_) {}
    if (pendingPrint) {
      await sendToPrinter(pendingPrint.data, pendingPrint.phase);
    } else {
      addToast(`Printer set to ${device.name}.`, 'success');
    }
  }, [pendingPrint, sendToPrinter, addToast]);

  const closePickerAndCancel = useCallback(() => {
    setPickerVisible(false);
    setPendingPrint(null);
  }, []);

  // Opens picker in change-only mode (no print triggered after selection)
  const handleChangePrinter = useCallback(() => openPicker(null), [openPicker]);

  // ── Tag-as-printed flow ─────────────────────────────────────────────────────

  const confirmPrintTag = useCallback(async () => {
    if (!printPrompt) return;
    setTaggingPrint(true);
    try {
      const updated = await api.post(`/orders/${printPrompt.orderId}/receipt-printed`, { phase: printPrompt.phase });
      onTagged?.(updated);
    } catch (err) {
      addToast(err.message || 'Failed to tag order as printed.', 'error');
    } finally {
      setTaggingPrint(false);
      setPrintPrompt(null);
    }
  }, [printPrompt, onTagged, addToast]);

  const cancelPrintTag = useCallback(() => setPrintPrompt(null), []);

  return {
    // Print trigger
    handlePrint,
    printing,
    // Bluetooth picker
    pickerVisible,
    pickerDevices,
    pickerLoading,
    handlePrinterSelected,
    closePickerAndCancel,
    handleChangePrinter,
    // Tag-as-printed
    printPrompt,
    taggingPrint,
    confirmPrintTag,
    cancelPrintTag,
  };
}
