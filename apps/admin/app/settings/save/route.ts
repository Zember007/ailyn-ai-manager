import { patchAction } from "../../lib/api";

export async function POST(request: Request) {
  const form = await request.formData();
  const patch: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("__")) continue;
    const type = String(form.get(`__type:${key}`) ?? "text");
    patch[key] = type === "number" ? Number(value) : String(value);
  }
  const result = await patchAction("/settings", patch);
  return new Response(null, {
    status: 303,
    headers: {
      Location: result.ok
        ? "/settings?notice=settings_saved"
        : `/settings?error=${result.status === 0 ? "api_unavailable" : "settings_save_failed"}`
    }
  });
}
