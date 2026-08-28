import { postAction } from "../../lib/api";

export async function POST(request: Request) {
  const form = await request.formData();
  const conversationId = String(form.get("conversationId") ?? "");
  const message = String(form.get("message") ?? "");
  const kindHint = String(form.get("kindHint") ?? "").trim();
  const fileName = String(form.get("fileName") ?? "").trim();
  const result = await postAction("/messages/test-chat", {
    conversationId,
    message,
    attachments: kindHint ? [{ kindHint, fileName: fileName || kindHint }] : []
  });

  const location = result.ok
    ? `/conversations/${conversationId}?notice=message_sent`
    : `/conversations/${conversationId}?error=${result.status === 0 ? "api_unavailable" : "message_send_failed"}`;

  return new Response(null, {
    status: 303,
    headers: { Location: location }
  });
}
