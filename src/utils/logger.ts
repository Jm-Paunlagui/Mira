/**
 * @fileoverview Enterprise Logging System with RFC 5424 Syslog Levels and File Rotation
 * @description Comprehensive logging solution with RFC 5424 severity levels, automatic
 *   file rotation, and organized directory structure. Levels follow priority 0 (highest)
 *   to 7 (lowest) — emergency, alert, critical, error, warning, notice, info, debug.
 * @author Jm-Paunlagui
 * @version 5.0.0
 * Levels follow RFC 5424 (eight levels: emergency/alert/critical/error/warning/notice/info/debug).
 */

import type { NextFunction, Request, Response } from "express";
import { promises as fs } from "fs";
import path from "path";
import { IS_COMPILED, APP_ROOT } from "./runtimePaths";
import os from "os";
import { requestContext } from "./requestContext";
import { scrubValue, scrubMeta } from "./logRedaction";

/**
 * Backpressure-loss report emitted when the write queue overflows.
 *
 * CLAUDE.md's rule is that log strings live in `constants/messages/`. This one
 * is the documented exception: logger.js is the logging infrastructure those
 * message modules exist to feed, and it imports only modules whose own
 * transitive closure is Node built-ins — today `./requestContext`
 * (`async_hooks`) and `./logRedaction` (`crypto`). Nothing in that closure
 * may ever require the logger; that, not the count of imports, is what
 * prevents the cycle every other module's `require("./logger")` would
 * otherwise create. Keeping this single template local preserves the
 * logger's zero-dependency position.
 *
 * @param {number} dropped - Entries discarded.
 * @param {number} cap - The queue cap that triggered the drop.
 * @returns {string}
 */
const WRITE_QUEUE_OVERFLOW = (dropped: number, cap: number): string =>
    `Log write queue overflowed — ${dropped} oldest entr${dropped === 1 ? "y" : "ies"} DROPPED (cap ${cap}). ` +
    `The log file has a gap. The disk could not keep up with log volume; check disk health, free space, ` +
    `and any antivirus real-time scanning of the log directory.`;

/** A record delivered to an onLevel() subscriber. */
type LevelRecord = { level: string; message: string; meta: Record<string, unknown>; requestId: string | null; timestamp: string };

class Logger {
    // ========================================
    // STATIC CONFIGURATION
    // ========================================

    static CONFIG = {
        MAX_FILE_SIZE: 50 * 1024 * 1024,

        /**
         * RFC 5424 syslog numeric priorities.
         * Lower number = higher priority. A log at level N is written when N <= currentLevel.
         * Backward-compatible mapping:
         *   Old ERROR:0 → ERROR:3, Old WARN:1 → WARNING:4, Old INFO:2 → INFO:6, Old DEBUG:3 → DEBUG:7
         */
        LEVELS: {
            EMERGENCY: 0, // System is unusable — panic, should never occur in a running process
            ALERT: 1, // Action must be taken immediately (e.g. DB pool completely down)
            CRITICAL: 2, // critical conditions (e.g. health check hard failure, cert expiry)
            ERROR: 3, // Error conditions (formerly ERROR:0)
            WARNING: 4, // Warning conditions (formerly WARN:1)
            NOTICE: 5, // Normal but significant condition (startup complete, config change)
            INFO: 6, // Informational (formerly INFO:2)
            DEBUG: 7, // Debug-level messages (formerly DEBUG:3)
        } as Record<string, number>,

        COLORS: {
            // RFC 5424 new levels
            EMERGENCY: "\x1b[105m", // Bright magenta background — highest severity
            ALERT: "\x1b[105m", // Bright magenta background — critical alert
            CRITICAL: "\x1b[91m", // Bright red — critical condition
            NOTICE: "\x1b[97m", // Bright white — normal but significant
            // Existing levels (kept identical)
            ERROR: "\x1b[31m",
            WARNING: "\x1b[33m",
            WARN: "\x1b[33m", // Alias for internal lookups that still use WARN key
            INFO: "\x1b[36m",
            DEBUG: "\x1b[35m",
            // Structural
            MACHINE_ID: "\x1b[94m",
            TIMESTAMP: "\x1b[90m",
            PID: "\x1b[92m",
            LOCATION: "\x1b[93m",
            REQUEST_PHASE: "\x1b[95m",
            METHOD: "\x1b[96m",
            MESSAGE: "\x1b[97m",
            RESET: "\x1b[0m",
            BRACKET: "\x1b[37m",
            SEPARATOR: "\x1b[37m",
        } as Record<string, string>,

        // In the compiled exe logs live NEXT TO THE EXE — a service can
        // start the exe with cwd anywhere (e.g. System32).
        LOG_BASE_DIR: IS_COMPILED ? path.join(APP_ROOT, "logs")
            : path.join(process.cwd(), "logs"),

        /**
         * Accepts all 8 RFC 5424 level names case-insensitively.
         * Also accepts legacy "WARN" as alias for "WARNING".
         * Default: INFO (numeric 6).
         */
        CURRENT_LEVEL: process.env.LOG_LEVEL || "INFO",

        CONSOLE_OUTPUT:
            process.env.ENABLE_CONSOLE_LOGS === "false"
                ? false
                : process.env.ENABLE_CONSOLE_LOGS === "true" ||
                  process.env.NODE_ENV !== "production" ||
                  process.env.DOCKER_CONTAINER === "true",

        EXCLUDED_URLS: [
            ...(process.env.LOG_EXCLUDE_HEALTH === "true" ? ["/health"] : []),
            ...(process.env.LOG_EXCLUDE_URLS
                ? process.env.LOG_EXCLUDE_URLS.split(",")
                : []),
        ],

        MAX_SAFESTR_LENGTH: process.env.LOG_MAX_SAFESTR_LENGTH
            ? parseInt(process.env.LOG_MAX_SAFESTR_LENGTH ?? "", 10)
            : Infinity,

        DATE_OPTIONS: {
            timeZone: "Asia/Manila",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            // h23, NOT hour12:false — some ICU builds map hour12:false to the
            // h24 cycle and render the midnight hour as "24" (observed in the
            // PKG-compiled prod exe: "[2026-07-02 24:56:00]"), which breaks
            // timestamp parsing and sorts the first hour of the day last.
            hourCycle: "h23",
        } satisfies Intl.DateTimeFormatOptions,
    };
    declare _levelSubscribers: Array<{ maxPriority: number; fn: (record: LevelRecord) => void }>;
    declare machineIdentifier: string;
    declare _droppedCount: number;
    declare _maxQueueLength: number;
    declare isWriting: boolean;
    declare writeQueue: Array<{ level: string; message: unknown; meta: Record<string, unknown>; requestId: string | null }>;
    declare _maxSafeStrLength: number;
    declare currentLevel: number;

    // ========================================
    // CONSTRUCTOR
    // ========================================

    constructor() {
        // Normalize WARN → WARNING for backward compatibility with env vars
        const rawLevel = (Logger.CONFIG.CURRENT_LEVEL || "INFO").toUpperCase();
        const normalizedLevel = rawLevel === "WARN" ? "WARNING" : rawLevel;

        this.currentLevel =
            Logger.CONFIG.LEVELS[normalizedLevel] ?? Logger.CONFIG.LEVELS.INFO;

        this._maxSafeStrLength = Logger.CONFIG.MAX_SAFESTR_LENGTH;
        this.writeQueue = [];
        this.isWriting = false;

        /**
         * Hard cap on queued-but-unwritten log entries (backpressure).
         *
         * `log()` is fire-and-forget: it pushes and returns without awaiting the
         * `fs.appendFile`. If the disk stalls, the drain rate drops to ~0 while
         * the fill rate keeps tracking request volume, so an uncapped array grows
         * without bound until the process dies of memory exhaustion — taking the
         * service down for a *logging* problem.
         *
         * Not hypothetical on the deployment target: Windows Server with Defender
         * real-time scanning of freshly-created rotating log files, which the
         * runbook does not exclude.
         *
         * On overflow the OLDEST entries are dropped, not the newest — during an
         * incident the most recent lines are the ones worth keeping, and the drop
         * itself is recorded so a gap in the log is never silent.
         *
         * @type {number}
         */
        this._maxQueueLength = Number(
            process.env.LOG_MAX_QUEUE_LENGTH || 10000,
        );

        /** @type {number} Entries discarded by the cap since the last report. */
        this._droppedCount = 0;
        this.machineIdentifier = this.#computeMachineIdentifier();
        this.#initializeBaseDirectory();

        /**
         * Level-tap subscriber list — see onLevel(). Plain array, no
         * EventEmitter inheritance needed for a handful of listeners.
         * @type {Array<{ maxPriority: number, fn: Function }>}
         */
        this._levelSubscribers = [];
    }

    // ========================================
    // LEVEL TAP — server-email-notifications feature
    // ========================================

    /**
     * Subscribes to log records at or above a given severity (numerically
     * `<= maxPriority`, since lower RFC 5424 priority numbers are MORE
     * severe). Used by `AlertNotifierService` to buffer crit/alert/emerg
     * events for the critical-channel digest email without coupling the
     * logger to any notification code.
     *
     * Records whose meta carries `_noNotify: true` are skipped — this is the
     * loop-guard: logging that
     * happens INSIDE the notification path itself must never re-trigger a
     * notification, or a failing SMTP send could log a warning that logs a
     * warning forever. `_noNotify` only ever suppresses the TAP; the log
     * line is still written to disk/console normally.
     *
     * Subscriber callbacks run synchronously, wrapped in try/catch — a
     * throwing subscriber can never break the log write path.
     *
     * @param {number}   maxPriority - RFC 5424 numeric priority ceiling (e.g. 2 = emerg/alert/crit)
     * @param {(record: { level: string, message: string, meta: object, requestId: string|null, timestamp: string }) => void} fn
     * @returns {() => void} Unsubscribe function
     *
     * @example
     * const unsubscribe = logger.onLevel(2, (record) => {
     *     criticalBuffer.push(record);
     * });
     * // later: unsubscribe();
     */
    onLevel(maxPriority: number, fn: (record: LevelRecord) => void): () => void {
        if (typeof fn !== "function") return () => {};
        const entry = { maxPriority, fn };
        this._levelSubscribers.push(entry);
        return () => {
            const idx = this._levelSubscribers.indexOf(entry);
            if (idx !== -1) this._levelSubscribers.splice(idx, 1);
        };
    }

    /**
     * Fires every subscriber whose `maxPriority` covers this record's level.
     * Never throws — a subscriber error is swallowed (logged to stderr only,
     * mirroring this file's existing internal-failure fallback) so the log
     * write path is never affected.
     *
     * @param {string} level     - RFC 5424 level name (e.g. "CRITICAL")
     * @param {*}      message   - Raw log message (resolved to string for subscribers)
     * @param {object} meta      - Log metadata; `_noNotify: true` skips the tap
     * @param {string|null} requestId
     */
    #notifySubscribers(level: string, message: unknown, meta: Record<string, unknown>, requestId: string | null) {
        if (!this._levelSubscribers.length) return;
        if (meta && meta._noNotify) return;
        const priority = Logger.CONFIG.LEVELS[level];
        if (priority === undefined) return;

        const record = {
            level,
            message: this.#resolveMessage(message),
            meta,
            requestId: requestId ?? null,
            timestamp: new Date().toISOString(),
        };

        for (const { maxPriority, fn } of this._levelSubscribers) {
            if (priority > maxPriority) continue;
            try {
                fn(record);
            } catch (err) {
                // Never let a subscriber crash the log write path — same
                // console.error fallback this file already uses for its own
                // internal (non-recursable) failures.
                console.error(
                    "Logger onLevel subscriber threw:",
                    err?.message ?? err,
                );
            }
        }
    }

    // ========================================
    // PRIVATE UTILITY METHODS
    // ========================================

    /**
     * Compute and cache machine identifier (hostname, primary IPv4)
     */
    #computeMachineIdentifier() {
        try {
            const hostname = os.hostname();
            const interfaces = os.networkInterfaces();
            let ipAddress = "unknown";

            for (const entries of Object.values(interfaces)) {
                if (!entries) continue;
                for (const net of entries) {
                    // Old Node versions reported family as the number 4 / 6.
                    const legacy = net as { family: string | number; addressFamily?: string };
                    const family: string | number = legacy.family || legacy.addressFamily || "";
                    const isIPv4 = family === "IPv4" || family === 4;
                    if (isIPv4 && !net.internal) {
                        ipAddress = net.address || ipAddress;
                        break;
                    }
                }
                if (ipAddress !== "unknown") break;
            }

            return `${hostname} (S) ${ipAddress}`;
        } catch {
            return "unknown (S) unknown";
        }
    }

    /**
     * Get current date components for directory structure and timestamps
     */
    #getDateComponents() {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat(
            "en-CA",
            Logger.CONFIG.DATE_OPTIONS,
        );
        const partsMap = Object.fromEntries(
            formatter
                .formatToParts(now)
                .map(({ type, value }) => [type, value]),
        );

        // Milliseconds come from Date directly (not Intl) — no ICU dependency,
        // safe in the PKG-compiled exe. Millisecond precision keeps the Request
        // Log Trace in true chronological order when many lines share a second.
        const ms = String(now.getMilliseconds()).padStart(3, "0");

        return {
            year: partsMap.year,
            month: partsMap.month,
            day: partsMap.day,
            timestamp: `${partsMap.year}-${partsMap.month}-${partsMap.day} ${partsMap.hour}:${partsMap.minute}:${partsMap.second}.${ms}`,
        };
    }

    /**
     * Shorten absolute paths to start at src/ when possible
     */
    #shortenPath(fullPath: unknown) {
        try {
            const cwd = process.cwd().replace(/\\/g, "/");
            const norm = String(fullPath || "").replace(/\\/g, "/");
            const srcIdx = norm.lastIndexOf("/src/");

            if (srcIdx !== -1) return norm.substring(srcIdx + 1);
            // Compiled exe: the embedded source map reports repo-relative paths ("src/...").
            if (norm.startsWith("src/")) return norm;
            if (norm.startsWith(cwd)) {
                const rel = norm.substring(cwd.length);
                return rel.startsWith("/") ? rel.substring(1) : rel;
            }

            const parts = norm.split("/");
            return parts.slice(Math.max(0, parts.length - 2)).join("/");
        } catch {
            return String(fullPath || "");
        }
    }

    /**
     * Safely serialize any value to string, handling objects, arrays, and primitives
     */
    #safeStringify(value: unknown, maxLength = this._maxSafeStrLength) {
        try {
            if (value === null) return "null";
            if (value === undefined) return "undefined";
            if (typeof value === "string") return value;
            if (typeof value === "number" || typeof value === "boolean")
                return String(value);

            if (typeof value === "object") {
                let jsonStr;
                try {
                    jsonStr = JSON.stringify(value);
                } catch {
                    try {
                        const seen = new WeakSet();
                        jsonStr = JSON.stringify(value, (key, val) => {
                            if (typeof val === "object" && val !== null) {
                                if (seen.has(val))
                                    return "[Circular Reference]";
                                seen.add(val);
                            }
                            return val;
                        });
                    } catch {
                        return "[Complex Object - Unable to Stringify]";
                    }
                }
                return jsonStr.length > maxLength
                    ? jsonStr.substring(0, maxLength - 3) + "..."
                    : jsonStr;
            }

            return String(value);
        } catch (error) {
            return `[Stringify Error: ${error.message}]`;
        }
    }

    /**
     * Ensure a directory exists, creating it if necessary
     */
    async #ensureDirectoryExists(dirPath: string) {
        try {
            await fs.mkdir(dirPath, { recursive: true });
        } catch (error) {
            if (error.code !== "EEXIST") {
                console.error(
                    "Failed to create log directory:",
                    dirPath,
                    error.message,
                );
                throw error;
            }
        }
    }

    /**
     * Get a file's size in bytes, returning 0 if it doesn't exist
     */
    async #getFileSize(filePath: string) {
        try {
            return (await fs.stat(filePath)).size;
        } catch (error) {
            if (error.code === "ENOENT") return 0;
            throw error;
        }
    }

    /**
     * Capture call site information (function, file, line) from stack trace
     */
    #captureCallSite(meta: Record<string, unknown> = {}) {
        let displayFn = meta.function || "anonymous";
        let displayFile = meta.file ? this.#shortenPath(meta.file) : "";
        let displayLine = meta.line ? `:${meta.line}` : "";

        if (!meta.function || !meta.file || !meta.line) {
            try {
                const enabled =
                    String(process.env.LOG_CALLSITE || "true").toLowerCase() ===
                    "true";
                if (enabled) {
                    const stack = (new Error().stack || "").split("\n");
                    const chosenFrame = stack
                        .slice(2)
                        .find(
                            (line) =>
                                line.trim() && !/logger\.[jt]s\b/.test(line),
                        );

                    if (chosenFrame) {
                        const m1 = chosenFrame
                            .trim()
                            .match(/^at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/);
                        const m2 = chosenFrame
                            .trim()
                            .match(/^at\s+(.+):(\d+):(\d+)$/);

                        if (m1) {
                            displayFn = m1[1];
                            displayFile = this.#shortenPath(m1[2]);
                            displayLine = `:${m1[3]}`;
                        } else if (m2) {
                            displayFn = "anonymous";
                            displayFile = this.#shortenPath(m2[1]);
                            displayLine = `:${m2[2]}`;
                        }
                    }
                }
            } catch {
                // Ignore callsite errors
            }
        }

        return { displayFn, displayFile, displayLine };
    }

    /**
     * Get next available log filename, rolling over when the size limit is exceeded
     */
    async #getAvailableFilename(baseDir: string, baseName: unknown) {
        let filename = `${baseName}.log`;
        let fullPath = path.join(baseDir, filename);

        if ((await this.#getFileSize(fullPath)) < Logger.CONFIG.MAX_FILE_SIZE) {
            return { filename, fullPath };
        }

        for (let counter = 1; counter < 1000; counter++) {
            filename = `${baseName}_${counter}.log`;
            fullPath = path.join(baseDir, filename);
            if (
                (await this.#getFileSize(fullPath)) <
                Logger.CONFIG.MAX_FILE_SIZE
            ) {
                return { filename, fullPath };
            }
        }

        filename = `${baseName}_${Date.now()}.log`;
        fullPath = path.join(baseDir, filename);
        return { filename, fullPath };
    }

    /**
     * Get log directory path for the current date
     */
    #getLogDirectory() {
        const { year, month, day } = this.#getDateComponents();
        return path.join(Logger.CONFIG.LOG_BASE_DIR, year, month, day);
    }

    /**
     * Initialize the base log directory on startup
     */
    async #initializeBaseDirectory() {
        try {
            await this.#ensureDirectoryExists(Logger.CONFIG.LOG_BASE_DIR);
        } catch (error) {
            console.error("Failed to initialize log directory:", error.message);
        }
    }

    /**
     * Build the plain-text log entry string
     */
    #formatMessage(level: unknown, message: unknown, meta: Record<string, unknown> = {}, requestId: string | null = null) {
        const { timestamp } = this.#getDateComponents();
        const cleanMessage = this.#resolveMessage(message);
        const { displayFn, displayFile, displayLine } =
            this.#captureCallSite(meta);
        const isHttpRequest = meta._isHttpRequest;
        const method = isHttpRequest ? meta.method || "UNKNOWN" : "FUNC";
        const machineId = meta._clientMachine || this.machineIdentifier;

        let entry = `[${machineId}] [${timestamp}] [${level}] [PID:${process.pid}] [${displayFn} @ ${displayFile}${displayLine}]`;

        if (isHttpRequest && meta._requestPhase)
            entry += ` ${meta._requestPhase}`;
        if (!(isHttpRequest && cleanMessage.includes(`[${meta.method} @`)))
            entry += ` [${method}]`;
        const _reqId = requestId ?? requestContext.getStore()?.requestId;
        if (_reqId) entry += ` [${_reqId}]`;
        entry += ` - ${cleanMessage}`;

        const metaStr = this.#buildMetaString(meta);
        if (metaStr) entry += ` | META: ${metaStr}`;

        return entry;
    }

    /**
     * Build the colorized console log entry string
     */
    #formatColorizedMessage(level: string, message: unknown, meta: Record<string, unknown> = {}, requestId: string | null = null) {
        const colors = Logger.CONFIG.COLORS;
        const { timestamp } = this.#getDateComponents();
        const cleanMessage = this.#resolveMessage(message);
        const { displayFn, displayFile, displayLine } =
            this.#captureCallSite(meta);
        const isHttpRequest = meta._isHttpRequest;
        const method = isHttpRequest ? meta.method || "UNKNOWN" : "FUNC";
        const machineId = meta._clientMachine || this.machineIdentifier;
        const levelColor = colors[level] || "";

        let entry = "";
        entry += `${colors.BRACKET}[${colors.MACHINE_ID}${machineId}${colors.BRACKET}]${colors.RESET}`;
        entry += ` ${colors.BRACKET}[${colors.TIMESTAMP}${timestamp}${colors.BRACKET}]${colors.RESET}`;
        entry += ` ${colors.BRACKET}[${levelColor}${level}${colors.BRACKET}]${colors.RESET}`;
        entry += ` ${colors.BRACKET}[${colors.PID}PID:${process.pid}${colors.BRACKET}]${colors.RESET}`;
        entry += ` ${colors.BRACKET}[${colors.LOCATION}${displayFn} @ ${displayFile}${displayLine}${colors.BRACKET}]${colors.RESET}`;

        if (isHttpRequest && meta._requestPhase) {
            entry += ` ${colors.REQUEST_PHASE}${meta._requestPhase}${colors.RESET}`;
        }

        if (!(isHttpRequest && cleanMessage.includes(`[${meta.method} @`))) {
            entry += ` ${colors.BRACKET}[${colors.METHOD}${method}${colors.BRACKET}]${colors.RESET}`;
        }

        const _reqId2 = requestId ?? requestContext.getStore()?.requestId;
        if (_reqId2)
            entry += ` ${colors.BRACKET}[${colors.PID}${_reqId2}${colors.BRACKET}]${colors.RESET}`;

        entry += ` ${colors.SEPARATOR}- ${colors.MESSAGE}${cleanMessage}${colors.RESET}`;

        const metaStr = this.#buildMetaString(meta);
        if (metaStr) {
            entry += ` ${colors.SEPARATOR}| ${colors.BRACKET}META: ${colors.MESSAGE}${metaStr}${colors.RESET}`;
        }

        return entry;
    }

    /**
     * Resolve a raw message value to a clean string
     */
    #resolveMessage(message: unknown) {
        if (message === null || message === undefined) return "[Empty Message]";
        return this.#safeStringify(message).trim() || "[Empty Message]";
    }

    /**
     * Serialize non-internal meta keys to a string
     */
    #buildMetaString(meta: Record<string, unknown>) {
        const INTERNAL_KEYS = new Set([
            "method",
            "url",
            "function",
            "file",
            "line",
        ]);
        const metaKeys = Object.keys(meta).filter(
            (k) => !k.startsWith("_") && !INTERNAL_KEYS.has(k),
        );
        if (metaKeys.length === 0) return null;

        const metaObj = Object.fromEntries(metaKeys.map((k) => [k, meta[k]]));
        return this.#safeStringify(metaObj);
    }

    /**
     * Inject call site info into a meta object from the current stack
     */
    #injectCallSite(meta: Record<string, unknown>) {
        try {
            const enabled =
                String(process.env.LOG_CALLSITE || "true").toLowerCase() ===
                "true";
            if (!enabled) return;

            const stack = (new Error().stack || "").split("\n");
            const chosenFrame = stack.slice(2).find((line) => {
                const t = line.trim();
                return (
                    t &&
                    !/[\\/]utils[\\/]logger\.[jt]s\b/.test(t)
                );
            });

            if (!chosenFrame) return;

            const m1 = chosenFrame
                .trim()
                .match(/^at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/);
            const m2 = chosenFrame.trim().match(/^at\s+(.+):(\d+):(\d+)$/);

            if (m1) {
                if (!meta.function) meta.function = m1[1];
                if (!meta.file) meta.file = m1[2];
                if (!meta.line) meta.line = m1[3];
            } else if (m2) {
                if (!meta.function) meta.function = "anonymous";
                if (!meta.file) meta.file = m2[1];
                if (!meta.line) meta.line = m2[2];
            }
        } catch {
            // Ignore callsite errors
        }
    }

    // ========================================
    // PRIVATE WRITE METHODS
    // ========================================

    /**
     * Write a formatted log entry to the appropriate file
     */
    async #writeToFile(level: string, message: unknown, meta: Record<string, unknown> = {}, requestId: string | null = null) {
        const logDir = this.#getLogDirectory();
        try {
            await this.#ensureDirectoryExists(logDir);
            const { fullPath } = await this.#getAvailableFilename(
                logDir,
                level.toLowerCase(),
            );
            const formattedMessage = this.#formatMessage(
                level,
                message,
                meta,
                requestId,
            );

            if (Logger.CONFIG.CONSOLE_OUTPUT) {
                console.log(
                    this.#formatColorizedMessage(
                        level,
                        message,
                        meta,
                        requestId,
                    ),
                );
            }

            await fs.appendFile(fullPath, formattedMessage + "\n", "utf8");
        } catch (error) {
            console.error(`Failed to write ${level} log:`, error.message);
        }
    }

    /**
     * Process the internal write queue sequentially to prevent concurrent writes
     */
    async #processWriteQueue() {
        if (this.isWriting || this.writeQueue.length === 0) return;

        this.isWriting = true;
        while (this.writeQueue.length > 0) {
            const { level, message, meta, requestId } = this.writeQueue.shift()!; // non-null: the loop checked length > 0
            try {
                await this.#writeToFile(level, message, meta, requestId);
            } catch (error) {
                console.error("Error processing write queue:", error.message);
            }
        }

        // Report any backpressure loss now that the disk has caught up, so a
        // gap in the log is always accounted for. Written directly rather than
        // via log() — log() would push onto the queue we are draining and could
        // re-enter this method.
        if (this._droppedCount > 0) {
            const dropped = this._droppedCount;
            this._droppedCount = 0;
            try {
                await this.#writeToFile(
                    "CRITICAL",
                    WRITE_QUEUE_OVERFLOW(dropped, this._maxQueueLength),
                    {},
                    null,
                );
            } catch (error) {
                console.error("Error reporting dropped logs:", error.message);
            }
        }

        this.isWriting = false;
    }

    // ========================================
    // ARGUMENT NORMALIZATION
    // ========================================

    #normalizeLogArguments(args: unknown[]) {
        if (args.length === 0) return { message: "[Empty Log]", meta: {} };
        if (args.length === 1) return { message: args[0], meta: {} };

        const [message, ...rest] = args;

        if (rest.length === 1 && this.#isPlainMetaObject(rest[0])) {
            return { message, meta: rest[0] };
        }

        const formattedArgs = rest.map((a: unknown) => this.#formatMetaValue(a, true));
        return {
            message: `${message} ${formattedArgs.join(" ")}`,
            meta: { additionalData: rest.map((a: unknown) => this.#formatMetaValue(a)) },
        };
    }

    #isPlainMetaObject(value: unknown): value is Record<string, unknown> {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object" ||
            Array.isArray(value)
        )
            return false;
        const keys = Object.keys(value);
        return keys.length === 0 || !keys.every((key, i) => key === String(i));
    }

    #formatMetaValue(value: unknown, forMessage = false) {
        if (value === null) return "null";
        if (value === undefined) return "undefined";
        if (typeof value === "string") return value;
        if (typeof value === "number" || typeof value === "boolean")
            return String(value);
        if (Array.isArray(value) || typeof value === "object")
            return forMessage ? JSON.stringify(value) : value;
        return String(value);
    }

    // ========================================
    // CORE LOGGING
    // ========================================

    /**
     * Core log method — enqueues a log entry for async file writing.
     * A log at RFC 5424 level N is written if N <= this.currentLevel
     * (lower number = higher priority = always shown).
     *
     * @param {string} level - One of EMERGENCY, ALERT, CRITICAL, ERROR, WARNING, NOTICE, INFO, DEBUG
     * @param {string|*} message - Log message or value
     * @param {object} [meta={}] - Optional metadata object
     */
    async log(level: string, message: string | unknown, meta: Record<string, unknown> = {}) {
        if (Logger.CONFIG.LEVELS[level] > this.currentLevel) return;
        if (!message || (typeof message === "string" && !message.trim()))
            return;

        // ⚠ #injectCallSite MUST run first: it mutates `meta` to add
        // function/file/line, and scrubMeta below clones AFTER — the clone
        // must carry those keys or every line's "[fn @ file:line]" becomes
        // "[anonymous @ ]". See logRedaction.js's INTERNAL_KEYS.
        this.#injectCallSite(meta);
        // Capture now — the ALS context is correct here. By the time #processWriteQueue
        // dequeues this item it may be running under a different request's context.
        const requestId = requestContext.getStore()?.requestId ?? null;

        // Redact once per record at enqueue so every sink (file, stdout, taps, SSE) sees the same text;
        // `_noRedact` is honoured only outside production.
        const bypass =
            meta?._noRedact === true && process.env.NODE_ENV !== "production";
        const safeMessage = bypass ? message : scrubValue(message);
        const safeMeta = bypass ? meta : scrubMeta(meta);

        this.#notifySubscribers(level, safeMessage, safeMeta, requestId);

        // Backpressure — see _maxQueueLength. Drop OLDEST so the newest lines
        // (the ones that matter during an incident) always survive, and count
        // the loss so the gap is reported rather than silent.
        if (this.writeQueue.length >= this._maxQueueLength) {
            const overflow = this.writeQueue.length - this._maxQueueLength + 1;
            this.writeQueue.splice(0, overflow);
            this._droppedCount += overflow;
        }

        this.writeQueue.push({
            level,
            message: safeMessage,
            meta: safeMeta,
            requestId,
        });
        this.#processWriteQueue();
    }

    /**
     * Wait until every queued line has been written to disk.
     *
     * `log()` is fire-and-forget by design — it pushes onto `writeQueue` and
     * returns without awaiting the `fs.appendFile`. That is right for the hot
     * request path and wrong at process exit: `server.ts`'s `gracefulShutdown`
     * logs "All resources cleaned up." and then calls `process.exit(0)` on the
     * next tick, which tears the process down before the queue drains. The
     * shutdown banner — the exact line `deploy/winsw/README.md` tells operators
     * to look for to distinguish a clean service stop from a hard kill — could
     * therefore be missing from a genuinely graceful stop, and on a slow disk
     * so could the lines before it.
     *
     * Bounded by `timeoutMs` so a stuck/full disk cannot hold the process open:
     * losing a few log lines is better than a service that will not stop.
     *
     * @param {number} [timeoutMs=3000] Give up waiting after this long.
     * @returns {Promise<boolean>} true if the queue drained, false on timeout.
     */
    async flush(timeoutMs: number = 3000): Promise<boolean> {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (
            (this.writeQueue.length > 0 || this.isWriting) &&
            Date.now() < deadline
        ) {
            this.#processWriteQueue();
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return this.writeQueue.length === 0 && !this.isWriting;
    }

    // ========================================
    // PUBLIC LEVEL METHODS — RFC 5424
    // ========================================

    /**
     * EMERGENCY (priority 0) — System is unusable. Should never occur in a running process.
     * Use for unrecoverable panics only.
     * @param {...*} args
     */
    emergency(...args: unknown[]) {
        const { message, meta } = this.#normalizeLogArguments(args);
        return this.log("EMERGENCY", message, meta);
    }

    /**
     * EMERG — Deprecated short alias for emergency(). Retained for backward compatibility.
     * @deprecated Use logger.emergency() instead.
     * @param {...*} args
     */
    emerg(...args: unknown[]) {
        return this.emergency(...args);
    }

    /**
     * ALERT (priority 1) — Action must be taken immediately.
     * Examples: DB pool completely down, critical dependency unreachable.
     * @param {...*} args
     */
    alert(...args: unknown[]) {
        const { message, meta } = this.#normalizeLogArguments(args);
        return this.log("ALERT", message, meta);
    }

    /**
     * CRITICAL (priority 2) — critical conditions.
     * Examples: health check hard failure, certificate expiry.
     * @param {...*} args
     */
    critical(...args: unknown[]) {
        const { message, meta } = this.#normalizeLogArguments(args);
        // Level key MUST be uppercase: lowercase "critical" missed both
        // LEVELS (level filter bypassed) and COLORS (rendered white) lookups
        // and wrote the literal "critical" into log lines.
        return this.log("CRITICAL", message, meta);
    }

    /**
     * CRIT — Deprecated short alias for critical(). Retained for backward compatibility.
     * @deprecated Use logger.critical() instead.
     * @param {...*} args
     */
    crit(...args: unknown[]) {
        return this.critical(...args);
    }

    /**
     * ERROR (priority 3) — Error conditions.
     * Backward-compatible replacement for old error() at level 0.
     * @param {...*} args
     */
    error(...args: unknown[]) {
        const { message, meta } = this.#normalizeLogArguments(args);
        return this.log("ERROR", message, meta);
    }

    /**
     * WARNING (priority 4) — Warning conditions.
     * Canonical RFC 5424 method name. Replaces the old warn() call site name.
     * Backward-compatible replacement for old warn() at level 1.
     * @param {...*} args
     */
    warning(...args: unknown[]) {
        const { message, meta } = this.#normalizeLogArguments(args);
        return this.log("WARNING", message, meta);
    }

    /**
     * WARN — Deprecated alias for warning(). Retained for backward compatibility only.
     * All new call sites must use logger.warning(). This alias will be removed in v6.
     * @deprecated Use logger.warning() instead.
     * @param {...*} args
     */
    warn(...args: unknown[]) {
        return this.warning(...args);
    }

    /**
     * NOTICE (priority 5) — Normal but significant condition.
     * Examples: startup complete, config change, expected administrative events.
     * @param {...*} args
     */
    notice(...args: unknown[]) {
        const { message, meta } = this.#normalizeLogArguments(args);
        return this.log("NOTICE", message, meta);
    }

    /**
     * INFO (priority 6) — Informational messages.
     * Backward-compatible replacement for old info() at level 2.
     * @param {...*} args
     */
    info(...args: unknown[]) {
        const { message, meta } = this.#normalizeLogArguments(args);
        return this.log("INFO", message, meta);
    }

    /**
     * DEBUG (priority 7) — Debug-level messages.
     * Backward-compatible replacement for old debug() at level 3.
     * @param {...*} args
     */
    debug(...args: unknown[]) {
        const { message, meta } = this.#normalizeLogArguments(args);
        return this.log("DEBUG", message, meta);
    }

    // ========================================
    // HTTP REQUEST LIFECYCLE LOGGING
    // ========================================

    logIncomingRequest(req: import("express").Request, customMessage: string | null = null) {
        return this.log("INFO", customMessage || "Incoming Request", {
            method: req.method,
            url: req.originalUrl || req.url,
            _isHttpRequest: true,
            _requestPhase: "[Incoming Request]",
            _clientMachine: this.#createClientMachineIdentifier(req),
        });
    }

    logHandlingRequest(req: import("express").Request, additionalMeta: Record<string, unknown> = {}) {
        return this.log("INFO", "Handling Request", {
            method: req.method,
            url: req.originalUrl || req.url,
            _isHttpRequest: true,
            _requestPhase: "[Handling Request]",
            _clientMachine: this.#createClientMachineIdentifier(req),
            ...additionalMeta,
        });
    }

    logCompletedRequest(req: Request, res: Response, duration: number, customMessage: string | null = null) {
        const level = res.statusCode >= 400 ? "ERROR" : "INFO";
        return this.log(level, customMessage || "Request Complete", {
            method: req.method,
            url: req.originalUrl || req.url,
            // statusCode + durationMs make ERROR-level completions diagnosable —
            // without them a request in error.log shows the route but not whether
            // it was a 401, 404, 429, or 500.
            statusCode: res.statusCode,
            durationMs: duration,
            _isHttpRequest: true,
            _requestPhase: "[Request Complete]",
            _clientMachine: this.#createClientMachineIdentifier(req),
        });
    }

    #createClientMachineIdentifier(req: import("express").Request) {
        const username =
            req.get?.("X-Client-Username") ||
            (req.query?.username && req.query?.userId
                ? `${req.query.username}@${req.query.userId}`
                : null) ||
            (req.user?.userId ?? req.user?.sub) ||
            "anonymous@unknown";
        return `${username} (C) ${this.#getClientIp(req)}`;
    }

    /**
     * Resolve the client IP recorded in every `[username (C) IP]` log line.
     *
     * CWE-290 (spoofing via forged request header). This deliberately does NOT
     * read `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP`. Those headers
     * are fully client-controlled, and this deployment puts NO reverse proxy in
     * front of Node — browsers connect straight to `https://SERVER:3000` (see
     * deploy/DEPLOYMENT_RUNBOOK.md), so nothing strips or rewrites them. Reading
     * them let any caller stamp an arbitrary source address onto every line of
     * the forensic log by adding one header, which is exactly the trail this
     * system leans on for audits.
     *
     * `req.ip` is the correct source for both topologies: the raw socket peer
     * when trust proxy is off (today), and the rightmost untrusted hop once
     * `app.set('trust proxy', N)` is configured in app.js (a future proxied
     * deployment) — Express does the X-Forwarded-For walk itself, correctly.
     *
     * This now matches RateLimiterMiddleware.extractIp, IpFilterMiddleware
     * .extractClientIp, and AuditLogMiddleware's DB-persisted CLIENT_IP, all of
     * which already dropped raw header parsing for this reason. The file logger
     * was the last consumer still trusting them.
     *
     * @param {import('express').Request} req
     * @returns {string}
     */
    #getClientIp(req: import('express').Request): string {
        return (
            req.ip ||
            req.socket?.remoteAddress ||
            req.connection?.remoteAddress ||
            "unknown"
        );
    }

    // ========================================
    // SPECIALIZED LOGGING
    // ========================================

    cache(operation: unknown, key: unknown, result: unknown, duration = null) {
        return this.log("DEBUG", "Cache Operation", {
            operation,
            key,
            result,
            ...(duration != null && { duration: `${duration}ms` }),
        });
    }

    database(operation: unknown, table: unknown, duration = null, rowCount = null) {
        return this.log("DEBUG", "Database Operation", {
            operation,
            table,
            ...(duration != null && { duration: `${duration}ms` }),
            ...(rowCount != null && { rowCount }),
        });
    }

    performance(operation: unknown, duration: number, details: Record<string, unknown> = {}) {
        const level = duration > 5000 ? "WARNING" : "INFO";
        return this.log(level, "Performance", {
            operation,
            duration: `${duration}ms`,
            ...details,
        });
    }

    security(event: unknown, details: Record<string, unknown> = {}) {
        return this.log("WARNING", "Security Event", {
            event,
            timestamp: new Date().toISOString(),
            ...details,
        });
    }

    // ========================================
    // MAINTENANCE & STATS
    // ========================================

    async getLogStats() {
        try {
            const logDir = this.#getLogDirectory();
            const files = await fs.readdir(logDir);

            const fileStats = await Promise.all(
                files
                    .filter((f) => f.endsWith(".log"))
                    .map(async (file) => {
                        const stats = await fs.stat(path.join(logDir, file));
                        return {
                            name: file,
                            size: stats.size,
                            sizeHuman: this.#formatBytes(stats.size),
                            created: stats.birthtime,
                            modified: stats.mtime,
                        };
                    }),
            );

            return {
                directory: logDir,
                totalFiles: fileStats.length,
                files: fileStats,
            };
        } catch (error) {
            return { error: error.message, directory: this.#getLogDirectory() };
        }
    }

    // A `cleanupOldLogs()` method used to live here. It logged "Log cleanup
    // completed" on every call and deleted no file — it computed a cutoff
    // date and never used it. It also had zero call sites anywhere in this
    // codebase, so the false assurance it gave never even reached an
    // operator through a real invocation. The real, unattended retention
    // sweep is `src/services/LogRetentionService.ts` — it lives in a service, not
    // here, because this file deliberately imports nothing from `src/`
    // except `requestContext` (see the comment at :20-27); pulling in
    // `constants/messages` or `fs`-heavy retention logic here would invert
    // that dependency.

    #formatBytes(bytes: number, decimals = 2) {
        if (bytes === 0) return "0 Bytes";
        const k = 1024;
        const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals < 0 ? 0 : decimals))} ${sizes[i]}`;
    }

    // ========================================
    // EXPRESS MIDDLEWARE FACTORY
    // ========================================

    /**
     * Returns an Express middleware that logs the full HTTP request lifecycle
     */
    createHttpLoggerMiddleware() {
        return (req: Request, res: Response, next: NextFunction) => {
            const startTime = Date.now();
            this.logIncomingRequest(req);

            const originalEnd = res.end.bind(res);
            res.end = ((...args: unknown[]) => {
                this.logCompletedRequest(req, res, Date.now() - startTime);
                return (originalEnd as (...a: unknown[]) => unknown)(...args);
            }) as typeof res.end;

            next();
        };
    }
}

// ========================================
// SINGLETON INSTANCE & EXPORTS
// ========================================

const logger = new Logger();

export { Logger, logger };
