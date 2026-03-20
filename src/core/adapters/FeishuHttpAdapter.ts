/**
 * 飞书 HTTP 适配器
 *
 * 通过 OpenClaw 的 ctx.http 调用飞书 API
 *
 * Token 获取优先级：
 * 1. 优先使用 OpenClaw 共享的飞书 token（ctx.feishu?.token）
 * 2. 否则使用传入的 appId/appSecret 获取 token
 */

interface FeishuHttpAdapterConfig {
  appId?: string;
  appSecret?: string;
}

interface AccessTokenResponse {
  code: number;
  msg: string;
  access_token: string;
  expires_in: number;
}

interface FeishuMessage {
  message_id: string;
  body: string;
  chat_id?: string;
  create_time?: string;
  sender?: {
    id?: { user_id?: string; string_user_id?: string };
  };
  mentions?: Array<{ key: string; id?: string; id_type?: string; name?: string }>;
}

interface FeishuMessageListResponse {
  code: number;
  msg: string;
  data?: {
    items?: FeishuMessage[];
    has_more?: boolean;
    page_token?: string;
  };
}

interface FeishuDocumentResponse {
  code: number;
  msg: string;
  data?: {
    document?: {
      document_id?: string;
      title?: string;
      owner_id?: string;
      create_time?: string;
    };
  };
}

interface FeishuDocumentBlockListResponse {
  code: number;
  msg: string;
  data?: {
    items?: Array<{
      block_id?: string;
      block_type?: number;
      text?: { elements?: Array<{ text_run?: { content?: string } }> };
    }>;
    has_more?: boolean;
    page_token?: string;
  };
}

interface FeishuMeeting {
  meeting_uuid?: string;
  topic?: string;
  start_time?: string;
  end_time?: string;
  host_user_id?: string;
  attendees?: Array<{ name?: string; user_id?: string }>;
  summary?: string;
}

interface FeishuMeetingListResponse {
  code: number;
  msg: string;
  data?: {
    meeting_list?: FeishuMeeting[];
    has_more?: boolean;
    page_token?: string;
  };
}

interface FeishuMeetingResponse {
  code: number;
  msg: string;
  data?: {
    meeting?: FeishuMeeting;
  };
}

interface FeishuTask {
  guid?: string;
  summary?: string;
  due?: { datetime?: string };
  completed_at?: string;
  created_at?: string;
  creator?: { name?: string; id?: string };
  subtasks?: Array<{ guid?: string; summary?: string }>;
}

interface FeishuTaskListResponse {
  code: number;
  msg: string;
  data?: {
    items?: FeishuTask[];
    has_more?: boolean;
    page_token?: string;
  };
}

interface FeishuTaskResponse {
  code: number;
  msg: string;
  data?: {
    task?: FeishuTask;
  };
}

interface FeishuChatListResponse {
  code: number;
  msg: string;
  data?: {
    items?: Array<{
      chat_id?: string;
      name?: string;
      chat_type?: string;
    }>;
    has_more?: boolean;
    page_token?: string;
  };
}

export class FeishuHttpAdapter {
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(private ctx: any, private config: FeishuHttpAdapterConfig = {}) {}

  /**
   * 获取 tenant access token（带缓存）
   * 优先从 ctx 获取，否则用配置的 appId/appSecret 获取
   */
  private async getAccessToken(): Promise<string> {
    // 如果 token 还在有效期，直接返回
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    // 优先使用 OpenClaw 共享的飞书 token
    const openclawFeishuToken = this.ctx?.feishu?.token;
    if (openclawFeishuToken) {
      this.accessToken = openclawFeishuToken;
      // OpenClaw 管理的 token 我们不知道过期时间，假设长期有效
      this.tokenExpiresAt = Date.now() + 3600 * 1000;
      return openclawFeishuToken;
    }

    // 如果没有 OpenClaw token 且没有配置凭证，报错
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error(
        '飞书 token 不可用。请确保 OpenClaw 飞书插件已配置，或在插件设置中提供 feishu.appId 和 feishu.appSecret。'
      );
    }

    // 通过飞书 OAuth API 获取 token
    const response = await this.ctx.http.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const data = response as AccessTokenResponse;
    if (data.code !== 0 || !data.access_token) {
      throw new Error(`获取飞书 access token 失败: ${data.msg}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 120) * 1000;

    return this.accessToken;
  }

  /**
   * 通用 GET 请求
   */
  private async get<T>(path: string, params?: Record<string, any>): Promise<T> {
    const token = await this.getAccessToken();
    return this.ctx.http.get(path, {
      params,
      headers: { Authorization: `Bearer ${token}` },
    }) as Promise<T>;
  }

  // ============================================================================
  // 消息相关 API
  // ============================================================================

  /**
   * 获取群聊列表
   */
  async listChats(): Promise<FeishuChatListResponse> {
    return this.get<FeishuChatListResponse>('https://open.feishu.cn/open-apis/chat/v4/list');
  }

  /**
   * 获取群消息列表
   */
  async getMessages(
    chatId: string,
    options?: {
      limit?: number;
      startTime?: number;
      endTime?: number;
      sortType?: 'ByCreateTimeDesc' | 'ByCreateTimeAsc';
    }
  ): Promise<FeishuMessageListResponse> {
    const params: Record<string, any> = {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: options?.limit || 100,
    };

    if (options?.startTime) {
      params.start_time = options.startTime;
    }
    if (options?.endTime) {
      params.end_time = options.endTime;
    }
    if (options?.sortType) {
      params.sort_type = options.sortType;
    }

    return this.get<FeishuMessageListResponse>(
      'https://open.feishu.cn/open-apis/im/v1/messages',
      params
    );
  }

  // ============================================================================
  // 文档相关 API
  // ============================================================================

  /**
   * 获取文档元信息
   */
  async getDocument(docId: string): Promise<FeishuDocumentResponse> {
    return this.get<FeishuDocumentResponse>(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}`
    );
  }

  /**
   * 获取文档块列表
   */
  async listDocumentBlocks(
    docId: string,
    options?: { limit?: number; pageToken?: string }
  ): Promise<FeishuDocumentBlockListResponse> {
    const params: Record<string, any> = {};
    if (options?.limit) params.page_size = options.limit;
    if (options?.pageToken) params.page_token = options.pageToken;

    return this.get<FeishuDocumentBlockListResponse>(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks`,
      params
    );
  }

  /**
   * 获取用户的文档列表
   */
  async listDocuments(options?: { limit?: number; pageToken?: string }): Promise<{
    code: number;
    msg: string;
    data?: {
      documents?: Array<{ document_id?: string; title?: string }>;
      has_more?: boolean;
      page_token?: string;
    };
  }> {
    const params: Record<string, any> = {};
    if (options?.limit) params.page_size = options.limit;
    if (options?.pageToken) params.page_token = options.pageToken;

    return this.get(
      'https://open.feishu.cn/open-apis/docx/v1/documents',
      params
    );
  }

  // ============================================================================
  // 会议相关 API
  // ============================================================================

  /**
   * 获取会议列表
   */
  async listMeetings(
    startTime: number,
    endTime: number,
    options?: { limit?: number }
  ): Promise<FeishuMeetingListResponse> {
    return this.get<FeishuMeetingListResponse>(
      'https://open.feishu.cn/open-apis/vc/v1/meetings',
      {
        start_time: startTime,
        end_time: endTime,
        page_size: options?.limit || 100,
      }
    );
  }

  /**
   * 获取会议详情
   */
  async getMeeting(meetingId: string): Promise<FeishuMeetingResponse> {
    return this.get<FeishuMeetingResponse>(
      `https://open.feishu.cn/open-apis/vc/v1/meetings/${meetingId}`
    );
  }

  // ============================================================================
  // 任务相关 API
  // ============================================================================

  /**
   * 获取任务列表
   */
  async listTasks(options?: { limit?: number; pageToken?: string }): Promise<FeishuTaskListResponse> {
    const params: Record<string, any> = {};
    if (options?.limit) params.page_size = options.limit;
    if (options?.pageToken) params.page_token = options.pageToken;

    return this.get<FeishuTaskListResponse>(
      'https://open.feishu.cn/open-apis/task/v2/tasks',
      params
    );
  }

  /**
   * 获取任务详情
   */
  async getTask(taskGuid: string): Promise<FeishuTaskResponse> {
    return this.get<FeishuTaskResponse>(
      `https://open.feishu.cn/open-apis/task/v2/tasks/${taskGuid}`
    );
  }
}
