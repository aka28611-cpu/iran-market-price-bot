import { describe, expect, it } from "vitest";
import { JahankhahanProvider } from "../src/providers/jahankhahan-provider";
import { ProviderConfigError } from "../src/providers/jahankhahan-provider";
import { UnknownProviderError } from "../src/providers/provider";
import {
  AVAILABLE_PROVIDERS,
  getProvider,
} from "../src/providers/registry";
import { StubProvider } from "../src/providers/stub-provider";

const LIVE_URL = "https://nerkh.jahankhahan.shop/data/live.json";

describe("provider registry — fail-closed", () => {
  it("provider ثبت‌شده (stub) را برمی‌گرداند", () => {
    const provider = getProvider({
      PRICE_PROVIDER: "stub",
      PRICE_API_BASE_URL: "",
    });
    expect(provider).toBeInstanceOf(StubProvider);
    expect(provider.name).toBe("stub");
  });

  it("jahankhahan با PRICE_API_BASE_URL معتبر ساخته میشود", () => {
    const provider = getProvider({
      PRICE_PROVIDER: "jahankhahan",
      PRICE_API_BASE_URL: LIVE_URL,
    });
    expect(provider).toBeInstanceOf(JahankhahanProvider);
    expect(provider.name).toBe("jahankhahan");
  });

  it("jahankhahan بدون PRICE_API_BASE_URL → ProviderConfigError (fail-closed)", () => {
    expect(() =>
      getProvider({ PRICE_PROVIDER: "jahankhahan", PRICE_API_BASE_URL: "" }),
    ).toThrowError(ProviderConfigError);
  });

  it("jahankhahan با PRICE_API_BASE_URL خراب → ProviderConfigError", () => {
    expect(() =>
      getProvider({
        PRICE_PROVIDER: "jahankhahan",
        PRICE_API_BASE_URL: "not-a-url",
      }),
    ).toThrowError(ProviderConfigError);
  });

  it("نام ناشناس → خطا (بدون fallback)", () => {
    expect(() =>
      getProvider({ PRICE_PROVIDER: "tgju", PRICE_API_BASE_URL: "" }),
    ).toThrowError(UnknownProviderError);
    expect(() =>
      getProvider({ PRICE_PROVIDER: "", PRICE_API_BASE_URL: "" }),
    ).toThrowError(UnknownProviderError);
  });

  it("stub هرگز داده ساختگی تولید نمیکند", async () => {
    const provider = new StubProvider();
    expect(await provider.fetchUsdTehran()).toBeNull();
    expect(await provider.fetchMarketReport()).toBeNull();
  });

  it("فقط providerهای ثبت‌شده تبلیغ میشوند", () => {
    expect(AVAILABLE_PROVIDERS).toEqual(["stub", "jahankhahan"]);
  });
});
