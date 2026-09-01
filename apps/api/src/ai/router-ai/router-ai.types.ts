export interface RouterAiChatMessage {
  role: "system" | "user" | "assistant";
  content: string | RouterAiContentPart[];
}

export type RouterAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

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
