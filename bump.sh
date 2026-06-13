#!/bin/bash
# Usage: ./bump.sh <new-version>
# e.g. ./bump.sh 3.1.9
#
# Bumps versionName / versionCode in build.gradle and version in
# package.json, commits the version bump, and tags the commit. The tag
# MUST point at the version-bump commit (not the prior code commit),
# otherwise the GitHub Actions release workflow will build an APK from
# the old code with the new version label. (This was the v3.1.5..v3.1.9
# release bug: every APK was built from a commit where package.json
# still had the previous version string.)
VERSION=$1
if [ -z "$VERSION" ]; then echo "Usage: ./bump.sh <version>"; exit 1; fi

CODE=$(grep versionCode android/app/build.gradle | grep -o '[0-9]*')
NEW_CODE=$((CODE + 1))

sed -i "s/versionCode $CODE/versionCode $NEW_CODE/" android/app/build.gradle
sed -i "s/versionName \"[^\"]*\"/versionName \"$VERSION\"/" android/app/build.gradle
# Update package.json to match
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json')); p.version='$VERSION'; fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');"

# Commit the version bump FIRST, then tag the resulting commit. Tagging
# HEAD before the version-bump is committed would tag the previous code
# commit, which is what was happening before this fix.
git add android/app/build.gradle package.json
git commit -m "Bump to v$VERSION (versionCode $NEW_CODE)"
git tag -a "v$VERSION" -m "v$VERSION" HEAD
git push origin "v$VERSION" 2>&1 | tail -1
git push origin HEAD 2>&1 | tail -1
echo "Bumped to v$VERSION (versionCode $NEW_CODE) and tagged v$VERSION"
