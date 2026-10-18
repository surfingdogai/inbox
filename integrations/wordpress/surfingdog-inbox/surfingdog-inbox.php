<?php
/**
 * Plugin Name:       Surfing Dog Inbox
 * Plugin URI:        https://github.com/surfingdogai/inbox/tree/main/integrations/wordpress
 * Description:       Lets AI agents find your agent inbox from your website: a link in every page, structured data, a line in llms.txt and the inbox's manifest at /.well-known/agent-inbox.json. One setting.
 * Version:           0.1.0
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

define( 'SDI_VERSION', '0.1.0' );
define( 'SDI_OPTION', 'sdi_inbox_host' );
define( 'SDI_MANIFEST_CACHE', 'sdi_manifest_copy' );
define( 'SDI_MANIFEST_PATH', '/.well-known/agent-inbox.json' );
define( 'SDI_CHECKER', 'https://network.surfingdog.ai' );

/*
 * What it publishes, from one setting (the inbox's address, inbox.<your domain> unless you set
 * another), the same lines the inbox's own Settings → Be found gives (ADR-022 in the inbox's
 * repository; its vectors/discovery.json):
 *
 *   - <link rel="agent-inbox" href="…/agent-inbox.json"> in every page's <head>, and the same as an
 *     HTTP Link field;
 *   - schema.org structured data on the front page: the business, with a potentialAction whose
 *     target is the inbox's manifest;
 *   - /llms.txt, when the site has none of its own: the site's name and the inbox's line;
 *   - /.well-known/agent-inbox.json: a copy of the inbox's own manifest, refreshed twice a day and
 *     checked before it is served (an agent inbox's, naming the inbox's address as its own), or,
 *     with no good copy, a redirect to it.
 *
 * It calls out to two addresses only: the inbox's own manifest, and, when an administrator presses
 * Check, Surfing Dog's checker. Both through wp_safe_remote_get, https only, no redirect followed,
 * with a timeout and a size cap.
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
 * The inbox's address: the setting, else inbox.<domain>. Only the site's domain or a name under it:
 * a link to an inbox anywhere else would lead agents to someone else's.
 */
function sdi_inbox_host() {
	$domain = sdi_site_domain();
	$host   = strtolower( trim( (string) get_option( SDI_OPTION, '' ) ) );
	if ( '' === $host ) {
		$host = 'inbox.' . $domain;
	}
	return sdi_host_on_site( $host, $domain ) ? $host : '';
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

/** The lines for this site, or null without an inbox address. */
function sdi_site_snippets() {
	$host = sdi_inbox_host();
	if ( '' === $host ) {
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
	$uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
	$path = wp_parse_url( $uri, PHP_URL_PATH );
	return is_string( $path ) ? $path : null;
}

/** What answers /llms.txt and /.well-known/agent-inbox.json, before WordPress looks for a page. */
function sdi_parse_request() {
	$path = sdi_request_path();
	if ( '/llms.txt' === $path ) {
		sdi_serve( sdi_llms_answer() );
	}
	if ( SDI_MANIFEST_PATH === $path ) {
		sdi_serve( sdi_manifest_answer() );
	}
}
add_action( 'parse_request', 'sdi_parse_request', 0 );

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

/** /llms.txt: the site's name, its tagline, and the inbox's line; none when another answers it. */
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

/**
 * /.well-known/agent-inbox.json: the copy, when there is a good one; else a redirect to the inbox's
 * own manifest, which an agent follows.
 */
function sdi_manifest_answer() {
	$s = sdi_site_snippets();
	if ( null === $s ) {
		return null;
	}
	$headers = array(
		'Content-Type'                => 'application/json; charset=utf-8',
		'Cache-Control'               => 'public, max-age=300',
		'Access-Control-Allow-Origin' => '*',
	);
	$copy = sdi_manifest_copy( sdi_inbox_host() );
	if ( null !== $copy ) {
		return array(
			'status'  => 200,
			'headers' => $headers,
			'body'    => $copy,
		);
	}
	return array(
		'status'  => 302,
		'headers' => array(
			'Location'      => $s['manifest'],
			'Cache-Control' => 'public, max-age=60',
		),
		'body'    => '',
	);
}

/**
 * Whether body is the manifest of the inbox at host: JSON, a surfingdog-inbox spec, and https://host
 * as its own address. Anything else is never served as the site's.
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

/**
 * The copy of the inbox's manifest: the last good one, fetched again when it is more than twelve
 * hours old; null when there has never been a good one. A failed fetch keeps the last good copy.
 */
function sdi_manifest_copy( $host ) {
	$cached = get_transient( SDI_MANIFEST_CACHE );
	if ( is_array( $cached ) && isset( $cached['host'], $cached['body'], $cached['at'] ) && $cached['host'] === $host
		&& time() - (int) $cached['at'] < 12 * HOUR_IN_SECONDS ) {
		return $cached['body'];
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
	if ( ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response ) ) {
		$body = wp_remote_retrieve_body( $response );
		if ( sdi_good_manifest( $body, $host ) ) {
			set_transient(
				SDI_MANIFEST_CACHE,
				array(
					'host' => $host,
					'body' => $body,
					'at'   => time(),
				),
				7 * DAY_IN_SECONDS
			);
			return $body;
		}
	}
	if ( is_array( $cached ) && isset( $cached['host'], $cached['body'] ) && $cached['host'] === $host ) {
		return $cached['body'];
	}
	return null;
}

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

/** The one setting, kept only as the site's domain or a name under it. */
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
}
add_action( 'admin_init', 'sdi_admin_init' );

/** A typed address, cleaned: its host alone; empty (inbox.<domain>) when it is not on the site. */
function sdi_sanitize_host( $value ) {
	$value = strtolower( trim( (string) $value ) );
	$value = preg_replace( '#^https?://#', '', $value );
	$value = preg_replace( '#[/?\#].*$#', '', $value );
	$value = rtrim( $value, '.' );
	if ( '' === $value ) {
		return '';
	}
	if ( ! sdi_host_on_site( $value, sdi_site_domain() ) ) {
		add_settings_error( SDI_OPTION, 'sdi_host', __( 'The address must be your own domain or a name under it, like inbox.', 'surfingdog-inbox' ) . sdi_site_domain() );
		return (string) get_option( SDI_OPTION, '' );
	}
	delete_transient( SDI_MANIFEST_CACHE );
	return $value;
}

/** Asks Surfing Dog's checker about the site, when an administrator presses Check. */
function sdi_check() {
	$host = sdi_inbox_host();
	if ( '' === $host ) {
		return new WP_Error( 'sdi_no_host', __( 'Set the address first.', 'surfingdog-inbox' ) );
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
	if ( 200 !== $code || ! is_array( $doc ) || ! isset( $doc['items'], $doc['ways'] ) || ! is_array( $doc['items'] ) ) {
		$detail = is_array( $doc ) && isset( $doc['detail'] ) && is_string( $doc['detail'] ) ? $doc['detail'] : __( 'The check could not run just now.', 'surfingdog-inbox' );
		return new WP_Error( 'sdi_check', $detail );
	}
	return $doc;
}

/** The checker's items in the owner's words. */
function sdi_item_words() {
	return array(
		'cname'      => __( 'DNS record', 'surfingdog-inbox' ),
		'manifest'   => __( 'Your inbox', 'surfingdog-inbox' ),
		'robots'     => __( 'robots.txt', 'surfingdog-inbox' ),
		'well_known' => '/.well-known/agent-inbox.json',
		'llms_txt'   => 'llms.txt',
		'link'       => __( 'Link in your pages', 'surfingdog-inbox' ),
		'schema_org' => __( 'Structured data', 'surfingdog-inbox' ),
		'dns_txt'    => __( '_agent-inbox record', 'surfingdog-inbox' ),
	);
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
	$s = sdi_site_snippets();
	echo '<div class="wrap"><h1>' . esc_html__( 'Agent inbox', 'surfingdog-inbox' ) . '</h1>';
	echo '<p>' . esc_html__( 'AI agents find your inbox from this site: a link in every page, structured data, a line in llms.txt and the inbox\'s manifest at /.well-known/agent-inbox.json.', 'surfingdog-inbox' ) . '</p>';
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
	}
	echo '<form method="post">';
	wp_nonce_field( 'sdi_check' );
	echo '<p><button type="submit" name="sdi_check" value="1" class="button">' . esc_html__( 'Check', 'surfingdog-inbox' ) . '</button> ';
	echo '<span class="description">' . esc_html__( 'Asks Surfing Dog\'s checker to read your site\'s public pages, as a browser would. Nothing is sent until you press it.', 'surfingdog-inbox' ) . '</span></p></form>';
	if ( is_wp_error( $check ) ) {
		echo '<div class="notice notice-warning"><p>' . esc_html( $check->get_error_message() ) . '</p></div>';
	} elseif ( is_array( $check ) ) {
		$words = sdi_item_words();
		echo '<h2>' . esc_html( ! empty( $check['ready'] ) ? sprintf( /* translators: %d: ways in place */ __( 'Agents can find it: %d of 5 ways in place.', 'surfingdog-inbox' ), (int) $check['ways'] ) : sprintf( /* translators: %d: ways in place */ __( 'Not yet: %d of 5 ways in place.', 'surfingdog-inbox' ), (int) $check['ways'] ) ) . '</h2><ul>';
		foreach ( $check['items'] as $item ) {
			if ( ! is_array( $item ) || ! isset( $item['id'], $item['state'], $item['detail'] ) || ! is_string( $item['id'] )
				|| ! is_string( $item['detail'] ) || ! isset( $words[ $item['id'] ] ) ) {
				continue;
			}
			$ok = 'ok' === $item['state'];
			echo '<li>' . ( $ok ? '✓ ' : '· ' ) . '<strong>' . esc_html( $words[ $item['id'] ] ) . '</strong> ' . esc_html( $item['detail'] );
			if ( ! $ok && isset( $item['fix'] ) && is_string( $item['fix'] ) && in_array( $item['id'], array( 'cname', 'manifest', 'robots' ), true ) ) {
				echo '<br><textarea readonly rows="4" class="large-text code">' . esc_textarea( $item['fix'] ) . '</textarea>';
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
