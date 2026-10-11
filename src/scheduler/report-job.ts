import type { Env } from "../env";
import { isAllowedPublishTarget } from "../auth/allowlist";
import { logInfo, logWarn } from "../logging";
import {
  DEFAULT_MARKET_HOURS,
  evaluateMarketSession,
} from "../market-hours";
import {
  crossCheckConfigFromEnv,
  crossCheckReportItems,
} from "../providers/cross-check";
import { getProvider } from "../providers/registry";
import { TelegramClient } from "../telegram/client";
import { formatMarketReport } from "../telegram/format";
import {
  isPaused,
  LAST_REPORT_KEY,
  readJson,
  recordRunStatus,
  REPORT_STATUS_KEY,
  writeJson,
  type RunStatus,
} from "../state";
import { sanitizeReportItems } from "../validation";
import type { JobDeps, JobResult, JobStatus } from "./usd-job";

/**
 * جاب هر ۶ ساعت — گزارش کامل بازار (پیام جدید با sendMessage).
 *
 * fail-closed:
 *  • نبود داده = عدم انتشار
 *  • آیتم نامعتبر = حذف از گزارش (نه جایگزین)
 *  • هیچ آیتم معتبر نبود = عدم انتشار
 *  • ساعت بازار UNKNOWN = عدم انتشار کامل (قیمت مشکوک ممنوع)
 *  • آیتم با اختلاف غیرعادی از مرجع = حذف از گزارش (اعتبارسنجی متقاطع)
 *
 * ضد اجرای تکراری cron: آخرین ارسال موفقِ تازه (< ۳۰ دقیقه) → این اجرا
 * suppressed میشود (Cron Triggers «حداقل یکبار» اجرا میشوند؛ تکرار = دو گزارش).
 */

/** حداقل فاصلهٔ مجاز بین دو ارسال موفق گزارش (ضد اجرای تکراری) */
const MIN_REPORT_SEND_INTERVAL_MS = 30 * 60 * 1000;

export async function runMarketReport(
  env: Env,
  deps: JobDeps = {},
): Promise<JobResult> {
  const now = deps.now ?? (() => new Date());
  const record = async (
    status: JobStatus,
    reason?: string,
  ): Promise<JobResult> => {
    await recordRunStatus(env.STATE, REPORT_STATUS_KEY, {
      at: now().toISOString(),
      status,
      reason,
    });
    return { status, reason };
  };

  try {
    if (await isPaused(env.STATE)) {
      const result = await record("paused");
      logInfo("job.report", { status: result.status });
      return result;
    }

    // گارد اجرای تکراری: ارسال موفقِ تازه (< ۳۰ دقیقه) → این اجرا suppressed
    const lastStatus = await readJson<RunStatus>(
      env.STATE,
      REPORT_STATUS_KEY,
    );
    // «ok» یا «suppressed» تازه = نشانهٔ فعالیت اخیر (زنجیرهٔ اجراهای تکراری
    // نباید با status suppressed باز شود — همان پیام دوباره نرود)
    const recentActivity =
      lastStatus?.status === "ok" || lastStatus?.status === "suppressed";
    if (recentActivity && typeof lastStatus.at === "string") {
      const lastAt = Date.parse(lastStatus.at);
      const elapsedMs = now().getTime() - lastAt;
      if (
        Number.isFinite(lastAt) &&
        Number.isFinite(elapsedMs) &&
        elapsedMs >= 0 &&
        elapsedMs < MIN_REPORT_SEND_INTERVAL_MS
      ) {
        const result = await record("suppressed", "DUPLICATE_RUN_SUPPRESSED");
        logWarn("job.report", {
          status: result.status,
          reason: result.reason,
        });
        return result;
      }
    }

    // ساعت بازار — منبع یگانه: src/market-hours.ts
    // UNKNOWN → عدم انتشار (fail-closed)؛ OPEN/CLOSED → ادامه:
    // اعتبارسنجی آیتمها داده خراب را حذف می‌کند و زمان داده در گزارش هست
    const marketHours = deps.marketHours ?? DEFAULT_MARKET_HOURS;
    const market = evaluateMarketSession(
      now(),
      marketHours.defaultSession,
      marketHours,
    );
    if (market.state === "UNKNOWN") {
      const result = await record("market-unknown", "MARKET_HOURS_UNKNOWN");
      logWarn("job.report", { status: result.status });
      return result;
    }

    const provider = deps.provider ?? getProvider(env);
    const report = await provider.fetchMarketReport();
    if (!report) {
      const result = await record("no-data");
      logInfo("job.report", { status: result.status, provider: provider.name });
      return result;
    }

    // آیتمهای نامعتبر حذف میشوند؛ نبود (null) باقی میماند تا فرمتر حذفش کند
    const items = sanitizeReportItems(report.items);

    // اعتبارسنجی متقاطع (بند ۳): یک fetch از TGJU + یکی از Wallex —
    // آیتم diverged حذف میشود (نرخ مشکوک منتشر نمیشود)؛ مرجع غایب →
    // بدون حذف + لاگ (advisory — مرجع رایگان نقطهٔ شکست انتشار نیست).
    const cc = crossCheckConfigFromEnv(env);
    let finalItems = items;
    let ccReason: string | undefined;
    if (cc.enabled && items.length > 0) {
      const outcome = await crossCheckReportItems(
        cc,
        items,
        deps.fetchFn ?? fetch.bind(globalThis),
        now,
      );
      if (outcome.dropped.length > 0) {
        finalItems = outcome.items;
        ccReason = `CROSS_CHECK_OMITTED:${outcome.dropped.join(",")}`;
        logWarn("job.report", { status: "ok", reason: ccReason });
      }
    }

    const text = formatMarketReport({ ...report, items: finalItems });
    if (text === null) {
      const result = await record(
        "invalid",
        ccReason ? "CROSS_CHECK_ALL_DROPPED" : "NO_VALID_ITEMS",
      );
      logWarn("job.report", { status: result.status, reason: result.reason });
      return result;
    }

    // مقصد انتشار فقط از allowlist (CHANNEL_ID)
    const target = env.CHANNEL_ID;
    if (!isAllowedPublishTarget(env.CHANNEL_ID, target)) {
      const result = await record("send-error", "TARGET_NOT_ALLOWED");
      logWarn("job.report", { status: result.status });
      return result;
    }

    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
      fetchFn: deps.fetchFn,
    });
    const sent = await tg.sendMessage(target, text);
    if (!sent.ok) {
      const result = await record("send-error", sent.error);
      logWarn("job.report", { status: result.status, reason: sent.error });
      return result;
    }

    await writeJson(env.STATE, LAST_REPORT_KEY, {
      ...report,
      items: finalItems,
    });
    const result = await record("ok", ccReason);
    logInfo("job.report", { status: result.status, reason: result.reason });
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "UNKNOWN";
    const result = await record("provider-error", reason);
    logWarn("job.report", { status: result.status });
    return result;
  }
}
