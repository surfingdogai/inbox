# The published image, started as root once so it can give the Render disk (which belongs to root)
# to the inbox's own user; it then runs as that user (apps/inbox/docker/start.mjs). The Blueprint
# (render.yaml, at the repository's root) builds this file. Pin a version to stay on it.
FROM ghcr.io/surfingdogai/inbox:latest
USER root
