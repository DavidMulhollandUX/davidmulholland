import type { ExtensionRequest, ExtensionResponse } from "@/lib/protocol";
import { ALARM_NAME, isBuilding, recoverAfterRestart, scheduleAutoRebuild, startBuild, stopBuild } from "@/lib/build";

export default defineBackground(() => {
  const ready = recoverAfterRestart();

  chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse: (r: ExtensionResponse) => void) => {
    ready
      .then(async () => {
        switch (request.type) {
          case "build":
            await startBuild("manual");
            break;
          case "resume":
            await startBuild("resume");
            break;
          case "cancel":
            await stopBuild();
            break;
          case "settings-updated":
            await scheduleAutoRebuild();
            break;
        }
        sendResponse({ ok: true });
      })
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void ready.then(() => {
      if (!isBuilding()) return startBuild("scheduled");
    });
  });

  chrome.runtime.onInstalled.addListener(() => void ready.then(scheduleAutoRebuild));
});
