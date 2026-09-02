import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// V3.0 Slice 5 removed the V1<->V2 long-press bridge and the V2 shell, but the
// landscape lock and single Android package identity must survive that cleanup.

test('AndroidManifest uses ${appName} placeholder and retains sensorLandscape', () => {
  const xml = readFileSync(fileURLToPath(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url)), 'utf8');
  assert.match(xml, /android:screenOrientation="sensorLandscape"/, 'expected sensorLandscape on MainActivity');
  assert.match(xml, /<activity[^>]*android:screenOrientation="sensorLandscape"/s);
  assert.match(xml, /<application[^>]*android:label="\$\{appName\}"/s, 'expected ${appName} placeholder on application');
  assert.match(xml, /<activity[^>]*android:label="\$\{appName\}"/s, 'expected ${appName} placeholder on activity');
});

test('build.gradle supports ANDROID_APPLICATION_ID and ANDROID_APP_NAME with production defaults', () => {
  const gradle = readFileSync(fileURLToPath(new URL('../android/app/build.gradle', import.meta.url)), 'utf8');
  assert.match(gradle, /applicationId\s+System\.getenv\("ANDROID_APPLICATION_ID"\)\s*\?:\s*"com\.leyble\.hub"/);
  assert.match(gradle, /appName:\s*System\.getenv\("ANDROID_APP_NAME"\)\s*\?:\s*"Leyble Hub"/);
});

test('capacitor.config.json stays appId com.leyble.hub (no .pos split)', () => {
  const raw = readFileSync(fileURLToPath(new URL('../capacitor.config.json', import.meta.url)), 'utf8');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.appId, 'com.leyble.hub');
  assert.equal(cfg.appName, 'Leyble Hub');
  assert.equal(cfg.server?.androidScheme, 'https');
});
