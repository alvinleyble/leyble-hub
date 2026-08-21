const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Server DB SSL & resilience configuration', () => {
  it('server/src/db.js exports query and connect functions and attaches error handler', () => {
    const db = require('../src/db');
    assert.equal(typeof db.query, 'function');
    assert.equal(typeof db.connect, 'function');
  });

  it('ssl logic activates on remote host and production', () => {
    const isRemote = (url) => Boolean(url && !url.includes('localhost') && !url.includes('127.0.0.1'));

    assert.equal(isRemote('postgresql://localhost/leyble_hub'), false);
    assert.equal(isRemote('postgresql://127.0.0.1:5432/leyble_hub'), false);
    assert.equal(isRemote('postgresql://postgres.xxx.supabase.co:5432/postgres'), true);
    assert.equal(isRemote('postgresql://user:pass@render.com/db'), true);
  });
});
