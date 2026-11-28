/**
 * IN-list padding (3.1.0): $in / $nin lists are sent at power-of-two lengths so
 * Oracle reuses one cursor per size class instead of hard-parsing every length.
 */
import { describe, it, expect } from "bun:test";
import { parseFilter } from "../../src";

const binds = (n: number) => (parseFilter({ ID: { $in: Array.from({ length: n }, (_, i) => i + 1) } }).whereClause.match(/:where_ID_\d+/g) ?? []).length;

describe("unit: IN-list padding", () => {
  it("pads to the next power of two, repeating the last value, capped at 1,000", () => {
    expect([1, 2, 3, 4, 5, 8, 9, 100, 129, 512, 513, 999, 1000].map(binds)).toEqual([1, 2, 4, 4, 8, 8, 16, 128, 256, 512, 1000, 1000, 1000]);
    const r = parseFilter({ ID: { $in: [7, 8, 9] } });
    expect(r.whereClause).toBe('WHERE "ID" IN (:where_ID_0, :where_ID_1, :where_ID_2, :where_ID_3)');
    expect(Object.values(r.binds)).toEqual([7, 8, 9, 9]);
  });

  it("$nin pads the same way (NOT IN with a repeated value is unchanged)", () => {
    const r = parseFilter({ S: { $nin: ["a", "b", "c", null] } });
    expect(r.whereClause).toBe('WHERE "S" NOT IN (:where_S_0, :where_S_1, :where_S_2, :where_S_3)');
    const r5 = parseFilter({ S: { $nin: ["a", "b", "c", "d", "e"] } });
    expect(Object.values(r5.binds)).toEqual(["a", "b", "c", "d", "e", "e", "e", "e"]);
  });

  it("every length from 1 to 1,000 maps to one of 11 SQL texts", () => {
    const texts = new Set<string>();
    for (let n = 1; n <= 1000; n++) texts.add(parseFilter({ ID: { $in: Array.from({ length: n }, (_, i) => i) } }).whereClause);
    expect(texts.size).toBe(11); // 1, 2, 4 … 512, 1000
  });

  it("mixed-type lists over 1,000 pad only their last group", () => {
    const vals: unknown[] = Array.from({ length: 1003 }, (_, i) => (i % 2 ? i : `s${i}`));
    const r = parseFilter({ ID: { $in: vals } });
    expect(Object.keys(r.binds)).toHaveLength(1000 + 4);
    expect(r.whereClause.match(/ IN \(/g)).toHaveLength(2);
  });
});
