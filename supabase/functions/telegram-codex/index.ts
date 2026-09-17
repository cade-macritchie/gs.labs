const telegramToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const webhookSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || '';
const githubToken = Deno.env.get('GITHUB_DISPATCH_TOKEN') || '';
const githubOwner = Deno.env.get('GITHUB_OWNER') || 'cade-macritchie';
const githubRepo = Deno.env.get('GITHUB_REPO') || 'gs.labs';
const allowedUserIds = new Set(
  (Deno.env.get('TELEGRAM_ALLOWED_USER_IDS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const allowedChatIds = new Set(
  (Deno.env.get('TELEGRAM_ALLOWED_CHAT_IDS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function sendTelegramMessage(chatId, text) {
  if (!telegramToken || !chatId) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!response.ok) {
      console.error('Telegram sendMessage failed.', response.status, await response.text());
    }
  } catch (error) {
    console.error('Telegram sendMessage request failed.', error);
  }
}

async function dispatchCodexJob(payload) {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(githubOwner)}/${encodeURIComponent(githubRepo)}/dispatches`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${githubToken}`,
        'content-type': 'application/json',
        'user-agent': 'enrollment-tools-telegram-codex',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ event_type: 'telegram_codex', client_payload: payload }),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub repository dispatch returned ${response.status}: ${await response.text()}`);
  }
}

Deno.serve(async (request) => {
  if (request.method === 'GET') return json({ ok: true, service: 'telegram-codex' });
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);

  if (!telegramToken || !webhookSecret || !githubToken || !allowedUserIds.size) {
    console.error('Telegram Codex function is missing required secrets.');
    return json({ ok: false, error: 'Service is not configured.' }, 503);
  }

  const suppliedSecret = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!secureEqual(suppliedSecret, webhookSecret)) {
    return json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }

  const message = update.message;
  const userId = String(message?.from?.id ?? '');
  const chatId = String(message?.chat?.id ?? '');
  const text = String(message?.text || '').trim();
  if (!message || message.from?.is_bot || !chatId || !text) return json({ ok: true, ignored: true });

  if (!allowedUserIds.has(userId) || (allowedChatIds.size && !allowedChatIds.has(chatId))) {
    console.warn('Rejected Telegram Codex request from an unauthorized sender.', { userId, chatId });
    return json({ ok: true, ignored: true });
  }

  const command = text.match(/^\/codex(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i);
  if (!command) {
    if (/^\/(?:start|help)(?:@[a-z0-9_]+)?$/i.test(text)) {
      await sendTelegramMessage(chatId, 'Use /codex followed by the requested repository change. Example:\n/codex Change the homepage card subtitle.');
    }
    return json({ ok: true, ignored: true });
  }

  const prompt = String(command[1] || '').trim();
  if (!prompt) {
    await sendTelegramMessage(chatId, 'Add a request after /codex. Example:\n/codex Change the homepage card subtitle.');
    return json({ ok: true });
  }
  if (prompt.length > 3000) {
    await sendTelegramMessage(chatId, 'That request is too long. Keep the /codex instruction under 3,000 characters.');
    return json({ ok: true });
  }

  const requestId = String(update.update_id ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  try {
    await dispatchCodexJob({ prompt, chat_id: chatId, user_id: userId, request_id: requestId });
    await sendTelegramMessage(chatId, `Codex request ${requestId} is queued. I will send the pull request here when it is ready.`);
    return json({ ok: true, request_id: requestId });
  } catch (error) {
    console.error('Unable to dispatch Telegram Codex job.', error);
    await sendTelegramMessage(chatId, `I could not queue Codex request ${requestId}. Check the Edge Function logs and GitHub token.`);
    // Acknowledge the update so Telegram does not retry it and create duplicate jobs.
    return json({ ok: false, error: 'Unable to queue request.' });
  }
});
