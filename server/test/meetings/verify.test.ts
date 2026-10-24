import { describe, expect, test } from "bun:test";
import { makeSource, quoteSupported, verifiedOwner } from "../../src/meetings/verify";

const src = makeSource("Ana: Parag will handle the advertisement campaign by Friday.\nBob: Sounds good, and we decided to launch on the thirtieth.");

describe("verify", () => {
  test("accepts real quotes, exact or slightly reworded", () => {
    expect(quoteSupported(src, "Parag will handle the advertisement campaign by Friday")).toBe(true);
    expect(quoteSupported(src, "Parag will handle advertisement campaign Friday")).toBe(true);
    expect(quoteSupported(src, "we decided to launch on the thirtieth")).toBe(true);
  });
  test("rejects invented or too-short quotes", () => {
    expect(quoteSupported(src, "Rahul will do the frontend AI integration")).toBe(false);
    expect(quoteSupported(src, "frontend AI integration")).toBe(false);
    expect(quoteSupported(src, "advertisement")).toBe(false);
    expect(quoteSupported(src, "")).toBe(false);
  });
  test("owners must be participants or named in the text", () => {
    expect(verifiedOwner(src, ["Ana", "Bob"], "bob")).toBe("Bob");
    expect(verifiedOwner(src, [], "Parag")).toBe("Parag");
    expect(verifiedOwner(src, ["Ana"], "Rahul")).toBeNull();
    expect(verifiedOwner(src, [], null)).toBeNull();
  });
});
