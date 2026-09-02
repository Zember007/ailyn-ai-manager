import { describe, expect, it, vi } from "vitest";
import { KnowledgeBaseResolverService } from "./knowledge-base-resolver.service.js";

describe("KnowledgeBaseResolverService fallback", () => {
  it("marks the complete manager-contact fallback as blocked", async () => {
    const fallback = {
      key: "unknown_fallback",
      answerRu: "К сожалению, у меня нет достоверной информации по этому вопросу. Пожалуйста, позвоните менеджеру по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108 — сотрудники подскажут Вам."
    };
    const knowledge = {
      resolveAll: vi.fn().mockResolvedValue([]),
      fallback: vi.fn().mockResolvedValue(fallback)
    };
    const documentation = { resolve: vi.fn().mockReturnValue(undefined) };
    const resolver = new KnowledgeBaseResolverService(knowledge as any, documentation as any);

    const [answer] = await resolver.resolve([{ text: "Есть ли у вас вертолётная площадка?", topic: "general" }], "ru");

    expect(answer.text).toContain("+996 502 108 108");
    expect(answer.text).toContain("WhatsApp +996 776 108 108");
    expect(answer.blocked).toBe(true);
  });

  it("keeps a documentation answer when the same compound turn also matches knowledge", async () => {
    const knowledge = {
      resolveAll: vi.fn().mockResolvedValue([{
        key: "office_wifi_charging",
        answerRu: "Да, для посетителей доступен Wi-Fi.",
        answerKg: undefined
      }]),
      fallback: vi.fn()
    };
    const documentation = {
      resolve: vi.fn().mockReturnValue({
        key: "documentation_application_process",
        text: "Осмотр обычно занимает около 5 минут."
      })
    };
    const resolver = new KnowledgeBaseResolverService(knowledge as any, documentation as any);

    const answers = await resolver.resolve([{ text: "Есть Wi-Fi и как проходит осмотр?", topic: "general" }], "ru");

    expect(answers.map((answer) => answer.key)).toEqual(expect.arrayContaining([
      "office_wifi_charging",
      "documentation_application_process"
    ]));
    expect(knowledge.fallback).not.toHaveBeenCalled();
  });
});
