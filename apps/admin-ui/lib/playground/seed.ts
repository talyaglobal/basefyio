// Seed dataset for the in-browser Playground database (PGlite).
//
// Six related tables with enough rows to demonstrate joins and aggregates.
// "Auto-reset" simply drops everything and re-runs this — see engine.reset().

export const SEED_SQL = /* sql */ `
DROP TABLE IF EXISTS comments, posts, todos, orders, products, users CASCADE;

CREATE TABLE users (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id     serial PRIMARY KEY,
  name   text NOT NULL,
  price  numeric(10,2) NOT NULL,
  stock  integer NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id),
  product_id  integer NOT NULL REFERENCES products(id),
  quantity    integer NOT NULL DEFAULT 1,
  total       numeric(10,2) NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE todos (
  id       serial PRIMARY KEY,
  user_id  integer NOT NULL REFERENCES users(id),
  title    text NOT NULL,
  done     boolean NOT NULL DEFAULT false
);

CREATE TABLE posts (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id),
  title       text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comments (
  id          serial PRIMARY KEY,
  post_id     integer NOT NULL REFERENCES posts(id),
  user_id     integer NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (name, email) VALUES
  ('Ada Lovelace',      'ada@example.com'),
  ('Alan Turing',       'alan@example.com'),
  ('Grace Hopper',      'grace@example.com'),
  ('Linus Torvalds',    'linus@example.com'),
  ('Margaret Hamilton', 'margaret@example.com'),
  ('Dennis Ritchie',    'dennis@example.com'),
  ('Barbara Liskov',    'barbara@example.com'),
  ('Ken Thompson',      'ken@example.com');

INSERT INTO products (name, price, stock) VALUES
  ('Mechanical Keyboard', 129.00, 42),
  ('27" Monitor',         349.99, 15),
  ('Wireless Mouse',       49.50, 87),
  ('USB-C Hub',            64.00, 30),
  ('Laptop Stand',         39.99, 53),
  ('Noise-cancel Headset',199.00, 21),
  ('Webcam 1080p',         79.00, 64),
  ('Desk Mat',             24.99, 120),
  ('Ergonomic Chair',     499.00,  9),
  ('Standing Desk',       599.00,  6);

INSERT INTO orders (user_id, product_id, quantity, total, status) VALUES
  (1, 1, 1, 129.00, 'shipped'),
  (1, 3, 2,  99.00, 'shipped'),
  (2, 2, 1, 349.99, 'pending'),
  (2, 9, 1, 499.00, 'paid'),
  (3, 5, 3, 119.97, 'shipped'),
  (3, 8, 4,  99.96, 'delivered'),
  (4, 6, 1, 199.00, 'paid'),
  (4, 7, 2, 158.00, 'pending'),
  (5,10, 1, 599.00, 'paid'),
  (5, 4, 1,  64.00, 'shipped'),
  (6, 1, 2, 258.00, 'delivered'),
  (7, 3, 1,  49.50, 'cancelled'),
  (7, 2, 1, 349.99, 'paid'),
  (8, 6, 1, 199.00, 'shipped'),
  (1, 8, 5, 124.95, 'delivered');

INSERT INTO todos (user_id, title, done) VALUES
  (1, 'Design analytical engine API',  true),
  (1, 'Write first program',           true),
  (2, 'Define the halting problem',    false),
  (2, 'Build the bombe',               true),
  (3, 'Coin the term "debugging"',     true),
  (3, 'Standardize COBOL',             false),
  (4, 'Release kernel 1.0',            true),
  (4, 'Review 200 pull requests',      false),
  (5, 'Ship Apollo guidance software', true),
  (6, 'Finish the C compiler',         true),
  (7, 'Prove data abstraction',        false),
  (8, 'Co-author Unix',                true);

INSERT INTO posts (user_id, title, body) VALUES
  (1, 'On analytical engines', 'The engine can do whatever we know how to order it to perform.'),
  (2, 'Can machines think?',   'A computer would deserve to be called intelligent if it could deceive a human.'),
  (3, 'Bugs and moths',        'From then on, when anything went wrong we said it had bugs in it.'),
  (4, 'Just for fun',          'Software is like sex: it is better when it is free.'),
  (6, 'The C programming language', 'C is quirky, flawed, and an enormous success.'),
  (7, 'Abstraction matters',   'Data abstraction lets us reason about programs in pieces.');

INSERT INTO comments (post_id, user_id, body) VALUES
  (1, 2, 'Remarkably ahead of its time.'),
  (1, 3, 'The first algorithm, no less.'),
  (2, 1, 'A profound question.'),
  (2, 4, 'Still debated today.'),
  (3, 5, 'A literal moth!'),
  (3, 8, 'Classic origin story.'),
  (4, 6, 'Couldn''t agree more.'),
  (4, 7, 'Open source for the win.'),
  (5, 8, 'C changed everything.'),
  (5, 4, 'The kernel is written in it.'),
  (6, 1, 'Elegant and timeless.'),
  (6, 3, 'Foundational work.');
`;

// Tables exposed in the Table Browser, in display order.
export const SEED_TABLES = [
  'users',
  'products',
  'orders',
  'todos',
  'posts',
  'comments',
] as const;
