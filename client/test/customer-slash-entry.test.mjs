import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomerEntry } from '../src/utils/customerEntry.js';
import { customerMatches, orderCustomerMatches } from '../src/utils/customerSearch.js';

for (const [input, expected] of [
  ['juan/brgy dalig', { name: 'juan', address: 'brgy dalig' }],
  ['  juan / brgy dalig  ', { name: 'juan', address: 'brgy dalig' }],
  ['juan / eldo / tabi aling nena', { name: 'juan', address: 'eldo / tabi aling nena' }],
  [' juan ', { name: 'juan', address: null }],
  ['/juan', { name: 'juan', address: null }],
  ['juan/ ', { name: 'juan', address: null }],
  [' / juan / ', { name: 'juan', address: null }],
  ['/juan/brgy dalig', { name: 'juan/brgy dalig', address: null }],
  ['  /  ', { name: '', address: null }],
  ['', { name: '', address: null }],
  [null, { name: '', address: null }],
]) {
  test(`quick customer entry: ${JSON.stringify(input)}`, () => {
    assert.deepEqual(parseCustomerEntry(input), expected);
  });
}

const juan = { name: 'Juan Store', address: 'Brgy Dalig / tabi Aling Nena', phone: '0917-123-4567' };

test('order search matches name, delivery note, and the existing phone/punctuation search', () => {
  for (const query of ['juan', 'DALIG', 'tabi aling nena', 'juanstore', '09171234567']) {
    assert.equal(orderCustomerMatches(juan, query), true, query);
  }
  assert.equal(orderCustomerMatches(juan, 'missing'), false);
  assert.equal(orderCustomerMatches(juan, ''), false);
  assert.equal(orderCustomerMatches(juan, '  '), false);
  assert.equal(orderCustomerMatches({ name: 'Juan' }, 'dalig'), false);
});

test('slash search requires the name AND note on their respective sides', () => {
  for (const query of ['juan/dalig', ' JUAN / BRGY DALIG ', 'juan/dalig / tabi']) {
    assert.equal(orderCustomerMatches(juan, query), true, query);
  }
  for (const query of ['pedro/dalig', 'juan/missing', 'dalig/juan']) {
    assert.equal(orderCustomerMatches(juan, query), false, query);
  }
  assert.equal(orderCustomerMatches({ name: 'Juan Store' }, 'juan/dalig'), false);
  assert.equal(orderCustomerMatches(juan, '/dalig'), true);
  assert.equal(orderCustomerMatches(juan, 'juan/'), true);
});

test('directory and merge matching retain their existing literal slash and empty query behaviour', () => {
  assert.equal(customerMatches(juan, ''), true);
  assert.equal(customerMatches(juan, 'juan/dalig'), false);
  const legacy = { name: 'juan/brgy dalig', address: null };
  const before = { ...legacy };
  assert.equal(customerMatches(legacy, 'juan/brgy dalig'), true);
  orderCustomerMatches(legacy, 'juan/brgy dalig');
  assert.deepEqual(legacy, before, 'search never cleans up existing names');
});
