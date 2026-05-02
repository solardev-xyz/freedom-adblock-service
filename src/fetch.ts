import { createHash } from 'node:crypto';

export interface FetchedSource {
  text: string;
  sha256: string;
  byteSize: number;
}

export async function fetchSource(url: string): Promise<FetchedSource> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const buf = Buffer.from(text, 'utf8');
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { text, sha256, byteSize: buf.byteLength };
}
