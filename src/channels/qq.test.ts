import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock OCR module
vi.mock('./ocr.js', () => ({
  isOcrAvailable: vi.fn(() => false),
  getOcrText: vi.fn(() => Promise.resolve(null)),
}));

// --- WebSocket mock (hoisted so vi.mock factory can reference it) ---

const { MockWebSocket, wsInstances, fetchMock } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    url: string;
    readyState = MockWebSocket.OPEN;
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    send: any;

    constructor(url: string) {
      this.url = url;
      this.send = vi.fn();
      wsInstances.push(this);
    }

    on(event: string, handler: (...args: any[]) => void) {
      const existing = this.handlers.get(event) || [];
      existing.push(handler);
      this.handlers.set(event, existing);
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
    }

    // Test helpers
    emit(event: string, ...args: any[]) {
      const handlers = this.handlers.get(event) || [];
      for (const h of handlers) h(...args);
    }

    simulateMessage(payload: Record<string, unknown>) {
      this.emit('message', JSON.stringify(payload));
    }
  }

  const wsInstances: InstanceType<typeof MockWebSocket>[] = [];
  const fetchMock = vi.fn();

  return { MockWebSocket, wsInstances, fetchMock };
});

vi.mock('ws', () => ({
  default: MockWebSocket,
}));

vi.stubGlobal('fetch', fetchMock);

import { QQChannel, QQChannelOpts } from './qq.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<QQChannelOpts>,
): QQChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'qq:c2c:openid_abc123': {
        name: 'Test DM',
        folder: 'test-dm',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'qq:group:group_openid_xyz': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function mockTokenResponse() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      access_token: 'test-token-123',
      expires_in: '7200',
    }),
  });
}

function mockGatewayResponse() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ url: 'wss://gateway.qq.com/ws' }),
  });
}

function getLatestWs(): InstanceType<typeof MockWebSocket> {
  return wsInstances[wsInstances.length - 1];
}

function simulateHello(ws: InstanceType<typeof MockWebSocket>) {
  ws.simulateMessage({
    op: 10, // HELLO
    d: { heartbeat_interval: 30000 },
  });
}

function simulateReady(ws: InstanceType<typeof MockWebSocket>) {
  ws.simulateMessage({
    op: 0, // DISPATCH
    s: 1,
    t: 'READY',
    d: { session_id: 'session-abc' },
  });
}

/** Set up fetch mocks for connect (token + gateway) and simulate WS handshake */
async function connectChannel(channel: QQChannel): Promise<InstanceType<typeof MockWebSocket>> {
  mockTokenResponse();
  mockGatewayResponse();

  const connectPromise = channel.connect();

  // Wait for async gateway fetch to resolve
  await vi.waitFor(() => {
    expect(wsInstances.length).toBeGreaterThan(0);
  });

  const ws = getLatestWs();
  ws.emit('open');
  simulateHello(ws);
  simulateReady(ws);

  // Let all microtasks settle
  await connectPromise.catch(() => {});
  return ws;
}

/** Flush microtasks so async dispatch handlers complete */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// --- Tests ---

describe('QQChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wsInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('fetches token, discovers gateway, and connects WebSocket', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);

      const ws = await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);
      expect(ws.url).toBe('wss://gateway.qq.com/ws');
    });

    it('sends IDENTIFY after HELLO', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);

      const ws = await connectChannel(channel);

      // IDENTIFY should have been sent
      const identifyCall = ws.send.mock.calls.find((call: any[]) => {
        const payload = JSON.parse(call[0]);
        return payload.op === 2; // OP_IDENTIFY
      });
      expect(identifyCall).toBeDefined();

      const payload = JSON.parse(identifyCall![0]);
      expect(payload.d.token).toBe('QQBot test-token-123');
      expect(payload.d.intents).toBe(1 << 25);
    });

    it('starts heartbeat after HELLO', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);

      const ws = await connectChannel(channel);

      // Advance past heartbeat interval
      ws.send.mockClear();
      vi.advanceTimersByTime(30000);

      const heartbeatCall = ws.send.mock.calls.find((call: any[]) => {
        const payload = JSON.parse(call[0]);
        return payload.op === 1; // OP_HEARTBEAT
      });
      expect(heartbeatCall).toBeDefined();
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);

      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Token management ---

  describe('token management', () => {
    it('caches token and reuses on second call', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);

      mockTokenResponse();
      const token1 = await channel.getAccessToken();

      // Second call should not trigger another fetch
      const token2 = await channel.getAccessToken();

      expect(token1).toBe('test-token-123');
      expect(token2).toBe('test-token-123');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refreshes token after clearTokenCache()', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);

      mockTokenResponse();
      await channel.getAccessToken();

      channel.clearTokenCache();
      mockTokenResponse();
      await channel.getAccessToken();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('uses singleflight for concurrent token requests', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);

      mockTokenResponse();

      const [t1, t2, t3] = await Promise.all([
        channel.getAccessToken(),
        channel.getAccessToken(),
        channel.getAccessToken(),
      ]);

      expect(t1).toBe('test-token-123');
      expect(t2).toBe('test-token-123');
      expect(t3).toBe('test-token-123');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // --- C2C (DM) message handling ---

  describe('C2C message handling', () => {
    it('delivers C2C message for registered chat', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({
        op: 0,
        s: 2,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: 'msg-001',
          author: { user_openid: 'openid_abc123', username: 'Alice' },
          content: 'Hello from QQ',
          timestamp: '2024-06-01T12:00:00+08:00',
        },
      });
      await flush();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qq:c2c:openid_abc123',
        expect.any(String),
        'Alice',
        'qq',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:c2c:openid_abc123',
        expect.objectContaining({
          id: 'msg-001',
          chat_jid: 'qq:c2c:openid_abc123',
          sender: 'openid_abc123',
          sender_name: 'Alice',
          content: 'Hello from QQ',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered C2C chats', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({
        op: 0,
        s: 2,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: 'msg-002',
          author: { user_openid: 'unknown_openid', username: 'Bob' },
          content: 'Hello',
          timestamp: '2024-06-01T12:00:00+08:00',
        },
      });
      await flush();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qq:c2c:unknown_openid',
        expect.any(String),
        'Bob',
        'qq',
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Group message handling ---

  describe('group message handling', () => {
    it('delivers group @mention message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({
        op: 0,
        s: 3,
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: {
          id: 'grp-msg-001',
          group_openid: 'group_openid_xyz',
          group_name: 'Dev Team',
          author: { member_openid: 'member_abc', username: 'Charlie' },
          content: 'What is the weather?',
          timestamp: '2024-06-01T13:00:00+08:00',
        },
      });
      await flush();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qq:group:group_openid_xyz',
        expect.any(String),
        'Dev Team',
        'qq',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:group:group_openid_xyz',
        expect.objectContaining({
          id: 'grp-msg-001',
          chat_jid: 'qq:group:group_openid_xyz',
          sender: 'member_abc',
          sender_name: 'member_abc',
          content: '@Andy What is the weather?',
          is_from_me: false,
        }),
      );
    });

    it('prepends trigger to group messages that lack it', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({
        op: 0,
        s: 3,
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: {
          id: 'grp-msg-002',
          group_openid: 'group_openid_xyz',
          author: { member_openid: 'member_abc' },
          content: 'no trigger here',
        },
      });
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:group:group_openid_xyz',
        expect.objectContaining({
          content: '@Andy no trigger here',
        }),
      );
    });

    it('does not double-prepend trigger if already present', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({
        op: 0,
        s: 3,
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: {
          id: 'grp-msg-003',
          group_openid: 'group_openid_xyz',
          author: { member_openid: 'member_abc' },
          content: '@Andy hello',
        },
      });
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:group:group_openid_xyz',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('uses fallback group name when group_name is missing', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({
        op: 0,
        s: 3,
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: {
          id: 'grp-msg-004',
          group_openid: 'group_openid_xyz',
          author: { member_openid: 'member_abc' },
          content: 'test',
        },
      });
      await flush();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qq:group:group_openid_xyz',
        expect.any(String),
        'QQ Group group_op',
        'qq',
        true,
      );
    });
  });

  // --- Content cleaning ---

  describe('content cleaning', () => {
    it('strips QQ face tags from messages', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({
        op: 0,
        s: 2,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: 'msg-face',
          author: { user_openid: 'openid_abc123', username: 'Alice' },
          content: 'Hello <faceType=1,faceId=178> world',
          timestamp: '2024-06-01T12:00:00+08:00',
        },
      });
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:c2c:openid_abc123',
        expect.objectContaining({
          content: 'Hello world',
        }),
      );
    });

    it('collapses extra whitespace', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({
        op: 0,
        s: 2,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: 'msg-ws',
          author: { user_openid: 'openid_abc123', username: 'Alice' },
          content: '  hello   world  ',
          timestamp: '2024-06-01T12:00:00+08:00',
        },
      });
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:c2c:openid_abc123',
        expect.objectContaining({
          content: 'hello world',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends C2C message via REST API', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      // Mock the REST API call for sending
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await channel.sendMessage('qq:c2c:openid_abc123', 'Hello back!');

      // Find the POST call to /v2/users/...
      const sendCall = fetchMock.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('/v2/users/openid_abc123/messages'),
      );
      expect(sendCall).toBeDefined();

      const body = JSON.parse(sendCall![1].body);
      expect(body.content).toBe('Hello back!');
      expect(body.msg_type).toBe(0);
    });

    it('sends group message via REST API', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await channel.sendMessage('qq:group:group_openid_xyz', 'Group reply');

      const sendCall = fetchMock.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('/v2/groups/group_openid_xyz/messages'),
      );
      expect(sendCall).toBeDefined();

      const body = JSON.parse(sendCall![1].body);
      expect(body.content).toBe('Group reply');
      expect(body.msg_type).toBe(0);
    });

    it('includes msg_id for passive reply when available', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      // Simulate receiving a message first (sets lastMsgId)
      ws.simulateMessage({
        op: 0,
        s: 2,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: 'incoming-msg-id',
          author: { user_openid: 'openid_abc123', username: 'Alice' },
          content: 'Hello',
          timestamp: '2024-06-01T12:00:00+08:00',
        },
      });
      await flush();

      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await channel.sendMessage('qq:c2c:openid_abc123', 'Reply');

      const sendCall = fetchMock.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('/v2/users/openid_abc123/messages'),
      );
      const body = JSON.parse(sendCall![1].body);
      expect(body.msg_id).toBe('incoming-msg-id');
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      await connectChannel(channel);

      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await expect(
        channel.sendMessage('qq:c2c:openid_abc123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('warns on unknown JID format', async () => {
      const { logger } = await import('../logger.js');
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      await connectChannel(channel);

      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      await channel.sendMessage('unknown:jid', 'test');

      expect(logger.warn).toHaveBeenCalledWith(
        { jid: 'unknown:jid' },
        'QQ: Unknown JID format for sendMessage',
      );
    });
  });

  // --- Message splitting ---

  describe('splitMessage', () => {
    it('returns single chunk for short messages', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      expect(channel.splitMessage('Hello')).toEqual(['Hello']);
    });

    it('returns single chunk at exactly 2000 chars', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      const text = 'x'.repeat(2000);
      expect(channel.splitMessage(text)).toEqual([text]);
    });

    it('splits long messages at newline boundaries', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      const line = 'a'.repeat(999);
      const text = `${line}\n${line}\n${line}`;
      const chunks = channel.splitMessage(text);

      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(`${line}\n${line}`);
      expect(chunks[1]).toBe(line);
    });

    it('splits at hard limit when no newline found', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      const text = 'x'.repeat(3000);
      const chunks = channel.splitMessage(text);

      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe('x'.repeat(2000));
      expect(chunks[1]).toBe('x'.repeat(1000));
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns qq:c2c: JIDs', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      expect(channel.ownsJid('qq:c2c:openid_abc123')).toBe(true);
    });

    it('owns qq:group: JIDs', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      expect(channel.ownsJid('qq:group:group_openid_xyz')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Reconnection ---

  describe('reconnection', () => {
    it('schedules reconnect on WebSocket close', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      // Simulate close
      ws.emit('close', 1006, Buffer.from('abnormal'));

      expect(channel.isConnected()).toBe(false);

      // Mock reconnect fetch calls
      mockTokenResponse();
      mockGatewayResponse();

      // Advance past first backoff step (1 second)
      vi.advanceTimersByTime(1500);
    });

    it('does not reconnect after explicit disconnect', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      await connectChannel(channel);

      await channel.disconnect();

      // Record call count after disconnect
      const callCountAfterDisconnect = fetchMock.mock.calls.length;

      // Advance past reconnect backoff — should not trigger new fetches
      vi.advanceTimersByTime(5000);

      expect(fetchMock.mock.calls.length).toBe(callCountAfterDisconnect);
    });
  });

  // --- Gateway opcodes ---

  describe('gateway opcodes', () => {
    it('handles RECONNECT opcode by closing WebSocket', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({ op: 7 }); // OP_RECONNECT

      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it('handles INVALID_SESSION by re-identifying', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.send.mockClear();
      ws.simulateMessage({ op: 9 }); // OP_INVALID_SESSION

      const identifyCall = ws.send.mock.calls.find((call: any[]) => {
        const payload = JSON.parse(call[0]);
        return payload.op === 2;
      });
      expect(identifyCall).toBeDefined();
    });

    it('tracks sequence numbers from dispatches', async () => {
      const opts = createTestOpts();
      const channel = new QQChannel('app123', 'secret456', opts);
      const ws = await connectChannel(channel);

      ws.simulateMessage({
        op: 0,
        s: 42,
        t: 'RESUMED',
        d: {},
      });

      // Heartbeat should include the latest seq
      ws.send.mockClear();
      vi.advanceTimersByTime(30000);

      const heartbeatCall = ws.send.mock.calls.find((call: any[]) => {
        const payload = JSON.parse(call[0]);
        return payload.op === 1;
      });
      expect(heartbeatCall).toBeDefined();
      const payload = JSON.parse(heartbeatCall![0]);
      expect(payload.d).toBe(42);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "qq"', () => {
      const channel = new QQChannel('app123', 'secret456', createTestOpts());
      expect(channel.name).toBe('qq');
    });
  });
});
