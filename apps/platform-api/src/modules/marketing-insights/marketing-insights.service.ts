import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import type { JWTInput } from 'google-auth-library';
import type { GoogleAuth } from 'google-auth-library';

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

@Injectable()
export class MarketingInsightsService {
  private readonly logger = new Logger(MarketingInsightsService.name);
  private readonly credentials: JWTInput | null;
  /** Auth with impersonation (for GSC) — falls back to directAuth if no impersonate email. */
  private readonly impersonatedAuth: GoogleAuth | null;
  /** Auth without impersonation (for GA4) — always uses direct service account. */
  private readonly directAuth: GoogleAuth | null;

  constructor(private readonly config: ConfigService) {
    this.credentials = this.loadServiceAccount();
    if (!this.credentials) {
      this.impersonatedAuth = null;
      this.directAuth = null;
      return;
    }

    // Direct service account access (no impersonation) — used for GA4
    this.directAuth = new google.auth.GoogleAuth({
      credentials: this.credentials,
      scopes: SCOPES,
    });

    const impersonateEmail = (this.config.get<string>('marketing.impersonateEmail') || '').trim();
    if (impersonateEmail) {
      // Domain-wide delegation for GSC: impersonate the specified user
      this.impersonatedAuth = new google.auth.GoogleAuth({
        credentials: this.credentials,
        scopes: SCOPES,
        clientOptions: { subject: impersonateEmail },
      });
    } else {
      // No impersonation configured — GSC also uses direct auth
      this.impersonatedAuth = this.directAuth;
    }
  }

  private loadServiceAccount(): JWTInput | null {
    const b64 = this.config.get<string>('marketing.serviceAccountJsonB64')?.trim();
    if (b64) {
      try {
        const json = Buffer.from(b64, 'base64').toString('utf8');
        return JSON.parse(json) as JWTInput;
      } catch (e) {
        this.logger.warn(`Invalid GOOGLE_MARKETING_SA_JSON_B64: ${(e as Error).message}`);
      }
    }
    const raw = this.config.get<string>('marketing.serviceAccountJson')?.trim();
    if (raw) {
      try {
        return JSON.parse(raw) as JWTInput;
      } catch (e) {
        this.logger.warn(`Invalid GOOGLE_MARKETING_SERVICE_ACCOUNT_JSON: ${(e as Error).message}`);
      }
    }
    return null;
  }

  private getSiteUrl(): string {
    return (this.config.get<string>('marketing.gscSiteUrl') || '').trim();
  }

  private getGaPropertyId(): string {
    return (this.config.get<string>('marketing.ga4PropertyId') || '').trim();
  }

  private getInspectUrl(siteUrl: string): string | null {
    const website = (this.config.get<string>('marketing.inspectUrlOverride') || '').trim();
    if (website) return website.replace(/\/$/, '') + '/';
    if (siteUrl.startsWith('http://') || siteUrl.startsWith('https://')) {
      return siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
    }
    const base = (
      this.config.get<string>('websiteUrl') ||
      this.config.get<string>('appUrl') ||
      'https://example.com'
    ).replace(/\/$/, '');
    return `${base}/`;
  }

  isSearchConsoleConfigured(): boolean {
    return !!this.credentials && !!this.getSiteUrl();
  }

  isAnalyticsConfigured(): boolean {
    return !!this.credentials && !!this.getGaPropertyId();
  }

  async getSearchConsoleSummary(): Promise<Record<string, unknown>> {
    const siteUrl = this.getSiteUrl();
    if (!this.credentials) {
      return {
        configured: false,
        message:
          'Set GOOGLE_MARKETING_SERVICE_ACCOUNT_JSON or GOOGLE_MARKETING_SA_JSON_B64 with a service account that has Search Console access.',
      };
    }
    if (!siteUrl) {
      return {
        configured: false,
        message: 'Set GOOGLE_SEARCH_CONSOLE_SITE_URL (e.g. https://www.example.com/ or sc-domain:example.com).',
      };
    }

    if (!this.impersonatedAuth) {
      return { configured: false, message: 'Could not create Google auth client.' };
    }

    const sc = google.searchconsole({ version: 'v1', auth: this.impersonatedAuth });
    const wm = google.webmasters({ version: 'v3', auth: this.impersonatedAuth });

    const sitesRes = await sc.sites.list().catch((e: Error) => {
      this.logger.warn(`sites.list failed: ${e.message}`);
      return { data: { siteEntry: [] } };
    });

    const sitemapsRes = await sc.sitemaps.list({ siteUrl }).catch((e: Error) => {
      this.logger.warn(`sitemaps.list failed: ${e.message}`);
      return { data: { sitemap: [] } };
    });

    const sitemapRows = (sitemapsRes.data.sitemap || []).map((s) => ({
      path: s.path || '',
      type: s.type || '',
      lastSubmitted: s.lastSubmitted || null,
      lastDownloaded: s.lastDownloaded || null,
      isPending: s.isPending ?? false,
      warnings: s.warnings != null ? Number(s.warnings) : 0,
      errors: s.errors != null ? Number(s.errors) : 0,
    }));

    const inspectUrl = this.getInspectUrl(siteUrl);
    let urlInspection: Record<string, unknown> | null = null;
    if (inspectUrl) {
      try {
        const insp = await sc.urlInspection.index.inspect({
          requestBody: {
            inspectionUrl: inspectUrl,
            siteUrl,
          },
        });
        const idx = insp.data.inspectionResult?.indexStatusResult;
        const issues: string[] = [];
        if (idx?.robotsTxtState && idx.robotsTxtState !== 'ROBOTS_TXT_STATE_UNSPECIFIED') {
          issues.push(`robots.txt: ${idx.robotsTxtState}`);
        }
        if (idx?.indexingState && idx.indexingState !== 'INDEXING_STATE_UNSPECIFIED') {
          issues.push(`indexing: ${idx.indexingState}`);
        }
        if (idx?.pageFetchState && idx.pageFetchState !== 'PAGE_FETCH_STATE_UNSPECIFIED') {
          issues.push(`page fetch: ${idx.pageFetchState}`);
        }
        const mu = insp.data.inspectionResult?.mobileUsabilityResult;
        if (mu?.verdict && mu.verdict !== 'VERDICT_UNSPECIFIED' && mu.verdict !== 'PASS') {
          issues.push(`mobile usability: ${mu.verdict}`);
        }
        urlInspection = {
          inspectionUrl: inspectUrl,
          coverageState: idx?.coverageState || null,
          verdict: idx?.verdict || null,
          lastCrawlTime: idx?.lastCrawlTime || null,
          issues,
        };
      } catch (e) {
        this.logger.warn(`urlInspection failed: ${(e as Error).message}`);
        urlInspection = { inspectionUrl: inspectUrl, error: (e as Error).message };
      }
    }

    const end = new Date();
    const start = daysAgo(28);
    const dateRange = {
      startDate: isoDate(start),
      endDate: isoDate(end),
    };

    // Fire all search analytics queries in parallel
    const [byDateRes, topQueriesRes, topPagesRes, byDeviceRes, byCountryRes] = await Promise.allSettled([
      // By date — daily clicks/impressions/ctr/position
      wm.searchanalytics.query({
        siteUrl,
        requestBody: { ...dateRange, dimensions: ['date'], rowLimit: 25000 },
      }),
      // Top queries
      wm.searchanalytics.query({
        siteUrl,
        requestBody: { ...dateRange, dimensions: ['query'], rowLimit: 20 },
      }),
      // Top pages
      wm.searchanalytics.query({
        siteUrl,
        requestBody: { ...dateRange, dimensions: ['page'], rowLimit: 20 },
      }),
      // By device
      wm.searchanalytics.query({
        siteUrl,
        requestBody: { ...dateRange, dimensions: ['device'], rowLimit: 10 },
      }),
      // By country
      wm.searchanalytics.query({
        siteUrl,
        requestBody: { ...dateRange, dimensions: ['country'], rowLimit: 10 },
      }),
    ]);

    // Helper to extract rows from settled results
    const extract = (res: PromiseSettledResult<any>) =>
      res.status === 'fulfilled' ? (res.value.data.rows || []) : [];

    // By date
    const byDateRows = extract(byDateRes);
    let totalClicks = 0;
    let totalImpressions = 0;
    let totalCtr = 0;
    let totalPosition = 0;
    const byDate: { date: string; clicks: number; impressions: number; ctr: number; position: number }[] = [];
    for (const r of byDateRows) {
      const date = (r.keys || [])[0] || '';
      const clicks = Number(r.clicks || 0);
      const impressions = Number(r.impressions || 0);
      const ctr = Number(r.ctr || 0);
      const position = Number(r.position || 0);
      totalClicks += clicks;
      totalImpressions += impressions;
      byDate.push({ date, clicks, impressions, ctr: Math.round(ctr * 10000) / 100, position: Math.round(position * 10) / 10 });
    }
    if (byDate.length > 0) {
      totalCtr = totalImpressions > 0 ? Math.round((totalClicks / totalImpressions) * 10000) / 100 : 0;
      totalPosition = byDate.reduce((s, r) => s + r.position, 0) / byDate.length;
    }
    byDate.sort((a, b) => a.date.localeCompare(b.date));

    // Top queries
    const topQueries = extract(topQueriesRes).map((r: any) => ({
      query: (r.keys || [])[0] || '',
      clicks: Number(r.clicks || 0),
      impressions: Number(r.impressions || 0),
      ctr: Math.round(Number(r.ctr || 0) * 10000) / 100,
      position: Math.round(Number(r.position || 0) * 10) / 10,
    }));

    // Top pages
    const topPages = extract(topPagesRes).map((r: any) => ({
      page: (r.keys || [])[0] || '',
      clicks: Number(r.clicks || 0),
      impressions: Number(r.impressions || 0),
      ctr: Math.round(Number(r.ctr || 0) * 10000) / 100,
      position: Math.round(Number(r.position || 0) * 10) / 10,
    }));

    // By device
    const byDevice = extract(byDeviceRes).map((r: any) => ({
      device: (r.keys || [])[0] || '',
      clicks: Number(r.clicks || 0),
      impressions: Number(r.impressions || 0),
      ctr: Math.round(Number(r.ctr || 0) * 10000) / 100,
      position: Math.round(Number(r.position || 0) * 10) / 10,
    }));

    // By country
    const byCountry = extract(byCountryRes).map((r: any) => ({
      country: (r.keys || [])[0] || '',
      clicks: Number(r.clicks || 0),
      impressions: Number(r.impressions || 0),
      ctr: Math.round(Number(r.ctr || 0) * 10000) / 100,
      position: Math.round(Number(r.position || 0) * 10) / 10,
    }));

    return {
      configured: true,
      siteUrl,
      sites: (sitesRes.data.siteEntry || []).map((s) => ({
        siteUrl: s.siteUrl || '',
        permissionLevel: s.permissionLevel || '',
      })),
      sitemaps: sitemapRows,
      urlInspection,
      searchPerformance: {
        from: dateRange.startDate,
        to: dateRange.endDate,
        totals: {
          clicks: totalClicks,
          impressions: totalImpressions,
          ctr: totalCtr,
          avgPosition: Math.round(totalPosition * 10) / 10,
        },
        byDate,
        topQueries,
        topPages,
        byDevice,
        byCountry,
      },
    };
  }

  async getAnalyticsTraffic(): Promise<Record<string, unknown>> {
    const propertyId = this.getGaPropertyId();
    if (!this.credentials) {
      return {
        configured: false,
        message:
          'Set GOOGLE_MARKETING_SERVICE_ACCOUNT_JSON or GOOGLE_MARKETING_SA_JSON_B64 with a service account that has Analytics Viewer on the GA4 property.',
      };
    }
    if (!propertyId) {
      return {
        configured: false,
        message: 'Set GOOGLE_ANALYTICS_PROPERTY_ID (numeric GA4 property id, e.g. 123456789).',
      };
    }

    if (!this.impersonatedAuth) {
      return { configured: false, message: 'Could not create Google auth client.' };
    }

    const analyticsData = google.analyticsdata({ version: 'v1beta', auth: this.impersonatedAuth });
    const prop = `properties/${propertyId}`;

    try {
      const [dailyReport, totalsReport, topPagesReport, referrerReport, deviceReport, countryReport] =
        await Promise.all([
          // Daily breakdown
          analyticsData.properties.runReport({
            property: prop,
            requestBody: {
              dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
              dimensions: [{ name: 'date' }],
              metrics: [
                { name: 'sessions' },
                { name: 'activeUsers' },
                { name: 'screenPageViews' },
                { name: 'bounceRate' },
                { name: 'averageSessionDuration' },
              ],
              orderBys: [{ dimension: { dimensionName: 'date' } }],
            },
          }),
          // Totals (summary cards)
          analyticsData.properties.runReport({
            property: prop,
            requestBody: {
              dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
              metrics: [
                { name: 'sessions' },
                { name: 'activeUsers' },
                { name: 'screenPageViews' },
                { name: 'newUsers' },
                { name: 'bounceRate' },
                { name: 'averageSessionDuration' },
                { name: 'engagedSessions' },
              ],
            },
          }),
          // Top pages
          analyticsData.properties.runReport({
            property: prop,
            requestBody: {
              dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
              dimensions: [{ name: 'pagePath' }],
              metrics: [
                { name: 'screenPageViews' },
                { name: 'activeUsers' },
                { name: 'averageSessionDuration' },
              ],
              orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
              limit: '15',
            },
          }),
          // Traffic sources
          analyticsData.properties.runReport({
            property: prop,
            requestBody: {
              dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
              dimensions: [{ name: 'sessionSource' }],
              metrics: [
                { name: 'sessions' },
                { name: 'activeUsers' },
              ],
              orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
              limit: '10',
            },
          }),
          // Device category
          analyticsData.properties.runReport({
            property: prop,
            requestBody: {
              dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
              dimensions: [{ name: 'deviceCategory' }],
              metrics: [
                { name: 'sessions' },
                { name: 'activeUsers' },
              ],
              orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
              limit: '5',
            },
          }),
          // Country
          analyticsData.properties.runReport({
            property: prop,
            requestBody: {
              dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
              dimensions: [{ name: 'country' }],
              metrics: [
                { name: 'sessions' },
                { name: 'activeUsers' },
              ],
              orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
              limit: '10',
            },
          }),
        ]);

      // Helper: extract dimension rows into typed objects
      const extractDim = (report: any) => {
        const metricNames = (report.data.metricHeaders || []).map((h: any) => h.name || '');
        return (report.data.rows || []).map((row: any) => {
          const dim = row.dimensionValues?.[0]?.value || '';
          const metrics = (row.metricValues || []).map((m: any) => Number(m.value || 0));
          const out: Record<string, number | string> = { dimension: dim };
          metricNames.forEach((name: string, i: number) => {
            out[name] = metrics[i] ?? 0;
          });
          return out;
        });
      };

      // Daily breakdown
      const metricHeaders = dailyReport.data.metricHeaders?.map((h) => h.name) || [];
      const byDate =
        dailyReport.data.rows?.map((row) => {
          const dateRaw = row.dimensionValues?.[0]?.value || '';
          const metrics = (row.metricValues || []).map((m) => Number(m.value || 0));
          const out: Record<string, number | string> = { date: dateRaw };
          metricHeaders.forEach((name, i) => {
            out[name || `m${i}`] = metrics[i] ?? 0;
          });
          return out;
        }) || [];

      // Totals
      const totalRow = totalsReport.data.rows?.[0];
      const totalMetrics = (totalRow?.metricValues || []).map((m) => Number(m.value || 0));
      const totalNames = totalsReport.data.metricHeaders?.map((h) => h.name) || [];
      const summary: Record<string, number> = {};
      totalNames.forEach((name, i) => {
        summary[name || `m${i}`] = totalMetrics[i] ?? 0;
      });

      return {
        configured: true,
        propertyId,
        byDate,
        dimensionHeaders: ['date'],
        metricHeaders,
        summary,
        topPages: extractDim(topPagesReport),
        trafficSources: extractDim(referrerReport),
        byDevice: extractDim(deviceReport),
        byCountry: extractDim(countryReport),
      };
    } catch (e) {
      const err = e as Error;
      this.logger.warn(`GA4 runReport failed: ${err.message}`);
      return {
        configured: true,
        propertyId,
        error: err.message,
      };
    }
  }
}
