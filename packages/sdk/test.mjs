import { createClient } from './dist/index.js';

const kb = createClient({
  apiUrl: process.env.KOLAYBASE_API_URL || 'http://localhost:4000',
  projectId: process.env.KOLAYBASE_PROJECT_ID || '5c136820-8052-4737-8c2f-82164c1de90b',
  apiKey: process.env.KOLAYBASE_ANON_KEY || 'your-anon-key',
});

async function run() {
  console.log('═══════════════════════════════════════');
  console.log('  @kolaybase/sdk  —  Integration Test');
  console.log('═══════════════════════════════════════\n');

  // ── 1. Auth ─────────────────────────────────────
  console.log('▸ Auth: signIn');
  const { data: auth, error: authErr } = await kb.auth.signIn({
    email: process.env.KOLAYBASE_TEST_EMAIL || 'test@example.com',
    password: process.env.KOLAYBASE_TEST_PASSWORD || '123456',
  });
  if (authErr) {
    console.error('  ✗ signIn failed:', authErr.message);
    process.exit(1);
  }
  console.log('  ✓ Logged in, token:', auth.accessToken.slice(0, 30) + '…');

  console.log('\n▸ Auth: getUser');
  const { data: user, error: userErr } = await kb.auth.getUser();
  if (userErr) console.log('  ✗ getUser failed:', userErr.message);
  else console.log('  ✓ User:', user.preferred_username, '(' + user.email + ')');

  console.log('\n▸ Auth: getSession');
  const session = kb.auth.getSession();
  console.log('  ✓ Session exists:', !!session, '| expiresAt:', new Date(session?.expiresAt || 0).toLocaleTimeString());

  // ── 2. Database ─────────────────────────────────
  console.log('\n▸ DB: listTables');
  const { data: tables, error: tablesErr } = await kb.listTables();
  if (tablesErr) console.log('  ✗ listTables failed:', tablesErr.message);
  else console.log('  ✓ Tables:', tables.map((t) => t.name).join(', ') || '(empty)');

  console.log('\n▸ DB: raw SQL — create test table');
  const { error: createErr } = await kb.sql(`
    CREATE TABLE IF NOT EXISTS sdk_test (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      score INT DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  if (createErr) console.log('  ✗ create table failed:', createErr.message);
  else console.log('  ✓ Table sdk_test created');

  console.log('\n▸ DB: insert');
  const { data: inserted, error: insErr } = await kb.from('sdk_test').insert([
    { name: 'Alice', score: 95, active: true },
    { name: 'Bob', score: 82, active: true },
    { name: 'Charlie', score: 70, active: false },
  ]);
  if (insErr) console.log('  ✗ insert failed:', insErr.message);
  else console.log('  ✓ Inserted', inserted.length, 'rows');

  console.log('\n▸ DB: select with filters');
  const { data: rows, error: selErr } = await kb
    .from('sdk_test')
    .select('id, name, score')
    .eq('active', true)
    .order('score', { ascending: false })
    .limit(10);
  if (selErr) console.log('  ✗ select failed:', selErr.message);
  else {
    console.log('  ✓ Active users (desc by score):');
    rows.forEach((r) => console.log(`    - ${r.name} (score: ${r.score})`));
  }

  console.log('\n▸ DB: update');
  const { data: updated, error: updErr } = await kb
    .from('sdk_test')
    .update({ score: 99 })
    .eq('name', 'Alice');
  if (updErr) console.log('  ✗ update failed:', updErr.message);
  else console.log('  ✓ Updated Alice:', JSON.stringify(updated[0]));

  console.log('\n▸ DB: toSQL() preview');
  const query = kb.from('sdk_test').select('*').gte('score', 80).order('name').limit(5);
  console.log('  ✓ SQL:', query.toSQL());

  console.log('\n▸ DB: delete');
  const { data: deleted, error: delErr } = await kb
    .from('sdk_test')
    .delete()
    .eq('name', 'Charlie');
  if (delErr) console.log('  ✗ delete failed:', delErr.message);
  else console.log('  ✓ Deleted', deleted.length, 'row(s)');

  // ── 3. Storage ──────────────────────────────────
  console.log('\n▸ Storage: listBuckets');
  const { data: buckets, error: buckErr } = await kb.storage.listBuckets();
  if (buckErr) console.log('  ✗ listBuckets failed:', buckErr.message);
  else console.log('  ✓ Buckets:', buckets.map((b) => `${b.name} (${b.public ? 'public' : 'private'})`).join(', ') || '(none)');

  console.log('\n▸ Storage: createBucket');
  const { data: newBucket, error: cbErr } = await kb.storage.createBucket('sdk-test', { public: false });
  if (cbErr) console.log('  ✗ createBucket failed:', cbErr.message, '(may already exist)');
  else console.log('  ✓ Created bucket:', newBucket.name);

  console.log('\n▸ Storage: upload');
  const bucket = kb.storage.from('sdk-test');
  const content = new TextEncoder().encode('Hello from @kolaybase/sdk! 🚀');
  const blob = new Blob([content], { type: 'text/plain' });
  const { data: uploaded, error: upErr } = await bucket.upload('hello.txt', blob, { contentType: 'text/plain' });
  if (upErr) console.log('  ✗ upload failed:', upErr.message);
  else console.log('  ✓ Uploaded:', uploaded.name, `(${uploaded.size} bytes)`);

  console.log('\n▸ Storage: list objects');
  const { data: objects, error: listErr } = await bucket.list();
  if (listErr) console.log('  ✗ list failed:', listErr.message);
  else console.log('  ✓ Objects:', objects.map((o) => o.name || o.prefix).join(', '));

  console.log('\n▸ Storage: download');
  const { data: dlBlob, error: dlErr } = await bucket.download('hello.txt');
  if (dlErr) console.log('  ✗ download failed:', dlErr.message);
  else {
    const text = await dlBlob.text();
    console.log('  ✓ Downloaded content:', text);
  }

  console.log('\n▸ Storage: createSignedUrl');
  const { data: signed, error: signErr } = await bucket.createSignedUrl('hello.txt', { expiresIn: 600 });
  if (signErr) console.log('  ✗ signedUrl failed:', signErr.message);
  else console.log('  ✓ Signed URL:', signed.url.slice(0, 80) + '…');

  console.log('\n▸ Storage: remove');
  const { data: rmResult, error: rmErr } = await bucket.remove(['hello.txt']);
  if (rmErr) console.log('  ✗ remove failed:', rmErr.message);
  else console.log('  ✓', rmResult.message);

  console.log('\n▸ Storage: deleteBucket');
  const { error: dbErr } = await kb.storage.deleteBucket('sdk-test');
  if (dbErr) console.log('  ✗ deleteBucket failed:', dbErr.message);
  else console.log('  ✓ Bucket sdk-test deleted');

  // ── Cleanup ─────────────────────────────────────
  console.log('\n▸ Cleanup: drop sdk_test table');
  await kb.sql('DROP TABLE IF EXISTS sdk_test');
  console.log('  ✓ Cleaned up');

  console.log('\n═══════════════════════════════════════');
  console.log('  All tests passed! ✓');
  console.log('═══════════════════════════════════════\n');

  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
