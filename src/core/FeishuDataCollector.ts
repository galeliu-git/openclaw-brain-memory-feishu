/**
 * 飞书数据采集器
 *
 * 通过 OpenClaw ctx.http 采集飞书数据：
 * - 群聊/私聊消息
 * - 文档内容
 * - 会议纪要
 * - 任务
 */

import type { NormalizedEvent } from '../types.js';
import { FeishuHttpAdapter } from './adapters/FeishuHttpAdapter.js';

export interface FeishuDataCollectorConfig {
  sources: {
    chats: boolean;
    docs: boolean;
    meetings: boolean;
    tasks: boolean;
  };
}

export class FeishuDataCollector {
  private feishuAdapter: FeishuHttpAdapter;

  constructor(
    private ctx: any,
    private config: FeishuDataCollectorConfig
  ) {
    // feishu token 从 ctx.feishu.token 获取（由 OpenClaw 飞书插件统一管理）
    // 如果没有配置凭证，FeishuHttpAdapter 会尝试从 ctx 获取
    this.feishuAdapter = new FeishuHttpAdapter(ctx);
  }

  // ============================================================================
  // 采集所有已开启的数据源
  // ============================================================================

  /**
   * 采集所有已开启的数据源
   */
  async collectAll(): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    if (this.config.sources.chats) {
      const chatEvents = await this.collectChats();
      events.push(...chatEvents);
    }

    if (this.config.sources.docs) {
      const docEvents = await this.collectDocs();
      events.push(...docEvents);
    }

    if (this.config.sources.meetings) {
      const meetingEvents = await this.collectMeetings();
      events.push(...meetingEvents);
    }

    if (this.config.sources.tasks) {
      const taskEvents = await this.collectTasks();
      events.push(...taskEvents);
    }

    return events;
  }

  // ============================================================================
  // 采集群聊和私聊消息
  // ============================================================================

  /**
   * 采集群聊消息
   */
  async collectChats(): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    try {
      const chatListResponse = await this.feishuAdapter.listChats();
      const chats = chatListResponse.data?.items || [];

      for (const chat of chats) {
        if (!chat.chat_id) continue;

        const isGroup = chat.chat_type === 'group';
        const messages = await this.collectChatMessages(
          chat.chat_id,
          isGroup ? 'group' : 'p2p'
        );
        events.push(...messages);
      }
    } catch (error) {
      console.error('采集群聊失败:', error);
    }

    return events;
  }

  /**
   * 采集单个群聊的消息
   */
  private async collectChatMessages(
    chatId: string,
    chatType: 'group' | 'p2p'
  ): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    try {
      const response = await this.feishuAdapter.getMessages(chatId, {
        limit: 100,
        sortType: 'ByCreateTimeDesc',
      });

      const messages = response.data?.items || [];

      for (const msg of messages) {
        if (!msg.message_id || !msg.body) continue;

        // 解析消息内容
        let content = '';
        try {
          const body = JSON.parse(msg.body);
          content = body.text || body.content || '';
        } catch {
          content = msg.body;
        }

        // 提取 @ 的用户
        const mentionedUserIds: string[] = [];
        if (msg.mentions) {
          for (const mention of msg.mentions) {
            if (mention.key === 'at_user' && mention.id) {
              mentionedUserIds.push(mention.id);
            }
          }
        }

        // 获取发送者信息
        const userId = msg.sender?.id?.user_id || '';
        const userName = msg.sender?.id?.string_user_id || '';

        const event: NormalizedEvent = {
          id: `feishu_chat_${msg.message_id}`,
          type: 'chat',
          content,
          sourceId: msg.message_id,
          url: `https://[tenant].feishu.cn/message/${chatId}/${msg.message_id}`,
          userId,
          userName,
          timestamp: msg.create_time ? new Date(msg.create_time).getTime() : Date.now(),
          chatId,
          chatName: '',
          chatType,
          mentionedUserIds,
          metadata: {
            chatType: msg.chat_id ? 'group' : 'p2p',
          },
        };

        events.push(event);
      }
    } catch (error) {
      console.error(`采集群聊 ${chatId} 消息失败:`, error);
    }

    return events;
  }

  // ============================================================================
  // 采集文档
  // ============================================================================

  /**
   * 采集文档内容
   */
  async collectDocs(): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    try {
      const docListResponse = await this.feishuAdapter.listDocuments({ limit: 100 });
      const docs = docListResponse.data?.documents || [];

      for (const doc of docs) {
        if (!doc.document_id) continue;

        const docEvent = await this.collectSingleDoc(doc.document_id);
        if (docEvent) {
          events.push(docEvent);
        }
      }
    } catch (error) {
      console.error('采集文档失败:', error);
    }

    return events;
  }

  /**
   * 采集单个文档内容
   */
  private async collectSingleDoc(docId: string): Promise<NormalizedEvent | null> {
    try {
      const response = await this.feishuAdapter.getDocument(docId);
      const doc = response.data?.document;
      if (!doc || !doc.document_id) return null;

      // 获取文档内容
      let content = '';
      if (doc.title) {
        content += `标题: ${doc.title}\n`;
      }

      // 获取文档块内容
      try {
        const blocksResponse = await this.feishuAdapter.listDocumentBlocks(docId);
        const blocks = blocksResponse.data?.items || [];
        for (const block of blocks) {
          if (block.block_id && block.block_type) {
            const blockContent = this.extractBlockText(block);
            if (blockContent) {
              content += blockContent + '\n';
            }
          }
        }
      } catch {
        // 如果获取块失败，只使用标题
      }

      return {
        id: `feishu_doc_${docId}`,
        type: 'doc',
        content: content.trim(),
        sourceId: docId,
        url: `https://[tenant].feishu.cn/docx/${docId}`,
        userId: doc.owner_id || '',
        userName: '',
        timestamp: doc.create_time ? new Date(doc.create_time).getTime() : Date.now(),
        metadata: {
          title: doc.title,
        },
      };
    } catch (error) {
      console.error(`采集文档 ${docId} 失败:`, error);
      return null;
    }
  }

  /**
   * 从文档块中提取文本
   */
  private extractBlockText(block: any): string {
    if (block.text) {
      return block.text.elements?.map((e: any) => e.text_run?.content || '').join('') || '';
    }
    return '';
  }

  // ============================================================================
  // 采集会议
  // ============================================================================

  /**
   * 采集会议纪要
   */
  async collectMeetings(): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    try {
      // 获取最近一周的会议
      const now = Date.now();
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

      const meetingListResponse = await this.feishuAdapter.listMeetings(
        Math.floor(weekAgo / 1000),
        Math.floor(now / 1000),
        { limit: 100 }
      );
      const meetings = meetingListResponse.data?.meeting_list || [];

      for (const meeting of meetings) {
        if (!meeting.meeting_uuid) continue;

        const meetingEvent = await this.collectSingleMeeting(meeting.meeting_uuid);
        if (meetingEvent) {
          events.push(meetingEvent);
        }
      }
    } catch (error) {
      console.error('采集会议失败:', error);
    }

    return events;
  }

  /**
   * 采集单个会议纪要
   */
  private async collectSingleMeeting(meetingId: string): Promise<NormalizedEvent | null> {
    try {
      const response = await this.feishuAdapter.getMeeting(meetingId);
      const meeting = response.data?.meeting;
      if (!meeting || !meeting.meeting_uuid) return null;

      // 构建会议内容摘要
      let content = '';
      if (meeting.topic) {
        content += `会议主题: ${meeting.topic}\n`;
      }
      if (meeting.start_time) {
        content += `开始时间: ${meeting.start_time}\n`;
      }
      if (meeting.end_time) {
        content += `结束时间: ${meeting.end_time}\n`;
      }
      if (meeting.host_user_id) {
        content += `主持人: ${meeting.host_user_id}\n`;
      }

      // 获取会议纪要
      if (meeting.summary) {
        content += `\n会议纪要:\n${meeting.summary}\n`;
      }

      // 获取参与者
      if (meeting.attendees) {
        content += `\n参与者:\n`;
        for (const attendee of meeting.attendees) {
          content += `- ${attendee.name || attendee.user_id}\n`;
        }
      }

      return {
        id: `feishu_meeting_${meetingId}`,
        type: 'meeting',
        content: content.trim(),
        sourceId: meetingId,
        url: `https://[tenant].feishu.cn/meeting/${meetingId}`,
        userId: meeting.host_user_id || '',
        userName: '',
        timestamp: meeting.start_time
          ? new Date(meeting.start_time).getTime()
          : Date.now(),
        metadata: {
          topic: meeting.topic,
          hostUserId: meeting.host_user_id,
        },
      };
    } catch (error) {
      console.error(`采集会议 ${meetingId} 失败:`, error);
      return null;
    }
  }

  // ============================================================================
  // 采集任务
  // ============================================================================

  /**
   * 采集任务
   */
  async collectTasks(): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    try {
      const taskListResponse = await this.feishuAdapter.listTasks({ limit: 100 });
      const tasks = taskListResponse.data?.items || [];

      for (const task of tasks) {
        if (!task.guid) continue;

        const taskEvent = await this.collectSingleTask(task.guid);
        if (taskEvent) {
          events.push(taskEvent);
        }
      }
    } catch (error) {
      console.error('采集任务失败:', error);
    }

    return events;
  }

  /**
   * 采集单个任务
   */
  private async collectSingleTask(taskId: string): Promise<NormalizedEvent | null> {
    try {
      const response = await this.feishuAdapter.getTask(taskId);
      const task = response.data?.task;
      if (!task || !task.guid) return null;

      // 构建任务内容
      let content = '';
      if (task.summary) {
        content += `任务描述: ${task.summary}\n`;
      }
      if (task.due?.datetime) {
        content += `截止时间: ${task.due.datetime}\n`;
      }
      if (task.completed_at) {
        content += `完成时间: ${task.completed_at}\n`;
      }
      if (task.creator) {
        content += `创建者: ${task.creator.name || task.creator.id}\n`;
      }

      // 获取子任务
      if (task.subtasks) {
        content += `\n子任务:\n`;
        for (const subtask of task.subtasks) {
          content += `- ${subtask.summary || subtask.guid}\n`;
        }
      }

      return {
        id: `feishu_task_${taskId}`,
        type: 'task',
        content: content.trim(),
        sourceId: taskId,
        url: `https://[tenant].feishu.cn/task/${taskId}`,
        userId: task.creator?.id || '',
        userName: task.creator?.name || '',
        timestamp: task.created_at
          ? new Date(task.created_at).getTime()
          : Date.now(),
        metadata: {
          status: task.completed_at ? 'completed' : 'pending',
          dueDatetime: task.due?.datetime,
        },
      };
    } catch (error) {
      console.error(`采集任务 ${taskId} 失败:`, error);
      return null;
    }
  }

  // ============================================================================
  // 增量采集
  // ============================================================================

  /**
   * 增量采集 - 只采集指定时间之后的数据
   */
  async collectSince(lastSyncTime: number): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    if (this.config.sources.chats) {
      const chatEvents = await this.collectChatsSince(lastSyncTime);
      events.push(...chatEvents);
    }

    if (this.config.sources.docs) {
      const docEvents = await this.collectDocsSince(lastSyncTime);
      events.push(...docEvents);
    }

    if (this.config.sources.meetings) {
      const meetingEvents = await this.collectMeetingsSince(lastSyncTime);
      events.push(...meetingEvents);
    }

    if (this.config.sources.tasks) {
      const taskEvents = await this.collectTasksSince(lastSyncTime);
      events.push(...taskEvents);
    }

    return events;
  }

  /**
   * 增量采集群聊消息
   */
  private async collectChatsSince(lastSyncTime: number): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    try {
      const chatListResponse = await this.feishuAdapter.listChats();
      const chats = chatListResponse.data?.items || [];

      for (const chat of chats) {
        if (!chat.chat_id) continue;
        const isGroup = chat.chat_type === 'group';
        const messages = await this.collectChatMessagesSince(
          chat.chat_id,
          isGroup ? 'group' : 'p2p',
          lastSyncTime
        );
        events.push(...messages);
      }
    } catch (error) {
      console.error('增量采集群聊失败:', error);
    }

    return events;
  }

  /**
   * 增量采集单个群聊消息
   */
  private async collectChatMessagesSince(
    chatId: string,
    chatType: 'group' | 'p2p',
    lastSyncTime: number
  ): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    try {
      const response = await this.feishuAdapter.getMessages(chatId, {
        limit: 100,
        startTime: Math.floor(lastSyncTime / 1000),
        sortType: 'ByCreateTimeAsc',
      });

      const messages = response.data?.items || [];

      for (const msg of messages) {
        if (!msg.message_id || !msg.body) continue;

        const msgTime = msg.create_time
          ? new Date(msg.create_time).getTime()
          : 0;

        // 跳过上次同步时间之前的消息
        if (msgTime <= lastSyncTime) continue;

        // 解析消息内容
        let content = '';
        try {
          const body = JSON.parse(msg.body);
          content = body.text || body.content || '';
        } catch {
          content = msg.body;
        }

        // 提取 @ 的用户
        const mentionedUserIds: string[] = [];
        if (msg.mentions) {
          for (const mention of msg.mentions) {
            if (mention.key === 'at_user' && mention.id) {
              mentionedUserIds.push(mention.id);
            }
          }
        }

        const userId = msg.sender?.id?.user_id || '';
        const userName = msg.sender?.id?.string_user_id || '';

        const event: NormalizedEvent = {
          id: `feishu_chat_${msg.message_id}`,
          type: 'chat',
          content,
          sourceId: msg.message_id,
          url: `https://[tenant].feishu.cn/message/${chatId}/${msg.message_id}`,
          userId,
          userName,
          timestamp: msgTime,
          chatId,
          chatName: '',
          chatType,
          mentionedUserIds,
          metadata: {
            chatType: msg.chat_id ? 'group' : 'p2p',
          },
        };

        events.push(event);
      }
    } catch (error) {
      console.error(`增量采集群聊 ${chatId} 消息失败:`, error);
    }

    return events;
  }

  /**
   * 增量采集文档（飞书文档 API 不支持时间过滤，改为检查 sourceId 去重）
   */
  private async collectDocsSince(lastSyncTime: number): Promise<NormalizedEvent[]> {
    return this.collectDocs();
  }

  /**
   * 增量采集会议
   */
  private async collectMeetingsSince(lastSyncTime: number): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    try {
      const meetingListResponse = await this.feishuAdapter.listMeetings(
        Math.floor(lastSyncTime / 1000),
        Math.floor(Date.now() / 1000),
        { limit: 100 }
      );
      const meetings = meetingListResponse.data?.meeting_list || [];

      for (const meeting of meetings) {
        if (!meeting.meeting_uuid) continue;

        const meetingEvent = await this.collectSingleMeeting(meeting.meeting_uuid);
        if (meetingEvent) {
          events.push(meetingEvent);
        }
      }
    } catch (error) {
      console.error('增量采集会议失败:', error);
    }

    return events;
  }

  /**
   * 增量采集任务
   */
  private async collectTasksSince(lastSyncTime: number): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];

    try {
      const taskListResponse = await this.feishuAdapter.listTasks({ limit: 100 });
      const tasks = taskListResponse.data?.items || [];

      for (const task of tasks) {
        if (!task.guid) continue;

        const taskTime = task.created_at
          ? new Date(task.created_at).getTime()
          : 0;
        if (taskTime <= lastSyncTime) continue;

        const taskEvent = await this.collectSingleTask(task.guid);
        if (taskEvent) {
          events.push(taskEvent);
        }
      }
    } catch (error) {
      console.error('增量采集任务失败:', error);
    }

    return events;
  }
}
