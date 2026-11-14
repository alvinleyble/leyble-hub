// The order picker's single-box shorthand: name / delivery note. The note is
// stored in the existing address field; later slashes belong to the note.
export function parseCustomerEntry(value) {
  const text = String(value ?? '').trim();
  const slash = text.indexOf('/');
  if (slash !== -1) {
    const name = text.slice(0, slash).trim();
    const address = text.slice(slash + 1).trim();
    if (name && address) return { name, address };
  }
  return { name: text.replace(/^\/+|\/+$/g, '').trim(), address: null };
}
