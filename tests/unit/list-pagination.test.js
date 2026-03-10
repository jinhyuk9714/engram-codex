import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  handlePromptsList,
  handleResourcesList,
  handleToolsList,
  paginateStaticItems
} from "../../lib/jsonrpc.js";

describe("paginateStaticItems", () => {
  test("returns nextCursor when the collection exceeds the default page size", () => {
    const items = Array.from({ length: 55 }, (_, index) => ({ id: `item-${index}` }));

    const result = paginateStaticItems(items);

    assert.equal(result.itemsSlice.length, 50);
    assert.equal(result.nextCursor !== undefined, true);
  });

  test("continues from the cursor offset and omits nextCursor on the last page", () => {
    const items = Array.from({ length: 55 }, (_, index) => ({ id: `item-${index}` }));
    const page1 = paginateStaticItems(items);
    const page2 = paginateStaticItems(items, { cursor: page1.nextCursor });

    assert.deepEqual(
      page2.itemsSlice.map((item) => item.id),
      ["item-50", "item-51", "item-52", "item-53", "item-54"]
    );
    assert.equal("nextCursor" in page2, false);
  });

  test("falls back to the first page for invalid cursors", () => {
    const items = Array.from({ length: 55 }, (_, index) => ({ id: `item-${index}` }));

    const result = paginateStaticItems(items, { cursor: "not-valid" });

    assert.equal(result.itemsSlice[0].id, "item-0");
    assert.equal(result.itemsSlice.length, 50);
  });
});

describe("MCP list handlers", () => {
  test("tools/list keeps the current first-page shape when the collection fits in one page", () => {
    const result = handleToolsList();

    assert.ok(Array.isArray(result.tools));
    assert.equal("nextCursor" in result, false);
  });

  test("prompts/list keeps the current first-page shape when the collection fits in one page", () => {
    const result = handlePromptsList();

    assert.ok(Array.isArray(result.prompts));
    assert.equal("nextCursor" in result, false);
  });

  test("resources/list keeps the current first-page shape when the collection fits in one page", () => {
    const result = handleResourcesList();

    assert.ok(Array.isArray(result.resources));
    assert.equal("nextCursor" in result, false);
  });
});
