/**
 * The API base URL the e2e suite talks to, shared by global-setup and the
 * specs that call the API directly.
 */
export function apiBase(baseURL: string): string {
  if (process.env.E2E_API_URL) return process.env.E2E_API_URL.replace(/\/$/, '');
  // app.<domain> → api.<domain>; anything else falls back to the dashboard's proxy.
  const m = /^(https?:\/\/)app\.(.+)$/.exec(baseURL);
  return m ? `${m[1]}api.${m[2]}/api` : `${baseURL.replace(/\/$/, '')}/api/proxy`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
