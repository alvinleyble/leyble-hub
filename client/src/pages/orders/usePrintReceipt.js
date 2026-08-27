import { useCallback, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import { generateReceiptHtml, printPhaseForStatus } from './receiptTemplate';
import { generateEscPos } from './escposReceipt';
import { V25_OFFLINE_CORE } from '../../config/features.js';
import { queueReceiptPrinted } from '../../offline/index.js';

const Printer = registerPlugin('Printer');

// Helper to determine if an argument is a valid order object vs an event object
const isOrderObject = (val) => Boolean(val && typeof val === 'object' && (val.id || val.receipt_number) && (val.status || val.items));

// Shared print flow for OrderDetailPage, ReviewQueueModal and the V2 POS.
// On native Android: direct Bluetooth ESC/POS (no dialog, no PrintHand).
// On web: window.print() via a popup.
// `onTagged(updatedOrder)` fires after the order is tagged as printed.
// `liveAdjustment` is the receipt override bag (adjustment / adjustment_reason)
// handed to the receipt renderers.
// `options`:
//   copies  — print this many copies with no "print twice?" gate (V2 POS: 2)
//   autoTag — tag the order as printed straight after a successful print instead of
//             asking first (V2 POS's zero-prompt flow; the NOT PRINTED badge in
//             History is what surfaces a print that never happened).
export function usePrintReceipt(order, returnCounts, onTagged, liveAdjustment, options = {}) {
  const { copies: forcedCopies = null, autoTag = false } = options;
  const { addToast } = useToast();

  const [printing,      setPrinting]      = useState(false);
  const [printPrompt,   setPrintPrompt]   = useState(null);
  const [taggingPrint,  setTaggingPrint]  = useState(false);
  // Pending orders only: "Print twice for your copy?" gate shown before the
  // actual print fires (see handlePrint / confirmTwice below).
  const [twicePrompt,   setTwicePrompt]   = useState(false);

  // Printer picker state
  const [pickerVisible,  setPickerVisible]  = useState(false);
  const [pickerDevices,  setPickerDevices]  = useState([]);
  const [pickerLoading,  setPickerLoading]  = useState(false);
  const [pickerCurrent,  setPickerCurrent]  = useState(null); // currently-saved printer (pre-fill)
  // ESC/POS bytes + phase queued while the user picks a printer
  const [pendingPrint,   setPendingPrint]   = useState(null); // {data: base64, phase, copies, order} | null

  // ── After a successful print: tag the order, or ask first ───────────────────

  const tagPrinted = useCallback(async (orderId, phase, targetOrder = null) => {
    try {
      if (V25_OFFLINE_CORE) {
        const active = targetOrder || (isOrderObject(orderId) ? orderId : order);
        // queueReceiptPrinted's own return carries the flipped
        // pending_receipt_printed_at / delivered_receipt_printed_at — `active` itself
        // is never mutated (review round 1, item 3), so pass the returned record on.
        const updated = await queueReceiptPrinted({ order: active || { id: orderId }, phase });
        onTagged?.(updated || active || { id: orderId });
      } else {
        const id = isOrderObject(orderId) ? orderId.id : orderId;
        const updated = await api.post(`/orders/${id}/receipt-printed`, { phase });
        onTagged?.(updated);
      }
    } catch (err) {
      addToast(err.message || 'Failed to tag order as printed.', 'error');
    }
  }, [onTagged, addToast, order]);

  const finishPrint = useCallback((phase, targetOrder = order) => {
    const active = isOrderObject(targetOrder) ? targetOrder : order;
    if (!phase || !active) return;
    if (autoTag) tagPrinted(active.id || active.receipt_number, phase, active);
    else setPrintPrompt({ orderId: active.id || active.receipt_number, phase, order: active });
  }, [order, autoTag, tagPrinted]);

  // ── Core Bluetooth send ─────────────────────────────────────────────────────

  const sendToPrinter = useCallback(async (data, phase, copies = 1, targetOrder = order) => {
    setPrinting(true);
    try {
      for (let i = 0; i < copies; i++) await Printer.printBytes({ data });
      addToast(copies > 1 ? 'Printed successfully (2 copies).' : 'Printed successfully.', 'success');
      finishPrint(phase, targetOrder);
    } catch (e) {
      addToast(`Print failed: ${e.message || 'unknown error'}`, 'error');
    } finally {
      setPrinting(false);
      setPendingPrint(null);
    }
  }, [order, addToast, finishPrint]);

  // ── Open paired-device picker ───────────────────────────────────────────────

  const openPicker = useCallback(async (pendingData) => {
    setPendingPrint(pendingData); // null = change-only (no print after selection)
    setPickerLoading(true);
    setPickerVisible(true);
    // Pre-fill from the currently-saved printer (for the Wi-Fi manual fields / initial tab).
    try { setPickerCurrent(await Printer.getSelectedPrinter()); } catch (_) { setPickerCurrent(null); }
    // Bluetooth list — don't abort the picker if it fails (Wi-Fi tab must still work with BT off).
    try {
      const result = await Printer.listPairedDevices();
      setPickerDevices(result.devices || []);
    } catch (e) {
      setPickerDevices([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  // ── executePrint (the actual print job, 1 or 2 copies) ──────────────────────

  // Web: print `copies` popups back-to-back — the next copy opens once the
  // previous one's print dialog closes (afterprint, or the window itself closing).
  const printWeb = useCallback((copies, phase, targetOrder = order) => {
    const activeOrder = isOrderObject(targetOrder) ? targetOrder : order;
    if (!activeOrder) return;
    const html = generateReceiptHtml(activeOrder, returnCounts, liveAdjustment || {});
    let remaining = copies;
    const printOne = () => {
      const win = window.open('', '_blank', 'width=360,height=700');
      if (!win) {
        addToast('Allow pop-ups to print receipt.', 'error');
        return;
      }
      win.document.write(html);
      win.document.close();
      win.focus();
      win.print();
      let settled = false;
      let poller;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(poller);
        win.removeEventListener('afterprint', finish);
        remaining -= 1;
        if (remaining > 0) printOne();
        else finishPrint(phase, activeOrder);
      };
      win.addEventListener('afterprint', finish);
      poller = setInterval(() => { if (win.closed) finish(); }, 400);
    };
    printOne();
  }, [order, returnCounts, liveAdjustment, finishPrint, addToast]);

  const executePrint = useCallback(async (copies, explicitOrder = null) => {
    const activeOrder = isOrderObject(explicitOrder) ? explicitOrder : order;
    if (!activeOrder || printing) return;
    const phase = printPhaseForStatus(activeOrder.status);

    if (!Capacitor.isNativePlatform()) {
      printWeb(copies, phase, activeOrder);
      return;
    }

    // Native: generate ESC/POS bytes
    const escposBytes = generateEscPos(activeOrder, returnCounts, liveAdjustment || {});
    let bin = '';
    for (let i = 0; i < escposBytes.length; i++) bin += String.fromCharCode(escposBytes[i]);
    const data = btoa(bin);

    // Check if a printer is already saved
    let savedPrinter = null;
    try { savedPrinter = await Printer.getSelectedPrinter(); } catch (_) {}

    if (savedPrinter?.address) {
      await sendToPrinter(data, phase, copies, activeOrder);
    } else {
      await openPicker({ data, phase, copies, order: activeOrder });
    }
  }, [order, returnCounts, liveAdjustment, printing, sendToPrinter, openPicker, printWeb]);

  // ── handlePrint (called by Print Receipt button) ────────────────────────────
  // Pending orders get a "Print twice for your copy?" gate first; every other
  // status prints once immediately, same as before.

  const handlePrint = useCallback((explicitOrder = null, copiesOverride = null) => {
    const activeOrder = isOrderObject(explicitOrder) ? explicitOrder : order;
    if (!activeOrder || printing) return;
    const copies = typeof copiesOverride === 'number' ? copiesOverride : forcedCopies;
    if (copies) {
      executePrint(copies, activeOrder);   // V2 POS: fixed copy count, no gate
    } else if (activeOrder.status === 'pending') {
      setTwicePrompt(true);
    } else {
      executePrint(1, activeOrder);
    }
  }, [order, printing, executePrint, forcedCopies]);

  const confirmTwice = useCallback((yes) => {
    setTwicePrompt(false);
    executePrint(yes ? 2 : 1, order);
  }, [executePrint, order]);

  // ── Picker callbacks ────────────────────────────────────────────────────────

  // Unified save for both transports: {type, address, port?, name}
  const savePrinter = useCallback(async ({ type, address, port = 9100, name }) => {
    setPickerVisible(false);
    try {
      await Printer.saveSelectedPrinter({ type, address, port, name });
    } catch (_) {}
    if (pendingPrint) {
      await sendToPrinter(pendingPrint.data, pendingPrint.phase, pendingPrint.copies, pendingPrint.order);
    } else {
      addToast(`Printer set to ${name}.`, 'success');
    }
  }, [pendingPrint, sendToPrinter, addToast]);

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
    const slip = [0x1b, 0x40] // ESC @ (init)
      .concat(Array.from(new TextEncoder().encode('Leyble Hub test print\n\n\n')))
      .concat([0x1d, 0x56, 0x00]); // GS V 0 (full cut)
    let bin = '';
    for (let i = 0; i < slip.length; i++) bin += String.fromCharCode(slip[i]);
    try {
      await Printer.printBytesTo({ type, address, port, data: btoa(bin) });
      addToast('Test slip sent.', 'success');
    } catch (e) {
      addToast(`Test print failed: ${e.message || 'unknown error'}`, 'error');
    }
  }, [addToast]);

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
    await tagPrinted(printPrompt.orderId, printPrompt.phase, printPrompt.order);
    setTaggingPrint(false);
    setPrintPrompt(null);
  }, [printPrompt, tagPrinted]);

  const cancelPrintTag = useCallback(() => setPrintPrompt(null), []);

  return {
    // Print trigger
    handlePrint,
    executePrint,
    printing,
    // Printer picker
    pickerVisible,
    pickerDevices,
    pickerLoading,
    pickerCurrent,
    printPending: !!pendingPrint,
    savePrinter,
    scanWifi,
    testPrint,
    closePickerAndCancel,
    handleChangePrinter,
    // Print-twice gate (pending orders only)
    twicePrompt,
    confirmTwice,
    // Tag-as-printed
    printPrompt,
    taggingPrint,
    confirmPrintTag,
    cancelPrintTag,
  };
}
