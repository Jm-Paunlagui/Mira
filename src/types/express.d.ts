/**
 * Express request fields the logger reads when an app built on Mira passes it a
 * request (logger.logIncomingRequest and friends). Declaration merging into the
 * global `Express.Request` that @types/express reads.
 *
 * Mira has no auth layer: `user` is whatever the app's auth middleware attaches.
 * Only the two claims the logger uses to label the client are declared.
 */
declare global {
    namespace Express {
        interface Request {
            user?: {
                userId?: string;
                sub?: string;
            };
        }
    }
}

export {};
