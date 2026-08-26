import { describe, expect, it } from 'vitest';

import { parseEagerPaths, parseMemberOnlyReadPaths } from '../parseEagerPaths';

const routesDoc = (directive: Record<string, unknown>) => ({
  includes: [{ view_type_routes: directive }],
});

describe('parseEagerPaths', () => {
  it('returns empty map when routesDoc has no eager_path', () => {
    expect(parseEagerPaths({})).toEqual(new Map());
    expect(parseEagerPaths(null)).toEqual(new Map());
    expect(parseEagerPaths(routesDoc({}))).toEqual(new Map());
  });

  it('parses single-level paths into one node per root entity', () => {
    const result = parseEagerPaths(routesDoc({ eager_path: ['todo.tasks', 'todo.meetings'] }));
    const todo = result.get('todo')!;
    expect(todo).toBeDefined();
    expect(Array.from(todo.keys()).sort()).toEqual(['meetings', 'tasks']);
    expect(todo.get('tasks')!.size).toBe(0);
    expect(todo.get('meetings')!.size).toBe(0);
  });

  it('merges multiple paths sharing a root into one tree', () => {
    const result = parseEagerPaths(routesDoc({ eager_path: ['user.posts.tags', 'user.tags'] }));
    const user = result.get('user')!;
    expect(Array.from(user.keys()).sort()).toEqual(['posts', 'tags']);
    const posts = user.get('posts')!;
    expect(Array.from(posts.keys())).toEqual(['tags']);
    expect(posts.get('tags')!.size).toBe(0);
  });

  it('builds nested trees of arbitrary depth', () => {
    const result = parseEagerPaths(routesDoc({ eager_path: ['a.b.c.d'] }));
    expect(result.get('a')!.get('b')!.get('c')!.get('d')!.size).toBe(0);
  });

  it('separates roots into independent entries', () => {
    const result = parseEagerPaths(
      routesDoc({ eager_path: ['user.posts', 'todo.tasks', 'post.tags'] }),
    );
    expect(Array.from(result.keys()).sort()).toEqual(['post', 'todo', 'user']);
  });

  it('reads per-entity eager_read_path as dotted trees (contacts sample)', () => {
    const result = parseEagerPaths({
      routes: [
        { contact: { eager_read_path: ['addresses', 'phones'] } },
        { contact_group: { eager_read_path: ['members'] } },
      ],
    });
    expect(Array.from(result.get('contact')!.keys()).sort()).toEqual(['addresses', 'phones']);
    expect(Array.from(result.get('contact_group')!.keys())).toEqual(['members']);
  });

  it('throws on a path that does not contain a dot (root-only)', () => {
    expect(() => parseEagerPaths(routesDoc({ eager_path: ['user'] }))).toThrow(/eager_path/i);
  });

  it('throws when eager_path is not an array', () => {
    expect(() => parseEagerPaths(routesDoc({ eager_path: 'user.posts' }))).toThrow();
  });

  it('throws on empty path segments', () => {
    expect(() => parseEagerPaths(routesDoc({ eager_path: ['user..tags'] }))).toThrow();
    expect(() => parseEagerPaths(routesDoc({ eager_path: ['.tags'] }))).toThrow();
    expect(() => parseEagerPaths(routesDoc({ eager_path: ['user.'] }))).toThrow();
  });
});

describe('parseMemberOnlyReadPaths', () => {
  it('returns an empty set when the key is absent', () => {
    expect(parseMemberOnlyReadPaths({})).toEqual(new Set());
    expect(parseMemberOnlyReadPaths(routesDoc({ eager_path: ['project.files'] }))).toEqual(
      new Set(),
    );
  });

  it('parses a subset of eager_path', () => {
    const result = parseMemberOnlyReadPaths(
      routesDoc({
        eager_path: ['project.files', 'test.steps'],
        eager_read_member_only: ['project.files'],
      }),
    );
    expect(result).toEqual(new Set(['project.files']));
  });

  it('throws when an entry is not also declared in eager_path', () => {
    expect(() =>
      parseMemberOnlyReadPaths(
        routesDoc({ eager_path: ['test.steps'], eager_read_member_only: ['project.files'] }),
      ),
    ).toThrow(/not in eager_path/i);
  });

  it('throws when an entry is not depth-1', () => {
    expect(() =>
      parseMemberOnlyReadPaths(
        routesDoc({
          eager_path: ['user.posts.tags'],
          eager_read_member_only: ['user.posts.tags'],
        }),
      ),
    ).toThrow(/depth-1/i);
  });

  it('throws when eager_read_member_only is not an array', () => {
    expect(() =>
      parseMemberOnlyReadPaths(
        routesDoc({ eager_path: ['project.files'], eager_read_member_only: 'project.files' }),
      ),
    ).toThrow();
  });
});
