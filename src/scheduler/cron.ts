import type { Env } from "../env";
import { logInfo, logWarn } from "../logging";
import { runMarketReport } from "./report-job";
import { runUsdRefresh, type JobDeps } from "./usd-job";

/**
 * Dispatcher جابهای Cron — بر اساس عبارت cron که trigger شده.
 * عبارات با wrangler.toml ([triggers].crons) هماهنگ هستند.
 *
 * زمان‌بندی (مأموریت ۲۰۲۶-۱۰-۱۱):
 *  • عبارت پنج‌دقیقه‌ای (گام ۵ دقیقه) → دلار+تتر؛ منطق ساعات بازار
 *    (market-hours.ts) تعیین میکند کِی fetch/انتشار واقعی انجام شود:
 *    OPEN → fetch و ویرایش پیام؛ CLOSED → نمایش کش با نشان بسته؛
 *    UNKNOWN → هیچ. یعنی «هر ۵ دقیقه» هرگز به معنای «تغییر هر ۵ دقیقه»
 *    نیست — دادهٔ بی‌تغییر = پیام بی‌تغییر (UNCHANGED، بدون تماس تلگرام).
 *    نکتهٔ پلتفرم: Cron Triggers تأخیر دقیقه‌ای دارند و «حداقل یکبار»
 *    اجرا میشوند؛ cadence پنج‌دقیقه‌ای best-effort است (سقف کران: ۵
 *    trigger per account در پلن رایگان — فقط ۲ استفاده میشود).
 *  • عبارت شش‌ساعتی (ساعت صفر، هر ۶ ساعت) → گزارش کامل بازار
 *    (همهٔ ارزها/طلا/سکه‌ها).
 *    تلاقی دو عبارت در ۰۰:۰۰/۰۶:۰۰/۱۲:۰۰/۱۸:۰۰ UTC: هر trigger فراخوانی
 *    scheduled خودش را میگیرد (event.cron متفاوت) → بدون تداخل.
 */

export const USD_CRON = "*/5 * * * *";
export const REPORT_CRON = "0 */6 * * *";

export async function handleScheduled(
  cron: string,
  env: Env,
  deps: JobDeps = {},
): Promise<void> {
  if (cron === USD_CRON) {
    const result = await runUsdRefresh(env, deps);
    logInfo("cron.usd", { status: result.status, reason: result.reason });
    return;
  }
  if (cron === REPORT_CRON) {
    const result = await runMarketReport(env, deps);
    logInfo("cron.report", { status: result.status, reason: result.reason });
    return;
  }
  // عبارت cron ناشناس — فقط لاگ (بدون انتشار)
  logWarn("cron.unknown", { cron });
}
