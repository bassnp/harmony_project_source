import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("should pass a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });
});
