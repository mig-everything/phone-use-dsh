// Standard WebRTC with MCP signaling; no certificate installation or relay.
function phoneUseRtc() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const channel = pc.createDataChannel('phone-use', { ordered: true });
  channel.binaryType = 'arraybuffer';
  let ended = false,
    frame,
    received = 0,
    frameTimer;
  const socket = {
    get readyState() {
      return ended ? 3 : channel.readyState === 'open' ? 1 : 0;
    },
    get bufferedAmount() {
      return channel.bufferedAmount;
    },
    send(data) {
      if (socket.readyState === 1) channel.send(data);
    },
    close() {
      if (ended) return;
      ended = true;
      clearTimeout(frameTimer);
      frame = undefined;
      pc.close();
      socket.onclose?.();
    },
    onopen: undefined,
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
  };
  const fail = () => {
    socket.onerror?.();
    socket.close();
  };
  channel.onopen = () => socket.onopen?.();
  channel.onclose = () => socket.close();
  channel.onerror = fail;
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected'].includes(pc.connectionState)) fail();
  };
  channel.onmessage = (event) => {
    if (ended) return;
    if (typeof event.data === 'string') {
      if (frame) return fail();
      socket.onmessage?.(event);
      return;
    }
    try {
      const packet = event.data,
        header = new DataView(packet);
      if (
        packet.byteLength <= 12 ||
        packet.byteLength > 16384 + 12 ||
        header.getUint32(0) !== 0x50555231
      )
        return fail();
      const total = header.getUint32(4),
        offset = header.getUint32(8);
      if (
        total < 1 ||
        total > 8 * 1024 * 1024 ||
        offset !== received ||
        offset + packet.byteLength - 12 > total
      )
        return fail();
      if (!frame) {
        frame = new Uint8Array(total);
        frameTimer = setTimeout(fail, 5000);
      }
      if (frame.length !== total) return fail();
      frame.set(new Uint8Array(packet, 12), offset);
      received += packet.byteLength - 12;
      if (received === total) {
        const data = frame.buffer;
        frame = undefined;
        received = 0;
        clearTimeout(frameTimer);
        socket.onmessage?.({ data });
      }
    } catch {
      fail();
    }
  };
  return {
    socket,
    async offer() {
      // The answer contains only a loopback candidate. Gathering browser LAN or
      // mDNS candidates is unnecessary; the local server never resolves them.
      await pc.setLocalDescription(await pc.createOffer());
      return pc.localDescription.sdp;
    },
    async accept(answer) {
      if (answer?.type !== 'answer' || typeof answer.sdp !== 'string' || answer.sdp.length > 16384)
        throw new Error('Invalid local WebRTC answer');
      const candidates = answer.sdp
        .split(/\r?\n/)
        .filter((line) => line.startsWith('a=candidate:'));
      if (
        !candidates.length ||
        candidates.some((line) => {
          const fields = line.split(' ');
          return (
            fields[2] !== 'udp' ||
            fields[4] !== '127.0.0.1' ||
            fields[6] !== 'typ' ||
            fields[7] !== 'host'
          );
        })
      )
        throw new Error('Expected only loopback WebRTC candidates');
      await pc.setRemoteDescription(answer);
    },
  };
}
