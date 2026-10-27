# The published image, started as root once so it can give the Fly volume (which belongs to root)
# to the inbox's own user; it then runs as that user (apps/inbox/docker/start.mjs). The version is
# pinned, so a rebuild never moves to another one: to update, back up, change it, and fly deploy.
FROM ghcr.io/surfingdogai/inbox:0.2.0-rc.1
USER root
