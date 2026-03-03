import { Bot, GrammyError } from 'grammy';

import { ASSISTANT_NAME, TELEGRAM_BOT_TOKEN, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private pollingActive = false;
  private reconnecting = false;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors — reconnect on fatal/network errors
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
      const isFatal =
        !(err.error instanceof GrammyError) ||
        err.error.error_code === 401 ||
        err.error.error_code === 409 ||
        err.error.error_code >= 500;
      if (isFatal) {
        // 409 = another instance is polling; wait longer for it to die
        const delay = err.error instanceof GrammyError && err.error.error_code === 409 ? 30000 : 5000;
        this.reconnect(delay);
      }
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          this.pollingActive = true;
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      }).catch((err) => {
        this.pollingActive = false;
        logger.error({ err }, 'Telegram polling died');
        this.reconnect();
      });
    });
  }

  private async reconnect(delayMs = 5000): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.pollingActive = false;
    logger.warn({ delayMs }, 'Telegram bot reconnecting...');
    if (this.bot) {
      try { this.bot.stop(); } catch {}
      this.bot = null;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    this.reconnecting = false;
    try {
      await this.connect();
    } catch (err) {
      logger.error({ err }, 'Telegram reconnect failed, retrying in 30s');
      this.reconnect(30000);
    }
  }

  private preprocessMarkdown(text: string): string {
    return text
      .replace(/\*\*([\s\S]*?)\*\*/g, '*$1*')  // **bold** → *bold*
      .replace(/__([\s\S]*?)__/g, '*$1*');       // __bold__ → *bold*
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    const chunks =
      text.length <= MAX_LENGTH
        ? [text]
        : Array.from({ length: Math.ceil(text.length / MAX_LENGTH) }, (_, i) =>
            text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
          );

    for (const chunk of chunks) {
      const processed = this.preprocessMarkdown(chunk);
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Try Markdown first so bold/italic/code renders correctly.
          // Fall back to plain text if Telegram rejects the formatting
          // (e.g. unmatched asterisks from agent output).
          try {
            await this.bot.api.sendMessage(numericId, processed, { parse_mode: 'Markdown' });
          } catch (fmtErr) {
            const isBadFormat = fmtErr instanceof GrammyError && fmtErr.error_code === 400;
            if (isBadFormat) {
              await this.bot.api.sendMessage(numericId, processed);
            } else {
              throw fmtErr;
            }
          }
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          const isTransient =
            !(err instanceof GrammyError) ||
            err.error_code === 429 ||
            err.error_code >= 500;
          if (!isTransient) break;
          const delay = err instanceof GrammyError && err.error_code === 429
            ? ((err.parameters as any)?.retry_after ?? 5) * 1000
            : 1000 * Math.pow(2, attempt);
          logger.warn({ jid, attempt, delay }, 'Telegram send failed, retrying');
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      if (lastErr) {
        logger.error({ jid, err: lastErr }, 'Failed to send Telegram message');
      }
    }
    logger.info({ jid, length: text.length }, 'Telegram message sent');
  }

  isConnected(): boolean {
    return this.bot !== null && this.pollingActive;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.reconnecting = true; // prevent reconnect loop on intentional shutdown
    this.pollingActive = false;
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts) => {
  if (!TELEGRAM_BOT_TOKEN) return null;
  return new TelegramChannel(TELEGRAM_BOT_TOKEN, opts);
});
