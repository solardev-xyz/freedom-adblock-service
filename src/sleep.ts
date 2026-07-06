import { setTimeout as sleepMs } from 'node:timers/promises';

/**
 * Sleep for `ms`, rejecting immediately if `signal` aborts. The one abort-aware
 * timer primitive shared by the serve loop and the daemon's startup retry.
 */
export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await sleepMs(ms, undefined, { signal });
}
