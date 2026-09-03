import { describe, expect, it } from "vitest";
import { detectMoneyMentions, resolveMoneyFacts } from "./money-normalization.js";

describe("money normalization", () => {
  it("parses mixed requested amount and vehicle value from free-form text", () => {
    const result = resolveMoneyFacts({
      text: "камри 2010 года надо 10 тыс долларов стоит 20 тыс",
      currentFacts: {}
    });

    expect(result.mentions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceText: "10 тыс долларов", currency: "USD", roleCandidate: "requestedAmount", normalizedAmount: 10_000 }),
      expect.objectContaining({ sourceText: "20 тыс", currency: null, roleCandidate: "vehicleValue", normalizedAmount: 20_000 })
    ]));
    expect(result.requestedAmount).toBe(10_000);
    expect(result.requestedAmountCurrency).toBe("USD");
    expect(result.vehicleValue).toBe(20_000);
    expect(result.vehicleValueCurrency).toBeUndefined();
  });

  it("supports spaced, compact, suffix, and decimal money formats", () => {
    expect(detectMoneyMentions("нужно 10 000, можно и 10000, бывает 10к и 10 k, машина стоит 1.5 млн или 250.000сом")).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceText: "10 000", normalizedAmount: 10_000 }),
      expect.objectContaining({ sourceText: "10000", normalizedAmount: 10_000 }),
      expect.objectContaining({ sourceText: "10к", normalizedAmount: 10_000 }),
      expect.objectContaining({ sourceText: "10 k", normalizedAmount: 10_000 }),
      expect.objectContaining({ sourceText: "1.5 млн", normalizedAmount: 1_500_000 }),
      expect.objectContaining({ sourceText: "250.000сом", normalizedAmount: 250_000, currency: "KGS" })
    ]));
  });

  it("keeps the multiplier and currency in a compact foreign amount", () => {
    expect(detectMoneyMentions("Перепутал цену, мне нужно 10 к долларов")).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceText: "10 к долларов", normalizedAmount: 10_000, currency: "USD" })
    ]));
  });

  it("falls back to larger-as-value smaller-as-requested for two ambiguous amounts", () => {
    const result = resolveMoneyFacts({
      text: "500 тыс и 1.2 млн",
      currentFacts: {}
    });

    expect(result.requestedAmount).toBe(500_000);
    expect(result.vehicleValue).toBe(1_200_000);
  });

  it("uses the remaining missing fact for a short standalone reply", () => {
    const amountOnly = resolveMoneyFacts({
      text: "400 тыс",
      currentFacts: { vehicleValue: 1_000_000 }
    });
    const valueOnly = resolveMoneyFacts({
      text: "2 000 000 руб",
      currentFacts: { vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2018 }
    });

    expect(amountOnly.requestedAmount).toBe(400_000);
    expect(amountOnly.requestedAmountCurrency).toBeUndefined();
    expect(valueOnly.vehicleValue).toBe(2_000_000);
    expect(valueOnly.vehicleValueCurrency).toBe("RUB");
  });

  it("does not reuse an explicitly requested amount as the vehicle value", () => {
    const result = resolveMoneyFacts({
      text: "хочу оставить камри под залог, нужно около 6 тысяч долларов",
      currentFacts: {}
    });

    expect(result.requestedAmount).toBe(6_000);
    expect(result.requestedAmountCurrency).toBe("USD");
    expect(result.vehicleValue).toBeUndefined();
    expect(result.vehicleValueCurrency).toBeUndefined();
  });

  it("uses pending facts and correction cues instead of freezing the first saved amount", () => {
    const pendingAmount = resolveMoneyFacts({
      text: "800 тысяч",
      currentFacts: { vehicleValue: 1_700_000 },
      pendingFacts: ["requestedAmount"]
    });
    const correctedAmount = resolveMoneyFacts({
      text: "нет, теперь нужно 450 000",
      currentFacts: { vehicleValue: 1_500_000, requestedAmount: 300_000 }
    });
    const ambiguousWithPendingValue = resolveMoneyFacts({
      text: "10",
      currentFacts: { requestedAmount: 100_000 },
      pendingFacts: ["vehicleValue"]
    });

    expect(pendingAmount.requestedAmount).toBe(800_000);
    expect(correctedAmount.requestedAmount).toBe(450_000);
    expect(ambiguousWithPendingValue.vehicleValue).toBeUndefined();
  });

  it("inherits currency and thousand multiplier only inside the same money clause", () => {
    const result = resolveMoneyFacts({
      text: "Камри 2022 стоит 20 тыс долларов, надо 10",
      currentFacts: {}
    });
    const compactCyrillic = resolveMoneyFacts({
      text: "камри 2023 стоит 21 к долларов надо 10",
      currentFacts: {}
    });
    const ambiguous = resolveMoneyFacts({ text: "надо 10", currentFacts: {} });

    expect(result.vehicleValue).toBe(20_000);
    expect(result.vehicleValueCurrency).toBe("USD");
    expect(result.requestedAmount).toBe(10_000);
    expect(result.requestedAmountCurrency).toBe("USD");
    expect(compactCyrillic.vehicleValue).toBe(21_000);
    expect(compactCyrillic.vehicleValueCurrency).toBe("USD");
    expect(compactCyrillic.requestedAmount).toBe(10_000);
    expect(compactCyrillic.requestedAmountCurrency).toBe("USD");
    expect(ambiguous.requestedAmount).toBeUndefined();
  });

  it("assigns a standalone approximate price to the only pending money field", () => {
    const result = resolveMoneyFacts({
      text: "примерно 200000 сом",
      currentFacts: { requestedAmount: 100_000 },
      pendingFacts: ["vehicleValue"]
    });

    expect(result.vehicleValue).toBe(200_000);
    expect(result.requestedAmount).toBeUndefined();
  });
});
