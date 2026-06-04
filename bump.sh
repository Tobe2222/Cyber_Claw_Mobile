#!/bin/bash
# Usage: ./bump.sh <new-version>
# e.g. ./bump.sh 2.13.107
VERSION=$1
if [ -z "$VERSION" ]; then echo "Usage: ./bump.sh <version>"; exit 1; fi

CODE=$(grep versionCode android/app/build.gradle | grep -o '[0-9]*')
NEW_CODE=$((CODE + 1))

sed -i "s/versionCode $CODE/versionCode $NEW_CODE/" android/app/build.gradle
sed -i "s/versionName \"[^\"]*\"/versionName \"$VERSION\"/" android/app/build.gradle
# Update package.json to match
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json')); p.version='$VERSION'; fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');"
echo "Bumped to $VERSION (versionCode $NEW_CODE)"
