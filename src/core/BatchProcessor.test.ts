import { describe, it, expect, beforeEach } from 'vitest';
import { BatchProcessor } from './BatchProcessor.js';
import type { NormalizedEvent } from '../types.js';

// Helper to create a mock event
function createMockEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'test_event_1',
    type: 'chat',
    content: 'Test message',
    sourceId: 'source_1',
    url: 'https://feishu.cn/test',
    userId: 'user_1',
    userName: 'Test User',
    timestamp: Date.now(),
    chatId: 'chat_1',
    chatName: 'Test Chat',
    chatType: 'group',
    ...overrides,
  };
}

describe('BatchProcessor', () => {
  let processor: BatchProcessor;

  beforeEach(() => {
    // Create fresh processor for each test
    processor = new BatchProcessor({
      batchWindowHours: 5,
      store: {} as any,
    });
    // Clear any existing batches (module-level singleton)
    processor.clearAll();
  });

  describe('addMessage', () => {
    it('should create a new batch for first message', () => {
      const event = createMockEvent({ id: '1', chatId: 'chat_1' });

      processor.addMessage(event);

      const pending = processor.getPendingBatches();
      expect(pending).toHaveLength(1);
      expect(pending[0].groupKey).toBe('group_chat_1');
      expect(pending[0].messages).toHaveLength(1);
    });

    it('should add message to existing batch', () => {
      const event1 = createMockEvent({ id: '1', chatId: 'chat_1', timestamp: 1000 });
      const event2 = createMockEvent({ id: '2', chatId: 'chat_1', timestamp: 2000 });

      processor.addMessage(event1);
      processor.addMessage(event2);

      const pending = processor.getPendingBatches();
      expect(pending).toHaveLength(1);
      expect(pending[0].messages).toHaveLength(2);
    });

    it('should separate group and p2p chats', () => {
      const groupEvent = createMockEvent({ id: '1', chatId: 'chat_1', chatType: 'group' });
      const p2pEvent = createMockEvent({ id: '2', chatId: 'chat_1', chatType: 'p2p' });

      processor.addMessage(groupEvent);
      processor.addMessage(p2pEvent);

      const pending = processor.getPendingBatches();
      expect(pending).toHaveLength(2);
      expect(pending.map((b) => b.groupKey)).toContain('group_chat_1');
      expect(pending.map((b) => b.groupKey)).toContain('p2p_chat_1');
    });

    it('should group docs by docId', () => {
      const docEvent = createMockEvent({ id: '1', type: 'doc', sourceId: 'doc_123' });

      processor.addMessage(docEvent);

      const pending = processor.getPendingBatches();
      expect(pending).toHaveLength(1);
      expect(pending[0].groupKey).toBe('doc_doc_123');
    });

    it('should group meetings by meetingId', () => {
      const meetingEvent = createMockEvent({ id: '1', type: 'meeting', sourceId: 'meeting_123' });

      processor.addMessage(meetingEvent);

      const pending = processor.getPendingBatches();
      expect(pending).toHaveLength(1);
      expect(pending[0].groupKey).toBe('meeting_meeting_123');
    });

    it('should group tasks by taskId', () => {
      const taskEvent = createMockEvent({ id: '1', type: 'task', sourceId: 'task_123' });

      processor.addMessage(taskEvent);

      const pending = processor.getPendingBatches();
      expect(pending).toHaveLength(1);
      expect(pending[0].groupKey).toBe('task_task_123');
    });
  });

  describe('getReadyBatches', () => {
    it('should not return batches within time window', () => {
      const now = Date.now();
      const event = createMockEvent({
        id: '1',
        chatId: 'chat_1',
        timestamp: now - 1000, // 1 second ago
      });

      processor.addMessage(event);

      const ready = processor.getReadyBatches();
      expect(ready).toHaveLength(0);
    });

    it('should return batches that exceeded time window', () => {
      const now = Date.now();
      const event = createMockEvent({
        id: '1',
        chatId: 'chat_1',
        timestamp: now - 6 * 60 * 60 * 1000, // 6 hours ago (> 5 hour window)
      });

      processor.addMessage(event);

      const ready = processor.getReadyBatches();
      expect(ready).toHaveLength(1);
    });

    it('should not return empty batches', () => {
      const now = Date.now();
      const event = createMockEvent({
        id: '1',
        chatId: 'chat_1',
        timestamp: now - 6 * 60 * 60 * 1000,
      });

      processor.addMessage(event);
      processor.clearBatch('group_chat_1');

      const ready = processor.getReadyBatches();
      expect(ready).toHaveLength(0);
    });
  });

  describe('clearBatch', () => {
    it('should remove a specific batch', () => {
      const event = createMockEvent({ id: '1', chatId: 'chat_1' });
      processor.addMessage(event);

      processor.clearBatch('group_chat_1');

      const pending = processor.getPendingBatches();
      expect(pending).toHaveLength(0);
    });

    it('should only remove specified batch', () => {
      const event1 = createMockEvent({ id: '1', chatId: 'chat_1' });
      const event2 = createMockEvent({ id: '2', chatId: 'chat_2' });

      processor.addMessage(event1);
      processor.addMessage(event2);
      processor.clearBatch('group_chat_1');

      const pending = processor.getPendingBatches();
      expect(pending).toHaveLength(1);
      expect(pending[0].groupKey).toBe('group_chat_2');
    });
  });

  describe('clearAll', () => {
    it('should remove all batches', () => {
      processor.addMessage(createMockEvent({ id: '1', chatId: 'chat_1' }));
      processor.addMessage(createMockEvent({ id: '2', chatId: 'chat_2' }));

      processor.clearAll();

      expect(processor.getPendingBatches()).toHaveLength(0);
    });
  });

  describe('getBatchCount', () => {
    it('should count batches by type', () => {
      processor.addMessage(createMockEvent({ id: '1', type: 'chat', chatType: 'group', chatId: 'g1' }));
      processor.addMessage(createMockEvent({ id: '2', type: 'chat', chatType: 'group', chatId: 'g2' }));
      processor.addMessage(createMockEvent({ id: '3', type: 'chat', chatType: 'p2p', chatId: 'p1' }));
      processor.addMessage(createMockEvent({ id: '4', type: 'doc', sourceId: 'd1' }));
      processor.addMessage(createMockEvent({ id: '5', type: 'meeting', sourceId: 'm1' }));
      processor.addMessage(createMockEvent({ id: '6', type: 'task', sourceId: 't1' }));

      const counts = processor.getBatchCount();

      expect(counts.group).toBe(2);
      expect(counts.p2p).toBe(1);
      expect(counts.doc).toBe(1);
      expect(counts.meeting).toBe(1);
      expect(counts.task).toBe(1);
    });
  });

  describe('batch metadata', () => {
    it('should track first and last message time', () => {
      const t1 = Date.now() - 10000;
      const t2 = Date.now() - 5000;
      const t3 = Date.now();

      processor.addMessage(createMockEvent({ id: '1', chatId: 'chat_1', timestamp: t1 }));
      processor.addMessage(createMockEvent({ id: '2', chatId: 'chat_1', timestamp: t2 }));
      processor.addMessage(createMockEvent({ id: '3', chatId: 'chat_1', timestamp: t3 }));

      const pending = processor.getPendingBatches();
      expect(pending[0].firstMessageTime).toBe(t1);
      expect(pending[0].lastMessageTime).toBe(t3);
    });

    it('should store source info correctly', () => {
      const event = createMockEvent({
        id: '1',
        type: 'chat',
        chatId: 'chat_123',
        chatName: 'My Chat Room',
        sourceId: 'msg_001',
      });

      processor.addMessage(event);

      const pending = processor.getPendingBatches();
      expect(pending[0].sourceType).toBe('chat');
      expect(pending[0].sourceId).toBe('msg_001');
      expect(pending[0].sourceName).toBe('My Chat Room');
    });
  });
});
