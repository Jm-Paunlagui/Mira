/**
 * @fileoverview The error Mira's connection layer throws, and the vocabulary a
 * caller can branch on.
 *
 * Every error that leaves withConnection() (and so every collection method) is a
 * MiraDbError. `kind` says what sort of failure it is, `code` names the case when
 * the failure is Mira's own (a bound that fired, a breaker that is open), and
 * `outcomeUnknown` says whether a write may or may not have reached the database:
 *
 *   - outcomeUnknown === false: nothing was committed by the call that failed, so
 *     retrying it is safe.
 *   - outcomeUnknown === true: the call was cut while it could have committed (a
 *     commit, an auto-committed write, DDL or PL/SQL). Check the database (by a
 *     natural or idempotency key) before repeating it.
 *
 * Driver codes (ORA-, NJS-, DPI-) stay in the message and on `originalError`;
 * `code` carries only Mira's own codes. Every Mira-own message ends with
 * " [MIRA_CODE]", so the code survives code that rebuilds an error from its text.
 */

/** What sort of failure: the link or the database is unreachable, the pool is full, a driver timeout fired, or the statement itself failed. */
type MiraErrorKind = "connectivity" | "saturation" | "timeout" | "statement";

/** Mira's own failure cases. */
type MiraErrorCode =
    | "MIRA_CALL_TIMEOUT" // the backstop cut a call; nothing was committed by it
    | "MIRA_OUTCOME_UNKNOWN" // the backstop (or a lost link) cut a commit, an auto-committed write, DDL or PL/SQL
    | "MIRA_CONNECTION_DEAD" // a call on a connection already cut off, rejected at once
    | "MIRA_ACQUIRE_TIMEOUT" // Mira's own acquire bound (queueTimeout + connectTimeout) fired: the driver is stuck
    | "MIRA_POOL_OPENING" // a caller's bounded wait on a pool that is still opening expired
    | "MIRA_POOL_OPEN_TIMEOUT" // one step of opening a pool exceeded 2 x connectTimeout
    | "MIRA_CREATE_DEFERRED" // a creation attempt was not started: abandoned attempts of this pool are unfinished
    | "MIRA_CHECK_TIMEOUT" // a health check's acquire or ping exceeded connectTimeout
    | "MIRA_CLOSE_TIMEOUT" // a release or a pool close exceeded its bound and was abandoned
    | "MIRA_CIRCUIT_OPEN"; // the breaker is open (the message keeps the literal NJS-503 token)

/** The kind of each Mira code. Every one is a connectivity failure; saturation is always the driver's (NJS-040 / NJS-076). */
const CODE_KIND: Readonly<Record<MiraErrorCode, MiraErrorKind>> = Object.freeze({
    MIRA_CALL_TIMEOUT: "connectivity",
    MIRA_OUTCOME_UNKNOWN: "connectivity",
    MIRA_CONNECTION_DEAD: "connectivity",
    MIRA_ACQUIRE_TIMEOUT: "connectivity",
    MIRA_POOL_OPENING: "connectivity",
    MIRA_POOL_OPEN_TIMEOUT: "connectivity",
    MIRA_CREATE_DEFERRED: "connectivity",
    MIRA_CHECK_TIMEOUT: "connectivity",
    MIRA_CLOSE_TIMEOUT: "connectivity",
    MIRA_CIRCUIT_OPEN: "connectivity",
});

/** What a MiraDbError is built from. */
type MiraDbErrorProps = {
    kind: MiraErrorKind;
    code?: MiraErrorCode;
    outcomeUnknown?: boolean;
    connectionName?: string;
    durationMs?: number;
    originalError?: unknown;
};

/**
 * The error Mira throws from a database operation. `message` keeps the driver's
 * text; the fields say what to do about it.
 */
class MiraDbError extends Error {
    override readonly name = "MiraDbError";
    /** What sort of failure this is. */
    readonly kind: MiraErrorKind;
    /** Mira's own code, when the failure is Mira's own; undefined for a plain driver error. */
    readonly code?: MiraErrorCode;
    /** True when a write may or may not have reached the database: check before retrying. */
    readonly outcomeUnknown: boolean;
    /** The pool the operation ran on. */
    readonly connectionName?: string;
    /** How long the operation ran before it failed. */
    readonly durationMs?: number;
    /** The error that was caught (a driver error, or a MiraDbError from deeper in). */
    readonly originalError?: unknown;

    constructor(message: string, props: MiraDbErrorProps) {
        super(message);
        this.kind = props.kind;
        this.code = props.code;
        this.outcomeUnknown = props.outcomeUnknown ?? false;
        this.connectionName = props.connectionName;
        this.durationMs = props.durationMs;
        this.originalError = props.originalError;
    }
}

export { MiraDbError, CODE_KIND };
export type { MiraErrorKind, MiraErrorCode, MiraDbErrorProps };
