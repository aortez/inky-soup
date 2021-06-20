# Cross compiler setup
Adapted from this SU answer:
https://superuser.com/a/396667

$ rustup target add arm-unknown-linux-gnueabihf
$ sudo apt-get install gcc-arm-linux-gnueabihf
$ echo '[target.arm-unknown-linux-gnueabihf]' >> ~/.cargo/config
$ echo 'linker = "arm-linux-gnueabihf-gcc"' >> ~/.cargo/config
$ cd <project dir>
$ cargo build --target=arm-unknown-linux-gnueabihf

# Build pi zero target like so
    cargo build --target=arm-unknown-linux-gnueabihf

# The binary will be here:
    target/arm-unknown-linux-gnueabihf/debug/upload-server
