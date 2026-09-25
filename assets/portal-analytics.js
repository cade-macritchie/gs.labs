(function () {
  'use strict';

  const PRODUCTION_HOST = 'cade-macritchie.github.io';
  const SITE_TOKEN = '41948a5bca5f4a97b32961ff03ce053f';
  const AGGREGATE_ENDPOINT = 'https://gs-labs-slate-gateway.gs-labs.workers.dev/api/analytics/event';
  const IDENTIFIER_PATTERN = /^[a-f0-9-]{20,64}$/i;
  const VISITOR_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

  if (window.location.hostname !== PRODUCTION_HOST || !SITE_TOKEN) return;

  function loadBeacon() {
    if (document.querySelector('script[data-enrollment-portal-analytics]')) return;
    const beacon = document.createElement('script');
    beacon.defer = true;
    beacon.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    beacon.referrerPolicy = 'no-referrer';
    beacon.setAttribute('data-enrollment-portal-analytics', '');
    beacon.setAttribute('data-cf-beacon', JSON.stringify({ token: SITE_TOKEN }));
    document.head.appendChild(beacon);
  }

  function sessionIdentifier() {
    try {
      const stored = sessionStorage.getItem('enrollment-analytics-session');
      if (IDENTIFIER_PATTERN.test(stored || '')) return stored;
    } catch (_) {}

    const generated = crypto.randomUUID();
    try { sessionStorage.setItem('enrollment-analytics-session', generated); } catch (_) {}
    return generated;
  }

  function visitorIdentifier(fallback) {
    const idKey = 'enrollment-analytics-visitor';
    const createdKey = 'enrollment-analytics-visitor-created';
    try {
      const stored = localStorage.getItem(idKey);
      const created = Number(localStorage.getItem(createdKey));
      const age = Date.now() - created;
      if (IDENTIFIER_PATTERN.test(stored || '') && created > 0 && age >= 0 && age < VISITOR_LIFETIME_MS) return stored;

      const generated = crypto.randomUUID();
      localStorage.setItem(idKey, generated);
      localStorage.setItem(createdKey, String(Date.now()));
      return generated;
    } catch (_) {
      return fallback;
    }
  }

  // Each recorded visit is one KV write on the Worker, and the Cloudflare
  // account is on Workers Free (1,000 writes/day shared by the whole Worker).
  // So a browser records a given page at most once per local calendar day;
  // a reload records again, as a deliberate "count this one". Browsers don't
  // expose hard vs. soft reload, so any reload counts.
  function alreadyRecordedToday(path) {
    const key = 'enrollment-analytics-recorded';
    const now = new Date();
    const today = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    const navigation = performance.getEntriesByType('navigation')[0];
    const reloaded = navigation ? navigation.type === 'reload' : false;
    try {
      let recorded = JSON.parse(localStorage.getItem(key) || '{}');
      if (!recorded || recorded.day !== today || !Array.isArray(recorded.paths)) recorded = { day: today, paths: [] };
      if (!reloaded && recorded.paths.includes(path)) return true;
      if (!recorded.paths.includes(path)) recorded.paths.push(path);
      localStorage.setItem(key, JSON.stringify(recorded));
    } catch (_) {}
    return false;
  }

  function recordAggregateVisit() {
    if (window.location.pathname.includes('/analytics/')) return;
    if (alreadyRecordedToday(window.location.pathname)) return;

    const sessionId = sessionIdentifier();
    const visitorId = visitorIdentifier(sessionId);

    fetch(AGGREGATE_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        path: window.location.pathname,
        session: sessionId,
        visitor: visitorId
      }),
      keepalive: true
    }).catch(function () {
      // Analytics must never interfere with a portal page.
    });
  }

  function startAnalytics() {
    loadBeacon();
    recordAggregateVisit();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startAnalytics, { once:true });
  else startAnalytics();
}());
