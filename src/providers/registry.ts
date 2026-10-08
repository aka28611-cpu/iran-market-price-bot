import type { Env } from "../env";
import { UnknownProviderError, type PriceProvider } from "./provider";
import { StubProvider } from "./stub-provider";

/**
 * انتخاب provider از متغیر PRICE_PROVIDER.
 *
 * fail-closed: هر نامی جز providerهای ثبت‌شده → خطا (هیچ fallbackای نیست).
 */
export function getProvider(
  env: Pick<Env, "PRICE_PROVIDER">,
): PriceProvider {
  switch (env.PRICE_PROVIDER) {
    case "stub":
      return new StubProvider();
    default:
      throw new UnknownProviderError(env.PRICE_PROVIDER);
  }
}

export const AVAILABLE_PROVIDERS: readonly string[] = ["stub"];
