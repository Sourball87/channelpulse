import { test } from "node:test";
import assert from "node:assert/strict";
import { sellThroughRedirectTarget } from "./sell-through-routing";

test("Explorer redirects to Sell Through and preserves global filters", () => {
  assert.equal(
    sellThroughRedirectTarget("?period=last4&category=Internal%20SSD&parts=12"),
    "/sell-through?period=last4&category=Internal%20SSD&parts=12",
  );
  assert.equal(sellThroughRedirectTarget(""), "/sell-through");
});
