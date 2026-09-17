/** Remote media is unavailable in the local edition, including direct-fetch fallbacks. */
export function githubMediaFetchUrl(_source: string): string | null {
  return null;
}

/**
 * Last path segment, for the signed URL's display name. A percent sequence GitHub accepts but
 * `decodeURIComponent` rejects is left encoded rather than failing the whole asset.
 */
export function githubMediaFileName(fetchUrl: string): string {
  const segment = new URL(fetchUrl).pathname.split("/").pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const name = decoded.replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "github-media";
}
