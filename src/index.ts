import { EnvError, parseEnv } from "./env";
import { logError } from "./logging";
import { handleFetchRequest } from "./router";
import { handleScheduled } from "./scheduler/cron";

/**
 * نقطه ورود Cloudflare Worker — iran-market-price-bot
 *
 *  • fetch     → /healthz و /telegram/webhook
 *  • scheduled → cronهای ۱ دقیقه و ۶ ساعت
 *
 * env نامعتبر در هر مسیر = توقف fail-closed (فقط نام متغیرها لاگ می‌شود).
 */

export default {
  async fetch(
    request: Request,
    env: unknown,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handleFetchRequest(request, env, ctx);
  },

  async scheduled(
    event: ScheduledEvent,
    env: unknown,
    _ctx: ExecutionContext,
  ): Promise<void> {
    let parsed;
    try {
      parsed = parseEnv(env);
    } catch (err) {
      const detail =
        err instanceof EnvError
          ? { missing: err.missing, invalid: err.invalid }
          : { error: "PARSE_FAILED" };
      logError("env.invalid", detail);
      return; // fail-closed — بدون env معتبر هیچ جابی اجرا نمی‌شود
    }
    try {
      await handleScheduled(event.cron, parsed);
    } catch (err) {
      logError("cron.error", {
        message: err instanceof Error ? err.message : "UNKNOWN",
      });
    }
  },
};
