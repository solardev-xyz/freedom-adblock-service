import { createHash } from 'node:crypto';

/** sha256 of the given bytes/string as lowercase hex. */
export const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');
