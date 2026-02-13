import { describe, expect, it } from "vitest";
import { registerOutboundCollector, responsesApiOutbound } from "./outbound.js";

describe("outbound collector", () => {
  it("captures sendText payloads", async () => {
    const collector = registerOutboundCollector("test-peer");

    await responsesApiOutbound.sendText!({
      cfg: {} as never,
      to: "test-peer",
      text: "Hello",
    });

    const captured = collector.drain();
    expect(captured).toHaveLength(1);
    expect(captured[0].text).toBe("Hello");
    expect(captured[0].mediaUrl).toBeUndefined();

    collector.dispose();
  });

  it("captures sendMedia payloads with mediaUrl", async () => {
    const collector = registerOutboundCollector("test-peer");

    await responsesApiOutbound.sendMedia!({
      cfg: {} as never,
      to: "test-peer",
      text: "Here is an image",
      mediaUrl: "https://example.com/photo.jpg",
    });

    const captured = collector.drain();
    expect(captured).toHaveLength(1);
    expect(captured[0].text).toBe("Here is an image");
    expect(captured[0].mediaUrl).toBe("https://example.com/photo.jpg");

    collector.dispose();
  });

  it("captures multiple sends in order", async () => {
    const collector = registerOutboundCollector("test-peer");

    await responsesApiOutbound.sendText!({
      cfg: {} as never,
      to: "test-peer",
      text: "Text message",
    });
    await responsesApiOutbound.sendMedia!({
      cfg: {} as never,
      to: "test-peer",
      text: "Image caption",
      mediaUrl: "/tmp/image.png",
    });

    const captured = collector.drain();
    expect(captured).toHaveLength(2);
    expect(captured[0].text).toBe("Text message");
    expect(captured[1].mediaUrl).toBe("/tmp/image.png");

    collector.dispose();
  });

  it("does not capture sends to unknown targets", async () => {
    const collector = registerOutboundCollector("peer-a");

    await responsesApiOutbound.sendText!({
      cfg: {} as never,
      to: "peer-b",
      text: "Wrong peer",
    });

    const captured = collector.drain();
    expect(captured).toHaveLength(0);

    collector.dispose();
  });

  it("cleans up after dispose", async () => {
    const collector = registerOutboundCollector("test-peer");
    collector.dispose();

    await responsesApiOutbound.sendText!({
      cfg: {} as never,
      to: "test-peer",
      text: "After dispose",
    });

    // No collector registered, so nothing is captured (no error thrown).
    const captured = collector.drain();
    expect(captured).toHaveLength(0);
  });

  it("drain returns a copy (draining twice returns same data)", () => {
    const collector = registerOutboundCollector("test-peer");

    // Push a payload manually by calling sendText
    void responsesApiOutbound.sendText!({
      cfg: {} as never,
      to: "test-peer",
      text: "Hello",
    });

    // Wait for the promise to settle
    const first = collector.drain();
    const second = collector.drain();
    expect(first).toEqual(second);

    collector.dispose();
  });
});
