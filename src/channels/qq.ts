import path from 'path';

import WebSocket from 'ws';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { isOcrAvailable, getOcrText } from './ocr.js';

// --- QQ Bot Open Platform constants ---

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

// WebSocket opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// Intent bitmask: PUBLIC_GUILD_MESSAGES (1<<25) is not needed for group/c2c
// GROUP_AND_C2C_EVENT = (1 << 25) covers group + c2c messages
const INTENT_GROUP_AND_C2C = 1 << 25;

// Reconnect backoff steps (seconds)
const BACKOFF_STEPS = [1, 2, 5, 10, 30, 60];

// QQ message size limit
const MAX_MSG_LENGTH = 2000;

// Session resume window (ms)
const RESUME_WINDOW_MS = 5 * 60 * 1000;

export interface QQChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface TokenInfo {
  accessToken: string;
  expiresAt: number;
}

export class QQChannel implements Channel {
  name = 'qq';

  private appId: string;
  private clientSecret: string;
  private opts: QQChannelOpts;

  // Token management
  private tokenInfo: TokenInfo | null = null;
  private tokenPromise: Promise<string> | null = null;

  // WebSocket state
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private lastConnectTime = 0;
  private reconnectAttempt = 0;
  private shouldReconnect = true;

  // Track last received msg_id per chat for passive replies
  private lastMsgId = new Map<string, string>();

  constructor(appId: string, clientSecret: string, opts: QQChannelOpts) {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.opts = opts;
  }

  // --- Token management ---

  async getAccessToken(): Promise<string> {
    // Return cached token if still valid (5-min safety buffer)
    if (this.tokenInfo && Date.now() < this.tokenInfo.expiresAt - 300_000) {
      return this.tokenInfo.accessToken;
    }

    // Singleflight: share pending token fetch
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = this.fetchToken();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async fetchToken(): Promise<string> {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });

    if (!resp.ok) {
      throw new Error(`QQ token exchange failed: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      expires_in: string;
    };
    const expiresIn = parseInt(data.expires_in, 10) * 1000;

    this.tokenInfo = {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresIn,
    };

    logger.info('QQ: Access token refreshed');
    return data.access_token;
  }

  clearTokenCache(): void {
    this.tokenInfo = null;
  }

  // --- REST API helpers ---

  private async apiRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    retry = true,
  ): Promise<Response> {
    const token = await this.getAccessToken();
    const url = `${API_BASE}${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Retry once on 401
    if (resp.status === 401 && retry) {
      this.clearTokenCache();
      return this.apiRequest(method, path, body, false);
    }

    return resp;
  }

  // --- WebSocket gateway ---

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    await this.connectWebSocket();
  }

  private async connectWebSocket(): Promise<void> {
    try {
      const token = await this.getAccessToken();

      // Discover gateway URL
      const gwResp = await this.apiRequest('GET', '/gateway/bot');
      if (!gwResp.ok) {
        throw new Error(`QQ gateway discovery failed: ${gwResp.status}`);
      }
      const gwData = (await gwResp.json()) as { url: string };
      const gatewayUrl = gwData.url;

      logger.info({ url: gatewayUrl }, 'QQ: Connecting to gateway');

      this.ws = new WebSocket(gatewayUrl);

      this.ws.on('open', () => {
        logger.info('QQ: WebSocket connected');
        this.lastConnectTime = Date.now();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const payload = JSON.parse(data.toString());
          this.handleGatewayMessage(payload);
        } catch (err) {
          logger.error({ err }, 'QQ: Failed to parse gateway message');
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        logger.warn(
          { code, reason: reason.toString() },
          'QQ: WebSocket closed',
        );
        this.connected = false;
        this.stopHeartbeat();
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err: Error) => {
        logger.error({ err }, 'QQ: WebSocket error');
      });
    } catch (err) {
      logger.error({ err }, 'QQ: Connection failed');
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  private handleGatewayMessage(payload: {
    op: number;
    d?: any;
    s?: number;
    t?: string;
  }): void {
    if (payload.s != null) {
      this.lastSeq = payload.s;
    }

    switch (payload.op) {
      case OP_HELLO:
        this.handleHello(payload.d);
        break;
      case OP_DISPATCH:
        this.handleDispatch(payload.t!, payload.d);
        break;
      case OP_HEARTBEAT_ACK:
        // Heartbeat acknowledged
        break;
      case OP_RECONNECT:
        logger.info('QQ: Server requested reconnect');
        this.ws?.close();
        break;
      case OP_INVALID_SESSION:
        logger.warn('QQ: Invalid session, re-identifying');
        this.sessionId = null;
        this.sendIdentify();
        break;
      default:
        logger.debug({ op: payload.op }, 'QQ: Unhandled opcode');
    }
  }

  private handleHello(data: { heartbeat_interval: number }): void {
    const interval = data.heartbeat_interval;
    logger.info({ interval }, 'QQ: HELLO received, starting heartbeat');

    this.startHeartbeat(interval);

    // Resume if we have a valid session
    const canResume =
      this.sessionId &&
      Date.now() - this.lastConnectTime < RESUME_WINDOW_MS;

    if (canResume) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  private sendIdentify(): void {
    this.wsSend({
      op: OP_IDENTIFY,
      d: {
        token: `QQBot ${this.tokenInfo?.accessToken}`,
        intents: INTENT_GROUP_AND_C2C,
        shard: [0, 1],
      },
    });
  }

  private sendResume(): void {
    this.wsSend({
      op: OP_RESUME,
      d: {
        token: `QQBot ${this.tokenInfo?.accessToken}`,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    });
  }

  private wsSend(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // --- Heartbeat ---

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.wsSend({ op: OP_HEARTBEAT, d: this.lastSeq });
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- Reconnection ---

  private scheduleReconnect(): void {
    const idx = Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1);
    const delaySec = BACKOFF_STEPS[idx];
    this.reconnectAttempt++;

    logger.info(
      { attempt: this.reconnectAttempt, delaySec },
      'QQ: Scheduling reconnect',
    );

    setTimeout(async () => {
      if (!this.shouldReconnect) return;
      try {
        await this.connectWebSocket();
      } catch (err) {
        logger.error({ err }, 'QQ: Reconnect failed');
      }
    }, delaySec * 1000);
  }

  // --- Dispatch handler ---

  private handleDispatch(eventType: string, data: any): void {
    logger.info({ eventType, data }, 'QQ: Dispatch event received');
    switch (eventType) {
      case 'READY': {
        this.sessionId = data.session_id;
        this.connected = true;
        this.reconnectAttempt = 0;
        logger.info({ sessionId: this.sessionId }, 'QQ: READY — session established');
        break;
      }
      case 'RESUMED': {
        this.connected = true;
        this.reconnectAttempt = 0;
        logger.info('QQ: RESUMED — session restored');
        break;
      }
      case 'C2C_MESSAGE_CREATE': {
        this.handleC2CMessage(data).catch((err) =>
          logger.error({ err }, 'QQ: C2C message handling failed'),
        );
        break;
      }
      case 'GROUP_AT_MESSAGE_CREATE': {
        this.handleGroupMessage(data).catch((err) =>
          logger.error({ err }, 'QQ: Group message handling failed'),
        );
        break;
      }
      default:
        logger.debug({ eventType }, 'QQ: Unhandled dispatch event');
    }
  }

  // --- Inbound message handling ---

  private async handleC2CMessage(data: any): Promise<void> {
    const openId = data.author?.user_openid || data.author?.id || 'unknown';
    const chatJid = `qq:c2c:${openId}`;
    const senderName =
      data.author?.member_openid || data.author?.username || openId;
    const textContent = this.cleanContent(data.content || '');
    const attachmentText = this.attachmentsSummary(data.attachments);
    const msgId = data.id || '';
    const timestamp = data.timestamp
      ? new Date(data.timestamp).toISOString()
      : new Date().toISOString();

    // Store msg_id for passive reply
    this.lastMsgId.set(chatJid, msgId);

    // Report metadata (always, even for unregistered chats)
    this.opts.onChatMetadata(chatJid, timestamp, senderName, 'qq', false);

    // Only deliver to registered groups
    const groups = this.opts.registeredGroups();
    if (!(chatJid in groups)) return;

    // Attempt OCR on image attachments
    const ocrText = await this.ocrAttachments(data.attachments, chatJid, senderName, textContent);
    const content = ocrText
      || [textContent, attachmentText].filter(Boolean).join(' ')
      || '[Empty message]';

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: openId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  private async handleGroupMessage(data: any): Promise<void> {
    const groupOpenId = data.group_openid || 'unknown';
    const chatJid = `qq:group:${groupOpenId}`;
    const senderName =
      data.author?.member_openid || data.author?.username || 'unknown';
    const senderId = data.author?.member_openid || data.author?.id || 'unknown';
    const textContent = this.cleanContent(data.content || '');
    const attachmentText = this.attachmentsSummary(data.attachments);
    const msgId = data.id || '';
    const timestamp = data.timestamp
      ? new Date(data.timestamp).toISOString()
      : new Date().toISOString();

    // Store msg_id for passive reply
    this.lastMsgId.set(chatJid, msgId);

    // Report metadata
    const groupName = data.group_name || `QQ Group ${groupOpenId.slice(0, 8)}`;
    this.opts.onChatMetadata(chatJid, timestamp, groupName, 'qq', true);

    // Only deliver to registered groups
    const groups = this.opts.registeredGroups();
    if (!(chatJid in groups)) return;

    // Attempt OCR on image attachments
    const ocrText = await this.ocrAttachments(data.attachments, chatJid, senderName, textContent);
    let content = ocrText
      || [textContent, attachmentText].filter(Boolean).join(' ')
      || '[Empty message]';

    // Group @mention messages: prepend trigger if not already present
    if (!TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  /** Strip QQ face tags and clean up whitespace */
  private cleanContent(text: string): string {
    return text
      .replace(/<faceType=[^>]*>/g, '') // Remove QQ face tags
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Build text description for attachments */
  private attachmentsSummary(attachments: any[]): string {
    if (!attachments || attachments.length === 0) return '';
    return attachments
      .map((att: any) => {
        const type = (att.content_type || '').split('/')[0];
        const name = att.filename || 'file';
        if (type === 'image') return `[Image: ${name}]`;
        if (type === 'video') return `[Video: ${name}]`;
        if (type === 'audio') return `[Audio: ${name}]`;
        return `[File: ${name}]`;
      })
      .join(' ');
  }

  /** Download image attachments from QQ CDN and run OCR. Returns OCR content or null. */
  private async ocrAttachments(
    attachments: any[] | undefined,
    chatJid: string,
    sender: string,
    caption: string,
  ): Promise<string | null> {
    if (!attachments || attachments.length === 0) return null;
    if (!isOcrAvailable()) return null;

    const images = attachments.filter(
      (att: any) => (att.content_type || '').startsWith('image/') && att.url,
    );
    if (images.length === 0) return null;

    const results: string[] = [];
    for (const img of images) {
      try {
        const resp = await fetch(img.url);
        if (!resp.ok) {
          logger.warn({ url: img.url, status: resp.status }, 'QQ: Failed to download image');
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        const ext = path.extname(img.filename || '.jpg').slice(1) || 'jpg';
        const ocrText = await getOcrText(buffer, ext, {
          source: 'qq',
          chatJid,
          sender,
          caption,
        });
        if (ocrText && ocrText.trim().length > 0) {
          results.push(ocrText);
          logger.info({ chatJid, sender }, 'QQ: Image OCR successful');
        }
      } catch (err) {
        logger.warn({ err, chatJid }, 'QQ: Image OCR failed');
      }
    }

    if (results.length === 0) return null;
    const ocrContent = results.join('\n---\n');
    return `[Photo OCR]\n${ocrContent}${caption ? `\n${caption}` : ''}`;
  }

  // --- Outbound messages ---

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      const chunks = this.splitMessage(text);
      for (const chunk of chunks) {
        if (jid.startsWith('qq:c2c:')) {
          await this.sendC2CMessage(jid, chunk);
        } else if (jid.startsWith('qq:group:')) {
          await this.sendGroupMessage(jid, chunk);
        } else {
          logger.warn({ jid }, 'QQ: Unknown JID format for sendMessage');
        }
      }
    } catch (err) {
      logger.error({ err, jid }, 'QQ: Failed to send message');
    }
  }

  private async sendC2CMessage(jid: string, text: string): Promise<void> {
    const openId = jid.slice('qq:c2c:'.length);
    const lastMsgId = this.lastMsgId.get(jid);
    const body: Record<string, unknown> = {
      content: text,
      msg_type: 0,
    };
    if (lastMsgId) {
      body.msg_id = lastMsgId;
    }

    const resp = await this.apiRequest(
      'POST',
      `/v2/users/${openId}/messages`,
      body,
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      logger.error(
        { status: resp.status, body: errText },
        'QQ: C2C send failed',
      );
    }
  }

  private async sendGroupMessage(jid: string, text: string): Promise<void> {
    const groupOpenId = jid.slice('qq:group:'.length);
    const lastMsgId = this.lastMsgId.get(jid);
    const body: Record<string, unknown> = {
      content: text,
      msg_type: 0,
    };
    if (lastMsgId) {
      body.msg_id = lastMsgId;
    }

    const resp = await this.apiRequest(
      'POST',
      `/v2/groups/${groupOpenId}/messages`,
      body,
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      logger.error(
        { status: resp.status, body: errText },
        'QQ: Group send failed',
      );
    }
  }

  /** Send an image to a QQ chat via URL. QQ fetches the image from the URL server-side. */
  async sendImage(jid: string, imageUrl: string, caption?: string): Promise<void> {
    try {
      const isC2C = jid.startsWith('qq:c2c:');
      const isGroup = jid.startsWith('qq:group:');
      if (!isC2C && !isGroup) {
        logger.warn({ jid }, 'QQ: Unknown JID format for sendImage');
        return;
      }

      const id = isC2C
        ? jid.slice('qq:c2c:'.length)
        : jid.slice('qq:group:'.length);
      const filesPath = isC2C
        ? `/v2/users/${id}/files`
        : `/v2/groups/${id}/files`;
      const messagesPath = isC2C
        ? `/v2/users/${id}/messages`
        : `/v2/groups/${id}/messages`;

      // Step 1: Upload image by URL
      const uploadResp = await this.apiRequest('POST', filesPath, {
        file_type: 1,
        url: imageUrl,
        srv_send_msg: false,
      });

      if (!uploadResp.ok) {
        const errText = await uploadResp.text().catch(() => '');
        logger.error({ status: uploadResp.status, body: errText }, 'QQ: Image upload failed');
        // Fallback: send as text with URL
        await this.sendMessage(jid, caption ? `${caption}\n${imageUrl}` : imageUrl);
        return;
      }

      const uploadData = (await uploadResp.json()) as { file_info: string };

      // Step 2: Send message with media reference
      const lastMsgId = this.lastMsgId.get(jid);
      const body: Record<string, unknown> = {
        msg_type: 7,
        media: { file_info: uploadData.file_info },
      };
      if (caption) body.content = caption;
      if (lastMsgId) body.msg_id = lastMsgId;

      const sendResp = await this.apiRequest('POST', messagesPath, body);
      if (!sendResp.ok) {
        const errText = await sendResp.text().catch(() => '');
        logger.error({ status: sendResp.status, body: errText }, 'QQ: Image send failed');
      } else {
        logger.info({ jid }, 'QQ: Image sent');
      }
    } catch (err) {
      logger.error({ err, jid }, 'QQ: Failed to send image');
    }
  }

  /** Split text into chunks ≤ MAX_MSG_LENGTH, preferring newline boundaries */
  splitMessage(text: string): string[] {
    if (text.length <= MAX_MSG_LENGTH) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_MSG_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Try to split at last newline within limit
      let splitIdx = remaining.lastIndexOf('\n', MAX_MSG_LENGTH);
      if (splitIdx <= 0) {
        // No newline found — split at limit
        splitIdx = MAX_MSG_LENGTH;
      }

      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).replace(/^\n/, '');
    }

    return chunks;
  }

  // --- Channel interface ---

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info('QQ: Disconnected');
  }
}

// --- Self-registration ---

registerChannel('qq', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['QQ_APP_ID', 'QQ_CLIENT_SECRET']);
  const appId = process.env.QQ_APP_ID || envVars.QQ_APP_ID || '';
  const secret =
    process.env.QQ_CLIENT_SECRET || envVars.QQ_CLIENT_SECRET || '';

  if (!appId || !secret) {
    logger.warn('QQ: QQ_APP_ID or QQ_CLIENT_SECRET not set');
    return null;
  }

  return new QQChannel(appId, secret, opts);
});
