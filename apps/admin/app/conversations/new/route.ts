import { postAction, type Stage1Conversation } from "../../lib/api";

export async function POST() {
  const result = await postAction<Stage1Conversation>("/conversations/web-test", {});
  const location = result.ok && result.data?.id
    ? `/conversations/${result.data.id}?notice=conversation_created`
    : `/conversations?error=${result.status === 0 ? "api_unavailable" : "conversation_create_failed"}`;
  return new Response(null, {
    status: 303,
    headers: { Location: location }
  });
}
