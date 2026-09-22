(function () {
  'use strict';

  const PARENT_ORIGIN = 'https://enroll.gs.edu';

  // Every term/year combination the data actually contains, oldest first. A
  // period left out of this table is invisible to every portal, which is how
  // all of 2025-2026 (561 people) and every Summer term used to be missing.
  //
  // Adding a period here is only half the job: the gateway needs a matching
  // person-created window in PERSON_CREATED_WINDOWS (tools/queryomatic/worker.js)
  // or inquiries and prospects fall back to all-time for that period.
  const periods = Object.freeze({
    total: Object.freeze({ label: 'Total (All Time)', term: null, year: null }),
    FA25: Object.freeze({ label: 'FA25 — Fall 2025', term: 'Fall', year: '2025-2026' }),
    SP26: Object.freeze({ label: 'SP26 — Spring 2026', term: 'Spring', year: '2025-2026' }),
    SU26: Object.freeze({ label: 'SU26 — Summer 2026', term: 'Summer', year: '2025-2026' }),
    FA26: Object.freeze({ label: 'FA26 — Fall 2026', term: 'Fall', year: '2026-2027' }),
    SP27: Object.freeze({ label: 'SP27 — Spring 2027', term: 'Spring', year: '2026-2027' }),
    SU27: Object.freeze({ label: 'SU27 — Summer 2027', term: 'Summer', year: '2026-2027' }),
    FA27: Object.freeze({ label: 'FA27 — Fall 2027', term: 'Fall', year: '2027-2028' }),
    SP28: Object.freeze({ label: 'SP28 — Spring 2028', term: 'Spring', year: '2027-2028' }),
    SU28: Object.freeze({ label: 'SU28 — Summer 2028', term: 'Summer', year: '2027-2028' })
  });

  function periodKey(term, year) {
    return Object.keys(periods).find(function (key) {
      return periods[key].term === (term || null) && periods[key].year === (year || null);
    }) || 'total';
  }

  function populatePeriodSelect(select, term, year) {
    if (!select) return;
    select.replaceChildren();
    Object.keys(periods).forEach(function (key) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = periods[key].label;
      select.appendChild(option);
    });
    select.value = periodKey(term, year);
  }

  function periodNavigation(key) {
    const period = periods[key] || periods.total;
    if (!period.term) return { set: {}, remove: ['term', 'year'] };
    return { set: { term: period.term, year: period.year }, remove: [] };
  }

  function createBridge(dashboard, onData) {
    let resizeFrame = 0;

    function post(type, details) {
      if (window.parent === window) return;
      window.parent.postMessage(Object.assign({ type: type, dashboard: dashboard }, details || {}), PARENT_ORIGIN);
    }

    function resize() {
      if (resizeFrame) return;
      resizeFrame = window.requestAnimationFrame(function () {
        resizeFrame = 0;
        const height = Math.ceil(document.documentElement.scrollHeight);
        post('enrollment-dashboard-resize', { height: height });
      });
    }

    window.addEventListener('message', function (event) {
      if (event.origin !== PARENT_ORIGIN || event.source !== window.parent || !event.data) return;
      if (event.data.type !== 'enrollment-dashboard-data' || event.data.dashboard !== dashboard) return;
      onData(event.data.payload || {});
      resize();
    });

    window.addEventListener('load', function () {
      post('enrollment-dashboard-ready');
      resize();
    });

    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(document.documentElement);

    return Object.freeze({
      navigate: function (set, remove) {
        if (window.parent === window) {
          const url = new URL(window.location.href);
          Object.keys(set || {}).forEach(function (key) {
            const value = String(set[key] == null ? '' : set[key]).trim();
            if (value) url.searchParams.set(key, value);
            else url.searchParams.delete(key);
          });
          (remove || []).forEach(function (key) { url.searchParams.delete(key); });
          window.location.assign(url.toString());
          return;
        }
        post('enrollment-dashboard-navigate', { set: set || {}, remove: remove || [] });
      },
      openRecord: function (url) {
        if (url) post('enrollment-dashboard-open-record', { url: String(url) });
      },
      resize: resize
    });
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function decodeEntities(value) {
    const named = { amp:'&', apos:"'", quot:'"', lt:'<', gt:'>', nbsp:'\u00a0', rsquo:'’', lsquo:'‘', rdquo:'”', ldquo:'“', ndash:'–', mdash:'—' };
    let decoded = String(value == null ? '' : value);
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decoded
        .replace(/&#x([0-9a-f]+);/gi, function (match, digits) { const code = parseInt(digits, 16); return Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match; })
        .replace(/&#(\d+);/g, function (match, digits) { const code = parseInt(digits, 10); return Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match; })
        .replace(/&([a-z]+);/gi, function (match, name) { return Object.prototype.hasOwnProperty.call(named, name.toLowerCase()) ? named[name.toLowerCase()] : match; });
      if (next === decoded) break;
      decoded = next;
    }
    return decoded;
  }

  // Slate sometimes hands back percent-escaped values (e.g. "Master%20of%20Divinity").
  // Decode each run of valid escapes on its own so a stray "%" never breaks the whole string.
  function decodePercent(value) {
    const raw = String(value == null ? '' : value);
    if (!/%[0-9a-f]{2}/i.test(raw)) return raw;
    return raw.replace(/(?:%[0-9a-f]{2})+/gi, function (match) {
      try { return decodeURIComponent(match); } catch (_) { return match; }
    });
  }

  function decodeText(value) {
    return decodeEntities(decodePercent(decodeEntities(value)));
  }

  function text(value, fallback) {
    return decodeText(value == null || value === '' ? (fallback == null ? '—' : fallback) : value);
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = text(value, '0');
  }

  function showApp() {
    const loading = document.getElementById('loading');
    const app = document.getElementById('app');
    if (loading) loading.hidden = true;
    if (app) app.hidden = false;
  }

  function emptyState(message) {
    const element = document.createElement('div');
    element.className = 'empty-state';
    const icon = document.createElement('div');
    icon.className = 'empty-state-icon';
    icon.textContent = '—';
    const copy = document.createElement('div');
    copy.textContent = message;
    element.append(icon, copy);
    return element;
  }

  function csvCell(value) {
    let normalized = decodeText(value == null ? '' : value).replace(/\r\n?/g, '\n');
    if (/^\s*[=+\-@]/.test(normalized)) normalized = "'" + normalized;
    return '"' + normalized.replace(/"/g, '""') + '"';
  }

  function downloadCsv(filename, columns, records) {
    const rows = Array.isArray(records) ? records : [];
    const fields = Array.isArray(columns) ? columns : [];
    if (!rows.length || !fields.length) return false;
    const lines = [fields.map(function (column) { return csvCell(column.label); }).join(',')];
    rows.forEach(function (record) {
      lines.push(fields.map(function (column) {
        const value = typeof column.value === 'function' ? column.value(record) : record && record[column.key];
        return csvCell(value);
      }).join(','));
    });
    const baseName = String(filename || 'records').trim().replace(/\.csv$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'records';
    const url = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = baseName + '.csv';
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    return true;
  }

  window.AcademicPeriods = Object.freeze({
    values: periods,
    keyFrom: periodKey,
    populate: populatePeriodSelect,
    navigation: periodNavigation
  });
  window.DashboardBridge = Object.freeze({ create: createBridge });
  window.DashboardUI = Object.freeze({
    number: number,
    decodeEntities: decodeEntities,
    decodeText: decodeText,
    text: text,
    setText: setText,
    showApp: showApp,
    emptyState: emptyState,
    downloadCsv: downloadCsv
  });
}());
