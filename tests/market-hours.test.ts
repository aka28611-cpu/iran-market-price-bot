import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKET_HOURS,
  evaluateMarketSession,
  type MarketHoursConfig,
} from "../src/market-hours";

/**
 * تست ساعت بازار — همه زمانها قطعی (UTC → تهران +03:30).
 * تقویم مرجع: 2025-10-08 چهارشنبه، 09 پنجشنبه، 10 جمعه، 11 شنبه.
 */

const S = DEFAULT_MARKET_HOURS.defaultSession;

describe("evaluateMarketSession — وضعیت OPEN/CLOSED", () => {
  it("داخل پنجره کاری روز میانی → OPEN (شنبه ۱۰:۰۰ تهران)", () => {
    const r = evaluateMarketSession(new Date("2025-10-11T06:30:00Z"), S);
    expect(r.state).toBe("OPEN");
    expect(r.weekday).toBe(6); // شنبه
  });

  it("پنجشنبه صبح (نیم‌روز) → OPEN", () => {
    const r = evaluateMarketSession(new Date("2025-10-09T07:00:00Z"), S);
    expect(r.state).toBe("OPEN");
    expect(r.weekday).toBe(4); // پنجشنبه
  });

  it("پنجشنبه بعدازظهر (پایان نیم‌روز) → CLOSED", () => {
    const r = evaluateMarketSession(new Date("2025-10-09T10:00:00Z"), S);
    expect(r.state).toBe("CLOSED");
  });

  it("جمعه (تعطیلی هفتگی) → CLOSED", () => {
    const r = evaluateMarketSession(new Date("2025-10-10T10:00:00Z"), S);
    expect(r.state).toBe("CLOSED");
    expect(r.weekday).toBe(5); // جمعه
  });

  it("قبل از ساعت باز شدن → CLOSED", () => {
    const r = evaluateMarketSession(new Date("2025-10-08T04:00:00Z"), S);
    expect(r.state).toBe("CLOSED");
  });

  it("بعد از ساعت بسته شدن → CLOSED", () => {
    const r = evaluateMarketSession(new Date("2025-10-08T18:00:00Z"), S);
    expect(r.state).toBe("CLOSED");
  });

  it("مرز دقیق باز شدن (۰۹:۰۰) → OPEN", () => {
    const r = evaluateMarketSession(new Date("2025-10-08T05:30:00Z"), S);
    expect(r.state).toBe("OPEN");
  });

  it("مرز دقیق بسته شدن (۱۹:۰۰) → CLOSED (بازه بسته در انتها)", () => {
    const r = evaluateMarketSession(new Date("2025-10-08T15:30:00Z"), S);
    expect(r.state).toBe("CLOSED");
  });

  it("تاریخ تهران «YYYY-MM-DD» و روز هفته درست برمی‌گردد", () => {
    const r = evaluateMarketSession(new Date("2025-10-08T21:00:00Z"), S);
    expect(r.date).toBe("2025-10-09"); // بعد از نیمه‌شب UTC → روز بعد تهران
    expect(r.weekday).toBe(4); // پنجشنبه
  });
});

describe("evaluateMarketSession — تعطیلات", () => {
  it("تاریخ تعطیل رسمی (حتی داخل پنجره) → CLOSED", () => {
    const config: MarketHoursConfig = {
      timezone: "Asia/Tehran",
      defaultSession: "s",
      sessions: {
        s: {
          windowsByDay: { 6: [{ from: "09:00", to: "19:00" }] },
          holidays: ["2025-10-11"],
        },
      },
    };
    const r = evaluateMarketSession(new Date("2025-10-11T06:30:00Z"), "s", config);
    expect(r.state).toBe("CLOSED");
  });
});

describe("evaluateMarketSession — UNKNOWN (fail-closed)", () => {
  it("session ناشناس → UNKNOWN", () => {
    const r = evaluateMarketSession(new Date("2025-10-08T06:00:00Z"), "no-such-session");
    expect(r.state).toBe("UNKNOWN");
    expect(r.weekday).toBeNull();
    expect(r.date).toBeNull();
  });

  it("timezone غیرمجاز → UNKNOWN", () => {
    const config = {
      timezone: "Europe/Berlin" as unknown as MarketHoursConfig["timezone"],
      defaultSession: "s",
      sessions: { s: { windowsByDay: { 6: [{ from: "00:00", to: "23:59" }] }, holidays: [] } },
    };
    const r = evaluateMarketSession(new Date("2025-10-11T06:30:00Z"), "s", config);
    expect(r.state).toBe("UNKNOWN");
  });

  it("فرمت پنجره خراب («9:00») → UNKNOWN", () => {
    const config: MarketHoursConfig = {
      timezone: "Asia/Tehran",
      defaultSession: "s",
      sessions: {
        s: {
          windowsByDay: { 3: [{ from: "9:00", to: "19:00" }] },
          holidays: [],
        },
      },
    };
    const r = evaluateMarketSession(new Date("2025-10-08T06:00:00Z"), "s", config);
    expect(r.state).toBe("UNKNOWN");
  });

  it("فرمت پنجره خارج از دامنه («25:00») → UNKNOWN", () => {
    const config: MarketHoursConfig = {
      timezone: "Asia/Tehran",
      defaultSession: "s",
      sessions: {
        s: { windowsByDay: { 3: [{ from: "00:00", to: "25:00" }] }, holidays: [] },
      },
    };
    const r = evaluateMarketSession(new Date("2025-10-08T06:00:00Z"), "s", config);
    expect(r.state).toBe("UNKNOWN");
  });

  it("بازه معکوس (to ≤ from) → UNKNOWN", () => {
    const config: MarketHoursConfig = {
      timezone: "Asia/Tehran",
      defaultSession: "s",
      sessions: {
        s: { windowsByDay: { 3: [{ from: "12:00", to: "12:00" }] }, holidays: [] },
      },
    };
    const r = evaluateMarketSession(new Date("2025-10-08T06:00:00Z"), "s", config);
    expect(r.state).toBe("UNKNOWN");
  });

  it("Date نامعتبر (NaN) → UNKNOWN", () => {
    const r = evaluateMarketSession(new Date(Number.NaN), S);
    expect(r.state).toBe("UNKNOWN");
  });
});

describe("DEFAULT_MARKET_HOURS — منبع یگانه ساعت بازار", () => {
  it("timezone فقط Asia/Tehran است", () => {
    expect(DEFAULT_MARKET_HOURS.timezone).toBe("Asia/Tehran");
  });

  it("defaultSession در sessions تعریف شده است", () => {
    expect(
      DEFAULT_MARKET_HOURS.sessions[DEFAULT_MARKET_HOURS.defaultSession],
    ).toBeDefined();
  });

  it("جمعه (روز ۵) تعریف نشده — تعطیلی هفتگی", () => {
    const schedule = DEFAULT_MARKET_HOURS.sessions[
      DEFAULT_MARKET_HOURS.defaultSession
    ];
    expect(schedule?.windowsByDay[5]).toBeUndefined();
  });

  it("همه روزهای تعریف‌شده پنجره معتبر دارند", () => {
    const schedule = DEFAULT_MARKET_HOURS.sessions[
      DEFAULT_MARKET_HOURS.defaultSession
    ];
    for (const windows of Object.values(schedule?.windowsByDay ?? {})) {
      for (const w of windows ?? []) {
        expect(w.from).toMatch(/^([01]\d|2[0-3]):([0-5]\d)$/);
        expect(w.to).toMatch(/^([01]\d|2[0-3]):([0-5]\d)$/);
        expect(w.from < w.to).toBe(true);
      }
    }
  });
});
