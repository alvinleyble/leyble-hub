import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// V3.0 Slice 5 removed the V1<->V2 long-press bridge and the V2 shell, but the
// landscape lock and single Android package identity must survive that cleanup.

test('AndroidManifest has screenOrientation="sensorLandscape" on MainActivity', () => {
  const xml = readFileSync(fileURLToPath(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url)), 'utf8');
  assert.match(xml, /android:screenOrientation="sensorLandscape"/, 'expected sensorLandscape on MainActivity');
  assert.match(xml, /<activity[^>]*android:screenOrientation="sensorLandscape"/s);
});

test('capacitor.config.json stays appId com.leyble.hub (no .pos split)', () => {
  const raw = readFileSync(fileURLToPath(new URL('../capacitor.config.json', import.meta.url)), 'utf8');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.appId, 'com.leyble.hub');
  assert.equal(cfg.appName, 'Leyble Hub');
  assert.equal(cfg.server?.androidScheme, 'https');
});
