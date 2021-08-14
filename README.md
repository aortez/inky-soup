![Example of Web Page](./inky-soup-uploader.png "Example of Web Page")

# Inky Soup
Automation for displaying images on the Pimoroni Inky Impression e-ink screen.
Inky Soup provides users with a web page that they can use to flash images
to their Inky Impression.

Currently it is very specific to my needs and is very WIP, but it works (for me)!

![A Goose](./upload-server/static/favicon.ico "A Goose")

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

## Image Gallery
* [x] Show images in /static/images directory.
* [x] Uploading a new image will put it in the /static/images dir.
* [ ] Make a /list endpoint for listing the current images.
* [ ] Make a /delete endpoint for deleting images.
* [ ] Add delete button next to each image and make it call the /delete endpoint for that image.
* [x] Redesign the page so that we have two forms:
1. One that uploads new images
2. One that flashes an image from the gallery

## Advanced
* preview image before flashing? allow user to crop interactively?
