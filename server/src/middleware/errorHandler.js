// Postgres SQLSTATE classes 22 (data exception) and 23 (integrity constraint violation)
// mean the request's own data is bad: the identical request can never succeed, however
// often it is retried. Answer those as a 4xx, not a 500. The offline outbox
// (client/src/offline/outbox.js) reads any 5xx as "server unwell", stops the whole drain
// and retries the same head record forever, so one bad record jams every record queued
// behind it on that device. A 4xx parks just that record in Needs attention and lets the
// rest of the queue sync. Class 40 (serialization failure, deadlock) stays a 500 on
// purpose: it is transient, and a retry can succeed.
const PG_BAD_DATA = /^2[23][0-9A-Z]{3}$/;
const PG_UNIQUE_VIOLATION = '23505';

function classifyDbError(err) {
  if (typeof err?.code !== 'string' || !PG_BAD_DATA.test(err.code)) return null;
  if (err.code === PG_UNIQUE_VIOLATION) {
    return { status: 409, code: 'duplicate', message: 'This record already exists.' };
  }
  return { status: 400, code: 'invalid_input', message: 'The request contained invalid data.' };
}

function errorHandler(err, req, res, next) {
  console.error(err);
  const isProduction = process.env.NODE_ENV === 'production';

  // A route that already chose a status keeps it; only unclassified errors are mapped.
  const dbError = err.status ? null : classifyDbError(err);
  if (dbError) {
    // Raw Postgres messages name tables and constraints, so production gets the plain one.
    return res.status(dbError.status).json({
      error: isProduction ? dbError.message : err.message,
      code: dbError.code,
    });
  }

  const status = err.status || 500;
  const message =
    isProduction && status === 500
      ? 'Internal server error'
      : err.message;
  res.status(status).json({ error: message });
}

module.exports = { errorHandler, classifyDbError };
