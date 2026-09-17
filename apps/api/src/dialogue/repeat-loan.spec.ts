import { describe, expect, it } from "vitest";
import { nextRequiredStageQuestion } from "./agent-turn.service.js";
import { isRepeatLoanRequest, persistentClientFacts } from "./repeat-loan.js";

describe("repeat-loan helpers", () => {
  it("recognizes a request for a new loan after repayment", () => {
    expect(isRepeatLoanRequest("Хочу снова займ под ту же машину")).toBe(true);
    expect(isRepeatLoanRequest("я снова хочу взять займ под ту же машину")).toBe(true);
    expect(isRepeatLoanRequest("Я выкупился и снова нужны деньги")).toBe(true);
    expect(isRepeatLoanRequest("Выкупил машину три дня назад")).toBe(true);
    expect(isRepeatLoanRequest("Займ снова дадите?")).toBe(true);
    expect(isRepeatLoanRequest("нужен новый займ")).toBe(true);
    expect(isRepeatLoanRequest("я могу новый займ оформить, уже расплатился")).toBe(true);
  });

  it("does not treat a service request for an active contract as a repeat loan", () => {
    expect(isRepeatLoanRequest("Где оплатить действующий займ?")).toBe(false);
    expect(isRepeatLoanRequest("У меня GPS не работает")).toBe(false);
  });

  it("keeps only durable client facts and ID documents", () => {
    expect(persistentClientFacts({
      fullName: "Иванов Иван Иванович",
      phone: "+996555000000",
      residenceRegion: "Бишкек",
      residenceText: "Бишкек",
      residenceCategory: "BISHKEK_CHUY",
      familyStatus: "single",
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2018,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage",
      visitDate: "2026-09-18",
      visitTime: "15:00",
      documents: {
        id_front: "received",
        id_back: "received",
        vehicle_registration_front: "received",
        vehicle_registration_back: "received",
        car_photo: "received"
      }
    })).toEqual({
      fullName: "Иванов Иван Иванович",
      phone: "+996555000000",
      residenceRegion: "Бишкек",
      residenceText: "Бишкек",
      residenceCategory: "BISHKEK_CHUY",
      familyStatus: "single",
      documents: { id_front: "received", id_back: "received" }
    });
  });

  it("asks for current STS without asking again for a saved ID", () => {
    const question = nextRequiredStageQuestion({
      vehicleModel: "Camry",
      vehicleYear: 2018,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "parking",
      residenceRegion: "Бишкек",
      residenceCategory: "BISHKEK_CHUY",
      familyStatus: "single",
      documents: { id_front: "received", id_back: "received" }
    });

    expect(question).toContain("свидетельство о регистрации автомобиля с обеих сторон");
    expect(question).not.toContain("фото ID");
  });
});
