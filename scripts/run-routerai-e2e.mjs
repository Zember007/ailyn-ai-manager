#!/usr/bin/env node

const apiUrl = (process.env.AILYN_API_URL ?? "http://localhost:3001/api").replace(/\/$/, "");
const runId = `routerai-e2e-${Date.now()}`;
const scenarioFilter = new Set(
  String(process.env.AILYN_E2E_SCENARIOS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const scenarios = [
  {
    id: "E2E-01-vague-residence",
    steps: [
      "Toyota Camry 2018, машина стоит 1.5 млн, хочу 500к",
      "без изъятия",
      "Прописка городская"
    ],
    includes: ["Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?"],
    excludes: ["Какая прописка у собственника автомобиля?"]
  },
  {
    id: "E2E-02-bishkek-limit-documents",
    steps: [
      "Toyota Camry 2018, машина стоит 1.5 млн, хочу 500к",
      "без изъятия",
      "Бишкек"
    ],
    includes: ["Предварительно возможная сумма", "600", "Окончательная сумма определяется после осмотра автомобиля и проверки документов", "Пришлите, пожалуйста, фото"]
  },
  {
    id: "E2E-03-parking-cap",
    steps: [
      "Toyota Land Cruiser 2020, стоит 5 млн, хочу 3 млн",
      "на стоянку",
      "Бишкек"
    ],
    includes: ["Предварительно возможная сумма", "2", "000", "Окончательная сумма определяется после осмотра автомобиля и проверки документов"]
  },
  {
    id: "E2E-04-region-10-refusal",
    steps: ["Toyota Camry 2018, регион 10, машина стоит 1 млн, хочу 300к"],
    includes: ["По автомобилям с регионом 10 компания займ не оформляет."]
  },
  {
    id: "E2E-05-motorcycle-refusal",
    steps: ["Хочу займ под мото, стоит 300к"],
    includes: ["только под легковые автомобили и минивэны"]
  },
  {
    id: "E2E-06-other-region-guarantor",
    steps: [
      "Toyota Camry 2019, машина стоит 1.5 млн, хочу 500к",
      "без изъятия",
      "Ош"
    ],
    includes: ["нужен поручитель от 25 лет", "ID или паспорт"]
  },
  {
    id: "E2E-07-no-guarantor-parking-offer",
    steps: [
      "Toyota Camry 2019, машина стоит 1.5 млн, хочу 500к",
      "без изъятия",
      "Ош",
      "поручителя нет"
    ],
    includes: ["Без поручителя оформление без изъятия продолжить нельзя", "охраняемую стоянку"]
  },
  {
    id: "E2E-08-documents-declined-family-status",
    steps: [
      "Toyota Camry 2018, машина стоит 1.5 млн, хочу 500к",
      "без изъятия",
      "Бишкек",
      "Не могу сейчас отправить фото документов"
    ],
    includes: ["собственник автомобиля состоит в браке"]
  },
  {
    id: "E2E-09-married-no-consent",
    steps: [
      "Toyota Camry 2018, машина стоит 1.5 млн, хочу 500к",
      "без изъятия",
      "Бишкек",
      "Не могу сейчас отправить фото документов",
      "Я женат, согласие не готово"
    ],
    includes: ["оригинал нотариального согласия", "когда нотариальное согласие будет готово"]
  },
  {
    id: "E2E-10-existing-contract-payment",
    steps: ["Я оплатил, проверьте оплату по действующему договору"],
    includes: ["+996 502 108 108", "+996 776 108 108"]
  }
].filter((scenario) => scenarioFilter.size === 0 || scenarioFilter.has(scenario.id));

await assertApiHealth();
const results = [];

for (const scenario of scenarios) {
  const conversation = await postJson("/conversations/web-test", {
    externalContactId: `${runId}-${scenario.id}`,
    externalConversationId: `${runId}-${scenario.id}`
  });
  let lastResponse;
  for (const message of scenario.steps) {
    lastResponse = await postJson("/messages/test-chat", {
      conversationId: conversation.id,
      message
    });
    assertRouterAiResponse(scenario.id, lastResponse);
  }

  const reply = normalizeReply(lastResponse.reply);
  for (const expected of scenario.includes ?? []) {
    if (!reply.includes(normalizeReply(expected))) {
      throw new Error(`${scenario.id}: expected reply to include "${expected}", got: ${lastResponse.reply}`);
    }
  }
  for (const forbidden of scenario.excludes ?? []) {
    if (reply.includes(normalizeReply(forbidden))) {
      throw new Error(`${scenario.id}: expected reply not to include "${forbidden}", got: ${lastResponse.reply}`);
    }
  }
  results.push({
    id: scenario.id,
    conversationId: conversation.id,
    routerAiModel: lastResponse.routerAiModel,
    promptVersion: lastResponse.promptVersion,
    reply: lastResponse.reply
  });
  console.log(`PASS ${scenario.id} model=${lastResponse.routerAiModel}`);
}

console.log(JSON.stringify({ apiUrl, runId, passed: results.length, results }, null, 2));

async function assertApiHealth() {
  const health = await getJson("/health");
  if (health.status !== "ok") {
    throw new Error(`API health is not ok: ${JSON.stringify(health)}`);
  }
}

function assertRouterAiResponse(scenarioId, response) {
  if (!response.validation?.passed) {
    throw new Error(`${scenarioId}: response validation failed: ${JSON.stringify(response.validation)}`);
  }
  if (!response.routerAiModel || /fallback|local/i.test(response.routerAiModel)) {
    throw new Error(`${scenarioId}: expected RouterAI model, got ${response.routerAiModel}`);
  }
  if (response.promptVersion !== "stage1-routerai-v1") {
    throw new Error(`${scenarioId}: expected stage1-routerai-v1, got ${response.promptVersion}`);
  }
}

async function getJson(path) {
  const response = await fetch(`${apiUrl}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function normalizeReply(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}
