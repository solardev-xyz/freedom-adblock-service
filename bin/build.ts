import { buildArtifacts } from '../src/build.ts';

// One-shot build CLI. Fetches every source, converts to desktop raw-text +
// iOS WebKit-JSON shards, and writes out/ (see src/build.ts). The daemon
// (bin/serve.ts) calls buildArtifacts directly on each tick instead.
//
//   MANIFEST_VERSION   optional integer; otherwise seconds-since-epoch

const manifestVersion = Number(process.env.MANIFEST_VERSION) || undefined;
await buildArtifacts({ manifestVersion });
