import { AdminShell, Panel } from "../../components";
import { getSearchParamValue, readQuery, toFeedbackMessage, type Stage1Conversation } from "../../lib/api";
import { ConversationWorkspace } from "./conversation-workspace";

export default async function ConversationDetailPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const resolvedParams = await params;
  const conversationResult = await readQuery<Stage1Conversation | { error: string }>(`/conversations/${resolvedParams.id}`, { error: "not_found" });
  const conversation = conversationResult.data;
  const query = (await searchParams) ?? {};
  const feedback = toFeedbackMessage(getSearchParamValue(query.notice) ?? getSearchParamValue(query.error) ?? conversationResult.error);

  if ("error" in conversation) {
    return (
      <AdminShell title="Диалог не найден">
        <Panel title="Нет данных">
          <p className="muted">Такой диалог не найден.</p>
        </Panel>
      </AdminShell>
    );
  }

  return (
    <AdminShell fullWidth title="Диалог" eyebrow={conversation.externalContactId || conversation.id}>
      <ConversationWorkspace initialConversation={conversation} initialFeedback={feedback} />
    </AdminShell>
  );
}
