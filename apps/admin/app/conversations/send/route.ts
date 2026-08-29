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

  const result = await postMultipartAction("/messages/test-chat", payload);
  if (!result.ok) {
    return Response.json(
      {
        error: result.error ?? "message_send_failed",
        status: result.status
      },
      { status: result.status || 500 }
    );
  }

  return Response.json(result.data, { status: 200 });
}
