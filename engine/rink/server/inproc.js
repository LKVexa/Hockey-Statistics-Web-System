'use strict';
/**
 * In-process RINK client for the desktop (LOCAL) profile and tests: the same { call, on } surface the worker gets
 * over the bridge, served by a RinkService in this process. Subscriptions filter live updates exactly like
 * gateway/rink-bridge.js does for remote sessions.
 */
function inProcessRink(service, principal) {
  const subs = new Set(); const listeners = new Set();
  // the same rule as the worker bridge: no control character reaches a terminal from league data
  const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
  const clone = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)), (k, v) => (typeof v === 'string' ? v.replace(CTRL, '') : v));
  service.on('update', (u) => {
    if (!subs.has(u.game)) return;
    const body = clone(service.updateFor(principal, u));
    for (const fn of listeners) { try { fn(body); } catch { /* a listener's failure is its own */ } }
  });
  return {
    async call(op, args = {}) {
      if (op === 'subscribe' || op === 'unsubscribe') {
        if (!service.caps(principal).query) throw Object.assign(new Error('live updates need rink.query'), { code: 'FORBIDDEN' });
        const key = typeof args.game === 'string' ? args.game : '';
        if (op === 'unsubscribe') { subs.delete(key); return { subscribed: [...subs] }; }
        if (!service.registry.game(key)) throw Object.assign(new Error(`no game ${key.slice(0, 24)}`), { code: 'NOT_FOUND' });
        if (subs.size >= 16 && !subs.has(key)) throw Object.assign(new Error('at most 16 subscriptions'), { code: 'LIMIT' });
        subs.add(key); return { subscribed: [...subs] };
      }
      return clone(await service.handle(principal, op, clone(args)));
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
module.exports = { inProcessRink };
