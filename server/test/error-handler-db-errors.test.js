// Database-free: the error handler is a pure function of (err, NODE_ENV).
// Production incident 2026-10-23: a duplicate product SKU (23505) and a customer id of
// "[object Object]" (22P02) were answered 500, which the offline outbox reads as "server
// unwell" — it stopped every device's drain on that one record and retried it forever.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { errorHandler, classifyDbError } = require('../src/middleware/errorHandler');

function pgError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function run(err) {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  errorHandler(err, {}, res, () => {});
  return res;
}

describe('errorHandler maps Postgres bad-data errors to 4xx', () => {
  let originalEnv;
  let originalConsoleError;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    originalConsoleError = console.error;
    console.error = () => {};
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    console.error = originalConsoleError;
  });

  it('answers a unique violation (duplicate SKU) with 409 duplicate', () => {
    const res = run(pgError('23505', 'duplicate key value violates unique constraint "products_sku_key"'));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'duplicate');
  });

  it('answers invalid text for an integer id ("[object Object]") with 400 invalid_input', () => {
    const res = run(pgError('22P02', 'invalid input syntax for type integer: "[object Object]"'));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'invalid_input');
  });

  it('answers other integrity violations, e.g. a missing foreign key, with 400', () => {
    assert.equal(run(pgError('23503', 'violates foreign key constraint')).statusCode, 400);
  });

  it('keeps transient database errors (serialization failure, deadlock) as 500', () => {
    assert.equal(run(pgError('40001', 'could not serialize access')).statusCode, 500);
    assert.equal(run(pgError('40P01', 'deadlock detected')).statusCode, 500);
  });

  it('never answers with stale_write, which the app treats specially', () => {
    assert.notEqual(run(pgError('23505', 'dup')).body.code, 'stale_write');
  });

  it('hides raw Postgres messages in production', () => {
    const res = run(pgError('23505', 'duplicate key value violates unique constraint "products_sku_key"'));
    assert.doesNotMatch(res.body.error, /products_sku_key/);
  });

  it('shows the raw message outside production', () => {
    process.env.NODE_ENV = 'development';
    const res = run(pgError('23505', 'duplicate key value violates unique constraint "products_sku_key"'));
    assert.match(res.body.error, /products_sku_key/);
  });

  it('leaves an explicit route status untouched', () => {
    const err = pgError('23505', 'dup');
    err.status = 422;
    assert.equal(run(err).statusCode, 422);
  });

  it('keeps unclassified errors as a plain 500', () => {
    const res = run(new Error('boom'));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal server error' });
  });

  it('ignores app-level string codes that are not SQLSTATEs', () => {
    assert.equal(classifyDbError({ code: 'session_superseded' }), null);
    assert.equal(classifyDbError({ code: 'ECONNREFUSED' }), null);
    assert.equal(classifyDbError({}), null);
  });
});
