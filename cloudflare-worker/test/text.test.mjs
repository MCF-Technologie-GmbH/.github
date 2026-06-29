import assert from "node:assert/strict";
import test from "node:test";
import { extractSections, replaceSections } from "../src/utils/text.js";

test("extractSections and replaceSections preserve repeated protected sections in order", () => {
  const body = [
    "<!-- protected:start -->",
    "Branch",
    "<!-- protected:end -->",
    "",
    "Editable body",
    "",
    "<!-- protected:start -->",
    "Metadata",
    "<!-- protected:end -->",
  ].join("\n");

  assert.deepEqual(extractSections(body, "protected"), ["\nBranch\n", "\nMetadata\n"]);

  const replaced = replaceSections(body, "protected", ["\nOld branch\n", "\nOld metadata\n"]);

  assert.match(replaced, /<!-- protected:start -->\nOld branch\n<!-- protected:end -->/);
  assert.match(replaced, /<!-- protected:start -->\nOld metadata\n<!-- protected:end -->/);
});
