import assert from "node:assert/strict";
import { test } from "node:test";
import { pageSize } from "../scripts/print-cups.js";

const options = (sizes) => `ColorModel/Color Mode: *RGB\nPageSize/Media Size: ${sizes}\nCutter/Cutter: *Normal\n`;

test("picks the plain 4x6 size when the queue defaults to another paper", () => {
  assert.deepEqual(pageSize(options("*w288h360 w288h432-div2 w288h432")), {
    args: ["-o", "PageSize=w288h432"], wide: false,
  });
});

test("keeps a queue already set to 4x6, including the 2inch cut variant", () => {
  assert.deepEqual(pageSize(options("w288h432 *w288h432-div2")), { args: [], wide: false });
  assert.deepEqual(pageSize(options("*PR6x4 w288h360")), { args: [], wide: true });
});

test("falls back to the queue default with a warning when no 4x6 size is listed", () => {
  const page = pageSize(options("*Letter A4"));
  assert.deepEqual(page.args, []);
  assert.match(page.warning, /Letter/);
  assert.deepEqual(pageSize("ColorModel/Color Mode: *RGB\n"), { args: [], wide: false });
});
