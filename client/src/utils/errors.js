/**
 * Centralized connection error formatter for Leyble-Hub.
 * Maps network timeouts, total offline status, server gateway errors,
 * and thermal printer disconnects to clear, actionable messages.
 */
export function formatConnectionError(err, fallback = 'Operation failed.') {
  // 1. Thermal Printer Disconnection
  const isPrinter = Boolean(
    err?.isPrinterError ||
    (typeof err?.message === 'string' && (
      err.message.includes('socket') ||
      err.message.includes('Bluetooth') ||
      err.message.toLowerCase().includes('bluetooth') ||
      err.message.toLowerCase().includes('socket')
    ))
  );
  if (isPrinter) {
    return 'Thermal printer disconnected. Please check that the printer is powered on and Bluetooth is enabled on this tablet.';
  }

  // 2. 5-Second Timeout / Lie-Fi
  if (err?.timedOut || err?.name === 'AbortError') {
    return 'Connection timed out (5s). The server or internet took too long to respond. Tap Retry to try again.';
  }

  // 3. Server Gateway / Restart
  if (err?.status === 502 || err?.status === 503 || err?.status === 504) {
    return 'Server is temporarily restarting or updating. Please try again in a few moments.';
  }

  // 4. Total Offline / Network Failure
  const isOffline = Boolean(
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    (typeof err?.message === 'string' && err.message.includes('Failed to fetch')) ||
    (err && !err.status)
  );
  if (isOffline) {
    return 'No internet connection. Operating in offline mode — your changes are safely stored on this tablet.';
  }

  return fallback;
}
