import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "../src/env";
import { makeRawEnv, MockKV } from "./helpers";

describe("parseEnv — fail-closed", () => {
  it("env کامل و معتبر را می‌پذیرد", () => {
    const parsed = parseEnv(makeRawEnv());
    expect(parsed.ADMIN_USER_ID).toBe(100200300);
    expect(parsed.CHANNEL_ID).toBe("-1001234567890");
    expect(parsed.PRICE_PROVIDER).toBe("stub");
  });

  it("فقط «نام» متغیرهای مفقود را گزارش می‌کند — نه مقدار", () => {
    try {
      parseEnv({ STATE: new MockKV() });
      expect.unreachable("باید EnvError پرتاب شود");
    } catch (err) {
      const e = err as EnvError;
      expect(e).toBeInstanceOf(EnvError);
      expect(e.missing).toContain("TELEGRAM_BOT_TOKEN");
      expect(e.missing).toContain("TELEGRAM_WEBHOOK_SECRET");
      expect(e.missing).toContain("ADMIN_USER_ID");
      expect(e.missing).toContain("CHANNEL_ID");
      expect(e.missing).not.toContain("PRICE_API_KEY"); // اختیاری
    }
  });

  it("مقادیر نامعتبر را رد می‌کند", () => {
    const raw = makeRawEnv({
      TELEGRAM_BOT_TOKEN: "not-a-token",
      TELEGRAM_WEBHOOK_SECRET: "short",
      ADMIN_USER_ID: "abc",
      CHANNEL_ID: "123",
    });
    try {
      parseEnv(raw);
      expect.unreachable("باید EnvError پرتاب شود");
    } catch (err) {
      const e = err as EnvError;
      expect(e.invalid).toContain("TELEGRAM_BOT_TOKEN");
      expect(e.invalid).toContain("TELEGRAM_WEBHOOK_SECRET");
      expect(e.invalid).toContain("ADMIN_USER_ID");
      expect(e.invalid).toContain("CHANNEL_ID");
    }
  });

  it("کانال عمومی @username معتبر است", () => {
    const parsed = parseEnv(makeRawEnv({ CHANNEL_ID: "@my_market_channel" }));
    expect(parsed.CHANNEL_ID).toBe("@my_market_channel");
  });

  it("پیش‌فرض PRICE_PROVIDER برابر stub است", () => {
    const raw = makeRawEnv();
    delete raw["PRICE_PROVIDER"];
    const parsed = parseEnv(raw);
    expect(parsed.PRICE_PROVIDER).toBe("stub");
  });

  it("نبود binding STATE را رد می‌کند", () => {
    const raw = makeRawEnv();
    delete raw["STATE"];
    try {
      parseEnv(raw);
      expect.unreachable("باید EnvError پرتاب شود");
    } catch (err) {
      const e = err as EnvError;
      expect(e.invalid).toContain("STATE");
    }
  });
});

describe("parseEnv — لینکهای عمومی اختیاری (CHANNEL_LINK / SUPPORT_LINK)", () => {
  it("غایب → رشته خالی (دکمه حذف میشود)", () => {
    const parsed = parseEnv(makeRawEnv());
    expect(parsed.CHANNEL_LINK).toBe("");
    expect(parsed.SUPPORT_LINK).toBe("");
  });

  it("لینک معتبر t.me نگه داشته میشود؛ اسلش انتهایی حذف میشود", () => {
    const parsed = parseEnv(
      makeRawEnv({
        CHANNEL_LINK: "https://t.me/my_market_channel/",
        SUPPORT_LINK: "https://t.me/support_bot",
      }),
    );
    expect(parsed.CHANNEL_LINK).toBe("https://t.me/my_market_channel");
    expect(parsed.SUPPORT_LINK).toBe("https://t.me/support_bot");
  });

  it("لینک نامعتبر → رشته خالی — هرگز URL ساختگی/خارجی جایگزین نمیشود", () => {
    const parsed = parseEnv(
      makeRawEnv({
        CHANNEL_LINK: "http://evil.example.com/channel",
        SUPPORT_LINK: "javascript:alert(1)",
      }),
    );
    expect(parsed.CHANNEL_LINK).toBe("");
    expect(parsed.SUPPORT_LINK).toBe("");
  });

  it("نامعتبر بودن لینک ربات را از کار نمی‌اندازد (env معتبر میماند)", () => {
    const parsed = parseEnv(
      makeRawEnv({ CHANNEL_LINK: "not a url" }),
    );
    expect(parsed.PRICE_PROVIDER).toBe("stub");
  });
});

describe("parseEnv — اعتبارسنجی متقاطع (متغیرهای اختیاری)", () => {
  it("غایب → پیش‌فرضهای امن: فعال، آستانه‌های ۲.۵/۵/۳، URLهای مرجع پیش‌فرض", () => {
    const raw = makeRawEnv();
    const parsed = parseEnv(raw);
    expect(parsed.CROSS_CHECK_ENABLED).toBe(true);
    expect(parsed.CROSS_CHECK_FX_TOLERANCE_PCT).toBe(2.5);
    expect(parsed.CROSS_CHECK_GOLD_TOLERANCE_PCT).toBe(5);
    expect(parsed.CROSS_CHECK_TETHER_TOLERANCE_PCT).toBe(3);
    expect(parsed.TGJU_REFERENCE_URL).toBe("https://call1.tgju.org/ajax.json");
    expect(parsed.WALLEX_MARKETS_URL).toBe(
      "https://api.wallex.ir/v1/depth?symbol=USDTTMN",
    );
  });

  it("CROSS_CHECK_ENABLED=false / 0 → غیرفعال", () => {
    for (const v of ["false", "0"]) {
      const parsed = parseEnv(makeRawEnv({ CROSS_CHECK_ENABLED: v }));
      expect(parsed.CROSS_CHECK_ENABLED).toBe(false);
    }
  });

  it("CROSS_CHECK_ENABLED نامعتبر → EnvError (غلط تایپی = خطای بلند)", () => {
    try {
      parseEnv(makeRawEnv({ CROSS_CHECK_ENABLED: "yes" }));
      expect.unreachable("باید EnvError پرتاب شود");
    } catch (err) {
      const e = err as EnvError;
      expect(e.invalid).toContain("CROSS_CHECK_ENABLED");
    }
  });

  it("آستانهٔ نامعتبر (صفر/منفی/بیش از ۵۰/غیر عددی) → EnvError", () => {
    for (const v of ["0", "-1", "51", "abc"]) {
      try {
        parseEnv(
          makeRawEnv({ CROSS_CHECK_FX_TOLERANCE_PCT: v }),
        );
        expect.unreachable(`باید EnvError پرتاب شود: ${v}`);
      } catch (err) {
        const e = err as EnvError;
        expect(e.invalid).toContain("CROSS_CHECK_FX_TOLERANCE_PCT");
      }
    }
  });

  it("آستانهٔ معتبر override میشود", () => {
    const parsed = parseEnv(
      makeRawEnv({
        CROSS_CHECK_FX_TOLERANCE_PCT: "1.5",
        CROSS_CHECK_GOLD_TOLERANCE_PCT: "8",
      }),
    );
    expect(parsed.CROSS_CHECK_FX_TOLERANCE_PCT).toBe(1.5);
    expect(parsed.CROSS_CHECK_GOLD_TOLERANCE_PCT).toBe(8);
  });

  it("URL مرجع غیر https / با credential → EnvError", () => {
    for (const v of ["http://call1.tgju.org/ajax.json", "ftp://x/y", "https://u:p@tgju.example/x"]) {
      try {
        parseEnv(makeRawEnv({ TGJU_REFERENCE_URL: v }));
        expect.unreachable(`باید EnvError پرتاب شود: ${v}`);
      } catch (err) {
        const e = err as EnvError;
        expect(e.invalid).toContain("TGJU_REFERENCE_URL");
      }
    }
  });

  it("URL مرجع معتبر override میشود", () => {
    const parsed = parseEnv(
      makeRawEnv({ WALLEX_MARKETS_URL: "https://api.wallex.example/v1/depth" }),
    );
    expect(parsed.WALLEX_MARKETS_URL).toBe(
      "https://api.wallex.example/v1/depth",
    );
  });
});
