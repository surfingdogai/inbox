<?php
/**
 * Removed with the plugin: its one setting and its copy of the inbox's manifest. Nothing else was
 * stored.
 *
 * @package SurfingDogInbox
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'sdi_inbox_host' );
delete_transient( 'sdi_manifest_copy' );
