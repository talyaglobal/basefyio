import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (must be defined before vi.mock factories run) ──────────────

const { mockApiClient } = vi.hoisted(() => {
  const mockApiClient = {
    listItems: vi.fn(),
    getItem: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
  };
  return { mockApiClient };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../lib/config.js', () => ({
  isLoggedIn: vi.fn().mockReturnValue(true),
  getProjectConfig: vi.fn(),
}));

vi.mock('../lib/ui.js', () => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  createSpinner: vi.fn().mockReturnValue({ stop: vi.fn() }),
  printTable: vi.fn(),
  printHeader: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  apiClient: mockApiClient,
  handleApiError: vi.fn().mockImplementation(async (err) => { throw err; }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { listItems, getItem, createItem, deleteItem } from './items.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROJECT_ID   = 'proj-123';
const ENTITY_NAME  = 'customers';
const ITEM_ID      = 'i-1';

const ITEM_PAGE = {
  data: [{ id: ITEM_ID, name: 'Alice' }],
  nextCursor: null,
  total: 1,
};

const ITEM = { id: ITEM_ID, name: 'Alice' };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('items CLI commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // ── listItems ──────────────────────────────────────────────────────────────

  describe('listItems', () => {
    it('calls apiClient.listItems with defaults and prints JSON', async () => {
      mockApiClient.listItems.mockResolvedValue(ITEM_PAGE);

      await listItems(PROJECT_ID, ENTITY_NAME, {});

      expect(mockApiClient.listItems).toHaveBeenCalledWith(PROJECT_ID, ENTITY_NAME, {
        limit: 20,
        cursor: undefined,
        sort: undefined,
        order: undefined,
        filters: {},
      });
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(ITEM_PAGE, null, 2));
    });

    it('passes limit, cursor, sort, order, and filters', async () => {
      mockApiClient.listItems.mockResolvedValue(ITEM_PAGE);

      await listItems(PROJECT_ID, ENTITY_NAME, {
        limit: '5',
        cursor: 'tok-abc',
        sort: 'name',
        order: 'asc',
        filter: ['status=active', 'role=admin'],
      });

      expect(mockApiClient.listItems).toHaveBeenCalledWith(PROJECT_ID, ENTITY_NAME, {
        limit: 5,
        cursor: 'tok-abc',
        sort: 'name',
        order: 'asc',
        filters: { status: 'active', role: 'admin' },
      });
    });

    it('propagates errors via handleApiError', async () => {
      const err = new Error('server error');
      mockApiClient.listItems.mockRejectedValue(err);

      await expect(listItems(PROJECT_ID, ENTITY_NAME, {})).rejects.toThrow('server error');
    });
  });

  // ── getItem ────────────────────────────────────────────────────────────────

  describe('getItem', () => {
    it('calls apiClient.getItem and prints JSON', async () => {
      mockApiClient.getItem.mockResolvedValue(ITEM);

      await getItem(PROJECT_ID, ENTITY_NAME, ITEM_ID);

      expect(mockApiClient.getItem).toHaveBeenCalledWith(PROJECT_ID, ENTITY_NAME, ITEM_ID);
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(ITEM, null, 2));
    });

    it('propagates errors via handleApiError', async () => {
      mockApiClient.getItem.mockRejectedValue(new Error('not found'));
      await expect(getItem(PROJECT_ID, ENTITY_NAME, ITEM_ID)).rejects.toThrow('not found');
    });
  });

  // ── createItem ─────────────────────────────────────────────────────────────

  describe('createItem', () => {
    it('parses JSON data and calls apiClient.createItem', async () => {
      const created = { id: 'i-2', name: 'Bob' };
      mockApiClient.createItem.mockResolvedValue(created);

      await createItem(PROJECT_ID, ENTITY_NAME, JSON.stringify({ name: 'Bob' }));

      expect(mockApiClient.createItem).toHaveBeenCalledWith(
        PROJECT_ID,
        ENTITY_NAME,
        { name: 'Bob' },
      );
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(created, null, 2));
    });

    it('throws when --data is not valid JSON', async () => {
      await expect(
        createItem(PROJECT_ID, ENTITY_NAME, 'not-json'),
      ).rejects.toThrow('--data must be a valid JSON string');
    });
  });

  // ── deleteItem ─────────────────────────────────────────────────────────────

  describe('deleteItem', () => {
    it('calls apiClient.deleteItem and prints JSON', async () => {
      const result = { deleted: true, id: ITEM_ID };
      mockApiClient.deleteItem.mockResolvedValue(result);

      await deleteItem(PROJECT_ID, ENTITY_NAME, ITEM_ID);

      expect(mockApiClient.deleteItem).toHaveBeenCalledWith(PROJECT_ID, ENTITY_NAME, ITEM_ID);
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    });

    it('propagates errors via handleApiError', async () => {
      mockApiClient.deleteItem.mockRejectedValue(new Error('delete failed'));
      await expect(deleteItem(PROJECT_ID, ENTITY_NAME, ITEM_ID)).rejects.toThrow('delete failed');
    });
  });
});
