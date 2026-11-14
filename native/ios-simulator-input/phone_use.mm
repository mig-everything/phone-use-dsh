// SPDX-License-Identifier: MIT
// DTUHID wire format and CoreSimulator signatures: Meta idb v1.7.8.
// See LICENSE.Meta and README.md. No Apple framework is redistributed.
#import <Foundation/Foundation.h>
#import <xpc/xpc.h>
#include <dlfcn.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <poll.h>
#include <memory>
#include <string>
#include <thread>
#include <unistd.h>

@interface NSObject (PhoneUseSimulator)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)path error:(NSError **)error;
- (id)deviceSetWithPath:(NSString *)path error:(NSError **)error;
- (NSArray *)availableDevices;
- (NSUUID *)UDID;
- (NSString *)stateString;
- (id)deviceType;
- (CGSize)mainScreenSize;
- (float)mainScreenScale;
- (unsigned int)lookup:(NSString *)service error:(NSError **)error;
@end

using Clock = std::chrono::steady_clock;
static volatile sig_atomic_t stopping = 0;
static void stop(int) { stopping = 1; }
static void output(NSDictionary *data) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:data options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}
static bool number(id value, double min, double max) {
  return [value isKindOfClass:NSNumber.class] &&
    CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
    std::isfinite([value doubleValue]) && [value doubleValue] >= min && [value doubleValue] <= max;
}
static xpc_object_t envelope(const char *type, xpc_object_t payload, bool barrier = false) {
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "messageType", type);
  xpc_dictionary_set_bool(message, "isBarrier", barrier);
  xpc_dictionary_set_string(message, "featureIdentifier", "com.apple.coredevice.feature.remote.hid.digitizer");
  xpc_dictionary_set_value(message, "payload", payload);
  return message;
}

class Channel {
 public:
  xpc_connection_t connection = nil;
  dispatch_queue_t queue = dispatch_queue_create("phone-use.dtuhid", DISPATCH_QUEUE_SERIAL);
  std::shared_ptr<std::atomic_bool> failed = std::make_shared<std::atomic_bool>(false);
  bool pressed = false;
  double x = 0, y = 0;
  uint64_t edge = 0;
  Clock::time_point lastInput = Clock::now();

  bool connect(id device) {
    using Endpoint = xpc_object_t (*)(mach_port_t, uint64_t, uint64_t);
    using Connect = xpc_connection_t (*)(xpc_object_t);
    using Enable = void (*)(xpc_connection_t);
    auto endpoint = (Endpoint)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
    auto create = (Connect)dlsym(RTLD_DEFAULT, "xpc_connection_create_from_endpoint");
    auto enable = (Enable)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
    if (!endpoint || !create || !enable) return false;
    NSError *error = nil;
    mach_port_t port = [device lookup:@"com.apple.coredevice.feature.remote.hid.digitizer" error:&error];
    if (!port) return false;
    connection = create(endpoint(port, 0, 0));
    if (!connection) return false;
    enable(connection);
    xpc_connection_set_target_queue(connection, queue);
    auto failure = failed;
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
      if (xpc_get_type(event) == XPC_TYPE_ERROR) failure->store(true);
    });
    xpc_connection_resume(connection);
    // Usage zero is a liveness barrier, not a keypress. A port alone does not
    // prove that the runtime's daemon can receive input.
    auto payload = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(payload, "usageCode", 0);
    xpc_dictionary_set_uint64(payload, "state", 2);
    auto ready = dispatch_semaphore_create(0);
    __block BOOL alive = NO;
    xpc_connection_send_message_with_reply(connection, envelope("IndigoKeyboardButtonEvent", payload, true), queue, ^(xpc_object_t reply) {
      alive = xpc_get_type(reply) != XPC_TYPE_ERROR;
      dispatch_semaphore_signal(ready);
    });
    if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC)) || !alive) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    return !failed->load();
  }
  bool send(uint64_t phase, double px, double py) {
    if (failed->load()) return false;
    x = px; y = py;
    auto point = xpc_dictionary_create(NULL, NULL, 0);
    auto payload = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_double(point, "x", x);
    xpc_dictionary_set_double(point, "y", y);
    xpc_dictionary_set_value(payload, "pointOne", point);
    xpc_dictionary_set_uint64(payload, "eventType", phase);
    xpc_dictionary_set_uint64(payload, "edge", edge);
    xpc_dictionary_set_uint64(payload, "target", 0);
    pressed = phase != 2;
    lastInput = Clock::now();
    xpc_connection_send_message(connection, envelope("IndigoDigitizerEvent", payload));
    auto sent = dispatch_semaphore_create(0);
    xpc_connection_send_barrier(connection, ^{ dispatch_semaphore_signal(sent); });
    // This acknowledges submission to XPC, not a rendered screen or app effect.
    return !dispatch_semaphore_wait(sent, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) && !failed->load();
  }
  bool release() { return !pressed || send(2, x, y); }
  ~Channel() {
    if (!connection) return;
    release();
    // Keep the connection alive long enough for its final release to be read.
    std::this_thread::sleep_for(std::chrono::milliseconds(80));
    xpc_connection_cancel(connection);
    // The handler owns its shared failure flag even if cancellation arrives later.
    dispatch_sync(queue, ^{});
  }
};

static int run(int argc, const char **argv) {
  if (argc == 2 && std::string(argv[1]) == "--self-test") {
    auto point = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(point, "edge", 3);
    auto message = envelope("IndigoDigitizerEvent", point);
    if (xpc_dictionary_get_bool(message, "isBarrier") || xpc_dictionary_get_uint64(xpc_dictionary_get_value(message, "payload"), "edge") != 3) return 2;
    output(@{@"protocol":@1, @"self_test":@YES});
    return 0;
  }
  if (argc != 4) return 2;
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator", RTLD_NOW)) return 3;
  NSError *error = nil;
  Class contextClass = NSClassFromString(@"SimServiceContext");
  if (![contextClass respondsToSelector:@selector(sharedServiceContextForDeveloperDir:error:)]) return 3;
  id context = [contextClass sharedServiceContextForDeveloperDir:@(argv[1]) error:&error];
  id set = [context deviceSetWithPath:@(argv[2]) error:&error];
  id device = nil;
  for (id candidate in [set availableDevices])
    if ([[[candidate UDID] UUIDString] caseInsensitiveCompare:@(argv[3])] == NSOrderedSame) device = candidate;
  if (!device || [[device stateString] caseInsensitiveCompare:@"Booted"] != NSOrderedSame) return 4;
  id type = [device deviceType];
  if (![type respondsToSelector:@selector(mainScreenSize)] || ![type respondsToSelector:@selector(mainScreenScale)]) return 4;
  CGSize size = [type mainScreenSize];
  double scale = [type mainScreenScale];
  if (!(scale > 0 && size.width > 0 && size.height > 0)) return 4;
  Channel channel;
  if (!channel.connect(device)) return 5;
  output(@{@"protocol":@1, @"ready":@YES, @"udid":[[device UDID] UUIDString],
    @"width":@(size.width / scale), @"height":@(size.height / scale), @"backend":@"dtuhid"});
  std::string buffer;
  uint64_t lastID = 0;
  while (!stopping && !channel.failed->load()) {
    if (channel.pressed && Clock::now() - channel.lastInput > std::chrono::seconds(5)) {
      channel.release();
      output(@{@"error":@"POINTER_EXPIRED", @"uncertain":@YES});
      return 6;
    }
    pollfd input{STDIN_FILENO, POLLIN, 0};
    int polled = poll(&input, 1, 500);
    if (polled < 0) { if (errno == EINTR) continue; break; }
    if (!polled) continue;
    char bytes[4096];
    ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
    if (count <= 0) break; // Parent exit closes stdin and releases any finger.
    buffer.append(bytes, (size_t)count);
    if (buffer.size() > 8192) return 7;
    size_t end;
    while ((end = buffer.find('\n')) != std::string::npos) { @autoreleasepool {
      NSData *data = [NSData dataWithBytes:buffer.data() length:end];
      id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
      buffer.erase(0, end + 1);
      if (![parsed isKindOfClass:NSDictionary.class]) return 7;
      NSDictionary *request = parsed;
      if (!number(request[@"id"], 1, 9007199254740991.0)) return 7;
      uint64_t sequence = [request[@"id"] unsignedLongLongValue];
      NSString *phase = request[@"phase"];
      bool cancel = [phase isEqual:@"cancel"];
      bool valid = [request[@"id"] doubleValue] == sequence && sequence > lastID && [phase isKindOfClass:NSString.class] &&
        (cancel || (number(request[@"x"], 0, 1) && number(request[@"y"], 0, 1)));
      if ([phase isEqual:@"down"] || [phase isEqual:@"swipe"])
        valid = valid && number(request[@"edge"], 0, 4) && [request[@"edge"] doubleValue] == [request[@"edge"] unsignedLongLongValue];
      if ([phase isEqual:@"swipe"])
        valid = valid && number(request[@"toX"], 0, 1) && number(request[@"toY"], 0, 1) && number(request[@"durationMs"], 100, 3000);
      bool begin = [phase isEqual:@"down"] || [phase isEqual:@"tap"] || [phase isEqual:@"swipe"];
      valid = valid && (cancel || (begin ? !channel.pressed : channel.pressed));
      valid = valid && (begin || cancel || [phase isEqual:@"move"] || [phase isEqual:@"up"]);
      if (!valid) {
        output(@{@"id":@(sequence), @"error":@"INVALID_INPUT", @"uncertain":@NO});
        continue;
      }
      lastID = sequence;
      double x = [request[@"x"] doubleValue], y = [request[@"y"] doubleValue];
      bool sent;
      if (cancel) sent = channel.release();
      else if (begin) {
        channel.edge = [phase isEqual:@"tap"] ? 0 : [request[@"edge"] unsignedLongLongValue];
        sent = channel.send(0, x, y);
        if (sent && [phase isEqual:@"tap"]) {
          std::this_thread::sleep_for(std::chrono::milliseconds(25));
          sent = channel.send(2, x, y);
        } else if (sent && [phase isEqual:@"swipe"]) {
          int duration = [request[@"durationMs"] intValue];
          int steps = (duration + 15) / 16;
          auto start = Clock::now();
          double toX = [request[@"toX"] doubleValue], toY = [request[@"toY"] doubleValue];
          for (int step = 1; sent && step <= steps && !stopping; step++) {
            std::this_thread::sleep_until(start + std::chrono::milliseconds(duration * step / steps));
            sent = channel.send(1, x + (toX - x) * step / steps, y + (toY - y) * step / steps);
          }
          sent = channel.release() && sent && !stopping;
        }
      } else sent = channel.send([phase isEqual:@"up"] ? 2 : 1, x, y);
      if (!sent) {
        output(@{@"id":@(sequence), @"error":@"INPUT_UNCERTAIN", @"uncertain":@YES});
        return 8;
      }
      output(@{@"id":@(sequence), @"submitted":@YES});
    }}
  }
  return channel.failed->load() ? 8 : 0;
}
int main(int argc, const char **argv) { @autoreleasepool {
  signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN);
  @try { return run(argc, argv); }
  @catch (NSException *exception) { output(@{@"error":@"NATIVE_FAILURE", @"uncertain":@YES}); return 9; }
}}
