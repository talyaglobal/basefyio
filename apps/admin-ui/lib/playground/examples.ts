// Curated example queries shown in the Playground sidebar. Each is runnable as-is
// against the seeded dataset and chosen to demonstrate a distinct capability.

export interface ExampleQuery {
  label: string;
  description: string;
  sql: string;
}

export const EXAMPLE_QUERIES: ExampleQuery[] = [
  {
    label: 'Select users',
    description: 'Basic read',
    sql: 'SELECT * FROM users;',
  },
  {
    label: 'Recent orders',
    description: 'Filter + limit',
    sql: 'SELECT id, user_id, total, status\nFROM orders\nORDER BY created_at DESC\nLIMIT 10;',
  },
  {
    label: 'Join: orders + users',
    description: 'Who bought what',
    sql: `SELECT u.name, p.name AS product, o.quantity, o.total, o.status
FROM orders o
JOIN users u    ON u.id = o.user_id
JOIN products p ON p.id = o.product_id
ORDER BY o.total DESC;`,
  },
  {
    label: 'Aggregate: spend per user',
    description: 'GROUP BY + SUM',
    sql: `SELECT u.name, COUNT(o.id) AS orders, SUM(o.total) AS lifetime_value
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.name
ORDER BY lifetime_value DESC NULLS LAST;`,
  },
  {
    label: 'Posts with comment counts',
    description: 'Correlated aggregate',
    sql: `SELECT p.title, u.name AS author, COUNT(c.id) AS comments
FROM posts p
JOIN users u    ON u.id = p.user_id
LEFT JOIN comments c ON c.post_id = p.id
GROUP BY p.title, u.name
ORDER BY comments DESC;`,
  },
  {
    label: 'Create a table',
    description: 'DDL',
    sql: `CREATE TABLE demo_notes (
  id    serial PRIMARY KEY,
  note  text NOT NULL,
  added timestamptz NOT NULL DEFAULT now()
);`,
  },
  {
    label: 'Insert rows',
    description: 'Write',
    sql: `INSERT INTO demo_notes (note) VALUES
  ('basefyio is fast'),
  ('the playground runs in my browser')
RETURNING *;`,
  },
  {
    label: 'Update rows',
    description: 'Mutate',
    sql: "UPDATE orders SET status = 'delivered' WHERE status = 'shipped' RETURNING id, status;",
  },
  {
    label: 'Delete rows',
    description: 'Remove',
    sql: "DELETE FROM todos WHERE done = true RETURNING id, title;",
  },
];
