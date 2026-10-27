/**
 * The three ways to run the inbox yourself, as /install shows them after the hosted inbox and the
 * line for your AI: one command on a server, the Docker image on a platform, Cloudflare Workers. The
 * words and the commands are here, in one place, so the page, the docs and the tests agree on them.
 */

/** The one-command installer (apps/site/public/install.sh, built from deploy/). */
export const INSTALL_COMMAND = "curl -fsSL https://surfingdog.ai/install.sh | sudo sh";

/** The image every release publishes, for amd64 and arm64. */
export const IMAGE = "ghcr.io/surfingdogai/inbox";

/**
 * The version the docs pin, the newest release's: the same as packages/core/src/version.ts, which
 * the tests check, so a release that forgets a page fails them.
 */
export const IMAGE_VERSION = "0.2.0-rc.1";

/**
 * The image run by hand, as the docs and the README give it: on the server itself only (a proxy
 * with TLS goes in front), with a secret key the person keeps a copy of, and the address it answers
 * at, so a sign-in link never takes its host from a caller.
 */
export const DOCKER_COMMAND = [
  `(umask 077; echo "INBOX_SECRET_KEY=$(openssl rand -base64 32)" > inbox.env)   # keep a copy somewhere safe`,
  "docker run -d --name inbox --restart unless-stopped -p 127.0.0.1:8787:8787 \\",
  "  -v inbox-data:/opt/inbox/data --env-file inbox.env \\",
  "  -e INBOX_OWNER_EMAIL=you@yourbusiness.com -e INBOX_PUBLIC_URL=https://inbox.yourbusiness.com \\",
  `  ${IMAGE}:${IMAGE_VERSION}`,
].join("\n");

/** Where the installer can be read before it is run. */
export const INSTALLER_SOURCE = "https://github.com/surfingdogai/inbox/blob/main/apps/site/public/install.sh";

/** The one-command way in one sentence, the same on /install, /inbox and in the README. */
export const SERVER_WHAT =
  "Point a subdomain, such as inbox.yourbusiness.com, at an Ubuntu or Debian server, then run one command. HTTPS, a backup every night, and updates that undo themselves if they fail.";

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
    what: SERVER_WHAT,
    command: INSTALL_COMMAND,
    links: [
      { label: "How it works", href: "/docs/run-it-yourself/" },
      { label: "Read it first", href: INSTALLER_SOURCE },
    ],
  },
  {
    id: "docker",
    name: "Docker, or a platform you use",
    what: "The image, for amd64 and arm64. Steps for Docker, Coolify, Fly.io, Render and Railway.",
    command: IMAGE,
    links: [
      { label: "Docker", href: "/docs/run-it-yourself/#docker-or-a-platform-you-use" },
      { label: "Platforms", href: "/docs/platforms/" },
      { label: "Backups", href: "/docs/backups/" },
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers",
    what: "One click puts it on your own Cloudflare account. You can start free; sending email needs Workers Paid or a Resend key.",
    command: null,
    links: [{ label: "What to have ready", href: "/docs/quickstart/#deploy-to-cloudflare" }],
  },
];
