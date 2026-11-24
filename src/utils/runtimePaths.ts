

/**
 * @fileoverview Where the backend's on-disk files live, in source runs and in the compiled exe.
 *
 * `bun build --compile` bundles every module into one executable and bakes the BUILD machine's
 * absolute `__dirname` into it (e.g. `C:\build\CATHERINE\Backend\src\services`). On the deploy box
 * that path does not exist, so any `path.join(__dirname, ...)` read — email templates, logos,
 * dev-docs, the changelog store, certs, logs — silently points at nothing. Every such path must
 * be built from APP_ROOT instead:
 *
 *   - compiled exe → the directory holding the exe; the build stages `src/utils/email-templates`,
 *     `src/assets`, `src/generated` and the native addons beside it (scripts/build.js)
 *   - `bun server.ts` / tests → the Backend folder (this file is Backend/src/utils/runtimePaths.ts)
 *
 * Detection: a compiled Bun binary reports its entry point inside Bun's embedded filesystem —
 * `/$bunfs/root/...` on POSIX, `B:\~BUN\root\...` on Windows.
 */

import path from "path";

/** True when `main` is an entry point inside a compiled Bun executable's embedded filesystem. */
function isBunCompiledMain(main: unknown) {
    return typeof main === "string" && (main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main));
}

/* c8 ignore next 2 -- the compiled arm is reachable only inside the bun-compiled exe */
const IS_COMPILED = typeof Bun !== "undefined" && isBunCompiledMain(Bun.main);
const APP_ROOT = IS_COMPILED ? path.dirname(process.execPath) : path.resolve(__dirname, "..", "..");

/** Absolute path to a file or folder under APP_ROOT. */
function appPath(...segments: string[]) {
    return path.join(APP_ROOT, ...segments);
}

export { IS_COMPILED, APP_ROOT, appPath, isBunCompiledMain };
