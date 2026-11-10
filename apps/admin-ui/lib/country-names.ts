// Search Console reports countries as lower-case ISO 3166 alpha-3 ("bra"); Intl.DisplayNames wants alpha-2.
// shortcut: the 60 most common markets, others show the upper-case code; extend when a new one shows up.
const A3_TO_A2: Record<string, string> = {
  ARE: 'AE', ARG: 'AR', AUS: 'AU', AUT: 'AT', AZE: 'AZ', BEL: 'BE', BGD: 'BD', BGR: 'BG', BRA: 'BR', CAN: 'CA',
  CHE: 'CH', CHL: 'CL', CHN: 'CN', COL: 'CO', CZE: 'CZ', DEU: 'DE', DNK: 'DK', DZA: 'DZ', EGY: 'EG', ESP: 'ES',
  FIN: 'FI', FRA: 'FR', GBR: 'GB', GRC: 'GR', HKG: 'HK', HRV: 'HR', HUN: 'HU', IDN: 'ID', IND: 'IN', IRL: 'IE',
  IRN: 'IR', IRQ: 'IQ', ISR: 'IL', ITA: 'IT', JPN: 'JP', KAZ: 'KZ', KEN: 'KE', KOR: 'KR', MAR: 'MA', MEX: 'MX',
  MYS: 'MY', NGA: 'NG', NLD: 'NL', NOR: 'NO', NZL: 'NZ', PAK: 'PK', PER: 'PE', PHL: 'PH', POL: 'PL', PRT: 'PT',
  ROU: 'RO', RUS: 'RU', SAU: 'SA', SGP: 'SG', SWE: 'SE', THA: 'TH', TUN: 'TN', TUR: 'TR', UKR: 'UA', USA: 'US',
  VNM: 'VN', ZAF: 'ZA',
};

const names = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;

export function countryName(code: string): string {
  const a3 = code.trim().toUpperCase();
  const a2 = A3_TO_A2[a3] ?? (a3.length === 2 ? a3 : null);
  try {
    return (a2 && names?.of(a2)) || a3;
  } catch {
    return a3;
  }
}
