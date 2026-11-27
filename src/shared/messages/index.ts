/**
 * @fileoverview Re-exports the message namespaces Mira uses.
 *
 * Messages are log-message templates for the Oracle adapter and the
 * query layer. Some templates here ARE thrown (e.g. `MSG.wrapError(...)`
 * in the wrapper), so check call sites before interpolating anything sensitive.
 */

export * from "./oracle.messages";
export * from "./oracleWrapper.messages";
export * from "./miraConfig.messages";
