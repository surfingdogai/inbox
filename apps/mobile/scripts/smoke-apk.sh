#!/bin/sh
# The test APK on a running emulator (CI, workflow android): installed, opened, and still running a
# few seconds later. The emulator's software graphics now and then take a WebView down on a cold
# start, so a failed launch is tried once more; one that fails twice, crash or not, fails the run,
# with the app's crash and log lines shown.
set -u
apk="$1"
adb uninstall ai.surfingdog.inbox >/dev/null 2>&1 || true
adb install -r "$apk" || exit 1
for try in 1 2; do
  adb logcat -c
  adb shell am start -W -n ai.surfingdog.inbox/.MainActivity || exit 1
  sleep 12
  if adb shell pidof ai.surfingdog.inbox >/dev/null; then
    if adb logcat -d -b crash | grep -q "Process: ai.surfingdog.inbox"; then
      adb logcat -d -b crash
      exit 1
    fi
    echo "the test APK opened and is running (try $try)"
    exit 0
  fi
  echo "the test APK is not running after try $try:"
  adb logcat -d -b crash
  adb logcat -d | grep -iE "surfingdog|chromium|AndroidRuntime|lowmemorykiller|ActivityManager: (Process|Killing)" | tail -80
done
exit 1
