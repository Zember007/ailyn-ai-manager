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
  response_format?:
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
  structured_outputs?: boolean;
}

export interface RouterAiChatResponse {
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      /** Present when a model declines structured output instead of content. */
      refusal?: string | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }[];
  model?: string;
  [key: string]: unknown;
}
