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
  private readonly googleAuth: GoogleAuth | null;

  constructor(private readonly config: ConfigService) {
    this.credentials = this.loadServiceAccount();
    this.googleAuth = this.credentials
      ? new google.auth.GoogleAuth({
          credentials: this.credentials,
          scopes: SCOPES,
        })
      : null;
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

    if (!this.googleAuth) {
      return { configured: false, message: 'Could not create Google auth client.' };
    }

    const sc = google.searchconsole({ version: 'v1', auth: this.googleAuth });
    const wm = google.webmasters({ version: 'v3', auth: this.googleAuth });

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
    let searchPerformance: Record<string, unknown> | null = null;
    try {
      const sa = await wm.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: isoDate(start),
          endDate: isoDate(end),
          dimensions: ['date'],
          rowLimit: 25000,
        },
      });
      const rows = sa.data.rows || [];
      let totalClicks = 0;
      let totalImpressions = 0;
      const byDate: { date: string; clicks: number; impressions: number }[] = [];
      for (const r of rows) {
        const keys = r.keys || [];
        const date = keys[0] || '';
        const clicks = Number(r.clicks || 0);
        const impressions = Number(r.impressions || 0);
        totalClicks += clicks;
        totalImpressions += impressions;
        byDate.push({ date, clicks, impressions });
      }
      byDate.sort((a, b) => a.date.localeCompare(b.date));
      searchPerformance = {
        from: isoDate(start),
        to: isoDate(end),
        totals: { clicks: totalClicks, impressions: totalImpressions },
        byDate,
      };
    } catch (e) {
      this.logger.warn(`searchanalytics.query failed: ${(e as Error).message}`);
      searchPerformance = { error: (e as Error).message };
    }

    return {
      configured: true,
      siteUrl,
      sites: (sitesRes.data.siteEntry || []).map((s) => ({
        siteUrl: s.siteUrl || '',
        permissionLevel: s.permissionLevel || '',
      })),
      sitemaps: sitemapRows,
      urlInspection,
      searchPerformance,
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

    if (!this.googleAuth) {
      return { configured: false, message: 'Could not create Google auth client.' };
    }

    const analyticsData = google.analyticsdata({ version: 'v1beta', auth: this.googleAuth });
    try {
      const [report, totals] = await Promise.all([
        analyticsData.properties.runReport({
          property: `properties/${propertyId}`,
          requestBody: {
            dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
            dimensions: [{ name: 'date' }],
            metrics: [
              { name: 'sessions' },
              { name: 'activeUsers' },
              { name: 'screenPageViews' },
            ],
            orderBys: [{ dimension: { dimensionName: 'date' } }],
          },
        }),
        analyticsData.properties.runReport({
          property: `properties/${propertyId}`,
          requestBody: {
            dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
            metrics: [
              { name: 'sessions' },
              { name: 'activeUsers' },
              { name: 'screenPageViews' },
              { name: 'newUsers' },
            ],
          },
        }),
      ]);

      const dimHeaders = report.data.dimensionHeaders?.map((h) => h.name) || [];
      const metricHeaders = report.data.metricHeaders?.map((h) => h.name) || [];
      const byDate =
        report.data.rows?.map((row) => {
          const dateRaw = row.dimensionValues?.[0]?.value || '';
          const metrics = (row.metricValues || []).map((m) => Number(m.value || 0));
          const out: Record<string, number | string> = { date: dateRaw };
          metricHeaders.forEach((name, i) => {
            const key = name || `m${i}`;
            out[key] = metrics[i] ?? 0;
          });
          return out;
        }) || [];

      const totalRow = totals.data.rows?.[0];
      const totalMetrics = (totalRow?.metricValues || []).map((m) => Number(m.value || 0));
      const totalNames = totals.data.metricHeaders?.map((h) => h.name) || [];
      const summary: Record<string, number> = {};
      totalNames.forEach((name, i) => {
        const key = name || `m${i}`;
        summary[key] = totalMetrics[i] ?? 0;
      });

      return {
        configured: true,
        propertyId,
        byDate,
        dimensionHeaders: dimHeaders,
        metricHeaders,
        summary,
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
