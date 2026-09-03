// src/telegram.ts — minimal zero-dependency Telegram Bot API client:
// sendMessage / editMessageText / answerCallbackQuery + getUpdates long-poll loop.

const API = 'https://api.telegram.org';

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  first_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
  date: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgHandlerContext {
  chatId: string;
  messageId?: number;
  text?: string;
  from?: TgUser;
  callback?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export class Tg {
  constructor(public readonly token: string) {}

  private async call(method: string, payload: Record<string, unknown> = {}, retries = 3): Promise<any> {
    const url = `${API}/bot${this.token}/${method}`;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
          const desc = data?.description || `HTTP ${res.status}`;
          if (res.status === 429) {
            const wait = data?.parameters?.retry_after ?? 3;
            await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
            continue;
          }
          if (res.status === 401) {
            throw new TelegramError(`telegram 401: ${desc} (bad bot token?)`, 401);
          }
          if (res.status >= 500 && attempt < retries - 1) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
            continue;
          }
          throw new TelegramError(`telegram ${res.status}: ${desc}`, res.status);
        }
        return data?.result;
      } catch (err) {
        if (err instanceof TelegramError) throw err;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    opts: { replyMarkup?: { inline_keyboard: InlineButton[][] } } = {},
  ): Promise<any> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (opts.replyMarkup) payload.reply_markup = opts.replyMarkup;
    return this.call('sendMessage', payload);
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    opts: { replyMarkup?: { inline_keyboard: InlineButton[][] } | null } = {},
  ): Promise<any> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (opts.replyMarkup !== undefined) payload.reply_markup = opts.replyMarkup;
    return this.call('editMessageText', payload);
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text) payload.text = text;
    await this.call('answerCallbackQuery', payload).catch(() => undefined);
  }

  // ---------- long polling ----------

  async getUpdates(offset: number, timeoutSec = 25): Promise<TgUpdate[]> {
    const res = await fetch(
      `${API}/bot${this.token}/getUpdates?offset=${offset}&timeout=${timeoutSec}&allowed_updates=${encodeURIComponent(
        JSON.stringify(['message', 'callback_query']),
      )}`,
      { signal: AbortSignal.timeout((timeoutSec + 15) * 1000) },
    );
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      const desc = data?.description || `HTTP ${res.status}`;
      throw new TelegramError(`getUpdates failed: ${desc}`, res.status);
    }
    return (data?.result as TgUpdate[]) ?? [];
  }

  /**
   * Run the long-poll loop. `handler` receives one update at a time and may
   * throw; a failing update never blocks the queue (offset advances first).
   */
  startPolling(
    handler: (ctx: TgHandlerContext) => Promise<void>,
    onFatal?: (err: Error) => void,
  ): void {
    let offset = 0;
    let conflictLoggedAt = 0;

    const loop = async (): Promise<void> => {
      for (;;) {
        try {
          const updates = await this.getUpdates(offset);
          for (const u of updates) {
            offset = u.update_id + 1; // advance first — never deadlock on a bad update
            try {
              await handler(this.toContext(u));
            } catch (err) {
              console.error('[telegram] update handler error:', (err as Error).message);
            }
          }
        } catch (err) {
          const e = err as TelegramError;
          if (e.code === 409) {
            // Another poller (or the same token elsewhere) is active.
            if (Date.now() - conflictLoggedAt > 300_000) {
              conflictLoggedAt = Date.now();
              console.error(
                '[telegram] 409 conflict: this bot token is being polled elsewhere. ' +
                  'Stop the other poller or use a fresh token from @BotFather.',
              );
            }
            await sleep(15_000);
          } else if (e.code === 401) {
            console.error('[telegram] 401 unauthorized — bot token invalid. Polling stopped.');
            onFatal?.(e);
            return;
          } else {
            console.error('[telegram] polling error:', (err as Error).message);
            await sleep(3000);
          }
        }
      }
    };

    void loop();
    console.log(`[telegram] long-polling started (bot ${this.token.split(':')[0]})`);
  }

  private toContext(u: TgUpdate): TgHandlerContext {
    if (u.callback_query) {
      const cq = u.callback_query;
      const chatId = cq.message?.chat.id != null ? String(cq.message.chat.id) : String(cq.from.id);
      return {
        chatId,
        messageId: cq.message?.message_id,
        from: cq.from,
        callback: cq,
      };
    }
    const m = u.message!;
    return {
      chatId: String(m.chat.id),
      messageId: m.message_id,
      text: m.text,
      from: m.from,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
