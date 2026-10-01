import { describe, expect, it, vi } from "vitest";
import { copyPublicIdentifier } from "./CopyableIdentifier";

describe("copyable public identifier", () => {
  it("copies an order id", async () => {
    const write = vi.fn(async () => undefined);
    await expect(copyPublicIdentifier("order_42", write)).resolves.toEqual({ copied: true });
    expect(write).toHaveBeenCalledWith("order_42");
  });

  it("does not copy a preimage", async () => {
    const write = vi.fn(async () => undefined);
    await expect(copyPublicIdentifier("preimage-deadbeef", write)).resolves.toEqual({ copied: false });
    expect(write).not.toHaveBeenCalled();
  });

  it("does not copy a url", async () => {
    const write = vi.fn(async () => undefined);
    await expect(copyPublicIdentifier("https://etherscan.io/tx/0xabc", write)).resolves.toEqual({ copied: false });
    expect(write).not.toHaveBeenCalled();
  });
});
