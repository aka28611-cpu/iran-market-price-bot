import type { Env } from "../env";
import { JahankhahanProvider } from "./jahankhahan-provider";
import { UnknownProviderError, type PriceProvider } from "./provider";
import { StubProvider } from "./stub-provider";

/**
 * انتخاب provider از متغیر PRICE_PROVIDER.
 *
 * fail-closed: هر نامی جز providerهای ثبت‌شده → خطا (هیچ fallbackای نیست).
 * فعالسازی jahankhahan نیازمند PRICE_API_BASE_URL معتبر است؛ غایب/نامعتبر
 * → ProviderConfigError (خطای پیکربندی، بدون fallback).
 * پیشفرض هنوز stub است — تنظیم production با تأیید مالک پروژه انجام میشود.
 */
export function getProvider(
  env: Pick<Env, "PRICE_PROVIDER" | "PRICE_API_BASE_URL">,
): PriceProvider {
  switch (env.PRICE_PROVIDER) {
    case "stub":
      return new StubProvider();
    case "jahankhahan":
      return new JahankhahanProvider({ baseUrl: env.PRICE_API_BASE_URL });
    default:
      throw new UnknownProviderError(env.PRICE_PROVIDER);
  }
}

export const AVAILABLE_PROVIDERS: readonly string[] = [
  "stub",
  "jahankhahan",
];
