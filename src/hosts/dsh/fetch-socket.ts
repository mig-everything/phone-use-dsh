import { EventEmitter } from 'node:events';
import type { PreviewSocket } from '../../transport/rtc-stream.js';

const WINDOW = 512 * 1024;
const LIMIT = 16 * 1024 * 1024;

/** Binary Fetch carrier for the shared preview protocol, with bounded backpressure. */
export class FetchPreviewSocket extends EventEmitter implements PreviewSocket {
  readonly body: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private ended = false;
  private sequence = 0;
  private feedbackSequence = 0;
  constructor(signal: AbortSignal) {
    super();
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        cancel: () => {
          this.close();
        },
      },
      { highWaterMark: WINDOW, size: (chunk) => chunk.byteLength },
    );
    const abort = () => this.close();
    signal.addEventListener('abort', abort, { once: true });
    this.once('close', () => signal.removeEventListener('abort', abort));
    if (signal.aborted) this.close();
  }
  get readyState() {
    return this.ended ? 3 : 1;
  }
  get bufferedAmount() {
    return this.ended ? 0 : Math.max(0, WINDOW - (this.controller.desiredSize ?? 0));
  }
  send(data: string | Buffer) {
    if (this.ended) return;
    const bytes = Buffer.from(data);
    if (bytes.length > LIMIT / 2 || this.bufferedAmount + bytes.length > LIMIT) return this.close();
    const header = Buffer.alloc(5);
    header[0] = typeof data === 'string' ? 1 : 2;
    header.writeUInt32BE(bytes.length, 1);
    try {
      this.controller.enqueue(Buffer.concat([header, bytes]));
    } catch {
      this.close();
    }
  }
  receive(sequence: number, message: string) {
    if (this.ended || sequence !== this.sequence + 1 || Buffer.byteLength(message) > 65536)
      throw new Error('Closed or out-of-order preview input; input was not replayed.');
    this.sequence = sequence;
    this.emit('message', Buffer.from(message), false);
  }
  receiveFeedback(sequence: number, acks: { session_id: string; observation_id: string }[]) {
    if (this.ended || sequence !== this.feedbackSequence + 1 || !acks.length || acks.length > 32)
      throw new Error('Closed or out-of-order preview feedback.');
    this.feedbackSequence = sequence;
    // This lane only acknowledges received frames. Device input always uses
    // the independently ordered control lane and its normal validation.
    for (const ack of acks)
      this.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'ack',
            session_id: ack.session_id,
            observation_id: ack.observation_id,
          }),
        ),
        false,
      );
  }
  close() {
    if (this.ended) return;
    this.ended = true;
    try {
      this.controller.close();
    } catch {
      /* Reader already cancelled. */
    }
    this.emit('close');
  }
}
