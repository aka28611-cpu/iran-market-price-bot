import { describe, expect, it } from "vitest";
import {
  JahankhahanProvider,
  parseJahankhahanPayload,
  parseJahankhahanTimestamp,
  ProviderConfigError,
} from "../src/providers/jahankhahan-provider";

/**
 * تستهای provider jahankhahan (nerkh.jahankhahan.shop/data/live.json).
 *
 * داده نمونه = خروجی واقعی عمومی API در ارزیابی Read-Only مرحله ۶
 * (بدون هیچ Secret — داده عمومی بازار).
 * fetch همیشه mock میشود — هیچ درخواست واقعی در تستها ارسال نمیشود.
 */

const LIVE_URL = "https://nerkh.jahankhahan.shop/data/live.json";
const FIXED_NOW = new Date("2026-10-08T11:45:00.000Z");

/** نمونه واقعی پاسخ API (۱۴۰۵/۰۷/۱۶ - ۱۴:۴۱ تهران) */
const SAMPLE: Record<string, unknown> = {
  date: "1405/07/16",
  time: "14:41",
  rates: {
    dollar: 267_200,
    euro: 299_690,
    pound: 352_770,
    lira: 5_440,
    aed: 73_049,
    gold: 26_393_400,
    gold24: 35_190_900,
    mesghal: 114_329_000,
    silver: 537_010,
    coin: 269_650_000,
    bahar: 259_330_000,
    half: 142_970_000,
    quarter: 76_980_000,
    gram: 37_000_000,
    tether: 267_878,
    bitcoin: 22_102_955_600,
    yuan: 40_090,
  },
  change: { dollar: 1.52, gold: 0.43, coin: 0.89 },
  usd: { ounce: 4115.99, "silver-ounce": 58.67 },
  ounce: 4115.99,
};

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** fetch فیک — فراخوانیها را ثبت و پاسخهای آماده را برمیگرداند */
function recordingFetch(
  responses: Response | Response[],
  calls: RecordedCall[] = [],
): { calls: RecordedCall[]; fetchFn: typeof fetch } {
  const list = Array.isArray(responses) ? [...responses] : [responses];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = list.shift();
    if (!next) throw new Error("no more canned responses");
    return next;
  }) as typeof fetch;
  return { calls, fetchFn };
}

function makeProvider(overrides: Record<string, unknown> = {}): {
  provider: JahankhahanProvider;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const { fetchFn } = recordingFetch(jsonResponse(SAMPLE), calls);
  const provider = new JahankhahanProvider({
    baseUrl: LIVE_URL,
    fetchFn,
    now: () => FIXED_NOW,
    ...overrides,
  });
  return { provider, calls };
}

// ---------- مهر زمانی ----------

describe("parseJahankhahanTimestamp — شمسی + ساعت تهران → ISO", () => {
  it("1405/07/16 14:41 → 2026-10-08T11:11:00.000Z (تهران = UTC+3:30)", () => {
    expect(parseJahankhahanTimestamp("1405/07/16", "14:41")).toBe(
      "2026-10-08T11:11:00.000Z",
    );
  });

  it("نیمهشب تهران 00:00 → 20:30 روز قبل UTC", () => {
    expect(parseJahankhahanTimestamp("1405/07/16", "00:00")).toBe(
      "2026-10-07T20:30:00.000Z",
    );
  });

  it("سال کبیسه: 1403/12/30 → 2025-03-20", () => {
    expect(parseJahankhahanTimestamp("1403/12/30", "00:00")).toBe(
      "2025-03-19T20:30:00.000Z",
    );
  });

  const badDates = [
    "1405-07-16",
    "1405/7/16",
    "1405/07/6",
    "14050716",
    "",
    "abcd/ef/gh",
    "2026-10-08",
  ];
  for (const bad of badDates) {
    it(`تاریخ نامعتبر «${bad}» → null`, () => {
      expect(parseJahankhahanTimestamp(bad, "14:41")).toBeNull();
    });
  }

  const badTimes = ["14:41:00", "24:00", "14:60", "1441", "", "14-41"];
  for (const bad of badTimes) {
    it(`زمان نامعتبر «${bad}» → null`, () => {
      expect(parseJahankhahanTimestamp("1405/07/16", bad)).toBeNull();
    });
  }

  it("ورودی غیر رشتهای (عدد/null/undefined) → null", () => {
    expect(parseJahankhahanTimestamp(14050716, "14:41")).toBeNull();
    expect(parseJahankhahanTimestamp("1405/07/16", null)).toBeNull();
    expect(parseJahankhahanTimestamp(undefined, undefined)).toBeNull();
  });

  it("محدودههای نامعتبر: ماه ۱۳، روز ۳۲، سال خارج از بازه → null", () => {
    expect(parseJahankhahanTimestamp("1405/13/16", "14:41")).toBeNull();
    expect(parseJahankhahanTimestamp("1405/07/32", "14:41")).toBeNull();
    expect(parseJahankhahanTimestamp("1390/07/16", "14:41")).toBeNull();
    expect(parseJahankhahanTimestamp("1500/07/16", "14:41")).toBeNull();
  });

  it("اسفند ۳۰ فقط در سال کبیسه: 1405/12/30 → null (سال غیرکبیسه)", () => {
    expect(parseJahankhahanTimestamp("1405/12/30", "10:00")).toBeNull();
    expect(parseJahankhahanTimestamp("1403/12/30", "10:00")).not.toBeNull();
  });
});

// ---------- parse payload ----------

describe("parseJahankhahanPayload — نگاشت فیلدها", () => {
  it("نمونه کامل → ۱۲ آیتم معتبر با مهر زمانی مشترک", () => {
    const result = parseJahankhahanPayload(SAMPLE);
    expect(result).not.toBeNull();
    expect(result?.items).toHaveLength(12);
    expect(result?.missing).toEqual([]);
    for (const item of result?.items ?? []) {
      expect(item.updatedAt).toBe("2026-10-08T11:11:00.000Z");
    }
  });

  it("مقادیر و واحدها درست نگاشت میشوند", () => {
    const result = parseJahankhahanPayload(SAMPLE);
    const bySymbol = new Map(
      (result?.items ?? []).map((i) => [i.symbol, i]),
    );
    expect(bySymbol.get("usd")?.value).toBe(267_200);
    expect(bySymbol.get("usd")?.unit).toBe("toman");
    expect(bySymbol.get("gold18k")?.value).toBe(26_393_400);
    expect(bySymbol.get("gold24k")?.value).toBe(35_190_900);
    expect(bySymbol.get("bahar")?.value).toBe(259_330_000);
    expect(bySymbol.get("halfCoin")?.value).toBe(142_970_000);
    expect(bySymbol.get("quarterCoin")?.value).toBe(76_980_000);
    expect(bySymbol.get("germi")?.value).toBe(37_000_000);
    expect(bySymbol.get("ounce")?.value).toBe(4115.99);
    expect(bySymbol.get("ounce")?.unit).toBe("usd");
    expect(bySymbol.get("eur")?.value).toBe(299_690);
    expect(bySymbol.get("gbp")?.value).toBe(352_770);
    expect(bySymbol.get("try")?.value).toBe(5_440);
    expect(bySymbol.get("aed")?.value).toBe(73_049);
  });

  it("فیلدهای تأییدنشده: mesghal با برچسب UNKNOWN و coin با UNVERIFIED_COIN", () => {
    const result = parseJahankhahanPayload(SAMPLE);
    const unverified = result?.unverified ?? [];
    expect(unverified).toHaveLength(2);

    const mesghal = unverified.find((f) => f.key === "mesghal");
    expect(mesghal?.status).toBe("UNKNOWN");
    expect(mesghal?.value).toBe(114_329_000);
    expect(mesghal?.symbol).toBe("mesghal");

    const coin = unverified.find((f) => f.key === "coin");
    expect(coin?.status).toBe("UNVERIFIED_COIN");
    expect(coin?.value).toBe(269_650_000);
    expect(coin?.symbol).toBe("emami");
  });

  it("فیلدهای تأییدنشده هرگز وارد items نمیشوند (نمایش production ممنوع)", () => {
    const result = parseJahankhahanPayload(SAMPLE);
    const symbols = (result?.items ?? []).map((i) => i.symbol);
    expect(symbols).not.toContain("mesghal");
    expect(symbols).not.toContain("emami");
    expect(symbols).not.toContain("goldMelted");
  });

  it("فیلد غایب → آیتم حذف و ثبت در missing (بدون مقدار جایگزین)", () => {
    const partial: Record<string, unknown> = {
      ...SAMPLE,
      rates: { ...(SAMPLE.rates as Record<string, unknown>) },
    };
    delete (partial.rates as Record<string, unknown>)["aed"];
    const result = parseJahankhahanPayload(partial);
    expect(result?.items).toHaveLength(11);
    expect(result?.missing).toContain("aed");
    const symbols = (result?.items ?? []).map((i) => i.symbol);
    expect(symbols).not.toContain("aed");
  });

  const invalidValues = [
    ["رشته", "267200"],
    ["صفر", 0],
    ["منفی", -1],
    ["null", null],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ] as const;
  for (const [label, value] of invalidValues) {
    it(`مقدار نامعتبر (${label}) → آیتم حذف، بقیه سالم میمانند`, () => {
      const payload: Record<string, unknown> = {
        ...SAMPLE,
        rates: { ...(SAMPLE.rates as Record<string, unknown>), dollar: value },
      };
      const result = parseJahankhahanPayload(payload);
      expect(result?.items).toHaveLength(11);
      expect(result?.missing).toContain("dollar");
      const symbols = (result?.items ?? []).map((i) => i.symbol);
      expect(symbols).not.toContain("usd");
      expect(symbols).toContain("eur");
    });
  }

  it("اونس: غیبت سطح top-level → fallback به usd.ounce", () => {
    const payload: Record<string, unknown> = { ...SAMPLE };
    delete payload["ounce"];
    const result = parseJahankhahanPayload(payload);
    const ounce = (result?.items ?? []).find((i) => i.symbol === "ounce");
    expect(ounce?.value).toBe(4115.99);
    expect(result?.missing).not.toContain("ounce");
  });

  it("اونس: غیبت هر دو منبع → آیتم حذف و ثبت در missing", () => {
    const payload: Record<string, unknown> = { ...SAMPLE };
    delete payload["ounce"];
    delete payload["usd"];
    const result = parseJahankhahanPayload(payload);
    const symbols = (result?.items ?? []).map((i) => i.symbol);
    expect(symbols).not.toContain("ounce");
    expect(result?.missing).toContain("ounce");
    expect(result?.items).toHaveLength(11);
  });

  it("فیلدهای تأییدنشده غایب → مقدار null در نتیجه unverified", () => {
    const payload: Record<string, unknown> = {
      ...SAMPLE,
      rates: { ...(SAMPLE.rates as Record<string, unknown>) },
    };
    delete (payload.rates as Record<string, unknown>)["coin"];
    delete (payload.rates as Record<string, unknown>)["mesghal"];
    const result = parseJahankhahanPayload(payload);
    const unverified = result?.unverified ?? [];
    expect(unverified.find((f) => f.key === "coin")?.value).toBeNull();
    expect(unverified.find((f) => f.key === "mesghal")?.value).toBeNull();
  });
});

describe("parseJahankhahanPayload — پاسخ نامعتبر → null (fail-closed)", () => {
  const invalidPayloads: Array<[string, unknown]> = [
    ["رشته", "not json"],
    ["عدد", 42],
    ["null", null],
    ["آرایه", [SAMPLE]],
    ["بدون date/time", { rates: SAMPLE.rates }],
    ["date میلادی بهجای شمسی", { ...SAMPLE, date: "2026-10-08" }],
    ["بدون rates", { date: "1405/07/16", time: "14:41" }],
    ["rates آرایه", { ...SAMPLE, rates: [1, 2, 3] }],
    ["rates رشته", { ...SAMPLE, rates: "dollar:267200" }],
  ];
  for (const [label, payload] of invalidPayloads) {
    it(`${label} → null`, () => {
      expect(parseJahankhahanPayload(payload)).toBeNull();
    });
  }
});

// ---------- Provider ----------

describe("JahankhahanProvider — پیکربندی", () => {
  it("name = jahankhahan", () => {
    const { provider } = makeProvider();
    expect(provider.name).toBe("jahankhahan");
  });

  const badUrls = [
    ["خالی", ""],
    ["بدون پروتکل", "nerkh.jahankhahan.shop/data/live.json"],
    ["پروتکل غیر http(s)", "ftp://example.test/live.json"],
    ["با credential", "https://user:pass@example.test/live.json"],
  ] as const;
  for (const [label, url] of badUrls) {
    it(`baseUrl ${label} → ProviderConfigError`, () => {
      expect(() => new JahankhahanProvider({ baseUrl: url })).toThrowError(
        ProviderConfigError,
      );
    });
  }
});

describe("JahankhahanProvider — fetchUsdTehran (نرخ تکعددی)", () => {
  it("null برمیگرداند — ساخت buy/sell از نرخ واحد ممنوع است", async () => {
    const { provider, calls } = makeProvider();
    expect(await provider.fetchUsdTehran()).toBeNull();
    // منبع نرخ میز خرید/فروش ندارد → حتی درخواست هم نباید ارسال شود
    expect(calls).toHaveLength(0);
  });
});

describe("JahankhahanProvider — fetchMarketReport", () => {
  it("گزارش کامل: source/fetchedAt/items و درخواست امن", async () => {
    const { provider, calls } = makeProvider();
    const report = await provider.fetchMarketReport();

    expect(report).not.toBeNull();
    expect(report?.source).toBe("jahankhahan");
    expect(report?.fetchedAt).toBe("2026-10-08T11:45:00.000Z");
    expect(report?.items).toHaveLength(12);

    const symbols = (report?.items ?? []).map((i) => i.symbol);
    expect(symbols).not.toContain("mesghal");
    expect(symbols).not.toContain("emami");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LIVE_URL);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.cache).toBe("no-store");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["accept"]).toBe("application/json");
  });

  it("هر آیتم مهر زمانی داده (نه زمان fetch) دارد", async () => {
    const { provider } = makeProvider();
    const report = await provider.fetchMarketReport();
    for (const item of report?.items ?? []) {
      expect(item.updatedAt).toBe("2026-10-08T11:11:00.000Z");
    }
  });

  it("گزارش جزئی: فقط فیلدهای سالم منتشر میشوند", async () => {
    const payload: Record<string, unknown> = {
      ...SAMPLE,
      rates: { bahar: 259_330_000 },
    };
    delete payload["ounce"];
    delete payload["usd"];
    const calls: RecordedCall[] = [];
    const { fetchFn } = recordingFetch(jsonResponse(payload), calls);
    const provider = new JahankhahanProvider({
      baseUrl: LIVE_URL,
      fetchFn,
      now: () => FIXED_NOW,
    });
    const report = await provider.fetchMarketReport();
    expect(report?.items).toHaveLength(1);
    expect(report?.items[0]?.symbol).toBe("bahar");
  });

  it("فیلدهای تأییدنشده در پاسخ سالم هم منتشر نمیشوند", async () => {
    const { provider } = makeProvider();
    const report = await provider.fetchMarketReport();
    const symbols = (report?.items ?? []).map((i) => i.symbol);
    // coin و mesghal در SAMPLE وجود دارند اما:
    expect(symbols).not.toContain("mesghal");
    expect(symbols).not.toContain("emami");
    expect(symbols).not.toContain("goldMelted");
  });

  const badResponses: Array<[string, Response]> = [
    ["HTTP 404", jsonResponse({}, { status: 404 })],
    ["HTTP 500", jsonResponse({}, { status: 500 })],
    ["HTTP 301 (redirect)", jsonResponse({}, { status: 301 })],
    [
      "HTML بهجای JSON (تله navasan.net)",
      new Response("<html>redirect</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ],
    ["JSON خراب", new Response("{invalid", { status: 200, headers: { "content-type": "application/json" } })],
  ];
  for (const [label, response] of badResponses) {
    it(`${label} → null`, async () => {
      const calls: RecordedCall[] = [];
      const { fetchFn } = recordingFetch(response, calls);
      const provider = new JahankhahanProvider({
        baseUrl: LIVE_URL,
        fetchFn,
        now: () => FIXED_NOW,
      });
      expect(await provider.fetchMarketReport()).toBeNull();
    });
  }

  it("خطای شبکه (reject) → null", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const provider = new JahankhahanProvider({
      baseUrl: LIVE_URL,
      fetchFn,
      now: () => FIXED_NOW,
    });
    expect(await provider.fetchMarketReport()).toBeNull();
  });

  it("تایم‌اوت درخواست → null (سریع برمیگردد، نه hang)", async () => {
    const fetchFn = ((
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as typeof fetch;
    const provider = new JahankhahanProvider({
      baseUrl: LIVE_URL,
      fetchFn,
      now: () => FIXED_NOW,
      timeoutMs: 25,
    });
    const started = Date.now();
    expect(await provider.fetchMarketReport()).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("payload معتبر ولی بدون هیچ فیلد معتبر → null (گزارش خالی = عدم انتشار)", async () => {
    const payload = {
      date: "1405/07/16",
      time: "14:41",
      rates: {},
      ounce: "invalid",
    };
    const calls: RecordedCall[] = [];
    const { fetchFn } = recordingFetch(jsonResponse(payload), calls);
    const provider = new JahankhahanProvider({
      baseUrl: LIVE_URL,
      fetchFn,
      now: () => FIXED_NOW,
    });
    expect(await provider.fetchMarketReport()).toBeNull();
  });

  it("دو فراخوانی متوالی = دو درخواست جدا (بدون کش داخلی)", async () => {
    const calls: RecordedCall[] = [];
    const { fetchFn } = recordingFetch(
      [jsonResponse(SAMPLE), jsonResponse(SAMPLE)],
      calls,
    );
    const provider = new JahankhahanProvider({
      baseUrl: LIVE_URL,
      fetchFn,
      now: () => FIXED_NOW,
    });
    const first = await provider.fetchMarketReport();
    const second = await provider.fetchMarketReport();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(calls).toHaveLength(2);
  });
});
