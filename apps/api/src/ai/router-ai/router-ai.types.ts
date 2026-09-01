export interface RouterAiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RouterAiChatRequest {
  model: string;
  messages: RouterAiChatMessage[];
  temperature?: number;
  max_tokens?: number;
  reasoning?: { enabled: boolean };
  response_format?: { type: "json_object" };
}

export interface RouterAiChatResponse {
  choices?: { message?: { content?: string } }[];
  model?: string;
}
