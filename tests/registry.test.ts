import { describe, expect, it } from "vitest";
import { UnknownProviderError } from "../src/providers/provider";
import {
  AVAILABLE_PROVIDERS,
  getProvider,
} from "../src/providers/registry";
import { StubProvider } from "../src/providers/stub-provider";

describe("provider registry — fail-closed", () => {
  it("provider ثبت‌شده (stub) را برمی‌گرداند", () => {
    const provider = getProvider({ PRICE_PROVIDER: "stub" });
    expect(provider).toBeInstanceOf(StubProvider);
    expect(provider.name).toBe("stub");
  });

  it("نام ناشناس → خطا (بدون fallback)", () => {
    expect(() => getProvider({ PRICE_PROVIDER: "tgju" })).toThrowError(
      UnknownProviderError,
    );
    expect(() => getProvider({ PRICE_PROVIDER: "" })).toThrowError(
      UnknownProviderError,
    );
  });

  it("stub هرگز داده ساختگی تولید نمی‌کند", async () => {
    const provider = new StubProvider();
    expect(await provider.fetchUsdTehran()).toBeNull();
    expect(await provider.fetchMarketReport()).toBeNull();
  });

  it("فقط providerهای ثبت‌شده تبلیغ می‌شوند", () => {
    expect(AVAILABLE_PROVIDERS).toEqual(["stub"]);
  });
});
