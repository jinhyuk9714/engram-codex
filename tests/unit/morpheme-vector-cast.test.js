import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("MorphemeIndex vector cast", () => {
  test("getOrRegisterEmbeddings uses the default pgvector cast", async () => {
    const { MorphemeIndex } = await import("../../lib/memory/MorphemeIndex.js");
    const index = new MorphemeIndex();
    const src = index.getOrRegisterEmbeddings.toString();

    assert.ok(src.includes("::vector"), "morpheme_dict insert should cast with ::vector");
    assert.ok(!src.includes("::nerdvana.vector"), "legacy nerdvana.vector cast should be removed");
  });
});
