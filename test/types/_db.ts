/**
 * TYPES — a db handle for the compile-only type tests. Never run: tsc checks
 * these files, so the credentials are placeholders.
 */
import { createMira } from "../../src";

export const mira = createMira({ pools: { appDb: { user: "u", password: "p", connectString: "h:1521/s" } } });
export const db = mira.db();
