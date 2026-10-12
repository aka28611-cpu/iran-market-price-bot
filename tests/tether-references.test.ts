import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiterForTests } from "../src/ratelimit";
import { parseEnv } from "../src/env";
import { runUsdRefresh } from "../src/scheduler/usd-job";
import { runMarketReport } from "../src/scheduler/report-job";
import {
  REF_HEALTH_KEY,
  USD_MESSAGE_ID_KEY,
  buildRefHealthSnapshot,
  writeRefHealthIfDue,
  type RefHealthSnapshot,
} from "../src/state";
import type { MarketReport } from "../src/types";
import {
  collectTetherReferences,
  evaluateTetherReferences,
  median,
  type TetherSourceOutcome,
} from "../src/providers/tether-references";
import { crossCheckReportItems } from "../src/providers/cross-check";
import {
  alwaysOpenMarketHours,
  makeEnv,
  makeRawEnv,
  MockKV,
  telegramRecorder,
  fakeProvider,
} from "./helpers";

/**
 * مأموریت ۲۹ — اعتبارسنجی چندمنبعی تتر (مرحلهٔ ۶):
 *  • آداپتورهای Wallex/Ramzinex/Nobitex — parse معتبر، رد ساختار/واحد/قدیمی
 *  • خرابی مستقل (403/timeout/5xx/JSON خراب) — یک منبع، بقیه سالم
 *  • موتور: میانهٔ مقاوم، حذف outlier، قاعدهٔ اجماع، مبدأ مستقل، تک‌مرجع
 *  •統 integration: انتشار تتر با مرجع غیرWallex، حذف بدون مرجع/اجماع
 *  • سلامت KV (تجمعی ۳۰ دقیقه + merge آخرین موفقیت/خطا)
 *  • env: فهرست منابع ناشناخته = خطای بلند
 */

const CFG = {
  enabled: true,
  tetherSources: ["wallex", "ramzinex", "nobitex"] as const,
  wallexUrl: "https://api.wallex.ir/v1/depth?symbol=USDTTMN",
  ramzinexUrl:
    "https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs/11",
  nobitexUrl:
    "https://api.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls",
  tetherTolerancePct: 3,
};

const NOW = () => new Date("2026-10-12T06:00:00.000Z");

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------- payloads واقعی-شکل (ساختار ممیزی ۲۰۲۶-10-12) ----------

const WALLEX_OK = {
  result: {
    ask: [{ price: 264_130, quantity: 1 }],
    bid: [{ price: 264_127, quantity: 1 }],
  },
};

const RAMZINEX_OK = {
  data: {
    pair_id: 11,
    base_currency_symbol: { en: "usdt", fa: "تتر" },
    quote_currency_symbol: { en: "irr", fa: "ریال" },
    is_delist: 0,
    is_temporarily_suspended: 0,
    buy: 2_641_011,
    sell: 2_644_000,
  },
};

function nobitexOk(opts: {
  isStatsAt?: number;
  bestBuy?: number;
  bestSell?: number;
  isClosed?: boolean;
} = {}): unknown {
  const tsSec =
    opts.isStatsAt ?? Math.floor(NOW().getTime() / 1000) - 300; // ۵ دقیقه پیش
  return {
    status: "ok",
    stats: {
      "usdt-rls": {
        isClosed: opts.isClosed ?? false,
        bestBuy: String(opts.bestBuy ?? 2_640_000),
        bestSell: String(opts.bestSell ?? 2_644_100),
        latest: "2642100",
        isStatsAt: tsSec,
      },
    },
  };
}

/** مسیریاب multi-source: هر منبع پاسخ مستقل خودش را میگیرد */
function multiSourceFetch(
  recorderFetch: typeof fetch,
  refs: {
    wallex?: Response;
    ramzinex?: Response;
    nobitex?: Response;
    tgju?: Response;
  },
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) return recorderFetch(url, init);
    if (u.includes("tgju")) {
      const today = NOW().toISOString().slice(0, 10);
      return (
        refs.tgju ??
        jsonRes({
          current: {
            price_dollar_rl: { p: "2,662,000", ts: `${today} 00:00:00` },
          },
        })
      );
    }
    if (u.includes("wallex")) return refs.wallex ?? jsonRes(WALLEX_OK);
    if (u.includes("ramzinex")) return refs.ramzinex ?? jsonRes(RAMZINEX_OK);
    if (u.includes("nobitex")) return refs.nobitex ?? jsonRes(nobitexOk());
    throw new Error(`unexpected url: ${u}`);
  }) as typeof fetch;
}

const REPORT_WITH_TETHER: MarketReport = {
  items: [
    { symbol: "usd", value: 266_200, unit: "toman" },
    { symbol: "usdt", value: 266_350, unit: "toman" },
  ],
  fetchedAt: NOW().toISOString(),
  source: "fake-m29",
  dataDate: NOW().toISOString(),
};

// ---------- median ----------

describe("median — میانهٔ مقاوم", () => {
  it("فرد: عضو میانی", () => {
    expect(median([10, 30, 20])).toBe(20);
  });
  it("زوج: میانگین دو عضو وسط", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });
  it("خالی → null", () => {
    expect(median([])).toBeNull();
  });
});

// ---------- آداپتورها ----------

describe("آداپتور Wallex (depth USDTTMN)", () => {
  it("دفتر سالم → mid تومان، ts=null (زنده)", async () => {
    const [out] = (await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {}),
      NOW,
    )) as [TetherSourceOutcome];
    expect(out.source).toBe("wallex");
    expect(out.quote).not.toBeNull();
    expect(out.quote?.valueToman).toBe(264_129); // (264130+264127)/2
    expect(out.quote?.dataTs).toBeNull();
    expect(out.quote?.unitSource).toBe("toman");
    expect(out.error).toBeNull();
  });
  it("۴۰۳ (رفتار واقعی egress Workers) → خرابی مستقل، quote=null", async () => {
    const [out] = (await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        wallex: new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } }),
      }),
      NOW,
    )) as [TetherSourceOutcome];
    expect(out.quote).toBeNull();
    expect(out.error).toBe("HTTP_403");
  });
  it("دفتر معکوس (bid>ask) → CROSSED_BOOK", async () => {
    const [out] = (await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        wallex: jsonRes({ result: { ask: [{ price: 100 }], bid: [{ price: 200 }] } }),
      }),
      NOW,
    )) as [TetherSourceOutcome];
    expect(out.quote).toBeNull();
    expect(out.error).toBe("CROSSED_BOOK");
  });
  it("JSON خراب → NON_JSON / INVALID_PAYLOAD، نه crash", async () => {
    const [out] = (await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        wallex: new Response("<html>err</html>", { status: 200, headers: { "content-type": "text/html" } }),
      }),
      NOW,
    )) as [TetherSourceOutcome];
    expect(out.quote).toBeNull();
    expect(out.error).toBe("NON_JSON");
  });
});

describe("آداپتور Ramzinex (pairs/11)", () => {
  it("میز سالم ریال → تومان (÷۱۰)، ts=null، خودتأییدی usdt/irr", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {}),
      NOW,
    );
    const rx = outcomes.find((o) => o.source === "ramzinex");
    expect(rx?.quote).not.toBeNull();
    expect(rx?.quote?.valueToman).toBe(264_251); // (2641011+2644000)/2/10
    expect(rx?.quote?.unitSource).toBe("rial");
    expect(rx?.quote?.dataTs).toBeNull();
    expect(rx?.quote?.rateType).toBe("desk-mid");
  });
  it("جفت اشتباه (base != usdt) → PAIR_MISMATCH (محافظت تغییر pair_id)", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        ramzinex: jsonRes({ data: { ...RAMZINEX_OK.data, base_currency_symbol: { en: "btc" } } }),
      }),
      NOW,
    );
    const rx = outcomes.find((o) => o.source === "ramzinex");
    expect(rx?.quote).toBeNull();
    expect(rx?.error).toBe("PAIR_MISMATCH");
  });
  it("واحد مبهم (quote=irt) → UNIT_UNKNOWN — حدس واحد ممنوع", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        ramzinex: jsonRes({ data: { ...RAMZINEX_OK.data, quote_currency_symbol: { en: "irt" } } }),
      }),
      NOW,
    );
    const rx = outcomes.find((o) => o.source === "ramzinex");
    expect(rx?.quote).toBeNull();
    expect(rx?.error).toBe("UNIT_UNKNOWN");
  });
  it("بازار معلق → SUSPENDED", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        ramzinex: jsonRes({ data: { ...RAMZINEX_OK.data, is_temporarily_suspended: 1 } }),
      }),
      NOW,
    );
    expect(outcomes.find((o) => o.source === "ramzinex")?.error).toBe("SUSPENDED");
  });
  it("میز معکوس (buy>sell) → CROSSED_DESK", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        ramzinex: jsonRes({ data: { ...RAMZINEX_OK.data, buy: 3_000_000, sell: 2_000_000 } }),
      }),
      NOW,
    );
    expect(outcomes.find((o) => o.source === "ramzinex")?.error).toBe("CROSSED_DESK");
  });
  it("مagnitude نامعقول → IMPLAUSIBLE", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        ramzinex: jsonRes({ data: { ...RAMZINEX_OK.data, buy: 500, sell: 600 } }),
      }),
      NOW,
    );
    expect(outcomes.find((o) => o.source === "ramzinex")?.error).toBe("IMPLAUSIBLE");
  });
  it("۵xx → خرابی مستقل", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        ramzinex: new Response("boom", { status: 502, headers: { "content-type": "text/plain" } }),
      }),
      NOW,
    );
    expect(outcomes.find((o) => o.source === "ramzinex")?.error).toBe("HTTP_502");
  });
});

describe("آداپتور Nobitex (market/stats usdt-rls)", () => {
  it("آمار سالم + isStatsAt تازه → mid ریال→تومان، ts=ISO", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {}),
      NOW,
    );
    const nb = outcomes.find((o) => o.source === "nobitex");
    expect(nb?.quote).not.toBeNull();
    expect(nb?.quote?.valueToman).toBe(264_205); // (2640000+2644100)/2/10
    expect(nb?.quote?.dataTs).toBeTypeOf("string");
    expect(nb?.quote?.unitSource).toBe("rial");
  });
  it("isStatsAt غایب → NO_VALID_TS (مهر الزامی)", async () => {
    const body = {
      status: "ok",
      stats: { "usdt-rls": { bestBuy: "2640000", bestSell: "2644100" } },
    };
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, { nobitex: jsonRes(body) }),
      NOW,
    );
    expect(outcomes.find((o) => o.source === "nobitex")?.error).toBe("NO_VALID_TS");
  });
  it("آمار کهنه (۳ ساعت) → STALE_STATS", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        nobitex: jsonRes(nobitexOk({ isStatsAt: Math.floor(NOW().getTime() / 1000) - 3 * 3600 })),
      }),
      NOW,
    );
    expect(outcomes.find((o) => o.source === "nobitex")?.error).toBe("STALE_STATS");
  });
  it("isClosed=true → MARKET_CLOSED (آمار فریزشده مرجع نیست)", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        nobitex: jsonRes(nobitexOk({ isClosed: true })),
      }),
      NOW,
    );
    expect(outcomes.find((o) => o.source === "nobitex")?.error).toBe("MARKET_CLOSED");
  });
  it("کلید ساختاری غلط → INVALID_PAYLOAD (بدون حدس واحد)", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        nobitex: jsonRes({ status: "ok", stats: { "usdt-irt": { isStatsAt: 1 } } }),
      }),
      NOW,
    );
    expect(outcomes.find((o) => o.source === "nobitex")?.error).toBe("INVALID_PAYLOAD");
  });
  it("isStatsAt بر حسب میلیثانیه هم پذیرفته میشود", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        nobitex: jsonRes(nobitexOk({ isStatsAt: NOW().getTime() - 60_000 })),
      }),
      NOW,
    );
    expect(outcomes.find((o) => o.source === "nobitex")?.quote).not.toBeNull();
  });
});

// ---------- جمعآوری موازی + خرابی مستقل ----------

describe("collectTetherReferences — فهرست و خرابی مستقل", () => {
  it("فهرست محدود به wallex فقط → یک outcome", async () => {
    const outcomes = await collectTetherReferences(
      { ...CFG, tetherSources: ["wallex"] },
      multiSourceFetch(telegramRecorder().fetchFn, {}),
      NOW,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.source).toBe("wallex");
  });
  it("Wallex ۴۰۳ + Ramzinex/Nobitex سالم → دو مرجع معتبر باقی", async () => {
    const outcomes = await collectTetherReferences(
      CFG,
      multiSourceFetch(telegramRecorder().fetchFn, {
        wallex: new Response("f", { status: 403, headers: { "content-type": "text/plain" } }),
      }),
      NOW,
    );
    expect(outcomes).toHaveLength(3);
    expect(outcomes.find((o) => o.source === "wallex")?.quote).toBeNull();
    const valid = outcomes.filter((o) => o.quote !== null);
    expect(valid).toHaveLength(2);
    expect(new Set(valid.map((o) => o.origin)).size).toBe(2);
  });
});

// ---------- موتور اعتبارسنجی ----------

function outcome(
  source: string,
  origin: string,
  value: number | null,
): TetherSourceOutcome {
  return {
    source: source as TetherSourceOutcome["source"],
    origin,
    quote:
      value === null
        ? null
        : {
            source: source as TetherSourceOutcome["source"],
            origin,
            asset: "usdt",
            valueToman: value,
            dataTs: null,
            observedAt: NOW().toISOString(),
            rateType: "desk-mid",
            unitSource: "toman",
          },
    latencyMs: 10,
    error: value === null ? "HTTP_403" : null,
  };
}

describe("evaluateTetherReferences — موتور چندمنبعی", () => {
  it("صفر مرجع → NO_REFERENCE (fail-closed)", () => {
    const v = evaluateTetherReferences(266_350, [], 3);
    expect(v.publish).toBe(false);
    expect(v.reason).toBe("NO_REFERENCE");
  });
  it("primary null → NO_REFERENCE", () => {
    const v = evaluateTetherReferences(
      null,
      [outcome("wallex", "wallex", 264_129)],
      3,
    );
    expect(v.publish).toBe(false);
    expect(v.reason).toBe("NO_REFERENCE");
  });
  it("تک‌مرجع + داخل آستانه → انتشار + پرچم singleReference", () => {
    const v = evaluateTetherReferences(
      264_000,
      [outcome("wallex", "wallex", 264_129)],
      3,
    );
    expect(v.publish).toBe(true);
    expect(v.singleReference).toBe(true);
    expect(v.reference).toBe(264_129);
    expect(v.validSources).toBe(1);
  });
  it("تک‌مرجع + واگرایی > آستانه → DIVERGED (حذف خط)", () => {
    const v = evaluateTetherReferences(
      264_000,
      [outcome("wallex", "wallex", 300_000)],
      3,
    );
    expect(v.publish).toBe(false);
    expect(v.reason).toBe("DIVERGED");
  });
  it("سه مرجع با یک outlier ۳۰٪ → outlier حذف؛ میانه از دو سالم", () => {
    const v = evaluateTetherReferences(
      264_000,
      [
        outcome("wallex", "wallex", 264_129),
        outcome("ramzinex", "ramzinex", 264_251),
        outcome("nobitex", "nobitex", 340_000),
      ],
      3,
    );
    expect(v.outliersDropped).toEqual(["nobitex"]);
    expect(v.publish).toBe(true);
    expect(v.reference).toBe(264_190); // میانگین دو سالم
    expect(v.originCount).toBe(2);
  });
  it("دو مرجع ۳۰٪ ناسازگار → NO_CONSENSUS (بی‌اعتمادی کاذب ممنوع)", () => {
    const v = evaluateTetherReferences(
      264_000,
      [outcome("wallex", "wallex", 264_000), outcome("ramzinex", "ramzinex", 343_000)],
      3,
    );
    expect(v.publish).toBe(false);
    expect(v.reason).toBe("NO_CONSENSUS");
  });
  it("دو مرجع نزدیک (۱٪) → اجماع + انتشار", () => {
    const v = evaluateTetherReferences(
      264_000,
      [outcome("wallex", "wallex", 264_000), outcome("ramzinex", "ramzinex", 266_600)],
      3,
    );
    expect(v.publish).toBe(true);
    expect(v.reference).toBe(265_300);
  });
  it("ردیابی مبدأ: دو نرخ هم‌مبدأ = یک تأیید مستقل", () => {
    // دو outcome با origin یکسان (مثل آینهٔ یک بالادست) → originCount=1
    const v = evaluateTetherReferences(
      264_000,
      [outcome("wallex", "tgju-family", 264_000), outcome("ramzinex", "tgju-family", 264_200)],
      3,
    );
    expect(v.publish).toBe(true);
    expect(v.originCount).toBe(1);
    expect(v.singleReference).toBe(true);
  });
});

// ---------- سلامت KV ----------

describe("سلامت منابع در KV (تجمعی + merge)", () => {
  it("snapshot اول: موفق → lastSuccessAt ثبت", () => {
    const snap = buildRefHealthSnapshot(
      null,
      [outcome("wallex", "wallex", 264_129)],
      NOW(),
    );
    expect(snap.tether.wallex?.status).toBe("ok");
    expect(snap.tether.wallex?.lastSuccessAt).toBe(NOW().toISOString());
  });
  it("merge: خطای جدید، موفقیت قبلی حفظ میشود", () => {
    const prev: RefHealthSnapshot = {
      at: "2026-10-12T05:00:00Z",
      tether: {
        wallex: {
          status: "ok",
          valueToman: 264_129,
          lastSuccessAt: "2026-10-12T05:00:00Z",
        },
      },
    };
    const snap = buildRefHealthSnapshot(
      prev,
      [outcome("wallex", "wallex", null)],
      NOW(),
    );
    expect(snap.tether.wallex?.status).toBe("error");
    expect(snap.tether.wallex?.lastError).toBe("HTTP_403");
    expect(snap.tether.wallex?.lastSuccessAt).toBe("2026-10-12T05:00:00Z");
  });
  it("سرکوب زمانی: نوشتن دوباره قبل از ۳۰ دقیقه = skip؛ force = نوشته", async () => {
    const kv = new MockKV();
    const recent = new Date("2026-10-12T05:45:00Z"); // ۱۵ دقیقه قبل از NOW
    await kv.put(
      REF_HEALTH_KEY,
      JSON.stringify({ at: recent.toISOString(), tether: {} }),
    );
    const wrote1 = await writeRefHealthIfDue(
      kv,
      [outcome("wallex", "wallex", 264_129)],
      NOW(),
    );
    expect(wrote1).toBe(false); // تازه است — بدون نوشتن
    const wrote2 = await writeRefHealthIfDue(
      kv,
      [outcome("wallex", "wallex", 264_129)],
      NOW(),
      true,
    );
    expect(wrote2).toBe(true);
  });
});

// ---------- integration: جاب ۵ دقیقه (usd-job) ----------

describe("جاب ۵ دقیقه — تتر چندمنبعی در انتشار واقعی", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
  });

  it("Wallex ۴۰۳ + Ramzinex/Nobitex سالم → خط تتر منتشر (قابلیت جدید مأموریت ۲۹)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const result = await runUsdRefresh(env, {
      fetchFn: multiSourceFetch(fetchFn, {
        wallex: new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } }),
      }),
      provider: fakeProvider(null, REPORT_WITH_TETHER),
      marketHours: alwaysOpenMarketHours(),
      now: NOW,
    });
    expect(result.status).toBe("ok");
    expect(result.reason).toBeUndefined(); // بدون متن فنی
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(1);
    expect(String(sends[0]?.body.text)).toContain("تتر");
    // سلامت Wallex خطا ثبت شد؛ دو منبع دیگر ok
    const health = JSON.parse(kv.store.get(REF_HEALTH_KEY) ?? "{}");
    expect(health.tether.wallex.status).toBe("error");
    expect(health.tether.wallex.lastError).toBe("HTTP_403");
    expect(health.tether.ramzinex.status).toBe("ok");
    expect(health.tether.nobitex.status).toBe("ok");
  });

  it("همهٔ مراجع قطع → خط تتر حذف + reason دقیق TETHER_OMITTED_NO_REFERENCE", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const down = new Response("down", { status: 503, headers: { "content-type": "text/plain" } });
    const result = await runUsdRefresh(env, {
      fetchFn: multiSourceFetch(fetchFn, {
        wallex: down,
        ramzinex: down,
        nobitex: down,
      }),
      provider: fakeProvider(null, REPORT_WITH_TETHER),
      marketHours: alwaysOpenMarketHours(),
      now: NOW,
    });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("TETHER_OMITTED_NO_REFERENCE");
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(1);
    expect(String(sends[0]?.body.text)).not.toContain("تتر");
  });

  it("مراجع ناسازگار (NO_CONSENSUS) → خط تتر حذف با reason مخصوص", async () => {
    const { fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const result = await runUsdRefresh(env, {
      fetchFn: multiSourceFetch(fetchFn, {
        wallex: jsonRes(WALLEX_OK),
        ramzinex: jsonRes({ data: { ...RAMZINEX_OK.data, buy: 3_400_000, sell: 3_450_000 } }),
        nobitex: new Response("x", { status: 503, headers: { "content-type": "text/plain" } }),
      }),
      provider: fakeProvider(null, REPORT_WITH_TETHER),
      marketHours: alwaysOpenMarketHours(),
      now: NOW,
    });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("TETHER_OMITTED_NO_CONSENSUS");
  });

  it("دو اجرای معتبر با قیمت یکسان → دو پیام جدید (رگرسیون مدل راند ۲۸)", async () => {
    const { calls, fetchFn } = telegramRecorder({ autoIncrementMessageIds: true });
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    for (let i = 0; i < 2; i++) {
      const r = await runUsdRefresh(env, {
        fetchFn: multiSourceFetch(fetchFn, {}),
        provider: fakeProvider(null, REPORT_WITH_TETHER),
        marketHours: alwaysOpenMarketHours(),
        now: NOW,
        scheduledTime: 1_000 + i * 300_000,
      });
      expect(r.status).toBe("ok");
    }
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(2);
    // id آخرین پیام = دومین id افزایشی (۱۰۱) — دو پیام «متمایز»
    expect(kv.store.get(USD_MESSAGE_ID_KEY)).toBe("101");
    expect(calls.filter((c) => c.url.endsWith("/editMessageText"))).toHaveLength(0);
  });

  it("نوشتن سلامت تجمعی: دو اجرا → فقط یک نوشتن KV در پنجرهٔ ۳۰ دقیقه", async () => {
    const { fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    for (let i = 0; i < 2; i++) {
      await runUsdRefresh(env, {
        fetchFn: multiSourceFetch(fetchFn, {}),
        provider: fakeProvider(null, REPORT_WITH_TETHER),
        marketHours: alwaysOpenMarketHours(),
        now: NOW,
        scheduledTime: 5_000 + i * 300_000,
      });
    }
    const healthWrites = kv.putCalls.filter((c) => c.key === REF_HEALTH_KEY);
    expect(healthWrites).toHaveLength(1);
  });
});

// ---------- integration: گزارش ۶ ساعته ----------

describe("گزارش ۶ ساعته — تتر چندمنبعی + سلامت اجباری", () => {
  it("Wallex قطع + Ramzinex سالم → آیتم تتر میماند + health:refs نوشته شد", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const result = await runMarketReport(env, {
      fetchFn: multiSourceFetch(fetchFn, {
        wallex: new Response("f", { status: 403, headers: { "content-type": "text/plain" } }),
      }),
      provider: fakeProvider(null, {
        ...REPORT_WITH_TETHER,
        items: [
          ...REPORT_WITH_TETHER.items,
          { symbol: "eur", value: 299_010, unit: "toman" },
        ],
      }),
      marketHours: alwaysOpenMarketHours(),
      now: NOW,
    });
    expect(result.status).toBe("ok");
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(1);
    expect(String(sends[0]?.body.text)).toContain("تتر");
    expect(kv.store.has(REF_HEALTH_KEY)).toBe(true);
    const health = JSON.parse(kv.store.get(REF_HEALTH_KEY) ?? "{}");
    expect(health.tether.wallex.status).toBe("error");
    expect(health.tether.ramzinex.status).toBe("ok");
  });

  it("همهٔ مراجع قطع → آیتم تتر حذف از گزارش (fail-closed)", async () => {
    const { calls, fetchFn } = telegramRecorder();
    const kv = new MockKV();
    const env = makeEnv({ STATE: kv });
    const down = new Response("d", { status: 503, headers: { "content-type": "text/plain" } });
    const result = await runMarketReport(env, {
      fetchFn: multiSourceFetch(fetchFn, {
        wallex: down,
        ramzinex: down,
        nobitex: down,
      }),
      provider: fakeProvider(null, {
        ...REPORT_WITH_TETHER,
        items: [
          ...REPORT_WITH_TETHER.items,
          { symbol: "eur", value: 299_010, unit: "toman" },
        ],
      }),
      marketHours: alwaysOpenMarketHours(),
      now: NOW,
    });
    expect(result.status).toBe("ok");
    expect(String(result.reason)).toContain("CROSS_CHECK_OMITTED:usdt");
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(String(sends[0]?.body.text)).not.toContain("تتر");
  });
});

// ---------- env: فهرست منابع ----------

describe("env — TETHER_REFERENCE_SOURCES", () => {
  it("آیتم ناشناخته → EnvError (خطای بلند پیکربندی)", () => {
    expect(() =>
      parseEnv(
        makeRawEnv({
          TETHER_REFERENCE_SOURCES: "wallex,bitpin",
          PRICE_PROVIDER: "stub",
        }),
      ),
    ).toThrow(/TETHER_REFERENCE_SOURCES/);
  });
  it("پیشفرض = هر سه منبع؛ لیست سفارشی معتبر پاس میشود", () => {
    const env = parseEnv(makeRawEnv({ PRICE_PROVIDER: "stub" }));
    expect(env.TETHER_REFERENCE_SOURCES).toBe("wallex,ramzinex,nobitex");
    const env2 = parseEnv(
      makeRawEnv({
        TETHER_REFERENCE_SOURCES: "ramzinex",
        PRICE_PROVIDER: "stub",
      }),
    );
    expect(env2.TETHER_REFERENCE_SOURCES).toBe("ramzinex");
  });
});

// ---------- crossCheckReportItems (مستقیم) ----------

describe("crossCheckReportItems — موتور تتر در گزارش", () => {
  it("آیتم تتر با مرجع رمزینکس سالم (Wallex قطع) → نگه داشته میشود", async () => {
    const out = await crossCheckReportItems(
      makeEnv() as never,
      [
        { symbol: "usd", value: 266_200, unit: "toman" },
        { symbol: "usdt", value: 266_350, unit: "toman" },
      ],
      multiSourceFetch(telegramRecorder().fetchFn, {
        wallex: new Response("f", { status: 403, headers: { "content-type": "text/plain" } }),
      }),
      NOW,
    );
    expect(out.dropped).not.toContain("usdt");
    expect(out.items.find((i) => i.symbol === "usdt")).toBeDefined();
    expect(out.wallexAvailable).toBe(false);
  });
});
