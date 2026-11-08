import type { ServerResponse } from 'node:http';

/**
 * 实时推送用浏览器自带的 SSE（EventSource）：服务器往下推，浏览器往上发用普通请求。
 * 打开某个对局页面 = 在这个对局里有一条推送连接 = 在这个对局“在线”。
 */
/** 一条推送连接是谁、连的什么：心跳时拿它判断这条连接还该不该开着。 */
export type StreamInfo = {
  userId: number;
  roomId: number | null;
  /** 观看（不在这一局里的人看公开对局、管理员看任何对局）：收推送，但不算这一局的“在线”。 */
  watch: boolean;
  /** 打开这条连接的那次登录（会话编号）。退出其他设备、改密码以后，别的登录开着的连接要断开。 */
  session: string | null;
};

type Stream = StreamInfo & {
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
  /** 已经断开或者被服务器关掉了，不能再往里写。 */
  closed: boolean;
};

const HEARTBEAT_MS = 25_000;
/** 每个账号最多同时开这么多条推送连接（开了太多标签页，或者有人故意狂开连接）：超过了先断开最早的。 */
export const MAX_STREAMS_PER_USER = 12;

export class RealtimeHub {
  private roomStreams = new Map<number, Set<Stream>>();
  private lobbyStreams = new Map<number, Set<Stream>>();
  private all = new Set<Stream>();

  /**
   * onPresenceChange：某人在某个对局里从不在线变成在线（online=true），或者反过来（online=false）时调用。
   * stillAllowed：每次心跳时检查这条连接还该不该开着（登录失效了、对局取消了公开、管理员被收回了权限），不该就断开。
   */
  constructor(
    private onPresenceChange: (roomId: number, userId: number, online: boolean) => void,
    private stillAllowed?: (stream: StreamInfo) => boolean,
  ) {}

  /** roomId 为 null 时是整个网站的推送（大厅、好友、公告）；watch 是观看对局，不算在线；session 是这次登录的会话编号。 */
  open(res: ServerResponse, userId: number, roomId: number | null, watch = false, session: string | null = null): Stream {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const stream: Stream = {
      res,
      userId,
      roomId,
      watch,
      session,
      // 定时发心跳，防止内网穿透或代理把空闲连接掐掉；顺便看看这条连接还该不该开着
      heartbeat: setInterval(() => this.beat(stream), HEARTBEAT_MS),
      closed: false,
    };
    const map = roomId === null ? this.lobbyStreams : this.roomStreams;
    const key = roomId ?? userId;
    const wasOnline = roomId !== null && !watch && this.isOnline(roomId, userId);

    // 连接太多：断开这个人最早的一条（它关掉时照常处理下线）
    const mine = [...this.all].filter((s) => s.userId === userId);
    if (mine.length >= MAX_STREAMS_PER_USER) mine[0].res.end();

    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(stream);
    this.all.add(stream);

    // 对方网络断掉时写入会出错；这里吞掉，不让它变成没人处理的错误把服务器弄崩
    res.on('error', () => {});
    res.on('close', () => {
      const closedByServer = stream.closed;
      this.detach(stream);
      // 服务器自己关掉的（对局被删除、服务器停止）、观看的，不算“下线”
      if (closedByServer || roomId === null || watch || this.isOnline(roomId, userId)) return;
      try {
        this.onPresenceChange(roomId, userId, false);
      } catch (err) {
        console.error('处理下线时出错：', err);
      }
    });

    if (roomId !== null && !watch && !wasOnline) this.onPresenceChange(roomId, userId, true);
    return stream;
  }

  /** 从登记里去掉，以后不再往这条连接推送。 */
  private detach(stream: Stream) {
    stream.closed = true;
    clearInterval(stream.heartbeat);
    this.all.delete(stream);
    const map = stream.roomId === null ? this.lobbyStreams : this.roomStreams;
    const key = stream.roomId ?? stream.userId;
    const set = map.get(key);
    if (set) {
      set.delete(stream);
      if (set.size === 0) map.delete(key);
    }
  }

  /** 马上按心跳的规矩检查一遍所有连接（不用等下一次心跳；测试也用它）。 */
  recheck() {
    for (const stream of [...this.all]) this.beat(stream);
  }

  private beat(stream: Stream) {
    let allowed = true;
    try {
      allowed = !this.stillAllowed || this.stillAllowed(stream);
    } catch {
      // 查不了（比如服务器正在停止）就先留着，下次心跳再看
    }
    if (allowed) this.write(stream, ': ping\n\n');
    else this.closeStreams([stream]);
  }

  private write(stream: Stream, chunk: string) {
    if (stream.closed || stream.res.writableEnded || stream.res.destroyed) return;
    stream.res.write(chunk);
  }

  onlineUserIds(roomId: number): Set<number> {
    const ids = new Set<number>();
    for (const stream of this.roomStreams.get(roomId) ?? []) if (!stream.watch) ids.add(stream.userId);
    return ids;
  }

  isOnline(roomId: number, userId: number): boolean {
    for (const stream of this.roomStreams.get(roomId) ?? []) if (stream.userId === userId && !stream.watch) return true;
    return false;
  }

  /** 这个人现在开着网站（任何页面）。好友列表里的“在线”用它。 */
  isConnected(userId: number): boolean {
    for (const stream of this.all) if (stream.userId === userId) return true;
    return false;
  }

  send(stream: Stream, event: string, data: unknown) {
    this.write(stream, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** 推给某个对局里所有打开着页面的人；filter 用来只推给部分人（比如私密信息）。 */
  toRoom(roomId: number, event: string, data: unknown, filter?: (userId: number) => boolean) {
    for (const stream of [...(this.roomStreams.get(roomId) ?? [])]) {
      if (!filter || filter(stream.userId)) this.send(stream, event, data);
    }
  }

  /**
   * 每个人收到的内容不一样时用这个：make 返回 undefined 表示这个人不推。同一个人开了几个页面，只算一次。
   * watch 表示这条连接是观看的（不在这一局里的人），看到的内容另有规矩。
   */
  toRoomEach(roomId: number, event: string, make: (userId: number, watch: boolean) => unknown) {
    const cache = new Map<string, unknown>();
    for (const stream of [...(this.roomStreams.get(roomId) ?? [])]) {
      const key = `${stream.userId}:${stream.watch}`;
      if (!cache.has(key)) cache.set(key, make(stream.userId, stream.watch));
      const data = cache.get(key);
      if (data !== undefined) this.send(stream, event, data);
    }
  }

  /** 推给某个人开着的大厅、“我的对局”这类页面（对局页面以外的页面）。 */
  toLobby(userId: number, event: string, data: unknown) {
    for (const stream of [...(this.lobbyStreams.get(userId) ?? [])]) this.send(stream, event, data);
  }

  /** 推给某个人开着的所有页面，包括对局页面（通知、私信、未读数这些跟着人走的推送）。 */
  toUser(userId: number, event: string, data: unknown) {
    for (const stream of [...this.all]) if (stream.userId === userId) this.send(stream, event, data);
  }

  /** 推给所有开着大厅这类页面的人（大厅里的公开对局有变化）。 */
  toAllLobbies(event: string, data: unknown) {
    for (const set of [...this.lobbyStreams.values()]) for (const stream of [...set]) this.send(stream, event, data);
  }

  /** 推给所有开着大厅这类页面的人，每个人的内容可以不一样（大厅聊天：屏蔽了发言的人就不推）。make 返回 undefined 表示这个人不推。 */
  toAllLobbiesEach(event: string, make: (userId: number) => unknown) {
    const cache = new Map<number, unknown>();
    for (const set of [...this.lobbyStreams.values()]) {
      for (const stream of [...set]) {
        if (!cache.has(stream.userId)) cache.set(stream.userId, make(stream.userId));
        const value = cache.get(stream.userId);
        if (value !== undefined) this.send(stream, event, value);
      }
    }
  }

  /** 推给所有开着网站的人（每个人的内容可以不一样，比如公告只发给某些人）。make 返回 undefined 表示这个人不推。 */
  toEveryone(event: string, make: (userId: number) => unknown) {
    const cache = new Map<number, unknown>();
    for (const stream of [...this.all]) {
      if (!cache.has(stream.userId)) cache.set(stream.userId, make(stream.userId));
      const value = cache.get(stream.userId);
      if (value !== undefined) this.send(stream, event, value);
    }
  }

  /** 现在开着网站的人（去重）。 */
  connectedUserIds(): Set<number> {
    return new Set([...this.all].map((s) => s.userId));
  }

  /** 对局被删除后，断开这个对局的所有推送连接（不触发“下线”）。 */
  closeRoom(roomId: number) {
    for (const stream of [...(this.roomStreams.get(roomId) ?? [])]) {
      this.detach(stream);
      stream.res.end();
    }
  }

  /** 断开这些连接；在对局里因此没有连接了的人算作下线。 */
  private closeStreams(streams: Stream[]) {
    const left = new Map<string, { roomId: number; userId: number }>();
    for (const stream of streams) {
      if (stream.closed) continue;
      // 观看的连接本来就不算在线，断开也不算下线
      if (stream.roomId !== null && !stream.watch) left.set(`${stream.roomId}:${stream.userId}`, { roomId: stream.roomId, userId: stream.userId });
      this.detach(stream);
      stream.res.end();
    }
    for (const { roomId, userId } of left.values()) {
      if (this.isOnline(roomId, userId)) continue;
      try {
        this.onPresenceChange(roomId, userId, false);
      } catch (err) {
        console.error('处理下线时出错：', err);
      }
    }
  }

  /** 账号被封禁、被删除、密码被重置：断开他所有的推送连接，在各个对局里算作下线。 */
  closeUser(userId: number) {
    this.closeStreams([...this.all].filter((s) => s.userId === userId));
  }

  /** 退出其他设备、改了密码：断开这个人别的登录开着的连接（keep 是现在这次登录，留着）。 */
  closeOtherSessions(userId: number, keep: string | null) {
    this.closeStreams([...this.all].filter((s) => s.userId === userId && s.session !== keep));
  }

  /** 退出登录：断开这次登录开着的连接。 */
  closeSession(session: string) {
    this.closeStreams([...this.all].filter((s) => s.session === session));
  }

  /**
   * 断开观看的连接（某一局的，或者某个人的）：取消了公开、管理员的权限变了。
   * 浏览器会自动重新连，那时再按现在的权限判断：还能看的照样看，不能看的连不上。
   */
  closeWatches(which: { roomId?: number; userId?: number }) {
    this.closeStreams(
      [...this.all].filter(
        (s) => s.watch && (which.roomId === undefined || s.roomId === which.roomId) && (which.userId === undefined || s.userId === which.userId),
      ),
    );
  }

  /** 服务器停止时断开所有推送连接（不触发“下线”）。 */
  closeAll() {
    for (const stream of [...this.all]) {
      this.detach(stream);
      stream.res.end();
    }
  }
}
