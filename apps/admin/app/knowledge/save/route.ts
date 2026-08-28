import { postJson } from "../../lib/api";

export async function POST(request: Request) {
  const form = await request.formData();
  await postJson("/knowledge", {
    key: String(form.get("key") ?? ""),
    category: String(form.get("category") ?? "general"),
    aliases: String(form.get("aliases") ?? "").split(",").map((alias) => alias.trim()).filter(Boolean),
    answerRu: String(form.get("answerRu") ?? ""),
    priority: Number(form.get("priority") ?? 0),
    status: String(form.get("status") ?? "draft"),
    active: form.get("active") === "on"
  }, null);
  return Response.redirect(new URL("/knowledge", request.url), 303);
}
