# Telegram Codex bot

This integration turns an authorized Telegram message such as:

```text
/codex Change the Teaching Sites empty-state copy and verify the page still loads.
```

into a reviewable pull request. It never pushes a Telegram-requested change directly to `main`.

## How it works

1. Telegram sends the bot update to the `telegram-codex` Supabase Edge Function.
2. The function verifies Telegram's webhook secret and the sender's user/chat ID.
3. It sends a `telegram_codex` repository-dispatch event to GitHub.
4. GitHub runs Codex with read-only repository credentials and workspace-limited writes.
5. The workflow saves Codex's diff as an artifact.
6. A separate job with write credentials applies that patch and opens a pull request.
7. The bot replies in Telegram with the pull-request URL.

The separate jobs matter: the Codex job cannot push, and the job that can push never runs repository code after applying the generated patch.

## 1. Create the Telegram bot

Create a bot with Telegram's `@BotFather` and save its token. Send the new bot one message, then obtain your numeric user and chat IDs before registering the webhook:

```powershell
$updates = Invoke-RestMethod -Uri "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getUpdates"
$updates.result | ConvertTo-Json -Depth 10
```

Use `message.from.id` for `TELEGRAM_ALLOWED_USER_IDS` and `message.chat.id` for `TELEGRAM_ALLOWED_CHAT_IDS`. Keep this bot private.

## 2. Create the GitHub dispatch token

Create a fine-grained GitHub personal access token scoped only to `cade-macritchie/gs.labs`. It needs permission to create repository dispatch events. Store it only as the Supabase secret `GITHUB_DISPATCH_TOKEN`.

## 3. Configure and deploy Supabase

Generate a long random webhook secret. From a configured Supabase CLI session, set:

```powershell
supabase secrets set TELEGRAM_BOT_TOKEN="$env:TELEGRAM_BOT_TOKEN"
supabase secrets set TELEGRAM_WEBHOOK_SECRET="$env:TELEGRAM_WEBHOOK_SECRET"
supabase secrets set TELEGRAM_ALLOWED_USER_IDS="YOUR_NUMERIC_USER_ID"
supabase secrets set TELEGRAM_ALLOWED_CHAT_IDS="YOUR_NUMERIC_CHAT_ID"
supabase secrets set GITHUB_DISPATCH_TOKEN="$env:GITHUB_DISPATCH_TOKEN"
supabase secrets set GITHUB_OWNER="cade-macritchie"
supabase secrets set GITHUB_REPO="gs.labs"
supabase functions deploy telegram-codex --no-verify-jwt
```

`--no-verify-jwt` is required because Telegram cannot send a Supabase JWT. The function instead requires Telegram's secret webhook header and an explicit user/chat allowlist.

## 4. Add GitHub Actions secrets

Add these repository Actions secrets:

- `OPENAI_API_KEY` — used only by `openai/codex-action` in the read-only-credentials job.
- `TELEGRAM_BOT_TOKEN` — used only by notification jobs after Codex finishes.

Do not put either value in the repository, GitHub Pages JavaScript, workflow YAML, Telegram messages, logs, or PR text.

## 5. Register the webhook

Replace `YOUR_PROJECT_REF` with the Supabase project reference and run:

```powershell
$webhookUrl = "https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-codex"
$body = @{
  url = $webhookUrl
  secret_token = $env:TELEGRAM_WEBHOOK_SECRET
  allowed_updates = @('message')
  drop_pending_updates = $true
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/setWebhook" `
  -ContentType 'application/json' `
  -Body $body
```

## 6. Test it

Send the bot:

```text
/codex Add a short comment to README.md explaining that the dashboards are hosted on GitHub Pages.
```

Expected flow:

1. Telegram replies that the request is queued.
2. The `Telegram Codex request` workflow appears in GitHub Actions.
3. Telegram receives either a pull-request URL, a no-change message, or a workflow-failure URL.
4. Review the diff and checks before merging.

## Security behavior

- Only configured Telegram user IDs are accepted; chat IDs can be restricted too.
- Requests are limited to 3,000 characters.
- Duplicate in-flight Telegram updates share a GitHub concurrency key.
- Codex receives no GitHub write credential or Telegram bot token.
- Codex runs against `main` and returns a patch artifact.
- A separate job opens the pull request; nothing auto-merges.
- Keep branch protection and required reviews enabled on `main`.

To disable the integration immediately, delete the Telegram webhook or remove/rotate `GITHUB_DISPATCH_TOKEN` in Supabase.
