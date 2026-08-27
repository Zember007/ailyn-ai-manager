import { postJson, type ScenarioRun } from "../../lib/api.js";

export async function POST(request: Request) {
  const form = await request.formData();
  const category = String(form.get("category") ?? "");
  const run = await postJson<ScenarioRun | null>("/scenarios/run", category ? { category } : {}, null);
  return Response.redirect(new URL(run?.id ? `/scenarios/runs/${run.id}` : "/scenarios", request.url), 303);
}
