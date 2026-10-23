import { describe, expect, test } from "bun:test";
import { heuristicDepth } from "../../src/turn/depth";

describe("heuristicDepth", () => {
  test("routes a long company profile to tools (memory write tools) instead of deep research", () => {
    const profile = (`VHSMO is a student-founded hardware and software startup making a screen-free retro camera. `
      + `The company shares practical information about its product, founders, and launch. `).repeat(6)
      + "This is our company profile.";

    expect(profile.length).toBeGreaterThan(700);
    expect(heuristicDepth({ trigger: "mention", text: profile })).toBe("tools");
  });

  test("a question about the company is a memory read, a statement about it is a save", () => {
    expect(heuristicDepth({ trigger: "mention", text: "what our company does" })).toBe("memory");
    expect(heuristicDepth({ trigger: "mention", text: "who runs our company?" })).toBe("memory");
    expect(heuristicDepth({ trigger: "mention", text: "This is what our company is all about: we build retro cameras" })).toBe("tools");
    expect(heuristicDepth({ trigger: "mention", text: "tell parag about our company please" })).toBe("tools");
  });
});
