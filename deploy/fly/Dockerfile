# The published image, started as root once so it can give the Fly volume (which belongs to root)
# to the inbox's own user; it then runs as that user (apps/inbox/docker/start.mjs). Pin a version
# you have tested, like ghcr.io/surfingdogai/inbox:0.1.0, and change it to update.
FROM ghcr.io/surfingdogai/inbox:latest
USER root
