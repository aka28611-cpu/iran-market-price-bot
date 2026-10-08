import type { Env } from "../env";
import { logInfo, logWarn } from "../logging";
import { runMarketReport } from "./report-job";
import { runUsdRefresh, type JobDeps } from "./usd-job";

/**
 * Dispatcher جابهای Cron — بر اساس عبارت cron که trigger شده.
 * عبارات با wrangler.toml ([triggers].crons) هماهنگ هستند.
 */

export const USD_CRON = "* * * * *";
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
