<?php
/**
 * The plugin's tests, with WordPress's functions stood in for: `php tests/run.php` from the plugin's
 * folder. Nothing here reaches the network: wp_safe_remote_get answers what each test sets. The
 * lines are held to the inbox's own vectors (packages/spec/vectors/discovery.json), which the network
 * and the hosted inbox are held to as well.
 *
 * @package SurfingDogInbox
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'SDI_TESTING', true );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'DAY_IN_SECONDS', 86400 );

// ---- WordPress, stood in for --------------------------------------------------------------------

$GLOBALS['sdi_t'] = array(
	'home'       => 'https://www.example.com/',
	'options'    => array(),
	'transients' => array(),
	'remote'     => array(),
	'calls'      => array(),
	'front'      => true,
	'name'       => 'Example Bakery',
	'tagline'    => 'Bread, every morning.',
	'status'     => null,
	'errors'     => array(),
	'cron'       => array(),
	'is404'      => true,
);
class WP_Error {
	private $m;
	public function __construct( $c = '', $m = '' ) {
		$this->m = $m;
	}
	public function get_error_message() {
		return $this->m;
	}
}
function home_url( $p = '' ) {
	return rtrim( $GLOBALS['sdi_t']['home'], '/' ) . '/' . ltrim( $p, '/' );
}
function admin_url( $p = '' ) {
	return 'https://www.example.com/wp-admin/' . $p;
}
function wp_parse_url( $u, $c = -1 ) {
	return parse_url( $u, $c );
}
function get_option( $k, $d = false ) {
	return array_key_exists( $k, $GLOBALS['sdi_t']['options'] ) ? $GLOBALS['sdi_t']['options'][ $k ] : $d;
}
function add_action() {}
function add_filter() {}
function register_activation_hook() {}
function register_deactivation_hook() {}
function update_option( $k, $v ) {
	$GLOBALS['sdi_t']['options'][ $k ] = $v;
	return true;
}
function delete_option( $k ) {
	unset( $GLOBALS['sdi_t']['options'][ $k ] );
	return true;
}
function wp_next_scheduled( $hook ) {
	return $GLOBALS['sdi_t']['cron'][ $hook ] ?? false;
}
function wp_schedule_event( $at, $recurrence, $hook ) {
	$GLOBALS['sdi_t']['cron'][ $hook ] = array( $at, $recurrence );
	return true;
}
function wp_clear_scheduled_hook( $hook ) {
	unset( $GLOBALS['sdi_t']['cron'][ $hook ] );
}
function is_404() {
	return $GLOBALS['sdi_t']['is404'];
}
function apply_filters( $h, $v ) {
	return $v;
}
function get_bloginfo( $k ) {
	return 'name' === $k ? $GLOBALS['sdi_t']['name'] : $GLOBALS['sdi_t']['tagline'];
}
function wp_json_encode( $v, $f = 0 ) {
	return json_encode( $v, $f );
}
function esc_url( $u ) {
	return htmlspecialchars( $u, ENT_QUOTES );
}
function esc_url_raw( $u ) {
	return $u;
}
function esc_attr( $s ) {
	return htmlspecialchars( $s, ENT_QUOTES );
}
function esc_html( $s ) {
	return htmlspecialchars( $s, ENT_QUOTES );
}
function esc_textarea( $s ) {
	return htmlspecialchars( $s, ENT_QUOTES );
}
function esc_html__( $s ) {
	return htmlspecialchars( $s, ENT_QUOTES );
}
function __( $s ) {
	return $s;
}
function is_front_page() {
	return $GLOBALS['sdi_t']['front'];
}
function status_header( $s ) {
	$GLOBALS['sdi_t']['status'] = $s;
}
function wp_unslash( $s ) {
	return $s;
}
function wp_strip_all_tags( $s ) {
	return strip_tags( $s );
}
function plugin_basename( $f ) {
	return basename( $f );
}
function get_transient( $k ) {
	return $GLOBALS['sdi_t']['transients'][ $k ] ?? false;
}
function set_transient( $k, $v ) {
	$GLOBALS['sdi_t']['transients'][ $k ] = $v;
	return true;
}
function delete_transient( $k ) {
	unset( $GLOBALS['sdi_t']['transients'][ $k ] );
}
function add_settings_error( $s, $c, $m ) {
	$GLOBALS['sdi_t']['errors'][] = $m;
}
function wp_safe_remote_get( $url, $args ) {
	$GLOBALS['sdi_t']['calls'][] = array( $url, $args );
	return $GLOBALS['sdi_t']['remote'][ $url ] ?? new WP_Error( 'http', 'unreachable' );
}
function is_wp_error( $v ) {
	return $v instanceof WP_Error;
}
function wp_remote_retrieve_response_code( $r ) {
	return $r['code'];
}
function wp_remote_retrieve_body( $r ) {
	return $r['body'];
}
function current_user_can( $cap ) {
	return true;
}
function settings_fields( $group ) {}
function submit_button() {
	echo '<button type="submit">Save</button>';
}
function wp_nonce_field( $action ) {}

/** An order, as WooCommerce hands one to an email: only its meta is read. */
class SDI_Test_Order {
	private $meta;
	public function __construct( $meta ) {
		$this->meta = $meta;
	}
	public function get_meta( $key ) {
		return isset( $this->meta[ $key ] ) ? $this->meta[ $key ] : '';
	}
}

require __DIR__ . '/../surfingdog-inbox.php';

// ---- a tiny runner ------------------------------------------------------------------------------

$failures = 0;
$count    = 0;
function check( $what, $ok, $detail = '' ) {
	global $failures, $count;
	++$count;
	if ( ! $ok ) {
		++$failures;
		fwrite( STDERR, "FAIL: $what" . ( '' !== $detail ? "\n  $detail" : '' ) . "\n" );
	}
}
function reset_site() {
	$GLOBALS['sdi_t']['options']    = array();
	$GLOBALS['sdi_t']['transients'] = array();
	$GLOBALS['sdi_t']['remote']     = array();
	$GLOBALS['sdi_t']['calls']      = array();
	$GLOBALS['sdi_t']['front']      = true;
	$GLOBALS['sdi_t']['errors']     = array();
	$GLOBALS['sdi_t']['cron']       = array();
	$GLOBALS['sdi_t']['is404']      = true;
	$GLOBALS['sdi_t']['status']     = null;
}
/** A site whose administrator saved the address, with its inbox answering a good manifest, fetched. */
function published_site( $host = 'inbox.example.com' ) {
	reset_site();
	$GLOBALS['sdi_t']['options'][ SDI_OPTION ]                       = $host;
	$GLOBALS['sdi_t']['remote'][ 'https://' . $host . SDI_MANIFEST_PATH ] = array(
		'code' => 200,
		'body' => '{"spec":"surfingdog-inbox/1","instance":"https://' . $host . '","item_types":["message"]}',
	);
	sdi_after_save();
	$GLOBALS['sdi_t']['calls'] = array();
}
function inner_ld( $tag ) {
	$open = '<script type="application/ld+json">';
	return json_decode( substr( $tag, strlen( $open ), -strlen( '</script>' ) ), true );
}

// ---- the lines, against the vectors -------------------------------------------------------------

$vectors = json_decode( file_get_contents( __DIR__ . '/../../../../packages/spec/vectors/discovery.json' ), true );
check( 'the vectors are read', is_array( $vectors ) && count( $vectors['cases'] ) >= 3 );
foreach ( $vectors['cases'] as $c ) {
	$got = sdi_snippets( $c['domain'], $c['host'], $c['business'] );
	foreach ( array( 'manifest', 'llms_line', 'llms_file', 'link_tag', 'link_header', 'dns_name', 'dns_value', 'well_known' ) as $k ) {
		check( "{$c['name']}: $k", $got[ $k ] === $c['snippets'][ $k ], var_export( $got[ $k ], true ) . ' vs ' . var_export( $c['snippets'][ $k ], true ) );
	}
	check( "{$c['name']}: json_ld", inner_ld( $got['json_ld'] ) === inner_ld( $c['snippets']['json_ld'] ), $got['json_ld'] );
	check( "{$c['name']}: json_ld closes once", substr_count( $got['json_ld'], '</script>' ) === 1 && false === strpos( substr( $got['json_ld'], 35, -9 ), '<' ) );
}

// ---- the words, against the vectors ---------------------------------------------------------------

$words = json_decode( file_get_contents( __DIR__ . '/../../../../packages/spec/vectors/discovery-words.json' ), true );
check( 'the words are read', is_array( $words ) && isset( $words['items'], $words['verdict'] ) );
check( 'the items\' names are the vectors\'', sdi_item_words() === $words['items'], var_export( sdi_item_words(), true ) );
check( 'the verdicts are the vectors\'', sdi_verdicts() === $words['verdict'], var_export( sdi_verdicts(), true ) );
foreach ( $words['short_details'] as $c ) {
	$got = sdi_short_detail( $c['detail'], $c['state'], $c['domain'] );
	check( 'short detail: ' . $c['detail'], $got === $c['short'], var_export( $got, true ) );
}
check( 'a ready check', 'Your website points agents to your inbox: 3 of 5 ways in place.' === sdi_verdict( array( 'state' => 'ready', 'ready' => true, 'ways' => 3 ) ) );
check( 'a state of later is not ready', 'Not yet: 2 of 5 ways in place.' === sdi_verdict( array( 'state' => 'later', 'ready' => true, 'ways' => 2 ) ) );
check( 'an older network: its ready stands', 'Your website points agents to your inbox: 2 of 5 ways in place.' === sdi_verdict( array( 'ready' => true, 'ways' => 2 ) ) );

// ---- the address: the site's domain or a name under it --------------------------------------------

reset_site();
check( 'no address before one is saved', '' === sdi_inbox_host() );
$GLOBALS['sdi_t']['options'][ SDI_OPTION ] = 'agents.example.com';
check( 'another name under the domain', 'agents.example.com' === sdi_inbox_host() );
$GLOBALS['sdi_t']['options'][ SDI_OPTION ] = 'inbox.example.net';
check( 'an address elsewhere is never used', '' === sdi_inbox_host() && null === sdi_site_snippets() );
$GLOBALS['sdi_t']['options'][ SDI_OPTION ] = 'notexample.com';
check( 'a look-alike is not under the domain', '' === sdi_inbox_host() );
reset_site();
check( 'typed with https:// and a path, kept as its host', 'agents.example.com' === sdi_sanitize_host( 'https://Agents.Example.com/x?y' ) );
check( 'typed elsewhere, refused with the reason', '' === sdi_sanitize_host( 'evil.example.org' ) && 1 === count( $GLOBALS['sdi_t']['errors'] ) );
check( 'saved empty: inbox.<domain>', 'inbox.example.com' === sdi_sanitize_host( '  ' ) );
check( 'no address with odd characters', ! sdi_valid_host( 'in box.example.com' ) && ! sdi_valid_host( '127.0.0.1' ) && ! sdi_valid_host( 'inbox..example.com' ) );

// ---- nothing published before the address is saved and its inbox answers --------------------------

reset_site();
ob_start();
sdi_head();
check( 'activated, nothing saved: no link', '' === ob_get_clean() );
check( 'activated, nothing saved: no llms.txt, no manifest', null === sdi_llms_answer() && null === sdi_manifest_answer() );
check( 'activated, nothing saved: nothing fetched', 0 === count( $GLOBALS['sdi_t']['calls'] ) );
$GLOBALS['sdi_t']['options'][ SDI_OPTION ] = 'inbox.example.com';
sdi_after_save();
check( 'saved, its inbox not answering: still nothing published', null === sdi_site_snippets() && 1 === count( $GLOBALS['sdi_t']['calls'] ) );
check( 'a failure waits fifteen minutes', false === sdi_refresh() && 1 === count( $GLOBALS['sdi_t']['calls'] ) );
sdi_after_save();
check( 'saved again: tried again at once', 2 === count( $GLOBALS['sdi_t']['calls'] ) );
$GLOBALS['sdi_t']['remote']['https://inbox.example.com/.well-known/agent-inbox.json'] = array( 'code' => 200, 'body' => '{"spec":"surfingdog-inbox/1","instance":"https://elsewhere.example"}' );
sdi_after_save();
check( 'another inbox\'s manifest is never kept', null === sdi_site_snippets() );
sdi_schedule();
check( 'WP-Cron refreshes it twice a day', isset( $GLOBALS['sdi_t']['cron'][ SDI_EVENT ] ) && 'twicedaily' === $GLOBALS['sdi_t']['cron'][ SDI_EVENT ][1] );

// ---- the head ---------------------------------------------------------------------------------------

published_site();
// WordPress keeps the name with HTML entities; the lines say it as written.
$GLOBALS['sdi_t']['name'] = 'Bread &amp; Co &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
ob_start();
sdi_head();
$head = ob_get_clean();
check( 'the link in the head', false !== strpos( $head, '<link rel="agent-inbox" type="application/json" href="https://inbox.example.com/.well-known/agent-inbox.json">' ), $head );
check( 'a name never closes the structured data', 1 === substr_count( $head, '</script>' ) && 1 === substr_count( $head, '<script' ), $head );
$ld = inner_ld( trim( substr( $head, strpos( $head, '<script' ) ) ) );
check( 'the structured data names the business and the inbox', 'Bread & Co </script><script>alert(1)</script>' === $ld['name'] && 'https://inbox.example.com/.well-known/agent-inbox.json' === $ld['potentialAction']['target']['urlTemplate'] );
$GLOBALS['sdi_t']['front'] = false;
ob_start();
sdi_head();
$head = ob_get_clean();
check( 'the structured data on the front page only', false === strpos( $head, 'ld+json' ) && false !== strpos( $head, 'rel="agent-inbox"' ) );
$GLOBALS['sdi_t']['name'] = 'Example Bakery';
check( 'drawing pages fetched nothing', 0 === count( $GLOBALS['sdi_t']['calls'] ) );

// ---- llms.txt -----------------------------------------------------------------------------------------

published_site();
$a = sdi_llms_answer();
check( 'llms.txt', 200 === $a['status'] && "# Example Bakery\n\n> Bread, every morning.\n\n## Agents\n\n- [Agent inbox](https://inbox.example.com/.well-known/agent-inbox.json): send us messages and requests\n" === $a['body'], var_export( $a['body'], true ) );
check( 'llms.txt is text', 'text/plain; charset=utf-8' === $a['headers']['Content-Type'] );

// ---- the manifest's copy --------------------------------------------------------------------------------

$good = '{"spec":"surfingdog-inbox/1","instance":"https://inbox.example.com","item_types":["message"]}';
check( 'a good manifest', sdi_good_manifest( $good, 'inbox.example.com' ) );
check( 'another inbox\'s manifest is not ours', ! sdi_good_manifest( '{"spec":"surfingdog-inbox/1","instance":"https://inbox.evil.example"}', 'inbox.example.com' ) );
check( 'not a manifest', ! sdi_good_manifest( '<html>', 'inbox.example.com' ) && ! sdi_good_manifest( '{"spec":"other/1","instance":"https://inbox.example.com"}', 'inbox.example.com' ) );

published_site();
$url = 'https://inbox.example.com/.well-known/agent-inbox.json';
$a   = sdi_manifest_answer();
check( 'served as a copy, nothing fetched', 200 === $a['status'] && $good === $a['body'] && '*' === $a['headers']['Access-Control-Allow-Origin'] && 0 === count( $GLOBALS['sdi_t']['calls'] ) );
reset_site();
$GLOBALS['sdi_t']['options'][ SDI_OPTION ]  = 'inbox.example.com';
$GLOBALS['sdi_t']['remote'][ $url ]          = array( 'code' => 200, 'body' => $good );
sdi_refresh();
$args = $GLOBALS['sdi_t']['calls'][0][1];
check( 'fetched safely: no redirect, a timeout, a size cap', 0 === $args['redirection'] && 5 === $args['timeout'] && 65536 === $args['limit_response_size'] );
$GLOBALS['sdi_t']['remote'][ $url ] = array( 'code' => 500, 'body' => '' );
sdi_refresh();
check( 'a failure keeps the last good copy', $good === sdi_manifest_copy( 'inbox.example.com' ) );
$c       = $GLOBALS['sdi_t']['options'][ SDI_COPY ];
$c['at'] = time() - 8 * 86400;
$GLOBALS['sdi_t']['options'][ SDI_COPY ] = $c;
check( 'no good copy for a week: nothing published', null === sdi_site_snippets() && null === sdi_manifest_answer() );
published_site();
$GLOBALS['sdi_t']['options'][ SDI_OPTION ] = 'agents.example.com';
check( 'another address: the old copy is not its', null === sdi_manifest_copy( 'agents.example.com' ) && null === sdi_site_snippets() );

// ---- requests: only what WordPress would answer 404 ------------------------------------------------------

published_site();
$_SERVER['REQUEST_URI'] = '/llms.txt?x=1';
ob_start();
sdi_template_redirect();
$out = ob_get_clean();
check( '/llms.txt answered', 200 === $GLOBALS['sdi_t']['status'] && 0 === strpos( $out, '# Example Bakery' ) );
$GLOBALS['sdi_t']['status'] = null;
$GLOBALS['sdi_t']['is404']  = false;
ob_start();
sdi_template_redirect();
check( 'another plugin answers /llms.txt: left to it', '' === ob_get_clean() && null === $GLOBALS['sdi_t']['status'] );
$GLOBALS['sdi_t']['is404'] = true;
$_SERVER['REQUEST_URI']    = '/.well-known/agent-inbox.json';
ob_start();
sdi_template_redirect();
$out = ob_get_clean();
check( 'the manifest answered', 200 === $GLOBALS['sdi_t']['status'] && $good === $out );
$GLOBALS['sdi_t']['status'] = null;
$_SERVER['REQUEST_URI']     = '/about/';
ob_start();
sdi_template_redirect();
check( 'another page left alone', '' === ob_get_clean() && null === $GLOBALS['sdi_t']['status'] );
$GLOBALS['sdi_t']['home'] = 'https://www.example.com/blog/';
$_SERVER['REQUEST_URI']   = '/llms.txt';
ob_start();
sdi_template_redirect();
check( 'in a subdirectory, the root is not ours', '' === ob_get_clean() && null === $GLOBALS['sdi_t']['status'] );
$GLOBALS['sdi_t']['home'] = 'https://www.example.com/';
check( 'requests fetched nothing', 0 === count( $GLOBALS['sdi_t']['calls'] ) );

// ---- Check ----------------------------------------------------------------------------------------------------

published_site();
$check = 'https://network.surfingdog.ai/v1/discovery/example.com?host=inbox.example.com';
$GLOBALS['sdi_t']['remote'][ $check ] = array( 'code' => 200, 'body' => '{"ready":false,"state":"no_way","ways":0,"items":[{"id":"llms_txt","need":"recommended","state":"missing","detail":"example.com has no llms.txt."}]}' );
$r = sdi_check();
check( 'Check asks the checker for this domain and address', is_array( $r ) && 0 === $r['ways'] && $check === $GLOBALS['sdi_t']['calls'][0][0] && 0 === $GLOBALS['sdi_t']['calls'][0][1]['redirection'] );
check( 'and says it in the owner\'s words', "Not yet: your website doesn't point to your inbox." === sdi_verdict( $r ) );
$GLOBALS['sdi_t']['remote'][ $check ] = array( 'code' => 429, 'body' => '{}' );
check( 'a busy checker, said so', is_wp_error( sdi_check() ) );
$GLOBALS['sdi_t']['remote'][ $check ] = array( 'code' => 503, 'body' => '{}' );
check( 'a checker too busy to read, said so', is_wp_error( sdi_check() ) );
$GLOBALS['sdi_t']['remote'][ $check ] = array( 'code' => 200, 'body' => '<html>' );
check( 'not a check, refused', is_wp_error( sdi_check() ) );

// ---- WooCommerce ----------------------------------------------------------------------------------------------

published_site();
check( 'without WooCommerce: no shop line, nothing quieted', '' === sdi_shop_line() && true === sdi_quiet_store_email( true, new SDI_Test_Order( array( '_sdi_ref' => '01JB7Z8K3M' ) ) ) );
ob_start();
sdi_settings_page();
$page = ob_get_clean();
check( 'without WooCommerce: no Connect WooCommerce', false === strpos( $page, 'Connect WooCommerce' ) );

// WooCommerce, active from here on: declared when this line runs (a class or function written at the
// top level would exist from the start, PHP binding it before anything runs).
if ( ! class_exists( 'WooCommerce' ) ) {
	class WooCommerce {}
	class WC_Data_Store {
		public static function load( $type ) {
			return new self();
		}
		public function search_webhooks( $args ) {
			$GLOBALS['sdi_t']['webhook_search'] = $args;
			return array_keys( $GLOBALS['sdi_t']['webhooks'] );
		}
	}
	class SDI_Test_Webhook {
		private $url;
		public function __construct( $url ) {
			$this->url = $url;
		}
		public function get_delivery_url() {
			return $this->url;
		}
	}
	function wc_get_webhook( $id ) {
		return isset( $GLOBALS['sdi_t']['webhooks'][ $id ] ) ? new SDI_Test_Webhook( $GLOBALS['sdi_t']['webhooks'][ $id ] ) : null;
	}
	function wc_get_page_permalink( $page ) {
		return 'shop' === $page ? 'https://www.example.com/shop/' : '';
	}
}
$GLOBALS['sdi_t']['webhooks'] = array();

published_site();
check( 'the connect address is the inbox\'s own Settings, the WooCommerce drawer open', 'https://inbox.example.com/settings/integrations?connect=woocommerce' === sdi_connect_url( 'inbox.example.com' ) );
ob_start();
sdi_settings_page();
$page = ob_get_clean();
check( 'with WooCommerce: Connect WooCommerce, to the inbox, in a new tab', false !== strpos( $page, '<a class="button button-primary" href="https://inbox.example.com/settings/integrations?connect=woocommerce" target="_blank" rel="noopener noreferrer">Connect WooCommerce</a>' ), $page );
$a = sdi_llms_answer();
check( 'llms.txt: the inbox\'s line as the vectors say, then the shop\'s', "# Example Bakery\n\n> Bread, every morning.\n\n## Agents\n\n- [Agent inbox](https://inbox.example.com/.well-known/agent-inbox.json): send us messages and requests\n- [Shop](https://www.example.com/shop/): orders at this shop's own checkout; questions, quotes and bookings to the agent inbox\n" === $a['body'], var_export( $a['body'], true ) );
reset_site();
ob_start();
sdi_settings_page();
$page = ob_get_clean();
check( 'no address saved: asked for first, no button', false !== strpos( $page, 'Save your inbox&#039;s address first.' ) && false === strpos( $page, 'Connect WooCommerce</a>' ), $page );

// The store's own emails: quiet only for orders the inbox made, while the inbox is connected to the shop.
published_site();
$ours   = new SDI_Test_Order( array( '_sdi_ref' => '01JB7Z8K3M4N5P6Q7R8S9T0V1W' ) );
$theirs = new SDI_Test_Order( array() );
sdi_store_connected( true );
check( 'not connected yet: every email goes', true === sdi_quiet_store_email( true, $ours ) );
$GLOBALS['sdi_t']['webhooks'] = array( 77 => 'https://hooks.elsewhere.example/v1/hooks/woocommerce/abc' );
sdi_store_connected( true );
check( 'another service\'s webhook is not the inbox', true === sdi_quiet_store_email( true, $ours ) );
$GLOBALS['sdi_t']['webhooks'][78] = 'https://inbox.example.com/v1/hooks/woocommerce/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh2';
sdi_store_connected( true );
check( 'connected, an order the inbox made: quiet', false === sdi_quiet_store_email( true, $ours ) );
ob_start();
sdi_settings_page();
$page = ob_get_clean();
check( 'connected: said so, no button', false !== strpos( $page, 'Connected. Orders your inbox accepts go into WooCommerce' ) && false === strpos( $page, 'Connect WooCommerce</a>' ), $page );
check( 'an order the shop took itself: as WooCommerce has it', true === sdi_quiet_store_email( true, $theirs ) );
check( 'an email the store had off stays off', false === sdi_quiet_store_email( false, $theirs ) );
check( 'not an order: as it was', true === sdi_quiet_store_email( true, null ) && true === sdi_quiet_store_email( true, 'x' ) );
check( 'the inbox\'s webhooks are looked for by name, active only', 'active' === $GLOBALS['sdi_t']['webhook_search']['status'] && 'Agent inbox' === $GLOBALS['sdi_t']['webhook_search']['search'] );
check( 'quiet: what the inbox sends itself, never on-hold (bank details), invoices or notes', array( 'customer_processing_order', 'customer_completed_order', 'customer_refunded_order', 'customer_partially_refunded_order', 'customer_cancelled_order' ) === sdi_quiet_emails() );

echo "$count checks, $failures failed\n";
exit( $failures > 0 ? 1 : 0 );
