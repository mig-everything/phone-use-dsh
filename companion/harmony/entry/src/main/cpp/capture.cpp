#include <algorithm>
#include <arpa/inet.h>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <multimedia/player_framework/native_avbuffer.h>
#include <multimedia/player_framework/native_avcodec_videoencoder.h>
#include <multimedia/player_framework/native_avformat.h>
#include <multimedia/player_framework/native_avscreen_capture.h>
#include <mutex>
#include <napi/native_api.h>
#include <native_buffer/native_buffer.h>
#include <native_window/external_window.h>
#include <poll.h>
#include <string>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
using Bytes = std::vector<uint8_t>;
using Clock = std::chrono::steady_clock;
// Network sends never run on the codec callback. Overflow disconnects the
// reader, so a new reader starts with codec configuration and an IDR, not
// damaged P frames.
class Capture {
public:
  std::atomic<bool> running{false}, started{false};
  std::atomic<int> state{-1}, error{0}, frames{0}, buffers{0};
  std::mutex commands;
  ~Capture() { stop(); }
  int start(int width, int height, int port, const std::string &token,
            bool lan) {
    stop();
    state = -1;
    error = 0;
    frames = 0;
    buffers = 0;
    started = false;
    token_ = token;
    server_ = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (server_ < 0)
      return fail(-100);
    int reuse = 1;
    setsockopt(server_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = htonl(lan ? INADDR_ANY : INADDR_LOOPBACK);
    if (bind(server_, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) ||
        listen(server_, 4))
      return fail(-101);
    encoder_ = OH_VideoEncoder_CreateByMime(OH_AVCODEC_MIMETYPE_VIDEO_AVC);
    raw_ = encoder_ == nullptr;
    width_ = width;
    height_ = height;
    int result = 0;
    if (encoder_) {
      OH_AVCodecCallback callback{};
      callback.onError = [](OH_AVCodec *, int32_t code, void *self) {
        auto *s = static_cast<Capture *>(self);
        s->error = code;
        s->running = false;
      };
      callback.onStreamChanged = [](OH_AVCodec *, OH_AVFormat *, void *) {};
      callback.onNeedInputBuffer = [](OH_AVCodec *, uint32_t, OH_AVBuffer *,
                                      void *) {};
      callback.onNewOutputBuffer = [](OH_AVCodec *codec, uint32_t index,
                                      OH_AVBuffer *buffer, void *self) {
        auto *s = static_cast<Capture *>(self);
        OH_AVCodecBufferAttr attr{};
        auto *data = OH_AVBuffer_GetAddr(buffer);
        const auto capacity = OH_AVBuffer_GetCapacity(buffer);
        if (OH_AVBuffer_GetBufferAttr(buffer, &attr) == AV_ERR_OK && data &&
            attr.offset >= 0 && attr.size > 0 && attr.size <= 2 * 1024 * 1024 &&
            static_cast<int64_t>(attr.offset) + attr.size <= capacity) {
          s->output(data + attr.offset, attr.size, attr.flags, attr.pts);
        }
        OH_VideoEncoder_FreeOutputBuffer(codec, index);
      };
      result = OH_VideoEncoder_RegisterCallback(encoder_, callback, this);
      if (result)
        return fail(result);
      OH_AVFormat *format = OH_AVFormat_Create();
      OH_AVFormat_SetIntValue(format, OH_MD_KEY_WIDTH, width);
      OH_AVFormat_SetIntValue(format, OH_MD_KEY_HEIGHT, height);
      OH_AVFormat_SetIntValue(format, OH_MD_KEY_PIXEL_FORMAT,
                              AV_PIXEL_FORMAT_RGBA);
      OH_AVFormat_SetLongValue(format, OH_MD_KEY_BITRATE, 12000000);
      OH_AVFormat_SetDoubleValue(format, OH_MD_KEY_FRAME_RATE, 30);
      OH_AVFormat_SetIntValue(format, OH_MD_KEY_I_FRAME_INTERVAL, 1000);
      result = OH_VideoEncoder_Configure(encoder_, format);
      OH_AVFormat_Destroy(format);
      if (result)
        return fail(result);
      if ((result = OH_VideoEncoder_GetSurface(encoder_, &window_)))
        return fail(result);
      if ((result = OH_VideoEncoder_Prepare(encoder_)))
        return fail(result);
      if ((result = OH_VideoEncoder_Start(encoder_)))
        return fail(result);
    }
    capture_ = OH_AVScreenCapture_Create();
    if (!capture_)
      return fail(-103);
    OH_AVScreenCapture_SetErrorCallback(
        capture_,
        [](OH_AVScreenCapture *, int32_t code, void *self) {
          auto *s = static_cast<Capture *>(self);
          s->error = code;
          s->running = false;
        },
        this);
    OH_AVScreenCapture_SetStateCallback(
        capture_,
        [](OH_AVScreenCapture *, OH_AVScreenCaptureStateCode code, void *self) {
          auto *s = static_cast<Capture *>(self);
          s->state = code;
          if (code == OH_SCREEN_CAPTURE_STATE_STARTED && s->running)
            s->started = true;
          if ((code >= OH_SCREEN_CAPTURE_STATE_CANCELED &&
               code <= OH_SCREEN_CAPTURE_STATE_STOPPED_BY_CALL) ||
              code == OH_SCREEN_CAPTURE_STATE_STOPPED_BY_USER_SWITCHES) {
            s->started = false;
            s->running = false;
          }
        },
        this);
    OH_AVScreenCaptureConfig config{};
    config.captureMode = OH_CAPTURE_HOME_SCREEN;
    config.dataType = OH_ORIGINAL_STREAM;
    config.videoInfo.videoCapInfo.videoFrameWidth = width;
    config.videoInfo.videoCapInfo.videoFrameHeight = height;
    config.videoInfo.videoCapInfo.videoSource = OH_VIDEO_SOURCE_SURFACE_RGBA;
    config.videoInfo.videoEncInfo.videoCodec = OH_H264;
    config.videoInfo.videoEncInfo.videoBitrate = 12000000;
    config.videoInfo.videoEncInfo.videoFrameRate = 30;
    // Video only: no microphone or system audio is collected or transmitted.
    if ((result = OH_AVScreenCapture_Init(capture_, config)))
      return fail(result);
    OH_AVScreenCapture_SetMicrophoneEnabled(capture_, false);
    OH_AVScreenCapture_SetCanvasRotation(capture_, true);
    if (raw_) {
      result = OH_AVScreenCapture_SetDataCallback(
          capture_,
          [](OH_AVScreenCapture *, OH_AVBuffer *buffer,
             OH_AVScreenCaptureBufferType type, int64_t, void *self) {
            if (type == OH_SCREEN_CAPTURE_BUFFERTYPE_VIDEO)
              static_cast<Capture *>(self)->rawOutput(buffer);
          },
          this);
      if (result)
        return fail(result);
    }
    running = true;
    result = raw_ ? OH_AVScreenCapture_StartScreenCapture(capture_)
                  : OH_AVScreenCapture_StartScreenCaptureWithSurface(capture_,
                                                                     window_);
    if (result)
      return fail(result);
    // Consent is asynchronous. Only the system's STARTED callback permits
    // streaming.
    thread_ = std::thread([this] {
      serve();
      cleanup();
    });
    return 0;
  }
  void stop() {
    running = false;
    changed_.notify_all();
    if (thread_.joinable())
      thread_.join();
    else
      cleanup();
  }

private:
  OH_AVCodec *encoder_ = nullptr;
  OH_AVScreenCapture *capture_ = nullptr;
  OHNativeWindow *window_ = nullptr;
  int server_ = -1;
  std::thread thread_;
  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<Bytes> queue_;
  Bytes config_;
  size_t queued_ = 0;
  bool reader_ = false, waitIdr_ = true, overflow_ = false;
  std::string token_;
  bool raw_ = false;
  bool framed_ = false;
  int width_ = 0, height_ = 0;
  Clock::time_point lastRaw_{};
  int fail(int code) {
    error = code;
    running = false;
    cleanup();
    return code;
  }
  void cleanup() {
    started = false;
    if (capture_) {
      OH_AVScreenCapture_StopScreenCapture(capture_);
      OH_AVScreenCapture_Release(capture_);
      capture_ = nullptr;
    }
    if (encoder_) {
      OH_VideoEncoder_Stop(encoder_);
      OH_VideoEncoder_Destroy(encoder_);
      encoder_ = nullptr;
    }
    if (window_) {
      OH_NativeWindow_DestroyNativeWindow(window_);
      window_ = nullptr;
    }
    if (server_ >= 0) {
      close(server_);
      server_ = -1;
    }
    started = false;
    std::lock_guard<std::mutex> lock(mutex_);
    queue_.clear();
    config_.clear();
    queued_ = 0;
    reader_ = false;
  }
  Bytes packet(const uint8_t *data, size_t size, uint64_t pts, bool config, bool key) {
    if (!framed_) return Bytes(data, data + size);
    Bytes bytes(12 + size);
    uint64_t header = pts & ((uint64_t{1} << 61) - 1);
    if (config) header |= uint64_t{1} << 62;
    if (key) header |= uint64_t{1} << 61;
    for (int i = 0; i < 8; i++) bytes[i] = header >> (56 - 8 * i);
    uint32_t length = htonl(static_cast<uint32_t>(size));
    std::memcpy(bytes.data() + 8, &length, 4);
    std::memcpy(bytes.data() + 12, data, size);
    return bytes;
  }
  void output(const uint8_t *data, size_t size, uint32_t flags, int64_t pts) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (flags & AVCODEC_BUFFER_FLAGS_CODEC_DATA) {
      if (size < 65536)
        config_.assign(data, data + size);
      return;
    }
    frames++;
    if (!reader_ || !running || overflow_)
      return;
    if (waitIdr_) {
      if (!(flags & AVCODEC_BUFFER_FLAGS_SYNC_FRAME))
        return;
      if (!config_.empty()) {
        queue_.push_back(packet(config_.data(), config_.size(), 0, true, false));
        queued_ += queue_.back().size();
      }
      waitIdr_ = false;
    }
    if (queued_ + size + 12 > 2 * 1024 * 1024) {
      overflow_ = true;
      changed_.notify_all();
      return;
    }
    queue_.push_back(packet(data, size, static_cast<uint64_t>(std::max<int64_t>(0, pts)), false, flags & AVCODEC_BUFFER_FLAGS_SYNC_FRAME));
    queued_ += queue_.back().size();
    changed_.notify_all();
  }
  void rawOutput(OH_AVBuffer *buffer) {
    buffers++;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running || !reader_ ||
        Clock::now() - lastRaw_ < std::chrono::milliseconds(100))
      return;
    OH_NativeBuffer *native = OH_AVBuffer_GetNativeBuffer(buffer);
    if (!native)
      return;
    OH_NativeBuffer_Config info{};
    OH_NativeBuffer_GetConfig(native, &info);
    auto *data = OH_AVBuffer_GetAddr(buffer);
    // The configured source is RGBA. Never infer a different stride or format.
    if (data && info.width == width_ && info.height == height_ &&
        info.stride >= width_ * 4 &&
        info.format == NATIVEBUFFER_PIXEL_FMT_RGBA_8888) {
      Bytes frame(static_cast<size_t>(width_) * height_ * 4);
      for (int y = 0; y < height_; y++)
        std::memcpy(frame.data() + static_cast<size_t>(y) * width_ * 4,
                    data + static_cast<size_t>(y) * info.stride, width_ * 4);
      // Raw frames are independent: keep only the newest complete frame behind
      // the sender.
      queue_.clear();
      queued_ = frame.size();
      queue_.push_back(std::move(frame));
      frames++;
      lastRaw_ = Clock::now();
      changed_.notify_all();
    } else {
      error = -104;
      running = false;
    }
    OH_NativeBuffer_Unreference(native);
  }
  bool sendAll(int fd, const uint8_t *data, size_t size) {
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    size_t at = 0;
    while (at < size && running && Clock::now() < deadline) {
      pollfd poller{fd, POLLOUT, 0};
      if (poll(&poller, 1, 100) <= 0)
        continue;
      if (poller.revents & (POLLHUP | POLLERR | POLLNVAL))
        return false;
      auto n = send(fd, data + at, size - at, MSG_NOSIGNAL | MSG_DONTWAIT);
      if (n < 0 && (errno == EAGAIN || errno == EINTR))
        continue;
      if (n <= 0)
        return false;
      at += n;
    }
    return at == size;
  }
  void reply(int fd, const std::string &value) {
    sendAll(fd, reinterpret_cast<const uint8_t *>(value.data()), value.size());
  }
  bool authorize(const std::string &request) {
    std::string folded = request;
    std::transform(folded.begin(), folded.end(), folded.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    const std::string prefix = "\r\nauthorization: bearer ";
    auto at = folded.find(prefix);
    if (at == std::string::npos)
      return false;
    at += prefix.size();
    auto end = request.find("\r\n", at);
    if (end == std::string::npos || end - at != token_.size())
      return false;
    unsigned difference = 0;
    for (size_t i = 0; i < token_.size(); i++)
      difference |= static_cast<unsigned>(request[at + i] ^ token_[i]);
    return difference == 0;
  }
  bool client(int fd) {
    std::string request;
    auto deadline = Clock::now() + std::chrono::seconds(2);
    while (running && request.size() < 4096 && Clock::now() < deadline) {
      pollfd p{fd, POLLIN, 0};
      if (poll(&p, 1, 100) <= 0)
        continue;
      char buffer[1024];
      const auto n = recv(fd, buffer, sizeof(buffer), MSG_DONTWAIT);
      if (n <= 0)
        return false;
      request.append(buffer, n);
      if (request.find("\r\n\r\n") != std::string::npos)
        break;
    }
    if (!authorize(request)) {
      reply(fd, "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: "
                "close\r\n\r\n");
      return false;
    }
    if (request.rfind("GET /status ", 0) == 0) {
      std::string body =
          "{\"started\":" + std::string(started ? "true" : "false") +
          ",\"frames\":" + std::to_string(frames) +
          ",\"state\":" + std::to_string(state) +
          ",\"error\":" + std::to_string(error) + "}";
      reply(fd,
            "HTTP/1.1 200 OK\r\nContent-Type: "
            "application/json\r\nCache-Control: no-store\r\nContent-Length: " +
                std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" +
                body);
      return false;
    }
    const bool framed = request.rfind("GET /stream-framed ", 0) == 0;
    if ((request.rfind("GET /stream ", 0) != 0 && !framed) || !started || (framed && raw_)) {
      reply(fd, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: "
                "0\r\nConnection: close\r\n\r\n");
      return false;
    }
    const std::string content =
        raw_ ? "application/x-phone-use-rgba\r\nX-Frame-Width: " +
                   std::to_string(width_) +
                   "\r\nX-Frame-Height: " + std::to_string(height_)
             : framed ? "application/x-phone-use-h264" : "video/h264";
    reply(fd, "HTTP/1.1 200 OK\r\nContent-Type: " + content +
                  "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
    if (framed) {
      const uint8_t header[16] = {'h', '2', '6', '4', 0x80, 0, 0, 0,
        static_cast<uint8_t>(width_ >> 24), static_cast<uint8_t>(width_ >> 16), static_cast<uint8_t>(width_ >> 8), static_cast<uint8_t>(width_),
        static_cast<uint8_t>(height_ >> 24), static_cast<uint8_t>(height_ >> 16), static_cast<uint8_t>(height_ >> 8), static_cast<uint8_t>(height_)};
      if (!sendAll(fd, header, sizeof(header))) return false;
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      queue_.clear();
      queued_ = 0;
      reader_ = true;
      framed_ = framed;
      waitIdr_ = true;
      overflow_ = false;
    }
    if (encoder_) {
      OH_AVFormat *params = OH_AVFormat_Create();
      OH_AVFormat_SetIntValue(params, OH_MD_KEY_REQUEST_I_FRAME, 1);
      OH_VideoEncoder_SetParameter(encoder_, params);
      OH_AVFormat_Destroy(params);
    }
    const auto firstFrameDeadline = Clock::now() + std::chrono::seconds(5);
    while (running) {
      if (frames == 0 && Clock::now() > firstFrameDeadline) {
        error = -105;
        running = false;
        break;
      }
      Bytes bytes;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds(150), [this] {
          return !queue_.empty() || overflow_ || !running;
        });
        if (overflow_)
          break;
        if (!queue_.empty()) {
          bytes = std::move(queue_.front());
          queue_.pop_front();
          queued_ -= bytes.size();
        }
      }
      pollfd p{fd, POLLIN, 0};
      if (poll(&p, 1, 0) > 0)
        break; // peer closed, or invalid request data during a one-way stream
      if (!bytes.empty() && !sendAll(fd, bytes.data(), bytes.size()))
        break;
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      reader_ = false;
      queue_.clear();
      queued_ = 0;
    }
    return true;
  }
  void serve() {
    auto idle = Clock::now();
    bool hadReader = false;
    while (running) {
      // Initial setup has a minute; after a reader leaves, recording stops in
      // 10 seconds.
      if (Clock::now() - idle > std::chrono::seconds(hadReader ? 10 : 60)) {
        running = false;
        break;
      }
      pollfd p{server_, POLLIN, 0};
      if (poll(&p, 1, 100) <= 0)
        continue;
      int fd = accept4(server_, nullptr, nullptr, SOCK_CLOEXEC);
      if (fd < 0)
        continue;
      if (client(fd)) {
        hadReader = true;
        idle = Clock::now();
      }
      close(fd);
    }
  }
};
Capture capture;
struct Job {
  napi_async_work work;
  napi_deferred deferred;
  bool start;
  int width = 0, height = 0, port = 27183, result = 0;
  bool lan = false;
  std::string token;
};
napi_value queue(napi_env env, Job *job) {
  napi_value promise, name;
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "phone-capture", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(
      env, nullptr, name,
      [](napi_env, void *data) {
        auto *j = static_cast<Job *>(data);
        std::lock_guard<std::mutex> lock(capture.commands);
        if (j->start)
          j->result =
              capture.start(j->width, j->height, j->port, j->token, j->lan);
        else
          capture.stop();
      },
      [](napi_env env, napi_status, void *data) {
        auto *j = static_cast<Job *>(data);
        napi_value result;
        napi_create_int32(env, j->result, &result);
        napi_resolve_deferred(env, j->deferred, result);
        napi_delete_async_work(env, j->work);
        delete j;
      },
      job, &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}
napi_value start(napi_env env, napi_callback_info info) {
  napi_value args[5];
  size_t argc = 5;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  auto *job = new Job{};
  job->start = true;
  if (argc != 5) {
    delete job;
    napi_throw_type_error(env, nullptr,
                          "Expected width, height, port, token and allowLAN");
    return nullptr;
  }
  char token[129]{};
  size_t length = 0;
  napi_get_value_int32(env, args[0], &job->width);
  napi_get_value_int32(env, args[1], &job->height);
  napi_get_value_int32(env, args[2], &job->port);
  napi_get_value_string_utf8(env, args[3], token, sizeof(token), &length);
  napi_get_value_bool(env, args[4], &job->lan);
  job->token.assign(token, length);
  if (job->width < 64 || job->height < 64 || job->width > 2560 ||
      job->height > 2560 || job->width % 2 || job->height % 2 ||
      job->port < 1024 || job->port > 65535 || length < 32 || length > 128 ||
      job->token.find_first_not_of("0123456789abcdefABCDEF-") !=
          std::string::npos) {
    delete job;
    napi_throw_range_error(env, nullptr, "Invalid capture configuration");
    return nullptr;
  }
  return queue(env, job);
}
napi_value stop(napi_env env, napi_callback_info) {
  auto *j = new Job{};
  j->start = false;
  return queue(env, j);
}
napi_value status(napi_env env, napi_callback_info) {
  std::string value =
      "{\"running\":" + std::string(capture.running ? "true" : "false") +
      ",\"started\":" + (capture.started ? "true" : "false") +
      ",\"state\":" + std::to_string(capture.state) +
      ",\"error\":" + std::to_string(capture.error) +
      ",\"frames\":" + std::to_string(capture.frames) +
      ",\"buffers\":" + std::to_string(capture.buffers) + "}";
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}
napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"status", nullptr, status, nullptr, nullptr, nullptr, napi_default,
       nullptr}};
  napi_define_properties(env, exports, 3, properties);
  return exports;
}
napi_module module{1, 0, nullptr, init, "phonecapture", nullptr, {nullptr}};
__attribute__((constructor)) void registerModule() {
  napi_module_register(&module);
}
} // namespace
