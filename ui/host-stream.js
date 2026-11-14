/* Authenticated host Fetch carrier. Frames never pass through a model tool result. */
function phoneUseHostStream(session, options = {}) {
  const controller = new AbortController();
  const fetchHost = (...args) => window.parent.fetch(...args);
  const endpoint = (name) => `/api/phone-use/${name}?session=${encodeURIComponent(session)}`;
  let channel,
    reader,
    sequence = 0,
    sending = Promise.resolve(),
    pendingBytes = 0;
  let feedbackSequence = 0,
    sendingFeedback = false;
  const feedback = [];
  const flushFeedback = async () => {
    if (sendingFeedback) return;
    sendingFeedback = true;
    try {
      while (feedback.length && socket.readyState === 1) {
        const batch = feedback.splice(0, 32);
        const response = await fetchHost(endpoint('feedback'), {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel, sequence: ++feedbackSequence, acks: batch }),
        });
        if (!response.ok) throw new Error('Preview feedback was not accepted.');
      }
    } catch (error) {
      socket.onerror?.(error);
      socket.close();
    } finally {
      sendingFeedback = false;
    }
  };
  const socket = {
    readyState: 0,
    binaryType: 'arraybuffer',
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    get bufferedAmount() {
      return pendingBytes;
    },
    send(message) {
      if (socket.readyState !== 1 || typeof message !== 'string' || message.length > 65536)
        return socket.close();
      if (options.feedback) {
        let value;
        try {
          value = JSON.parse(message);
        } catch {
          return socket.close();
        }
        if (value.type === 'ack') {
          if (feedback.length >= 128) return socket.close();
          feedback.push({ session_id: value.session_id, observation_id: value.observation_id });
          void flushFeedback();
          return;
        }
      }
      const number = ++sequence;
      pendingBytes += message.length;
      if (pendingBytes > 128 * 1024) return socket.close();
      sending = sending
        .then(async () => {
          if (socket.readyState !== 1) return;
          const response = await fetchHost(endpoint('input'), {
            method: 'POST',
            credentials: 'same-origin',
            signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ channel, sequence: number, message }),
          });
          if (!response.ok) throw new Error('Preview input was not accepted.');
        })
        .catch((error) => {
          socket.onerror?.(error);
          socket.close();
        })
        .finally(() => {
          pendingBytes -= message.length;
        });
    },
    close() {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      feedback.length = 0;
      controller.abort();
      void reader?.cancel().catch(() => {});
      if (channel)
        void fetchHost(endpoint('disconnect'), {
          method: 'POST',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(2500),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel }),
        }).catch(() => {});
      socket.onclose?.({});
    },
  };
  const start = async () => {
    try {
      const response = await fetchHost(endpoint('stream'), {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        cache: 'no-store',
      });
      channel = response.headers.get('x-phone-use-channel');
      if (
        !response.ok ||
        !response.body ||
        !channel ||
        !response.headers.get('content-type')?.startsWith('application/x-phone-use-stream')
      )
        throw new Error('Host preview is unavailable.');
      if (controller.signal.aborted) return;
      reader = response.body.getReader();
      socket.readyState = 1;
      socket.onopen?.({});
      let buffer = new Uint8Array();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (buffer.length + value.length > 16 * 1024 * 1024)
          throw new Error('Preview frame exceeds the limit.');
        const joined = new Uint8Array(buffer.length + value.length);
        joined.set(buffer);
        joined.set(value, buffer.length);
        buffer = joined;
        let offset = 0;
        while (buffer.length - offset >= 5) {
          const kind = buffer[offset],
            size = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4).getUint32(0);
          if (![1, 2].includes(kind) || size > 8 * 1024 * 1024)
            throw new Error('Invalid preview frame.');
          if (buffer.length - offset < size + 5) break;
          const bytes = buffer.slice(offset + 5, offset + 5 + size);
          socket.onmessage?.({ data: kind === 1 ? new TextDecoder().decode(bytes) : bytes.buffer });
          offset += size + 5;
        }
        buffer = buffer.slice(offset);
      }
      socket.close();
    } catch (error) {
      if (!controller.signal.aborted) socket.onerror?.(error);
      socket.close();
    }
  };
  return { socket, start };
}
