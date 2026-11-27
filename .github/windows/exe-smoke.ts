/**
 * Windows CI: compiled-executable smoke test (no database).
 *
 *   bun build .github/windows/exe-smoke.ts --compile --outfile dist-exe/exe-smoke.exe
 *
 * Stage node-oracledb's win32 binary beside the exe in node_modules/oracledb/build/Release,
 * set IC_DIR to the Instant Client directory, and run the exe. It loads Thick mode from
 * binaryDir + libDir the way CATHERINE does, prints the mode and client version, and must
 * exit by itself with code 0.
 */
import path from "node:path";
import { configureDriver, initDriver } from "../../src";

const exeDir = path.dirname(process.execPath);
configureDriver({
    mode: "thick",
    libDir: process.env.IC_DIR,
    binaryDir: path.join(exeDir, "node_modules", "oracledb", "build", "Release"),
});
const info = initDriver();
console.log("exe driver:", info);
if (info.mode !== "thick" || !info.clientVersion) {
    console.error("expected Thick mode with a client version");
    process.exit(1);
}
