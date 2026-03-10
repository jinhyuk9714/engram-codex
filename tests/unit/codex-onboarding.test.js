import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { handleInitialize } from "../../lib/jsonrpc.js";
import { getPrompt } from "../../lib/tools/prompts.js";

describe("Codex-focused onboarding", () => {
  test("initialize instructions and server info are Codex-focused", async () => {
    const result = await handleInitialize({ protocolVersion: "2025-11-25" });
    const claudeCode = new RegExp(["Claude", "Code"].join(" "));
    const claudeMd = new RegExp("CLAUDE" + "\\.md");
    const sessionStart = new RegExp("Session" + "Start");
    const userPromptSubmit = new RegExp("User" + "Prompt" + "Submit");

    assert.equal(result.serverInfo.name, "engram-codex-server");
    assert.match(result.instructions, /Engram Codex Server/);
    assert.match(result.instructions, /AGENTS\.md/);
    assert.match(result.instructions, /context/);
    assert.match(result.instructions, /recall/);
    assert.match(result.instructions, /reflect/);
    assert.doesNotMatch(result.instructions, claudeCode);
    assert.doesNotMatch(result.instructions, claudeMd);
    assert.doesNotMatch(result.instructions, sessionStart);
    assert.doesNotMatch(result.instructions, userPromptSubmit);
  });

  test("onboarding prompt refers to Codex and AGENTS guidance", async () => {
    const prompt = await getPrompt("onboarding");
    const text = prompt.messages[0].content.text;
    const claudeCode = new RegExp(["Claude", "Code"].join(" "));
    const claudeMd = new RegExp("CLAUDE" + "\\.md");

    assert.match(text, /Engram Codex/);
    assert.match(text, /Codex/);
    assert.match(text, /AGENTS\.md/);
    assert.doesNotMatch(text, claudeCode);
    assert.doesNotMatch(text, claudeMd);
  });
});
