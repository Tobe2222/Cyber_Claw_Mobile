/**
 * patch-native-modules.js
 * Runs after `npm install` (postinstall) to fix JVM target mismatches
 * in third-party React Native libraries that hardcode jvmTarget = "1.8"
 */

const fs = require('fs');
const path = require('path');

const patches = [
  {
    file: 'node_modules/react-native-audio-recorder-player/android/build.gradle',
    find: 'jvmTarget = "1.8"',
    replace: 'jvmTarget = "17"',
  },
];

let patchCount = 0;
for (const { file, find, replace } of patches) {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) {
    console.log(`[patch] SKIP (not found): ${file}`);
    continue;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(find)) {
    content = content.split(find).join(replace);
    fs.writeFileSync(filePath, content);
    console.log(`[patch] OK: ${file} — "${find}" → "${replace}"`);
    patchCount++;
  } else if (content.includes(replace)) {
    console.log(`[patch] ALREADY APPLIED: ${file}`);
  } else {
    console.log(`[patch] NOT FOUND: "${find}" in ${file}`);
  }
}
console.log(`[patch] Done. ${patchCount} patch(es) applied.`);
