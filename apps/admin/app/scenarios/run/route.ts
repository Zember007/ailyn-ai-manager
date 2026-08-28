import { postAction, type ScenarioRun } from "../../lib/api";

export async function POST(request: Request) {
  const form = await request.formData();
  const category = String(form.get("category") ?? "");
  const run = await postAction<ScenarioRun>("/scenarios/run", category ? { category } : {});
  return new Response(null, {
    status: 303,
    headers: {
      Location: run.ok && run.data?.id
        ? `/scenarios/runs/${run.data.id}?notice=scenarios_started`
        : `/scenarios?error=${run.status === 0 ? "api_unavailable" : "scenario_run_failed"}`
    }
  });
}
