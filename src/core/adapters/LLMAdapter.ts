/**
 * LLM 适配器
 *
 * 封装 OpenClaw 的 ctx.llm 接口，提供统一的 LLM 调用方式
 */

interface LLMCompleteOptions {
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' } | { type: 'text' };
}

export class LLMAdapter {
  constructor(private ctx: any) {}

  /**
   * 文本补全
   *
   * @param options.messages 消息数组（推荐方式）
   * @param options.prompt 提示字符串（兼容方式）
   * @param options.temperature 温度参数
   * @param options.maxTokens 最大 token 数
   * @param options.responseFormat 返回格式
   */
  async complete(options: LLMCompleteOptions): Promise<string> {
    const { temperature = 0.3, maxTokens, responseFormat } = options;

    // 构建请求参数
    const requestOptions: any = { temperature };

    if (options.messages) {
      requestOptions.messages = options.messages;
    } else if (options.prompt) {
      requestOptions.prompt = options.prompt;
    } else {
      throw new Error('LLMAdapter.complete requires either messages or prompt');
    }

    if (maxTokens) {
      requestOptions.maxTokens = maxTokens;
    }

    if (responseFormat) {
      requestOptions.response_format = responseFormat;
    }

    return this.ctx.llm.complete(requestOptions);
  }

  /**
   * 文本嵌入
   *
   * 如果 ctx.embedding 可用则使用，否则抛出错误
   */
  async embed(text: string): Promise<number[]> {
    if (this.ctx.embedding) {
      return this.ctx.embedding.embed(text);
    }
    throw new Error(
      'ctx.embedding not available. Please ensure OpenClaw embedding is configured, ' +
      'or use a BrainMemoryStore with direct embedding API access.'
    );
  }

  /**
   * 检查 LLM 是否可用
   */
  isAvailable(): boolean {
    return !!this.ctx.llm;
  }

  /**
   * 检查 embedding 是否可用
   */
  isEmbeddingAvailable(): boolean {
    return !!this.ctx.embedding;
  }
}
