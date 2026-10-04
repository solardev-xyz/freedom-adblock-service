import { evaluatePreprocessor } from '@ghostery/adblocker';
import { sha256Hex } from './hash.ts';

// uBlock Origin's own filter lists (uAssets), fetched the way desktop's
// scripts/fetch-adblock-lists.js does: resolve the branch head once, download
// every file at that commit (a permanent, citable source for GPL-3.0), then
// evaluate `!#if` blocks against a fixed environment and splice in
// `!#include`s, so the content-blocker conversion and the scriptlet index both
// see one plain-text view of the list.

export interface UblockPin {
  repo: string; // e.g. uBlockOrigin/uAssets
  branch: string; // the branch the Pages site serves (gh-pages)
  pages_base: string; // https://ublockorigin.github.io/uAssets/
}

export interface UblockSourceConfig {
  url: string; // top-level list, under pin.pages_base
  extra_urls?: string[]; // appended after `url` (e.g. Quick fixes)
  pin: UblockPin;
}

export interface UblockSource {
  text: string; // preprocessed, includes spliced, lists concatenated
  sha256: string; // over `text`
  byteSize: number;
  commit: string | null; // null: fell back to the live Pages URLs
  urls: string[]; // the exact URLs fetched (at the commit when resolved)
  fetchedAt: string;
}

const MAX_INCLUDE_DEPTH = 3;

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'freedom-adblock-service', ...headers },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Evaluate `!#if` / `!#else` / `!#endif` against `env` (tokens not in it are
 * false) and splice `!#include <file>` (same directory only — uBlock's rule).
 * Mirrors desktop's resolveUblockText.
 */
export async function resolveUblockText(
  text: string,
  baseUrl: string,
  env: Map<string, boolean>,
  fetchOne: (url: string) => Promise<string>,
  depth = 0,
): Promise<string> {
  const out: string[] = [];
  const stack: Array<{ cond: boolean; active: boolean }> = [];
  const live = () => stack.every((frame) => frame.active);
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('!#if ')) {
      const cond = evaluatePreprocessor(line.slice(5).trim(), env);
      stack.push({ cond, active: cond });
      continue;
    }
    if (line.trim() === '!#else') {
      const frame = stack[stack.length - 1];
      if (!frame) throw new Error(`${baseUrl}: !#else without !#if`);
      frame.active = !frame.cond;
      continue;
    }
    if (line.trim() === '!#endif') {
      if (!stack.pop()) throw new Error(`${baseUrl}: !#endif without !#if`);
      continue;
    }
    if (!live()) continue;
    if (line.startsWith('!#include ')) {
      const name = line.slice('!#include '.length).trim();
      if (depth >= MAX_INCLUDE_DEPTH) throw new Error(`${baseUrl}: !#include nested too deep`);
      const includeUrl = new URL(name, baseUrl);
      const base = new URL('.', baseUrl);
      if (includeUrl.origin !== base.origin || !includeUrl.pathname.startsWith(base.pathname)) {
        throw new Error(`${baseUrl}: refusing out-of-tree !#include ${name}`);
      }
      const included = await fetchOne(includeUrl.href);
      out.push(await resolveUblockText(included, includeUrl.href, env, fetchOne, depth + 1));
      continue;
    }
    out.push(line);
  }
  if (stack.length > 0) throw new Error(`${baseUrl}: unterminated !#if`);
  return out.join('\n');
}

/** The commit `branch` points at now, or null when GitHub can't say. */
async function resolveBranchCommit({ repo, branch }: UblockPin): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  try {
    const sha = (
      await fetchText(`https://api.github.com/repos/${repo}/commits/${branch}`, {
        Accept: 'application/vnd.github.sha',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      })
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected answer ${JSON.stringify(sha.slice(0, 80))}`);
    return sha;
  } catch (err) {
    console.warn(`  ⚠ could not resolve ${repo}@${branch} (${(err as Error).message}); using the live Pages URLs`);
    return null;
  }
}

// Top-level uBlock lists carry a `! Title:` header; the files they include
// don't always, so those only have to not be an HTML error page.
function assertUblockList(text: string, url: string, topLevel: boolean): void {
  const head = text.slice(0, 2048);
  if (topLevel ? !/^! Title: uBlock/m.test(head) : /^\s*</.test(head)) {
    throw new Error(`${url} does not look like a uBlock filter list`);
  }
}

export async function fetchUblockSource(
  cfg: UblockSourceConfig,
  env: Map<string, boolean>,
): Promise<UblockSource> {
  const fetchedAt = new Date().toISOString();
  const { repo, pages_base: pagesBase } = cfg.pin;
  const commit = await resolveBranchCommit(cfg.pin);
  const rawBase = `https://raw.githubusercontent.com/${repo}/${commit}/`;
  const atCommit = (url: string) => {
    if (!commit) return url;
    if (!url.startsWith(pagesBase)) throw new Error(`${url} is not under ${pagesBase}`);
    return `${rawBase}${url.slice(pagesBase.length)}`;
  };

  const urls: string[] = [];
  const fetchOne = async (url: string, topLevel = false) => {
    const text = await fetchText(url);
    assertUblockList(text, url, topLevel);
    urls.push(url);
    return text;
  };

  const parts: string[] = [];
  for (const pagesUrl of [cfg.url, ...(cfg.extra_urls ?? [])]) {
    const url = atCommit(pagesUrl);
    parts.push(await resolveUblockText(await fetchOne(url, true), url, env, fetchOne));
  }
  const text = parts.join('\n');
  return { text, sha256: sha256Hex(text), byteSize: Buffer.byteLength(text), commit, urls, fetchedAt };
}
