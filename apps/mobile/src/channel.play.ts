import type * as Direct from "./channel";
import { NO_UPDATE } from "./lib/update";

/**
 * The Google Play copy (channel.ts): in its place in `vite build --mode play`. Google Play installs and
 * updates the app, so it never asks anywhere else whether a new version is out, and never says so.
 */
export const CHANNEL: typeof Direct.CHANNEL = "play";

/** Never asks: Play updates the app. Nothing is fetched. */
export const checkForUpdate: typeof Direct.checkForUpdate = async () => NO_UPDATE;

/** Never shown: there is nothing to get from the download page. */
export const UpdateLine: typeof Direct.UpdateLine = () => null;
