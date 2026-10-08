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
