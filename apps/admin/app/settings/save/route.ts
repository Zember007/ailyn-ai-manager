import { patchJson } from "../../lib/api";

export async function POST(request: Request) {
  const form = await request.formData();
  const patch: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("__")) continue;
    const type = String(form.get(`__type:${key}`) ?? "text");
    patch[key] = type === "number" ? Number(value) : String(value);
  }
  await patchJson("/settings", patch, null);
  return Response.redirect(new URL("/settings", request.url), 303);
}
