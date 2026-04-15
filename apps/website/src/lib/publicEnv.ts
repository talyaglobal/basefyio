/** Browser-safe public URLs (Astro/Vite `import.meta.env.PUBLIC_*`). */

export function getPublicApiBaseUrl(): string {
  const u = import.meta.env.PUBLIC_PLATFORM_API_URL;
  if (typeof u === 'string' && u.trim().length > 0) return u.replace(/\/$/, '');
  return 'http://localhost:8000';
}

export function getAppBaseUrl(): string {
  const u = import.meta.env.PUBLIC_APP_URL;
  if (typeof u === 'string' && u.length > 0) return u.replace(/\/$/, '');
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3000`;
  }
  return 'http://localhost:3000';
}

export function billingPlansUrl(): string {
  return `${getPublicApiBaseUrl()}/api/billing/plans`;
}
