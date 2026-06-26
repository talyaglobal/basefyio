import type { Metadata } from "next";
import { SiteShell } from "@/components/site-shell";
import { buildMetadata } from "@/lib/seo/metadata";

const TITLE = "Terms of Service";
const DESCRIPTION =
  "The terms that govern your use of basefyio — accounts, acceptable use, billing, liability, and termination.";
const UPDATED = "June 26, 2026";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({ path: "/terms", title: TITLE, description: DESCRIPTION });
}

export default function TermsPage() {
  return (
    <SiteShell>
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="text-4xl font-bold tracking-tight">{TITLE}</h1>
        <p className="mt-3 text-sm text-muted-foreground">Last updated: {UPDATED}</p>

        <div className="mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1">
          <p>
            These Terms of Service (&quot;Terms&quot;) govern your access to and use of basefyio
            (the &quot;Service&quot;), operated by Talya Smart. By creating an account or using the
            Service, you agree to these Terms.
          </p>

          <h2>1. Accounts</h2>
          <p>
            You must provide accurate information and are responsible for safeguarding your
            credentials and for all activity under your account. You must be at least 16
            years old to use the Service.
          </p>

          <h2>2. Acceptable use</h2>
          <ul>
            <li>No illegal, infringing, or harmful content or activity.</li>
            <li>No attempts to breach security, disrupt, or overload the Service.</li>
            <li>No use that violates the rights or privacy of others.</li>
            <li>You are responsible for the data you store and for obtaining any consents required from your own end users.</li>
          </ul>

          <h2>3. Plans &amp; billing</h2>
          <ul>
            <li>Paid plans are billed in advance on a recurring basis until cancelled.</li>
            <li>Fees are charged to your payment method on file via our payment processor.</li>
            <li>Failed payments may lead to suspension after a grace period.</li>
            <li>Except where required by law, fees are non-refundable.</li>
          </ul>

          <h2>4. Your content</h2>
          <p>
            You retain ownership of the data and content you store. You grant us the limited
            rights needed to host and operate the Service on your behalf. You are responsible
            for keeping your own backups where appropriate.
          </p>

          <h2>5. Availability</h2>
          <p>
            We strive for high availability but do not guarantee uninterrupted service. We
            may perform maintenance and may modify or discontinue features with reasonable
            notice where practical.
          </p>

          <h2>6. Termination</h2>
          <p>
            You may stop using the Service at any time. We may suspend or terminate access
            for breach of these Terms or to protect the Service. Upon termination, your data
            may be deleted after a reasonable period.
          </p>

          <h2>7. Disclaimers &amp; liability</h2>
          <p>
            The Service is provided &quot;as is&quot; without warranties of any kind. To the maximum
            extent permitted by law, we are not liable for indirect, incidental, or
            consequential damages, and our total liability is limited to the amounts you paid
            in the 12 months preceding the claim.
          </p>

          <h2>8. Changes</h2>
          <p>
            We may update these Terms; material changes will be reflected by the
            &quot;Last updated&quot; date. Continued use after changes constitutes acceptance.
          </p>

          <h2>9. Contact</h2>
          <p>
            Questions: <a href="mailto:support@talyasmart.com">support@talyasmart.com</a>.
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
