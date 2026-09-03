import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentTurnService } from "./agent-turn.service.js";

beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
  process.env.REDIS_URL ??= "redis://localhost:6379";
});

const baseResult = {
  reply: "Подскажите, пожалуйста, следующий шаг.",
  language: "ru",
  intent: "continue_application",
  leadCardPatch: {},
  cardSummary: "Тестовая заявка",
  dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" },
  targetEvent: null,
  managerUpdate: { kind: "none", changedFields: [] },
  attachments: []
};

describe("single-agent runtime regressions", () => {
  it("recovers from a generic parking cap and uses the 950k personal limit after a program switch", async () => {
    const wrong = {
      ...baseResult,
      reply: "По программе со стоянкой для Ваших данных предварительно доступно до 2 000 000 сом. Пожалуйста, отправьте ID и СТС.",
      leadCardPatch: { requestedProgram: "parking" },
      preliminaryLimit: 2_000_000
    };
    const corrected = {
      ...baseResult,
      reply: "По программе со стоянкой для Ваших данных предварительно доступно до 950 000 сом. Пожалуйста, отправьте ID и СТС.",
      leadCardPatch: { requestedProgram: "parking" },
      preliminaryLimit: 950_000
    };
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ model: "main", choices: [{ message: { content: JSON.stringify(wrong) } }] })
        .mockResolvedValueOnce({ model: "main", choices: [{ message: { content: JSON.stringify(corrected) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Какая программа Вам удобнее?", createdAt: "now" } as any],
      facts: {
        vehicleMake: "Omoda",
        vehicleYear: 2009,
        vehicleValue: 1_900_000,
        requestedAmount: 650_000,
        requestedProgram: "without_storage",
        residenceRegion: "Бостери",
        residenceCategory: "OTHER_KG",
        guarantorAvailable: true
      },
      settings: {},
      text: "Тогда со стоянкой",
      attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.error).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedProgram).toBe("parking");
    expect(output.result?.preliminaryLimit).toBe(950_000);
    expect(output.reply).toContain("950 000");
    expect(client.createChatCompletion.mock.calls[1][0].messages[0].content).toContain("expected:950000");
  });

  it("retries when the model tries to request documents before residence", async () => {
    const skippedResidence = {
      ...baseResult,
      reply: "Теперь отправьте фотографии ID и СТС.",
      leadCardPatch: { requestedProgram: "without_storage" },
      dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" }
    };
    const fixed = {
      ...baseResult,
      reply: "Подскажите, пожалуйста, Ваша прописка в Бишкеке, Чуйской области или в другом регионе Кыргызстана?",
      leadCardPatch: { requestedProgram: "without_storage" },
      dialogueState: { stage: "COLLECTING_RESIDENCE", status: "need_more_data", nextAction: "collect_residence" }
    };
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ model: "main", choices: [{ message: { content: JSON.stringify(skippedResidence) } }] })
        .mockResolvedValueOnce({ model: "main", choices: [{ message: { content: JSON.stringify(fixed) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "without_storage" },
      settings: {},
      text: "без изъятия",
      attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.error).toBeUndefined();
    expect(output.result?.dialogueState.stage).toBe("COLLECTING_RESIDENCE");
    expect(output.reply).toContain("прописка");
  });

  it("treats no after optional car photos as a refusal and does not ask for them again", async () => {
    const reasksPhotos = {
      ...baseResult,
      reply: "Если есть возможность, отправьте 2–3 фотографии автомобиля. Когда Вам удобно приехать?",
      leadCardPatch: {},
      preliminaryLimit: 500_000,
      dialogueState: { stage: "SCHEDULING_VISIT", status: "continue", nextAction: "schedule_visit" }
    };
    const fixed = {
      ...baseResult,
      reply: "Подскажите, пожалуйста, Вы состоите в браке?",
      leadCardPatch: { declinedCarPhoto: true },
      preliminaryLimit: 500_000,
      dialogueState: { stage: "COLLECTING_FAMILY_STATUS", status: "need_more_data", nextAction: "collect_family_status" }
    };
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ model: "main", choices: [{ message: { content: JSON.stringify(reasksPhotos) } }] })
        .mockResolvedValueOnce({ model: "main", choices: [{ message: { content: JSON.stringify(fixed) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Если есть возможность, пожалуйста, отправьте также 2–3 фотографии автомобиля.", createdAt: "now" } as any],
      facts: {
        vehicleMake: "Toyota",
        vehicleYear: 2022,
        vehicleValue: 1_000_000,
        requestedAmount: 300_000,
        requestedProgram: "parking",
        residenceRegion: "Бишкек",
        residenceCategory: "BISHKEK",
        documents: {
          id_front: "received",
          id_back: "received",
          vehicle_registration_front: "received",
          vehicle_registration_back: "received"
        }
      },
      settings: {},
      text: "нет",
      attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.error).toBeUndefined();
    expect(output.result?.leadCardPatch.declinedCarPhoto).toBe(true);
    expect(output.result?.dialogueState.stage).toBe("COLLECTING_FAMILY_STATUS");
    expect(output.reply).not.toMatch(/фотограф|фото автомобиля/u);
  });
});
