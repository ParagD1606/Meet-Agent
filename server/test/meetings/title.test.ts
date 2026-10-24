import { describe, expect, test } from "bun:test";
import { cleanTitle } from "../../src/meetings";

describe("cleanTitle", () => {
  test("turns Slack's raw huddle canvas title into a readable one", () => {
    const raw = ":headphones: Huddle notes: 10/24/26 in &lt;#C0CBHSQ2FB5&gt;";
    expect(cleanTitle(raw, "general")).toBe("Huddle in #general · Oct 24");
    expect(cleanTitle(raw, null)).toBe("Huddle · Oct 24");
    expect(cleanTitle(":headphones: Huddle notes: 10/24/26 in &lt;#C0CBHSQ2FB5|design&gt;", null)).toBe("Huddle in #design · Oct 24");
  });
  test("falls back to the end date and leaves other titles alone", () => {
    expect(cleanTitle("Huddle notes", "ops", new Date("2026-10-24T10:00:00Z"))).toBe("Huddle in #ops · Oct 24");
    expect(cleanTitle("Standup 10:30:15", null)).toBe("Standup 10:30:15");
    expect(cleanTitle("Planning", null)).toBe("Planning");
    expect(cleanTitle(cleanTitle(":headphones: Huddle notes: 10/24/26 in &lt;#C1&gt;", "ops"), "ops")).toBe("Huddle in #ops · Oct 24");
  });
});
