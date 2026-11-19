// ---------------------------------------------------------------------------
// Multi-turn, tool-calling chat
//
// `ModelClient.complete` is one system prompt, one user message, one answer —
// right for a JSON verdict, wrong for an agent that has to read Lean's reply
// before deciding what to write next. This is the same request with a message
// history and a tool list, and the same budget discipline: every request is
// reserved against the run budget before it is sent and settled to the usage
// the provider reports.
// ---------------------------------------------------------------------------

/** A JSON-schema tool the model may call. */
export interface ChatToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model wrote it; parse defensively. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls?: ChatToolCall[];
      /**
       * Provider reasoning state, returned verbatim on the next request. Models
       * that reason between tool calls lose the thread without it, and some
       * providers reject a tool-use turn whose reasoning was dropped.
       */
      reasoningDetails?: unknown;
    }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ChatTurnResult {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  finishReason: string | null;
  /** Readable reasoning summary when the provider returns one. */
  reasoning: string | null;
}

/** The wire shape the OpenAI-compatible endpoint expects. */
export function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
      case 'user':
        return { role: message.role, content: message.content };
      case 'tool':
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content ?? '',
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
          ...(message.reasoningDetails !== undefined ? { reasoning_details: message.reasoningDetails } : {}),
        };
    }
  });
}

export function toWireTools(tools: ChatToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** Parses one assistant choice off the wire. Unknown shapes become empty fields, never throws. */
export function fromWireChoice(choice: unknown): ChatTurnResult {
  const c = (choice ?? {}) as {
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_details?: unknown;
      tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
    };
  };
  const toolCalls: ChatToolCall[] = [];
  for (const [index, call] of (Array.isArray(c.message?.tool_calls) ? c.message!.tool_calls : []).entries()) {
    const name = call?.function?.name;
    if (typeof name !== 'string') continue;
    const args = call.function?.arguments;
    toolCalls.push({
      id: typeof call.id === 'string' && call.id ? call.id : `call_${index}`,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    });
  }
  const content = typeof c.message?.content === 'string' ? c.message.content : null;
  return {
    message: {
      role: 'assistant',
      content,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(c.message?.reasoning_details !== undefined ? { reasoningDetails: c.message.reasoning_details } : {}),
    },
    finishReason: typeof c.finish_reason === 'string' ? c.finish_reason : null,
    reasoning: typeof c.message?.reasoning === 'string' ? c.message.reasoning : null,
  };
}

/** Rough byte count of a history, the same conservative estimate `complete` reserves with. */
export function estimateChatBytes(messages: ChatMessage[], tools: ChatToolSpec[]): number {
  return Buffer.byteLength(JSON.stringify(toWireMessages(messages)) + JSON.stringify(toWireTools(tools)), 'utf8') + 256;
}
