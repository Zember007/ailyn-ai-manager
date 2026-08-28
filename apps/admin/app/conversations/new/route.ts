import { postJson, type Stage1Conversation } from "../../lib/api";

export async function POST(request: Request) {
  const conversation = await postJson<Stage1Conversation | null>("/conversations/web-test", {}, null);
  const url = new URL(conversation?.id ? `/conversations/${conversation.id}` : "/conversations", request.url);
  return Response.redirect(url, 303);
}
