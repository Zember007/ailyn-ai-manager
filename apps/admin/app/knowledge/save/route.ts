import { postAction } from "../../lib/api";

export async function POST(request: Request) {
  const form = await request.formData();
  const result = await postAction("/knowledge", {
    key: String(form.get("key") ?? ""),
    category: String(form.get("category") ?? "general"),
    aliases: String(form.get("aliases") ?? "").split(",").map((alias) => alias.trim()).filter(Boolean),
    answerRu: String(form.get("answerRu") ?? ""),
    priority: Number(form.get("priority") ?? 0),
    status: String(form.get("status") ?? "draft"),
    active: form.get("active") === "on"
  });
  return new Response(null, {
    status: 303,
    headers: {
      Location: result.ok
        ? "/knowledge?notice=knowledge_saved"
        : `/knowledge?error=${result.status === 0 ? "api_unavailable" : "knowledge_save_failed"}`
    }
  });
}
