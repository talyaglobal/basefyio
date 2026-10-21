const udpSend = jest.fn();
const udpClose = jest.fn();
const udpOn = jest.fn();
jest.mock('dgram', () => ({
  createSocket: jest.fn(() => ({ send: udpSend, close: udpClose, on: udpOn, unref: jest.fn() })),
}));

type Handler = (...args: any[]) => void;
const sockets: FakeTcpSocket[] = [];
class FakeTcpSocket {
  destroyed = false;
  written: Buffer[] = [];
  private handlers = new Map<string, Handler[]>();
  constructor() {
    sockets.push(this);
  }
  timeoutHandler: (() => void) | null = null;
  unref() {}
  setKeepAlive() {}
  setTimeout(ms: number, h?: () => void) {
    this.timeoutHandler = ms > 0 && h ? h : null;
    return this;
  }
  on(event: string, h: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) || []), h]);
    return this;
  }
  once(event: string, h: Handler) {
    return this.on(event, h);
  }
  off(event: string, h: Handler) {
    this.handlers.set(event, (this.handlers.get(event) || []).filter((x) => x !== h));
    return this;
  }
  emit(event: string, ...args: any[]) {
    for (const h of [...(this.handlers.get(event) || [])]) h(...args);
  }
  write(buf: Buffer, cb: (err?: Error) => void) {
    this.written.push(buf);
    cb();
    return true;
  }
  end() {}
  destroy() {
    this.destroyed = true;
  }
}
jest.mock('net', () => ({
  isIPv6: () => false,
  createConnection: jest.fn(() => new FakeTcpSocket()),
}));

import { AuditEvent } from '../audit-event';
import { SyslogAuditTarget } from './syslog-audit-target';

const ev = (n: number): AuditEvent => ({
  time: '2026-10-20T10:00:00.000Z',
  source: 'http',
  traceId: `t${n}`,
  actorUserId: 'u',
  actorRole: 'USER',
  action: 'GET /x',
  resourceType: 'x',
  resourceId: null,
  severity: 'LOW',
  success: true,
  host: 'h',
  env: 'test',
  product: 'basefyio',
});

const base = { host: 'collector.example', port: 514, facility: 13, appName: 'basefyio-api', maxBytes: 8192 };

beforeEach(() => {
  udpSend.mockReset();
  udpClose.mockReset();
  sockets.length = 0;
});

describe('SyslogAuditTarget over UDP', () => {
  it('sends one datagram per event with the RFC 5424 line', async () => {
    udpSend.mockImplementation((_b, _o, _l, _p, _h, cb) => cb(null));
    const target = new SyslogAuditTarget({ ...base, protocol: 'udp' });
    await target.send([ev(1), ev(2)]);
    expect(udpSend).toHaveBeenCalledTimes(2);
    const [buf, offset, length, port, host] = udpSend.mock.calls[0];
    expect(port).toBe(514);
    expect(host).toBe('collector.example');
    expect(offset).toBe(0);
    expect(length).toBe(buf.length);
    expect(buf.toString('utf8').startsWith('<110>1 2026-10-20T10:00:00.000Z h basefyio-api ')).toBe(true);
    await target.close();
    expect(udpClose).toHaveBeenCalled();
  });

  it('surfaces a send error so the service can retry and count it', async () => {
    udpSend.mockImplementation((_b, _o, _l, _p, _h, cb) => cb(new Error('EHOSTUNREACH')));
    const target = new SyslogAuditTarget({ ...base, protocol: 'udp' });
    await expect(target.send([ev(1)])).rejects.toThrow('EHOSTUNREACH');
  });
});

describe('SyslogAuditTarget over TCP', () => {
  it('frames each message with octet counting on one persistent socket', async () => {
    const target = new SyslogAuditTarget({ ...base, protocol: 'tcp' });
    const pending = target.send([ev(1), ev(2)]);
    await new Promise((r) => setImmediate(r));
    sockets[0].emit('connect');
    await pending;
    expect(sockets).toHaveLength(1);
    expect(sockets[0].written).toHaveLength(2);
    const frame = sockets[0].written[0].toString('utf8');
    const space = frame.indexOf(' ');
    const declared = Number(frame.slice(0, space));
    const body = frame.slice(space + 1);
    expect(Buffer.byteLength(body, 'utf8')).toBe(declared);
    expect(body.startsWith('<110>1 ')).toBe(true);
  });

  it('reconnects after the socket drops', async () => {
    const target = new SyslogAuditTarget({ ...base, protocol: 'tcp' });
    const first = target.send([ev(1)]);
    await new Promise((r) => setImmediate(r));
    sockets[0].emit('connect');
    await first;
    sockets[0].emit('close');
    const second = target.send([ev(2)]);
    await new Promise((r) => setImmediate(r));
    sockets[1].emit('connect');
    await second;
    expect(sockets).toHaveLength(2);
    expect(sockets[1].written).toHaveLength(1);
  });

  it('fails the batch when the connection is refused', async () => {
    const target = new SyslogAuditTarget({ ...base, protocol: 'tcp' });
    const pending = target.send([ev(1)]);
    await new Promise((r) => setImmediate(r));
    sockets[0].emit('error', new Error('ECONNREFUSED'));
    await expect(pending).rejects.toThrow('ECONNREFUSED');
  });

  it('gives up on a connection that never completes', async () => {
    const target = new SyslogAuditTarget({ ...base, protocol: 'tcp' });
    const pending = target.send([ev(1)]);
    await new Promise((r) => setImmediate(r));
    expect(sockets[0].timeoutHandler).not.toBeNull();
    sockets[0].timeoutHandler!();
    await expect(pending).rejects.toThrow('timed out');
    expect(sockets[0].destroyed).toBe(true);
  });

  it('clears the connect timeout once connected', async () => {
    const target = new SyslogAuditTarget({ ...base, protocol: 'tcp' });
    const pending = target.send([ev(1)]);
    await new Promise((r) => setImmediate(r));
    sockets[0].emit('connect');
    await pending;
    expect(sockets[0].timeoutHandler).toBeNull();
  });
});
