import * as dgram from 'dgram';
import * as net from 'net';
import { AuditEvent } from '../audit-event';
import { SyslogTargetConfig } from '../audit-sink.config';
import { formatRfc5424 } from '../rfc5424';
import { AuditTarget } from './audit-target';

const TCP_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Ships one RFC 5424 message per event over UDP or TCP.
 *
 * TCP uses octet counting (RFC 6587: `<length> <message>`) on one persistent
 * socket that reconnects with backoff. Nothing is buffered here beyond the
 * batch in flight — the service's bounded queue is the only buffer.
 */
export class SyslogAuditTarget implements AuditTarget {
  readonly name = 'syslog';
  readonly description: string;

  private udp: dgram.Socket | null = null;
  private tcp: net.Socket | null = null;
  private tcpConnecting: Promise<net.Socket> | null = null;
  private closed = false;

  constructor(private readonly cfg: SyslogTargetConfig) {
    this.description = `${cfg.host}:${cfg.port}/${cfg.protocol}`;
  }

  format(event: AuditEvent): string {
    return formatRfc5424(event, {
      facility: this.cfg.facility,
      appName: this.cfg.appName,
      procId: String(process.pid),
      maxBytes: this.cfg.maxBytes,
    });
  }

  async send(batch: AuditEvent[]): Promise<void> {
    if (this.closed) throw new Error('syslog target closed');
    for (const event of batch) {
      const msg = this.format(event);
      if (this.cfg.protocol === 'udp') await this.sendUdp(msg);
      else await this.sendTcp(msg);
    }
  }

  private sendUdp(msg: string): Promise<void> {
    if (!this.udp) {
      this.udp = dgram.createSocket(net.isIPv6(this.cfg.host) ? 'udp6' : 'udp4');
      this.udp.unref();
      this.udp.on('error', () => {
        /* reported through the send callback */
      });
    }
    const buf = Buffer.from(msg, 'utf8');
    return new Promise((resolve, reject) => {
      this.udp!.send(buf, 0, buf.length, this.cfg.port, this.cfg.host, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  private connectTcp(): Promise<net.Socket> {
    if (this.tcp && !this.tcp.destroyed) return Promise.resolve(this.tcp);
    if (this.tcpConnecting) return this.tcpConnecting;
    this.tcpConnecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: this.cfg.host, port: this.cfg.port });
      socket.unref();
      socket.setKeepAlive(true, 30_000);
      const onError = (err: Error) => {
        socket.destroy();
        if (this.tcp === socket) this.tcp = null;
        reject(err);
      };
      socket.once('error', onError);
      // A receiver that drops SYNs would otherwise hold the batch for the OS
      // connect timeout (minutes); fail fast and let the retry ladder decide.
      socket.setTimeout(TCP_CONNECT_TIMEOUT_MS, () => onError(new Error('syslog connect timed out')));
      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.off('error', onError);
        socket.on('error', () => {
          socket.destroy();
          if (this.tcp === socket) this.tcp = null;
        });
        socket.on('close', () => {
          if (this.tcp === socket) this.tcp = null;
        });
        this.tcp = socket;
        resolve(socket);
      });
    }).finally(() => {
      this.tcpConnecting = null;
    });
    return this.tcpConnecting;
  }

  private async sendTcp(msg: string): Promise<void> {
    const socket = await this.connectTcp();
    const payload = Buffer.from(msg, 'utf8');
    const frame = Buffer.concat([Buffer.from(`${payload.length} `, 'ascii'), payload]);
    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        /* already closed */
      }
      this.udp = null;
    }
    if (this.tcp) {
      this.tcp.end();
      this.tcp.destroy();
      this.tcp = null;
    }
  }
}
