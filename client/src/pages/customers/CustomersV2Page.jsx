import React from 'react';
import V2Placeholder from '../shared/V2Placeholder';

// Placeholder landing — the real V2 customers screen ships in Slice 3.
// The V1 CustomersPage stays untouched at /customers.
export default function CustomersV2Page() {
  return (
    <V2Placeholder
      title="Customers"
      slice="Slice 3"
      description="Directory filters, the slide-over profile drawer and the delivery vs pickup suki pricing matrix land here."
      v1Path="/customers"
    />
  );
}
