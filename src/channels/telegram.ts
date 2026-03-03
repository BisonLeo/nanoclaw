import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { Api, Bot } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (proxyUrl) return new HttpsProxyAgent(proxyUrl);
  return undefined;
}

// --- OCR helpers ---

const OCR_ENV = readEnvFile(['PADDLEOCR_VENV', 'PADDLEOCR_SERVER_URL']);
const PADDLEOCR_VENV =
  process.env.PADDLEOCR_VENV || OCR_ENV.PADDLEOCR_VENV || '/home/leo/padvenv';
const PADDLEOCR_SERVER_URL =
  process.env.PADDLEOCR_SERVER_URL ||
  OCR_ENV.PADDLEOCR_SERVER_URL ||
  'http://192.168.21.48:8080/v1';

const OCR_CACHE_DIR = path.join(DATA_DIR, 'imageocr');

function isOcrAvailable(): boolean {
  return fs.existsSync(path.join(PADDLEOCR_VENV, 'bin', 'activate'));
}

async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
  botToken: string,
): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const agent = getProxyAgent();
  const resp = await fetch(url, agent ? { dispatcher: undefined } : undefined);
  if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

function runOcr(imagePath: string, outputDir: string): string | null {
  try {
    const cmd = `source "${PADDLEOCR_VENV}/bin/activate" && paddleocr doc_parser -i "${imagePath}" --vl_rec_backend vllm-server --vl_rec_server_url "${PADDLEOCR_SERVER_URL}" --save_path "${outputDir}"`;
    logger.info({ cmd }, 'OCR command');
    execSync(cmd, { shell: '/bin/bash', timeout: 120000, stdio: 'pipe' });

    // Find the markdown output file
    const baseName = path.basename(imagePath, path.extname(imagePath));
    const mdPath = path.join(outputDir, `${baseName}.md`);
    if (!fs.existsSync(mdPath)) {
      // Try to find any .md file in the output
      const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.md'));
      if (files.length === 0) {
        logger.warn({ imagePath, outputDir }, 'OCR produced no markdown output');
        return null;
      }
      const altMdPath = path.join(outputDir, files[0]);
      return cleanOcrOutput(fs.readFileSync(altMdPath, 'utf-8'));
    }
    return cleanOcrOutput(fs.readFileSync(mdPath, 'utf-8'));
  } catch (err) {
    logger.error({ err, imagePath }, 'OCR execution failed');
    return null;
  }
}

function cleanOcrOutput(text: string): string {
  let cleaned = text
    // Strip HTML table tags
    .replace(/<\/?table[^>]*>/gi, '')
    .replace(/<\/?thead[^>]*>/gi, '')
    .replace(/<\/?tbody[^>]*>/gi, '')
    .replace(/<\/?tr[^>]*>/gi, '\n')
    .replace(/<\/?th[^>]*>/gi, ' ')
    .replace(/<\/?td[^>]*>/gi, ' ')
    // Strip LaTeX markers
    .replace(/\$\$/g, '')
    .replace(/\$/g, '')
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

interface OcrIndexEntry {
  hash: string;
  source: string;
  chatJid: string;
  sender: string;
  caption: string;
  createdAt: string;
  ocrLength: number | null;
}

const INDEX_PATH = path.join(OCR_CACHE_DIR, 'index.json');

function readOcrIndex(): Record<string, OcrIndexEntry> {
  try {
    if (fs.existsSync(INDEX_PATH)) {
      return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    }
  } catch { /* corrupted index, start fresh */ }
  return {};
}

function writeOcrIndex(index: Record<string, OcrIndexEntry>): void {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

async function getOcrText(
  imageBuffer: Buffer,
  ext: string,
  meta: { source: string; chatJid: string; sender: string; caption: string },
): Promise<string | null> {
  const hash = crypto
    .createHash('sha256')
    .update(imageBuffer)
    .digest('hex');

  // Each image gets its own subfolder: data/imageocr/{hash}/
  const hashDir = path.join(OCR_CACHE_DIR, hash);
  fs.mkdirSync(hashDir, { recursive: true });
  const cachePath = path.join(hashDir, 'ocr.txt');

  // Cache hit
  if (fs.existsSync(cachePath)) {
    logger.info({ hash: hash.slice(0, 12) }, 'OCR cache hit');
    return fs.readFileSync(cachePath, 'utf-8');
  }

  // Cache miss — save original image, run OCR into same subfolder
  const imagePath = path.join(hashDir, `original.${ext}`);
  fs.writeFileSync(imagePath, imageBuffer);

  const text = runOcr(imagePath, hashDir);
  if (text) {
    fs.writeFileSync(cachePath, text);
    logger.info(
      { hash: hash.slice(0, 12), length: text.length, dir: hashDir },
      'OCR completed and cached',
    );
  }

  // Update index
  const index = readOcrIndex();
  index[hash] = {
    hash,
    source: meta.source,
    chatJid: meta.chatJid,
    sender: meta.sender,
    caption: meta.caption,
    createdAt: new Date().toISOString(),
    ocrLength: text ? text.length : null,
  };
  writeOcrIndex(index);

  return text;
}

// --- End OCR helpers ---

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

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const agent = getProxyAgent();
    const clientOpts = agent
      ? { baseFetchConfig: { agent, compress: true } }
      : undefined;
    this.bot = new Bot(this.botToken, { client: clientOpts });

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
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

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

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
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

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption || '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

      let content = `[Photo]${caption ? ` ${caption}` : ''}`;

      // Attempt OCR if available
      if (isOcrAvailable() && this.bot) {
        try {
          const photos = ctx.message.photo;
          const largest = photos[photos.length - 1];
          const imageBuffer = await downloadTelegramFile(
            this.bot,
            largest.file_id,
            this.botToken,
          );
          const ext = 'jpg'; // Telegram photos are always JPEG
          const ocrText = await getOcrText(imageBuffer, ext, {
            source: 'telegram',
            chatJid,
            sender: senderName,
            caption,
          });
          if (ocrText && ocrText.trim().length > 0) {
            content = `[Photo OCR]\n${ocrText}${caption ? `\n${caption}` : ''}`;
            logger.info({ chatJid, sender: senderName }, 'Photo OCR successful');
          }
        } catch (err) {
          logger.warn({ err, chatJid }, 'Photo OCR failed, using placeholder');
        }
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
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

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
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
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
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

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  const agent = getProxyAgent();
  const clientOpts = agent
    ? { baseFetchConfig: { agent, compress: true } }
    : undefined;
  for (const token of tokens) {
    try {
      const api = new Api(token, clientOpts);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) return;

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
