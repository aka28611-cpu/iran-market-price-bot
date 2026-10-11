import type { Env } from "../env";
import { logInfo, logWarn } from "../logging";
import { runMarketReport } from "./report-job";
import { runUsdRefresh, type JobDeps } from "./usd-job";

/**
 * Dispatcher جابهای Cron — بر اساس عبارت cron که trigger شده.
 * عبارات با wrangler.toml ([triggers].crons) هماهنگ هستند.
 *
 * زمان‌بندی (مأموریت ۲۰۲۶-۱۰-۱۱ / راند ۲۸):
 *  • عبارت پنج‌دقیقه‌ای (گام ۵ دقیقه) → دلار+تتر؛ منطق ساعات بازار
 *    (market-hours.ts) تعیین میکند کِی fetch/انتشار واقعی انجام شود:
 *    OPEN → fetch و «پیام جدید» (حتی با قیمت یکسان — پیامهای قبلی
 *    هرگز ویرایش/حذف نمیشوند)؛ CLOSED → فقط در گذار، یک پیام با نشان
 *    بسته؛ UNKNOWN → هیچ.
 *    ضد پیام مضاعف: اجرای مجدد «همان رویداد» (scheduledTime یکسان)
 *    پیام تکراری نمی‌سازد (گارد usd:last_event + قفل مشورتی KV)؛
 *    رویداد بعدی همیشه پیام جدید می‌سازد.
 *    نکتهٔ پلتفرم: Cron Triggers تأخیر دقیقه‌ای دارند و «حداقل یکبار»
 *    اجرا میشوند؛ cadence پنج‌دقیقه‌ای best-effort است (سقف کران: ۵
 *    trigger per account در پلن رایگان — فقط ۲ استفاده میشود).
 *  • عبارت شش‌ساعتی (ساعت صفر، هر ۶ ساعت) → گزارش کامل بازار
 *    (همهٔ ارزها/طلا/سکه‌ها) — همیشه پیام جدید با sendMessage.
 *    تلاقی دو عبارت در ۰۰:۰۰/۰۶:۰۰/۱۲:۰۰/۱۸:۰۰ UTC: هر trigger فراخوانی
 *    scheduled خودش را میگیرد (event.cron متفاوت) → هر دو پیام طبق
 *    برنامهٔ خود ارسال میشوند (بدون تداخل).
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
