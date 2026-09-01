import { Injectable } from "@nestjs/common";
import type {
  DeferredIntegrationResult,
  FxConversionResult,
  FxRateProvider,
  ManagerNotificationChannel,
  SpeechToTextProvider,
  WorkingCalendarProvider
} from "./pipeline.contracts.js";
import type { MoneyCurrencyCode } from "./money-normalization.js";

const NBKR_DAILY_RATES_URL = "https://www.nbkr.kg/XML/daily.xml";
const NBKR_CACHE_TTL_MS = 30 * 60 * 1000;
const NBKR_FETCH_TIMEOUT_MS = 1_500;

@Injectable()
export class DeferredIntegrationsService implements SpeechToTextProvider, FxRateProvider, WorkingCalendarProvider, ManagerNotificationChannel {
  private fxFeedCache?: { fetchedAt: number; xml: string };
  private fxFeedPromise?: Promise<string | undefined>;

  async transcribe(): Promise<DeferredIntegrationResult<string>> { return { available: false, code: "SPEC_GAP_STT" }; }
  async convertToSom(input: { amount: number; currency: Exclude<MoneyCurrencyCode, "KGS"> }): Promise<FxConversionResult | DeferredIntegrationResult<number>> {
    try {
      const xml = await this.loadNbkrFeed();
      if (!xml) {
        return { available: false, code: "SPEC_GAP_FX" };
      }
      const rate = extractNbkrRate(xml, input.currency);
      if (!rate) {
        return { available: false, code: "SPEC_GAP_FX" };
      }

      return {
        available: true,
        value: Math.round(input.amount * rate.ratePerUnit),
        currency: input.currency,
        rate: rate.rate,
        nominal: rate.nominal,
        source: "NBKR",
        sourceUrl: NBKR_DAILY_RATES_URL,
        effectiveDate: rate.effectiveDate
      };
    } catch {
      return { available: false, code: "SPEC_GAP_FX" };
    }
  }
  async isWorkingTime(): Promise<DeferredIntegrationResult<boolean>> { return { available: false, code: "SPEC_GAP_CALENDAR" }; }
  async deliver(): Promise<DeferredIntegrationResult<void>> { return { available: false, code: "SPEC_GAP_MANAGER_DELIVERY" }; }

  private async loadNbkrFeed(): Promise<string | undefined> {
    const cached = this.fxFeedCache;
    if (cached && Date.now() - cached.fetchedAt < NBKR_CACHE_TTL_MS) {
      return cached.xml;
    }

    if (!this.fxFeedPromise) {
      this.fxFeedPromise = this.fetchNbkrFeed();
    }

    try {
      return await this.fxFeedPromise;
    } finally {
      this.fxFeedPromise = undefined;
    }
  }

  private async fetchNbkrFeed(): Promise<string | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NBKR_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(NBKR_DAILY_RATES_URL, {
        headers: { accept: "application/xml,text/xml" },
        signal: controller.signal
      });
      if (!response.ok) {
        return undefined;
      }

      const xml = await response.text();
      this.fxFeedCache = { xml, fetchedAt: Date.now() };
      return xml;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractNbkrRate(
  xml: string,
  currency: Exclude<MoneyCurrencyCode, "KGS">
): { rate: number; nominal: number; ratePerUnit: number; effectiveDate: string } | undefined {
  const currencyMatch = xml.match(new RegExp(`<Currency[^>]*ISOCode="${currency}"[^>]*>([\\s\\S]*?)<\\/Currency>`, "i"));
  if (!currencyMatch?.[1]) {
    return undefined;
  }

  const nominalValue = extractXmlTag(currencyMatch[1], "Nominal");
  const rateValue = extractXmlTag(currencyMatch[1], "Value");
  if (!nominalValue || !rateValue) {
    return undefined;
  }

  const nominal = Number(nominalValue.replace(",", "."));
  const rate = Number(rateValue.replace(",", "."));
  if (!Number.isFinite(nominal) || !Number.isFinite(rate) || nominal <= 0) {
    return undefined;
  }

  return {
    rate,
    nominal,
    ratePerUnit: rate / nominal,
    effectiveDate: extractNbkrDate(xml)
  };
}

function extractXmlTag(xml: string, tagName: string): string | undefined {
  return xml.match(new RegExp(`<${tagName}>([^<]+)<\\/${tagName}>`, "i"))?.[1]?.trim();
}

function extractNbkrDate(xml: string): string {
  const rawDate = xml.match(/\bDate="(\d{2})[./-](\d{2})[./-](\d{4})"/i);
  if (!rawDate) {
    return new Date().toISOString().slice(0, 10);
  }
  return `${rawDate[3]}-${rawDate[2]}-${rawDate[1]}`;
}
