/**
 * The three ways to run the inbox yourself, as /install shows them after the hosted inbox: one
 * command on a server, the Docker image on a platform, Cloudflare Workers. The words and the
 * commands are here, in one place, so the page, the docs and the tests agree on them.
 */

/** The one-command installer (apps/site/public/install.sh, built from deploy/). */
export const INSTALL_COMMAND = "curl -fsSL https://surfingdog.ai/install.sh | sudo sh";

/** The image every release publishes, for amd64 and arm64. */
export const IMAGE = "ghcr.io/surfingdogai/inbox";

/** The shortest real run of the image: the data in a volume, and the address that may sign in. */
export const DOCKER_COMMAND = `docker run -d -p 8787:8787 -v inbox-data:/opt/inbox/data -e INBOX_OWNER_EMAIL=you@yourbusiness.com ${IMAGE}`;

/** Where the installer can be read before it is run. */
export const INSTALLER_SOURCE = "https://github.com/surfingdogai/inbox/blob/main/apps/site/public/install.sh";

export interface SelfHostWay {
  readonly id: string;
  readonly name: string;
  readonly what: string;
  /** The line to copy, or null for the Deploy to Cloudflare button. */
  readonly command: string | null;
  readonly links: readonly { readonly label: string; readonly href: string }[];
}

export const SELF_HOST: readonly SelfHostWay[] = [
  {
    id: "server",
    name: "On your own server",
    what: "One command on Ubuntu or Debian. It asks for your address and your email, then sets up HTTPS, a backup every night, and updates that roll back on their own.",
    command: INSTALL_COMMAND,
    links: [
      { label: "How it works", href: "/docs/run-it-yourself/" },
      { label: "Read it first", href: INSTALLER_SOURCE },
    ],
  },
  {
    id: "docker",
    name: "Docker, or a platform you use",
    what: "The image, for amd64 and arm64, with steps for Coolify, Fly.io, Render and Railway.",
    command: DOCKER_COMMAND,
    links: [
      { label: "Platforms", href: "/docs/platforms/" },
      { label: "Backups", href: "/docs/backups/" },
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers",
    what: "One click copies it to your own Cloudflare account, with a D1 database, a queue and a cron. The free plan runs it.",
    command: null,
    links: [{ label: "What to have ready", href: "/docs/quickstart/#deploy-to-cloudflare" }],
  },
];
