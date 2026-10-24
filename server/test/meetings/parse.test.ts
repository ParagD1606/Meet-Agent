import { describe, expect, test } from "bun:test";
import { linesToText, MAX_LINES, numberedLines, parseTranscript } from "../../src/meetings/parse";

describe("parseTranscript", () => {
  test("Name: text and AMI-like speaker letters", () => {
    expect(parseTranscript("Ana: hello there\nBob: hi\nA: second speaker")).toEqual([{ speaker: "Ana", text: "hello there" }, { speaker: "Bob", text: "hi" }, { speaker: "A", text: "second speaker" }]);
  });
  test("[hh:mm] and [hh:mm:ss] timestamps are dropped", () => {
    expect(parseTranscript("[10:02] Ana: one\n[10:02:31] Bob: two")).toEqual([{ speaker: "Ana", text: "one" }, { speaker: "Bob", text: "two" }]);
  });
  test("a wrapped continuation joins the previous line", () => {
    expect(parseTranscript("Ana: first part\nand the rest\nBob: next")).toEqual([{ speaker: "Ana", text: "first part and the rest" }, { speaker: "Bob", text: "next" }]);
  });
  test("WebVTT with <v Name>", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Ana>I will send it</v>\n\n00:00:04.000 --> 00:00:06.000\n<v Bob>Great, thanks</v>\n";
    expect(parseTranscript(vtt)).toEqual([{ speaker: "Ana", text: "I will send it" }, { speaker: "Bob", text: "Great, thanks" }]);
  });
  test("SRT: every cue is its own line", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello everyone\n\n2\n00:00:03,000 --> 00:00:04,000\nLet's start\n";
    expect(parseTranscript(srt)).toEqual([{ speaker: "", text: "Hello everyone" }, { speaker: "", text: "Let's start" }]);
  });
  test("JSON: array, {lines}, {transcript}, and alternative key names", () => {
    expect(parseTranscript('[{"speaker":"Ana","text":"hi"},{"name":"Bob","content":"yo"}]')).toEqual([{ speaker: "Ana", text: "hi" }, { speaker: "Bob", text: "yo" }]);
    expect(parseTranscript('{"lines":[{"speaker_name":"Ana","text":"hi"}]}', "json")).toEqual([{ speaker: "Ana", text: "hi" }]);
    expect(parseTranscript('{"transcript":["Ana: one","Bob: two"]}')).toEqual([{ speaker: "Ana", text: "one" }, { speaker: "Bob", text: "two" }]);
  });
  test("plain paragraphs without speakers", () => {
    expect(parseTranscript("We met today.\nIt went well.\n\nNext paragraph here.")).toEqual([{ speaker: "", text: "We met today. It went well." }, { speaker: "", text: "Next paragraph here." }]);
  });
  test("limits and secret scrub", () => {
    expect(parseTranscript(`Ana: ${"x".repeat(9000)}`)[0]!.text.length).toBe(4000);
    expect(parseTranscript(Array.from({ length: MAX_LINES + 50 }, (_, i) => `Ana: line ${i}`).join("\n")).length).toBe(MAX_LINES);
    const out = parseTranscript("Ana: the token is xoxb-1234567890-abcdefghij and the password: hunter2hunter2\nBob: fine");
    expect(JSON.stringify(out)).not.toContain("xoxb-1234");
    expect(JSON.stringify(out)).not.toContain("hunter2hunter2");
    expect(out[1]).toEqual({ speaker: "Bob", text: "fine" });
  });
  test("round trip with the numbered lines the evidence points at", () => {
    const text = linesToText([{ speaker: "Ana", text: "one" }, { speaker: "", text: "two" }]);
    expect(numberedLines(text)).toEqual([{ n: 1, speaker: "Ana", text: "one" }, { n: 2, speaker: "", text: "two" }]);
  });
});
