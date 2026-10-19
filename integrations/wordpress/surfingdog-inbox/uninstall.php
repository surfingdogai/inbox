<?php
/**
 * Removed with the plugin: its one setting, its copy of the inbox's manifest and its WP-Cron event.
 * Nothing else was stored.
 *
 * @package SurfingDogInbox
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'sdi_inbox_host' );
delete_option( 'sdi_manifest_copy' );
delete_transient( 'sdi_manifest_copy' );
wp_clear_scheduled_hook( 'sdi_refresh_event' );
