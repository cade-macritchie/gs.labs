(function () {
  'use strict';

  const PRODUCTION_HOST = 'cade-macritchie.github.io';
  const SITE_TOKEN = '41948a5bca5f4a97b32961ff03ce053f';
  const AGGREGATE_ENDPOINT = 'https://gs-labs-slate-gateway.gs-labs.workers.dev/api/analytics/event';
  const CLICKS_ENDPOINT = 'https://gs-labs-slate-gateway.gs-labs.workers.dev/api/analytics/clicks';
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
    if (window.location.pathname.includes('/analytics/')) return false;
    if (alreadyRecordedToday(window.location.pathname)) return false;

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
    return true;
  }

  // Click counts, batched into one beacon when the page is left, and only on
  // visits recordAggregateVisit counted, so clicks never add more than one
  // Worker request per recorded page view.
  //
  // Pages render student names, emails and phone numbers as links and buttons,
  // so a click target is never labeled by its text at click time. Elements
  // already on the page when this runs (before any data has loaded) are
  // labeled by the text they had then; anything rendered later is labeled by
  // its CSS class, e.g. "[campus-card]". Either way, data-track="Name" on an
  // element overrides the label. Text with an @ or a 5+ digit run is dropped.
  const CLICKABLE = 'a[href], button, summary, [role="button"], [role="tab"], [role="option"], input[type="checkbox"], input[type="radio"], input[type="submit"], input[type="button"], [data-track]';
  const MAX_CLICK_TARGETS = 50;

  function cleanLabel(text) {
    const label = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return label && !/@|\d{5,}/.test(label) ? label : '';
  }

  function staticLabel(element) {
    const field = element.matches('input[type="checkbox"], input[type="radio"]');
    return cleanLabel(element.getAttribute('aria-label')) ||
      cleanLabel(field ? (element.labels && element.labels[0] && element.labels[0].textContent) : (element.textContent || element.value)) ||
      cleanLabel(element.title);
  }

  function startClickTracking() {
    const staticLabels = new WeakMap();
    document.querySelectorAll(CLICKABLE).forEach(function (element) {
      const label = staticLabel(element);
      if (label) staticLabels.set(element, label);
    });

    const counts = new Map();
    document.addEventListener('click', function (event) {
      const element = event.target instanceof Element ? event.target.closest(CLICKABLE) : null;
      if (!element) return;
      const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/)[0] : '';
      const target = cleanLabel(element.getAttribute('data-track')) ||
        staticLabels.get(element) ||
        '[' + (className || element.tagName.toLowerCase()) + ']';
      if (counts.has(target) || counts.size < MAX_CLICK_TARGETS) counts.set(target, (counts.get(target) || 0) + 1);
    }, true);

    window.addEventListener('pagehide', function () {
      if (!counts.size) return;
      const clicks = Array.from(counts, function (entry) { return { target: entry[0], count: entry[1] }; });
      counts.clear();
      try {
        navigator.sendBeacon(CLICKS_ENDPOINT, JSON.stringify({ path: window.location.pathname, clicks: clicks }));
      } catch (_) {}
    });
  }

  function startAnalytics() {
    loadBeacon();
    if (recordAggregateVisit()) startClickTracking();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startAnalytics, { once:true });
  else startAnalytics();
}());
