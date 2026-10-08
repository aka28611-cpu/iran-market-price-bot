import { EnvError, parseEnv, type Env } from "./env";
import { verifyWebhookSecret } from "./auth/telegram-auth";
import { logError, logWarn } from "./logging";
import { rateLimit } from "./ratelimit";
import { handleTelegramUpdate } from "./telegram/commands";

/**
 * سطح HTTP عمداً حداقلی است:
 *
 *  • GET  /healthz          → {"ok":true} — بدون هیچ diagnostic یا اطلاعات
 *  • POST /telegram/webhook → فقط با هدر secret معتبر (زمان-ثابت)
 *  • هیچ endpoint مدیریتی عمومی وجود ندارد.
 *
 * env نامعتبر → 503 (fail-closed) — جز «نام» متغیرها چیزی لاگ نمی‌شود.
 */

export const HEALTH_PATH = "/healthz";
export const WEBHOOK_PATH = "/telegram/webhook";

const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const HEALTH_RATE_LIMIT = 60; // در دقیقه، per IP

const text = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export async function handleFetchRequest(
  request: Request,
  rawEnv: unknown,
  ctx: ExecutionContext,
): Promise<Response> {
  let env: Env;
  try {
    env = parseEnv(rawEnv);
  } catch (err) {
    const detail =
      err instanceof EnvError
        ? { missing: err.missing, invalid: err.invalid }
        : { error: "PARSE_FAILED" };
    logError("env.invalid", detail);
    return json({ ok: false }, 503);
  }

  const url = new URL(request.url);

  if (url.pathname === HEALTH_PATH) {
    if (request.method !== "GET") return text("Method Not Allowed", 405);
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!rateLimit(`health:${ip}`, HEALTH_RATE_LIMIT)) {
      return text("Too Many Requests", 429);
    }
    return json({ ok: true }, 200);
  }

  if (url.pathname === WEBHOOK_PATH) {
    if (request.method !== "POST") return text("Method Not Allowed", 405);
    const provided = request.headers.get(WEBHOOK_SECRET_HEADER);
    if (!verifyWebhookSecret(provided, env.TELEGRAM_WEBHOOK_SECRET)) {
      logWarn("webhook.unauthorized");
      return text("Unauthorized", 401);
    }
    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return text("Bad Request", 400);
    }
    // پردازش غیرهمزمان — پاسخ سریع به Telegram
    ctx.waitUntil(handleTelegramUpdate(update, env));
    return json({ ok: true }, 200);
  }

  // مسیر ناشناس — پاسخ کوتاه بدون جزئیات
  return text("Not Found", 404);
}
