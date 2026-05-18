import "dotenv/config";

/**
 * src/index.ts
 * CaaS-Lite platform entry point.
 * Delegates all initialisation to src/app.ts which enforces the correct
 * 14-step startup sequence.
 *
 * Start the server:
 *   npx ts-node src/index.ts
 *   node dist/index.js          (after tsc build)
 */

import { createApp, startServer } from "./app";

startServer(createApp());
