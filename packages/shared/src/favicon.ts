import { isLoopbackUrl } from "./localNetwork.ts";

/** Use only already embedded icons or a local development server's favicon. */
export function toolActivityFaviconUrl(
  icon: {
    readonly pageUrl: string;
    readonly faviconUrl?: string | undefined;
    readonly faviconUrlDark?: string | undefined;
  },
  appearance: "light" | "dark",
  _size = 32,
): string | null {
  const candidates =
    appearance === "dark" ? [icon.faviconUrlDark, icon.faviconUrl] : [icon.faviconUrl];
  for (const candidate of candidates) {
    if (candidate && (candidate.startsWith("data:image/") || isLoopbackUrl(candidate)))
      return candidate;
  }
  return isLoopbackUrl(icon.pageUrl) ? new URL("/favicon.ico", icon.pageUrl).href : null;
}

export function faviconUrlForOrigin(_rawUrl: string | null | undefined, _size = 32): null {
  return null;
}
