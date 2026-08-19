import React from 'react';
import V2Placeholder from '../shared/V2Placeholder';

// Placeholder landing — the real V2 inventory screen ships in Slice 2.
// The V1 InventoryPage stays untouched at /inventory.
export default function InventoryV2Page() {
  return (
    <V2Placeholder
      title="Inventory"
      slice="Slice 2"
      description="Batch price edit (the priority), in-line price edits, w/ dep flags, product detail & audit drawer and the physical count sheet land here."
      v1Path="/inventory"
    />
  );
}
