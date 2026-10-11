import { EnvError, parseEnv } from "./env";
import { logError } from "./logging";
import { handleFetchRequest } from "./router";
import { handleScheduled } from "./scheduler/cron";

/**
 * نقطه ورود Cloudflare Worker — iran-market-price-bot
 *
 *  • fetch     → /healthz و /telegram/webhook
 *  • scheduled → cronهای ۵ دقیقه و ۶ ساعت
 *    (scheduledTime رویداد برای گارد «اجرای مجدد همان رویداد» پاس می‌شود)
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
      // scheduledTime رویداد → گارد ضد پیام مضاعف در جاب ۵ دقیقه:
      // اجرای مجدد «همان رویداد» پیام تکراری نمی‌سازد؛ رویداد بعدی همیشه
      // پیام جدید می‌سازد (حتی با قیمت یکسان).
      await handleScheduled(event.cron, parsed, {
        scheduledTime: event.scheduledTime,
      });
    } catch (err) {
      logError("cron.error", {
        message: err instanceof Error ? err.message : "UNKNOWN",
      });
    }
  },
};
