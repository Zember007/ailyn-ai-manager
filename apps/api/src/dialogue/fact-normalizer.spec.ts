import { describe, expect, it } from "vitest";
import { normalizeTurnFacts } from "./fact-normalizer.js";

describe("normalizeTurnFacts", () => {
  it("retains a vague city residence reply and asks for a specific location", () => {
    expect(
      normalizeTurnFacts({
        text: "Прописка городская",
        pendingFacts: ["residenceRegion"],
        currentFacts: {}
      })
    ).toEqual({
      residenceText: "городская",
      residenceNeedsClarification: true
    });
  });

  it("normalizes an explicit Bishkek residence while preserving the client wording", () => {
    expect(
      normalizeTurnFacts({
        text: "Собственник прописан в Бишкеке",
        pendingFacts: ["residenceRegion"],
        currentFacts: {}
      })
    ).toEqual({
      residenceText: "Бишкек",
      residenceRegion: "Бишкек",
      residenceCategory: "BISHKEK",
      residenceNeedsClarification: false
    });
  });

  it("does not treat an unrelated use of the word city as a residence answer", () => {
    expect(
      normalizeTurnFacts({
        text: "Где у вас офис в городе?",
        pendingFacts: ["requestedAmount"],
        currentFacts: {}
      })
    ).toEqual({});
  });

  it("maps an owner residence reply into the regional decision fields", () => {
    expect(normalizeTurnFacts({
      text: "В Оше",
      pendingFacts: ["ownerResidenceRegion"],
      currentFacts: { borrowerIsOwner: false }
    })).toEqual({
      ownerResidenceRegion: "Ош",
      residenceText: "Ош",
      residenceRegion: "Ош",
      residenceCategory: "OTHER_KG",
      residenceNeedsClarification: false
    });
  });

  it("captures married status and missing spouse consent deterministically", () => {
    expect(normalizeTurnFacts({
      text: "Я женат, согласие не готово",
      pendingFacts: ["familyStatus"],
      currentFacts: {}
    })).toEqual({
      familyStatus: "married",
      spouseConsentReady: false
    });
  });

  it("captures a short parking programme answer deterministically", () => {
    expect(normalizeTurnFacts({
      text: "на стоянку",
      pendingFacts: ["requestedProgram"],
      currentFacts: {}
    })).toEqual({
      requestedProgram: "parking"
    });
  });

  it("captures a document-photo refusal deterministically", () => {
    expect(normalizeTurnFacts({
      text: "Не могу сейчас отправить фото документов",
      pendingFacts: ["id_front", "id_back"],
      currentFacts: {}
    })).toEqual({
      declinedDocuments: true
    });
  });

  it("extracts explicit borrower full name and phone from free text", () => {
    expect(normalizeTurnFacts({
      text: "Меня зовут Иванов Иван Иванович, мой номер +996 555 123 456",
      pendingFacts: [],
      currentFacts: {}
    })).toEqual({
      fullName: "Иванов Иван Иванович",
      phone: "+996555123456"
    });
  });

  it("extracts critical first-message vehicle facts for a region-10 refusal", () => {
    expect(normalizeTurnFacts({
      text: "Меня зовут Иванов Иван Иванович, телефон +996 555 123 456. Toyota Camry 2018, регион 10, машина стоит 1.5 млн, хочу 500к",
      pendingFacts: [],
      currentFacts: {}
    })).toEqual(expect.objectContaining({
      fullName: "Иванов Иван Иванович",
      phone: "+996555123456",
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2018,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      vehicleRegistrationRegion: "10"
    }));
  });

  it("extracts motorcycle collateral as an unsupported vehicle type", () => {
    expect(normalizeTurnFacts({
      text: "Меня зовут Иванов Иван Иванович. Хочу займ под мото, стоит 300к",
      pendingFacts: [],
      currentFacts: {}
    })).toEqual(expect.objectContaining({
      vehicleType: "motorcycle",
      vehicleValue: 300_000
    }));
  });
});
