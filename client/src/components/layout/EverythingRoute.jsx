import React from 'react';
import { Navigate } from 'react-router-dom';
import { useShowEverything } from '../../config/showEverything';

// Wraps a screen the trimmed app hides (Incoming, Personnel, Tickets, Audit Log). With
// Settings' "Show everything" off, no link reaches it, and a typed or remembered route
// lands on Outgoing instead. Until the switch's stored value has been read it renders
// nothing, so someone who has it on is never bounced away on the way in.
export default function EverythingRoute({ children }) {
  const { showEverything, ready } = useShowEverything();
  if (!ready) return null;
  if (!showEverything) return <Navigate to="/orders" replace />;
  return children;
}
