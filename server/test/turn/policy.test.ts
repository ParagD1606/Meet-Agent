import "./env";
import { describe, expect, test } from "bun:test";
import { actionClass, classifyTool, needsApproval, parseApprovalCards } from "../../src/mcp/policy";

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

describe("approval policy", () => {
  test.each([
    ["create_issue", "linear", "ticket"], ["add_comment", "github", "ticket"], ["update_page", "notion", "doc_edit"],
    ["update_document", "google", "doc_edit"], ["send_email", "gmail-personal-only", "email_calendar"], ["create_event", "google", "email_calendar"],
    ["post_message", "slack", "slack_post"], ["post_message", "custom", "slack_post"],
    ["delete_issue", "linear", "other"], ["merge_pull_request", "github", "other"], ["frobnicate", "custom", "other"],
  ] as const)("%s on %s -> %s", (name, provider, cls) => expect(actionClass(name, provider)).toBe(cls));

  test("destructiveHint is always other, even for a ticket tool", () => expect(actionClass("create_issue", "linear", { destructiveHint: true })).toBe("other"));

  test("no card by default for the four classes; other always has one; admin can turn a class on", () => {
    const d = parseApprovalCards(undefined);
    for (const c of ["ticket", "slack_post", "doc_edit", "email_calendar"] as const) expect(needsApproval(c, d)).toBe(false);
    expect(needsApproval("other", d)).toBe(true);
    expect(needsApproval("email_calendar", parseApprovalCards({ email_calendar: true }))).toBe(true);
    expect(needsApproval("other", parseApprovalCards({ ticket: false }))).toBe(true);
  });
});
