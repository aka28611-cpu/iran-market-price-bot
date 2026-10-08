import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiterForTests } from "../src/ratelimit";
import { PAUSED_FLAG_KEY } from "../src/state";
import worker from "../src/index";
import {
  adminUpdate,
  makeExecutionContext,
  makeRawEnv,
  MockKV,
  WEBHOOK_SECRET,
} from "./helpers";

const BASE = "http://worker.test";

describe("سطح HTTP — حداقلی و امن", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("GET /healthz فقط {ok:true} برمی‌گرداند (بدون diagnostic)", async () => {
    const { ctx } = makeExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}/healthz`),
      makeRawEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("متد غیر GET روی /healthz → 405", async () => {
    const { ctx } = makeExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}/healthz`, { method: "POST" }),
      makeRawEnv(),
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it("healthz بعد از سقف مجاز → 429 (rate limit)", async () => {
    const { ctx } = makeExecutionContext();
    const env = makeRawEnv();
    let last = 200;
    for (let i = 0; i < 65; i += 1) {
      last = (await worker.fetch(new Request(`${BASE}/healthz`), env, ctx))
        .status;
    }
    expect(last).toBe(429);
  });

  it("وب‌هوک بدون secret یا با secret غلط → 401", async () => {
    const { ctx } = makeExecutionContext();
    const noSecret = await worker.fetch(
      new Request(`${BASE}/telegram/webhook`, { method: "POST", body: "{}" }),
      makeRawEnv(),
      ctx,
    );
    expect(noSecret.status).toBe(401);

    const wrongSecret = await worker.fetch(
      new Request(`${BASE}/telegram/webhook`, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "wrong-secret-123456" },
        body: JSON.stringify(adminUpdate("/status")),
      }),
      makeRawEnv(),
      ctx,
    );
    expect(wrongSecret.status).toBe(401);
  });

  it("وب‌هوک با secret درست، دستور ادمین را پردازش می‌کند", async () => {
    // fetch سراسری را stub می‌کنیم تا هیچ تماس واقعی با Telegram انجام نشود
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        sent.push(
          typeof init?.body === "string" ? JSON.parse(init.body) : {},
        );
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 55 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const { ctx, flush } = makeExecutionContext();
    const kv = new MockKV();
    const env = makeRawEnv({ STATE: kv });
    const res = await worker.fetch(
      new Request(`${BASE}/telegram/webhook`, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
        body: JSON.stringify(adminUpdate("/pause")),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await flush();
    expect(kv.store.get(PAUSED_FLAG_KEY)).toBe("1");
    expect(sent.length).toBeGreaterThanOrEqual(1); // پاسخ به ادمین
    vi.unstubAllGlobals();
  });

  it("متد غیر POST روی وب‌هوک → 405", async () => {
    const { ctx } = makeExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}/telegram/webhook`),
      makeRawEnv(),
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it("مسیر ناشناس → 404 ساده (بدون endpoint مدیریتی عمومی)", async () => {
    const { ctx } = makeExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}/admin`),
      makeRawEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("env نامعتبر → 503 (fail-closed)", async () => {
    const { ctx } = makeExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}/healthz`),
      { TELEGRAM_BOT_TOKEN: "x" },
      ctx,
    );
    expect(res.status).toBe(503);
  });
});

describe("scheduled — dispatch بر اساس cron", () => {
  it("cron هر ۱ دقیقه → اجرای جاب دلار (stub → no-data، بدون انتشار)", async () => {
    const kv = new MockKV();
    const env = makeRawEnv({ STATE: kv });
    await worker.scheduled(
      { cron: "* * * * *" } as unknown as ScheduledEvent,
      env,
      makeExecutionContext().ctx,
    );
    const status = JSON.parse(kv.store.get("status:usd") ?? "{}");
    expect(status.status).toBe("no-data");
  });

  it("cron هر ۶ ساعت → اجرای جاب گزارش (stub → no-data، بدون انتشار)", async () => {
    const kv = new MockKV();
    const env = makeRawEnv({ STATE: kv });
    await worker.scheduled(
      { cron: "0 */6 * * *" } as unknown as ScheduledEvent,
      env,
      makeExecutionContext().ctx,
    );
    const status = JSON.parse(kv.store.get("status:report") ?? "{}");
    expect(status.status).toBe("no-data");
  });

  it("env نامعتبر در scheduled → هیچ جابی اجرا نمی‌شود", async () => {
    const kv = new MockKV();
    await worker.scheduled(
      { cron: "* * * * *" } as unknown as ScheduledEvent,
      { STATE: kv },
      makeExecutionContext().ctx,
    );
    expect(await kv.get("status:usd")).toBeNull();
  });
});
