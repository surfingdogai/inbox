<?php
/**
 * Plugin Name:       Surfing Dog Inbox
 * Plugin URI:        https://github.com/surfingdogai/inbox/tree/main/integrations/wordpress
 * Description:       Points AI agents from your website to your agent inbox: a link in every page, structured data, a line in llms.txt and a copy of the inbox's manifest at /.well-known/agent-inbox.json. With WooCommerce, connects your shop to your inbox without copying a key. One setting.
 * Version:           0.2.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Surfing Dog
 * Author URI:        https://surfingdog.ai
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       surfingdog-inbox
 *
 * @package SurfingDogInbox
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SDI_VERSION', '0.2.0' );
define( 'SDI_OPTION', 'sdi_inbox_host' );
define( 'SDI_COPY', 'sdi_manifest_copy' );
define( 'SDI_MANIFEST_PATH', '/.well-known/agent-inbox.json' );
define( 'SDI_CHECKER', 'https://network.surfingdog.ai' );
define( 'SDI_EVENT', 'sdi_refresh_event' );
define( 'SDI_RETRY', 15 * 60 );
define( 'SDI_KEEP', 7 * 24 * 3600 );

/*
 * What it publishes, from one setting (the inbox's address, inbox.<your domain> unless you set
 * another), the same lines the inbox's own Settings → Be found gives (ADR-024 in the inbox's
 * repository; its vectors/discovery.json):
 *
 *   - <link rel="agent-inbox" href="…/agent-inbox.json"> in every page's <head>, and the same as an
 *     HTTP Link field;
 *   - schema.org structured data on the front page: the business, with a potentialAction whose
 *     target is the inbox's manifest;
 *   - /llms.txt, when nothing else answers it (a file on disk, another plugin): the site's name and
 *     the inbox's line;
 *   - /.well-known/agent-inbox.json, when nothing else answers it: a copy of the inbox's own
 *     manifest, checked before it is kept (an agent inbox's, naming the inbox's address as its own).
 *
 * It publishes nothing until an administrator has saved the address and a good copy of the inbox's
 * manifest has been fetched (so no agent is led to an inbox that is not there), and stops once no
 * good copy has been fetched for a week. The copy is fetched by WP-Cron twice a day, and when the
 * address is saved, never while a visitor waits; a failed fetch is not tried again for 15 minutes.
 *
 * It calls out to two addresses only: the inbox's own manifest, and, when an administrator presses
 * Check, Surfing Dog's checker. Both through wp_safe_remote_get, https only, no redirect followed,
 * with a timeout and a size cap.
 *
 * With WooCommerce active (ADR-032 in the inbox's repository), it also:
 *
 *   - offers Connect WooCommerce, which opens the inbox's own Settings → Integrations with the
 *     WooCommerce drawer open; the owner presses Connect your shop there, and Approve on WooCommerce's
 *     own page. The plugin itself makes no key and sends nothing;
 *   - adds one line to its llms.txt for the shop: while the inbox is connected to it, agents order
 *     through the inbox and pay at the shop's own checkout; before, orders at the shop's own checkout
 *     and everything else to the inbox;
 *   - keeps WooCommerce's own processing and completed emails quiet for the orders the inbox made,
 *     while the inbox is connected to the shop: the inbox sends the customer its own receipt and says
 *     when the order is on its way. Refund and cancellation emails, bank transfer details (on hold),
 *     invoices and notes go as WooCommerce has them: the inbox does not send those.
 */

/** The site's own domain: its home URL's host, without www. */
function sdi_site_domain() {
	$host = wp_parse_url( home_url( '/' ), PHP_URL_HOST );
	$host = is_string( $host ) ? strtolower( $host ) : '';
	return preg_replace( '/^www\./', '', $host );
}

/** Whether a host name is plain: letters, digits, hyphens and dots, two labels at least. */
function sdi_valid_host( $host ) {
	return is_string( $host ) && strlen( $host ) <= 253
		&& (bool) preg_match( '/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/', $host );
}

/**
 * The inbox's address, as saved: the site's domain or a name under it (a link to an inbox anywhere
 * else would lead agents to someone else's); '' before an administrator saved one.
 */
function sdi_inbox_host() {
	$host = strtolower( trim( (string) get_option( SDI_OPTION, '' ) ) );
	return sdi_host_on_site( $host, sdi_site_domain() ) ? $host : '';
}

/** Whether host is domain or a name under it. */
function sdi_host_on_site( $host, $domain ) {
	if ( ! sdi_valid_host( $host ) || ! sdi_valid_host( $domain ) ) {
		return false;
	}
	return $host === $domain || substr( $host, -strlen( '.' . $domain ) ) === '.' . $domain;
}

/** JSON for inside a <script>: <, >, & and the two line separators escaped, so nothing can close it. */
function sdi_script_json( $value ) {
	$json = wp_json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP );
	return str_replace( array( "\u{2028}", "\u{2029}" ), array( '\\u2028', '\\u2029' ), (string) $json );
}

/**
 * The lines for the inbox at host, of the business named name at domain: the same as the inbox's
 * vectors/discovery.json.
 */
function sdi_snippets( $domain, $host, $name ) {
	$name     = trim( preg_replace( '/\s+/u', ' ', (string) $name ) );
	$name     = '' === $name ? $domain : $name;
	$manifest = 'https://' . $host . SDI_MANIFEST_PATH;
	$line     = '- [Agent inbox](' . $manifest . '): send us messages and requests';
	$ld       = array(
		'@context'        => 'https://schema.org',
		'@type'           => 'Organization',
		'name'            => $name,
		'potentialAction' => array(
			'@type'  => 'CommunicateAction',
			'name'   => 'Message us',
			'target' => array(
				'@type'       => 'EntryPoint',
				'contentType' => 'application/json',
				'urlTemplate' => $manifest,
			),
		),
		'url'             => 'https://' . $domain . '/',
	);
	return array(
		'manifest'    => $manifest,
		'llms_line'   => $line,
		'llms_file'   => '# ' . $name . "\n\n## Agents\n\n" . $line . "\n",
		'link_tag'    => '<link rel="agent-inbox" type="application/json" href="' . $manifest . '">',
		'link_header' => 'Link: <' . $manifest . '>; rel="agent-inbox"',
		'json_ld'     => '<script type="application/ld+json">' . sdi_script_json( $ld ) . '</script>',
		'dns_name'    => '_agent-inbox',
		'dns_value'   => 'v=sdi1; manifest=' . $manifest,
		'well_known'  => 'https://' . $domain . SDI_MANIFEST_PATH,
	);
}

/**
 * A site setting as plain text: WordPress keeps the site's name and tagline with HTML entities
 * (Bread &amp; Co), and the lines say them as people wrote them.
 */
function sdi_site_text( $key ) {
	$text = html_entity_decode( wp_strip_all_tags( (string) get_bloginfo( $key ) ), ENT_QUOTES | ENT_HTML5, 'UTF-8' );
	return trim( preg_replace( '/\s+/u', ' ', $text ) );
}

// ---- the copy of the inbox's manifest --------------------------------------------------------------

/**
 * Whether body is the manifest of the inbox at host: JSON, a surfingdog-inbox spec, and https://host
 * as its own address. Anything else is never kept, nor served as the site's.
 */
function sdi_good_manifest( $body, $host ) {
	if ( ! is_string( $body ) || strlen( $body ) > 65536 ) {
		return false;
	}
	$doc = json_decode( $body, true );
	if ( ! is_array( $doc ) || ! isset( $doc['spec'], $doc['instance'] ) || ! is_string( $doc['spec'] ) || ! is_string( $doc['instance'] ) ) {
		return false;
	}
	return 0 === strpos( $doc['spec'], 'surfingdog-inbox/' ) && rtrim( $doc['instance'], '/' ) === 'https://' . $host;
}

/** What is kept of the copy: host, body (the last good one), at (when it was fetched), retry (not before). */
function sdi_copy_state() {
	$c = get_option( SDI_COPY, array() );
	return is_array( $c ) ? $c : array();
}

/** The good copy for host, when there is one fetched within the last week; null otherwise. */
function sdi_manifest_copy( $host ) {
	$c = sdi_copy_state();
	if ( '' === $host || ! isset( $c['host'], $c['body'], $c['at'] ) || $c['host'] !== $host || ! is_string( $c['body'] ) ) {
		return null;
	}
	if ( time() - (int) $c['at'] > SDI_KEEP ) {
		return null;
	}
	return $c['body'];
}

/**
 * Fetches the inbox's manifest again and keeps it when it is good: from WP-Cron, or when the address
 * is saved (force), never while a visitor waits. A failure keeps the last good copy, and is not tried
 * again for 15 minutes unless forced.
 *
 * @param bool $force Fetch even within the 15 minutes after a failure.
 */
function sdi_refresh( $force = false ) {
	$host = sdi_inbox_host();
	if ( '' === $host ) {
		return false;
	}
	$c = sdi_copy_state();
	if ( isset( $c['host'] ) && $c['host'] !== $host ) {
		$c = array();
	}
	if ( ! $force && isset( $c['retry'] ) && time() < (int) $c['retry'] ) {
		return false;
	}
	$response = wp_safe_remote_get(
		'https://' . $host . SDI_MANIFEST_PATH,
		array(
			'timeout'             => 5,
			'redirection'         => 0,
			'limit_response_size' => 65536,
			'headers'             => array( 'Accept' => 'application/json' ),
			'user-agent'          => 'SurfingDogInboxWordPress/' . SDI_VERSION . '; ' . home_url( '/' ),
		)
	);
	$c['host'] = $host;
	if ( ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response ) ) {
		$body = wp_remote_retrieve_body( $response );
		if ( sdi_good_manifest( $body, $host ) ) {
			$c['body'] = $body;
			$c['at']   = time();
			unset( $c['retry'] );
			update_option( SDI_COPY, $c, false );
			return true;
		}
	}
	$c['retry'] = time() + SDI_RETRY;
	update_option( SDI_COPY, $c, false );
	return false;
}
add_action( SDI_EVENT, 'sdi_refresh' );

/** The address saved: fetch the copy at once, so the lines are published as soon as it is good. */
function sdi_after_save() {
	sdi_refresh( true );
}
add_action( 'add_option_' . SDI_OPTION, 'sdi_after_save', 10, 0 );
add_action( 'update_option_' . SDI_OPTION, 'sdi_after_save', 10, 0 );

/** WP-Cron's twice a day, from the plugin's activation (and kept in place from the admin). */
function sdi_schedule() {
	if ( ! wp_next_scheduled( SDI_EVENT ) ) {
		wp_schedule_event( time() + 60, 'twicedaily', SDI_EVENT );
	}
}
register_activation_hook( __FILE__, 'sdi_schedule' );

function sdi_unschedule() {
	wp_clear_scheduled_hook( SDI_EVENT );
}
register_deactivation_hook( __FILE__, 'sdi_unschedule' );

/** The lines for this site, or null while nothing is published: no address saved, or no good copy. */
function sdi_site_snippets() {
	$host = sdi_inbox_host();
	if ( '' === $host || null === sdi_manifest_copy( $host ) ) {
		return null;
	}
	return sdi_snippets( sdi_site_domain(), $host, sdi_site_text( 'name' ) );
}

// ---- in every page ------------------------------------------------------------------------------

/** The link, in every page's head; the structured data on the front page. */
function sdi_head() {
	$s = sdi_site_snippets();
	if ( null === $s ) {
		return;
	}
	echo '<link rel="agent-inbox" type="application/json" href="' . esc_url( $s['manifest'] ) . '">' . "\n";
	if ( is_front_page() ) {
		// The block is built by sdi_script_json, which escapes everything that could close it.
		echo $s['json_ld'] . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	}
}
add_action( 'wp_head', 'sdi_head', 5 );

/** The same link as an HTTP Link field, for agents that read headers and not pages. */
function sdi_send_headers() {
	$s = sdi_site_snippets();
	if ( null !== $s && ! headers_sent() ) {
		header( 'Link: <' . esc_url_raw( $s['manifest'] ) . '>; rel="agent-inbox"', false );
	}
}
add_action( 'send_headers', 'sdi_send_headers' );

// ---- /llms.txt and /.well-known/agent-inbox.json ------------------------------------------------

/** The request's path, when WordPress is served at the root of its domain; else null. */
function sdi_request_path() {
	$home = wp_parse_url( home_url( '/' ), PHP_URL_PATH );
	if ( is_string( $home ) && '' !== trim( $home, '/' ) ) {
		return null; // in a subdirectory: the root's files are not WordPress's to serve
	}
	$uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
	$path = wp_parse_url( $uri, PHP_URL_PATH );
	return is_string( $path ) ? $path : null;
}

/**
 * What answers /llms.txt and /.well-known/agent-inbox.json: only when WordPress would answer 404, last
 * of template_redirect, so a file on disk, or another plugin's route, answers first.
 */
function sdi_template_redirect() {
	if ( ! is_404() ) {
		return;
	}
	$path = sdi_request_path();
	if ( '/llms.txt' === $path ) {
		sdi_serve( sdi_llms_answer() );
	}
	if ( SDI_MANIFEST_PATH === $path ) {
		sdi_serve( sdi_manifest_answer() );
	}
}
add_action( 'template_redirect', 'sdi_template_redirect', 99 );

/**
 * An answer: status, headers, body; null for none (WordPress goes on as if this plugin were not
 * here).
 *
 * @param array|null $answer The answer.
 */
function sdi_serve( $answer ) {
	if ( null === $answer ) {
		return;
	}
	status_header( $answer['status'] );
	foreach ( $answer['headers'] as $name => $value ) {
		header( $name . ': ' . $value );
	}
	echo $answer['body']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	sdi_exit();
}

/** Ends the request (replaced in the tests). */
function sdi_exit() {
	if ( ! defined( 'SDI_TESTING' ) ) {
		exit;
	}
}

/** /llms.txt: the site's name, its tagline, and the inbox's line; none while nothing is published. */
function sdi_llms_answer() {
	$s = sdi_site_snippets();
	if ( null === $s ) {
		return null;
	}
	$name    = sdi_site_text( 'name' );
	$tagline = sdi_site_text( 'description' );
	$body    = '# ' . ( '' === $name ? sdi_site_domain() : $name ) . "\n\n";
	if ( '' !== $tagline ) {
		$body .= '> ' . $tagline . "\n\n";
	}
	$body .= "## Agents\n\n" . $s['llms_line'] . "\n";
	$shop  = sdi_shop_line();
	if ( '' !== $shop ) {
		$body .= $shop . "\n";
	}
	/**
	 * The llms.txt this plugin serves, for a theme or plugin that adds its own sections.
	 *
	 * @param string $body The file.
	 */
	$body = (string) apply_filters( 'sdi_llms_txt', $body );
	return array(
		'status'  => 200,
		'headers' => array(
			'Content-Type'  => 'text/plain; charset=utf-8',
			'Cache-Control' => 'public, max-age=300',
		),
		'body'    => $body,
	);
}

/** /.well-known/agent-inbox.json: the good copy of the inbox's manifest, kept; none without one. */
function sdi_manifest_answer() {
	$host = sdi_inbox_host();
	$copy = sdi_manifest_copy( $host );
	if ( null === $copy ) {
		return null;
	}
	return array(
		'status'  => 200,
		'headers' => array(
			'Content-Type'                => 'application/json; charset=utf-8',
			'Cache-Control'               => 'public, max-age=300',
			'Access-Control-Allow-Origin' => '*',
		),
		'body'    => $copy,
	);
}

// ---- WooCommerce --------------------------------------------------------------------------------

/** Whether WooCommerce is active on this site. */
function sdi_woocommerce_active() {
	return class_exists( 'WooCommerce' );
}

/** Where the owner connects WooCommerce: the inbox's own Settings → Integrations, its drawer open. */
function sdi_connect_url( $host ) {
	return 'https://' . $host . '/settings/integrations?connect=woocommerce';
}

/** The shop's own page, for the llms.txt line: WooCommerce's shop page, or the site's front page. */
function sdi_shop_url() {
	$url = function_exists( 'wc_get_page_permalink' ) ? (string) wc_get_page_permalink( 'shop' ) : '';
	return '' !== $url ? $url : home_url( '/' );
}

/**
 * The llms.txt line for a WooCommerce shop; '' without one. While the inbox is connected to the shop,
 * agents order through the inbox (a person pays at the shop's own checkout); before, orders go to the
 * shop's own checkout and everything else to the inbox.
 */
function sdi_shop_line() {
	if ( ! sdi_woocommerce_active() ) {
		return '';
	}
	if ( sdi_store_connected() ) {
		return '- [Shop](' . esc_url_raw( sdi_shop_url() ) . '): products and stock; agents order through the agent inbox, paid at this shop\'s own checkout';
	}
	return '- [Shop](' . esc_url_raw( sdi_shop_url() ) . '): orders at this shop\'s own checkout; questions, quotes and bookings to the agent inbox';
}

/**
 * Whether the inbox at the saved address is connected to this shop now: one of its webhooks, active,
 * delivers to it (the inbox makes them once it is connected, and removes them when it is not). Asked
 * once a request.
 *
 * @param bool $forget Forget what was found this request (the tests' own; WordPress never passes it).
 */
function sdi_store_connected( $forget = false ) {
	static $known = null;
	if ( $forget ) {
		$known = null;
		return false;
	}
	if ( null !== $known ) {
		return $known;
	}
	$known = false;
	$host  = sdi_inbox_host();
	if ( '' === $host || ! sdi_woocommerce_active() || ! class_exists( 'WC_Data_Store' ) || ! function_exists( 'wc_get_webhook' ) ) {
		return $known;
	}
	try {
		$ids = WC_Data_Store::load( 'webhook' )->search_webhooks(
			array(
				'status' => 'active',
				'search' => 'Agent inbox',
				'limit'  => 20,
			)
		);
	} catch ( Exception $e ) {
		return $known;
	}
	$prefix = 'https://' . $host . '/v1/hooks/woocommerce/';
	foreach ( (array) $ids as $id ) {
		$hook = wc_get_webhook( $id );
		if ( $hook && 0 === strpos( (string) $hook->get_delivery_url(), $prefix ) ) {
			$known = true;
			break;
		}
	}
	return $known;
}

/**
 * WooCommerce's emails to the customer that the inbox sends itself for the orders it made: the receipt
 * once paid (processing), and the order on its way (completed). Refunds and cancellations made in the
 * shop are not the inbox's to tell, so WooCommerce's own emails about them always go.
 */
function sdi_quiet_emails() {
	return array(
		'customer_processing_order',
		'customer_completed_order',
	);
}

/**
 * One of those emails, for an order the inbox made (`_sdi_ref`) while the inbox is connected to the
 * shop: not sent, since the inbox tells the customer itself, in the business's name. Every other
 * order, and every other email, is left as WooCommerce has it.
 *
 * @param bool  $enabled Whether WooCommerce would send it.
 * @param mixed $order   What the email is about.
 */
function sdi_quiet_store_email( $enabled, $order = null ) {
	if ( ! $enabled || ! is_object( $order ) || ! method_exists( $order, 'get_meta' ) ) {
		return $enabled;
	}
	if ( '' === (string) $order->get_meta( '_sdi_ref' ) || ! sdi_store_connected() ) {
		return $enabled;
	}
	/**
	 * Whether WooCommerce's own emails stay quiet for an order the inbox made. True by default.
	 *
	 * @param bool     $quiet Quiet.
	 * @param WC_Order $order The order.
	 */
	return apply_filters( 'sdi_quiet_store_emails', true, $order ) ? false : $enabled;
}
foreach ( sdi_quiet_emails() as $sdi_email_id ) {
	add_filter( 'woocommerce_email_enabled_' . $sdi_email_id, 'sdi_quiet_store_email', 10, 2 );
}

/** Declared compatible with WooCommerce's order tables (HPOS): orders are read only through WC_Order. */
function sdi_declare_compatibility() {
	if ( class_exists( 'Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
	}
}
add_action( 'before_woocommerce_init', 'sdi_declare_compatibility' );

// ---- the setting --------------------------------------------------------------------------------

/** Settings → Agent inbox. */
function sdi_admin_menu() {
	add_options_page(
		__( 'Agent inbox', 'surfingdog-inbox' ),
		__( 'Agent inbox', 'surfingdog-inbox' ),
		'manage_options',
		'surfingdog-inbox',
		'sdi_settings_page'
	);
}
add_action( 'admin_menu', 'sdi_admin_menu' );

/** The one setting, kept only as the site's domain or a name under it; and the refresh in place. */
function sdi_admin_init() {
	register_setting(
		'surfingdog-inbox',
		SDI_OPTION,
		array(
			'type'              => 'string',
			'sanitize_callback' => 'sdi_sanitize_host',
			'default'           => '',
		)
	);
	sdi_schedule();
}
add_action( 'admin_init', 'sdi_admin_init' );

/** A typed address, cleaned: its host alone; inbox.<domain> when left empty; refused when not on the site. */
function sdi_sanitize_host( $value ) {
	$value = strtolower( trim( (string) $value ) );
	$value = preg_replace( '#^https?://#', '', $value );
	$value = preg_replace( '#[/?\#].*$#', '', $value );
	$value = rtrim( $value, '.' );
	if ( '' === $value ) {
		$value = 'inbox.' . sdi_site_domain();
	}
	if ( ! sdi_host_on_site( $value, sdi_site_domain() ) ) {
		add_settings_error( SDI_OPTION, 'sdi_host', __( 'The address must be your own domain or a name under it, like inbox.', 'surfingdog-inbox' ) . sdi_site_domain() );
		return (string) get_option( SDI_OPTION, '' );
	}
	return $value;
}

/** Asks Surfing Dog's checker about the site, when an administrator presses Check. */
function sdi_check() {
	$host = sdi_inbox_host();
	if ( '' === $host ) {
		return new WP_Error( 'sdi_no_host', __( 'Save the address first.', 'surfingdog-inbox' ) );
	}
	$url      = SDI_CHECKER . '/v1/discovery/' . rawurlencode( sdi_site_domain() ) . '?host=' . rawurlencode( $host );
	$response = wp_safe_remote_get(
		$url,
		array(
			'timeout'             => 25,
			'redirection'         => 0,
			'limit_response_size' => 262144,
			'headers'             => array( 'Accept' => 'application/json' ),
			'user-agent'          => 'SurfingDogInboxWordPress/' . SDI_VERSION,
		)
	);
	if ( is_wp_error( $response ) ) {
		return new WP_Error( 'sdi_check', __( 'The check could not run just now. Try again in a minute.', 'surfingdog-inbox' ) );
	}
	$code = (int) wp_remote_retrieve_response_code( $response );
	$doc  = json_decode( wp_remote_retrieve_body( $response ), true );
	if ( 429 === $code ) {
		return new WP_Error( 'sdi_check', __( 'Checked a moment ago. Try again in a minute.', 'surfingdog-inbox' ) );
	}
	if ( 503 === $code ) {
		return new WP_Error( 'sdi_check', __( 'The checker is busy just now. Try again in a minute.', 'surfingdog-inbox' ) );
	}
	if ( 200 !== $code || ! is_array( $doc ) || ! isset( $doc['items'], $doc['ways'] ) || ! is_array( $doc['items'] ) ) {
		$detail = is_array( $doc ) && isset( $doc['detail'] ) && is_string( $doc['detail'] ) ? $doc['detail'] : __( 'The check could not run just now.', 'surfingdog-inbox' );
		return new WP_Error( 'sdi_check', $detail );
	}
	return $doc;
}

/** The checker's items in the owner's words (the inbox's vectors/discovery-words.json). */
function sdi_item_words() {
	return array(
		'cname'      => __( 'Inbox address', 'surfingdog-inbox' ),
		'manifest'   => __( 'Your inbox', 'surfingdog-inbox' ),
		'robots'     => 'robots.txt',
		'well_known' => __( 'Inbox file on your site', 'surfingdog-inbox' ),
		'llms_txt'   => 'llms.txt',
		'link'       => __( 'Link in your pages', 'surfingdog-inbox' ),
		'schema_org' => __( 'Structured data', 'surfingdog-inbox' ),
		'dns_txt'    => __( 'DNS pointer', 'surfingdog-inbox' ),
	);
}

/** A check's state in the owner's words ({ways} and {host} filled in); an unknown state is not ready. */
function sdi_verdicts() {
	return array(
		'ready'             => __( 'Your website points agents to your inbox: {ways} of 5 ways in place.', 'surfingdog-inbox' ),
		'dns_only'          => __( 'Not on your website yet: the DNS record alone points to your inbox.', 'surfingdog-inbox' ),
		'no_way'            => __( "Not yet: your website doesn't point to your inbox.", 'surfingdog-inbox' ),
		'unreachable'       => __( "Not yet: the inbox doesn't answer at {host}.", 'surfingdog-inbox' ),
		'blocked'           => __( 'Not yet: robots.txt keeps AI assistants out.', 'surfingdog-inbox' ),
		'robots_unreadable' => __( "Not yet: robots.txt can't be read, so assistants read nothing.", 'surfingdog-inbox' ),
		'not_ready'         => __( 'Not yet: {ways} of 5 ways in place.', 'surfingdog-inbox' ),
	);
}

/** The verdict for a check's answer. */
function sdi_verdict( $check ) {
	$v     = sdi_verdicts();
	$state = isset( $check['state'] ) && is_string( $check['state'] ) ? $check['state'] : '';
	if ( isset( $v[ $state ] ) && 'not_ready' !== $state ) {
		$text = $v[ $state ];
	} else {
		$text = ( '' === $state && ! empty( $check['ready'] ) ) ? $v['ready'] : $v['not_ready'];
	}
	$host = isset( $check['host'] ) && is_string( $check['host'] ) ? $check['host'] : '';
	return str_replace( array( '{ways}', '{host}' ), array( (string) (int) $check['ways'], $host ), $text );
}

/** An item's detail as a row says it: the label it starts with taken off, a missing item not there yet. */
function sdi_short_detail( $detail, $state, $domain ) {
	if ( 'missing' === $state && false === strpos( $detail, 'could not be read' ) ) {
		return __( 'Not there yet.', 'surfingdog-inbox' );
	}
	$prefixes = array( 'robots.txt ', 'llms.txt ', 'https://' . $domain . SDI_MANIFEST_PATH . ' ', '_agent-inbox.' . $domain . ' ', 'https://' . $domain . '/robots.txt ', 'https://' . $domain . '/llms.txt ' );
	foreach ( $prefixes as $p ) {
		if ( 0 === strpos( $detail, $p ) ) {
			$d   = substr( $detail, strlen( $p ) );
			$pos = strpos( $d, 'keeps out AI assistants that people use' );
			if ( false !== $pos ) {
				$d = substr_replace( $d, 'keeps out assistants people use', $pos, strlen( 'keeps out AI assistants that people use' ) );
			}
			return ucfirst( $d );
		}
	}
	return $detail;
}

/** The settings page: the address, what is published, and Check. */
function sdi_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$check = null;
	if ( isset( $_POST['sdi_check'] ) ) {
		check_admin_referer( 'sdi_check' );
		$check = sdi_check();
	}
	$host = sdi_inbox_host();
	if ( '' !== $host && null === sdi_manifest_copy( $host ) ) {
		sdi_refresh();
	}
	$s = sdi_site_snippets();
	echo '<div class="wrap"><h1>' . esc_html__( 'Agent inbox', 'surfingdog-inbox' ) . '</h1>';
	echo '<p>' . esc_html__( 'This site points AI agents to your inbox: a link in every page, structured data, a line in llms.txt and a copy of the inbox\'s manifest.', 'surfingdog-inbox' ) . '</p>';
	echo '<form method="post" action="options.php">';
	settings_fields( 'surfingdog-inbox' );
	echo '<table class="form-table" role="presentation"><tr><th scope="row"><label for="sdi-host">' . esc_html__( 'Your inbox\'s address', 'surfingdog-inbox' ) . '</label></th><td>';
	echo '<input name="' . esc_attr( SDI_OPTION ) . '" id="sdi-host" type="text" class="regular-text code" value="' . esc_attr( (string) get_option( SDI_OPTION, '' ) ) . '" placeholder="' . esc_attr( 'inbox.' . sdi_site_domain() ) . '">';
	echo '<p class="description">' . esc_html__( 'Leave it empty for inbox.', 'surfingdog-inbox' ) . esc_html( sdi_site_domain() ) . '</p></td></tr></table>';
	submit_button();
	echo '</form>';
	if ( null !== $s ) {
		echo '<h2>' . esc_html__( 'Published', 'surfingdog-inbox' ) . '</h2><ul>';
		echo '<li><code>' . esc_html( $s['link_tag'] ) . '</code></li>';
		echo '<li><a href="' . esc_url( home_url( '/llms.txt' ) ) . '">llms.txt</a> · <a href="' . esc_url( home_url( SDI_MANIFEST_PATH ) ) . '">agent-inbox.json</a></li></ul>';
		echo '<p>' . esc_html__( 'One more, where your DNS is: type TXT, name', 'surfingdog-inbox' ) . ' <code>' . esc_html( $s['dns_name'] ) . '</code>, ' . esc_html__( 'value', 'surfingdog-inbox' ) . ' <code>' . esc_html( $s['dns_value'] ) . '</code></p>';
	} elseif ( '' === $host ) {
		echo '<p>' . esc_html__( 'Nothing is published until you save the address.', 'surfingdog-inbox' ) . '</p>';
	} else {
		echo '<p>' . esc_html( sprintf( /* translators: %s: the inbox's address */ __( 'Nothing is published yet: %s does not answer as an agent inbox. It is tried again twice a day.', 'surfingdog-inbox' ), $host ) ) . '</p>';
	}
	if ( sdi_woocommerce_active() ) {
		echo '<h2>WooCommerce</h2>';
		if ( '' === $host ) {
			echo '<p>' . esc_html__( 'Save your inbox\'s address first.', 'surfingdog-inbox' ) . '</p>';
		} elseif ( sdi_store_connected() ) {
			echo '<p>' . esc_html__( 'Connected. Orders your inbox accepts go into WooCommerce, paid at your own checkout. WooCommerce\'s own emails about them stay quiet: your inbox already told your customer.', 'surfingdog-inbox' ) . '</p>';
		} else {
			echo '<p>' . esc_html__( 'Your products in your inbox, and the orders it accepts in WooCommerce, paid at your own checkout.', 'surfingdog-inbox' ) . '</p>';
			echo '<p><a class="button button-primary" href="' . esc_url( sdi_connect_url( $host ) ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'Connect WooCommerce', 'surfingdog-inbox' ) . '</a> ';
			echo '<span class="description">' . esc_html__( 'Opens your inbox. Press Connect your shop there, then Approve.', 'surfingdog-inbox' ) . '</span></p>';
		}
	}
	echo '<form method="post">';
	wp_nonce_field( 'sdi_check' );
	echo '<p><button type="submit" name="sdi_check" value="1" class="button">' . esc_html__( 'Check', 'surfingdog-inbox' ) . '</button> ';
	echo '<span class="description">' . esc_html__( 'Asks Surfing Dog\'s checker to read your site\'s public pages, as a browser would. Nothing is sent until you press it.', 'surfingdog-inbox' ) . '</span></p></form>';
	if ( is_wp_error( $check ) ) {
		echo '<div class="notice notice-warning"><p>' . esc_html( $check->get_error_message() ) . '</p></div>';
	} elseif ( is_array( $check ) ) {
		$words  = sdi_item_words();
		$domain = sdi_site_domain();
		echo '<h2>' . esc_html( sdi_verdict( $check ) ) . '</h2><ul>';
		foreach ( $check['items'] as $item ) {
			if ( ! is_array( $item ) || ! isset( $item['id'], $item['state'], $item['detail'] ) || ! is_string( $item['id'] )
				|| ! is_string( $item['state'] ) || ! is_string( $item['detail'] ) || ! isset( $words[ $item['id'] ] ) ) {
				continue;
			}
			$mark = 'ok' === $item['state'] ? '✓' : ( 'missing' === $item['state'] ? '○' : '!' );
			echo '<li>' . esc_html( $mark ) . ' <strong>' . esc_html( $words[ $item['id'] ] ) . '</strong> ' . esc_html( sdi_short_detail( $item['detail'], $item['state'], $domain ) );
			if ( 'ok' !== $item['state'] && in_array( $item['id'], array( 'cname', 'manifest', 'robots' ), true ) ) {
				if ( 'robots' === $item['id'] && isset( $item['fix_lines'] ) && is_string( $item['fix_lines'] ) && '' !== $item['fix_lines'] ) {
					echo '<br>' . esc_html__( 'Add these lines at the top of robots.txt:', 'surfingdog-inbox' );
					echo '<br><textarea readonly rows="4" class="large-text code">' . esc_textarea( $item['fix_lines'] ) . '</textarea>';
					echo '<br><span class="description">' . esc_html__( "Blocking training crawlers is fine: it doesn't stop assistants.", 'surfingdog-inbox' ) . '</span>';
				} elseif ( isset( $item['fix'] ) && is_string( $item['fix'] ) ) {
					echo '<br><textarea readonly rows="4" class="large-text code">' . esc_textarea( $item['fix'] ) . '</textarea>';
				}
			}
			echo '</li>';
		}
		echo '</ul>';
	}
	echo '</div>';
}

/** A link to the setting from the plugins list. */
function sdi_action_links( $links ) {
	$links[] = '<a href="' . esc_url( admin_url( 'options-general.php?page=surfingdog-inbox' ) ) . '">' . esc_html__( 'Settings', 'surfingdog-inbox' ) . '</a>';
	return $links;
}
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), 'sdi_action_links' );
