// Adapted from HMBot's MIT-licensed device bridge (see LICENSE.HMBot).
// The system UiTest C extension owns capture and
// input. No private graphics libraries, Java runtime, SDK JAR or shared agent.so.
#include "extension_c_api.h"
#include <window_manager/oh_display_manager.h>
#include <multimodalinput/oh_input_manager.h>
#include <multimodalinput/oh_key_code.h>
#include <atomic>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <pthread.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>
using namespace OHOS::uitest;

static UiTestPort api;
static LowLevelFunctions low{};
static int listener=-1, peer=-1, inputOwner=-1, captureOwner=-1, width=0, height=0, rotation=-1, foldMode=-1, frameWidth=0, frameHeight=0, epoch=0, px=0, py=0;
static uint64_t displayId=0;
static double scale=1.0;
static bool pressed=false;
static char secret[80]{};
static std::atomic<bool> stopped{false};
static pthread_mutex_t inputLock=PTHREAD_MUTEX_INITIALIZER, outputLock=PTHREAD_MUTEX_INITIALIZER, frameLock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t frameReady=PTHREAD_COND_INITIALIZER;
static uint8_t* latest=nullptr;
static size_t latestSize=0;
static int latestWidth=0,latestHeight=0,latestEpoch=0,latestRotation=0;
static uint64_t latestId=0;
static constexpr size_t MAX_FRAME=8*1024*1024;
static Text text(const char* value){return {value,strlen(value)};}

static bool sendAll(const void* data,size_t size){
 const auto* bytes=static_cast<const uint8_t*>(data);
 while(size&&!stopped){ssize_t n=send(peer,bytes,size,MSG_NOSIGNAL);if(n<0&&errno==EINTR)continue;if(n<=0){stopped=true;return false;}bytes+=n;size-=n;}
 return size==0;
}
static void packet(uint8_t type,const void* bytes,size_t size){
 if(stopped||size>MAX_FRAME)return;
 uint8_t header[5]={type,uint8_t(size>>24),uint8_t(size>>16),uint8_t(size>>8),uint8_t(size)};
 pthread_mutex_lock(&outputLock);if(sendAll(header,sizeof(header)))sendAll(bytes,size);pthread_mutex_unlock(&outputLock);
}
static void message(uint8_t type,const char* value){packet(type,value,strlen(value));}
static void failure(const char* value){message(4,value);stopped=true;}
// Atomic touch does not request UiTest's exclusive accessibility driver.
static bool touch(int stage,int x,int y){
 return low.atomicTouch(stage,x,y)==0;
}
static bool key(int code){
 auto* event=OH_Input_CreateKeyEvent();if(!event)return false;
 OH_Input_SetKeyEventKeyCode(event,code);OH_Input_SetKeyEventAction(event,KEY_ACTION_DOWN);
 int down=OH_Input_InjectKeyEvent(event);OH_Input_SetKeyEventAction(event,KEY_ACTION_UP);
 int up=OH_Input_InjectKeyEvent(event);OH_Input_DestroyKeyEvent(&event);return down==0&&up==0;
}
static void release(){if(pressed){pressed=false;touch(TOUCH_ACTION_UP,px,py);}}
static void yieldInput(){release();if(inputOwner>=0){close(inputOwner);inputOwner=-1;}}
static int claimSocket(const char* name){
 int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);if(fd<0)return -1;
 sockaddr_un address{};address.sun_family=AF_UNIX;strcpy(address.sun_path+1,name);
 if(bind(fd,reinterpret_cast<sockaddr*>(&address),offsetof(sockaddr_un,sun_path)+1+strlen(name))!=0){close(fd);return -1;}return fd;
}
static bool claimInput(){
 if(inputOwner>=0)return true;inputOwner=claimSocket("hmbot_manual_input_v1");return inputOwner>=0;
}
static bool dimensions(int fw,int fh){
 int32_t w=0,h=0;
 if(OH_NativeDisplayManager_GetDefaultDisplayWidth(&w)!=DISPLAY_MANAGER_OK||OH_NativeDisplayManager_GetDefaultDisplayHeight(&h)!=DISPLAY_MANAGER_OK||w<1||h<1||w>16384||h>16384)return false;
 NativeDisplayManager_Rotation r;
 if(OH_NativeDisplayManager_GetDefaultDisplayRotation(&r)!=DISPLAY_MANAGER_OK)return false;
 uint64_t id=0;if(OH_NativeDisplayManager_GetDefaultDisplayId(&id)!=DISPLAY_MANAGER_OK)return false;
 NativeDisplayManager_FoldDisplayMode mode;int m=-1;
 if(OH_NativeDisplayManager_IsFoldable()&&OH_NativeDisplayManager_GetFoldDisplayMode(&mode)==DISPLAY_MANAGER_OK)m=int(mode);
 if(w!=width||h!=height||fw!=frameWidth||fh!=frameHeight||int(r)*90!=rotation||id!=displayId||m!=foldMode){
  release();width=w;height=h;frameWidth=fw;frameHeight=fh;rotation=int(r)*90;displayId=id;foldMode=m;epoch++;
 }
 return true;
}
static bool jpegSize(Text bytes,int& w,int& h){
 const auto* b=reinterpret_cast<const uint8_t*>(bytes.data);size_t len=bytes.size;
 if(len<4||b[0]!=255||b[1]!=216)return false;
 for(size_t i=2;i+8<len;){
  if(b[i++]!=255)continue;int marker=b[i++];if(marker==255){i--;continue;}if(marker==0xda||marker==0xd9)return false;
  if(marker==0||marker==0xd8||(marker>=0xd0&&marker<=0xd7))continue;
  size_t n=(size_t(b[i])<<8)|b[i+1];if(n<2||i+n>len)return false;
  if((marker>=0xc0&&marker<=0xc3)||(marker>=0xc5&&marker<=0xc7)||(marker>=0xc9&&marker<=0xcb)||(marker>=0xcd&&marker<=0xcf)){
   w=(int(b[i+5])<<8)|b[i+6];h=(int(b[i+3])<<8)|b[i+4];return w>0&&h>0&&w<=16384&&h<=16384;
  }i+=n;
 }return false;
}
static void image(Text bytes){
 if(stopped||bytes.size>MAX_FRAME)return;
 int w=0,h=0;if(!jpegSize(bytes,w,h)){failure("设备未返回有效图像");return;}
 pthread_mutex_lock(&inputLock);
 if(!dimensions(w,h)){pthread_mutex_unlock(&inputLock);failure("无法获取设备尺寸");return;}
 int sourceWidth=width,sourceHeight=height,sourceEpoch=epoch,sourceRotation=rotation;uint64_t sourceId=displayId;pthread_mutex_unlock(&inputLock);
 auto* copy=static_cast<uint8_t*>(malloc(bytes.size));if(!copy){failure("设备图像内存不足");return;}memcpy(copy,bytes.data,bytes.size);
 pthread_mutex_lock(&frameLock);free(latest);latest=copy;latestSize=bytes.size;latestWidth=sourceWidth;latestHeight=sourceHeight;latestEpoch=sourceEpoch;latestRotation=sourceRotation;latestId=sourceId;pthread_cond_signal(&frameReady);pthread_mutex_unlock(&frameLock);
}
static void* writeFrames(void*){
 int sentEpoch=0;
 while(!stopped){
  pthread_mutex_lock(&frameLock);
  if(!latest&&!stopped){timespec until{};clock_gettime(CLOCK_REALTIME,&until);until.tv_sec++;pthread_cond_timedwait(&frameReady,&frameLock,&until);}
  auto* data=latest;size_t size=latestSize;int w=latestWidth,h=latestHeight,e=latestEpoch,r=latestRotation;uint64_t id=latestId;latest=nullptr;latestSize=0;pthread_mutex_unlock(&frameLock);
  if(data){
   if(e!=sentEpoch){char meta[200];snprintf(meta,sizeof(meta),"{\"width\":%d,\"height\":%d,\"rotation\":%d,\"id\":\"%llu\",\"epoch\":%d}",w,h,r,(unsigned long long)id,e);message(1,meta);sentEpoch=e;}
   packet(2,data,size);free(data);
  }else if(!stopped)message(3,"{}");
 }return nullptr;
}
static bool readLine(char* out,size_t capacity,int timeout){
 size_t size=0;time_t end=time(nullptr)+timeout;
 while(!stopped&&time(nullptr)<end){pollfd item{peer,POLLIN,0};int ready=poll(&item,1,500);if(ready<0&&errno==EINTR)continue;if(ready<0)return false;if(ready==0)continue;
  char ch;ssize_t n=recv(peer,&ch,1,0);if(n<=0)return false;if(ch=='\n'){out[size]=0;return true;}if(size+1>=capacity||ch=='\r'||ch==0)return false;out[size++]=ch;
 }return false;
}
static bool command(const char* line){
 if(strcmp(line,"stop")==0)return false;
 pthread_mutex_lock(&inputLock);
 if(strncmp(line,"action ",7)==0){
  // One acknowledged operation. No automatic replay after a broken connection.
  int id=0,e=0,x=0,y=0,tx=0,ty=0,duration=0;char kind[20]{},extra;
  int count=sscanf(line,"action %d %d %19s %d %d %d %d %d %c",&id,&e,kind,&x,&y,&tx,&ty,&duration,&extra);
  bool isTap=strcmp(kind,"tap")==0,isSwipe=strcmp(kind,"swipe")==0,isKey=strcmp(kind,"back")==0||strcmp(kind,"home")==0;
  bool pointerDown=strcmp(kind,"pointer_down")==0,pointerMove=strcmp(kind,"pointer_move")==0,pointerUp=strcmp(kind,"pointer_up")==0||strcmp(kind,"pointer_cancel")==0;
  bool pointer=pointerDown||pointerMove||pointerUp;
  bool valid=id>0&&((isKey&&count==3)||((isTap||pointer)&&count==5)||(isSwipe&&count==8&&duration>=100&&duration<=3000));
  const char* status="rejected";const char* reason="invalid_action";
  if(valid&&dimensions(frameWidth,frameHeight)&&e==epoch){
   valid=isKey||(x>=0&&y>=0&&x<width&&y<height&&(!isSwipe||(tx>=0&&ty>=0&&tx<width&&ty<height)));
   if(valid&&claimInput()){
    bool ok=true;
    if(pointer){
     if(pointerDown){release();px=x;py=y;pressed=true;ok=touch(TOUCH_ACTION_DOWN,x,y);}
     else if(pressed){px=x;py=y;ok=touch(pointerMove?TOUCH_ACTION_MOVE:TOUCH_ACTION_UP,x,y);if(pointerUp)pressed=false;}
     else ok=pointerUp;
    }else if(isKey)ok=key(strcmp(kind,"back")==0?KEYCODE_BACK:KEYCODE_HOME);
    else {
     release();px=x;py=y;pressed=true;ok=touch(TOUCH_ACTION_DOWN,x,y);
     if(isSwipe){
      int steps=(duration+15)/16;
      for(int step=1;step<=steps&&ok;step++){
       usleep(duration*1000/steps);px=x+(tx-x)*step/steps;py=y+(ty-y)*step/steps;
       ok=touch(TOUCH_ACTION_MOVE,px,py);
      }
     }else usleep(16000);
     ok=touch(TOUCH_ACTION_UP,px,py)&&ok;pressed=false;
    }
    if(!pointer||pointerUp||!ok)yieldInput();status=ok?"applied":"uncertain";reason=ok?"ok":"input_failed";
   }else reason=valid?"input_busy":"out_of_bounds";
  }else if(valid){yieldInput();reason="display_changed";}
  char ack[160];snprintf(ack,sizeof(ack),"{\"action\":%d,\"status\":\"%s\",\"reason\":\"%s\"}",id,status,reason);message(3,ack);
 }else if(strncmp(line,"claim ",6)==0||strncmp(line,"yield ",6)==0){
  char* end=nullptr;long id=strtol(line+6,&end,10);if(!id||id>2147483647||*end){pthread_mutex_unlock(&inputLock);return false;}
  char ack[96];if(line[0]=='c')snprintf(ack,sizeof(ack),"{\"claim\":%ld,\"granted\":%s}",id,claimInput()?"true":"false");
  else {yieldInput();snprintf(ack,sizeof(ack),"{\"released\":%ld}",id);}message(3,ack);
 }else if(strcmp(line,"release")==0)release();
 else if(strncmp(line,"release ",8)==0){
  char* end=nullptr;long id=strtol(line+8,&end,10);if(!id||id>2147483647||*end){pthread_mutex_unlock(&inputLock);return false;}
  release();char ack[80];snprintf(ack,sizeof(ack),"{\"released\":%ld}",id);message(3,ack);
 }else if(strcmp(line,"key back")==0||strcmp(line,"key home")==0){
  release();if(inputOwner>=0&&!key(strcmp(line,"key back")==0?KEYCODE_BACK:KEYCODE_HOME))failure("设备按键执行失败");
 }else if(strcmp(line,"ping")==0){}
 else {
  char event[8],extra;int x=0,y=0,e=0;
  if(sscanf(line,"touch %7s %d %d %d %c",event,&x,&y,&e,&extra)!=4||x<0||y<0||x>=width||y>=height){pthread_mutex_unlock(&inputLock);return false;}
  int stage=strcmp(event,"down")==0?1:strcmp(event,"move")==0?2:strcmp(event,"up")==0?3:0;
  if(!stage){pthread_mutex_unlock(&inputLock);return false;}
  if(e!=epoch)release();
  else if(inputOwner>=0&&(stage==1||pressed)){if(stage==1)release();px=x;py=y;pressed=stage!=3;if(!touch(stage,x,y))failure("设备触控执行失败");}
 }
 pthread_mutex_unlock(&inputLock);return !stopped;
}
static bool identifier(const char* s){size_t n=strlen(s);return n>=16&&n<70&&strspn(s,"abcdefghijklmnopqrstuvwxyz0123456789_")==n;}
extern "C" __attribute__((visibility("default"))) RetCode UiTestExtension_OnInit(UiTestPort p,size_t argc,char** argv){
 if(argc!=3||!identifier(argv[0])||!identifier(argv[1]))return -1;
 char* end=nullptr;scale=strtod(argv[2],&end);if(*end||scale<0.25||scale>1.0)return -1;
 api=p;low.callThroughMessage=reinterpret_cast<decltype(low.callThroughMessage)>(sizeof(low));
 if(api.initLowLevelFunctions(&low)!=0||!low.callThroughMessage||!low.atomicTouch||!low.startCapture||!low.stopCapture)return -1;
 strcpy(secret,argv[1]);listener=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);if(listener<0)return -1;
 sockaddr_un address{};address.sun_family=AF_UNIX;strcpy(address.sun_path+1,argv[0]);
 if(bind(listener,reinterpret_cast<sockaddr*>(&address),offsetof(sockaddr_un,sun_path)+1+strlen(argv[0]))!=0||listen(listener,1)!=0){close(listener);listener=-1;return -1;}return 0;
}
extern "C" __attribute__((visibility("default"))) RetCode UiTestExtension_OnRun(){
 // A launch that never connects expires without leaving a device daemon.
 pollfd item{listener,POLLIN,0};if(poll(&item,1,15000)<=0){close(listener);return -1;}
 peer=accept4(listener,nullptr,nullptr,SOCK_CLOEXEC);close(listener);listener=-1;if(peer<0)return -1;
 timeval timeout{2,0};setsockopt(peer,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
 char line[160];if(!readLine(line,sizeof(line),3)||strcmp(line,secret)!=0){close(peer);return -1;}
 // Some firmware silently suppresses a second capture. Reject it explicitly
 // before calling the system service; never disrupt an existing view.
 captureOwner=claimSocket("hmbot_capture_v1");
 if(captureOwner<0){failure("此设备的系统采集已被其他窗口占用。");close(peer);return -1;}
 pthread_t writer;bool writing=pthread_create(&writer,nullptr,writeFrames,nullptr)==0;
 char options[64];snprintf(options,sizeof(options),"{\"scale\":%.8f}",scale);
 if(!writing||low.startCapture(text("copyScreen"),image,text(options))!=0)failure("设备图像通道不可用，可使用截图预览");
 // Host sends an idle ping; process also expires if a broken tunnel stays open.
 while(!stopped&&readLine(line,sizeof(line),20)&&command(line)){}
 pthread_mutex_lock(&inputLock);yieldInput();pthread_mutex_unlock(&inputLock);
 stopped=true;low.stopCapture(text("copyScreen"));pthread_cond_signal(&frameReady);if(writing)pthread_join(writer,nullptr);
 shutdown(peer,SHUT_RDWR);close(peer);close(captureOwner);free(latest);latest=nullptr;return 0;
}
