// Workers können kein Chromium starten. Stub, damit get-item.ts übersetzt.
export async function fetchItemDetailsViaBrowser(..._args: unknown[]): Promise<never> {
  throw new Error('Browser mode is not available on Cloudflare Workers.');
}
