import { parseSemver } from '../../src/config/updates.js';

/**
 * Keep Capacitor's generated Xcode project in lockstep with the release
 * manifests. The generated project is gitignored, so this must run after
 * every `cap add ios` rather than relying on a committed project file.
 */
export function updateIosProjectVersion(project, version) {
  const parsed = parseSemver(version);
  const buildNumber = parsed.major * 1000000 + parsed.minor * 1000 + parsed.patch;
  const projectVersionPattern = /CURRENT_PROJECT_VERSION = [^;]+;/g;
  const marketingVersionPattern = /MARKETING_VERSION = [^;]+;/g;

  if (!projectVersionPattern.test(project)) {
    throw new Error('generated Xcode project has no CURRENT_PROJECT_VERSION setting');
  }
  projectVersionPattern.lastIndex = 0;
  if (!marketingVersionPattern.test(project)) {
    throw new Error('generated Xcode project has no MARKETING_VERSION setting');
  }
  marketingVersionPattern.lastIndex = 0;

  return {
    buildNumber,
    project: project
      .replace(projectVersionPattern, `CURRENT_PROJECT_VERSION = ${buildNumber};`)
      .replace(marketingVersionPattern, `MARKETING_VERSION = ${version};`)
  };
}
