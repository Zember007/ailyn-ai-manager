import { postMultipartAction } from "../../lib/api";

export async function POST(request: Request) {
  const form = await request.formData();
  const conversationId = String(form.get("conversationId") ?? "");
  const payload = new FormData();
  payload.set("conversationId", conversationId);
  payload.set("message", String(form.get("message") ?? ""));

  for (const value of form.getAll("files")) {
    if (value instanceof File && value.size > 0) {
      payload.append("files", value, value.name);
    }
  }

  const result = await postMultipartAction<{ conversationId?: string }>("/messages/test-chat", payload);
  const locationConversationId = result.data?.conversationId || conversationId;

  const location = result.ok
    ? `/conversations/${locationConversationId}?notice=message_sent`
    : `/conversations/${locationConversationId}?error=${result.status === 0 ? "api_unavailable" : result.error ?? "message_send_failed"}`;

  return new Response(null, {
    status: 303,
    headers: { Location: location }
  });
}
