// The billing page works on the active organization; the organization layout
// has already made this one active. Stripe's success/cancel return lands on
// /dashboard/billing, which forwards here with its query string.
export { default } from '@/app/dashboard/billing/page';
