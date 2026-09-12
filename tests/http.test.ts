import { describe, expect, it, vi } from "vitest";

import { readLimitedText } from "../src/http.js";

describe("bounded response reader", () => {
  it("decodes split UTF-8 characters at the exact byte limit", async () => {
    const bytes = new TextEncoder().encode("A😀Z");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 3));
          controller.enqueue(bytes.slice(3));
          controller.close();
        },
      }),
    );
    await expect(readLimitedText(response, bytes.length)).resolves.toBe("A😀Z");
    expect(response.body?.locked).toBe(false);
  });

  it("cancels a declared oversized response before reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "9" },
    });
    await expect(readLimitedText(response, 8, "GitHub API")).rejects.toThrow(
      "GitHub API response exceeded 8 bytes",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, "1"])(
    "enforces the streamed byte limit when content-length is %s",
    async (contentLength) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("😀"));
          },
          cancel,
        }),
        { headers: contentLength ? { "content-length": contentLength } : {} },
      );
      await expect(readLimitedText(response, 3)).rejects.toThrow(
        "API response exceeded 3 bytes",
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    },
  );

  it("accepts a response without a body", async () => {
    await expect(readLimitedText(new Response(null), 0)).resolves.toBe("");
  });
});
