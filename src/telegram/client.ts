/**
 * کلاینت Telegram Bot API — با timeout و مدیریت خطای fail-closed.
 *
 *  • توکن هرگز لاگ نمی‌شود و در هیچ پیام خطایی ظاهر نمی‌شود.
 *  • خطاها به کدهای کوتاه (TIMEOUT/NETWORK/…) نگاشت می‌شوند.
 *  • خطای بی‌خطر «message is not modified» به‌عنوان ok تلقی می‌شود.
 */

export interface TelegramDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface TelegramResult {
  ok: boolean;
  messageId?: number;
  /** وضعیت عضویت خام از getChatMember (فقط برای آن متد) */
  memberStatus?: string;
  /** کد کوتاه خطا: TIMEOUT | NETWORK | HTTP_xxx | توضیح سرویس */
  error?: string;
  /** خطای بی‌خطر (مثل message is not modified) */
  benign?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  result?: unknown;
}

export class TelegramClient {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly token: string,
    deps: TelegramDeps = {},
  ) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = deps.fetchFn ?? fetch.bind(globalThis);
  }

  private async call(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<TelegramResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      const data = (await res.json()) as TelegramResponse;
      if (res.status === 200 && data.ok) {
        const result = data.result as Record<string, unknown> | undefined;
        const messageId =
          result && typeof result.message_id === "number"
            ? result.message_id
            : undefined;
        // وضعیت عضویت (خروجی getChatMember) — فقط اگر رشته معتبر باشد
        const memberStatus =
          result && typeof result.status === "string" && result.status.length > 0
            ? result.status
            : undefined;
        return { ok: true, messageId, memberStatus };
      }
      if (
        typeof data.description === "string" &&
        data.description.includes("message is not modified")
      ) {
        return { ok: true, benign: true };
      }
      return { ok: false, error: data.description ?? `HTTP_${res.status}` };
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      return { ok: false, error: timedOut ? "TIMEOUT" : "NETWORK" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** گزینه‌های ارسال پیام — replyMarkup خام (InlineKeyboardMarkup) */
  sendMessage(
    chatId: string | number,
    text: string,
    options: { replyMarkup?: unknown } = {},
  ): Promise<TelegramResult> {
    const payload: Record<string, unknown> = { chat_id: chatId, text };
    if (options.replyMarkup !== undefined) {
      // JSON serialization دقیقاً مطابق Bot API (reply_markup رشته JSON است)
      payload.reply_markup = JSON.stringify(options.replyMarkup);
    }
    return this.call("sendMessage", payload);
  }

  /**
   * ویرایش متن پیام + کیبورد — برای ناوبری منوها بدون پیام جدید.
   * خطای بی‌خطر «message is not modified» در call به ok نگاشت میشود.
   */
  editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    options: { replyMarkup?: unknown } = {},
  ): Promise<TelegramResult> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (options.replyMarkup !== undefined) {
      payload.reply_markup = JSON.stringify(options.replyMarkup);
    }
    return this.call("editMessageText", payload);
  }

  /**
   * وضعیت عضویت یک کاربر در چت/کانال — server-side.
   * نتیجه ok:false هرگز «عدم عضویت» نیست؛ تفسیر سه‌حالته با auth/access.ts است.
   */
  getChatMember(
    chatId: string | number,
    userId: number,
  ): Promise<TelegramResult> {
    return this.call("getChatMember", { chat_id: chatId, user_id: userId });
  }

  /** پاسخ به callback query — توقف نشانگر بارگذاری تلگرام؛ متن کوتاه اختیاری (toast) */
  answerCallbackQuery(
    callbackQueryId: string,
    options: { text?: string; showAlert?: boolean } = {},
  ): Promise<TelegramResult> {
    const payload: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (options.text !== undefined) {
      payload.text = options.text.slice(0, 190);
    }
    if (options.showAlert) {
      payload.show_alert = true;
    }
    return this.call("answerCallbackQuery", payload);
  }
}
