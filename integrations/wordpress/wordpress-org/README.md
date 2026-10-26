# wordpress.org: the submission package

Everything the wordpress.org listing needs, prepared and **not submitted**. Submitting is done from
the wordpress.org account that will own the plugin (the `Contributors:` line in `readme.txt` names
it), at https://wordpress.org/plugins/developers/add/. Nothing here is uploaded anywhere by a script.

Guidelines read on 20 October 2026:

- Detailed plugin guidelines: https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/
- How readme.txt works: https://developer.wordpress.org/plugins/wordpress-org/how-your-readme-txt-works/
- Plugin assets: https://developer.wordpress.org/plugins/wordpress-org/plugin-assets/
- Plugin check (the review team's tool): https://wordpress.org/plugins/plugin-check/
- Readme validator: https://wordpress.org/plugins/developers/readme-validator/

## 1. The zip

    cd integrations/wordpress && zip -r surfingdog-inbox.zip surfingdog-inbox -x 'surfingdog-inbox/tests/*'

The zip holds `surfingdog-inbox.php`, `readme.txt` and `uninstall.php`. The tests stay out of it.

## 2. Assets (SVN `/assets`, not in the zip)

| File | Size | What it shows |
| --- | --- | --- |
| `icon-128x128.png` | 128 × 128 | The mark alone, on paper white. |
| `icon-256x256.png` | 256 × 256 | The same, for high-density screens. (An `icon.svg` may replace both.) |
| `banner-772x250.png` | 772 × 250 | Wordmark and one line: "Point AI agents to your inbox." No screenshot, no small text. |
| `banner-1544x500.png` | 1544 × 500 | The same, for high-density screens. |
| `screenshot-1.png` | ≤ 1200 wide | Settings → Agent inbox: the address saved, and what is published. |
| `screenshot-2.png` | ≤ 1200 wide | Check: the verdict and its items. |
| `screenshot-3.png` | ≤ 1200 wide | With WooCommerce active: the WooCommerce section and **Connect WooCommerce**. |
| `screenshot-4.png` | ≤ 1200 wide | The inbox's Settings → Integrations, WooCommerce open on **Connect your shop**. |

Screenshot captions are `== Screenshots ==` in `readme.txt`, in the same order. Every example in them
uses a made-up business on `example.com`; none names a real one, a person, or any one country.

## 3. The review, checked

The review team's usual findings, and where this plugin stands.

| | Rule | Where it stands |
| --- | --- | --- |
| ✓ | GPL-compatible licence (guideline 1) | MIT, which is GPL-compatible. `License` and `License URI` in both headers. |
| ✓ | Human-readable code, nothing obfuscated (4) | One plain PHP file. |
| ✓ | No tracking without consent (7) | The checker is called only when the administrator presses Check. The background fetch goes to the business's own inbox, for its public manifest. |
| ✓ | External services disclosed (6, 7) | `== External services ==` in `readme.txt`: what is called, when, what is sent, terms and privacy links. |
| ✓ | Nothing executed from elsewhere (8) | Only JSON is read: the manifest, checked before it is kept, and the checker's answer. |
| ✓ | No "powered by" or credit on the public site (10) | What it publishes points to the business's own inbox only. |
| ✓ | No admin nags or hijacking (11) | One settings page under Settings. No notices, no dashboard widgets. |
| ✓ | Readme: at most five tags, no keyword stuffing (12) | Five tags. |
| ✓ | WordPress's own functions (13) | `wp_safe_remote_get`, the Settings API, WP-Cron, `wp_json_encode`, `esc_*`. No bundled libraries. |
| ✓ | Trademarks (17) | WooCommerce is named in the description and the button, never in the plugin's name or slug. |
| ✓ | Input sanitised, output escaped | `sdi_sanitize_host` on the one setting; every echo escaped (`esc_html`, `esc_attr`, `esc_url`, `esc_textarea`; the JSON-LD built by `sdi_script_json`). |
| ✓ | Nonces and capabilities | The setting through `options.php` (`settings_fields`); Check with `wp_nonce_field`/`check_admin_referer`; the page needs `manage_options`. |
| ✓ | Direct access | `ABSPATH` checked first; `uninstall.php` checks `WP_UNINSTALL_PLUGIN`. |
| ✓ | Uninstall cleans up | Its option, its copy, its transient and its cron event. Nothing else is stored. |
| ✓ | Text domain is the slug | `surfingdog-inbox`. |
| ✓ | WooCommerce's order tables (HPOS) | Declared compatible; orders read only through `WC_Order::get_meta`. |
| ! | Unique prefix | Functions, options, constants and the cron hook use `sdi_` / `SDI_`. Reviewers often ask for a prefix of at least four characters; if asked, rename to `sdinbox_` before the listing (no installs from wordpress.org exist yet, so nothing to migrate there; a site that installed the zip keeps its address by the option's old name only if the rename migrates it). |
| ! | `Tested up to` | 6.8 here. Set it to the current WordPress release on the day of submitting, after testing on it. |
| ! | `Contributors` | `surfingdog` must be the wordpress.org username that submits. |
| ! | Plugin Check | Run the Plugin Check plugin on a test site before submitting, and fix what it says. |

## 4. On the day

1. Make the zip (§1) and run Plugin Check on a test site with and without WooCommerce.
2. Paste `readme.txt` into the readme validator.
3. Submit the zip at https://wordpress.org/plugins/developers/add/ from the owning account.
4. Once approved: SVN `trunk/` gets the three files, `tags/0.2.0/` a copy, `assets/` the files of §2.
