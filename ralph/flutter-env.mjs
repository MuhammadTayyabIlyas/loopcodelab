// Pure helper: the build environment a flutter-app worker/finalize session needs.
// No I/O — unit-tested. The Flutter + Android SDKs are shared (read-only) at /opt;
// per-build write caches (PUB_CACHE, GRADLE_USER_HOME) live under the runner's $HOME
// so sandboxed tenants don't clash. `home` is kept as the literal shell token `$HOME`
// by default so it resolves to the tenant's home at exec time (the session runs AS the
// tenant in multitenant, as tmuxweb in single-tenant) — never resolve it server-side.
export const FLUTTER_BUILD_FORMAT = 'flutter-app';
export const DEFAULT_FLUTTER_ROOT = '/opt/flutter';
export const DEFAULT_ANDROID_HOME = '/opt/android-sdk';

export function isFlutterRun(run) {
  return !!run && run.outputFormat === FLUTTER_BUILD_FORMAT;
}

// Returns shell `KEY=value` assignment tokens to prepend to a build command.
export function flutterEnvAssignments({
  home = '$HOME',
  flutterRoot = DEFAULT_FLUTTER_ROOT,
  androidHome = DEFAULT_ANDROID_HOME,
} = {}) {
  return [
    `FLUTTER_ROOT=${flutterRoot}`,
    `FLUTTER_HOME=${flutterRoot}`,
    `ANDROID_HOME=${androidHome}`,
    `ANDROID_SDK_ROOT=${androidHome}`,
    `PUB_CACHE=${home}/.pub-cache`,
    `GRADLE_USER_HOME=${home}/.gradle`,
    // $PATH expands at exec time; prepend the SDK bins so `flutter`/`adb`/`sdkmanager` resolve.
    // $HOME/.pub-cache/bin is where `dart pub global activate flutterfire_cli` puts `flutterfire`.
    `PATH=${flutterRoot}/bin:${androidHome}/cmdline-tools/latest/bin:${androidHome}/platform-tools:${home}/.pub-cache/bin:$PATH`,
  ];
}

// Whether there's enough free disk to attempt a (heavy, multi-GB) Flutter build.
export function diskOkForBuild(freeBytes, minGiB = 3) {
  const n = Number(freeBytes);
  return Number.isFinite(n) && n >= minGiB * 1024 * 1024 * 1024;
}
