// Run with: cd apps/platform-api && npx ts-node prisma/seeds/domain-templates.seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const templates = [
  {
    slug: 'crm',
    promptExamples: [
      { input: 'customers,leads,deals', domain: 'crm' },
      { input: 'contacts,pipeline,activities', domain: 'crm' },
    ],
    applicationDefaults: { features: ['timeline-detail', 'kanban-deals', 'activity-feed'] },
    uiOverrides: { detailPage: 'timeline' },
    dashboardTemplates: [
      { name: 'Sales Pipeline', type: 'kanban', table: 'deals', groupBy: 'stage' },
      { name: 'Activity Timeline', type: 'timeline', table: 'activities', dateField: 'due_at' },
    ],
    chartTemplates: [
      { name: 'Revenue by Month', type: 'line', table: 'deals', x: 'closed_at', y: 'sum:amount' },
    ],
    kpiTemplates: [
      { name: 'Total Revenue', formula: 'sum(deals.amount) WHERE stage=closed' },
      { name: 'Conversion Rate', formula: 'count(deals WHERE stage=closed) / count(leads)' },
    ],
    workflowTemplates: [],
    agentTemplates: [],
  },
  {
    slug: 'inventory',
    promptExamples: [
      { input: 'products,inventory,stock', domain: 'inventory' },
    ],
    applicationDefaults: { features: ['stock-level-chart', 'reorder-alerts'] },
    uiOverrides: {},
    dashboardTemplates: [
      { name: 'Stock Levels', type: 'chart', kind: 'bar', table: 'inventory' },
    ],
    chartTemplates: [],
    kpiTemplates: [
      { name: 'Low Stock Items', formula: 'count(inventory WHERE quantity < reorder_level)' },
    ],
    workflowTemplates: [],
    agentTemplates: [],
  },
  {
    slug: 'orders',
    promptExamples: [
      { input: 'orders,order_items,shipments', domain: 'orders' },
    ],
    applicationDefaults: { features: ['kanban-by-status', 'revenue-chart'] },
    uiOverrides: { listPage: 'kanban' },
    dashboardTemplates: [
      { name: 'Orders by Status', type: 'kanban', table: 'orders', groupBy: 'status' },
    ],
    chartTemplates: [
      { name: 'Revenue Trend', type: 'line', table: 'orders', x: 'created_at', y: 'sum:total' },
    ],
    kpiTemplates: [
      { name: 'Total Revenue', formula: 'sum(orders.total)' },
    ],
    workflowTemplates: [],
    agentTemplates: [],
  },
  {
    slug: 'generic',
    promptExamples: [],
    applicationDefaults: {},
    uiOverrides: {},
    dashboardTemplates: [],
    chartTemplates: [],
    kpiTemplates: [],
    workflowTemplates: [],
    agentTemplates: [],
  },
];

async function main() {
  for (const t of templates) {
    await (prisma as any).domainTemplate.upsert({
      where: { slug: t.slug },
      update: t,
      create: t,
    });
    console.log(`Seeded template: ${t.slug}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
