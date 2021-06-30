#!/bin/bash
#
# Builds and deploys the project to your raspberry pi zero.

DEPLOY_TEMP_DIR=/tmp/inky-soup

set -exuof pipefail

# Directory for temp storage of deployment files.
rm -rf $DEPLOY_TEMP_DIR
mkdir -p $DEPLOY_TEMP_DIR

# Stage service script.
cp inky-soup.service $DEPLOY_TEMP_DIR

# Build upload server.
pushd .
cd upload-server
cargo build --target=arm-unknown-linux-gnueabihf
cp target/arm-unknown-linux-gnueabihf/debug/upload-server $DEPLOY_TEMP_DIR
cp -ra static $DEPLOY_TEMP_DIR
cp -ra templates $DEPLOY_TEMP_DIR
cp -ra Rocket.toml $DEPLOY_TEMP_DIR
popd

# Copy over image update python script.
cp ./update-image.py $DEPLOY_TEMP_DIR

# Deploy to your pi.
scp -pr $DEPLOY_TEMP_DIR pi@$INKY_SOUP_IP:~
