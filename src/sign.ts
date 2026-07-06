import { Wallet } from 'ethers';
import { canonicalManifestForSigning, type FeedManifest } from './manifest.ts';

/**
 * Sign a manifest with an EIP-191 personal_sign over its canonical bytes
 * (see canonicalManifestForSigning). Returns a new manifest with `sig` set.
 * The client verifies with ethers `verifyMessage` against the pinned signer
 * address; iOS verifies the same EIP-191 signature.
 */
export async function signManifest(
  manifest: FeedManifest,
  signerKey: string,
): Promise<FeedManifest> {
  const wallet = new Wallet(signerKey);
  const sig = await wallet.signMessage(canonicalManifestForSigning(manifest));
  return { ...manifest, sig };
}

/** The Ethereum address for a signer key — this is what clients pin. */
export function signerAddress(signerKey: string): string {
  return new Wallet(signerKey).address;
}
