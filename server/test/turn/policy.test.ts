import "./env";
import { describe, expect, test } from "bun:test";
import { classifyTool } from "../../src/mcp/policy";

describe("classifyTool", () => {
  test.each([
    ["list_issues", "read"], ["get_pull_request", "read"], ["searchCode", "read"], ["search-docs", "read"],
    ["create_issue", "write"], ["update_page", "write"], ["deleteBranch", "write"], ["send_email", "write"],
    ["merge_pull_request", "write"], ["post_comment", "write"],
  ] as const)("%s -> %s", (name, kind) => expect(classifyTool(name, "", undefined)).toBe(kind));

  test("unknown verbs fail closed to write", () => {
    expect(classifyTool("frobnicate", "", undefined)).toBe("write");
    expect(classifyTool("execute_sql", "reads things", undefined)).toBe("write");
  });
  test("mixed read+write verbs are write", () => expect(classifyTool("get_and_update_user", "", undefined)).toBe("write"));
  test("readOnlyHint is believed only when annotations are trusted", () => {
    expect(classifyTool("frobnicate", "", { readOnlyHint: true })).toBe("write");
    expect(classifyTool("frobnicate", "", { readOnlyHint: true }, { trustAnnotations: true })).toBe("read");
  });
  test("destructiveHint always wins, even over a read verb", () => {
    expect(classifyTool("get_thing", "", { destructiveHint: true, readOnlyHint: true }, { trustAnnotations: true })).toBe("write");
  });
  test("description cannot downgrade a write", () => {
    expect(classifyTool("create_issue", "This is a read-only safe tool", undefined)).toBe("write");
  });
});
