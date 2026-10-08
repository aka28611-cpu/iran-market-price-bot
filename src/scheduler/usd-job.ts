import type { Env } from "../env";
import { isAllowedPublishTarget } from "../auth/allowlist";
import { logInfo, logWarn } from "../logging";
import {
  DEFAULT_MARKET_HOURS,
  evaluateMarketSession,
  type MarketHoursConfig,
} from "../market-hours";
import type { PriceProvider } from "../providers/provider";
import { getProvider } from "../providers/registry";
import { TelegramClient } from "../telegram/client";
import { formatUsdMessage, formatUsdMessageClosed } from "../telegram/format";
import {
  getUsdMessageId,
  isPaused,
  LAST_USD_PRICE_KEY,
  readLastUsdPrice,
  recordRunStatus,
  setUsdMessageId,
  USD_STATUS_KEY,
  writeJson,
} from "../state";
import { validateUsdPrice, validateUsdPriceShape } from "../validation";

/**
 * جاب هر ۱ دقیقه — بروزرسانی «پیام ثابت» دلار فردایی با editMessageText.
 *
 * fail-closed:
 *  • ساعت بازار UNKNOWN → هیچ چیزی منتشر نمی‌شود (قیمت مشکوک ممنوع)
 *  • بازار CLOSED → provider صدا زده نمی‌شود؛ فقط «آخرین قیمت معتبر»
 *    کش‌شده با نشان «بازار بسته» روی همان پیام ثابت نمایش داده می‌شود
 *  • داده نامعتبر/نبود داده = هیچ تغییری در کانال ایجاد نمی‌شود
 *  • هیچ مقدار جایگزین (fallback) ارسال نمی‌شود
 */

export interface JobDeps {
  /** تزریق fetch برای تست */
  fetchFn?: typeof fetch;
  /** ساعت قابل‌تنظیم برای تست */
  now?: () => Date;
  /** override provider برای تست */
  provider?: PriceProvider;
  /** override ساعت بازار برای تست (پیش‌فرض: src/market-hours.ts) */
  marketHours?: MarketHoursConfig;
}

export type JobStatus =
  | "ok"
  | "paused"
  | "no-data"
  | "invalid"
  | "send-error"
  | "edit-error"
  | "provider-error"
  | "market-closed"
  | "market-unknown";

export interface JobResult {
  status: JobStatus;
  reason?: string;
}

export function describeJobResult(result: JobResult): string {
  switch (result.status) {
    case "ok":
      return "✅ پیام دلار در کانال بروزرسانی شد.";
    case "paused":
      return "⏸ انتشار متوقف است؛ با /resume ادامه دهید.";
    case "no-data":
      return "⚠️ داده‌ای از provider دریافت نشد — چیزی منتشر نشد (بدون مقدار جایگزین).";
    case "invalid":
      return `⚠️ داده نامعتبر بود (${result.reason ?? "?"}) — چیزی منتشر نشد.`;
    case "send-error":
      return `❌ خطا در ارسال پیام به کانال: ${result.reason ?? "?"}`;
    case "edit-error":
      return `❌ خطا در ویرایش پیام: ${result.reason ?? "?"}`;
    case "provider-error":
      return `❌ خطای provider: ${result.reason ?? "?"}`;
    case "market-closed":
      return "🌙 بازار بسته است — پیام ثابت با «آخرین قیمت معتبر» بروزرسانی شد.";
    case "market-unknown":
      return "❓ وضعیت ساعت بازار نامشخص است — برای امنیت هیچ چیزی منتشر نشد.";
  }
}

type Recorder = (
  status: JobStatus,
  reason?: string,
) => Promise<JobResult>;

export async function runUsdRefresh(
  env: Env,
  deps: JobDeps = {},
): Promise<JobResult> {
  const now = deps.now ?? (() => new Date());
  const record: Recorder = async (status, reason) => {
    await recordRunStatus(env.STATE, USD_STATUS_KEY, {
      at: now().toISOString(),
      status,
      reason,
    });
    return { status, reason };
  };

  try {
    if (await isPaused(env.STATE)) {
      const result = await record("paused");
      logInfo("job.usd", { status: result.status });
      return result;
    }

    // ساعت بازار — منبع یگانه: src/market-hours.ts
    const marketHours = deps.marketHours ?? DEFAULT_MARKET_HOURS;
    const market = evaluateMarketSession(
      now(),
      marketHours.defaultSession,
      marketHours,
    );

    if (market.state === "UNKNOWN") {
      // fail-closed: قیمت مشکوک در وضعیت نامشخص هرگز منتشر نمی‌شود
      const result = await record("market-unknown", "MARKET_HOURS_UNKNOWN");
      logWarn("job.usd", { status: result.status });
      return result;
    }

    if (market.state === "CLOSED") {
      return await refreshWhileMarketClosed(env, deps, record);
    }

    // ---- OPEN: روال عادی ----
    const provider = deps.provider ?? getProvider(env);
    const price = await provider.fetchUsdTehran();
    if (!price) {
      const result = await record("no-data");
      logInfo("job.usd", { status: result.status, provider: provider.name });
      return result;
    }

    const verdict = validateUsdPrice(price, now().getTime());
    if (!verdict.ok) {
      const result = await record("invalid", verdict.reason);
      logWarn("job.usd", {
        status: result.status,
        reason: verdict.reason,
        provider: provider.name,
      });
      return result;
    }

    const published = await publishPinnedMessage(
      env,
      deps,
      formatUsdMessage(price),
      record,
    );
    if (published) return published;

    await writeJson(env.STATE, LAST_USD_PRICE_KEY, price);
    const result = await record("ok");
    logInfo("job.usd", { status: result.status });
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "UNKNOWN";
    const result = await record("provider-error", reason);
    logWarn("job.usd", { status: result.status });
    return result;
  }
}

/**
 * بازار بسته: provider صدا زده نمی‌شود (بدون fetch جدید)؛
 * پیام ثابت با «آخرین قیمت معتبر» کش‌شده + نشان بسته بودن بروزرسانی
 * می‌شود. نبود/خرابی کش = عدم انتشار (هیچ مقدار جایگزین ساخته نمی‌شود).
 */
async function refreshWhileMarketClosed(
  env: Env,
  deps: JobDeps,
  record: Recorder,
): Promise<JobResult> {
  const cached = await readLastUsdPrice(env.STATE);
  if (!cached) {
    const result = await record("no-data", "MARKET_CLOSED_NO_CACHE");
    logInfo("job.usd", { status: "no-data", market: "CLOSED" });
    return result;
  }

  // اعتبارسنجی ساختاری (بدون چک تازگی — در بازار بسته داده کهنه طبیعی است)
  const verdict = validateUsdPriceShape(cached);
  if (!verdict.ok) {
    const result = await record("invalid", `CLOSED_${verdict.reason ?? "INVALID"}`);
    logWarn("job.usd", {
      status: "invalid",
      market: "CLOSED",
      reason: verdict.reason,
    });
    return result;
  }

  const published = await publishPinnedMessage(
    env,
    deps,
    formatUsdMessageClosed(cached),
    record,
  );
  if (published) return published;

  const result = await record("market-closed");
  logInfo("job.usd", { status: result.status, market: "CLOSED" });
  return result;
}

/**
 * انتشار/ویرایش «پیام ثابت» دلار — مقصد انتشار فقط از allowlist (CHANNEL_ID).
 * خروجی: null = موفق؛ غیر null = نتیجه ثبت‌شده خطا (send-error / edit-error).
 */
async function publishPinnedMessage(
  env: Env,
  deps: JobDeps,
  text: string,
  record: Recorder,
): Promise<JobResult | null> {
  const target = env.CHANNEL_ID;
  if (!isAllowedPublishTarget(env.CHANNEL_ID, target)) {
    const result = await record("send-error", "TARGET_NOT_ALLOWED");
    logWarn("job.usd", { status: result.status });
    return result;
  }

  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
    fetchFn: deps.fetchFn,
  });
  const messageId = await getUsdMessageId(env.STATE);

  if (messageId === null) {
    // اولین اجرا: ساخت «پیام ثابت» و ذخیره id آن
    const sent = await tg.sendMessage(target, text);
    if (!sent.ok || sent.messageId === undefined) {
      const result = await record("send-error", sent.error);
      logWarn("job.usd", { status: result.status, reason: sent.error });
      return result;
    }
    await setUsdMessageId(env.STATE, sent.messageId);
    return null;
  }

  // اجراهای بعدی: ویرایش همان پیام — پیام جدیدی ساخته نمی‌شود
  const edited = await tg.editMessageText(target, messageId, text);
  if (!edited.ok) {
    const result = await record("edit-error", edited.error);
    logWarn("job.usd", { status: result.status, reason: edited.error });
    return result;
  }
  return null;
}
