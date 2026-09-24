const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && origin === env.ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...JSON_HEADERS, ...(extraHeaders || {}) },
  });
}

function isAdmin(request, env) {
  const key = request.headers.get('X-Admin-Key');
  return Boolean(env.ADMIN_KEY) && key === env.ADMIN_KEY;
}

function normalizeCode(rawSegment) {
  let value = rawSegment;
  try {
    value = decodeURIComponent(rawSegment || '');
  } catch {
    // leave value as-is if it isn't validly percent-encoded
  }
  return String(value || '').trim().toUpperCase().slice(0, 60);
}

const CODE_COLUMNS = 'code, amount, initial_amount, notes, created_at, updated_at';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (parts[0] !== 'api' || parts[1] !== 'waiver-codes') {
        return json({ error: 'not found' }, 404, cors);
      }

      // GET /api/waiver-codes — admin only, list every code
      if (parts.length === 2 && request.method === 'GET') {
        if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401, cors);
        const { results } = await env.DB.prepare(
          `SELECT ${CODE_COLUMNS} FROM waiver_codes ORDER BY created_at DESC`
        ).all();
        return json({ codes: results }, 200, cors);
      }

      // (1) POST /api/waiver-codes — admin only, add a waiver code
      // body: { code, amount, notes? }
      if (parts.length === 2 && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401, cors);
        const body = await request.json().catch(() => ({}));
        const code = normalizeCode(body.code);
        const amount = Number(body.amount);
        const notes = body.notes == null ? null : String(body.notes).slice(0, 500);
        if (!code) return json({ error: 'code is required' }, 400, cors);
        if (!Number.isInteger(amount) || amount < 0) {
          return json({ error: 'amount must be a non-negative integer' }, 400, cors);
        }

        const existing = await env.DB.prepare(
          'SELECT code FROM waiver_codes WHERE code = ?'
        ).bind(code).first();
        if (existing) return json({ error: 'code already exists' }, 409, cors);

        const result = await env.DB.prepare(
          `INSERT INTO waiver_codes (code, amount, initial_amount, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
           RETURNING ${CODE_COLUMNS}`
        ).bind(code, amount, amount, notes).first();
        return json({ waiverCode: result }, 201, cors);
      }

      // POST /api/waiver-codes/sync — admin only, bulk-add from a nightly
      // Slate export. Body: { codes: [{ code, amount, notes? }, ...] }.
      // Inserts codes it hasn't seen before; an already-known code is left
      // alone so a code someone used earlier today doesn't get its amount
      // reset back to the export's original value on the next sync.
      if (parts.length === 3 && parts[2] === 'sync' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401, cors);
        const body = await request.json().catch(() => ({}));
        const rows = Array.isArray(body.codes) ? body.codes : [];
        if (!rows.length) return json({ error: 'codes array is required' }, 400, cors);

        const created = [];
        const skipped = [];
        const invalid = [];
        const seen = new Set();

        for (const row of rows) {
          const rowCode = normalizeCode(row && row.code);
          const rowAmount = Number(row && row.amount);
          const rowNotes = row && row.notes == null ? null : String(row.notes).slice(0, 500);
          if (!rowCode || !Number.isInteger(rowAmount) || rowAmount < 0) {
            invalid.push((row && row.code) || '(blank)');
            continue;
          }
          if (seen.has(rowCode)) continue;
          seen.add(rowCode);

          const result = await env.DB.prepare(
            `INSERT INTO waiver_codes (code, amount, initial_amount, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(code) DO NOTHING
             RETURNING code`
          ).bind(rowCode, rowAmount, rowAmount, rowNotes).first();
          if (result) created.push(rowCode); else skipped.push(rowCode);
        }

        return json({ created, skipped, invalid }, 200, cors);
      }

      // GET /api/waiver-codes/summary — admin only. Total registrants across
      // all codes, using each code's original initial_amount (not its
      // current/decremented amount) so partial redemption doesn't shrink the
      // count, and excluding any code whose notes mention "admin" (e.g.
      // comp/staff codes that shouldn't count as real registrants).
      if (parts.length === 3 && parts[2] === 'summary' && request.method === 'GET') {
        if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401, cors);
        const result = await env.DB.prepare(
          `SELECT COALESCE(SUM(initial_amount), 0) AS totalRegistrants, COUNT(*) AS codeCount
           FROM waiver_codes
           WHERE notes IS NULL OR LOWER(notes) NOT LIKE '%admin%'`
        ).first();
        return json({ totalRegistrants: result.totalRegistrants, codeCount: result.codeCount }, 200, cors);
      }

      const code = parts.length >= 3 ? normalizeCode(parts[2]) : '';
      if (parts.length >= 3 && !code) {
        return json({ error: 'invalid code' }, 400, cors);
      }

      // (2) GET /api/waiver-codes/:code — check the code matches an existing record
      if (parts.length === 3 && request.method === 'GET') {
        const result = await env.DB.prepare(
          `SELECT ${CODE_COLUMNS} FROM waiver_codes WHERE code = ?`
        ).bind(code).first();
        if (!result) return json({ valid: false, error: 'code not found' }, 404, cors);
        return json({ valid: true, waiverCode: result }, 200, cors);
      }

      // (3) GET /api/waiver-codes/:code/limit — is the remaining amount > 0?
      if (parts.length === 4 && parts[3] === 'limit' && request.method === 'GET') {
        const result = await env.DB.prepare(
          'SELECT amount FROM waiver_codes WHERE code = ?'
        ).bind(code).first();
        if (!result) return json({ valid: false, error: 'code not found' }, 404, cors);
        return json({ valid: result.amount > 0, amount: result.amount }, 200, cors);
      }

      // (4) POST /api/waiver-codes/:code/decrement — consume one use, atomically
      if (parts.length === 4 && parts[3] === 'decrement' && request.method === 'POST') {
        const result = await env.DB.prepare(
          `UPDATE waiver_codes
           SET amount = amount - 1, updated_at = datetime('now')
           WHERE code = ? AND amount > 0
           RETURNING ${CODE_COLUMNS}`
        ).bind(code).first();
        if (!result) {
          const stillExists = await env.DB.prepare(
            'SELECT code FROM waiver_codes WHERE code = ?'
          ).bind(code).first();
          if (!stillExists) return json({ error: 'code not found' }, 404, cors);
          return json({ error: 'waiver code limit reached' }, 409, cors);
        }
        return json({ waiverCode: result }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'server error', message: String((err && err.message) || err) }, 500, cors);
    }
  },
};
