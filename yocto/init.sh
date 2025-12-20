#!/usr/bin/env bash

INIT_HEADER="INKY-SOUP INIT"

YOCTO_POKY_REMOTE=https://github.com/yoctoproject/poky.git
YOCTO_META_RPI_REMOTE=git://git.yoctoproject.org/meta-raspberrypi.git
YOCTO_META_OE_REMOTE=git://git.openembedded.org/meta-openembedded.git
YOCTO_OE_CORE_REMOTE=git://git.openembedded.org/openembedded-core.git
YOCTO_BRANCH=scarthgap

BUILD_DIR_NAME=build
BUILD_POKY_DIR=$BUILD_DIR_NAME/poky

SRC_DIR=src
SRC_POKY_DIR=$SRC_DIR/poky
SRC_POKY_BUILD_DIR=$SRC_POKY_DIR/build

SRC_META_RPI_DIR_NAME=meta-raspberrypi
SRC_META_RPI_DIR=$SRC_DIR/$SRC_META_RPI_DIR_NAME

SRC_META_OE_DIR_NAME=meta-openembedded
SRC_META_OE_DIR=$SRC_DIR/$SRC_META_OE_DIR_NAME

SRC_OE_CORE_DIR_NAME=openembedded-core
SRC_OE_CORE_DIR=$SRC_DIR/$SRC_OE_CORE_DIR_NAME

echo "[$INIT_HEADER] Initializing Yocto build environment..."
echo "[$INIT_HEADER] Using source directory '$SRC_DIR'."

function init_required_src_dir() {
  if [ ! $# -eq 3 ]; then
    echo "[$INIT_HEADER] Usage: init_required_src_dir <dir> <git_url> <branch>"
    exit 2
  fi

  local dir=$1;
  local git_url=$2;
  local branch=$3;

  if [ ! -d $dir ]; then
    echo "[$INIT_HEADER] Cloning '$dir' from '$git_url' @ '$branch'..."
    git clone --depth 1 -b $branch $git_url $dir || {
      echo "[$INIT_HEADER] Failed to clone sources for '$dir' using '$git_url' @ '$branch'."
      exit 4
    }
  else
    echo "[$INIT_HEADER] Directory '$dir' already exists. Init skipped."
  fi
}

init_required_src_dir $SRC_POKY_DIR $YOCTO_POKY_REMOTE $YOCTO_BRANCH
init_required_src_dir $SRC_META_RPI_DIR $YOCTO_META_RPI_REMOTE $YOCTO_BRANCH
init_required_src_dir $SRC_META_OE_DIR $YOCTO_META_OE_REMOTE $YOCTO_BRANCH
init_required_src_dir $SRC_OE_CORE_DIR $YOCTO_OE_CORE_REMOTE $YOCTO_BRANCH

pushd $SRC_POKY_DIR > /dev/null

if [ ! -L ./$BUILD_DIR_NAME ]; then
  if [ -d ./$BUILD_DIR_NAME ]; then
    rm -rf ./$BUILD_DIR_NAME
  fi

  echo "[$INIT_HEADER] Linking persistent build directory '$BUILD_POKY_DIR'..."
  ln -sf ../../$BUILD_POKY_DIR ./$BUILD_DIR_NAME
fi;

echo "[$INIT_HEADER] Linking directories to layers..."
ln -sf ../$SRC_META_RPI_DIR_NAME ../../$SRC_POKY_DIR/$SRC_META_RPI_DIR_NAME
ln -sf ../$SRC_META_OE_DIR_NAME ../../$SRC_POKY_DIR/$SRC_META_OE_DIR_NAME
ln -sf ../$SRC_OE_CORE_DIR_NAME ../../$SRC_POKY_DIR/$SRC_OE_CORE_DIR_NAME

if [ ! -f ./oe-init-build-env ]; then
  echo "[$INIT_HEADER] Can't find 'oe-init-build-env' in '$SRC_POKY_DIR'."
  exit 5
fi

echo "[$INIT_HEADER] Running 'oe-init-build-env'..."
source ./oe-init-build-env || {
  echo "[$INIT_HEADER] oe-init-build-env failed."
  echo "[$INIT_HEADER] Maybe missing build tools... trying install-buildtools."

  (scripts/install-buildtools && source ./oe-init-build-env) || {
    echo "[$INIT_HEADER] Still failed. Check the output above."
    exit 6
  }
}

echo "[$INIT_HEADER] Init complete. You can now run: bitbake core-image-minimal"
