# Inky Soup
Automation for displaying images on the Pimoroni Inky Impression e-ink screen.
Inky Soup provides users with a web page that they can use to flash images
to their Inky Impression.

Currently it is very specific to my needs and is very WIP, but it works (for me)!

# Instructions

Te project consists of two components:

1. A web page - this component is written in Rust using the fine library Rocket
for all the web stuff.
1. A python script for flashing the images to the screen.

Use the deploy script to build and deploy to your Pi.

    INKY_SOUP_IP=<your Pi's IP or hostname> ./deploy.sh

Then, run the image server by hand:
cd deploy
./upload-server

Now, visit your PI in a web browser (port 8000) over your local network and start uploading
images!


# TODO

## Basic
* add validator for image types
* logging
* auto start server at boot

## Advanced
* preview image before flashing? allow user to crop interactively?
* remember last n images uploaded and allow the user to change between them
