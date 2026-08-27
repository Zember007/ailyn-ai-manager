import { postJson } from "../../lib/api.js";

export async function POST(request: Request) {
  const form = await request.formData();
  const conversationId = String(form.get("conversationId") ?? "");
  const message = String(form.get("message") ?? "");
  const kindHint = String(form.get("kindHint") ?? "").trim();
  const fileName = String(form.get("fileName") ?? "").trim();
  await postJson("/messages/test-chat", {
    conversationId,
    message,
    attachments: kindHint ? [{ kindHint, fileName: fileName || kindHint }] : []
  }, null);
  return Response.redirect(new URL(`/conversations/${conversationId}`, request.url), 303);
}
