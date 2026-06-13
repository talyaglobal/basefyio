import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

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

// ── Imports ──────────────────────────────────────────────────────────────────

import { listItems, getItem, createItem, updateItem, deleteItem } from './items.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PROJECT_ID   = 'proj-123';
const STRUCTURE_ID = 'str-456';
const ITEM_ID      = 'i-1';

const ITEM_PAGE = {
  data: [{ id: ITEM_ID, data: { title: 'Alice' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  nextCursor: null,
  total: 1,
};

const ITEM = { id: ITEM_ID, data: { title: 'Alice' } };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('items CLI commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('listItems', () => {
    it('calls apiClient.listItems with structureId and defaults', async () => {
      mockApiClient.listItems.mockResolvedValue(ITEM_PAGE);
      await listItems(PROJECT_ID, STRUCTURE_ID, {});
      expect(mockApiClient.listItems).toHaveBeenCalledWith(PROJECT_ID, STRUCTURE_ID, {
        limit: 20,
        cursor: undefined,
      });
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(ITEM_PAGE, null, 2));
    });

    it('passes limit and cursor', async () => {
      mockApiClient.listItems.mockResolvedValue(ITEM_PAGE);
      await listItems(PROJECT_ID, STRUCTURE_ID, { limit: '5', cursor: 'tok-abc' });
      expect(mockApiClient.listItems).toHaveBeenCalledWith(PROJECT_ID, STRUCTURE_ID, {
        limit: 5,
        cursor: 'tok-abc',
      });
    });

    it('propagates errors', async () => {
      mockApiClient.listItems.mockRejectedValue(new Error('server error'));
      await expect(listItems(PROJECT_ID, STRUCTURE_ID, {})).rejects.toThrow('server error');
    });
  });

  describe('getItem', () => {
    it('calls apiClient.getItem and prints JSON', async () => {
      mockApiClient.getItem.mockResolvedValue(ITEM);
      await getItem(PROJECT_ID, STRUCTURE_ID, ITEM_ID);
      expect(mockApiClient.getItem).toHaveBeenCalledWith(PROJECT_ID, STRUCTURE_ID, ITEM_ID);
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(ITEM, null, 2));
    });

    it('propagates errors', async () => {
      mockApiClient.getItem.mockRejectedValue(new Error('not found'));
      await expect(getItem(PROJECT_ID, STRUCTURE_ID, ITEM_ID)).rejects.toThrow('not found');
    });
  });

  describe('createItem', () => {
    it('parses JSON data and calls apiClient.createItem', async () => {
      const created = { id: 'i-2', data: { title: 'Bob' } };
      mockApiClient.createItem.mockResolvedValue(created);
      await createItem(PROJECT_ID, STRUCTURE_ID, JSON.stringify({ title: 'Bob' }));
      expect(mockApiClient.createItem).toHaveBeenCalledWith(
        PROJECT_ID,
        STRUCTURE_ID,
        { title: 'Bob' },
      );
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(created, null, 2));
    });

    it('throws when --data is not valid JSON', async () => {
      await expect(createItem(PROJECT_ID, STRUCTURE_ID, 'not-json')).rejects.toThrow(
        '--data must be a valid JSON string',
      );
    });
  });

  describe('updateItem', () => {
    it('parses JSON and calls apiClient.updateItem', async () => {
      const updated = { id: ITEM_ID, data: { title: 'Updated' } };
      mockApiClient.updateItem.mockResolvedValue(updated);
      await updateItem(PROJECT_ID, STRUCTURE_ID, ITEM_ID, JSON.stringify({ title: 'Updated' }));
      expect(mockApiClient.updateItem).toHaveBeenCalledWith(
        PROJECT_ID,
        STRUCTURE_ID,
        ITEM_ID,
        { title: 'Updated' },
      );
    });

    it('throws when --data is not valid JSON', async () => {
      await expect(updateItem(PROJECT_ID, STRUCTURE_ID, ITEM_ID, 'bad')).rejects.toThrow(
        '--data must be a valid JSON string',
      );
    });
  });

  describe('deleteItem', () => {
    it('calls apiClient.deleteItem and prints JSON', async () => {
      const result = { deleted: true, id: ITEM_ID };
      mockApiClient.deleteItem.mockResolvedValue(result);
      await deleteItem(PROJECT_ID, STRUCTURE_ID, ITEM_ID);
      expect(mockApiClient.deleteItem).toHaveBeenCalledWith(PROJECT_ID, STRUCTURE_ID, ITEM_ID);
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    });

    it('propagates errors', async () => {
      mockApiClient.deleteItem.mockRejectedValue(new Error('delete failed'));
      await expect(deleteItem(PROJECT_ID, STRUCTURE_ID, ITEM_ID)).rejects.toThrow('delete failed');
    });
  });
});
