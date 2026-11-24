

import { AsyncLocalStorage } from "async_hooks";

// Singleton AsyncLocalStorage that carries the current request ID through the
// entire async call chain. An app sets it per request (e.g. in a middleware);
// the logger reads it so every log line in that request includes [req_xxx].
/** What one request carries through its async chain. */
type RequestStore = {
    requestId?: string;
};

const requestContext = new AsyncLocalStorage<RequestStore>();

export { requestContext };
export type { RequestStore };
