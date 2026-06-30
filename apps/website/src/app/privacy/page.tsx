import type { Metadata } from "next";
import { SiteShell } from "@/components/site-shell";
import { buildMetadata } from "@/lib/seo/metadata";

const TITLE = "Privacy Policy";
const DESCRIPTION =
  "How basefyio collects, uses, stores, and protects personal data, and the rights you have over your information.";
const UPDATED = "June 26, 2026";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({ path: "/privacy", title: TITLE, description: DESCRIPTION });
}

export default function PrivacyPage() {
  return (
    <SiteShell>
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="text-4xl font-bold tracking-tight">{TITLE}</h1>
        <p className="mt-3 text-sm text-muted-foreground">Last updated: {UPDATED}</p>

        <div className="mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1">
          <p>
            This Privacy Policy explains how basefyio (&quot;basefyio&quot;, &quot;we&quot;, &quot;us&quot;),
            operated by Talya Smart, handles personal data when you use our website,
            dashboard, APIs, SDK, and CLI (together, the &quot;Service&quot;). We act as a
            <strong> data controller</strong> for your account data and as a
            <strong> data processor</strong> for the end-user data you store in your projects.
          </p>

          <h2>1. Data we collect</h2>
          <ul>
            <li><strong>Account data:</strong> name, email, password (stored hashed via our identity provider), and team membership.</li>
            <li><strong>Billing data:</strong> plan, subscription status, and invoices. Card details are handled directly by our payment processor (Stripe) and are never stored on our servers.</li>
            <li><strong>Project data:</strong> the databases, files, authentication users, and other content you create in your projects.</li>
            <li><strong>Usage &amp; technical data:</strong> log records, IP address, device/browser information, and audit events needed to operate and secure the Service.</li>
          </ul>

          <h2>2. How we use data</h2>
          <ul>
            <li>To provide, maintain, and secure the Service and your projects.</li>
            <li>To process payments and manage subscriptions.</li>
            <li>To communicate service, security, and account notices.</li>
            <li>To detect, prevent, and investigate abuse, fraud, and security incidents.</li>
            <li>To comply with legal obligations.</li>
          </ul>

          <h2>3. Legal bases</h2>
          <p>
            We process personal data to perform our contract with you, to pursue our
            legitimate interests in running a secure service, to comply with legal
            obligations, and — where required — based on your consent.
          </p>

          <h2>4. Sub-processors</h2>
          <p>
            We rely on a limited set of infrastructure and service providers, including a
            payment processor (Stripe) and our hosting provider. They process data only as
            needed to deliver the Service.
          </p>

          <h2>5. Data retention</h2>
          <p>
            We keep account and billing data for as long as your account is active and as
            required by law. Project data is retained until you delete it; deleted projects
            are held briefly in a recoverable state before permanent removal. Backups are
            rotated on a regular schedule.
          </p>

          <h2>6. Security</h2>
          <p>
            We use encryption in transit, access controls, network isolation per project,
            and audit logging. No method of transmission or storage is completely secure,
            but we work to protect your data using industry-standard safeguards.
          </p>

          <h2>7. Your rights</h2>
          <p>
            Depending on your jurisdiction, you may have the right to access, correct,
            export, restrict, or delete your personal data, and to object to certain
            processing. To exercise these rights, contact us at the address below.
          </p>

          <h2>8. International transfers</h2>
          <p>
            Where data is transferred across borders, we apply appropriate safeguards
            consistent with applicable data-protection law.
          </p>

          <h2>9. Children</h2>
          <p>The Service is not directed to children under 16, and we do not knowingly collect their data.</p>

          <h2>10. Changes</h2>
          <p>
            We may update this policy from time to time. Material changes will be reflected
            by the &quot;Last updated&quot; date above.
          </p>

          <h2>11. Contact</h2>
          <p>
            Questions or requests: <a href="mailto:support@talyasmart.com">support@talyasmart.com</a>.
          </p>

          <p className="text-xs italic">
            This document is provided for transparency and may be updated to reflect legal
            review for your jurisdiction.
          </p>
        </div>
      </div>
    </SiteShell>
  );
}
