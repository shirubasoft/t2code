/** Addresses the local edition can contact without leaving this machine. */
export function isLoopbackUrl(input: string | URL): boolean {
  try {
    const url = typeof input === "string" ? new URL(input) : input;
    return (
      ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
