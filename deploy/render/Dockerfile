# The published image, started as root once so it can give the Render disk (which belongs to root)
# to the inbox's own user; it then runs as that user (apps/inbox/docker/start.mjs). The Blueprint
# (render.yaml, at the repository's root) builds this file. The version is pinned, so a rebuild never
# moves to another one: to update, back up, change it in your copy, and deploy.
FROM ghcr.io/surfingdogai/inbox:0.1.0
USER root
