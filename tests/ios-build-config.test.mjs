import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { updateIosProjectVersion } from '../scripts/lib/ios-project.mjs';

const root = new URL('../', import.meta.url);

async function source(file) {
  return readFile(new URL(file, root), 'utf8');
}

test('iOS builds target the Capacitor 8 Swift Package Manager Xcode project', async () => {
  const [pkgText, ci, release] = await Promise.all([
    source('package.json'),
    source('.github/workflows/ci.yml'),
    source('.github/workflows/release.yml')
  ]);
  const pkg = JSON.parse(pkgText);

  for (const [name, command] of [
    ['package build:ios script', pkg.scripts['build:ios']],
    ['build-only workflow', ci],
    ['release workflow', release]
  ]) {
    assert.match(command, /xcodebuild -project ios\/App\/App\.xcodeproj/, `${name} must build Capacitor 8's generated Xcode project`);
    assert.doesNotMatch(command, /xcodebuild[^\n]*App\.xcworkspace/, `${name} must not build the CocoaPods workspace that Capacitor 8 no longer generates`);
  }
});

test('generated Xcode build settings receive the release version and numeric build number', () => {
  const fixture = `
    CURRENT_PROJECT_VERSION = 1;
    MARKETING_VERSION = 1.0;
    CURRENT_PROJECT_VERSION = 1;
    MARKETING_VERSION = 1.0;
  `;
  const result = updateIosProjectVersion(fixture, '1.2.46');

  assert.equal(result.buildNumber, 1002046);
  assert.equal((result.project.match(/CURRENT_PROJECT_VERSION = 1002046;/g) || []).length, 2);
  assert.equal((result.project.match(/MARKETING_VERSION = 1\.2\.46;/g) || []).length, 2);
  assert.throws(
    () => updateIosProjectVersion('MARKETING_VERSION = 1.0;', '1.2.46'),
    /CURRENT_PROJECT_VERSION/
  );
  assert.throws(
    () => updateIosProjectVersion('CURRENT_PROJECT_VERSION = 1;', '1.2.46'),
    /MARKETING_VERSION/
  );
});
