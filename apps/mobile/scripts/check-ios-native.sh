#!/bin/sh
# The iPhone app's native code that a Mac can check without Xcode (IOS.md): every file that needs only
# Foundation, CryptoKit, Security, LocalAuthentication and UserNotifications is type-checked against the
# macOS SDK, and the shared code runs its tests (RFC 8291's example, the push store, what a notification
# says). The Capacitor glue (Native/App/InboxNativePlugin.swift, MainViewController.swift) needs Xcode.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../.." && pwd)
native="$here/ios/Native"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

flags=""
# Some Command Line Tools installs define the module SwiftBridging twice; hide the second definition.
inc=/Library/Developer/CommandLineTools/usr/include/swift
if [ -f "$inc/module.modulemap" ] && [ -f "$inc/bridging.modulemap" ] &&
  grep -q 'module SwiftBridging' "$inc/module.modulemap" && grep -q 'module SwiftBridging' "$inc/bridging.modulemap"; then
  : >"$out/empty.modulemap"
  printf '{"version":0,"case-sensitive":"false","roots":[{"type":"file","name":"%s","external-contents":"%s"}]}\n' \
    "$inc/module.modulemap" "$out/empty.modulemap" >"$out/overlay.json"
  flags="-vfsoverlay $out/overlay.json"
fi

# shellcheck disable=SC2086
swiftc $flags -typecheck -parse-as-library \
  "$native"/Shared/*.swift "$native/NotificationService/NotificationService.swift" "$native/App/DeviceKeys.swift"
echo "type-checked: Shared, NotificationService, App/DeviceKeys"
# shellcheck disable=SC2086
swiftc $flags -O -o "$out/ios-native-tests" "$native"/Shared/*.swift "$native/Tests/main.swift"
"$out/ios-native-tests" "$root/packages/spec/vectors/push.json"
