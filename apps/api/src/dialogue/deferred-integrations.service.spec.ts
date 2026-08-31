import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredIntegrationsService } from "./deferred-integrations.service.js";

describe("DeferredIntegrationsService FX conversion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts USD, EUR, and KZT to som using the NBKR daily feed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0" encoding="UTF-8"?>
<CurrencyRates Date="31.08.2026">
  <Currency ISOCode="USD"><Nominal>1</Nominal><Value>87.4500</Value></Currency>
  <Currency ISOCode="EUR"><Nominal>1</Nominal><Value>101.2500</Value></Currency>
  <Currency ISOCode="KZT"><Nominal>10</Nominal><Value>1.7600</Value></Currency>
</CurrencyRates>`
    }));

    const service = new DeferredIntegrationsService();

    await expect(service.convertToSom({ amount: 10_000, currency: "USD" })).resolves.toEqual(expect.objectContaining({
      available: true,
      value: 874_500,
      currency: "USD",
      source: "NBKR",
      effectiveDate: "2026-08-31"
    }));
    await expect(service.convertToSom({ amount: 1_000, currency: "EUR" })).resolves.toEqual(expect.objectContaining({
      available: true,
      value: 101_250,
      currency: "EUR"
    }));
    await expect(service.convertToSom({ amount: 20_000, currency: "KZT" })).resolves.toEqual(expect.objectContaining({
      available: true,
      value: 3_520,
      currency: "KZT",
      nominal: 10
    }));
  });

  it("fails closed when the NBKR feed is unavailable or malformed", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, text: async () => "<CurrencyRates />" }));

    const service = new DeferredIntegrationsService();

    await expect(service.convertToSom({ amount: 10_000, currency: "USD" })).resolves.toEqual({
      available: false,
      code: "SPEC_GAP_FX"
    });
    await expect(service.convertToSom({ amount: 10_000, currency: "USD" })).resolves.toEqual({
      available: false,
      code: "SPEC_GAP_FX"
    });
  });
});
