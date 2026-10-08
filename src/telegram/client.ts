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
        return { ok: true, messageId };
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

  sendMessage(
    chatId: string | number,
    text: string,
  ): Promise<TelegramResult> {
    return this.call("sendMessage", { chat_id: chatId, text });
  }

  editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
  ): Promise<TelegramResult> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }
}
