#!/usr/bin/env node
/**
 * Tell IndexNow (Bing, Yandex, Naver, Seznam, Yep — not Google) about every URL
 * in the live sitemap, in one POST.
 *
 *   INDEXNOW_KEY=<key> node scripts/indexnow.mjs
 *
 * Env:
 *   INDEXNOW_KEY   required. Must match the public file /<key>.txt on the host.
 *   SITE_URL       default https://basefyio.com
 *   DRY_RUN=1      print the URL list and the request, send nothing.
 *
 * Exit code is 0 for any 2xx answer (200 = accepted, 202 = accepted, key check
 * pending); anything else prints the answer and exits 1.
 */
const SITE = (process.env.SITE_URL || "https://basefyio.com").replace(/\/$/, "");
const KEY = process.env.INDEXNOW_KEY;
const DRY = process.env.DRY_RUN === "1";
const ENDPOINT = "https://api.indexnow.org/indexnow";

if (!KEY || !/^[A-Za-z0-9-]{8,128}$/.test(KEY)) {
  console.error("INDEXNOW_KEY is missing or not 8-128 characters of a-z, 0-9, -");
  process.exit(2);
}

const host = new URL(SITE).host;
const sitemap = await fetch(`${SITE}/sitemap.xml`);
if (!sitemap.ok) {
  console.error(`sitemap.xml answered ${sitemap.status}`);
  process.exit(1);
}
const xml = await sitemap.text();
// Only URLs on this host; the sitemap also lists docs/status subdomains.
const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => m[1].trim().replace(/&amp;/g, "&"))
  .filter((u) => new URL(u).host === host);

const body = { host, key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList };
console.log(`${urlList.length} URLs for ${host}`);
if (DRY) {
  console.log(urlList.join("\n"));
  console.log(`\nDRY_RUN: would POST ${ENDPOINT} with keyLocation ${body.keyLocation}`);
  process.exit(0);
}

const keyCheck = await fetch(body.keyLocation);
if (!keyCheck.ok || (await keyCheck.text()).trim() !== KEY) {
  console.error(`${body.keyLocation} does not serve the key (status ${keyCheck.status}); not sending`);
  process.exit(1);
}

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});
console.log(`IndexNow answered ${res.status} ${res.statusText}`);
if (!res.ok) {
  console.error((await res.text()).slice(0, 500));
  process.exit(1);
}
