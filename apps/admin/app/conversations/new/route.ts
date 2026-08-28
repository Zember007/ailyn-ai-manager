import { postJson, type Stage1Conversation } from "../../lib/api";

export async function POST() {
  const conversation = await postJson<Stage1Conversation | null>("/conversations/web-test", {}, null);
  const location = conversation?.id ? `/conversations/${conversation.id}` : "/conversations";
  return new Response(null, {
    status: 303,
    headers: { Location: location }
  });
}
