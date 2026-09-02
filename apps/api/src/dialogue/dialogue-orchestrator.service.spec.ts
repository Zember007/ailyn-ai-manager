import { describe, expect, it, vi } from "vitest";
import { AgentTurnService } from "./agent-turn.service.js";
import { DialogueOrchestratorService } from "./dialogue-orchestrator.service.js";

const validResult = {
  reply: "Подскажите, пожалуйста, модель и год выпуска автомобиля.", language: "ru", intent: "new_loan", leadCardPatch: { vehicleMake: "Toyota", vehicleYear: 2020 }, cardSummary: "Toyota 2020, ожидаются остальные данные.",
  dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "Запросить стоимость" }, targetEvent: null,
  managerUpdate: { kind: "none", changedFields: [] }, attachments: []
};

describe("single-agent dialogue", () => {
  it("uses one multimodal model call with full history and knowledge", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ model: "one-model", choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    const service = new AgentTurnService(client);
    const output = await service.run({ messages: [{ author: "client", body: "Старая реплика", createdAt: "2026-01-01" } as any], facts: { fullName: "Иван" }, settings: { parkingInterestRate: 2.4 }, text: "Toyota 2020", attachments: [{ id: "photo", mimeType: "image/jpeg", contentBase64: "abc" }] });
    expect(output.result).toEqual(validResult);
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    const request = client.createChatCompletion.mock.calls[0][0];
    expect(request.model).toBe(process.env.ROUTERAI_TEXT_MODEL ?? "routerai-text-model-not-configured");
    expect(JSON.stringify(request.messages)).toContain("Старая реплика");
    expect(JSON.stringify(request.messages)).toContain("docx_0001");
    expect(request.messages[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
  });

  it("does not expose an invalid model payload as a card update", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: { arbitrary: true } }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "test", attachments: [] });
    expect(output.result).toBeUndefined();
    expect(output.reply).toContain("не удалось обработать");
  });

  it("persists a validated patch and preserves the public result shape", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "Toyota", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["vehicleMake", "vehicleYear"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn().mockResolvedValue({ result: validResult, reply: validResult.reply, model: "one-model", promptVersion: "single-agent-v1" }) } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
    const result = await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "Toyota", attachments: [], timestamp: new Date() });
    expect(store.updateFacts).toHaveBeenCalledWith(application, validResult.leadCardPatch);
    expect(store.saveAgentState).toHaveBeenCalledWith(application, expect.objectContaining({ cardSummary: validResult.cardSummary }));
    expect(result).toEqual(expect.objectContaining({ reply: validResult.reply, application, conversation, validation: { passed: true, errors: [] } }));
  });

  it("creates exactly one initial manager card after the target event", async () => {
    const target = { ...validResult, targetEvent: "documents", managerUpdate: { kind: "initial" as const, changedFields: [] } };
    const application = { id: "app", facts: {}, contactId: "contact" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn().mockResolvedValue(true) } as any;
    const service = new DialogueOrchestratorService({ run: vi.fn().mockResolvedValue({ result: target, reply: target.reply, model: "one", promptVersion: "v1" }) } as any, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
    await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", attachments: [], timestamp: new Date() });
    expect(store.createManagerNotification).toHaveBeenCalledWith(application, "initial", expect.objectContaining({ event: "documents" }));
    expect(store.updateFacts).toHaveBeenLastCalledWith(application, { handedToManager: true });
  });
});
