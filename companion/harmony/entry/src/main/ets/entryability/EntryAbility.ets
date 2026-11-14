import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import capture from 'libphonecapture.so';

export default class EntryAbility extends UIAbility {
  onWindowStageCreate(stage: window.WindowStage): void {
    stage.loadContent('pages/Index');
  }
  onDestroy(): void { capture.stop(); }
}
