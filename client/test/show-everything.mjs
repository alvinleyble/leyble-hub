// Settings' "Show everything" switch for a single test. It is off by default, so a test
// that exercises a part the trimmed app hides (later order stages, the review queues,
// stock counts, Incoming / Personnel / Tickets / Audit Log) turns it on for itself here;
// it goes back off when that test ends.
import { setShowEverything, __resetShowEverythingForTest } from '../src/config/showEverything.js';

export async function showEverythingFor(t) {
  await setShowEverything(true);
  t.after(() => __resetShowEverythingForTest());
}
