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
  // v3.1.22: AsyncStorage's android/build.gradle has its OWN
  // `repositories { mavenCentral(); google() }` block. When
  // gradle resolves transitive deps (like
  // org.asyncstorage.shared_storage:storage-android:1.0.0) for
  // THIS subproject, it uses these repos, NOT the root
  // project's allprojects block. JitPack (added by react-native's
  // gradle plugin at line 99 of DependencyUtils.kt) is also
  // consulted, and JitPack times out intermittently. The fix:
  // add the local_repo to this subproject's repos so gradle
  // finds the AAR locally and never needs JitPack.
  {
    file: 'node_modules/@react-native-async-storage/async-storage/android/build.gradle',
    find: 'repositories {\n    mavenCentral()\n    google()\n}\n\ndependencies {\n    implementation "com.facebook.react:react-android"\n    api "org.asyncstorage.shared_storage:storage-android:1.0.0"',
    replace: 'repositories {\n    // v3.1.22: local_repo must be FIRST so gradle finds\n    // storage-android locally and never hits JitPack.\n    // rootDir here is the async-storage subproject\'s android\n    // dir, so ../local_repo is the right relative path.\n    maven {\n        url = uri("${rootDir}/../local_repo")\n        metadataSources {\n            mavenPom()\n            gradleMetadata()\n            artifact()\n        }\n    }\n    mavenCentral()\n    google()\n}\n\ndependencies {\n    implementation "com.facebook.react:react-android"\n    api "org.asyncstorage.shared_storage:storage-android:1.0.0"',
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
