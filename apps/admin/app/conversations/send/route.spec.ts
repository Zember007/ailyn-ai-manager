import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route.js";

describe("conversations/send route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns json from the backend instead of redirecting after a successful send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            conversationId: "conv-123",
            reply: "Здравствуйте",
            persisted: true,
            conversation: {
              id: "conv-123",
              messages: [{ id: "m-1", author: "client", body: "test", createdAt: "2026-08-29T00:00:00.000Z", attachmentIds: [], attachments: [] }]
            },
            application: { id: "app-123" },
            validation: { passed: true, errors: [] },
            routerAiModel: "local-stage1-fallback",
            promptVersion: "stage1-local-v1"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      )
    );
    const form = new FormData();
    form.set("conversationId", "conv-123");
    form.set("message", "test");

    const response = await POST(
      new Request("http://localhost/conversations/send", {
        method: "POST",
        body: form
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      conversationId: "conv-123",
      reply: "Здравствуйте",
      persisted: true
    });
  });

  it("returns a json error payload for failed sends", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "conversation_not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        })
      )
    );
    const form = new FormData();
    form.set("conversationId", "missing-conversation");
    form.set("message", "test");

    const response = await POST(
      new Request("http://localhost/conversations/send", {
        method: "POST",
        body: form
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "conversation_not_found",
      status: 404
    });
  });

  it("forwards selected files through multipart form-data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          conversationId: "conv-123",
          reply: "ok",
          persisted: true,
          conversation: { id: "conv-123", messages: [] },
          application: { id: "app-1" },
          validation: { passed: true, errors: [] },
          routerAiModel: "local-stage1-fallback",
          promptVersion: "stage1-local-v1"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.set("conversationId", "conv-123");
    form.set("message", "");
    form.append("files", new File(["image"], "car-photo.jpg", { type: "image/jpeg" }));

    await POST(
      new Request("http://localhost/conversations/send", {
        method: "POST",
        body: form
      })
    );

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwarded = options.body as FormData;
    expect(forwarded.get("conversationId")).toBe("conv-123");
    expect(forwarded.get("message")).toBe("");
    expect(forwarded.getAll("files")).toHaveLength(1);
  });
});
