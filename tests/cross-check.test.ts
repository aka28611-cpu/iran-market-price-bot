import { describe, expect, it } from "vitest";
import {
  compareWithReference,
  crossCheckConfigFromEnv,
  crossCheckReportItems,
  fetchTgjuSnapshot,
  fetchWallexUsdtToman,
  tolerancePctFor,
  TGJU_DEFAULT_URL,
  TGJU_SYMBOL_MAP,
  WALLEX_DEPTH_DEFAULT_URL,
  type CrossCheckConfig,
} from "../src/providers/cross-check";
import { PIN_DATA_KEY, PIN_TEXT_KEY, USD_MESSAGE_ID_KEY, USD_SEND_LOCK_KEY } from "../src/state";
import { runUsdRefresh } from "../src/scheduler/usd-job";
import { runMarketReport } from "../src/scheduler/report-job";
import { REPORT_STATUS_KEY } from "../src/state";
import type { MarketReport } from "../src/types";
import {
  alwaysOpenMarketHours,
  makeEnv,
  MockKV,
  telegramRecorder,
  fakeProvider,
} from "./helpers";

/**
 * اعتبارسنجی متقاطع (بند ۳ مأموریت ۲۰۲۶-۱۰-۱۱):
 *  • مقایسه با مرجع مستقل + آستانهٔ قابل‌تنظیم
 *  • اختلاف غیرعادی → عدم انتشار + ثبت دلیل
 *  • مرجع قطع → advisory (انتشار ادامه دارد)
 *  • قفل مشورتی ارسال و گارد اجرای تکراری گزارش
 *
 * fetch مسیریابی‌شده با URL: تلگرام → رفتار recorder؛ TGJU/Wallex → JSON مرجع.
 */

const CFG: CrossCheckConfig = crossCheckConfigFromEnv(
  makeEnv() satisfies Parameters<typeof crossCheckConfigFromEnv>[0],
);

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** snapshot نمونهٔ TGJU — قیمتها «ریالی» با کاما + ts تهران */
function tgjuBody(overrides: Record<string, { p: string; ts: string }> = {}): unknown {
  const current: Record<string, { p: string; ts: string }> = {
    price_dollar_rl: { p: "2,651,000", ts: "2026-10-10 00:00:00" },
    crypto_tether_dummy: { p: "1", ts: "2026-10-10 00:00:00" },
    geram18: { p: "264,961,000", ts: "2026-10-10 00:00:00" },
    sekee: { p: "2,693,100,000", ts: "2026-10-10 00:00:00" },
    ...overrides,
  };
  return { current };
}

function wallexBody(ask: number, bid: number): unknown {
  return {
    result: {
      ask: [{ price: ask, quantity: 10 }],
      bid: [{ price: bid, quantity: 10 }],
    },
  };
}

/** مسیریاب fetch تست: تلگرام → recorder؛ tgju/wallex → پاسخ قابل تنظیم */
function routedFetch(
  recorderFetch: typeof fetch,
  refs: { tgju?: Response; wallex?: Response },
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) return recorderFetch(url, init);
    if (u.includes("tgju")) return refs.tgju ?? jsonRes(tgjuBody());
    if (u.includes("wallex")) return refs.wallex ?? jsonRes(wallexBody(264300, 264297));
    throw new Error(`unexpected url: ${u}`);
  }) as typeof fetch;
}

const FIXED_NOW = () => new Date("2026-10-11T08:00:00.000Z");

// ---------- snapshot TGJU ----------

describe("fetchTgjuSnapshot — parse و واحد", () => {
  it("قیمت ریالی با کاما → تومان (÷۱۰) و مهر زمانی ISO تهران", async () => {
    const snap = await fetchTgjuSnapshot(
      TGJU_DEFAULT_URL,
      routedFetch(telegramRecorder().fetchFn, {}),
      FIXED_NOW,
    );
    expect(snap).not.toBeNull();
    // 2,651,000 ریال → 265,100 تومان
    expect(snap?.get("price_dollar_rl")?.value).toBe(265_100);
    // 2026-10-10 00:00:00 تهران → 2026-09-30... نه: 2026-10-09T20:30:00Z
    expect(snap?.get("price_dollar_rl")?.ts).toBe("2026-10-09T20:30:00.000Z");
  });

  it("نماد با مهر کهنه (>۷۲h) از مرجع حذف میشود (کل snapshot نمیپرد)", async () => {
    const snap = await fetchTgjuSnapshot(
      TGJU_DEFAULT_URL,
      routedFetch(telegramRecorder().fetchFn, {
        tgju: jsonRes(
          tgjuBody({ price_dollar_rl: { p: "2,651,000", ts: "2026-10-01 00:00:00" } }),
        ),
      }),
      FIXED_NOW,
    );
    expect(snap?.has("price_dollar_rl")).toBe(false);
    expect(snap?.has("geram18")).toBe(true);
  });

  it("payload بدون current → null", async () => {
    const snap = await fetchTgjuSnapshot(
      TGJU_DEFAULT_URL,
      routedFetch(telegramRecorder().fetchFn, { tgju: jsonRes({ ok: true }) }),
      FIXED_NOW,
    );
    expect(snap).toBeNull();
  });

  it("HTTP خطا / HTML → null (مرجع در دسترس نیست)", async () => {
    for (const bad of [
      new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
      new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]) {
      const snap = await fetchTgjuSnapshot(
        TGJU_DEFAULT_URL,
        routedFetch(telegramRecorder().fetchFn, { tgju: bad }),
        FIXED_NOW,
      );
      expect(snap).toBeNull();
    }
  });

  it("قیمت نامعتبر (رشته/صفر/منفی) از snapshot حذف میشود", async () => {
    const snap = await fetchTgjuSnapshot(
      TGJU_DEFAULT_URL,
      routedFetch(telegramRecorder().fetchFn, {
        tgju: jsonRes(
          tgjuBody({
            price_dollar_rl: { p: "not-a-number", ts: "2026-10-10 00:00:00" },
          }),
        ),
      }),
      FIXED_NOW,
    );
    expect(snap?.has("price_dollar_rl")).toBe(false);
  });
});

// ---------- Wallex ----------

describe("fetchWallexUsdtToman — دفتر سفارش", () => {
  it("میانگین best bid/ask → تومان", async () => {
    const q = await fetchWallexUsdtToman(
      WALLEX_DEPTH_DEFAULT_URL,
      routedFetch(telegramRecorder().fetchFn, {}),
    );
    expect(q?.value).toBe(264_299); // (264300+264297)/2 → گرد
  });

  it("دفتر معکوس (bid>ask) → null (دادهٔ خراب)", async () => {
    const q = await fetchWallexUsdtToman(
      WALLEX_DEPTH_DEFAULT_URL,
      routedFetch(telegramRecorder().fetchFn, {
        wallex: jsonRes(wallexBody(264_200, 264_900)),
      }),
    );
    expect(q).toBeNull();
  });

  it("payload بدون ask/bid → null", async () => {
    const q = await fetchWallexUsdtToman(
      WALLEX_DEPTH_DEFAULT_URL,
      routedFetch(telegramRecorder().fetchFn, { wallex: jsonRes({ result: {} }) }),
    );
    expect(q).toBeNull();
  });
});

// ---------- مقایسه و آستانه ----------

describe("compareWithReference — آستانهٔ قابل‌تنظیم", () => {
  it("مرجع غایب → reference-unavailable (advisory)", () => {
    const out = compareWithReference(265_100, null, 2.5);
    expect(out.verdict).toBe("reference-unavailable");
    expect(out.diffPct).toBeNull();
  });

  it("اختلاف داخل آستانه → match (حتی نزدیک مرز)", () => {
    // +2.49% با آستانه 2.5
    const ref = { value: 265_100, ts: null };
    expect(compareWithReference(265_100 * 1.0249, ref, 2.5).verdict).toBe("match");
  });

  it("اختلاف بیرون آستانه → diverged با درصد علامت‌دار", () => {
    const ref = { value: 265_100, ts: null };
    const out = compareWithReference(265_100 * 1.03, ref, 2.5);
    expect(out.verdict).toBe("diverged");
    expect(out.diffPct).toBeCloseTo(3, 0);
  });

  it("خطای ۱۰ برابری واحد (ریال/تومان) → diverged (+900%)", () => {
    const ref = { value: 265_100, ts: null };
    const out = compareWithReference(2_651_000, ref, 2.5);
    expect(out.verdict).toBe("diverged");
    expect(out.diffPct).toBe(900);
  });

  it("آستانه بر اساس نوع بازار: ارز/طلا/تتر", () => {
    expect(tolerancePctFor("usd", CFG)).toBe(CFG.fxTolerancePct);
    expect(tolerancePctFor("gold18k", CFG)).toBe(CFG.goldTolerancePct);
    expect(tolerancePctFor("emami", CFG)).toBe(CFG.goldTolerancePct);
    expect(tolerancePctFor("usdt", CFG)).toBe(CFG.tetherTolerancePct);
  });
});

// ---------- crossCheckReportItems ----------

describe("crossCheckReportItems — گزارش", () => {
  const items = [
    { symbol: "usd" as const, value: 265_100 },
    { symbol: "usdt" as const, value: 265_250 },
    { symbol: "emami" as const, value: 269_310_000 },
    { symbol: "eur" as const, value: 298_310 },
    { symbol: "ounce" as const, value: 4193.87 },
  ];

  it("همخوانی کامل → هیچ حذفی؛ ounce بدون چک باقی میماند", async () => {
    const out = await crossCheckReportItems(
      CFG,
      items,
      routedFetch(telegramRecorder().fetchFn, {
        tgju: jsonRes(
          tgjuBody({
            price_eur: { p: "2,983,100", ts: "2026-10-10 00:00:00" },
          }),
        ),
        wallex: jsonRes(wallexBody(265_250, 265_250)),
      }),
      FIXED_NOW,
    );
    expect(out.dropped).toEqual([]);
    expect(out.items).toHaveLength(items.length);
    expect(out.tgjuAvailable).toBe(true);
    expect(out.wallexAvailable).toBe(true);
  });

  it("اختلاف غیرعادی → آیتم diverged حذف (نه جایگزینی)", async () => {
    const out = await crossCheckReportItems(
      CFG,
      items,
      routedFetch(telegramRecorder().fetchFn, {
        tgju: jsonRes(
          tgjuBody({
            // دلار ۳۰٪ دورتر — diverged قطعی
            price_dollar_rl: { p: "3,600,000", ts: "2026-10-10 00:00:00" },
          }),
        ),
      }),
      FIXED_NOW,
    );
    expect(out.dropped).toContain("usd");
    expect(out.items.map((i) => i.symbol)).not.toContain("usd");
    // سایر آیتمها باقیاند
    expect(out.items.map((i) => i.symbol)).toContain("emami");
  });

  it("تتر diverged از Wallex → حذف", async () => {
    const out = await crossCheckReportItems(
      CFG,
      items,
      routedFetch(telegramRecorder().fetchFn, {
        wallex: jsonRes(wallexBody(300_000, 300_000)), // ~13% دور
      }),
      FIXED_NOW,
    );
    expect(out.dropped).toContain("usdt");
  });

  it("مرجع غایب → تتر حذف (fail-closed)؛ سایر آیتمها بدون حذف (advisory)", async () => {
    const out = await crossCheckReportItems(
      CFG,
      items,
      routedFetch(telegramRecorder().fetchFn, {
        tgju: jsonRes({ ok: true }),
        wallex: jsonRes({ result: {} }),
      }),
      FIXED_NOW,
    );
    // دستور مالک (۲۰۲۶-۱۰-۱۱): تتر بدون مرجع Wallex معتبر منتشر نمیشود
    expect(out.dropped).toEqual(["usdt"]);
    expect(out.tgjuAvailable).toBe(false);
    expect(out.wallexAvailable).toBe(false);
    expect(out.items.map((i) => i.symbol)).not.toContain("usdt");
    // قطع مرجع TGJU: سایر آیتمها حذف نمیشوند (advisory)
    expect(out.items.map((i) => i.symbol)).toContain("usd");
    expect(out.items.map((i) => i.symbol)).toContain("emami");
  });

  it("config غیرفعال → بدون هیچ fetch", async () => {
    let fetched = 0;
    const counting = (async () => {
      fetched += 1;
      return jsonRes({});
    }) as typeof fetch;
    const out = await crossCheckReportItems(
      { ...CFG, enabled: false },
      items,
      counting,
      FIXED_NOW,
    );
    expect(fetched).toBe(0);
    expect(out.items).toHaveLength(items.length);
  });
});

// ---------- usd-job: ادغام چک در انتشار ----------

const USER_REPORT: MarketReport = {
  items: [
    { symbol: "usd", value: 266_200, unit: "toman" },
    { symbol: "usdt", value: 266_350, unit: "toman" },
    { symbol: "eur", value: 299_010, unit: "toman" },
  ],
  fetchedAt: new Date().toISOString(),
  source: "fake-single",
  dataDate: new Date().toISOString(),
};

describe("runUsdRefresh — اعتبارسنجی متقاطع در انتشار", () => {
  it("دلار diverged → عدم انتشار کل پیام + دلیل در status (invalid)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const routed = routedFetch(fetchFn, {
      // مرجع ۳۰٪ دورتر → diverged قطعی
      tgju: jsonRes(
        tgjuBody({ price_dollar_rl: { p: "3,600,000", ts: "2026-10-10 00:00:00" } }),
      ),
    });
    const result = await runUsdRefresh(env, {
      fetchFn: routed,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("invalid");
    expect(String(result.reason)).toContain("CROSS_CHECK_DIVERGENCE_USD");
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(0);
    expect(kv.store.has(PIN_TEXT_KEY)).toBe(false);
    expect(kv.store.has(PIN_DATA_KEY)).toBe(false);
  });

  it("تتر diverged → پیام دلار بدون خط تتر منتشر میشود (خط مشکوک حذف)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const routed = routedFetch(fetchFn, {
      wallex: jsonRes(wallexBody(300_000, 300_000)), // تتر ~13% دور
    });
    const result = await runUsdRefresh(env, {
      fetchFn: routed,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("TETHER_OMITTED_CROSS_CHECK");
    const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.body.text)).toContain("<b>266,200</b> معامله");
    expect(String(sent[0]?.body.text)).not.toContain("قیمت تتر");
    // pin data بدون tether ذخیره شد (نرخ مشکوک کش هم نمیشود)
    const pinData = JSON.parse(kv.store.get(PIN_DATA_KEY) ?? "{}");
    expect(pinData.tether).toBeUndefined();
  });

  it("قطع Wallex → خط تتر منتشر نمیشود (fail-closed)؛ دلار با مرجع سالم منتشر میشود", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const routed = routedFetch(fetchFn, {
      wallex: new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    });
    const result = await runUsdRefresh(env, {
      fetchFn: routed,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("TETHER_OMITTED_NO_REFERENCE");
    const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    const text = String(sent[0]?.body.text);
    expect(text).toContain("<b>266,200</b> معامله");
    expect(text).not.toContain("قیمت تتر"); // تتر بدون مرجع مستقل: حذف خط
    // مقدار قبلی تتر هم «نرخ تازه» نمایش داده نشد — pin data بدون tether
    const pinData = JSON.parse(kv.store.get(PIN_DATA_KEY) ?? "{}");
    expect(pinData.tether).toBeUndefined();
  });

  it("قطع TGJU → دلار advisory منتشر میشود + تتر با Wallex سالم؛ قطع مرجع فقط در لاگ/KV", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const routed = routedFetch(fetchFn, {
      tgju: new Response("service unavailable", { status: 503, headers: { "content-type": "text/plain" } }),
      wallex: jsonRes(wallexBody(266_350, 266_350)), // مرجع تتر سالم
    });
    const result = await runUsdRefresh(env, {
      fetchFn: routed,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("CROSS_CHECK_ADVISORY_TGJU_DOWN");
    const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    const text = String(sent[0]?.body.text);
    expect(text).toContain("<b>266,200</b> معامله");
    expect(text).toContain("<b>266,350 تومان</b>"); // تتر با مرجع معتبر منتشر شد
    // متن فنی/داخلی هرگز در پیام عمومی نیست
    expect(text).not.toContain("مرجع");
    expect(text).not.toContain("تأییدنشده");
    expect(text).not.toContain("خطا");
  });

  it("دادهٔ بی‌تغییر (UNCHANGED) → هیچ fetch مرجعی انجام نمیشود (صرفهٔ درخواست)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    let refFetches = 0;
    const counting = routedFetch(fetchFn, {
      tgju: ((): Response => {
        refFetches += 1;
        return jsonRes(tgjuBody());
      })(),
    });
    // اجرای اول: انتشار (چک فعال — ۱ fetch مرجع)
    await runUsdRefresh(env, {
      fetchFn: counting,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    const afterFirst = refFetches;
    // اجرای دوم با همان داده: UNCHANGED → بدون fetch مرجع
    const result = await runUsdRefresh(env, {
      fetchFn: counting,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("UNCHANGED");
    expect(refFetches).toBe(afterFirst);
  });
});

// ---------- usd-job: قفل مشورتی ارسال ----------

describe("runUsdRefresh — قفل ارسال (ضد اجرای هم‌زمان)", () => {
  it("قفل فعال → suppressed؛ هیچ sendMessage ای رفت و قفل دست‌نخورده ماند", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await kv.put(USD_SEND_LOCK_KEY, "1", { expirationTtl: 60 });
    const result = await runUsdRefresh(env, {
      fetchFn,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(result.status).toBe("suppressed");
    expect(result.reason).toBe("DUPLICATE_RUN_LOCKED");
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(0);
    expect(kv.store.has(USD_SEND_LOCK_KEY)).toBe(true);
    expect(kv.store.has(USD_MESSAGE_ID_KEY)).toBe(false);
  });

  it("ارسال موفق → قفل آزاد میشود (TTL پشتیبان)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await runUsdRefresh(env, {
      fetchFn,
      provider: fakeProvider(null, USER_REPORT),
      marketHours: alwaysOpenMarketHours(),
    });
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(1);
    expect(kv.store.has(USD_SEND_LOCK_KEY)).toBe(false);
    expect(kv.store.has(USD_MESSAGE_ID_KEY)).toBe(true);
  });
});

// ---------- report-job: گارد اجرای تکراری ----------

describe("runMarketReport — گارد اجرای تکراری", () => {
  it("ارسال موفقِ تازه (< ۳۰ دقیقه) → suppressed بدون fetch/ارسال", async () => {
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await kv.put(
      REPORT_STATUS_KEY,
      JSON.stringify({ at: "2025-10-08T09:45:00Z", status: "ok" }),
    );
    const { calls, fetchFn } = telegramRecorder();
    const result = await runMarketReport(env, {
      fetchFn,
      now: () => new Date("2025-10-08T10:00:00Z"),
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(null, USER_REPORT),
    });
    expect(result.status).toBe("suppressed");
    expect(result.reason).toBe("DUPLICATE_RUN_SUPPRESSED");
    expect(calls).toHaveLength(0);
  });

  it("ارسال موفقِ قدیمی (> ۳۰ دقیقه) → اجرای عادی", async () => {
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await kv.put(
      REPORT_STATUS_KEY,
      JSON.stringify({ at: "2025-10-08T09:00:00Z", status: "ok" }),
    );
    const { calls, fetchFn } = telegramRecorder();
    const result = await runMarketReport(env, {
      fetchFn,
      now: () => new Date("2025-10-08T10:00:00Z"),
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(null, USER_REPORT),
    });
    expect(result.status).toBe("ok");
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(1);
  });

  it("زنجیرهٔ اجرای تکراری: suppressed تازه هم گارد را فعال نگه میدارد", async () => {
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    // اجرای تکراری اول (suppressed) ۱۰ دقیقه پیش — ok اصلی ۱۵ دقیقه پیش
    await kv.put(
      REPORT_STATUS_KEY,
      JSON.stringify({ at: "2025-10-08T09:50:00Z", status: "suppressed" }),
    );
    const { calls, fetchFn } = telegramRecorder();
    const result = await runMarketReport(env, {
      fetchFn,
      now: () => new Date("2025-10-08T10:00:00Z"),
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(null, USER_REPORT),
    });
    expect(result.status).toBe("suppressed");
    expect(result.reason).toBe("DUPLICATE_RUN_SUPPRESSED");
    expect(calls).toHaveLength(0);
  });

  it("status خراب/بدون at → گارد نادیده گرفته میشود (fail-open عمدی)", async () => {
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    await kv.put(REPORT_STATUS_KEY, "{corrupt json");
    const { calls, fetchFn } = telegramRecorder();
    const result = await runMarketReport(env, {
      fetchFn,
      now: () => new Date("2025-10-08T10:00:00Z"),
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(null, USER_REPORT),
    });
    expect(result.status).toBe("ok");
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(1);
  });
});

// ---------- report-job: حذف آیتم diverged ----------

describe("runMarketReport — اعتبارسنجی متقاطع گزارش", () => {
  it("آیتم diverged از گزارش حذف و دلیل در status ثبت میشود", async () => {
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const report: MarketReport = {
      fetchedAt: "2026-10-11T07:30:00Z",
      source: "test",
      dataDate: "2026-10-10T00:00:00Z",
      items: [
        { symbol: "usd", value: 265_100, unit: "toman" },
        { symbol: "emami", value: 269_310_000, unit: "toman" },
      ],
    };
    const routed = routedFetch(fetchFn, {
      tgju: jsonRes(
        tgjuBody({
          // دلار سالم؛ امامی ۲۵٪ دور → حذف
          sekee: { p: "3,600,000,000", ts: "2026-10-10 00:00:00" },
        }),
      ),
    });
    const result = await runMarketReport(env, {
      fetchFn: routed,
      now: FIXED_NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(null, report),
    });
    expect(result.status).toBe("ok");
    expect(String(result.reason)).toContain("CROSS_CHECK_OMITTED");
    expect(String(result.reason)).toContain("emami");
    const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sent).toHaveLength(1);
    const text = String(sent[0]?.body.text);
    expect(text).toContain("دلار");
    expect(text).not.toContain("سکه امامی");
  });

  it("همهٔ آیتمها diverged → عدم انتشار (CROSS_CHECK_ALL_DROPPED)", async () => {
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const { calls, fetchFn } = telegramRecorder();
    const report: MarketReport = {
      fetchedAt: "2026-10-11T07:30:00Z",
      source: "test",
      items: [{ symbol: "usd", value: 500_000, unit: "toman" }],
    };
    const routed = routedFetch(fetchFn, {
      tgju: jsonRes(tgjuBody()), // مرجع 265,100 — اختلاف ~۸۸٪
    });
    const result = await runMarketReport(env, {
      fetchFn: routed,
      now: FIXED_NOW,
      marketHours: alwaysOpenMarketHours(),
      provider: fakeProvider(null, report),
    });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("CROSS_CHECK_ALL_DROPPED");
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(0);
  });
});

// ---------- نگاشت نمادها ----------

describe("TGJU_SYMBOL_MAP — پوشش نمادهای انتشار", () => {
  it("همهٔ نمادهای تومانی گزارش (بهجز ounce) مرجع TGJU دارند", () => {
    for (const key of ["usd", "usdt", "eur", "gbp", "try", "aed", "gold18k", "gold24k", "mesghal", "emami", "bahar", "halfCoin", "quarterCoin", "germi"] as const) {
      expect(TGJU_SYMBOL_MAP[key], `missing mapping for ${key}`).toBeTruthy();
    }
    expect(TGJU_SYMBOL_MAP.ounce).toBeUndefined();
  });
});
