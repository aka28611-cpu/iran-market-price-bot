import type { Env } from "../env";
import { isAllowedPublishTarget } from "../auth/allowlist";
import { logInfo, logWarn } from "../logging";
import type { PriceProvider } from "../providers/provider";
import { getProvider } from "../providers/registry";
import { TelegramClient } from "../telegram/client";
import { formatUsdMessage } from "../telegram/format";
import {
  getUsdMessageId,
  isPaused,
  LAST_USD_PRICE_KEY,
  recordRunStatus,
  setUsdMessageId,
  USD_STATUS_KEY,
  writeJson,
} from "../state";
import { validateUsdPrice } from "../validation";

/**
 * جاب هر ۱ دقیقه — بروزرسانی «پیام ثابت» دلار فردایی با editMessageText.
 *
 * fail-closed: داده نامعتبر/نبود داده = هیچ تغییری در کانال ایجاد نمی‌شود.
 * هیچ مقدار جایگزین (fallback) ارسال نمی‌شود.
 */

export interface JobDeps {
  /** تزریق fetch برای تست */
  fetchFn?: typeof fetch;
  /** ساعت قابل‌تنظیم برای تست */
  now?: () => Date;
  /** override provider برای تست */
  provider?: PriceProvider;
}

export type JobStatus =
  | "ok"
  | "paused"
  | "no-data"
  | "invalid"
  | "send-error"
  | "edit-error"
  | "provider-error";

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
  }
}

export async function runUsdRefresh(
  env: Env,
  deps: JobDeps = {},
): Promise<JobResult> {
  const now = deps.now ?? (() => new Date());
  const record = async (
    status: JobStatus,
    reason?: string,
  ): Promise<JobResult> => {
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

    // مقصد انتشار فقط از allowlist (CHANNEL_ID)
    const target = env.CHANNEL_ID;
    if (!isAllowedPublishTarget(env.CHANNEL_ID, target)) {
      const result = await record("send-error", "TARGET_NOT_ALLOWED");
      logWarn("job.usd", { status: result.status });
      return result;
    }

    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
      fetchFn: deps.fetchFn,
    });
    const text = formatUsdMessage(price);
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
    } else {
      // اجراهای بعدی: ویرایش همان پیام — پیام جدیدی ساخته نمی‌شود
      const edited = await tg.editMessageText(target, messageId, text);
      if (!edited.ok) {
        const result = await record("edit-error", edited.error);
        logWarn("job.usd", { status: result.status, reason: edited.error });
        return result;
      }
    }

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
