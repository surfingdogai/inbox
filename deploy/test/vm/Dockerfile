# A disposable server for the installer's test: a fresh Ubuntu or Debian with systemd as PID 1 and
# nothing else, not even curl, so the installer has everything to do. Run it privileged, with the
# host's cgroups (deploy/test/installer-vm.sh does).
ARG BASE=ubuntu:24.04
FROM ${BASE}
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv dbus \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl mask getty.target console-getty.service systemd-logind.service systemd-udevd.service \
    systemd-resolved.service 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
