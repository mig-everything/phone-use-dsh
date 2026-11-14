import { EventEmitter } from 'node:events';
import type { RTCPeerConnection, RTCDataChannel } from 'werift';
import { PhoneError } from '../core/errors.js';

export interface PreviewSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer, binary: boolean) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: () => void): this;
}

// Ordered/reliable SCTP messages remain small. One bounded frame is reassembled
// by the UI; the shared preview protocol still permits only one unacked batch/device.
export const RTC_FRAGMENT_MAGIC = 0x50555231; // PUR1
export const RTC_FRAGMENT_BYTES = 16384;
export const RTC_MAX_FRAME = 8 * 1024 * 1024;
const RTC_SEND_WINDOW = 64 * 1024;

/** Internal transport adapter; exported for backpressure/lifecycle regression tests. */
export class RtcSocket extends EventEmitter implements PreviewSocket {
  private ended = false;
  private queue: { data: string | Buffer; offset: number }[] = [];
  private queuedBytes = 0;
  private scheduled?: NodeJS.Immediate;
  private readonly resume = () => this.schedule();
  constructor(
    private readonly channel: RTCDataChannel,
    private readonly dispose: () => void,
  ) {
    super();
    channel.onmessage = ({ data }) => {
      if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) return this.close();
      this.emit('message', Buffer.from(data), false);
    };
    channel.onclose = () => this.close();
    channel.onerror = () => this.close();
    channel.bufferedAmountLowThreshold = 0;
    channel.on('bufferedamountlow', this.resume);
  }
  get readyState() {
    return !this.ended && this.channel.readyState === 'open' ? 1 : 3;
  }
  get bufferedAmount() {
    return this.ended ? 0 : this.queuedBytes + this.channel.bufferedAmount;
  }
  send(data: string | Buffer) {
    if (this.readyState !== 1) return;
    const size = Buffer.byteLength(data);
    const bytes = size + (typeof data === 'string' ? 0 : 12 * Math.ceil(size / RTC_FRAGMENT_BYTES));
    if (
      size > RTC_MAX_FRAME ||
      (typeof data === 'string' && size > RTC_SEND_WINDOW) ||
      this.bufferedAmount + bytes > 2 * RTC_MAX_FRAME ||
      this.queue.length >= 1024
    ) {
      this.close();
      return;
    }
    if (Buffer.isBuffer(data) && !data.length) return;
    // Retain an immutable frame until the channel has capacity. Account for both
    // our queue and SCTP's buffer so the shared preview producer sees backpressure.
    this.queue.push({ data: typeof data === 'string' ? data : Buffer.from(data), offset: 0 });
    this.queuedBytes += bytes;
    this.schedule();
  }
  private schedule() {
    if (this.scheduled || this.readyState !== 1 || !this.queue.length) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.pump();
    });
    this.scheduled.unref();
  }
  private pump() {
    let written = 0;
    try {
      while (this.readyState === 1 && this.queue.length) {
        const item = this.queue[0]!;
        const { data, offset } = item;
        const size =
          typeof data === 'string'
            ? Buffer.byteLength(data)
            : 12 + Math.min(RTC_FRAGMENT_BYTES, data.length - offset);
        if (
          written + size > RTC_SEND_WINDOW ||
          this.channel.bufferedAmount + size > RTC_SEND_WINDOW
        )
          break;
        let packet: string | Buffer;
        if (typeof data === 'string') {
          packet = data;
          this.queue.shift();
        } else {
          packet = Buffer.allocUnsafe(size);
          packet.writeUInt32BE(RTC_FRAGMENT_MAGIC, 0);
          packet.writeUInt32BE(data.length, 4);
          packet.writeUInt32BE(offset, 8);
          data.copy(packet, 12, offset, offset + size - 12);
          item.offset += size - 12;
          if (item.offset === data.length) this.queue.shift();
        }
        this.queuedBytes -= size;
        written += size;
        this.channel.send(packet);
      }
      // Yield between bounded bursts; resume after SCTP drains instead of
      // enqueueing a whole multi-megabyte frame into concurrent SCTP sends.
      if (!this.channel.bufferedAmount) this.schedule();
    } catch {
      this.close();
    }
  }
  close() {
    if (this.ended) return;
    this.ended = true;
    clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.queue = [];
    this.queuedBytes = 0;
    this.channel.off('bufferedamountlow', this.resume);
    this.emit('close');
    this.dispose();
  }
}

/** MCP-signaled, ephemeral DTLS/SCTP. No CA trust store, DNS, STUN, TURN or LAN listener. */
export class RtcPreviewServer {
  private readonly peers = new Map<RTCPeerConnection, () => Promise<void>>();
  private closed = false;
  get size() {
    return this.peers.size;
  }
  async answer(offer: string, accept: (socket: PreviewSocket) => void) {
    const lines = offer.split(/\r?\n/);
    if (
      offer.length > 16384 ||
      lines.filter((line) => line.startsWith('m=')).length !== 1 ||
      !lines.some((line) => /^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(line)) ||
      !lines.some((line) => /^a=fingerprint:sha-256 (?:[\dA-F]{2}:){31}[\dA-F]{2}$/i.test(line))
    )
      throw new PhoneError('INVALID_ARGUMENT', 'Expected a bounded WebRTC data-channel offer.');
    // DSH's Fetch carrier and ordinary phone actions do not use WebRTC.
    // An optional media dependency must not prevent those hosts from loading.
    const PeerConnection = await import('werift')
      .then((module) => module.RTCPeerConnection)
      .catch(() => {
        throw new PhoneError(
          'RTC_UNAVAILABLE',
          'WebRTC could not load; use another preview transport.',
        );
      });
    if (this.closed || this.peers.size >= 16)
      throw new PhoneError('DEVICE_BUSY', 'Preview connection limit reached.');
    const pc = new PeerConnection({
      iceServers: [],
      // ICE-lite responds to the browser's local checks and never runs server
      // discovery. This also avoids werift's lower-level default STUN fallback.
      iceLite: true,
      // Disable interface discovery, then add and explicitly bind ONLY loopback.
      iceUseIpv4: false,
      iceUseIpv6: false,
      iceUseTcp: false,
      iceAdditionalHostAddresses: ['127.0.0.1'],
      iceInterfaceAddresses: { udp4: '127.0.0.1' },
      iceFilterStunResponse: (_message, address) => address[0] === '127.0.0.1',
      iceFilterCandidatePair: (pair) => pair.remoteCandidate.host === '127.0.0.1',
    });
    let socket: RtcSocket | undefined;
    let closing: Promise<void> | undefined;
    const dispose = () => {
      if (closing) return closing;
      clearTimeout(timeout);
      // Keep closing peers counted until all their sockets have actually closed.
      closing = Promise.resolve().then(async () => {
        socket?.close();
        try {
          await pc.close();
        } finally {
          this.peers.delete(pc);
        }
      });
      return closing;
    };
    const end = () => {
      void dispose().catch(() => {});
    };
    const timeout = setTimeout(end, 10000);
    timeout.unref();
    this.peers.set(pc, dispose);
    pc.onconnectionstatechange = () => {
      if (['closed', 'failed', 'disconnected'].includes(pc.connectionState)) end();
    };
    pc.ondatachannel = ({ channel }) => {
      if (
        socket ||
        channel.label !== 'phone-use' ||
        !channel.ordered ||
        channel.maxRetransmits !== null ||
        channel.maxPacketLifeTime !== null
      ) {
        end();
        return;
      }
      socket = new RtcSocket(channel, end);
      const opened = () => {
        if (closing || this.closed) return end();
        clearTimeout(timeout);
        accept(socket!);
      };
      if (channel.readyState === 'open') opened();
      else channel.onopen = opened;
    };
    try {
      // The browser initiates to our loopback candidate. Never resolve its mDNS
      // candidates or probe user-supplied addresses through this local service.
      const sdp = lines
        .filter(
          (line) =>
            !line.startsWith('a=candidate:') &&
            !line.startsWith('a=remote-candidates:') &&
            line !== 'a=end-of-candidates',
        )
        .join('\r\n');
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (closing || this.closed) throw new Error('Preview negotiation closed');
      return { type: 'answer' as const, sdp: pc.localDescription!.sdp };
    } catch {
      await dispose();
      throw new PhoneError('INVALID_ARGUMENT', 'Could not negotiate the local preview channel.');
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.peers.values()].map((dispose) => dispose()));
  }
}
