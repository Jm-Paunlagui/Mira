/**
 * @fileoverview Re-exports the message namespaces Mira uses.
 *
 * Messages are log-message templates for the Oracle adapter and the
 * oracle-mongo-wrapper. Some templates here ARE thrown (e.g. `MSG.wrapError(...)`
 * in the wrapper), so check call sites before interpolating anything sensitive.
 *
 * Kept in sync with CATHERINE's src/constants/messages/ (same file names).
 */

export * from "./oracle.messages";
export * from "./oracleWrapper.messages";
export * from "./miraConfig.messages";
