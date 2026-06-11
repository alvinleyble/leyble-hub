import { useCallback, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import { generateReceiptHtml, printPhaseForStatus } from './receiptTemplate';

// Native Android print bridge (implemented in android/.../PrinterPlugin.java).
// On web this proxy is unused — the Print button that calls it only renders
// inside the native-only receipt overlay.
const Printer = registerPlugin('Printer');

// Shared print → wait-for-return → confirm-tag flow for OrderDetailPage and
// ReviewQueueModal. `onTagged(updatedOrder)` is called after the user confirms
// the "tag as printed" prompt and the server records it.
export function usePrintReceipt(order, returnCounts, onTagged, liveAdjustment) {
  const { addToast } = useToast();
  const [nativePrintDoc, setNativePrintDoc] = useState(null);
  const [printPrompt, setPrintPrompt] = useState(null);
  const [taggingPrint, setTaggingPrint] = useState(false);

  const handlePrint = useCallback(() => {
    if (!order) return;
    const htmlString = generateReceiptHtml(order, returnCounts, liveAdjustment);
    const phase = printPhaseForStatus(order.status);

    if (Capacitor.isNativePlatform()) {
      setNativePrintDoc(htmlString);
      return;
    }

    const win = window.open('', '_blank', 'width=360,height=700');
    win.document.write(htmlString);
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
  }, [order, returnCounts, liveAdjustment]);

  // Android WebView ignores window.print(), so hand the receipt HTML to the
  // native PrinterPlugin which drives Android's system PrintManager.
  const handleNativePrint = useCallback(async () => {
    if (!nativePrintDoc || !order) return;
    const phase = printPhaseForStatus(order.status);
    const orderId = order.id;
    try {
      await Printer.printHtml({ html: nativePrintDoc });
    } catch (e) {
      addToast('Printing is not available on this device.', 'error');
    } finally {
      setNativePrintDoc(null);
      if (phase) setPrintPrompt({ orderId, phase });
    }
  }, [nativePrintDoc, order, addToast]);

  const closeNativePreview = useCallback(() => setNativePrintDoc(null), []);

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
    handlePrint,
    nativePrintDoc,
    handleNativePrint,
    closeNativePreview,
    printPrompt,
    taggingPrint,
    confirmPrintTag,
    cancelPrintTag,
  };
}
