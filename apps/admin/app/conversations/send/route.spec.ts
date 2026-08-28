import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route.js";

describe("conversations/send route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects back into the same conversation after a successful send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ conversationId: "conv-123" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
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

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/conversations/conv-123?notice=message_sent");
  });

  it("forwards selected files through multipart form-data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ conversationId: "conv-123" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
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
