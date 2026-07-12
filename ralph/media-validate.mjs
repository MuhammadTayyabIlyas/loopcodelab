// ralph/media-validate.mjs
// Pure verdict logic for the finished-build media output report (run.mediaReport).
// The orchestrator gathers ffprobe results; this decides per-file pass/fail against
// PLATFORM_SPECS and which requested platforms have no render. Advisory only.
import { PLATFORM_SPECS, checkOutput, platformForFile } from './social-formats.mjs';
export { platformForFile };

export function mediaOutputReport(files, requestedPlatforms) {
  const outputs = []; const warnings = []; const seen = new Set();
  for (const { file, probe } of Array.isArray(files) ? files : []) {
    const platform = platformForFile(file);
    if (!platform) { warnings.push(`${file} does not match a platform render name (*-<platform>.mp4)`); continue; }
    // Unlike compose's self-verify (which waives "no audio" for silent boards), the
    // user-facing report flags it unconditionally: a social video without audio is
    // worth a ⚠ even when the storyboard chose silence. Advisory either way.
    const issues = checkOutput(probe, PLATFORM_SPECS[platform]);
    outputs.push({ file, platform, ok: issues.length === 0, issues });
    seen.add(platform);
  }
  const missing = (Array.isArray(requestedPlatforms) ? requestedPlatforms : []).filter((p) => !seen.has(p));
  return { ok: missing.length === 0 && outputs.every((o) => o.ok), outputs, missing, warnings };
}
