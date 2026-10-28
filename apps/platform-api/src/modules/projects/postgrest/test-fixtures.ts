import { ProjectSchema, SchemaCache } from './schema-cache';

/**
 * A small fixed schema shared by the PostgREST specs: posts belong to a user
 * (author) and have many comments.
 *
 *   posts(id, title, author_id, body, created_at)   author_id → users.id
 *   users(id, name, email, profile)
 *   comments(id, post_id, body, status, created_at) post_id  → posts.id
 *   tags(id, name) ⇄ post_tags(post_id, tag_id)      many-to-many
 */
export function fixtureSchema(): { schema: ProjectSchema; cache: SchemaCache } {
  const tables = new Map();
  const mk = (name: string, cols: string[], pk: string[]) =>
    tables.set(name, { name, columns: new Set(cols), primaryKey: pk });
  mk('posts', ['id', 'title', 'author_id', 'body', 'created_at'], ['id']);
  mk('users', ['id', 'name', 'email', 'profile'], ['id']);
  mk('comments', ['id', 'post_id', 'body', 'status', 'created_at'], ['id']);
  mk('tags', ['id', 'name'], ['id']);
  mk('post_tags', ['post_id', 'tag_id'], ['post_id', 'tag_id']);
  // A table without a primary key, for the upsert refusal.
  mk('events', ['name', 'at'], []);

  const schema: ProjectSchema = {
    tables,
    foreignKeys: [
      { constraint: 'posts_author_fk', table: 'posts', columns: ['author_id'], foreignTable: 'users', foreignColumns: ['id'] },
      { constraint: 'comments_post_fk', table: 'comments', columns: ['post_id'], foreignTable: 'posts', foreignColumns: ['id'] },
      { constraint: 'post_tags_post_fk', table: 'post_tags', columns: ['post_id'], foreignTable: 'posts', foreignColumns: ['id'] },
      { constraint: 'post_tags_tag_fk', table: 'post_tags', columns: ['tag_id'], foreignTable: 'tags', foreignColumns: ['id'] },
    ],
    loadedAt: Date.now(),
  };
  return { schema, cache: new SchemaCache() };
}
