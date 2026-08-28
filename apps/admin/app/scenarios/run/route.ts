import { postJson, type ScenarioRun } from "../../lib/api";

export async function POST(request: Request) {
  const form = await request.formData();
  const category = String(form.get("category") ?? "");
  const run = await postJson<ScenarioRun | null>("/scenarios/run", category ? { category } : {}, null);
  return new Response(null, {
    status: 303,
    headers: { Location: run?.id ? `/scenarios/runs/${run.id}` : "/scenarios" }
  });
}
