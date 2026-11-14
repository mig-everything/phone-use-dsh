import { display } from '@kit.ArkUI';
import { util } from '@kit.ArkTS';
import { pasteboard } from '@kit.BasicServicesKit';
import capture from 'libphonecapture.so';

interface CaptureStatus { running: boolean; started: boolean; state: number; error: number; frames: number; }
@Entry
@Component
struct Index {
  @State token: string = util.generateRandomUUID().replace(/-/g, '');
  @State allowLAN: boolean = false;
  @State running: boolean = false;
  @State busy: boolean = false;
  @State status: string = '准备连接';
  @State frames: number = 0;
  private timer: number = -1;
  private captureWidth: number = 0;
  private captureHeight: number = 0;
  aboutToAppear(): void {
    this.timer = setInterval(() => {
      const state = JSON.parse(capture.status()) as CaptureStatus;
      this.running = state.running; this.frames = state.frames;
      if (state.error === -105) this.status = '设备未返回视频画面，电脑端将使用截图预览';
      else if (state.error !== 0) this.status = `采集失败，错误码 ${state.error}`;
      else if (state.started && state.running) this.status = state.frames > 0 ? '投屏中，可返回桌面操作其他应用' : '屏幕共享已授权，等待电脑连接';
      else if (state.running) this.status = '请在系统弹窗中确认屏幕共享';
      else if (state.state >= 1 && state.state <= 4) this.status = '屏幕共享已取消或停止';
      else if (this.frames > 0) this.status = '连接已结束，投屏已停止';
      // Rebuild the encoder explicitly after rotation or folding; stale video must not be used for touch.
      if (state.started && state.running) {
        const screen = display.getDefaultDisplaySync();
        if (screen.width !== this.captureWidth || screen.height !== this.captureHeight) {
          capture.stop(); this.status = '屏幕尺寸已改变，请重新开始投屏';
        }
      }
    }, 1000);
  }
  aboutToDisappear(): void { if (this.timer >= 0) clearInterval(this.timer); }
  async toggleCapture(): Promise<void> {
    this.busy = true;
    try {
      if (this.running) { await capture.stop(); this.status = '已停止'; }
      else {
        const screen = display.getDefaultDisplaySync();
        this.captureWidth = screen.width; this.captureHeight = screen.height;
        const scale = Math.min(1, 2560 / Math.max(this.captureWidth, this.captureHeight));
        const code = await capture.start(Math.floor(this.captureWidth * scale / 2) * 2, Math.floor(this.captureHeight * scale / 2) * 2, 27183, this.token, this.allowLAN);
        this.status = code === 0 ? '等待系统授权' : `无法开始，错误码 ${code}`;
      }
    } finally { this.busy = false; }
  }
  build() {
    Column({ space: 18 }) {
      Text('Phone Use').fontSize(30).fontWeight(FontWeight.Medium).fontColor('#24252B');
      Text('屏幕共享').fontSize(16).fontColor('#85868E');
      Text(this.status).fontSize(14).textAlign(TextAlign.Center).width('90%');
      Button(this.running ? '停止投屏' : '开始投屏').enabled(!this.busy).onClick(() => this.toggleCapture()).backgroundColor('#24252B');
      Text('连接码').fontSize(12).fontColor('#85868E');
      Text(this.token).fontSize(12).fontFamily('monospace').copyOption(CopyOptions.LocalDevice).textAlign(TextAlign.Center).width('90%');
      Button('复制连接码').type(ButtonType.Normal).onClick(() => pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.token)));
      Row({ space: 10 }) { Toggle({ type: ToggleType.Switch, isOn: this.allowLAN }).enabled(!this.running && !this.busy).onChange(value => { this.allowLAN = value; }); Text('允许局域网连接').fontSize(13); }
      Text('默认通过 USB 调试转发连接。局域网模式需要电脑与手机处于同一可信网络，并使用连接码。').fontSize(12).fontColor('#85868E').lineHeight(20).textAlign(TextAlign.Center).width('86%');
      Text(`端口 27183 · 已采集 ${this.frames} 帧`).fontSize(11).fontColor('#85868E');
      Text('只共享屏幕，不采集麦克风或系统声音。连接结束后自动停止；你也可以随时通过系统录屏提示结束共享。').fontSize(12).fontColor('#85868E').lineHeight(20).textAlign(TextAlign.Center).width('86%');
    }.width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor('#F7F7F8');
  }
}
