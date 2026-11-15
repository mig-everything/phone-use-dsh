(() => {
  'use strict';
  const version = '__PHONE_USE_VERSION__';
  const byId = (id) => document.getElementById(id);
  const pending = new Map(),
    entries = new Map(),
    connecting = new Set();
  const icon = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  const icons = {
    more: icon(
      '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    ),
    refresh: icon(
      '<path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/>',
    ),
    back: icon('<path d="m14 6-6 6 6 6"/>'),
    home: icon('<circle cx="12" cy="12" r="7"/>'),
    screenshot: icon('<path d="M8 5 6 8H3v12h18V8h-3l-2-3Z"/><circle cx="12" cy="13" r="4"/>'),
  };
  const platformNames = {
    harmonyos: 'HarmonyOS',
    android: 'Android',
    ios: 'iPhone',
    demo: '虚拟演示',
  };
  const postureNames = { folded: '折叠', 'half-folded': '半折叠', expanded: '展开', unknown: '' };
  const actionNames = {
    tap: '点击',
    tap_node: '点击控件',
    swipe: '滑动',
    text: '输入文字',
    key: '系统按键',
    launch: '打开应用',
    fold: '切换折叠姿态',
  };
  let nextId = 1,
    origin = '*',
    initialized = false,
    disposed = false,
    suspended = false;
  let hostCarrier,
    hostVisible = true;
  let hostIntent, pickerSignature;
  let panelId,
    activeId,
    mode = 'focus',
    layoutChosen = false,
    devices = [],
    diagnostics = [];
  let tickTimer,
    statusRunning = false,
    nextStatus = 0,
    frameCount = 0;
  let liveSocket,
    liveReady = false,
    livePerDeviceVideo = false,
    liveFrameWindow = 1,
    liveConnecting = false,
    nextLive = 0,
    nextRtc = 0,
    nextHeartbeat = 0;
  let selectionRevision = 0;
  const livePending = new Map();
  let connectionReason = 'none',
    connectionSecure = false,
    connectionTransport = 'mcp',
    rtcFailure = 'none',
    connectionEndpoint,
    reportTimer;
  const connectionReasons = {
    none: '正在建立本机连接',
    csp: '宿主安全策略拦截了直连地址',
    'connect-error': '连接失败，请检查本机服务和宿主的本地连接权限',
    'handshake-timeout': '本机连接握手超时',
    closed: '本机连接已断开',
    bootstrap: '宿主未能取得直连凭据',
    'invalid-ticket': '直连配置缺失或协议不匹配',
    'server-config': '加密直连的证书配置无效',
  };
  function connectionReport() {
    return {
      version,
      state: liveReady ? 'direct' : connectionReason === 'none' ? 'connecting' : 'fallback',
      reason: connectionReason,
      secure: connectionSecure,
      webcodecs: nativeVideo,
      transport: liveReady ? connectionTransport : 'mcp',
      rtc_failure: rtcFailure,
    };
  }
  function connectionStatus(reason = connectionReason) {
    connectionReason = reason;
    byId('connection-status').textContent = liveReady
      ? connectionTransport === 'host'
        ? '宿主直连'
        : '本机直连'
      : '兼容预览';
    byId('connection-detail').textContent = liveReady
      ? `${{ webrtc: 'WebRTC 加密直连', wss: 'WSS 加密直连', ws: 'WS 本机直连', host: 'DSH 原生通道' }[connectionTransport]} · 视频与操作使用独立通道`
      : `MCP 图片轮询 · ${connectionReasons[reason]}`;
    byId('connection-help').textContent = liveReady
      ? ''
      : hostCarrier?.kind === 'dsh'
        ? '宿主通道暂未连接。可重试直连；更新插件后请重新打开此看板。无需配置证书。'
        : connectionTransport === 'wss'
          ? 'WebRTC 暂不可用，已尝试配置的 WSS。请检查证书信任及宿主本地连接权限；普通操作无需证书。'
          : `WebRTC ${rtcFailure === 'unavailable' ? '未受宿主支持' : '暂未连接'}，已自动使用兼容预览。无需安装证书，可重试连接或更新宿主。`;
    byId('connection-version').textContent =
      `Phone Use ${version} · ${nativeVideo ? '具备 WebCodecs' : '无 WebCodecs'}`;
    for (const e of entries.values()) previewDetails(e);
    clearTimeout(reportTimer);
    if (panelId && initialized && !disposed)
      reportTimer = setTimeout(() => {
        void tool('phone_panel', { panel_id: panelId, preview_client: connectionReport() }).catch(
          () => {},
        );
      }, 150);
  }
  document.addEventListener('securitypolicyviolation', (event) => {
    if (event.effectiveDirective !== 'connect-src' || !connectionEndpoint) return;
    try {
      if (new URL(event.blockedURI).origin === connectionEndpoint) connectionStatus('csp');
    } catch {
      /* Do not log URLs or security-policy contents. */
    }
  });
  const visible = () => !disposed && !suspended && hostVisible && !document.hidden;
  function notify(method, params = {}) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, origin);
  }
  function request(method, params, timeoutMs = 45000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('宿主响应超时，请重新观察后再操作。'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, origin);
    });
  }
  async function tool(name, args) {
    const result = await request('tools/call', { name, arguments: args });
    return checked(result);
  }
  function checked(result) {
    if (result.isError) {
      const detail = result.structuredContent?.error;
      const error = new Error(detail?.message ?? '设备操作失败，请重新观察。');
      error.code = detail?.code;
      error.uncertain = detail?.uncertain;
      throw error;
    }
    return result;
  }
  function updateView() {
    if (!liveReady || liveSocket?.readyState !== WebSocket.OPEN) return;
    const sessions = visible()
      ? [...entries.values()]
          .filter(
            (e) =>
              e.live && e.inView && !e.card.hidden && !e.disposed && !e.pausing && !e.state.paused,
          )
          .slice(0, 8)
          .map((e) => e.id)
      : [];
    liveSocket.send(
      JSON.stringify({
        type: 'view',
        sessions,
        quality: mode,
        ...(liveFrameWindow > 1 ? { frame_window: liveFrameWindow } : {}),
        video:
          nativeVideo &&
          (livePerDeviceVideo || !sessions.some((id) => entries.get(id).videoFailure)),
        ...(livePerDeviceVideo
          ? {
              video_sessions: sessions.filter((id) => nativeVideo && !entries.get(id).videoFailure),
              video_failures: sessions.flatMap((id) => {
                const reason = nativeVideo ? entries.get(id).videoFailure : 'unavailable';
                return reason ? [{ session_id: id, reason }] : [];
              }),
            }
          : {}),
      }),
    );
    nextHeartbeat = Date.now() + 2000;
  }
  function liveAction(e, action) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        livePending.delete(id);
        const error = new Error('操作响应超时，请观察设备后再继续。');
        error.uncertain = true;
        reject(error);
      }, 45000);
      livePending.set(id, { resolve, reject, timer });
      liveSocket.send(JSON.stringify({ type: 'act', id, session_id: e.id, action }));
    }).then(checked);
  }
  function livePointer(e, phase, point, observation_id) {
    const id = nextId++;
    const started = performance.now();
    return new Promise((resolve, reject) => {
      if (!liveReady || liveSocket?.readyState !== WebSocket.OPEN)
        return reject(new Error('原生操作通道已断开'));
      const timer = setTimeout(() => {
        livePending.delete(id);
        reject(new Error('触控响应超时，已停止本次手势'));
        liveSocket?.close();
      }, 6000);
      livePending.set(id, { resolve, reject, timer });
      liveSocket.send(
        JSON.stringify({
          type: 'pointer',
          id,
          session_id: e.id,
          phase,
          x: point.x,
          y: point.y,
          ...(observation_id ? { observation_id } : {}),
        }),
      );
    })
      .then(checked)
      .finally(() => {
        e.pointerTiming ??= {};
        e.pointerTiming[phase] = Math.round(performance.now() - started);
      });
  }
  async function flushPointer(e) {
    const p = e.directPointer;
    if (!p || p.sending) return;
    p.sending = true;
    try {
      if (!p.started) {
        p.started = true;
        await livePointer(e, 'down', p, p.observation_id);
      }
      while (p.next || p.end) {
        const point = p.next ?? p.last ?? p;
        const previous = p.last ?? p;
        if (p.end !== 'cancel' && !p.last && (point.x !== p.x || point.y !== p.y)) {
          // A pan recognizer may use its first move only to begin recognition.
          // Retain the first real sample as well as the latest; a single jump
          // gets one point on the same segment. This remains a bounded gesture.
          const first = p.firstMove;
          const anchor =
            first && (first.x !== point.x || first.y !== point.y)
              ? first
              : { x: (p.x + point.x) / 2, y: (p.y + point.y) / 2 };
          // The OS may coalesce down and the first move when both arrive in one
          // display interval. Pace just the beginning of a pan; subsequent moves
          // remain immediate. Recheck cancellation after yielding.
          await new Promise((resolve) => setTimeout(resolve, 16));
          if (p.end === 'cancel') continue;
          p.last = anchor;
          await livePointer(e, 'move', anchor);
          await new Promise((resolve) => setTimeout(resolve, 16));
          continue;
        }
        // A quick drag may finish while down is still awaiting acknowledgement.
        // Preserve its final movement before up; otherwise platforms can interpret
        // the down/up pair as a tap. Cancellation must never add a movement.
        const finalMove = p.end === 'up' && (point.x !== previous.x || point.y !== previous.y);
        const phase = finalMove ? 'move' : (p.end ?? 'move');
        p.next = undefined;
        p.last = point;
        await livePointer(e, phase, point);
        if (phase !== 'move') {
          e.directPointer = undefined;
          e.observation = undefined;
          e.nextFrame = 0;
          break;
        }
      }
    } catch (error) {
      e.directPointer = undefined;
      e.actionError = error.message;
      // Release a possibly accepted finger. Never replay its down/move on another backend.
      if (liveReady) void livePointer(e, 'cancel', p.last ?? p).catch(() => {});
      e.observation = undefined;
      e.nextFrame = 0;
    } finally {
      p.sending = false;
      controls(e);
    }
  }
  function cancelDirectPointer(e) {
    if (!e.directPointer) return;
    e.directPointer.end = 'cancel';
    e.directPointer.next = undefined;
    void flushPointer(e);
  }
  const nativeVideo =
    typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
  function stopDecoder(e) {
    e.decodePending?.finish();
    e.decodePending = undefined;
    if (e.decoder && e.decoder.state !== 'closed') e.decoder.close();
    e.decoder = undefined;
  }
  function failVideo(e, reason) {
    e.videoFailure = reason;
    stopDecoder(e);
    updateView();
    previewDetails(e);
  }
  async function decodeVideo(e, data, payload) {
    const video = data.video;
    if (!nativeVideo || e.videoFailure || !video?.packets?.length) return;
    try {
      const key = `${video.codec}:${video.epoch}`;
      if (!e.decoder || e.decoder.state === 'closed' || e.decoderKey !== key || video.reset) {
        stopDecoder(e);
        let config = {
          codec: video.codec,
          optimizeForLatency: true,
          hardwareAcceleration: 'prefer-hardware',
        };
        if (!(await VideoDecoder.isConfigSupported(config)).supported) {
          // A host without GPU decode may still support software H.264. Keep
          // the original stream before falling back to JPEG re-encoding.
          config = { ...config, hardwareAcceleration: 'no-preference' };
          if (!(await VideoDecoder.isConfigSupported(config)).supported)
            throw Object.assign(new Error('Video codec unsupported'), { reason: 'unsupported' });
        }
        if (e.disposed) return;
        e.decoderKey = key;
        e.decoder = new VideoDecoder({
          output(frame) {
            const pending = e.decodePending;
            try {
              if (!pending || frame.timestamp !== pending.timestamp) return;
              if (!e.disposed && visible() && pending.generation === e.generation) {
                if (e.canvas.width !== frame.displayWidth) e.canvas.width = frame.displayWidth;
                if (e.canvas.height !== frame.displayHeight) e.canvas.height = frame.displayHeight;
                e.context ??= e.canvas.getContext('2d', { alpha: false, desynchronized: true });
                e.context.drawImage(frame, 0, 0);
                applyFrame(e, {
                  structuredContent: pending.data,
                  _meta: { frame: { native: true, mimeType: 'video/h264' } },
                });
              }
              pending.finish();
            } finally {
              frame.close();
            }
          },
          error() {
            failVideo(e, 'decode-error');
          },
        });
        e.decoder.configure(config);
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          e.decodePending = undefined;
          reject(Object.assign(new Error('Video decode timed out'), { reason: 'timeout' }));
        }, 1500);
        e.decodePending = {
          data,
          generation: e.generation,
          timestamp: video.packets.at(-1).timestamp,
          finish() {
            clearTimeout(timer);
            e.decodePending = undefined;
            resolve();
          },
        };
        let offset = 0;
        for (const packet of video.packets) {
          if (offset + packet.length > payload.byteLength) throw new Error('Invalid video payload');
          e.decoder.decode(
            new EncodedVideoChunk({
              type: packet.key ? 'key' : 'delta',
              timestamp: packet.timestamp,
              data: payload.subarray(offset, offset + packet.length),
            }),
          );
          offset += packet.length;
        }
      });
    } catch (error) {
      failVideo(e, error.reason ?? 'decode-error');
    }
  }
  async function prepareConnection() {
    if (hostCarrier?.kind === 'dsh') {
      const result = await tool('phone_connect', { panel_id: panelId });
      const config = result._meta?.stream;
      if (config?.transport !== 'host') throw new Error('Host preview unavailable');
      return {
        ...phoneUseHostStream(hostCarrier.session, {
          feedback: config.features?.includes('frame-feedback') === true,
        }),
        config,
        transport: 'host',
      };
    }
    if (typeof RTCPeerConnection === 'function' && Date.now() >= nextRtc) {
      let rtc;
      try {
        rtc = phoneUseRtc();
        const result = checked(
          await request(
            'tools/call',
            {
              name: 'phone_connect',
              arguments: { panel_id: panelId, rtc_offer: await rtc.offer() },
            },
            8000,
          ),
        );
        const config = result._meta?.stream;
        if (config?.transport !== 'webrtc' || !config.features?.includes('rtc-fragments-v1'))
          throw new Error('WebRTC not available');
        return {
          socket: rtc.socket,
          config,
          transport: 'webrtc',
          start: () => rtc.accept(config.answer),
        };
      } catch {
        rtc?.socket.close();
        rtcFailure = 'negotiation';
        nextRtc = Date.now() + 60000;
      }
    } else if (typeof RTCPeerConnection !== 'function') rtcFailure = 'unavailable';
    const result = await tool('phone_connect', { panel_id: panelId });
    const config = result._meta?.stream;
    const url = new URL(config?.url);
    if (
      !['ws:', 'wss:'].includes(url.protocol) ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/phone-use' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid preview endpoint');
    return {
      socket: new WebSocket(config.url),
      config,
      transport: url.protocol.slice(0, -1),
      endpoint: url.origin,
    };
  }
  async function connectLive() {
    if (
      !panelId ||
      !initialized ||
      liveConnecting ||
      liveReady ||
      Date.now() < nextLive ||
      !visible()
    )
      return;
    liveConnecting = true;
    nextLive = Date.now() + 15000;
    connectionReason = 'none';
    const wantedPanel = panelId;
    try {
      const connection = await prepareConnection();
      const { config, socket: ws, transport } = connection;
      if (disposed || panelId !== wantedPanel) {
        ws.close();
        return;
      }
      if (!config || config.protocol !== 1 || !/^[a-f0-9]{64}$/.test(config.token)) {
        ws.close();
        return connectionStatus('invalid-ticket');
      }
      livePerDeviceVideo = config.features?.includes('per-device-video') === true;
      liveFrameWindow = config.features?.includes('frame-window') === true ? 4 : 1;
      connectionTransport = transport;
      connectionSecure = transport !== 'ws';
      connectionEndpoint = connection.endpoint;
      liveSocket?.close();
      liveSocket = ws;
      ws.binaryType = 'arraybuffer';
      const timeout = setTimeout(
        () => {
          if (!liveReady && ws === liveSocket) {
            if (connectionReason === 'none') connectionStatus('handshake-timeout');
            ws.close();
          }
        },
        transport === 'webrtc' ? 5000 : 3000,
      );
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: config.token }));
      ws.onmessage = async (event) => {
        if (ws !== liveSocket || disposed) return;
        if (event.data instanceof ArrayBuffer) {
          let data, release;
          try {
            const packet = event.data,
              length = new DataView(packet).getUint32(0);
            if (length > 65536 || length + 4 >= packet.byteLength) return;
            data = JSON.parse(new TextDecoder().decode(new Uint8Array(packet, 4, length)));
            const e = entries.get(data.session_id);
            if (!e || e.card.hidden || !e.live || !visible()) return;
            const previous = e.receiving ?? Promise.resolve();
            const generationAtReceipt = e.generation;
            e.receiving = new Promise((resolve) => {
              release = resolve;
            });
            await previous;
            if (
              ws !== liveSocket ||
              e.disposed ||
              e.generation !== generationAtReceipt ||
              e.card.hidden ||
              !e.live ||
              !visible()
            )
              return;
            if (data.mimeType === 'video/h264') {
              await decodeVideo(e, data, new Uint8Array(packet, 4 + length));
              return;
            }
            const src = URL.createObjectURL(
              new Blob([packet.slice(4 + length)], { type: 'image/jpeg' }),
            );
            const generation = e.generation,
              decoded = new Image();
            decoded.src = src;
            try {
              await decoded.decode();
            } catch {
              URL.revokeObjectURL(src);
              return;
            }
            if (e.disposed || e.generation !== generation || !visible()) {
              URL.revokeObjectURL(src);
              return;
            }
            if (
              applyFrame(e, {
                structuredContent: data,
                _meta: { frame: { url: src, mimeType: 'image/jpeg' } },
              })
            ) {
              const previous = e.objectUrl;
              e.objectUrl = src;
              if (previous) URL.revokeObjectURL(previous);
            } else URL.revokeObjectURL(src);
          } catch {
            // A corrupt packet cannot replace the last valid screen or authorize input.
          } finally {
            release?.();
            if (data?.observation?.id && ws.readyState === WebSocket.OPEN)
              ws.send(
                JSON.stringify({
                  type: 'ack',
                  session_id: data.session_id,
                  observation_id: data.observation.id,
                }),
              );
          }
          return;
        }
        const data = JSON.parse(event.data);
        if (data.type === 'ready') {
          liveReady = true;
          if (transport === 'webrtc') rtcFailure = 'none';
          connectionStatus('none');
          clearTimeout(timeout);
          updateView();
          layout();
        } else if (data.type === 'panel') applyPanel(data.panel);
        else if (data.type === 'result') {
          const p = livePending.get(data.id);
          if (p) {
            livePending.delete(data.id);
            clearTimeout(p.timer);
            p.resolve(data.result);
          }
        } else if (data.type === 'frame-error') {
          const e = entries.get(data.session_id);
          if (e && !e.state.paused) {
            e.error = data.error?.message ?? '画面暂不可用';
            controls(e);
          }
        }
      };
      ws.onerror = () => {
        if (ws === liveSocket && connectionReason === 'none') connectionStatus('connect-error');
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (ws !== liveSocket) return;
        liveReady = false;
        if (transport === 'webrtc' && !disposed) {
          rtcFailure =
            connectionReason === 'handshake-timeout'
              ? 'timeout'
              : connectionReason === 'connect-error'
                ? 'connect-error'
                : 'closed';
          nextRtc = Date.now() + 60000;
          nextLive = 0;
        }
        connectionStatus(connectionReason === 'none' ? 'closed' : connectionReason);
        for (const p of livePending.values()) {
          clearTimeout(p.timer);
          const error = new Error('直连通道已断开，操作结果待确认。请观察后继续。');
          error.uncertain = true;
          p.reject(error);
        }
        livePending.clear();
        for (const e of entries.values()) {
          stopDecoder(e);
          e.generation++;
          e.observation = undefined;
          e.nextFrame = 0;
        }
        layout();
        tick();
      };
      if (connection.start) {
        try {
          void connection.start().catch(() => {
            ws.onerror?.();
            ws.close();
          });
        } catch {
          ws.onerror();
          ws.close();
        }
      }
    } catch (error) {
      connectionStatus(error.code === 'CONFIG_ERROR' ? 'server-config' : 'bootstrap');
    } finally {
      liveConnecting = false;
    }
  }
  function message(text = '') {
    byId('status').textContent = text;
  }
  function context() {
    if (!initialized || !activeId || !entries.has(activeId)) return;
    const e = entries.get(activeId);
    void request(
      'ui/update-model-context',
      {
        content: [
          {
            type: 'text',
            text: `Phone Use panel selection: ${e.state.device.name}; device_id=${e.state.device.id}; session_id=${activeId}. This selection is context only. Observe this device before acting; use each device's own observation for parallel tasks.`,
          },
        ],
      },
      8000,
    ).catch(() => {});
  }
  function choose(id, focus = false) {
    activeId = id;
    for (const e of entries.values()) {
      e.pointer = undefined;
      cancelDirectPointer(e);
    }
    if (focus) {
      mode = 'focus';
      layoutChosen = true;
    }
    layout();
    const e = entries.get(id);
    if (e) e.nextFrame = 0;
    context();
  }
  function layout() {
    if (!entries.has(activeId)) activeId = entries.keys().next().value;
    byId('workspace').dataset.mode = mode;
    byId('focus-mode').setAttribute('aria-pressed', String(mode === 'focus'));
    byId('grid-mode').setAttribute('aria-pressed', String(mode === 'grid'));
    byId('empty-workspace').hidden = entries.size > 0;
    byId('tabs').hidden = entries.size < 2;
    byId('count').textContent = `${entries.size} 台已连接`;
    const direct =
      liveReady && [...entries.values()].some((e) => e.state.manual_input === 'stream');
    const gestureEdges =
      direct && [...entries.values()].some((e) => e.state.manual_input_inset > 0);
    byId('preview-note').textContent =
      `${mode === 'grid' ? '各设备独立刷新 · ' : ''}${direct ? `原生触控 · ${gestureEdges ? '边缘滑动松手执行' : '拖动即时跟随'}` : '点击操作 · 松手后执行拖动'} · 悬停显示工具`;
    for (const e of entries.values()) {
      e.card.hidden = mode === 'focus' && activeId !== e.id;
      e.card.dataset.active = String(e.id === activeId);
      e.tab.setAttribute('aria-pressed', String(e.id === activeId));
    }
    updateView();
  }
  function blank(e, title, detail) {
    e.poster.hidden = true;
    e.canvas.hidden = true;
    e.poster.removeAttribute('src');
    stopDecoder(e);
    if (e.objectUrl) {
      URL.revokeObjectURL(e.objectUrl);
      e.objectUrl = undefined;
    }
    e.observation = undefined;
    e.card.querySelector('.placeholder strong').textContent = title;
    e.card.querySelector('.placeholder small').textContent = detail;
  }
  function controls(e) {
    const paused = Boolean(e.state.paused || e.pausing),
      busy = e.busy || e.state.busy;
    const key = [
      initialized,
      paused,
      busy,
      e.error,
      e.actionError,
      e.live,
      e.state.display?.posture,
    ].join('|');
    if (e.controlsKey === key) return;
    e.controlsKey = key;
    const status = paused ? 'paused' : e.error || e.actionError ? 'error' : busy ? 'busy' : 'ready';
    e.pill.dataset.status = status;
    e.pill.textContent = paused
      ? '已暂停'
      : e.error
        ? '连接异常'
        : e.actionError
          ? '操作待确认'
          : busy
            ? '操作中'
            : !e.live
              ? '预览已停止'
              : '已连接';
    e.stage.dataset.busy = String(busy);
    const caps = e.state.device.capabilities;
    for (const button of e.card.querySelectorAll('[data-control]')) {
      const name = button.dataset.control;
      button.disabled =
        !initialized ||
        e.busy ||
        ((paused || e.state.busy) && !['pause', 'close', 'live'].includes(name));
      if (name === 'back' || name === 'home') button.disabled ||= !caps.keys.includes(name);
      if (name === 'pause') {
        button.textContent = paused ? '继续设备' : '暂停设备';
        button.setAttribute('aria-pressed', String(paused));
      }
      if (name === 'live') {
        button.textContent = e.live ? '停止预览' : '连续预览';
        button.setAttribute('aria-pressed', String(e.live));
      }
    }
    e.tab.querySelector('.dot').classList.toggle('paused', paused);
    for (const button of e.card.querySelectorAll('[data-posture]')) {
      button.disabled = !initialized || busy || paused;
      button.setAttribute(
        'aria-pressed',
        String(e.state.display?.posture === button.dataset.posture),
      );
    }
    e.card.querySelector('.card-error').textContent = e.actionError || e.error || '';
    e.card.querySelector('.card-error').hidden = !e.error && !e.actionError;
  }
  function applyState(e, state) {
    if ((state.revision ?? 0) < (e.state.revision ?? 0)) return;
    if (state.paused && !e.state.paused) {
      e.generation++;
      e.pointer = undefined;
      cancelDirectPointer(e);
    }
    const resumed = e.state.paused && !state.paused;
    e.state = state;
    if (state.paused) blank(e, '设备已暂停', '画面与操作已暂停，可在设备上手动接管。');
    if (resumed) {
      e.nextFrame = 0;
      e.error = '';
    }
    const display = state.display;
    const geometryKey = display && `${displayKey(display)}:${display.width}:${display.height}`;
    if (display && e.geometryKey !== geometryKey) {
      e.geometryKey = geometryKey;
      e.card.querySelector('.dimensions').textContent =
        `${display.width} × ${display.height} · ${postureNames[display.posture] || '直板 / 姿态未知'}${display.rotation ? ` · ${display.rotation}°` : ''}`;
      e.card.style.setProperty('--aspect', String(display.width / display.height));
      e.shell.dataset.landscape = String(display.width > display.height);
      e.shell.dataset.folded = String(display.posture !== 'expanded');
      appearance(e, display);
    }
    const activity = state.activity;
    if (activity && e.activityKey !== `${activity.id}:${activity.status}`) {
      e.activityKey = `${activity.id}:${activity.status}`;
      const label = {
        running: '执行中',
        applied: '已执行',
        failed: '失败',
        uncertain: '结果待确认',
      }[activity.status];
      e.card.querySelector('.activity').textContent =
        `${actionNames[activity.kind] ?? activity.kind} · ${label} · ${new Date(activity.at).toLocaleTimeString()}`;
      if (
        activity.id !== e.activityId &&
        activity.point &&
        Date.now() - Date.parse(activity.at) < 4000
      )
        showGesture(e, activity);
      e.activityId = activity.id;
    }
    controls(e);
  }
  function deviceLabel(device) {
    const generic = /^(?:emulator|sdk_gphone\w*|Android SDK built for .*)$/i.test(device.name);
    return generic
      ? `${platformNames[device.platform]} ${device.id.split(':').at(-1)}`
      : device.name;
  }
  function skinLayout(e) {
    const skin = e.skin;
    if (skin?.kind !== 'native') return;
    e.card.style.setProperty('--aspect', String(skin.width / skin.height));
    for (const [name, value] of Object.entries({
      sx: skin.screen.x / skin.width,
      sy: skin.screen.y / skin.height,
      sw: skin.screen.width / skin.width,
      sh: skin.screen.height / skin.height,
    }))
      e.shell.style.setProperty(`--${name}`, `${value * 100}%`);
  }
  function appearance(e, display) {
    const key = `${e.state.device.model}:${display.inputWidth}:${display.inputHeight}:${display.rotation}:${display.posture}`;
    if (key === e.skinKey) {
      skinLayout(e);
      return;
    }
    e.skinKey = key;
    e.skin = undefined;
    e.shell.dataset.appearance = 'plain';
    for (const screen of [e.poster, e.canvas]) screen.style.removeProperty('mask-image');
    e.card.querySelector('.skin-source').textContent = '精简边框 · 正在查找型号素材';
    void tool('phone_appearance', { panel_id: panelId, session_id: e.id })
      .then((result) => {
        if (e.disposed || e.skinKey !== key) return;
        const skin = result._meta?.appearance;
        e.skin = skin;
        e.card.querySelector('.skin-source').textContent =
          skin?.kind === 'native' ? skin.source : `精简边框 · ${skin?.reason ?? '无匹配素材'}`;
        if (skin?.kind !== 'native') return;
        e.shell.dataset.appearance = 'native';
        e.card.querySelector('.native-frame').src = skin.image;
        const overlay = e.card.querySelector('.native-overlay');
        if (skin.overlay) {
          overlay.src = skin.overlay;
          overlay.hidden = false;
        } else {
          overlay.hidden = true;
          overlay.removeAttribute('src');
        }
        if (skin.mask)
          for (const screen of [e.poster, e.canvas]) screen.style.maskImage = `url("${skin.mask}")`;
        skinLayout(e);
      })
      .catch(() => {
        if (!e.disposed)
          e.card.querySelector('.skin-source').textContent = '精简边框 · 型号素材不可用';
      });
  }
  function contentRect(e) {
    const r = e.image.getBoundingClientRect(),
      d = e.observation?.display;
    if (!d || !r.width || !r.height) return;
    const scale = Math.min(r.width / d.width, r.height / d.height);
    const width = d.width * scale,
      height = d.height * scale;
    return {
      left: r.left + (r.width - width) / 2,
      top: r.top + (r.height - height) / 2,
      width,
      height,
    };
  }
  function point(e, event, rect) {
    const r = rect ?? contentRect(e);
    if (!r) return;
    const p = { x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height };
    if (![p.x, p.y].every((n) => n >= 0 && n <= 1)) return;
    return p;
  }
  function showGesture(e, activity) {
    const r = contentRect(e);
    if (!r || !activity.point || e.image.hidden) return;
    const stage = e.stage.getBoundingClientRect(),
      dot = document.createElement('i');
    dot.className = 'gesture';
    dot.style.left = `${r.left - stage.left + activity.point.x * r.width}px`;
    dot.style.top = `${r.top - stage.top + activity.point.y * r.height}px`;
    e.stage.append(dot);
    if (
      typeof dot.animate === 'function' &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      const dx = activity.to ? (activity.to.x - activity.point.x) * r.width : 0;
      const dy = activity.to ? (activity.to.y - activity.point.y) * r.height : 0;
      dot.animate(
        [
          { opacity: 1, transform: 'translate(0,0) scale(.8)' },
          { opacity: 0, transform: `translate(${dx}px,${dy}px) scale(1.5)` },
        ],
        { duration: 850, fill: 'forwards' },
      );
    }
    setTimeout(() => dot.remove(), 900);
  }
  function applyFrame(e, result) {
    const data = result.structuredContent;
    if (data?.session) applyState(e, data.session);
    const observation = data?.observation;
    if (!observation || data.session_id !== e.id || e.state.paused || e.pausing) return;
    if (e.observation && Date.parse(observation.capturedAt) < Date.parse(e.observation.capturedAt))
      return;
    const frame = result._meta?.frame ?? result.content?.find((item) => item.type === 'image');
    if (!frame && e.observation?.id === observation.id) {
      e.error = '';
      controls(e);
      return;
    }
    if (
      !frame ||
      !['image/png', 'image/jpeg', 'video/h264'].includes(frame.mimeType) ||
      (!frame.native && typeof frame.data !== 'string' && typeof frame.url !== 'string')
    )
      return;
    e.poster.hidden = Boolean(frame.native);
    e.canvas.hidden = !frame.native;
    e.image = frame.native ? e.canvas : e.poster;
    if (!frame.native && e.observation?.id !== observation.id)
      e.image.src = frame.url ?? `data:${frame.mimeType};base64,${frame.data}`;
    e.image.hidden = false;
    e.observation = observation;
    e.state.display = observation.display;
    if (e.directPointer && displayKey(e.directPointer.display) !== displayKey(observation.display))
      cancelDirectPointer(e);
    e.previewMime = frame.mimeType;
    if (
      e.pointer &&
      (displayKey(e.pointer.display) !== displayKey(observation.display) ||
        e.pointer.activity !== e.state.activity?.id)
    )
      e.pointer = undefined;
    const now = performance.now();
    e.frameStats ??= { at: now, count: 0, fps: 0 };
    e.frameStats.count++;
    if (now - e.frameStats.at > 1000) {
      e.frameStats.fps = (e.frameStats.count * 1000) / (now - e.frameStats.at);
      e.frameStats.count = 0;
      e.frameStats.at = now;
    }
    e.error = '';
    if (now >= (e.nextDetails ?? 0)) {
      e.nextDetails = now + 500;
      previewDetails(e);
    }
    controls(e);
    return true;
  }
  function displayKey(display) {
    return (
      display &&
      [display.id, display.inputWidth, display.inputHeight, display.rotation, display.posture].join(
        ':',
      )
    );
  }
  function previewDetails(e) {
    const observation = e.observation;
    if (!observation) return;
    const transport =
      {
        snapshots: '截图预览',
        'wda-mjpeg': 'WDA 连续画面',
        scrcpy: e.previewMime === 'video/h264' ? 'H.264 原生视频' : 'scrcpy 连续画面',
        'harmony-native': '鸿蒙原生连续画面',
        'harmony-uitest': '鸿蒙系统连续采集',
        'android-emulator': 'Android 模拟器原生视频',
        'ios-simulator': 'iOS 模拟器原生视频',
      }[observation.preview_transport] ?? '截图预览';
    e.card.querySelector('.updated').textContent =
      `${new Date(observation.capturedAt).toLocaleTimeString()} · ${transport}${liveReady ? ' · 直连' : ''}`;
    const reason = nativeVideo ? e.videoFailure : 'unavailable';
    const reasons = {
      unavailable: '当前宿主没有视频解码能力，使用 JPEG',
      unsupported: '当前宿主不支持该视频编码，使用 JPEG',
      'decode-error': '视频解码失败，使用 JPEG',
      timeout: '视频解码超时，使用 JPEG',
    };
    e.card.querySelector('.video-status').textContent = !liveReady
      ? `MCP 图片轮询 · ${connectionReasons[connectionReason]}`
      : reason
        ? reasons[reason]
        : e.previewMime === 'video/h264'
          ? '视频直解'
          : 'JPEG 连续画面';
    e.card.querySelector('[data-control="retry-video"]').hidden =
      !liveReady || !nativeVideo || !reason;
    const t = e.actionTiming;
    const touch = e.pointerTiming;
    e.card.querySelector('.input-performance').textContent = [
      t ? `操作耗时：排队 ${t.queue} ms · 校验 ${t.prepare} ms · 执行 ${t.execute} ms` : '',
      touch ? `触控往返：按下 ${touch.down ?? '—'} ms · 移动 ${touch.move ?? '—'} ms` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    e.card.querySelector('.performance').textContent =
      `${(e.frameStats?.fps ?? 0).toFixed(1)} 帧/秒 · 画面 ${e.image.naturalWidth || e.canvas.width || observation.display.width} × ${e.image.naturalHeight || e.canvas.height || observation.display.height}${e.actionMs ? ` · 操作 ${e.actionMs} ms` : ''}`;
  }
  function makeEntry(state) {
    const id = state.session_id,
      card = document.createElement('article'),
      tab = document.createElement('button');
    card.className = 'card';
    card.tabIndex = 0;
    card.dataset.sessionId = id;
    card.dataset.deviceId = state.device.id;
    card.innerHTML = `<div class="card-head"><div class="device-title"><button class="name" title="聚焦这台设备"></button><span class="platform"></span></div><div class="row"><span class="pill"></span><details class="more"><summary aria-label="设备详情" title="设备详情">${icons.more}</summary><div class="detail-menu"><div class="device-id"></div><div class="geometry"><span class="dimensions">等待画面</span><span class="updated">—</span><span class="performance">—</span><span class="video-status">等待视频通道</span><span class="input-performance"></span></div><button data-control="retry-video" hidden>重试视频直解</button><button data-control="live" aria-pressed="true">停止预览</button><button data-control="pause">暂停设备</button><button data-control="close">断开设备</button><div class="fold"><button data-posture="folded">折叠</button><button data-posture="half-folded">半折叠</button><button data-posture="expanded">展开</button></div><span class="skin-source">精简边框</span><span class="activity">尚无操作</span></div></details></div></div>
      <div class="stage"><div class="device-shell" data-appearance="plain"><img class="native-frame" alt="" aria-hidden="true" /><img class="screen" hidden draggable="false" /><canvas class="screen" hidden></canvas><img class="native-overlay" alt="" aria-hidden="true" /><div class="placeholder"><div class="outline" aria-hidden="true"></div><strong>正在读取画面</strong><small>首次采集可能需要几秒。</small></div></div><div class="controls">${[
        ['back', '返回'],
        ['home', '主屏幕'],
        ['refresh', '刷新'],
        ['screenshot', '截图并保存'],
      ]
        .map(
          ([name, label]) =>
            `<button data-control="${name}" aria-label="${label}" title="${label}">${icons[name]}</button>`,
        )
        .join('')}</div></div>
      <div class="card-error" role="status" hidden></div>`;
    card.querySelector('.name').textContent = deviceLabel(state.device);
    card.querySelector('.platform').textContent = platformNames[state.device.platform];
    card.querySelector('.device-id').textContent =
      `${platformNames[state.device.platform]} · ${state.device.id}`;
    card.querySelector('.device-id').title = state.device.id;
    card.querySelector('.fold').hidden = !state.device.capabilities.foldControl;
    tab.className = 'tab';
    tab.innerHTML = '<i class="dot"></i><span></span>';
    tab.querySelector('span').textContent = deviceLabel(state.device);
    tab.title = `${platformNames[state.device.platform]} · ${state.device.id}`;
    const e = {
      id,
      state: { ...state, paused: false },
      card,
      tab,
      image: card.querySelector('.screen'),
      poster: card.querySelector('img.screen'),
      canvas: card.querySelector('canvas.screen'),
      stage: card.querySelector('.stage'),
      shell: card.querySelector('.device-shell'),
      pill: card.querySelector('.pill'),
      live: true,
      busy: false,
      frameRunning: false,
      nextFrame: 0,
      generation: 0,
      failures: 0,
      inView: true,
      disposed: false,
      error: '',
      lastWheel: 0,
    };
    e.image.alt = `${state.device.name} 的当前屏幕`;
    tab.onclick = () => choose(id);
    card.querySelector('.name').onclick = () => choose(id, true);
    card.querySelectorAll('[data-control]').forEach((button) => {
      button.onclick = () => control(e, button.dataset.control);
    });
    card.querySelectorAll('[data-posture]').forEach((button) => {
      button.onclick = () => act(e, { kind: 'fold', posture: button.dataset.posture });
    });
    e.shell.addEventListener('pointerdown', (event) => {
      if (!canAct(e) || event.button !== 0) return;
      const p = point(e, event);
      if (!p) return;
      choose(id);
      const inset = e.state.manual_input_inset ?? 0;
      const display = e.observation.display;
      const inputX = Math.round(p.x * (display.inputWidth - 1));
      const inputY = Math.round(p.y * (display.inputHeight - 1));
      const streamStart =
        Math.min(
          inputX,
          inputY,
          display.inputWidth - 1 - inputX,
          display.inputHeight - 1 - inputY,
        ) >= inset;
      if (liveReady && e.state.manual_input === 'stream' && streamStart) {
        e.directPointer = {
          ...p,
          observation_id: e.observation.id,
          display: e.observation.display,
          rect: contentRect(e),
        };
        e.shell.setPointerCapture(event.pointerId);
        void flushPointer(e);
        return;
      }
      e.pointer = {
        ...p,
        observation_id: e.observation.id,
        display: e.observation.display,
        rect: contentRect(e),
        activity: e.state.activity?.id,
        at: Date.now(),
        generation: e.generation,
      };
      e.shell.setPointerCapture(event.pointerId);
      updateView();
    });
    e.shell.addEventListener('pointermove', (event) => {
      if (!e.directPointer || e.directPointer.end) return;
      const p = point(e, event, e.directPointer.rect);
      const previous = e.directPointer.next ?? e.directPointer.last ?? e.directPointer;
      // Hosts can emit a pointermove at the unchanged down position. Native
      // drivers may discard it; it must not count as the first pan sample.
      if (p && (p.x !== previous.x || p.y !== previous.y)) {
        if (!e.directPointer.last) e.directPointer.firstMove ??= p;
        e.directPointer.next = p;
        void flushPointer(e);
      }
    });
    e.shell.addEventListener('pointerup', (event) => {
      if (e.directPointer) {
        const p = point(e, event, e.directPointer.rect);
        e.directPointer.next = p ?? e.directPointer.last;
        e.directPointer.end = p ? 'up' : 'cancel';
        void flushPointer(e);
        return;
      }
      const start = e.pointer;
      e.pointer = undefined;
      updateView();
      if (
        !start ||
        !canAct(e) ||
        start.generation !== e.generation ||
        start.activity !== e.state.activity?.id ||
        displayKey(start.display) !== displayKey(e.observation.display)
      )
        return;
      const end = point(e, event, start.rect);
      if (!end) return;
      const common = {
        x: start.x,
        y: start.y,
        space: 'normalized',
        observation_id: e.observation.id,
      };
      const moved = Math.hypot(start.x - end.x, start.y - end.y) > 0.015;
      void act(
        e,
        moved
          ? {
              kind: 'swipe',
              ...common,
              to_x: end.x,
              to_y: end.y,
              duration_ms: Math.max(100, Math.min(3000, Date.now() - start.at)),
            }
          : { kind: 'tap', ...common },
      );
    });
    e.shell.addEventListener('pointercancel', () => {
      cancelDirectPointer(e);
      e.pointer = undefined;
      updateView();
    });
    e.shell.addEventListener(
      'wheel',
      (event) => {
        if (!canAct(e) || !point(e, event)) return;
        event.preventDefault();
        if (Date.now() - e.lastWheel < 300 || Math.abs(event.deltaY) < 4) return;
        e.lastWheel = Date.now();
        const down = event.deltaY > 0;
        void act(e, {
          kind: 'swipe',
          x: 0.5,
          y: down ? 0.7 : 0.3,
          to_x: 0.5,
          to_y: down ? 0.3 : 0.7,
          space: 'normalized',
          duration_ms: 300,
          observation_id: e.observation.id,
        });
      },
      { passive: false },
    );
    entries.set(id, e);
    byId('workspace').append(card);
    byId('tabs').append(tab);
    intersection?.observe(card);
    applyState(e, state);
    return e;
  }
  function remove(e) {
    cancelDirectPointer(e);
    e.disposed = true;
    e.generation++;
    stopDecoder(e);
    e.pointer = undefined;
    intersection?.unobserve(e.card);
    e.image.removeAttribute('src');
    if (e.objectUrl) URL.revokeObjectURL(e.objectUrl);
    e.card.remove();
    e.tab.remove();
    entries.delete(e.id);
  }
  const intersection =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (changes) => {
            for (const change of changes) {
              const e = entries.get(change.target.dataset.sessionId);
              if (e) {
                e.inView = change.isIntersecting;
                if (!e.inView) cancelDirectPointer(e);
              }
            }
          },
          { rootMargin: '100px' },
        );
  function applyPanel(panel) {
    if (!panel?.panel_id || !Array.isArray(panel.sessions)) return;
    if (panelId && panelId !== panel.panel_id) for (const e of [...entries.values()]) remove(e);
    if (panelId !== panel.panel_id) {
      liveSocket?.close();
      liveReady = false;
      selectionRevision = 0;
      nextLive = 0;
      nextRtc = 0;
    }
    panelId = panel.panel_id;
    const ids = new Set(panel.sessions.map((s) => s.session_id));
    for (const e of [...entries.values()]) if (!ids.has(e.id)) remove(e);
    for (const state of panel.sessions) {
      const e = entries.get(state.session_id);
      if (e) applyState(e, state);
      else makeEntry(state);
    }
    if (!layoutChosen) mode = entries.size > 1 ? 'grid' : 'focus';
    if (panel.selection && panel.selection.revision > selectionRevision) {
      selectionRevision = panel.selection.revision;
      if (entries.has(panel.selection.session_id)) choose(panel.selection.session_id, true);
    }
    if (panel.devices) {
      devices = panel.devices;
      diagnostics = panel.diagnostics ?? [];
    }
    byId('add').disabled = byId('empty-add').disabled = !initialized;
    layout();
    if (!byId('picker').hidden) renderPicker();
  }
  function consume(result) {
    const data = result?.structuredContent;
    if (data?.panel) applyPanel(data.panel);
    if (data?.selected_session_id && entries.has(data.selected_session_id))
      choose(data.selected_session_id, true);
    if (data?.session_id && entries.has(data.session_id))
      applyFrame(entries.get(data.session_id), result);
  }
  function renderPicker() {
    const list = byId('device-list');
    const signature = JSON.stringify([
      devices,
      [...connecting],
      [...entries.values()].map((e) => [e.state.device.id, e.id]),
      diagnostics,
    ]);
    if (signature === pickerSignature) return;
    pickerSignature = signature;
    list.replaceChildren();
    for (const device of devices) {
      const item = document.createElement('div'),
        label = document.createElement('div'),
        name = document.createElement('strong'),
        detail = document.createElement('small'),
        button = document.createElement('button');
      item.className = 'device-option';
      item.dataset.deviceId = device.id;
      name.textContent = deviceLabel(device);
      detail.textContent = `${platformNames[device.platform]} · ${device.id}`;
      label.append(name, detail);
      const session = [...entries.values()].find((e) => e.state.device.id === device.id);
      button.textContent = session ? '查看' : connecting.has(device.id) ? '连接中…' : '连接';
      button.disabled = connecting.has(device.id);
      button.onclick = async () => {
        if (session) {
          choose(session.id, true);
          byId('picker').hidden = true;
          return;
        }
        button.disabled = true;
        button.textContent = '连接中…';
        connecting.add(device.id);
        message();
        try {
          const result = await tool('phone_panel_action', {
            panel_id: panelId,
            command: { kind: 'open', device_id: device.id },
          });
          await sync(true);
          const id = result.structuredContent?.session_id;
          if (id) choose(id);
          byId('picker').hidden = true;
        } catch (error) {
          message(error.message);
          button.disabled = false;
          button.textContent = '重试连接';
        } finally {
          connecting.delete(device.id);
          if (!byId('picker').hidden) renderPicker();
        }
      };
      item.append(label, button);
      list.append(item);
    }
    byId('diagnostics').textContent = diagnostics.length
      ? diagnostics.map((d) => `${platformNames[d.platform]}：${d.error.message}`).join(' · ')
      : devices.length
        ? '每台设备单独连接。同一对话中的已有会话会自动复用。'
        : '没有发现设备。请启动模拟器，或连接手机并确认调试授权，然后重新发现。';
  }
  async function sync(discover = false) {
    if (!panelId || !initialized || disposed) return;
    // A status poll can overtake slow device discovery. Keep session state
    // ordered, but do not discard newly discovered devices with that snapshot.
    const sequence = ++syncSequence;
    let result;
    try {
      result = await tool('phone_panel', {
        panel_id: panelId,
        discover,
        preview_client: connectionReport(),
      });
    } catch (error) {
      if (error.code !== 'PANEL_CLOSED') throw error;
      result = await tool('phone_panel', { discover: true });
    }
    if (disposed) return;
    const discovered = result.structuredContent?.panel;
    if (
      discovered?.panel_id === panelId &&
      Array.isArray(discovered.devices) &&
      sequence >= appliedDiscovery
    ) {
      appliedDiscovery = sequence;
      devices = discovered.devices;
      diagnostics = discovered.diagnostics ?? [];
      if (!byId('picker').hidden) renderPicker();
    }
    if (sequence < appliedSync) return;
    appliedSync = sequence;
    consume(result);
  }
  let syncSequence = 0,
    appliedSync = 0,
    appliedDiscovery = 0;
  function canAct(e) {
    return (
      initialized &&
      !e.disposed &&
      !e.busy &&
      !e.directPointer &&
      !e.state.busy &&
      !e.state.paused &&
      !e.error &&
      !e.pausing &&
      e.observation &&
      e.observation.input_ready !== false &&
      !e.image.hidden
    );
  }
  async function run(e, command) {
    if (e.busy || e.disposed || !initialized) return;
    e.busy = true;
    if (command.kind === 'act') e.generation++;
    updateView();
    e.error = '';
    e.actionError = '';
    controls(e);
    const started = performance.now();
    try {
      const result =
        command.kind === 'act' && liveReady
          ? await liveAction(e, command.action)
          : await tool('phone_panel_action', { panel_id: panelId, command });
      appliedSync = ++syncSequence;
      if (e.disposed) return;
      if (command.kind === 'act') {
        e.actionMs = Math.round(performance.now() - started);
        e.actionTiming = result.structuredContent?.timing_ms;
      }
      if (result.structuredContent?.session) applyState(e, result.structuredContent.session);
      return result;
    } catch (error) {
      if (!e.disposed)
        e.actionError = `${error.message}${error.uncertain ? ' 操作可能已生效，请观察后再决定下一步。' : ''}`;
      if (error.code === 'SESSION_CLOSED') void sync().catch(() => {});
    } finally {
      e.busy = false;
      controls(e);
      updateView();
    }
  }
  async function act(e, action) {
    if ((action.kind === 'tap' || action.kind === 'swipe') && action.space === 'normalized')
      showGesture(e, {
        point: { x: action.x, y: action.y },
        ...(action.kind === 'swipe' ? { to: { x: action.to_x, y: action.to_y } } : {}),
      });
    const result = await run(e, { kind: 'act', session_id: e.id, action });
    if (result) {
      e.observation = undefined;
      if (!liveReady) await refreshFrame(e, true);
    }
    // Failed or uncertain actions are never replayed. A fresh frame is safe.
    else e.nextFrame = 0;
  }
  async function control(e, name) {
    if (name === 'retry-video') {
      e.videoFailure = undefined;
      stopDecoder(e);
      updateView();
      previewDetails(e);
      return;
    }
    if (name === 'screenshot') {
      const result = await run(e, { kind: 'screenshot', session_id: e.id, wait_for: 'stable' });
      const frame = result?._meta?.frame;
      const observation = result?.structuredContent?.observation;
      if (!frame || !observation) return;
      const src = `data:${frame.mimeType};base64,${frame.data}`;
      byId('capture-image').src = src;
      byId('save-capture').href = src;
      byId('save-capture').download =
        `phone-use-${e.state.device.platform}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      const stability = observation.stability;
      byId('capture-note').textContent =
        `${e.state.device.name} · ${new Date(observation.capturedAt).toLocaleTimeString()} · 原始分辨率 ${observation.display.width} × ${observation.display.height}。${stability?.status === 'stable' ? '画面连续稳定。' : '等待结束，画面可能仍在变化。'}点击保存原图后由浏览器下载；插件不会自动存盘。`;
      if (!byId('capture-dialog').open) byId('capture-dialog').showModal();
      return;
    }
    if (name === 'live') {
      cancelDirectPointer(e);
      e.live = !e.live;
      e.nextFrame = 0;
      controls(e);
      updateView();
      return;
    }
    if (name === 'refresh') {
      await refreshFrame(e, true);
      return;
    }
    if (name === 'home' || name === 'back') {
      await act(e, { kind: 'key', key: name });
      return;
    }
    if (name === 'pause') {
      const paused = !e.state.paused;
      if (paused) {
        e.pausing = true;
        e.generation++;
        e.pointer = undefined;
        blank(e, '设备暂停中', '正在停止画面与操作。');
      }
      await run(e, { kind: 'pause', session_id: e.id, paused });
      e.pausing = false;
      e.nextFrame = 0;
      controls(e);
      if (!e.state.paused) await refreshFrame(e, true);
    }
    if (name === 'close') {
      e.generation++;
      const result = await run(e, { kind: 'close', session_id: e.id });
      if (result) {
        remove(e);
        layout();
        context();
      }
    }
  }
  async function refreshFrame(e, force = false) {
    if (
      !panelId ||
      e.disposed ||
      e.frameRunning ||
      e.busy ||
      e.state.paused ||
      e.pausing ||
      (!force && (!e.live || !e.inView || e.card.hidden)) ||
      !visible() ||
      (liveReady && !force)
    )
      return;
    e.frameRunning = true;
    frameCount++;
    const generation = e.generation,
      started = Date.now();
    try {
      const result = await tool('phone_frame', {
        panel_id: panelId,
        session_id: e.id,
        ...(e.observation ? { after_id: e.observation.id } : {}),
      });
      if (!e.disposed && generation === e.generation && !e.pausing) {
        applyFrame(e, result);
        e.failures = 0;
      }
    } catch (error) {
      if (e.disposed || generation !== e.generation) return;
      e.failures++;
      if (error.code === 'SESSION_PAUSED') {
        applyState(e, { ...e.state, paused: true });
      } else if (error.code === 'SESSION_CLOSED') {
        remove(e);
        layout();
      } else {
        e.error = error.message;
        controls(e);
      }
    } finally {
      e.frameRunning = false;
      frameCount--;
      e.nextFrame = e.failures
        ? Date.now() + Math.min(8000, 1000 * 2 ** e.failures)
        : Math.max(Date.now(), started + (mode === 'grid' ? 180 : 100));
    }
  }
  function tick() {
    clearTimeout(tickTimer);
    if (!visible()) return;
    if (initialized && panelId) {
      void connectLive();
      if (liveReady && Date.now() >= nextHeartbeat) updateView();
      if (!liveReady && !statusRunning && Date.now() >= nextStatus) {
        statusRunning = true;
        void sync()
          .catch((error) => message(error.message))
          .finally(() => {
            statusRunning = false;
            nextStatus = Date.now() + 1200;
          });
      }
      for (const e of [...entries.values()].sort((a, b) => a.nextFrame - b.nextFrame)) {
        if (frameCount >= 2) break;
        if (Date.now() >= e.nextFrame) void refreshFrame(e);
      }
    }
    tickTimer = setTimeout(tick, 80);
  }
  function hostContext(context) {
    if (!context) return;
    if (context.phoneUseHost?.kind === 'dsh') {
      hostCarrier = context.phoneUseHost;
      document.documentElement.dataset.host = 'dsh';
    }
    if (typeof context.visible === 'boolean') {
      hostVisible = context.visible;
      if (!hostVisible) {
        for (const e of entries.values()) cancelDirectPointer(e);
        liveSocket?.close();
      } else nextLive = 0;
    }
    if (context.phoneUseIntent?.id && context.phoneUseIntent.id !== hostIntent) {
      hostIntent = context.phoneUseIntent.id;
      if (context.phoneUseIntent.command === 'connect') void showPicker();
      if (context.phoneUseIntent.command === 'grid') {
        mode = 'grid';
        layoutChosen = true;
        layout();
      }
    }
    if (['light', 'dark'].includes(context.theme))
      document.documentElement.dataset.theme = context.theme;
    for (const [key, value] of Object.entries(context.styles?.variables ?? {}))
      if (key.startsWith('--') && typeof value === 'string')
        document.documentElement.style.setProperty(key, value);
    if (context.displayMode || context.availableDisplayModes)
      byId('expand').hidden =
        context.displayMode === 'fullscreen' ||
        !context.availableDisplayModes?.includes('fullscreen');
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || (origin !== '*' && event.origin !== origin)) return;
    const m = event.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (!m.method && m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message));
      else {
        if (origin === '*') origin = event.origin;
        p.resolve(m.result);
      }
    } else if (m.method === 'ui/notifications/tool-result') consume(m.params);
    else if (m.method === 'ui/notifications/host-context-changed') {
      hostContext(m.params);
      tick();
    } else if (m.method === 'ping' && m.id !== undefined)
      window.parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, origin);
    else if (m.method === 'ui/resource-teardown' && m.id !== undefined) {
      disposed = true;
      clearTimeout(reportTimer);
      liveSocket?.close();
      clearTimeout(tickTimer);
      for (const e of [...entries.values()]) remove(e);
      window.parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, origin);
    }
  });
  for (const value of ['focus', 'grid'])
    byId(`${value}-mode`).onclick = () => {
      mode = value;
      layoutChosen = true;
      layout();
    };
  async function showPicker() {
    byId('picker').hidden = false;
    renderPicker();
    try {
      await sync(true);
    } catch (error) {
      message(error.message);
    }
  }
  byId('add').onclick = byId('empty-add').onclick = showPicker;
  const connectionMenu = document.querySelector('.connection');
  const closeConnectionMenu = () => {
    connectionMenu.open = false;
  };
  // Connection diagnostics open only through their summary. Dismiss before a
  // device gesture without consuming that gesture or changing the connection.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!connectionMenu.contains(event.target)) closeConnectionMenu();
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !connectionMenu.open) return;
    const restoreFocus = connectionMenu.contains(document.activeElement);
    closeConnectionMenu();
    if (restoreFocus) byId('connection-status').focus({ preventScroll: true });
    event.preventDefault();
  });
  connectionMenu.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !connectionMenu.contains(event.relatedTarget)) closeConnectionMenu();
  });
  window.addEventListener('blur', closeConnectionMenu);
  byId('retry-connection').onclick = () => {
    nextLive = 0;
    nextRtc = 0;
    void connectLive();
  };
  byId('close-capture').onclick = () => byId('capture-dialog').close();
  byId('capture-dialog').addEventListener('close', () => {
    byId('capture-image').removeAttribute('src');
    byId('save-capture').removeAttribute('href');
  });
  byId('dismiss-picker').onclick = () => {
    byId('picker').hidden = true;
  };
  byId('discover').onclick = async () => {
    byId('discover').disabled = true;
    try {
      await sync(true);
    } catch (error) {
      message(error.message);
    } finally {
      byId('discover').disabled = false;
    }
  };
  byId('expand').onclick = () => {
    void request('ui/request-display-mode', { mode: 'fullscreen' }).catch((error) =>
      message(error.message),
    );
  };
  document.addEventListener('visibilitychange', () => {
    if (!visible()) for (const e of entries.values()) cancelDirectPointer(e);
    updateView();
    tick();
  });
  window.addEventListener('pagehide', () => {
    suspended = true;
    updateView();
    clearTimeout(tickTimer);
  });
  window.addEventListener('pageshow', () => {
    suspended = false;
    tick();
  });
  if (window.parent === window) {
    message('请从支持 MCP Apps 的宿主打开设备控制台。');
    return;
  }
  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'Phone Use', version },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
  })
    .then((result) => {
      initialized = true;
      connectionStatus();
      hostContext(result?.hostContext);
      notify('ui/notifications/initialized');
      byId('add').disabled = byId('empty-add').disabled = !panelId;
      for (const e of entries.values()) controls(e);
      if (typeof ResizeObserver !== 'undefined') {
        let previous = 0;
        new ResizeObserver(() => {
          const height = Math.ceil(document.body.getBoundingClientRect().height);
          if (height !== previous) {
            previous = height;
            notify('ui/notifications/size-changed', { height });
          }
        }).observe(document.body);
      }
      tick();
    })
    .catch((error) => message(error.message));
})();
