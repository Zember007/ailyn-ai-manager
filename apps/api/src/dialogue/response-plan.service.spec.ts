import { describe, expect, it } from "vitest";
import { evaluateApplication } from "@ailyn/business-rules";
import { ResponsePlanService } from "./response-plan.service.js";

describe("ResponsePlanService first contact", () => {
  it("uses the approved full first-contact block when no data is known", () => {
    const service = new ResponsePlanService();
    const plan = service.build({ facts: {}, decision: evaluateApplication({}), isFirstMessage: true, questions: [] });
    expect(plan.nextQuestions).toEqual([
      "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.\n\nПодскажите, пожалуйста:\n- модель и год выпуска автомобиля;\n- ориентировочную стоимость автомобиля;\n- какая сумма займа Вам необходима?"
    ]);
  });

  it("does not ask first-contact facts that are already provided", () => {
    const service = new ResponsePlanService();
    const facts = { vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2021, vehicleValue: 1_500_000, requestedAmount: 500_000 } as const;
    const plan = service.build({ facts, decision: evaluateApplication(facts), isFirstMessage: true, questions: [] });
    expect(plan.nextQuestions[0]).toContain("без изъятия автомобиля");
    expect(plan.nextQuestions[0]).not.toContain("Здравствуйте!");
  });
});
