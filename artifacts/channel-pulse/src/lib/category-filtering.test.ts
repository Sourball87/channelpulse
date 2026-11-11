import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterStockCodeParts,
  keepCategoryCompatiblePartIds,
  listSelectableCategories,
  readCategoryFilter,
  writeCategoryFilter,
} from "./category-filtering";

const parts = [
  { id: 1, part_no: "SSD-A", category: "SSD" },
  { id: 2, part_no: "SSD-B", category: "SSD" },
  { id: 3, part_no: "MON-A", category: "Monitor" },
  { id: 4, part_no: "OLD-A", category: "HDD & Memory" },
];

test("category narrows and clearing restores the Stock Code list", () => {
  assert.deepEqual(filterStockCodeParts(parts, "SSD").map((part) => part.part_no), ["SSD-A", "SSD-B"]);
  assert.deepEqual(filterStockCodeParts(parts, undefined).map((part) => part.part_no),
    ["SSD-A", "SSD-B", "MON-A", "OLD-A"]);
});

test("category options match the Settings data and omit the placeholder", () => {
  assert.deepEqual(listSelectableCategories(parts), ["Monitor", "SSD"]);
});

test("switching categories clears incompatible Stock Code filters", () => {
  assert.deepEqual(keepCategoryCompatiblePartIds(parts, [1], "SSD"), [1]);
  assert.deepEqual(keepCategoryCompatiblePartIds(parts, [3], "SSD"), []);
});

test("category persists in the shared URL and can be cleared", () => {
  assert.equal(readCategoryFilter("?period=last4&category=Internal%20SSD"), "Internal SSD");
  assert.equal(readCategoryFilter("?category=HDD%20%26%20Memory"), undefined);
  const params = new URLSearchParams("period=last4&category=SSD");
  writeCategoryFilter(params, null);
  assert.equal(params.toString(), "period=last4");
});
